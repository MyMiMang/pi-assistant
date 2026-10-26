/**
 * `antigravity` 模型渠道：把本机已登录的 Antigravity CLI（`agy`）包装成 Pi 的一个模型渠道，**实验性**（方案 docs/design/cli-models.md §5b）。
 * 流程骨架在 `channel-core.ts`，这里只写 agy 自己的协议适配（`CliBackend`）：
 *
 * - 每个 Pi 会话一个**长驻**的 agy 进程（`cli-agents/agy-process.ts`，启动约 35 秒所以不按轮起）；自带工具全关（工作区自定义代理），
 *   只剩工具桥 MCP 里的 Pi 工具。系统提示 / 工具集 / 模型变了就弃用旧进程、新开会话（历史渲染成文字）；思考强度变了只换进程、续用同一会话。
 * - 模型调工具：工具桥收到 `tools/call`，等 300 毫秒收齐并行调用，这一段 Pi 消息以 `toolUse` 结束，**调用挂着不回**；
 *   Pi 执行完工具再调 `streamSimple`，骨架发现末尾是这些 toolCall 的 toolResult，就按配对键（step_index）回填，agy 接着往下生成。
 * - 插话：agy 不能把消息并进当前轮，所以附在下一个工具结果文字后面（「[用户插话] …」）；没有挂起的工具时由骨架当作下一条消息。
 * - 停止 = SIGINT；跨轮靠对照表 `--conversation`；空闲 10 分钟进程自己退出，下一轮用 `--conversation` 再起。
 * - 不显示思考（agy 没有思考内容）；用量取每个 agent_response 步骤的 usage；cost 一律 0。
 * - 没有工具的请求（Pi 整理上下文时的总结等）：单次跑完就关进程，不进对照表。
 */
import { join } from "node:path";
import { AgyProcess, type AgyExit, type AgyItem } from "../../cli-agents/agy-process.ts";
import { agyThinkingMap, effortsOf, resolveAgyModel, type AgyFamily } from "../../cli-agents/agy-models.ts";
import { findAgyCommand } from "../../cli-agents/detect.ts";
import { toolBridge, type Tool, type ToolBridge } from "../../cli-agents/tool-bridge.ts";
import type { PiModels } from "../index.ts";
import { createCliChannel, type CliBackend, type CliLive, type LaunchRequest, type Step } from "./channel-core.ts";
import { blocksToPlainText, toolResultToMcp, toolsPromptComposite, userMessagesToClaude } from "./convert.ts";
import { EventQueue } from "./event-queue.ts";
import { describeCliError, registerCliProvider } from "./provider.ts";
import { SyncStore } from "./sync-map.ts";

export const ANTIGRAVITY_PROVIDER = "antigravity";
/** Pi 的 `api` 字段：自定义流式实现的名字 */
export const ANTIGRAVITY_API = "antigravity-cli";

export interface AntigravityDeps {
	/** 数据目录：对照表放 `<dataDir>/cli-models/agy-conversations.json`，运行目录放 `<dataDir>/cli-models/agy-runs/<随机>` */
	dataDir: string;
	/** 工具桥地址的前缀，生产里是 `http://127.0.0.1:${config.port}` */
	bridgeBaseUrl: () => string;
	/** agy 可执行文件；不给就自己找。测试用它换成假 agy */
	command?: () => string | null;
	baseEnv?: NodeJS.ProcessEnv;
	/** 额外环境变量（测试选假 agy 场景用） */
	extraEnv?: () => Record<string, string>;
	/** 模型家族（`agy models` 的解析结果）；用来把 Pi 的「模型 + 思考强度」拼成 agy 的完整模型 id */
	families?: AgyFamily[];
	collectMs?: number;
	idleMs?: number;
	/** 测试可换成独立的工具桥登记表 / 对照表 */
	bridge?: ToolBridge;
	store?: SyncStore;
}

type Item = AgyItem | { type: "exit"; exit: AgyExit };

interface AgyLive extends CliLive {
	proc: AgyProcess;
	/** 交给 Pi 的 toolCall id → 工具桥的配对键（step_index） */
	keyOf: Map<string, string>;
	responded: boolean;
	/** 这一轮正常结束了（进程可以留着给下一轮用） */
	cleanEnd: boolean;
}

