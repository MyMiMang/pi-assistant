/**
 * 通用 ACP（Agent Client Protocol）模型渠道后端：把任何支持 ACP 的本机命令行（OpenCode 等）包装成 Pi 的一个模型渠道。方案 docs/design/acp-cli-models.md。
 * 流程骨架在 `channel-core.ts`，这里只写 ACP 协议适配（`CliBackend`）；每家命令行只给一份 `AcpChannelConfig`（启动方式 `AcpProfile` + 报错样式），
 * 例：`opencode.ts`。加新的一家 = 加一份配置，不要复制这里的流程。
 *
 * - 每个 Pi 会话一个**长驻**的命令行进程（`cli-agents/acp-process.ts`）；自带工具全关，只剩工具桥 MCP 里的 Pi 工具（工具桥经 ACP `mcpServers` 挂上）。
 *   系统提示 / 工具集变了：弃用旧进程重开（配置是进程级的），能 `session/resume` 就续接。模型和思考强度是会话级的，变了不用重开（`session/set_config_option`）。
 * - 模型调工具：工具桥收到 `tools/call`，收齐并行调用后这一段 Pi 消息以 `toolUse` 结束，**调用挂着不回**；
 *   Pi 执行完工具再调 `streamSimple`，骨架发现末尾是这些 toolCall 的 toolResult，就按配对键（MCP 请求 id）回填，命令行接着往下生成。
 * - 插话：ACP 不能把消息并进当前轮，所以附在下一个工具结果文字后面（「[用户插话] …」）；没有挂起的工具时由骨架当作下一条消息。
 * - 停止 = `session/cancel`；跨轮靠对照表 + `session/resume`；空闲 10 分钟进程自己退出。
 * - 用量：ACP 回包里的用量只是**最后一次模型调用**的，`usage_update` 一轮只来一次（也不是整轮合计），没法按次累加，
 *   所以只有最后一段 Pi 消息有用量（正好是当前上下文大小），中间被工具打断的段没有。cost 一律 0。
 * - 没有工具的请求（Pi 整理上下文时的总结等）：单次跑完就关进程，不进对照表。
 */
import { join } from "node:path";
import { AcpProcess, type AcpExit, type AcpItem, type AcpProfile } from "../../cli-agents/acp-process.ts";
import { toolBridge, type Tool, type ToolBridge } from "../../cli-agents/tool-bridge.ts";
import { createCliChannel, type CliBackend, type CliLive, type LaunchRequest, type Step } from "./channel-core.ts";
import { blocksToAcpPrompt, toolsPromptComposite } from "./convert.ts";
import { EventQueue } from "./event-queue.ts";
import { ProcessPool, releaseProc, resolveToolResults } from "./process-pool.ts";
import { describeCliError, type CliErrorStyle } from "./provider.ts";
import { SyncStore } from "./sync-map.ts";

/** 每家 ACP 命令行的配置 */
export interface AcpChannelConfig {
	profile: AcpProfile;
	/** 数据目录下的子目录前缀，如 `opencode`：对照表 `<前缀>-sessions.json`、运行目录 `<前缀>-runs`、工作目录 `<前缀>-work` */
	name: string;
	/** 在本机自己找命令（`deps.command` 没给时用） */
	findCommand(): string | null;
	/** 找不到命令时的说明 */
	notFound: string;
	errorStyle: CliErrorStyle;
	/** 匹配「续用的会话找不到」的原文 */
	resumeFailed: RegExp;
}

export interface AcpDeps {
	/** 数据目录 */
	dataDir: string;
	/** 工具桥地址的前缀，生产里是 `http://127.0.0.1:${config.port}` */
	bridgeBaseUrl: () => string;
	/** 命令行可执行文件；不给就自己找。测试用它换成假命令 */
	command?: () => string | null;
	baseEnv?: NodeJS.ProcessEnv;
	/** 额外环境变量（测试选假命令场景用） */
	extraEnv?: () => Record<string, string>;
	collectMs?: number;
	settleMs?: number;
	idleMs?: number;
	/** 测试可换成独立的工具桥登记表 / 对照表 */
	bridge?: ToolBridge;
	store?: SyncStore;
}

type Item = AcpItem | { type: "exit"; exit: AcpExit };

interface AcpLive extends CliLive {
	proc: AcpProcess;
	/** 交给 Pi 的 toolCall id → 工具桥的配对键（MCP 请求 id） */
	keyOf: Map<string, string>;
	responded: boolean;
	/** 思考块还开着（文字或工具来了先把它关掉） */
	thinking: boolean;
	/** 这一轮正常结束了（进程可以留着给下一轮用） */
	cleanEnd: boolean;
}

