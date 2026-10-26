/**
 * 本机命令行工具（claude / codex / 以后的 agy）当 Pi 模型渠道的**共用骨架**（方案 docs/design/cli-models.md §3、§5.3）。
 *
 * 骨架管流程：`streamSimple` 的入口、事件队列、SegmentBuilder 收尾、abort、「工具交回 Pi → 同一轮续接」、
 * 对照表续用、对不上 / 续用失败就重开（把 Pi 上下文渲染成文字）、没有工具的单次请求、onPayload / onResponse / onProviderStreamEvent 钩子。
 * 每家只写自己协议相关的 `CliBackend`：怎么启动并发首条输入、怎么把工具结果和插话交回去、怎么打断、原生事件怎么翻成 `Step`。
 * 加新的一家 = 写一个 `CliBackend`（见 docs/MODULES.md），不要复制这里的流程。
 */
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type Api, type AssistantMessageEventStream, type Message, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { TokenUsage } from "../../cli-agents/events.ts";
import type { Tool } from "../../cli-agents/tool-bridge.ts";
import { conversationOf, matchContinuation, renderFreshInput, thinkingToEffort, toolDefOf, type ClaudeBlock, type Continuation } from "./convert.ts";
import { SegmentBuilder, type SegmentEvent } from "./segment.ts";
import { makeSyncEntry, messageHash, planTurn, type SyncStore, type TurnPlan } from "./sync-map.ts";

/** 发给命令行工具的用户输入：纯文字或统一的内容块（文字 / base64 图片） */
export type CliInput = string | ClaudeBlock[];

/** 一次启动的请求（骨架算好，交给 `backend.launch`） */
export interface LaunchRequest {
	/** Pi 会话键；单次请求（没有工具）没有 */
	key?: string;
	model: string;
	effort?: string;
	systemPrompt?: string;
	/** 续用的会话 / 线程 id；没有 = 新开 */
	resumeSessionId?: string;
	input: CliInput;
	tools: Tool[];
	oneShot: boolean;
	/** 这一轮开始时「模型 + 工具集 + 系统提示」的指纹，结束时写对照表用 */
	composite: string;
	/** 运行自己没了（进程退出）时调用：从进行中表里去掉，之后不能再被续接 */
	forget: (live: CliLive) => void;
}

/** 一个进行中的运行（进程 / 线程）。各家在此基础上加自己的字段。 */
export interface CliLive {
	key?: string;
	/** 原生事件队列；骨架自己会往里放 `{type:"aborted"}` */
	queue: { push(item: { type: string }): void; next(): Promise<{ type: string }> };
	dead: boolean;
	/** 结束时要执行的清理（取消监听等） */
	offs: Array<() => void>;
	/** 已交给 Pi、等 Pi 执行完工具回来的 toolCall id */
	pendingIds: Set<string>;
	composite: string;
}

/** 原生事件翻译出来的「步骤」：骨架按它推进 SegmentBuilder */
export type Step =
	| { type: "content"; ev: SegmentEvent }
	/** `set` = 整个换成这个值；`fallback` = 这一段没有别的用量时才用 */
	| { type: "usage"; usage: TokenUsage; mode: "set" | "fallback" }
	/** 对方已经有响应了（触发一次 `onResponse`） */
	| { type: "responded" }
	/** 这一段以 toolUse 结束，运行保持挂着；`ids` 默认取这一段里交给 Pi 的 toolCall */
	| { type: "tool_use"; ids?: string[] }
	/** 这一轮正常结束；`sessionId` 用来写对照表 */
	| { type: "finish"; reason: "stop" | "length"; sessionId?: string; fallbackUsage?: TokenUsage }
	/** 出错 / 被中止；`resumeFailed`：是「续用的会话找不到」，骨架会改成新开重来一次 */
	| { type: "fail"; reason: "error" | "aborted"; message: string; resumeFailed?: boolean; fallbackUsage?: TokenUsage };

