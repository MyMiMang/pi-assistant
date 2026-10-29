/**
 * `codex` 模型渠道：把本机已登录的 `codex app-server` 包装成 Pi 的一个模型渠道（方案 docs/design/cli-models.md §5）。
 * 流程骨架在 `channel-core.ts`，这里只写 Codex 自己的协议适配（`CliBackend`）：
 *
 * - 全局一个 app-server 进程（`cli-agents/codex-hub.ts`），每个 Pi 会话一个 Codex 线程；Codex 自带工具全关，只剩我们声明的动态工具。
 * - 模型调动态工具：Codex 向我们发请求 `item/tool/call`，这一段 Pi 消息以 `toolUse` 结束，请求**挂着不回**；
 *   Pi 执行完工具再调 `streamSimple`，骨架发现末尾是这个 toolCall 的 toolResult，就把结果当作那个请求的回包，Codex 接着往下生成。
 * - 插话 = `turn/steer`，停止 = `turn/interrupt`。
 * - 跨轮靠对照表 `thread/resume`；工具集 / 系统提示 / 模型变了、对不上就新开线程，把 Pi 上下文渲染成文字送进去。
 * - 没有工具的请求（Pi 整理上下文时的总结等）：`ephemeral` 线程单次跑完，不留痕。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createCodexEventConverter, type CodexEvent } from "../../cli-agents/codex-events.ts";
import type { RpcExit } from "../../cli-agents/jsonrpc-stdio.ts";
import { CodexHub } from "../../cli-agents/codex-hub.ts";
import type { PiModels } from "../index.ts";
import { createCliChannel, type CliBackend, type CliLive, type LaunchRequest, type Step } from "./channel-core.ts";
import { blocksToCodexInput, toolResultToCodex, toolsPromptComposite, userMessagesToClaude } from "./convert.ts";
import { EventQueue } from "./event-queue.ts";
import { describeCliError, registerCliProvider, thinkingMapOf } from "./provider.ts";
import { SyncStore } from "./sync-map.ts";

export const CODEX_PROVIDER = "codex";
/** Pi 的 `api` 字段：自定义流式实现的名字 */
export const CODEX_API = "codex-app-server";

export interface CodexDeps {
	/** 数据目录：对照表放 `<dataDir>/cli-models/codex-threads.json`，工作目录放 `<dataDir>/cli-models/work` */
	dataDir: string;
	/** codex 可执行文件；不给就自己找。测试用它换成假 codex */
	command?: () => string | null;
	cwd?: () => string;
	baseEnv?: NodeJS.ProcessEnv;
	/** 额外环境变量（测试选假 codex 场景用） */
	extraEnv?: () => Record<string, string>;
	idleMs?: number;
	/** 测试可换成独立的 hub / 对照表 */
	hub?: CodexHub;
	store?: SyncStore;
}

type Item = CodexEvent | { type: "exit"; exit: RpcExit };

interface CodexLive extends CliLive {
	threadId: string;
	/** `turn/start` 回包后才有的 turn id */
	ready: Promise<string>;
	/** 已交给 Pi、等 Pi 执行完工具回来的调用：Codex 的 callId 和那个请求的 JSON-RPC id */
	pending?: { callId: string; rpcId: number | string };
	responded: boolean;
}

/** Codex 报错 → 中文说明，带上原文 */
export const describeCodexError = (text: string): string => describeCliError({ label: "Codex", loginCommand: "codex login", notLoggedIn: /not logged in|log in|login|unauthorized|401|sign in/i }, text).replace("本机 Codex 未登录，", "本机 Codex 未登录或登录已过期，");

const RESUME_FAILED = /no rollout|not found|no thread|could not find|不存在/i;

