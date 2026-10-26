/**
 * claude stream-json 的一行 → 我们自己的简单事件（纯逻辑，带少量状态：块序号对应的工具 id、这条消息的输入用量）。
 * 样例和字段来源：docs/design/cli-models.md §7 第 5 条、§4.3。
 *
 * 要点：
 * - 文字 / 思考 / 工具参数都取自 `stream_event`（要 `--include-partial-messages`）；`assistant` 事件（每个块一条）不用。
 * - 一条助理消息何时结束：看 `message_delta{stop_reason}`；工具挂起时它也会立刻到，不用等 `result`。
 * - 用量：输入取 `message_start.usage`，输出取 `message_delta.usage.output_tokens`，整轮合计取 `result.usage`。
 *   **不读** `assistant.message.usage.output_tokens`（永远是 0），也不信 `thinking_tokens`。
 * - 不转 `total_cost_usd`（订阅用户看 API 标价会被误导）。
 */
import { fromClaudeToolName } from "./launch.ts";

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export type ClaudeEvent =
	| { type: "init"; sessionId: string; tools: string[]; model: string }
	| { type: "message_start"; messageId: string; usage: TokenUsage }
	| { type: "text_start" }
	| { type: "text_delta"; text: string }
	| { type: "text_end" }
	| { type: "thinking_start" }
	| { type: "thinking_delta"; text: string }
	| { type: "thinking_end" }
	/** `name` 已去掉 `mcp__pia__` 前缀，是 Pi 里的工具名 */
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_args_delta"; id: string; partialJson: string }
	/** `args` 是解析好的参数；JSON 不完整时 `args` 为 `{}` 且带 `argsRaw` */
	| { type: "tool_call_end"; id: string; name: string; args: Record<string, unknown>; argsRaw?: string }
	/** `stopReason`：`tool_use` / `end_turn` / `max_tokens` 等 claude 原样的值 */
	| { type: "message_end"; stopReason: string; usage: TokenUsage }
	/** 工具挂起期间每 30 秒一条，表示进程还活着 */
	| { type: "heartbeat"; toolUseId: string }
	/** claude 回填的工具结果（超时 / 取消时 `isError` 为真），用来发现它自己掐断了工具 */
	| { type: "tool_result"; toolUseId: string; isError: boolean; text: string }
	| { type: "result"; sessionId: string; isError: boolean; text: string; usage: TokenUsage }
	/** 不是 JSON 的 stdout 行（可能是错误提示） */
	| { type: "unparsed"; line: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const usageOf = (u: unknown): TokenUsage => {
	const o = isObj(u) ? u : {};
	return { input: num(o.input_tokens), output: num(o.output_tokens), cacheRead: num(o.cache_read_input_tokens), cacheWrite: num(o.cache_creation_input_tokens) };
};

/** tool_result 的 content 可能是字符串，也可能是 [{type:"text",text}] */
function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b) => (isObj(b) && b.type === "text" ? str(b.text) : "")).join("");
}

interface Block {
	kind: "text" | "thinking" | "tool";
	id: string;
	name: string;
	json: string;
}

export interface EventConverter {
	/** 一行 stdout → 0 到多个事件 */
	convert(line: string): ClaudeEvent[];
}