/** 每家要实现的协议适配 */
export interface CliBackend<L extends CliLive> {
	/** 界面 / 错误里的名字，如 `Claude Code` */
	label: string;
	/** 续用判断用的指纹：不一样就不续用旧会话（至少含模型；codex 还含工具集和系统提示） */
	composite(modelId: string, tools: Tool[], systemPrompt: string | undefined): string;
	/** 启动 / 续用并发出首条输入；失败抛错（message 就是给用户看的中文说明） */
	launch(req: LaunchRequest): Promise<L>;
	/** Pi 执行完工具回来：先交插话，再把结果回给挂着的那几个调用（`ids` = 之前挂着的 toolCall id） */
	resume(live: L, cont: Continuation, ids: string[]): Promise<void>;
	/** 打断运行（结束进程 / `turn/interrupt`），尽力而为；不负责从表里删 */
	abort(live: L): void;
	/** 原生事件 → 步骤。`b` 是当前这一段（可读 `toolCallIds` 等） */
	step(live: L, item: { type: string }, b: SegmentBuilder): Step[];
	/** 报错文字是不是「续用的会话找不到」（启动时就抛错的那种） */
	isResumeFailure(message: string): boolean;
	/** 运行结束后的清理（可选）：`oneShot` 的运行也会走到这里 */
	release?(live: L, oneShot: boolean): void;
	/** 服务关闭 */
	dispose?(): void;
}

