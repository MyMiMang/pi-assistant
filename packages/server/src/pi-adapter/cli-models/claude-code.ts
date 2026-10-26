/**
 * `claude-code` 模型渠道：把本机已登录的 `claude` 包装成 Pi 的一个模型渠道（方案 docs/design/cli-models.md §3、§4）。
 * 流程骨架在 `channel-core.ts`，这里只写 claude 自己的协议适配（`CliBackend`）：
 *
 * - 每轮用户消息起一个 claude 进程（`cli-agents/claude-process.ts`），内置工具全关，只能用 Pi 里的工具（经工具桥 MCP）。
 * - claude 想调工具：这一段 Pi 消息以 `toolUse` 结束，**claude 进程留在「进行中运行」表里**；Pi 执行完工具再调 `streamSimple`，
 *   骨架发现末尾是这些 toolCall 的 toolResult，就按 id 把结果回填，接着把 claude 后续事件流给这次调用。
 * - 跨轮靠 `sync-map.ts` 的对照表 `--resume`；对不上就新开会话，把 Pi 上下文渲染成文字送进去。
 * - 没有工具的请求（Pi 整理上下文时的总结等）：单次跑完，不续用会话、不留 claude 会话记录。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeRun, type ClaudeExit } from "../../cli-agents/claude-process.ts";
import { findClaudeCommand } from "../../cli-agents/detect.ts";
import type { ClaudeEvent } from "../../cli-agents/events.ts";
import { toolBridge, type Tool, type ToolBridge } from "../../cli-agents/tool-bridge.ts";
import type { PiModels } from "../index.ts";
import { createCliChannel, type CliBackend, type CliLive, type LaunchRequest, type Step } from "./channel-core.ts";
import { toolResultToMcp, userMessagesToClaude } from "./convert.ts";
import { EventQueue } from "./event-queue.ts";
import { describeCliError, registerCliProvider } from "./provider.ts";
import { SyncStore } from "./sync-map.ts";

export const CLAUDE_CODE_PROVIDER = "claude-code";
/** Pi 的 `api` 字段：自定义流式实现的名字 */
export const CLAUDE_CODE_API = "claude-code-cli";

/** 渠道模型：id 就是 `claude --model` 的别名。haiku 不支持思考强度。 */
export const CLAUDE_CODE_MODELS = [
	{ id: "opus", name: "Claude Code · Opus", reasoning: true },
	{ id: "sonnet", name: "Claude Code · Sonnet", reasoning: true },
	{ id: "haiku", name: "Claude Code · Haiku", reasoning: false },
] as const;

export interface ClaudeCodeDeps {
	/** 数据目录：对照表放 `<dataDir>/cli-models/claude-sessions.json`，没给 cwd 时工作目录放 `<dataDir>/cli-models/work` */
	dataDir: string;
	/** 工具桥地址的前缀，生产里是 `http://127.0.0.1:${config.port}` */
	bridgeBaseUrl: () => string;
	/** claude 可执行文件；不给就自己找。测试用它换成假 claude */
	command?: () => string | null;
	/** claude 的工作目录；不给用 `<dataDir>/cli-models/work` */
	cwd?: () => string;
	baseEnv?: NodeJS.ProcessEnv;
	/** 额外环境变量（测试选假 claude 场景用） */
	extraEnv?: () => Record<string, string>;
	/** 测试可换成独立的工具桥登记表 */
	bridge?: ToolBridge;
	/** 对照表（默认放数据目录的小 JSON） */
	store?: SyncStore;
}

type Item = ClaudeEvent | { type: "exit"; exit: ClaudeExit };

interface ClaudeLive extends CliLive {
	run: ClaudeRun;
	claudeSessionId?: string;
	lastStop?: string;
}

/** claude 报错 → 中文说明，带上原文 */
export const describeClaudeError = (text: string): string => describeCliError({ label: "Claude Code", loginCommand: "claude auth login", notLoggedIn: /not logged in|please run \/login|\/login/i, authFailed: /invalid bearer token|authenticat/i }, text);

const RESUME_FAILED = /no conversation found|session id|could not resume/i;

