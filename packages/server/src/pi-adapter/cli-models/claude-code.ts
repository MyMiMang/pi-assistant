/**
 * `claude-code` 模型渠道：把本机已登录的 `claude` 包装成 Pi 的一个模型渠道（方案 docs/design/cli-models.md §3、§4）。
 *
 * - 每轮用户消息起一个 claude 进程（`cli-agents/claude-process.ts`），内置工具全关，只能用 Pi 里的工具（经工具桥 MCP）。
 * - claude 想调工具：这一段 Pi 消息以 `toolUse` 结束，**claude 进程留在「进行中运行」表里**；Pi 执行完工具再调 `streamSimple`，
 *   渠道发现末尾是这些 toolCall 的 toolResult，就按 id 把结果回填，接着把 claude 后续事件流给这次调用。
 * - 跨轮靠 `sync-map.ts` 的对照表 `--resume`；对不上就新开会话，把 Pi 上下文渲染成文字送进去。
 * - 没有工具的请求（Pi 整理上下文时的总结等）：单次跑完，不续用会话、不留 claude 会话记录。
 * 只有这里和 `index.ts` 的注册入口与 Pi 打交道；claude 进程、工具桥、事件转换都在 `cli-agents/`（与 Pi 无关）。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type Api, type AssistantMessageEventStream, type Message, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { ClaudeRun, type ClaudeExit, type UserContent } from "../../cli-agents/claude-process.ts";
import { findClaudeCommand } from "../../cli-agents/detect.ts";
import type { ClaudeEvent } from "../../cli-agents/events.ts";
import { toolBridge, type Tool, type ToolBridge } from "../../cli-agents/tool-bridge.ts";
import type { PiModels } from "../index.ts";
import { conversationOf, matchContinuation, renderFreshInput, thinkingToEffort, toolResultToMcp, userMessagesToClaude } from "./convert.ts";
import { SegmentBuilder } from "./segment.ts";
import { makeSyncEntry, messageHash, planTurn, SyncStore, type TurnPlan } from "./sync-map.ts";

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

type QItem = ClaudeEvent | { type: "exit"; exit: ClaudeExit } | { type: "aborted" };

/** 进程那边来的事件先排队，`streamSimple` 这边按需一个个取（工具挂起期间事件继续排队，下一次调用接着取） */
class EventQueue {
	private items: QItem[] = [];
	private waiter: ((i: QItem) => void) | undefined;
	push(i: QItem): void {
		if (this.waiter) {
			const w = this.waiter;
			this.waiter = undefined;
			w(i);
		} else this.items.push(i);
	}
	next(): Promise<QItem> {
		const i = this.items.shift();
		return i ? Promise.resolve(i) : new Promise((r) => (this.waiter = r));
	}
}

interface LiveRun {
	run: ClaudeRun;
	queue: EventQueue;
	/** 已交给 Pi、等 Pi 执行完工具回来的 toolCall id */
	pendingIds: Set<string>;
	claudeSessionId?: string;
	lastStop?: string;
	dead: boolean;
	offs: Array<() => void>;
}

const mcpToolOf = (t: { name: string; description: string; parameters: unknown }): Tool => {
	const schema = JSON.parse(JSON.stringify(t.parameters ?? {})) as Record<string, unknown>;
	return { name: t.name, description: t.description, inputSchema: { ...schema, type: "object" } as Tool["inputSchema"] };
};

/** claude 报错 → 中文说明，带上原文 */
export function describeClaudeError(text: string): string {
	const raw = text.trim() || "（没有错误内容）";
	if (/not logged in|please run \/login|\/login/i.test(raw)) return `本机 Claude Code 未登录，请在终端运行 claude auth login。原文：${raw}`;
	if (/invalid bearer token|authenticat/i.test(raw)) return `Claude Code 认证失败，请在终端运行 claude auth login 重新登录。原文：${raw}`;
	return `Claude Code 出错：${raw}`;
}

const RESUME_FAILED = /no conversation found|session id|could not resume/i;

