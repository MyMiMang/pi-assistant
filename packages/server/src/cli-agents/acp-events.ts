/**
 * ACP（Agent Client Protocol）的通知 / 回包 → 我们自己的简单事件（纯逻辑，无状态）。方案：docs/design/acp-cli-models.md。
 *
 * 实测（OpenCode 1.18.35）看到的 `session/update` 种类：
 * - `agent_message_chunk` / `agent_thought_chunk`：增量文字 / 思考（`content.text`）；思考只在部分请求里有，界面要能接受没有思考。
 * - `tool_call`：模型开始调一个工具（`title` = `<MCP 服务名>_<工具名>`，如 `pia_echo`；`toolCallId` 是模型侧的 id）。
 *   **只用来数「模型报告了几个我们的工具」，不用来配对**：它和工具桥收到的 MCP `tools/call` 没有可对上的 id，并行时两边顺序也不一致（实测）。
 * - `tool_call_update`：工具进展，不用。`usage_update`：只在一轮结束时来一次，`used` = 最后一次模型调用的上下文大小（不是整轮合计），`cost` 不转。
 * - `available_commands_update` 等：忽略。
 * `session/prompt` 的回包带 `stopReason` 和 `usage`，**usage 只是最后一次模型调用的**，不是整轮合计（ACP 没有按次的用量通知，没法自己累加）。
 */
import type { ClaudeEvent, TokenUsage } from "./events.ts";

export type AcpEvent =
	| Extract<ClaudeEvent, { type: "text_delta" | "thinking_delta" }>
	/** 模型报告它开始调我们的一个工具（只用来数数，`id` 是模型侧的 id） */
	| { type: "our_tool_call"; id: string }
	/** 上下文占用（`usage_update`） */
	| { type: "context"; used: number; size: number };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** `session/update` 通知的 params → 0 到多个事件。`toolPrefix` 是我们工具在 ACP 里的标题前缀（`pia_`）。 */
export function convertAcpUpdate(params: unknown, toolPrefix: string): AcpEvent[] {
	const update = isObj(params) && isObj(params.update) ? params.update : undefined;
	if (!update) return [];
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
		case "agent_thought_chunk": {
			const c = isObj(update.content) ? update.content : {};
			const text = c.type === "text" ? str(c.text) : "";
			return text ? [{ type: update.sessionUpdate === "agent_message_chunk" ? "text_delta" : "thinking_delta", text }] : [];
		}
		case "tool_call":
			return str(update.title).startsWith(toolPrefix) ? [{ type: "our_tool_call", id: str(update.toolCallId) }] : [];
		case "usage_update":
			return [{ type: "context", used: num(update.used), size: num(update.size) }];
		default:
			return [];
	}
}

/** `session/prompt` 回包里的用量 → 统一用量（ACP 的 inputTokens 不含缓存读取，实测；思考 token 算进输出，总数才对得上） */
export function acpUsageOf(u: unknown): TokenUsage {
	const o = isObj(u) ? u : {};
	return { input: num(o.inputTokens), output: num(o.outputTokens) + num(o.thoughtTokens), cacheRead: num(o.cachedReadTokens), cacheWrite: num(o.cachedWriteTokens) };
}

/** 想要的思考强度 → 这个模型 `effort` 选项里真有的值。没指定用 `default`；想要的没有就按「相近的」退（xhigh ↔ max → high）。 */
export function pickEffort(available: readonly string[], want: string | undefined): string | undefined {
	if (!want) return available.includes("default") ? "default" : undefined;
	const order: Record<string, string[]> = {
		minimal: ["minimal", "low"],
		low: ["low", "minimal", "medium"],
		medium: ["medium", "high", "low"],
		high: ["high", "max", "xhigh", "medium"],
		xhigh: ["xhigh", "max", "high"],
		max: ["max", "xhigh", "high"],
	};
	return (order[want] ?? [want]).find((e) => available.includes(e));
}

/** `session/new` / `session/set_config_option` 回包里某个选项当前可选的值 */
export function configValues(configOptions: unknown, id: string): { current: string; values: string[] } | undefined {
	if (!Array.isArray(configOptions)) return undefined;
	const o = configOptions.find((c) => isObj(c) && c.id === id);
	if (!isObj(o)) return undefined;
	const values = Array.isArray(o.options) ? o.options.flatMap((x) => (isObj(x) && typeof x.value === "string" ? [x.value] : [])) : [];
	return { current: str(o.currentValue), values };
}

/** `session/request_permission` 的选项里挑「允许一次」（没有就挑任一个允许类；都没有返回 undefined = 取消） */
export function pickAllowOption(options: unknown): string | undefined {
	if (!Array.isArray(options)) return undefined;
	const opts = options.filter(isObj);
	const o = opts.find((x) => x.kind === "allow_once") ?? opts.find((x) => typeof x.kind === "string" && x.kind.startsWith("allow"));
	return o && typeof o.optionId === "string" ? o.optionId : undefined;
}