function claudeBackend(deps: ClaudeCodeDeps): CliBackend<ClaudeLive> {
	return {
		label: "Claude Code",
		composite: (modelId) => modelId,
		async launch(req: LaunchRequest) {
			const command = (deps.command ?? (() => findClaudeCommand()))();
			if (!command) throw new Error("没有找到 claude 命令。请先按 Claude Code 官方说明安装，再在终端运行 claude auth login 登录。");
			const queue = new EventQueue<Item | { type: "aborted" }>();
			const cwd = (deps.cwd ?? (() => join(deps.dataDir, "cli-models", "work")))();
			mkdirSync(cwd, { recursive: true }); // 目录不存在时 spawn 会报 ENOENT
			const run = new ClaudeRun({
				command,
				cwd,
				bridgeBaseUrl: deps.bridgeBaseUrl(),
				tools: req.tools as Tool[],
				args: { model: req.model, effort: req.effort, resumeSessionId: req.resumeSessionId, systemPrompt: req.systemPrompt, noSessionPersistence: req.oneShot || undefined },
				onEvent: (e) => queue.push(e),
				baseEnv: deps.baseEnv,
				extraEnv: deps.extraEnv?.(),
				bridge: deps.bridge ?? toolBridge,
			});
			const lr: ClaudeLive = { key: req.key, run, queue, pendingIds: new Set(), dead: false, offs: [], composite: req.composite };
			void run.done.then((exit) => {
				queue.push({ type: "exit", exit });
				req.forget(lr);
			});
			run.start();
			run.sendUserMessage(req.input);
			return lr;
		},
		async resume(lr, cont, ids) {
			// 插话先写进 stdin：claude 会在工具返回之后、下一次请求之前并入同一轮（实测 6）；先回填结果的话，下一次请求可能已经发出
			if (cont.extras.length) {
				const blocks = userMessagesToClaude(cont.extras);
				if (blocks.length) lr.run.sendUserMessage(blocks);
			}
			for (const id of ids) lr.run.resolveTool(id, toolResultToMcp(cont.results.get(id)!));
		},
		abort: (lr) => lr.run.abort(),
		isResumeFailure: () => false,
		step(lr, raw, b): Step[] {
			const item = raw as Item;
			if (item.type === "exit") {
				const x = item.exit;
				if (x.aborted) return [{ type: "fail", reason: "aborted", message: "已停止" }];
				if (x.spawnError) return [{ type: "fail", reason: "error", message: `无法启动 claude：${x.spawnError}` }];
				return [{ type: "fail", reason: "error", message: `Claude Code 进程意外退出（退出码 ${x.code ?? x.signal ?? "未知"}）${x.stderr ? `：${x.stderr}` : ""}` }];
			}
			if (item.type === "init") {
				lr.claudeSessionId ||= item.sessionId;
				return [{ type: "responded" }];
			}
			if (item.type === "result") {
				if (item.isError) return [{ type: "fail", reason: "error", message: describeClaudeError(item.text), resumeFailed: RESUME_FAILED.test(item.text), fallbackUsage: item.usage }];
				return [{ type: "finish", reason: lr.lastStop === "max_tokens" ? "length" : "stop", sessionId: item.sessionId || lr.claudeSessionId, fallbackUsage: item.usage }];
			}
			const steps: Step[] = [{ type: "content", ev: item }];
			if (item.type === "message_end") {
				lr.lastStop = item.stopReason;
				// 这条助理消息里 claude 调了工具：交给 Pi，进程留着等结果
				if (item.stopReason === "tool_use" && b.toolCallIds.length) steps.push({ type: "tool_use" });
			}
			return steps;
		},
	};
}

/** 本渠道一个实例 = 一张进行中运行表 + 一张对照表 */
export function createClaudeCodeChannel(deps: ClaudeCodeDeps) {
	return createCliChannel(claudeBackend(deps), deps.store ?? new SyncStore(join(deps.dataDir, "cli-models", "claude-sessions.json")));
}

/** 把 `claude-code` 渠道注册进 Pi（模型 opus / sonnet / haiku，自带 streamSimple）。 */
export async function registerClaudeCodeProvider(models: PiModels, deps: ClaudeCodeDeps) {
	const channel = createClaudeCodeChannel(deps);
	await registerCliProvider(models, {
		id: CLAUDE_CODE_PROVIDER,
		name: "Claude Code（本机）",
		api: CLAUDE_CODE_API,
		baseUrl: "claude-code://local",
		streamSimple: channel.streamSimple as never,
		models: CLAUDE_CODE_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			// 思考强度对应 claude --effort 的 low…max；minimal 没有对应档位
			thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
			image: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
		})),
	});
	return channel;
}
