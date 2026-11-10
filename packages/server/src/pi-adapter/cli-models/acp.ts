/**
 * 通用 ACP（Agent Client Protocol）模型渠道后端：把任何支持 ACP 的本机命令行（OpenCode 等）包装成 Pi 的一个模型渠道。方案 docs/design/acp-cli-models.md。
 * 流程骨架在 `channel-core.ts`，这里只写 ACP 协议适配（`CliBackend`）；每家命令行只给一份 `AcpChannelConfig`（启动方式 `AcpProfile` + 报错样式），
 * 例：`opencode.ts`。加新的一家 = 加一份配置，不要复制这里的流程。
 *
 * - 每个 Pi 会话一个**长驻**的命令行进程（`cli-agents/acp-process.ts`）。brain 关闭自带工具，native 保留原生能力并绑定宿主工作区 / 权限；两者都复用 Pi 工具桥 MCP。
 *   系统提示 / 工具集变了：弃用旧进程重开（配置是进程级的），能 `session/resume` 就续接。模型和思考强度是会话级的，变了不用重开（`session/set_config_option`）。
 * - 模型调工具：工具桥收到 `tools/call`，收齐并行调用后这一段 Pi 消息以 `toolUse` 结束，**调用挂着不回**；
 *   Pi 执行完工具再调 `streamSimple`，骨架发现末尾是这些 toolCall 的 toolResult，就按配对键（MCP 请求 id）回填，命令行接着往下生成。
 * - 插话：ACP 不能把消息并进当前轮，所以附在下一个工具结果文字后面（「[用户插话] …」）；没有挂起的工具时由骨架当作下一条消息。
 * - 停止 = `session/cancel`；跨轮靠对照表 + `session/resume`；空闲 10 分钟进程自己退出。
 * - 用量：ACP 回包里的用量只是**最后一次模型调用**的，`usage_update` 一轮只来一次（也不是整轮合计），没法按次累加，
 *   所以只有最后一段 Pi 消息有用量（正好是当前上下文大小），中间被工具打断的段没有。cost 一律 0。
 * - 没有工具的请求（Pi 整理上下文时的总结等）：单次跑完就关进程，不进对照表。
 */
import { isAbsolute, join } from "node:path";
import { AcpProcess, type AcpExit, type AcpItem, type AcpProfile } from "../../cli-agents/acp-process.ts";
import { toolBridge, type Tool, type ToolBridge } from "../../cli-agents/tool-bridge.ts";
import { createCliChannel, type CliBackend, type CliLive, type LaunchRequest, type Step } from "./channel-core.ts";
import { blocksToAcpPrompt, toolsPromptComposite } from "./convert.ts";
import { EventQueue } from "./event-queue.ts";
import { ProcessPool, releaseProc, resolveToolResults } from "./process-pool.ts";
import { describeCliError, type CliErrorStyle } from "./provider.ts";
import { SyncStore } from "./sync-map.ts";
import { getNativeSessionContext, addNativeSessionCleanup } from "./session-context.ts";

/** 每家 ACP 命令行的配置 */
export interface AcpChannelConfig {
	profile: AcpProfile;
	/** 旧渠道默认 brain；native 从已绑定宿主取得工作目录与权限路由。 */
	mode?: "brain" | "native";
	/** 安装版本 / 隔离策略变更时更新，避免沿用旧线程。 */
	sessionPolicy?: string;
	/** 数据目录下的子目录前缀，如 `opencode`：对照表 `<前缀>-sessions.json`、运行目录 `<前缀>-runs`、工作目录 `<前缀>-work` */
	name: string;
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
	commandArgs?: () => string[];
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
	cancelPending?: () => void;
}