function codexBackend(deps: CodexDeps, hub: CodexHub): CliBackend<CodexLive> {
	const cwdOf = deps.cwd ?? (() => join(deps.dataDir, "cli-models", "work"));

	/** 打断进行中的一轮（尽力而为）：挂着的工具请求回「已取消」，再 `turn/interrupt`。 */
	function interrupt(l: CodexLive): void {
		if (l.pending) hub.respond(l.pending.rpcId, { success: false, contentItems: [{ type: "inputText", text: "已取消" }] });
		l.pending = undefined;
		void l.ready.then((turnId) => hub.request("turn/interrupt", { threadId: l.threadId, turnId }, 10_000)).catch(() => {});
	}

	return {
		label: "Codex",
		// 工具集 / 系统提示 / 模型任何一个变了就不续用旧线程（thread/resume 没有 dynamicTools；提示按定稿也算「变了」）
		composite: toolsPromptComposite,
		isResumeFailure: (msg) => RESUME_FAILED.test(msg),
		async launch(req: LaunchRequest) {
			const cwd = cwdOf();
			mkdirSync(cwd, { recursive: true });
			const common = { cwd, approvalPolicy: "never", sandbox: "read-only", baseInstructions: req.systemPrompt ?? null, model: req.model };
			let threadId = req.resumeSessionId;
			try {
				if (threadId) {
					if (!hub.isLoaded(threadId)) await hub.request("thread/resume", { threadId, ...common });
				} else {
					const dynamicTools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, inputSchema: t.inputSchema }));
					const r = await hub.request<{ thread: { id: string } }>("thread/start", { ...common, ephemeral: req.oneShot, ...(dynamicTools.length ? { dynamicTools } : {}) });
					threadId = r.thread.id;
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(req.resumeSessionId && RESUME_FAILED.test(msg) ? msg : describeCodexError(msg));
			}
			hub.markLoaded(threadId);
			let resolveReady!: (id: string) => void;
			let rejectReady!: (e: unknown) => void;
			const ready = new Promise<string>((res, rej) => ((resolveReady = res), (rejectReady = rej)));
			ready.catch(() => {});
			const queue = new EventQueue<Item | { type: "aborted" }>();
			const conv = createCodexEventConverter(threadId);
			const l: CodexLive = { key: req.key, threadId, ready, queue, pendingIds: new Set(), dead: false, offs: [], composite: req.composite, responded: false };
			// 接收方先登记再发 turn/start，别漏掉最早的事件
			l.offs.push(
				hub.subscribe(threadId, {
					notification: (method, params) => {
						for (const e of conv.notification(method, params)) queue.push(e);
					},
					request: (id, method, params) => {
						for (const e of conv.serverRequest(id, method, params) ?? []) queue.push(e);
					},
					exit: (exit) => {
						queue.push({ type: "exit", exit });
						req.forget(l);
					},
				}),
			);
			hub.setActive(threadId, true);
			const input = blocksToCodexInput(typeof req.input === "string" ? [{ type: "text", text: req.input }] : req.input);
			try {
				const r = await hub.request<{ turn: { id: string } }>("turn/start", { threadId, input, model: req.model, summary: "auto", ...(req.effort ? { effort: req.effort } : {}) });
				resolveReady(r.turn.id);
			} catch (e) {
				rejectReady(e);
				req.forget(l);
				const msg = e instanceof Error ? e.message : String(e);
				throw new Error(req.resumeSessionId && RESUME_FAILED.test(msg) ? msg : describeCodexError(msg));
			}
			return l;
		},
		async resume(l, cont) {
			const pending = l.pending!;
			// 插话先 steer：排在工具结果之后进入 Codex 的下一次模型请求（实测 5）
			if (cont.extras.length) {
				const input = blocksToCodexInput(userMessagesToClaude(cont.extras));
				if (input.length) await l.ready.then((turnId) => hub.request("turn/steer", { threadId: l.threadId, expectedTurnId: turnId, input })).catch(() => {});
			}
			l.pending = undefined;
			hub.respond(pending.rpcId, toolResultToCodex(cont.results.get(pending.callId)!));
		},
		abort: interrupt,
		release(l, oneShot) {
			hub.setActive(l.threadId, false);
			if (oneShot) void hub.request("thread/unsubscribe", { threadId: l.threadId }, 10_000).catch(() => {}); // 总结用的线程不留
		},
		dispose: () => hub.dispose(),
		step(l, raw): Step[] {
			const item = raw as Item;
			const first: Step[] = l.responded ? [] : [{ type: "responded" }];
			l.responded = true;
			switch (item.type) {
				case "exit": {
					const x = item.exit;
					if (x.closedByUs) return [{ type: "fail", reason: "aborted", message: "已停止" }];
					if (x.spawnError) return [{ type: "fail", reason: "error", message: `无法启动 codex：${x.spawnError}` }];
					return [{ type: "fail", reason: "error", message: `Codex 进程意外退出（退出码 ${x.code ?? x.signal ?? "未知"}）${x.stderr ? `：${x.stderr}` : ""}` }];
				}
				case "usage":
					return [...first, { type: "usage", usage: item.usage, mode: "set" }];
				case "tool_request":
					l.pending = { callId: item.callId, rpcId: item.rpcId };
					return [...first, { type: "tool_use", ids: [item.callId] }];
				case "turn_end":
					if (item.status === "interrupted") return [{ type: "fail", reason: "aborted", message: "已停止" }];
					if (item.status === "failed") return [{ type: "fail", reason: "error", message: describeCodexError(item.error ?? "") }];
					return [...first, { type: "finish", reason: "stop", sessionId: l.threadId }];
				default:
					return [...first, { type: "content", ev: item }];
			}
		},
	};
}

