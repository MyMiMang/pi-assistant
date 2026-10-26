/**
 * 把 claude 的简单事件（cli-agents/events.ts）拼成 Pi 的一条助理消息和事件流。
 *
 * 一次 `streamSimple` 调用对应一个「段」：从 `start` 到恰好一个 `done` 或 `error`。
 * 一轮里 claude 调了工具，这一段以 `toolUse` 结束（claude 进程不结束），Pi 执行完工具再开下一段。
 * 文字 / 思考 / 工具调用事件成对；结束前自动补上没关的块；cost 一律 0（订阅不显示钱）。
 */
import { parseStreamingJson, type AssistantMessage, type AssistantMessageEventStream, type Api, type Model, type ToolCall, type Usage } from "@earendil-works/pi-ai";
import type { CodexEvent } from "../../cli-agents/codex-events.ts";
import type { ClaudeEvent, TokenUsage } from "../../cli-agents/events.ts";

/** `SegmentBuilder.handle` 认得的事件：claude 和 codex 的文字 / 思考 / 工具调用事件同形 */
export type SegmentEvent = ClaudeEvent | CodexEvent;

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export class SegmentBuilder {
	readonly message: AssistantMessage;
	private started = false;
	private ended = false;
	private openText = -1;
	private openThinking = -1;
	private sawUsage = false;
	/** 工具调用块：claude 的 tool_use id → 在 content 里的下标 */
	private readonly toolIndex = new Map<string, number>();
	private readonly toolJson = new Map<string, string>();
	private readonly emittedToolIds: string[] = [];
	private readonly skipped = new Set<string>();

	constructor(
		model: Model<Api>,
		private readonly stream: AssistantMessageEventStream,
		/** Pi 里有的工具名；claude 自带的别的工具（如服务端搜索）不交给 Pi */
		private readonly toolNames: ReadonlySet<string>,
	) {
		this.message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "pending", timestamp: Date.now() };
	}

	get isEnded(): boolean {
		return this.ended;
	}

	/** 这一段里交给 Pi 的工具调用 id */
	get toolCallIds(): string[] {
		return [...this.emittedToolIds];
	}

	start(): void {
		if (this.started || this.ended) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.message });
	}

	private addUsage(u: TokenUsage): void {
		const total = this.message.usage;
		total.input += u.input;
		total.output += u.output;
		total.cacheRead += u.cacheRead;
		total.cacheWrite += u.cacheWrite;
		total.totalTokens = total.input + total.output + total.cacheRead + total.cacheWrite;
		this.sawUsage = true;
	}

	/** 用量整个换成这个值（codex：`thread/tokenUsage/updated` 的 last 是「最近一次模型请求」，不是累加；Pi 靠最后一条助理消息的用量估上下文，叠加会虚高） */
	setUsage(u: TokenUsage): void {
		const total = this.message.usage;
		total.input = u.input;
		total.output = u.output;
		total.cacheRead = u.cacheRead;
		total.cacheWrite = u.cacheWrite;
		total.totalTokens = u.input + u.output + u.cacheRead + u.cacheWrite;
		this.sawUsage = true;
	}

	/** 这一段没有任何 `message_end` 用量时（如直接报错），退而用整轮的 `result.usage`。 */
	useFallbackUsage(u: TokenUsage): void {
		if (!this.sawUsage) this.addUsage(u);
	}

	private closeText(): void {
		if (this.openText < 0) return;
		const block = this.message.content[this.openText];
		if (block.type === "text") this.stream.push({ type: "text_end", contentIndex: this.openText, content: block.text, partial: this.message });
		this.openText = -1;
	}

	private closeThinking(): void {
		if (this.openThinking < 0) return;
		const block = this.message.content[this.openThinking];
		if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: this.openThinking, content: block.thinking, partial: this.message });
		this.openThinking = -1;
	}

	/** 处理一个 claude 事件（文字 / 思考 / 工具调用 / 用量）；一段何时结束由调用方看 `message_end` 和 `result` 决定。 */
	handle(ev: SegmentEvent): void {
		if (this.ended) return;
		this.start();
		const m = this.message;
		switch (ev.type) {
			case "text_start": {
				this.closeText();
				this.openText = m.content.push({ type: "text", text: "" }) - 1;
				this.stream.push({ type: "text_start", contentIndex: this.openText, partial: m });
				return;
			}
			case "text_delta": {
				if (this.openText < 0) this.handle({ type: "text_start" });
				const b = m.content[this.openText];
				if (b.type === "text") b.text += ev.text;
				this.stream.push({ type: "text_delta", contentIndex: this.openText, delta: ev.text, partial: m });
				return;
			}
			case "text_end":
				this.closeText();
				return;
			case "thinking_start": {
				this.closeThinking();
				this.openThinking = m.content.push({ type: "thinking", thinking: "" }) - 1;
				this.stream.push({ type: "thinking_start", contentIndex: this.openThinking, partial: m });
				return;
			}
			case "thinking_delta": {
				if (this.openThinking < 0) this.handle({ type: "thinking_start" });
				const b = m.content[this.openThinking];
				if (b.type === "thinking") b.thinking += ev.text;
				this.stream.push({ type: "thinking_delta", contentIndex: this.openThinking, delta: ev.text, partial: m });
				return;
			}
			case "thinking_end":
				this.closeThinking();
				return;
			case "tool_call_start": {
				if (!this.toolNames.has(ev.name)) {
					this.skipped.add(ev.id);
					return;
				}
				const call: ToolCall = { type: "toolCall", id: ev.id, name: ev.name, arguments: {} };
				const idx = m.content.push(call) - 1;
				this.toolIndex.set(ev.id, idx);
				this.toolJson.set(ev.id, "");
				this.stream.push({ type: "toolcall_start", contentIndex: idx, partial: m });
				return;
			}
			case "tool_call_args_delta": {
				const idx = this.toolIndex.get(ev.id);
				if (idx === undefined) return;
				const json = (this.toolJson.get(ev.id) ?? "") + ev.partialJson;
				this.toolJson.set(ev.id, json);
				const call = m.content[idx];
				if (call.type === "toolCall") call.arguments = parseStreamingJson(json) as ToolCall["arguments"];
				this.stream.push({ type: "toolcall_delta", contentIndex: idx, delta: ev.partialJson, partial: m });
				return;
			}
			case "tool_call_end": {
				const idx = this.toolIndex.get(ev.id);
				if (idx === undefined) return;
				const call = m.content[idx];
				if (call.type !== "toolCall") return;
				call.arguments = ev.args as ToolCall["arguments"];
				if (ev.argsRaw !== undefined) call.argumentsError = `工具参数不是有效的 JSON 对象：${ev.argsRaw.slice(0, 500)}`;
				this.emittedToolIds.push(ev.id);
				this.stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: call, partial: m });
				return;
			}
			case "message_end":
				this.closeText();
				this.closeThinking();
				this.addUsage(ev.usage);
				return;
			default:
				return;
		}
	}

	private closeAll(): void {
		this.closeText();
		this.closeThinking();
	}

	/** 正常结束：`stop` / `length` / `toolUse` */
	finish(reason: "stop" | "length" | "toolUse"): void {
		if (this.ended) return;
		this.start();
		this.closeAll();
		this.ended = true;
		this.message.stopReason = reason;
		this.stream.push({ type: "done", reason, message: this.message });
		this.stream.end();
	}

	/** 出错或被中止。出错前没起好（没发过 start）时直接发 error。 */
	fail(reason: "error" | "aborted", errorMessage: string): void {
		if (this.ended) return;
		this.closeAll();
		this.ended = true;
		this.message.stopReason = reason;
		this.message.errorMessage = errorMessage;
		this.stream.push({ type: "error", reason, error: this.message });
		this.stream.end();
	}
}