function acpBackend(cfg: AcpChannelConfig, deps: AcpDeps): CliBackend<AcpLive> {
	const label = cfg.profile.label;
	const pool = new ProcessPool<AcpProcess>();

	return {
		label,
		// 不含模型：模型是会话级的，换了用 set_config_option 切，不用重开会话
		composite: (_model, tools, systemPrompt) => toolsPromptComposite("", tools, systemPrompt),
		isResumeFailure: (msg) => cfg.resumeFailed.test(msg),
		async launch(req: LaunchRequest) {
			const command = (deps.command ?? cfg.findCommand)();
			if (!command) throw new Error(cfg.notFound);
			let proc = await pool.take(req.key, req.composite, (p) => !!req.resumeSessionId && p.sessionId === req.resumeSessionId);
			if (!proc) {
				const dir = join(deps.dataDir, "cli-models");
				const fresh = new AcpProcess({
					profile: cfg.profile,
					command,
					runsRoot: join(dir, `${cfg.name}-runs`),
					workDir: join(dir, `${cfg.name}-work`),
					dataDir: deps.dataDir,
					bridgeBaseUrl: deps.bridgeBaseUrl(),
					tools: req.tools as Tool[],
					systemPrompt: req.systemPrompt,
					sessionId: req.resumeSessionId,
					collectMs: deps.collectMs,
					settleMs: deps.settleMs,
					idleMs: deps.idleMs,
					baseEnv: deps.baseEnv,
					extraEnv: deps.extraEnv?.(),
					bridge: deps.bridge ?? toolBridge,
				});
				fresh.start();
				pool.add(req.key, fresh, req.composite);
				proc = fresh;
			}
			const queue = new EventQueue<Item | { type: "aborted" }>();
			const l: AcpLive = { key: req.key, proc, queue, pendingIds: new Set(), dead: false, offs: [], composite: req.composite, keyOf: new Map(), responded: false, thinking: false, cleanEnd: false };
			l.offs.push(
				proc.attach({
					onItem: (i) => queue.push(i),
					onExit: (exit) => {
						queue.push({ type: "exit", exit });
						req.forget(l);
					},
				}),
			);
			proc.sendPrompt(blocksToAcpPrompt(req.input), req.model, req.effort);
			return l;
		},
		resume: async (l, cont, ids) => resolveToolResults(l.keyOf, cont, ids, (key, result) => void l.proc.resolveTool(key, result)),
		abort: (l) => l.proc.abort(),
		release: (l, oneShot) => releaseProc(l.proc, l.cleanEnd, oneShot),
		dispose: () => pool.disposeAll(),
		step(l, raw, b): Step[] {
			const item = raw as Item;
			const first: Step[] = l.responded || item.type === "exit" ? [] : [{ type: "responded" }];
			l.responded = true;
			/** 开新内容前先关掉还开着的思考块 */
			const closeThinking = (): Step[] => (l.thinking ? ((l.thinking = false), [{ type: "content", ev: { type: "thinking_end" } }]) : []);
			switch (item.type) {
				case "exit": {
					const x = item.exit;
					if (x.aborted) return [{ type: "fail", reason: "aborted", message: "已停止" }];
					if (x.spawnError) return [{ type: "fail", reason: "error", message: `无法启动 ${label}：${x.spawnError}` }];
					return [{ type: "fail", reason: "error", message: `${label} 进程意外退出（退出码 ${x.code ?? x.signal ?? "未知"}）${x.stderr ? `：${x.stderr}` : ""}`, resumeFailed: cfg.resumeFailed.test(x.stderr) }];
				}
				case "thinking_delta":
					l.thinking = true;
					return [...first, { type: "content", ev: item }];
				case "text_delta":
					return [...first, ...closeThinking(), { type: "content", ev: item }];
				case "tool_call":
					l.keyOf.set(item.id, item.key);
					return [...first, ...closeThinking(), { type: "content", ev: { type: "tool_call_start", id: item.id, name: item.name } }, { type: "content", ev: { type: "tool_call_end", id: item.id, name: item.name, args: item.args } }];
				case "tools_ready":
					return b.toolCallIds.length ? [...first, { type: "tool_use" }] : first;
				case "result": {
					const resumeFailed = item.isError && cfg.resumeFailed.test(item.text);
					if (item.isError) return [{ type: "fail", reason: "error", message: describeCliError(cfg.errorStyle, item.text), resumeFailed }];
					if (item.stopReason === "cancelled") return [{ type: "fail", reason: "error", message: `${label} 提前结束了这一轮` }];
					if (item.stopReason === "refusal") return [{ type: "fail", reason: "error", message: `${label} 里的模型拒绝回答` }];
					l.cleanEnd = true;
					return [...first, ...closeThinking(), { type: "finish", reason: item.stopReason === "max_tokens" ? "length" : "stop", sessionId: item.sessionId || l.proc.sessionId, fallbackUsage: item.usage }];
				}
			}
		},
	};
}

/** 一个 ACP 渠道实例 = 一张进行中运行表 + 一个进程池 + 一张对照表 */
export function createAcpChannel(cfg: AcpChannelConfig, deps: AcpDeps) {
	return createCliChannel(acpBackend(cfg, deps), deps.store ?? new SyncStore(join(deps.dataDir, "cli-models", `${cfg.name}-sessions.json`)));
}