/** agy 报错 → 中文说明，带上原文；地区限制单独提示 */
export function describeAgyError(text: string): string {
	const base = describeCliError({ label: "Antigravity", loginCommand: "agy", notLoggedIn: /sign in|log in|login|not authenticated|unauthenticated|401/i }, text);
	return /location is not supported/i.test(text) ? `${base}（Gemini 模型在部分地区不可用，可以换 Claude 或 GPT-OSS 模型）` : base;
}

const RESUME_FAILED = /conversation[^\n]*(not found|does not exist|no such|unknown|invalid)|(not found|no such|unknown)[^\n]*conversation/i;

interface Pooled {
	proc: AgyProcess;
	composite: string;
}

function antigravityBackend(deps: AntigravityDeps, state: { families: AgyFamily[] }): CliBackend<AgyLive> {
	/** 每个 Pi 会话键一个长驻进程（空闲 / 一轮刚结束时在这里等下一轮） */
	const pool = new Map<string, Pooled>();

	/** 弃用旧进程并等它退出（同一个会话不能被两个进程同时用） */
	async function retire(p: Pooled): Promise<void> {
		p.proc.shutdown();
		await p.proc.done;
	}

	return {
		label: "Antigravity",
		composite: toolsPromptComposite,
		isResumeFailure: () => false,
		async launch(req: LaunchRequest) {
			const command = (deps.command ?? (() => findAgyCommand()))();
			if (!command) throw new Error("没有找到 agy 命令。请先按 Antigravity 官方说明安装，再在终端运行 agy 登录。");
			const model = resolveAgyModel(state.families, req.model, req.effort);
			let proc: AgyProcess | undefined;
			const old = req.key ? pool.get(req.key) : undefined;
			if (old) {
				const reusable = !old.proc.dead && !old.proc.busy && !!req.resumeSessionId && old.proc.conversationId === req.resumeSessionId && old.proc.model === model && old.composite === req.composite;
				if (reusable) proc = old.proc;
				else {
					pool.delete(req.key!);
					await retire(old);
				}
			}
			if (!proc) {
				const fresh = new AgyProcess({
					command,
					runsRoot: join(deps.dataDir, "cli-models", "agy-runs"),
					bridgeBaseUrl: deps.bridgeBaseUrl(),
					tools: req.tools as Tool[],
					model,
					systemPrompt: req.systemPrompt,
					conversationId: req.resumeSessionId,
					collectMs: deps.collectMs,
					idleMs: deps.idleMs,
					baseEnv: deps.baseEnv,
					extraEnv: deps.extraEnv?.(),
					bridge: deps.bridge ?? toolBridge,
				});
				fresh.start();
				if (req.key) {
					const entry = { proc: fresh, composite: req.composite };
					pool.set(req.key, entry);
					void fresh.done.then(() => pool.get(req.key!) === entry && pool.delete(req.key!));
				}
				proc = fresh;
			}
			const queue = new EventQueue<Item | { type: "aborted" }>();
			const l: AgyLive = { key: req.key, proc, queue, pendingIds: new Set(), dead: false, offs: [], composite: req.composite, keyOf: new Map(), responded: false, cleanEnd: false };
			l.offs.push(
				proc.attach({
					onItem: (i) => queue.push(i),
					onExit: (exit) => {
						queue.push({ type: "exit", exit });
						req.forget(l);
					},
				}),
			);
			proc.sendUserMessage(blocksToPlainText(req.input));
			return l;
		},
		async resume(l, cont, ids) {
			// agy 不能把消息并进当前轮：插话附在最后一个工具结果后面，模型下一次请求就看得到
			const extra = cont.extras.length ? blocksToPlainText(userMessagesToClaude(cont.extras)).trim() : "";
			ids.forEach((id, i) => {
				const key = l.keyOf.get(id);
				const msg = cont.results.get(id);
				if (!key || !msg) return;
				const result = toolResultToMcp(msg);
				if (extra && i === ids.length - 1) result.content.push({ type: "text", text: `\n\n[用户插话] ${extra}` });
				l.proc.resolveTool(key, result);
			});
		},
		abort: (l) => l.proc.abort(),
		release(l, oneShot) {
			if (!l.cleanEnd) l.proc.abort();
			else if (oneShot) l.proc.shutdown(); // 总结用的进程用完就关
		},
		dispose() {
			for (const p of pool.values()) p.proc.abort();
			pool.clear();
		},
		step(l, raw, b): Step[] {
			const item = raw as Item;
			const first: Step[] = l.responded ? [] : [{ type: "responded" }];
			if (item.type !== "unparsed") l.responded = true;
			switch (item.type) {
				case "exit": {
					const x = item.exit;
					if (x.aborted) return [{ type: "fail", reason: "aborted", message: "已停止" }];
					if (x.spawnError) return [{ type: "fail", reason: "error", message: `无法启动 agy：${x.spawnError}` }];
					const why = x.stderr || "";
					return [{ type: "fail", reason: "error", message: `Antigravity 进程意外退出（退出码 ${x.code ?? x.signal ?? "未知"}）${why ? `：${why}` : ""}`, resumeFailed: RESUME_FAILED.test(why) }];
				}
				case "init":
					return first;
				case "text_delta":
				case "message_end":
					return [...first, { type: "content", ev: item }];
				case "tool_call":
					l.keyOf.set(item.id, item.key);
					return [...first, { type: "content", ev: { type: "tool_call_start", id: item.id, name: item.name } }, { type: "content", ev: { type: "tool_call_end", id: item.id, name: item.name, args: item.args } }];
				case "tools_ready":
					return b.toolCallIds.length ? [...first, { type: "tool_use" }] : first;
				case "result":
					if (item.isError) return [{ type: "fail", reason: "error", message: describeAgyError(item.text), resumeFailed: RESUME_FAILED.test(item.text), fallbackUsage: item.usage }];
					l.cleanEnd = true;
					return [...first, { type: "finish", reason: "stop", sessionId: item.sessionId || l.proc.conversationId, fallbackUsage: item.usage }];
				default:
					return first; // tool_step / step_error / unparsed：只是旁证
			}
		},
	};
}