export function createEventConverter(): EventConverter {
	const blocks = new Map<number, Block>();
	let startUsage = usageOf(undefined);

	function stream(ev: Obj): ClaudeEvent[] {
		const idx = num(ev.index);
		switch (ev.type) {
			case "message_start": {
				const m = isObj(ev.message) ? ev.message : {};
				startUsage = usageOf(m.usage);
				blocks.clear();
				return [{ type: "message_start", messageId: str(m.id), usage: startUsage }];
			}
			case "content_block_start": {
				const b = isObj(ev.content_block) ? ev.content_block : {};
				if (b.type === "tool_use") {
					const blk: Block = { kind: "tool", id: str(b.id), name: fromClaudeToolName(str(b.name)), json: "" };
					blocks.set(idx, blk);
					return [{ type: "tool_call_start", id: blk.id, name: blk.name }];
				}
				if (b.type === "thinking") {
					blocks.set(idx, { kind: "thinking", id: "", name: "", json: "" });
					return [{ type: "thinking_start" }];
				}
				if (b.type === "text") {
					blocks.set(idx, { kind: "text", id: "", name: "", json: "" });
					return [{ type: "text_start" }];
				}
				return [];
			}
			case "content_block_delta": {
				const d = isObj(ev.delta) ? ev.delta : {};
				const blk = blocks.get(idx);
				if (d.type === "text_delta") return [{ type: "text_delta", text: str(d.text) }];
				if (d.type === "thinking_delta") return [{ type: "thinking_delta", text: str(d.thinking) }];
				if (d.type === "input_json_delta" && blk?.kind === "tool") {
					const part = str(d.partial_json);
					blk.json += part;
					return [{ type: "tool_call_args_delta", id: blk.id, partialJson: part }];
				}
				return []; // signature_delta 等：续用 claude 自己的会话，不需要
			}
			case "content_block_stop": {
				const blk = blocks.get(idx);
				blocks.delete(idx);
				if (!blk) return [];
				if (blk.kind === "text") return [{ type: "text_end" }];
				if (blk.kind === "thinking") return [{ type: "thinking_end" }];
				const raw = blk.json.trim();
				if (!raw) return [{ type: "tool_call_end", id: blk.id, name: blk.name, args: {} }];
				try {
					const parsed: unknown = JSON.parse(raw);
					if (isObj(parsed)) return [{ type: "tool_call_end", id: blk.id, name: blk.name, args: parsed }];
				} catch {}
				return [{ type: "tool_call_end", id: blk.id, name: blk.name, args: {}, argsRaw: blk.json }];
			}
			case "message_delta": {
				const d = isObj(ev.delta) ? ev.delta : {};
				const u = isObj(ev.usage) ? ev.usage : {};
				const usage: TokenUsage = {
					input: num(u.input_tokens) || startUsage.input,
					output: num(u.output_tokens),
					cacheRead: num(u.cache_read_input_tokens) || startUsage.cacheRead,
					cacheWrite: num(u.cache_creation_input_tokens) || startUsage.cacheWrite,
				};
				return [{ type: "message_end", stopReason: str(d.stop_reason) || "end_turn", usage }];
			}
			default:
				return []; // message_stop 等
		}
	}

	function convert(line: string): ClaudeEvent[] {
		const text = line.trim();
		if (!text) return [];
		let msg: unknown;
		try {
			msg = JSON.parse(text);
		} catch {
			return [{ type: "unparsed", line: text }];
		}
		if (!isObj(msg)) return [{ type: "unparsed", line: text }];
		switch (msg.type) {
			case "system":
				if (msg.subtype !== "init") return [];
				return [{ type: "init", sessionId: str(msg.session_id), tools: Array.isArray(msg.tools) ? msg.tools.map(str) : [], model: str(msg.model) }];
			case "stream_event":
				return isObj(msg.event) ? stream(msg.event) : [];
			case "tool_progress":
				return msg.heartbeat === true ? [{ type: "heartbeat", toolUseId: str(msg.parent_tool_use_id) || str(msg.tool_use_id) }] : [];
			case "user": {
				const m = isObj(msg.message) ? msg.message : {};
				if (!Array.isArray(m.content)) return [];
				return m.content
					.filter((b): b is Obj => isObj(b) && b.type === "tool_result")
					.map((b) => ({ type: "tool_result" as const, toolUseId: str(b.tool_use_id), isError: b.is_error === true, text: toolResultText(b.content) }));
			}
			case "result": {
				const isError = msg.is_error === true;
				const text = str(msg.result) || (isError ? str(msg.subtype) : "");
				return [{ type: "result", sessionId: str(msg.session_id), isError, text, usage: usageOf(msg.usage) }];
			}
			default:
				return []; // assistant（每块一条，用量是占位）、system/status、thinking_tokens 等
		}
	}

	return { convert };
}