function acpBackend(cfg: AcpChannelConfig, deps: AcpDeps): CliBackend<AcpLive> {
	const label = cfg.profile.label;
	const pool = new ProcessPool<AcpProcess>();
	const native = cfg.mode === "native";
	const nativeContext = (key: string | undefined) => {
		const context = getNativeSessionContext(key);
		if (!context) throw new Error(`${label} 缺少原生会话上下文，无法启动；无工具的单次总结请求不支持原生渠道`);
		if (!isAbsolute(context.workspace)) throw new Error(`${label} 的工作文件夹必须是绝对路径`);
		if (context.isPaused()) throw new Error("电脑操作已暂停，无法启动原生渠道");
		return context;
	};

	return {
		label,
		checkContinuationComposite: native,
		// 不含模型：会话级配置；native 另含工作区、命令路径（安装版本）及隔离策略。
		composite: (_model, tools, systemPrompt, key) => toolsPromptComposite(native ? JSON.stringify(["native", nativeContext(key).workspace, deps.command?.(), cfg.sessionPolicy ?? ""]) : "", tools, systemPrompt),
		// 原生过程可能已有副作用，不因一条报错自动重新发送整轮。
		isResumeFailure: (msg) => !native && cfg.resumeFailed.test(msg),
		async launch(req: LaunchRequest) {
			if (native && !deps.command) throw new Error(`${label} 缺少 Pi 配置的绝对命令路径`);
			const command = deps.command?.() ?? null;
			if (!command) throw new Error(cfg.notFound);
			if (native && !isAbsolute(command)) throw new Error(`${label} 必须使用 Pi 配置的绝对命令路径`);
			const context = native ? nativeContext(req.key) : undefined;
			const prefix = [req.systemPrompt, "你在 Pi 助理中为用户工作。保留你自己的系统指令与原生工具；工作地点是当前助理的工作文件夹。你也可以调用已提供的 Pi 工具使用助理电脑、浏览器、记忆、群聊以及发送文件；这些工具按 Pi 的权限规则执行。原生工具已执行的操作不要再交给 Pi 重复执行。"].filter(Boolean).join("\n\n");
			const prepend = (input: LaunchRequest["input"]) => [{ type: "text" as const, text: prefix }, ...(typeof input === "string" ? [{ type: "text" as const, text: input }] : input)];
			let initialInput = req.input;
			let proc = await pool.take(req.key, req.composite, (p) => !!req.resumeSessionId && p.sessionId === req.resumeSessionId);
			if (!proc) {
				const dir = join(deps.dataDir, "cli-models");
				const fresh = new AcpProcess({
					profile: { ...cfg.profile, ...(native ? { mode: "native" as const } : {}), args: dir => [...(deps.commandArgs?.() ?? []), ...cfg.profile.args(dir)] },
					requestPermission: context ? (params) => context.requestPermission(params) : undefined,
					isPaused: context ? () => context.isPaused() : undefined,
					isWaitingForApproval: context ? () => context.isWaitingForApproval?.() ?? false : undefined,
					command,
					runsRoot: join(dir, `${cfg.name}-runs`),
					workDir: context?.workspace ?? join(dir, `${cfg.name}-work`),
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
				if (context) {
					const off = context.onPause(() => { context.cancelPending?.(); fresh.abort(); });
					void fresh.done.then(off);
					if (req.key) {
						const offCleanup = addNativeSessionCleanup(req.key, () => { context.cancelPending?.(); fresh.abort(); });
						void fresh.done.then(offCleanup);
					}
					if (context.isPaused()) fresh.abort();
					if (!req.resumeSessionId) initialInput = prepend(req.input);
				}
				pool.add(req.key, fresh, req.composite);
				proc = fresh;
			}
			const queue = new EventQueue<Item | { type: "aborted" }>();
			const l: AcpLive = { key: req.key, proc, queue, pendingIds: new Set(), dead: false, offs: [], composite: req.composite, keyOf: new Map(), responded: false, thinking: false, cleanEnd: false, cancelPending: context ? () => context.cancelPending?.() : undefined };
			l.offs.push(
				proc.attach({
					onItem: (i) => queue.push(i),
					onExit: (exit) => {
						queue.push({ type: "exit", exit });
						req.forget(l);
					},
				}),
			);
			if (!proc.sendPrompt(blocksToAcpPrompt(initialInput), req.model, req.effort, native ? blocksToAcpPrompt(prepend(req.freshInput)) : undefined)) {
				proc.abort();
				for (const off of l.offs) off();
				throw new Error(`${label} 无法接收输入，运行已停止`);
			}
			return l;
		},
		resume: async (l, cont, ids) => resolveToolResults(l.keyOf, cont, ids, (key, result) => void l.proc.resolveTool(key, result)),
		abort: (l) => { l.cancelPending?.(); l.proc.abort(); },
		release: (l, oneShot) => { if (!l.cleanEnd) l.cancelPending?.(); releaseProc(l.proc, l.cleanEnd, oneShot); },
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
					return [{ type: "fail", reason: "error", message: `${label} 进程意外退出（退出码 ${x.code ?? x.signal ?? "未知"}）${x.stderr ? `：${x.stderr}` : ""}`, resumeFailed: !native && cfg.resumeFailed.test(x.stderr) }];
				}
				case "native_tool":
					// pump 已透传原生通知，绝不生成可被 Pi 再执行的 toolCall。
					return [...first, ...closeThinking()];
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
					const resumeFailed = !native && item.isError && cfg.resumeFailed.test(item.text);
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
