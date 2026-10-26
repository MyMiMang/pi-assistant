/**
 * agy `--output-format stream-json` 的一行 → 我们自己的简单事件（纯逻辑，无状态）。样例和字段来源：docs/design/cli-models.md §5b.1 第 7 条。
 *
 * 三种原始事件：`init`（会话 id、模型）、`step_update`（一步的进展）、`result`（一轮结束）。
 * - 文字：`agent_response` 的 `ACTIVE` 带 `text_delta`（块比较大，不是逐字）；`DONE` 带结尾的换行和这一步的用量，
 *   用量**不含**缓存读取（`cache_read_tokens` 另算）。每次模型请求（含工具后的续写）是一个 `agent_response` 步骤。
 * - 工具：`tool` 步骤 ACTIVE（带 `tool_name`、参数）→ DONE / ERROR。工具名带 `mcp_pia_pia_` 前缀的是我们的；
 *   工具什么时候交给 Pi 看工具桥收到的 `tools/call`（`step_index` 是两边的配对键），这里的 `tool_step` 只是旁证（agy 自己掐断工具时是 ERROR）。
 * - 没有思考内容（`thinking_tokens` 一直是 0），所以不产生 thinking 事件。
 * 文字 / 用量 / 结果事件和 claude 的同形（`ClaudeEvent`），SegmentBuilder 直接吃。
 */
import type { ClaudeEvent, TokenUsage } from "./events.ts";
import { fromAgyToolName } from "./agy-launch.ts";

export type AgyEvent =
	| Extract<ClaudeEvent, { type: "init" | "text_delta" | "message_end" | "result" | "unparsed" }>
	/** 一个工具步骤的进展；`mine` = 是我们工具桥的工具（不是 agy 残留的自带工具） */
	| { type: "tool_step"; stepIndex: number; state: string; name: string; mine: boolean; args: Record<string, unknown> }
	/** `error_message` 步骤的文字（出错原因的旁证，正式结果看 `result`） */
	| { type: "step_error"; text: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** agy 的用量 → 统一用量（input 本来就不含缓存读取） */
export const agyUsageOf = (u: unknown): TokenUsage => {
	const o = isObj(u) ? u : {};
	return { input: num(o.input_tokens), output: num(o.output_tokens), cacheRead: num(o.cache_read_tokens), cacheWrite: 0 };
};

function stepEvents(s: Obj): AgyEvent[] {
	switch (s.step_type) {
		case "agent_response": {
			const text = str(s.text_delta);
			if (s.state === "ACTIVE") return text ? [{ type: "text_delta", text }] : [];
			if (s.state !== "DONE") return [];
			// DONE 通常只带结尾的 "\n"；万一带了真正的文字也要保留
			const out: AgyEvent[] = text.trim() ? [{ type: "text_delta", text }] : [];
			out.push({ type: "message_end", stopReason: "end_turn", usage: agyUsageOf(s.usage) });
			return out;
		}
		case "tool": {
			const info = isObj(s.tool_info) ? s.tool_info : {};
			const { name, mine } = fromAgyToolName(str(s.tool_name) || str(info.name));
			return [{ type: "tool_step", stepIndex: num(s.step_index), state: str(s.state), name, mine, args: isObj(info.parameters) ? info.parameters : {} }];
		}
		case "error_message":
			return [{ type: "step_error", text: str(s.text_delta) || str(s.error) || str(s.text) }];
		default:
			return []; // user_input 等
	}
}

/** 一行 stdout → 0 到多个事件 */
export function convertAgyLine(line: string): AgyEvent[] {
	const text = line.trim();
	if (!text) return [];
	let msg: unknown;
	try {
		msg = JSON.parse(text);
	} catch {
		return [{ type: "unparsed", line: text }];
	}
	if (!isObj(msg)) return [{ type: "unparsed", line: text }];
	switch (msg.event) {
		case "init": {
			const init = isObj(msg.init) ? msg.init : {};
			return [{ type: "init", sessionId: str(msg.conversation_id), tools: [], model: str(init.model) }];
		}
		case "step_update":
			return isObj(msg.step_update) ? stepEvents(msg.step_update) : [];
		case "result": {
			const r = isObj(msg.result) ? msg.result : {};
			const isError = r.status !== "SUCCESS";
			return [{ type: "result", sessionId: str(r.conversation_id), isError, text: isError ? str(r.error) || str(r.status) : str(r.response), usage: agyUsageOf(r.usage) }];
		}
		default:
			return [];
	}
}