/** 本渠道一个实例 = 一张进行中运行表 + 一张对照表 */
export function createClaudeCodeChannel(deps: ClaudeCodeDeps) {
	const live = new Map<string, LiveRun>();
	const store = deps.store ?? new SyncStore(join(deps.dataDir, "cli-models", "claude-sessions.json"));

	function killLive(key: string): void {
		const lr = live.get(key);
		live.delete(key);
		if (lr) {
			lr.dead = true;
			lr.run.abort();
		}
	}

	function watch(lr: LiveRun, signal: AbortSignal | undefined): void {
		if (!signal) return;
		const onAbort = () => {
			lr.dead = true; // 之后再有请求不能续接到这个已被中止的运行上
			lr.queue.push({ type: "aborted" });
			lr.run.abort();
		};
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		lr.offs.push(() => signal.removeEventListener("abort", onAbort));
	}

	function launch(key: string | undefined, tools: Tool[], opts: { claudeModel: string; effort?: string; resume?: string; systemPrompt?: string; oneShot: boolean }): LiveRun {
		const command = (deps.command ?? (() => findClaudeCommand()))();
		if (!command) throw new Error("没有找到 claude 命令。请先按 Claude Code 官方说明安装，再在终端运行 claude auth login 登录。");
		const queue = new EventQueue();
		const cwd = (deps.cwd ?? (() => join(deps.dataDir, "cli-models", "work")))();
		mkdirSync(cwd, { recursive: true }); // 目录不存在时 spawn 会报 ENOENT
		const run = new ClaudeRun({
			command,
			cwd,
			bridgeBaseUrl: deps.bridgeBaseUrl(),
			tools,
			args: { model: opts.claudeModel, effort: opts.effort, resumeSessionId: opts.resume, systemPrompt: opts.systemPrompt, noSessionPersistence: opts.oneShot || undefined },
			onEvent: (e) => queue.push(e),
			baseEnv: deps.baseEnv,
			extraEnv: deps.extraEnv?.(),
			bridge: deps.bridge ?? toolBridge,
		});
		const lr: LiveRun = { run, queue, pendingIds: new Set(), dead: false, offs: [] };
		void run.done.then((exit) => {
			lr.dead = true;
			for (const off of lr.offs) off();
			queue.push({ type: "exit", exit });
			if (key && live.get(key) === lr) live.delete(key);
		});
		run.start();
		return lr;
	}

	async function pump(lr: LiveRun, b: SegmentBuilder, model: Model<Api>, options: SimpleStreamOptions | undefined, ctx: { key?: string; claudeModel: string; messages: Message[]; canRetryFresh: boolean }): Promise<"retry-fresh" | undefined> {
		let responded = false;
		const finishDead = () => {
			if (ctx.key) live.delete(ctx.key);
			lr.dead = true;
			for (const off of lr.offs) off();
		};
		for (;;) {
			const item = await lr.queue.next();
			if (item.type === "aborted") {
				finishDead();
				if (ctx.key) store.delete(ctx.key);
				b.fail("aborted", "已停止");
				return;
			}
			if (item.type === "exit") {
				finishDead();
				if (ctx.key) store.delete(ctx.key);
				const x = item.exit;
				if (x.aborted) b.fail("aborted", "已停止");
				else if (x.spawnError) b.fail("error", `无法启动 claude：${x.spawnError}`);
				else b.fail("error", `Claude Code 进程意外退出（退出码 ${x.code ?? x.signal ?? "未知"}）${x.stderr ? `：${x.stderr}` : ""}`);
				return;
			}
			await options?.onProviderStreamEvent?.(item, model);
			if (item.type === "init") {
				lr.claudeSessionId ||= item.sessionId;
				if (!responded) {
					responded = true;
					await options?.onResponse?.({ status: 200, headers: {} }, model);
				}
				continue;
			}
			if (item.type === "result") {
				finishDead();
				if (item.isError) {
					if (ctx.key) store.delete(ctx.key);
					if (ctx.canRetryFresh && !b.message.content.length && RESUME_FAILED.test(item.text)) return "retry-fresh";
					b.useFallbackUsage(item.usage);
					b.fail("error", describeClaudeError(item.text));
					return;
				}
				b.useFallbackUsage(item.usage);
				b.finish(lr.lastStop === "max_tokens" ? "length" : "stop");
				const sid = item.sessionId || lr.claudeSessionId;
				if (ctx.key && sid) store.set(ctx.key, makeSyncEntry(sid, ctx.claudeModel, ctx.messages, b.message));
				return;
			}
			b.handle(item);
			if (item.type === "message_end") {
				lr.lastStop = item.stopReason;
				const ids = b.toolCallIds;
				if (item.stopReason === "tool_use" && ids.length) {
					// 工具交回 Pi：这一段到此结束，claude 进程留在表里等结果
					lr.pendingIds = new Set(ids);
					b.finish("toolUse");
					return;
				}
			}
		}
	}

	/** 取 onPayload 可能返回的替换内容里我们认得的字段 */
	function applyPayload(payload: Payload, replaced: unknown): Payload {
		if (!replaced || typeof replaced !== "object") return payload;
		const r = replaced as Partial<Payload>;
		return {
			model: typeof r.model === "string" ? r.model : payload.model,
			effort: r.effort === undefined ? payload.effort : r.effort,
			systemPrompt: typeof r.systemPrompt === "string" ? r.systemPrompt : payload.systemPrompt,
			resumeSessionId: r.resumeSessionId === undefined ? payload.resumeSessionId : r.resumeSessionId,
			input: typeof r.input === "string" || Array.isArray(r.input) ? r.input : payload.input,
			tools: payload.tools,
		};
	}

	async function drive(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream): Promise<void> {
		const piTools = getCurrentTools(context.messages);
		const b = new SegmentBuilder(model, stream, new Set(piTools.map((t) => t.name)));
		const messages = conversationOf(context.messages);
		const oneShot = piTools.length === 0;
		const key = oneShot ? undefined : (options?.sessionId ?? `h:${messages[0] ? messageHash(messages[0]) : "empty"}`);
		if (options?.signal?.aborted) return b.fail("aborted", "已停止");

		// 同一轮续接：把 Pi 执行完的工具结果按 id 回填给还挂着的 claude
		const existing = key ? live.get(key) : undefined;
		if (key && existing) {
			const cont = existing.dead ? null : matchContinuation(messages, existing.pendingIds);
			if (cont) {
				b.start();
				watch(existing, options?.signal);
				// 插话先写进 stdin：claude 会在工具返回之后、下一次请求之前并入同一轮（实测 6）；先回填结果的话，下一次请求可能已经发出
				if (cont.extras.length) {
					const blocks = userMessagesToClaude(cont.extras);
					if (blocks.length) existing.run.sendUserMessage(blocks);
				}
				const ids = [...existing.pendingIds];
				existing.pendingIds = new Set();
				for (const id of ids) existing.run.resolveTool(id, toolResultToMcp(cont.results.get(id)!));
				await pump(existing, b, model, options, { key, claudeModel: model.id, messages, canRetryFresh: false });
				return;
			}
			killLive(key); // 对不上（Pi 重试 / 分支 / 进程已死）：丢掉旧的，当新的一轮
		}

		const claudeModel = model.id;
		const effort = thinkingToEffort(options?.reasoning);
		let plan: TurnPlan = oneShot ? { mode: "fresh", reason: "单次请求", input: renderFreshInput(messages) } : planTurn(key ? store.get(key) : undefined, claudeModel, messages);
		const tools = piTools.map(mcpToolOf);
		const systemPrompt = getCurrentSystemPrompt(context.messages) || undefined;
		let started = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			const base: Payload = { model: claudeModel, effort, systemPrompt, resumeSessionId: plan.mode === "resume" ? plan.claudeSessionId : undefined, input: plan.input, tools: tools.map((t) => t.name) };
			const payload = applyPayload(base, await options?.onPayload?.(base, model));
			let lr: LiveRun;
			try {
				lr = launch(key, tools, { claudeModel: payload.model, effort: payload.effort, resume: payload.resumeSessionId, systemPrompt: payload.systemPrompt, oneShot });
			} catch (e) {
				return b.fail("error", e instanceof Error ? e.message : String(e));
			}
			if (!started) {
				started = true;
				b.start();
			}
			if (key) live.set(key, lr);
			watch(lr, options?.signal);
			lr.run.sendUserMessage(payload.input);
			const out = await pump(lr, b, model, options, { key, claudeModel, messages, canRetryFresh: plan.mode === "resume" && attempt === 0 });
			if (out !== "retry-fresh") return;
			plan = { mode: "fresh", reason: "claude 找不到要续用的会话", input: renderFreshInput(messages) };
		}
	}

	function streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		drive(model, context, options, stream).catch((e) => {
			const b = new SegmentBuilder(model, stream, new Set());
			b.fail("error", `Claude Code 渠道出错：${e instanceof Error ? e.message : String(e)}`);
		});
		return stream;
	}

	/** 结束全部进行中的运行（服务关闭 / 测试收尾） */
	function disposeAll(): void {
		for (const key of [...live.keys()]) killLive(key);
	}

	return { streamSimple, disposeAll, liveCount: () => live.size, store };
}