export function createCliChannel<L extends CliLive>(backend: CliBackend<L>, store: SyncStore) {
	const live = new Map<string, L>();

	/** 一个运行不再进行：从表里去掉、不再被续接、执行清理 */
	function finish(l: L, oneShot = !l.key): void {
		if (l.key && live.get(l.key) === l) live.delete(l.key);
		l.dead = true;
		for (const off of l.offs) off();
		l.offs = [];
		backend.release?.(l, oneShot);
	}

	function kill(key: string): void {
		const l = live.get(key);
		live.delete(key);
		if (l && !l.dead) {
			backend.abort(l);
			finish(l);
		}
	}

	function watch(l: L, signal: AbortSignal | undefined): void {
		if (!signal) return;
		const onAbort = () => {
			if (l.dead) return;
			backend.abort(l);
			finish(l); // 之后再有请求不能续接到这个已被中止的运行上
			l.queue.push({ type: "aborted" });
		};
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		l.offs.push(() => signal.removeEventListener("abort", onAbort));
	}

	async function pump(l: L, b: SegmentBuilder, model: Model<Api>, options: SimpleStreamOptions | undefined, ctx: { messages: Message[]; canRetryFresh: boolean }): Promise<"retry-fresh" | undefined> {
		let responded = false;
		for (;;) {
			const item = await l.queue.next();
			if (item.type === "aborted") {
				finish(l);
				if (l.key) store.delete(l.key);
				b.fail("aborted", "已停止");
				return;
			}
			if (item.type !== "exit") await options?.onProviderStreamEvent?.(item, model);
			for (const s of backend.step(l, item, b)) {
				switch (s.type) {
					case "content":
						b.handle(s.ev);
						break;
					case "usage":
						if (s.mode === "set") b.setUsage(s.usage);
						else b.useFallbackUsage(s.usage);
						break;
					case "responded":
						if (!responded) {
							responded = true;
							await options?.onResponse?.({ status: 200, headers: {} }, model);
						}
						break;
					case "tool_use":
						// 工具交回 Pi：这一段到此结束，运行留在表里等结果
						l.pendingIds = new Set(s.ids ?? b.toolCallIds);
						b.finish("toolUse");
						return;
					case "finish":
						finish(l);
						if (s.fallbackUsage) b.useFallbackUsage(s.fallbackUsage);
						b.finish(s.reason);
						if (l.key && s.sessionId) store.set(l.key, makeSyncEntry(s.sessionId, l.composite, ctx.messages, b.message));
						return;
					case "fail":
						finish(l);
						if (l.key) store.delete(l.key);
						if (s.resumeFailed && ctx.canRetryFresh && !b.message.content.length) return "retry-fresh";
						if (s.fallbackUsage) b.useFallbackUsage(s.fallbackUsage);
						b.fail(s.reason, s.message);
						return;
				}
			}
		}
	}

	async function drive(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream): Promise<void> {
		const piTools = getCurrentTools(context.messages);
		const b = new SegmentBuilder(model, stream, new Set(piTools.map((t) => t.name)));
		const messages = conversationOf(context.messages);
		const oneShot = piTools.length === 0;
		const key = oneShot ? undefined : (options?.sessionId ?? `h:${messages[0] ? messageHash(messages[0]) : "empty"}`);
		if (options?.signal?.aborted) return b.fail("aborted", "已停止");

		// 同一轮续接：把 Pi 执行完的工具结果回填给还挂着的运行
		const existing = key ? live.get(key) : undefined;
		if (key && existing) {
			const cont = existing.dead ? null : matchContinuation(messages, existing.pendingIds);
			if (cont) {
				b.start();
				watch(existing, options?.signal);
				const ids = [...existing.pendingIds];
				existing.pendingIds = new Set();
				await backend.resume(existing, cont, ids);
				await pump(existing, b, model, options, { messages, canRetryFresh: false });
				return;
			}
			kill(key); // 对不上（Pi 重试 / 分支 / 进程已死）：丢掉旧的，当新的一轮
		}

		const effort = thinkingToEffort(options?.reasoning);
		const tools = piTools.map(toolDefOf);
		const systemPrompt = getCurrentSystemPrompt(context.messages) || undefined;
		const composite = backend.composite(model.id, tools, systemPrompt);
		let plan: TurnPlan = oneShot ? { mode: "fresh", reason: "单次请求", input: renderFreshInput(messages) } : planTurn(key ? store.get(key) : undefined, composite, messages);
		let started = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			const base: Payload = { model: model.id, effort, systemPrompt, resumeSessionId: plan.mode === "resume" ? plan.claudeSessionId : undefined, input: plan.input, tools: tools.map((t) => t.name) };
			const payload = applyPayload(base, await options?.onPayload?.(base, model));
			let l: L;
			try {
				l = await backend.launch({ key, model: payload.model, effort: payload.effort, systemPrompt: payload.systemPrompt, resumeSessionId: payload.resumeSessionId, input: payload.input, tools, oneShot, composite, forget: (x) => finish(x as L) });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (plan.mode === "resume" && attempt === 0 && backend.isResumeFailure(msg)) {
					if (key) store.delete(key);
					plan = { mode: "fresh", reason: `${backend.label} 找不到要续用的会话`, input: renderFreshInput(messages) };
					continue;
				}
				return b.fail("error", msg);
			}
			if (!started) {
				started = true;
				b.start();
			}
			if (key) live.set(key, l);
			watch(l, options?.signal);
			const out = await pump(l, b, model, options, { messages, canRetryFresh: plan.mode === "resume" && attempt === 0 });
			if (out !== "retry-fresh") return;
			plan = { mode: "fresh", reason: `${backend.label} 找不到要续用的会话`, input: renderFreshInput(messages) };
		}
	}

	function streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		drive(model, context, options, stream).catch((e) => {
			const b = new SegmentBuilder(model, stream, new Set());
			b.fail("error", `${backend.label} 渠道出错：${e instanceof Error ? e.message : String(e)}`);
		});
		return stream;
	}

	/** 结束全部进行中的运行（服务关闭 / 测试收尾） */
	function disposeAll(): void {
		for (const key of [...live.keys()]) kill(key);
		backend.dispose?.();
	}

	return { streamSimple, disposeAll, liveCount: () => live.size, store };
}

/** 发给命令行工具的请求内容（`onPayload` 可看可换） */
interface Payload {
	model: string;
	effort: string | undefined;
	systemPrompt: string | undefined;
	resumeSessionId: string | undefined;
	input: CliInput;
	tools: string[];
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

export type CliChannel = ReturnType<typeof createCliChannel>;
