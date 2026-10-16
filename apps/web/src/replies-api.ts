/**
 * 引用回复的后端接口适配层（typed adapter）。
 *
 * 契约（冻结，见 docs/design/message-replies.md §4）：
 *   POST /api/agents/:id/messages       支持 replyToId / clientId
 *   POST /api/rooms/:rid/messages       支持 replyToId / clientId
 *   GET  /api/messages/:mid             单条消息
 *   GET  /api/messages/:mid/context?limit=50&roomId=|conversationId=
 *                                     有界上下文窗口（同容器前后各 ≤ limit/2）；`&bounds=1` 额外回 hasOlder/hasNewer，
 *                                     用于把当前列表切换成围绕目标的连续历史窗口（可前后按需分页、可回到最新）
 * 错误码：reply_not_found / reply_cross_scope / reply_not_quotable（只带 {error, code}，不泄露内容）。
 *
 * 前端不信任客户端自填的作者 / 摘录 / 接收人；发送只传 replyToId（+ 幂等 clientId）。
 */
import { ApiError, api } from "./api";
import type { Message } from "./types";

export interface LocateResult {
	/** 目标消息；定位不到为 null */
	message: Message | null;
	/** 有界上下文（含目标）；用于替换当前列表为一个连续窗口，避免目标孤立 */
	context: Message[];
	/** 窗口之外是否还有更早的消息（服务端 bounds）；null = 旧服务端未告知，按未知处理 */
	hasOlder: boolean | null;
	/** 窗口之外是否还有更新的消息；null = 旧服务端未告知 */
	hasNewer: boolean | null;
	/** true = 网络 / 未知错误，可重试；false = 已确认不存在 / 越权 */
	retryable: boolean;
}

interface Scope {
	roomId?: string | null;
	conversationId?: string | null;
}

interface ContextBounds {
	messages: Message[];
	hasOlder?: boolean;
	hasNewer?: boolean;
}

/** 定位一条可能不在当前列表里的消息（有界，不一次加载全历史）。 */
export async function locateMessage(messageId: string, scope: Scope = {}): Promise<LocateResult> {
	// bounds=1：除了窗口本身，还要知道窗口外是否还有更早 / 更新的消息（历史窗口导航用）。
	const q = new URLSearchParams({ limit: "50", bounds: "1" });
	if (scope.roomId) q.set("roomId", scope.roomId);
	if (scope.conversationId) q.set("conversationId", scope.conversationId);
	try {
		const body = await api<Message[] | ContextBounds>(`/api/messages/${encodeURIComponent(messageId)}/context?${q}`);
		// 旧服务端只回数组：仍能定位，但没有 bounds（返回 null）。
		const rows = Array.isArray(body) ? body : Array.isArray(body?.messages) ? body.messages : null;
		if (!rows) return { message: null, context: [], hasOlder: null, hasNewer: null, retryable: true };
		return {
			message: rows.find((m) => m.id === messageId) ?? null,
			context: rows,
			hasOlder: Array.isArray(body) ? null : (body.hasOlder ?? null),
			hasNewer: Array.isArray(body) ? null : (body.hasNewer ?? null),
			retryable: true,
		};
	} catch (e) {
		// 404 / 403（不存在、跨容器、不可引用）→ 已确认定位不到，不重试
		if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 410)) return { message: null, context: [], hasOlder: null, hasNewer: null, retryable: false };
		return { message: null, context: [], hasOlder: null, hasNewer: null, retryable: true };
	}
}

export const locateAgentMessage = (conversationId: string | null | undefined, messageId: string) => locateMessage(messageId, { conversationId });
export const locateRoomMessage = (roomId: string, messageId: string) => locateMessage(messageId, { roomId });