/** 发给 claude 的请求内容（`onPayload` 可看可换） */
interface Payload {
	model: string;
	effort: string | undefined;
	systemPrompt: string | undefined;
	resumeSessionId: string | undefined;
	input: UserContent;
	tools: string[];
}

/** 把 `claude-code` 渠道注册进 Pi（模型 opus / sonnet / haiku，自带 streamSimple）。 */
export async function registerClaudeCodeProvider(models: PiModels, deps: ClaudeCodeDeps) {
	const channel = createClaudeCodeChannel(deps);
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	models.registerProvider(CLAUDE_CODE_PROVIDER, {
		name: "Claude Code（本机）",
		baseUrl: "claude-code://local",
		api: CLAUDE_CODE_API,
		streamSimple: channel.streamSimple,
		models: CLAUDE_CODE_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			api: CLAUDE_CODE_API,
			baseUrl: "claude-code://local",
			reasoning: m.reasoning,
			// 思考强度对应 claude --effort 的 low…max；minimal 没有对应档位
			...(m.reasoning ? { thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" } } : {}),
			input: ["text", "image"],
			cost,
			contextWindow: 200_000,
			maxTokens: 64_000,
		})),
	});
	// 不需要密钥；给个占位让 Pi 把这个渠道算作可用（登录状态由设置卡片的检测负责）
	await models.setRuntimeApiKey(CLAUDE_CODE_PROVIDER, "local");
	return channel;
}
