/**
 * `codex app-server` 的通知 / 服务端请求 → 我们自己的简单事件（纯逻辑，带少量状态；方案 docs/design/cli-models.md §5.1 第 4 条）。
 * 文字 / 思考 / 工具调用事件和 claude 那边（`events.ts` 的 `ClaudeEvent`）同形，直接交给同一个 `SegmentBuilder`。
 *
 * 要点：
 * - 正文取自 `item/agentMessage/delta`，思考取自 `item/reasoning/summaryTextDelta`（要 `turn/start` 传 `summary:"auto"`）。
 * - 模型调动态工具时服务端发请求 `item/tool/call`：转成 `tool_call_start` + `tool_call_end` + `tool_request`（带 JSON-RPC 请求 id，回包要用）。
 *   Codex 一次只发一个，每个都单独让 Pi 那条消息以 toolUse 结束。
 * - 用量取 `thread/tokenUsage/updated` 的 `last`（最近一次模型请求）；它常在工具回包之后才到，由渠道记到当时在写的那一段。
 * - 不转钱：订阅用户看 API 标价会被误导。
 */
import type { ClaudeEvent, TokenUsage } from "./events.ts";

/** 和 claude 同形的文字 / 思考 / 工具调用事件 */
type SharedEvent = Extract<ClaudeEvent, { type: "text_start" | "text_delta" | "text_end" | "thinking_start" | "thinking_delta" | "thinking_end" | "tool_call_start" | "tool_call_end" }>;