/** 本渠道一个实例 = 一个 hub + 一张进行中表 + 一张对照表 */
export function createCodexChannel(deps: CodexDeps) {
	const cwdOf = deps.cwd ?? (() => join(deps.dataDir, "cli-models", "work"));
	const hub = deps.hub ?? new CodexHub({ command: deps.command, cwd: () => (mkdirSync(cwdOf(), { recursive: true }), cwdOf()), baseEnv: deps.baseEnv, extraEnv: deps.extraEnv, idleMs: deps.idleMs });
	return { ...createCliChannel(codexBackend(deps, hub), deps.store ?? new SyncStore(join(deps.dataDir, "cli-models", "codex-threads.json"))), hub };
}

export type CodexChannel = ReturnType<typeof createCodexChannel>;

/** 向 Codex 问模型列表并（重新）注册 `codex` 渠道；重新检测时再调一次就刷新列表。 */
export async function registerCodexModels(models: PiModels, channel: CodexChannel, reprobe = false) {
	if (reprobe) channel.hub.reprobe();
	const list = await channel.hub.listModels();
	channel.hub.stopIfIdle(); // 只为问列表起的进程，用完就关；真有对话时下次请求再起
	if (!list.length) throw new Error("Codex 没有返回任何模型");
	await registerCliProvider(models, {
		id: CODEX_PROVIDER,
		name: "Codex（本机）",
		api: CODEX_API,
		baseUrl: "codex://local",
		streamSimple: channel.streamSimple as never,
		models: list.map((m) => ({ id: m.id, name: `Codex · ${m.name}`, reasoning: m.efforts.length > 0, thinkingLevelMap: thinkingMapOf(m.efforts), image: m.image, contextWindow: 258_400, maxTokens: 64_000 })),
	});
	return list;
}

/** 创建渠道并注册模型（Codex 进程只为问一次 `model/list` 起，之后关掉）。 */
export async function registerCodexProvider(models: PiModels, deps: CodexDeps): Promise<CodexChannel> {
	const channel = createCodexChannel(deps);
	try {
		await registerCodexModels(models, channel);
	} catch (e) {
		channel.disposeAll();
		throw e;
	}
	return channel;
}
