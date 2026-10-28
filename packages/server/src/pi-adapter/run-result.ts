import { INTERJECTION_PREFIX, messageText, modelErrorMessage, type AgentSession } from "./index.ts";

/** 一条 assistant 消息的内容里有没有用户看得见的东西（正文 / 思考 / 工具调用）。 */
function hasVisibleContent(content: unknown): boolean {
	return Array.isArray(content) && content.some((b: { type?: string; text?: string; thinking?: string }) => b.type === "toolCall" || (b.type === "text" && !!b.text?.trim()) || (b.type === "thinking" && !!b.thinking?.trim()));
}

/**
 * prompt()正常resolve不代表服务成功；从公开messages检查最终模型结果，不能把失败标成后台任务完成。
 * 「收尾空回复」（同一轮前面已有正文 / 思考 / 工具调用，最后一次模型请求正常 stop 却什么都没输出）是正常结束，不算失败；
 * 「同一轮」= 最近一条真正的用户消息（插话不算）之后的所有消息。
 */
export function lastAssistantError(session: AgentSession): string | undefined {
	const all = session.messages;
	let from = 0;
	for (let i = all.length - 1; i >= 0; i--) {
		const m = all[i];
		if (m.role === "user" && !messageText(m).startsWith(INTERJECTION_PREFIX)) { from = i + 1; break; }
	}
	const run = all.slice(from);
	const assistants = run.filter((m) => m.role === "assistant");
	const message = assistants.at(-1);
	if (!message || message.role !== "assistant") return "这次未收到回复，服务未提供具体原因";
	if (message.stopReason === "aborted") return undefined;
	if (message.stopReason === "error" || message.errorMessage) return modelErrorMessage(message.errorMessage);
	if (!hasVisibleContent(message.content) && !assistants.some((m) => m.role === "assistant" && m.stopReason !== "error" && hasVisibleContent(m.content))) return "这次未收到回复，服务未提供具体原因";
	return undefined;
}