export type CodexEvent =
	| SharedEvent
	/** Codex 在等我们回包（`respondTo` 用的请求 id）；回包前这一轮不会往下走 */
	| { type: "tool_request"; rpcId: number | string; callId: string; name: string; args: Record<string, unknown> }
	| { type: "usage"; usage: TokenUsage }
	/** `turn/completed`：`status` 为 completed / interrupted / failed 等；失败时 `error` 是原因 */
	| { type: "turn_end"; status: string; error?: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `tokenUsage.last` → 我们的用量：OpenAI 的 inputTokens 含缓存，Pi 的 input 是不含缓存的新输入。 */
export function codexUsage(last: unknown): TokenUsage {
	const o = isObj(last) ? last : {};
	const cacheRead = num(o.cachedInputTokens);
	const cacheWrite = num(o.cacheWriteInputTokens);
	return { input: Math.max(0, num(o.inputTokens) - cacheRead - cacheWrite), output: num(o.outputTokens), cacheRead, cacheWrite };
}

const errText = (e: unknown): string => (isObj(e) ? str(e.message) : str(e));

export interface CodexEventConverter {
	/** 一条通知（无 id）→ 事件；`threadId` 不是这个转换器负责的线程时返回空 */
	notification(method: string, params: unknown): CodexEvent[];
	/** 一条服务端请求（有 id）：只有 `item/tool/call` 有事件，别的返回 null（由调用方按 `answerServerRequest` 回） */
	serverRequest(id: number | string, method: string, params: unknown): CodexEvent[] | null;
}

export function createCodexEventConverter(threadId: string): CodexEventConverter {
	/** 进行中的正文 / 思考块：itemId → 是否已开块、已写了几段摘要 */
	const text = new Map<string, { opened: boolean }>();
	const thinking = new Map<string, { opened: boolean; lastIndex: number }>();
	let lastError = "";

	function notification(method: string, params: unknown): CodexEvent[] {
		const p = isObj(params) ? params : {};
		if (str(p.threadId) !== threadId) return [];
		switch (method) {
			case "item/started": {
				const item = isObj(p.item) ? p.item : {};
				if (item.type === "agentMessage") text.set(str(item.id), { opened: false });
				else if (item.type === "reasoning") thinking.set(str(item.id), { opened: false, lastIndex: 0 });
				return [];
			}
			case "item/agentMessage/delta": {
				const id = str(p.itemId);
				const st = text.get(id) ?? { opened: false };
				text.set(id, st);
				const out: CodexEvent[] = [];
				if (!st.opened) {
					st.opened = true;
					out.push({ type: "text_start" });
				}
				out.push({ type: "text_delta", text: str(p.delta) });
				return out;
			}
			case "item/reasoning/summaryTextDelta": {
				const id = str(p.itemId);
				const st = thinking.get(id) ?? { opened: false, lastIndex: 0 };
				thinking.set(id, st);
				const idx = num(p.summaryIndex);
				const out: CodexEvent[] = [];
				if (!st.opened) {
					st.opened = true;
					out.push({ type: "thinking_start" });
				} else if (idx !== st.lastIndex) out.push({ type: "thinking_delta", text: "\n\n" }); // 多段摘要之间隔一行
				st.lastIndex = idx;
				out.push({ type: "thinking_delta", text: str(p.delta) });
				return out;
			}
			case "item/completed": {
				const item = isObj(p.item) ? p.item : {};
				const id = str(item.id);
				if (item.type === "agentMessage") {
					const st = text.get(id);
					text.delete(id);
					if (st?.opened) return [{ type: "text_end" }];
					const t = str(item.text); // 没收到增量时用完整文字补上
					return t ? [{ type: "text_start" }, { type: "text_delta", text: t }, { type: "text_end" }] : [];
				}
				if (item.type === "reasoning") {
					const st = thinking.get(id);
					thinking.delete(id);
					if (st?.opened) return [{ type: "thinking_end" }];
					const t = Array.isArray(item.summary) ? item.summary.map(str).filter(Boolean).join("\n\n") : "";
					return t ? [{ type: "thinking_start" }, { type: "thinking_delta", text: t }, { type: "thinking_end" }] : [];
				}
				return [];
			}
			case "thread/tokenUsage/updated": {
				const tu = isObj(p.tokenUsage) ? p.tokenUsage : {};
				return [{ type: "usage", usage: codexUsage(tu.last) }];
			}
			case "error":
				if (p.willRetry !== true) lastError = errText(p.error) || lastError;
				return [];
			case "turn/completed": {
				const turn = isObj(p.turn) ? p.turn : {};
				const status = str(turn.status) || "completed";
				const error = errText(turn.error) || (status === "failed" ? lastError : "");
				return [{ type: "turn_end", status, ...(error ? { error } : {}) }];
			}
			default:
				return []; // thread/status/changed、account/rateLimits/updated、item/started(userMessage) 等
		}
	}

	function serverRequest(id: number | string, method: string, params: unknown): CodexEvent[] | null {
		if (method !== "item/tool/call") return null;
		const p = isObj(params) ? params : {};
		if (str(p.threadId) !== threadId) return [];
		const callId = str(p.callId);
		const name = str(p.tool);
		const args = isObj(p.arguments) ? p.arguments : {};
		return [{ type: "tool_call_start", id: callId, name }, { type: "tool_call_end", id: callId, name, args }, { type: "tool_request", rpcId: id, callId, name, args }];
	}

	return { notification, serverRequest };
}

/** 我们不处理的服务端请求一律拒绝 / 回「不可用」（方案 §5.2 审查定稿）：返回 JSON-RPC 的 result 或 error。 */
export function answerServerRequest(method: string): { result: unknown } | { error: { code: number; message: string } } {
	switch (method) {
		case "item/commandExecution/requestApproval":
		case "item/fileChange/requestApproval":
			return { result: { decision: "decline" } };
		case "applyPatchApproval":
		case "execCommandApproval":
			return { result: { decision: "denied" } };
		case "mcpServer/elicitation/request":
			return { result: { action: "decline" } };
		case "item/tool/requestUserInput":
		case "item/permissions/requestApproval":
			return { error: { code: -32000, message: "Pi 助理不支持这个操作（不可用）" } };
		default:
			return { error: { code: -32601, message: `不支持的请求：${method}` } };
	}
}
