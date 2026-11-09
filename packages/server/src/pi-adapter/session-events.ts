/** Pi 会话事件归一化与原生工具展示事件的共用订阅。 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { subscribeNativeTools, type NativeToolEvent } from "./cli-models/session-context.ts";
// 仅在事件回调里调用这两个函数；index 转出本模块时不会读取尚未初始化的绑定。
import { messageText, modelErrorMessage } from "./index.ts";
import { isAbortedMessage } from "./run-result.ts";
export type { NativeToolEvent } from "./cli-models/session-context.ts";

export type AgentEvent =
	| NativeToolEvent
	| { type: "assistant_start" }
	| { type: "text_delta"; delta: string }
	/** 模型原生的思考 / 推理内容（reasoning） */
	| { type: "thinking_delta"; delta: string }
	| {
			type: "assistant_end";
			text: string;
			error?: string;
			aborted?: boolean;
			hasToolCalls?: boolean;
			provider?: string;
			model?: string;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number };
	  }
	| { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
	| { type: "tool_end"; id: string; name: string; isError: boolean; resultText: string }
	| { type: "tool_update"; id: string; name: string } /** 工具还在跑又有新输出（长命令持续打印）：只当「有动静」，内容不转发 */
	| { type: "settled"; aborted: boolean }
	/** 一条用户消息真正进入了模型上下文（插话在下一个工具边界送达时触发） */
	| { type: "user_start"; text: string }
	/**
	 * 一条消息写进 Pi 会话文件后，它对应的 entry id（app 消息 ↔ Pi entry 的可信映射，用于「从消息另开会话分支」）。
	 * 监听器先于 Pi 的持久化触发，所以这里在持久化之后的微任务里，用公开 `SessionManager.getEntries()`
	 * 按**消息对象身份**（`entry.message === message`）反查 entry id；role 可能是 user / assistant / toolResult。
	 */
	| { type: "entry_id"; entryId: string; role: string; toolCallId?: string }
	| { type: "compaction_start"; reason: string }
	/** Pi 因网络 / 服务临时错误准备自动重试（上一条 assistant 错误消息就是被重试的那条） */
	| { type: "retry_start"; attempt: number; max: number }
	| { type: "retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "compaction_end"; reason: string; ok: boolean; aborted: boolean; error?: string; tokensBefore?: number; summary?: string };

/**
 * 把刚持久化的消息解析成 Pi entry id：用公开 `SessionManager.getEntries()` 按**消息对象身份**匹配
 * （`entry.message === message`）。Pi 的 `appendMessage(event.message)` 存的就是同一个对象，所以即使
 * 多条 message_end 落在同一个 tick（并行工具结果 / 连发同文本 user / steer），也各归各的 entry——
 * 不读 leaf、不按文本或下标猜（读 leaf 会把同 tick 的几条都指到最后一个 entry）。
 * 会话已释放 / 找不到（例如 leaf 被切走）返回 null，调用方跳过映射，绝不落一个错的 id。
 */
function entryIdOfMessage(session: AgentSession, message: unknown): string | null {
	try {
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}
	} catch {
		/* 会话已释放 */
	}
	return null;
}

export function subscribeSession(session: AgentSession, fn: (e: AgentEvent) => void): () => void {
	const unsubscribePi = session.subscribe((e: AgentSessionEvent) => {
		const ev = e as { type: string; [k: string]: any };
		if ((ev as { parentToolCallId?: string }).parentToolCallId) return; // 嵌套调用不单独显示
		switch (ev.type) {
			case "message_start":
				if (ev.message?.role === "assistant") fn({ type: "assistant_start" });
				else if (ev.message?.role === "user") fn({ type: "user_start", text: messageText(ev.message) });
				break;
			case "message_update":
				if (ev.assistantMessageEvent?.type === "text_delta") fn({ type: "text_delta", delta: ev.assistantMessageEvent.delta });
				else if (ev.assistantMessageEvent?.type === "thinking_delta") fn({ type: "thinking_delta", delta: ev.assistantMessageEvent.delta });
				break;
			case "message_end": {
				const persisted = ev.message as { role?: string; toolCallId?: string } | undefined;
				if (persisted?.role === "user" || persisted?.role === "assistant" || persisted?.role === "toolResult") {
					const role = persisted.role;
					const message = persisted;
					// Pi 在把这条消息 appendMessage 到 SessionManager 之前就通知了监听器；append 紧随其后且中间没有 await，
					// 所以在微任务里按消息对象身份反查 entry id，同 tick 的多条也不会互相顶替。
					queueMicrotask(() => {
						const entryId = entryIdOfMessage(session, message);
						if (entryId) fn({ type: "entry_id", entryId, role, toolCallId: persisted.toolCallId });
					});
				}
				if (ev.message?.role === "assistant") {
					const m = ev.message;
					const aborted = isAbortedMessage(m);
					fn({
						type: "assistant_end",
						text: messageText(m),
						error: aborted ? undefined : m.stopReason === "error" || m.errorMessage ? modelErrorMessage(m.errorMessage) : undefined,
						aborted,
						hasToolCalls: Array.isArray(m.content) && m.content.some((b: { type?: string }) => b.type === "toolCall"),
						provider: m.provider,
						model: m.model,
						usage: m.usage ? { input: m.usage.input ?? 0, output: m.usage.output ?? 0, cacheRead: m.usage.cacheRead ?? 0, cacheWrite: m.usage.cacheWrite ?? 0, reasoning: m.usage.reasoning ?? 0, cost: m.usage.cost?.total ?? 0 } : undefined,
					});
				}
				break;
			}
			case "tool_execution_start":
				fn({ type: "tool_start", id: ev.toolCallId, name: ev.toolName, args: ev.args ?? {} });
				break;
			case "tool_execution_update": fn({ type: "tool_update", id: ev.toolCallId, name: ev.toolName }); break;
			case "tool_execution_end": {
				const r = ev.result as { content?: { type: string; text?: string }[] } | undefined;
				const resultText = Array.isArray(r?.content) ? r!.content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n") : String(r ?? "");
				fn({ type: "tool_end", id: ev.toolCallId, name: ev.toolName, isError: !!ev.isError, resultText });
				break;
			}
			case "agent_settled": fn({ type: "settled", aborted: !!ev.aborted }); break;
			case "auto_retry_start": fn({ type: "retry_start", attempt: ev.attempt, max: ev.maxAttempts }); break;
			case "auto_retry_end": fn({ type: "retry_end", success: !!ev.success, attempt: ev.attempt, finalError: ev.finalError }); break;
			case "compaction_start": fn({ type: "compaction_start", reason: ev.reason }); break;
			case "compaction_end":
				fn({ type: "compaction_end", reason: ev.reason, ok: !!ev.result && !ev.aborted, aborted: !!ev.aborted, error: ev.errorMessage, tokensBefore: ev.result?.tokensBefore, summary: ev.result?.summary });
				break;
		}
	});
	const unsubscribeNative = subscribeNativeTools(session.sessionId, fn);
	return () => {
		try { unsubscribePi(); } finally { unsubscribeNative(); }
	};
}