/** 本渠道一个实例 = 一张进行中运行表 + 一个进程池 + 一张对照表 */
export function createAntigravityChannel(deps: AntigravityDeps) {
	const state = { families: deps.families ?? [] };
	const core = createCliChannel(antigravityBackend(deps, state), deps.store ?? new SyncStore(join(deps.dataDir, "cli-models", "agy-conversations.json")));
	return { ...core, setFamilies: (families: AgyFamily[]) => void (state.families = families) };
}

export type AntigravityChannel = ReturnType<typeof createAntigravityChannel>;

/** 用 `agy models` 的结果（重新）注册 `antigravity` 渠道；重新检测时再调一次就刷新列表。 */
export async function registerAntigravityModels(models: PiModels, channel: AntigravityChannel, families: AgyFamily[]): Promise<void> {
	if (!families.length) throw new Error("Antigravity 没有返回任何模型");
	channel.setFamilies(families);
	await registerCliProvider(models, {
		id: ANTIGRAVITY_PROVIDER,
		name: "Antigravity（本机）",
		api: ANTIGRAVITY_API,
		baseUrl: "antigravity://local",
		streamSimple: channel.streamSimple as never,
		models: families.map((f) => ({
			id: f.id,
			name: `Antigravity · ${f.name}`,
			reasoning: effortsOf(f).length > 1,
			thinkingLevelMap: agyThinkingMap(f),
			image: false, // 图片经 stdin 没验证过，先不声明能看图
			contextWindow: 200_000,
			maxTokens: 64_000,
		})),
	});
}

/** 创建渠道并注册模型（模型家族由调用方先问 `agy models` 得到）。 */
export async function registerAntigravityProvider(models: PiModels, deps: AntigravityDeps & { families: AgyFamily[] }): Promise<AntigravityChannel> {
	const channel = createAntigravityChannel(deps);
	try {
		await registerAntigravityModels(models, channel, deps.families);
	} catch (e) {
		channel.disposeAll();
		throw e;
	}
	return channel;
}
