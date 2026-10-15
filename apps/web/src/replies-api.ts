/**
 * 引用回复的后端接口适配层（typed adapter）。
 *
 * 契约（冻结，见 docs/design/message-replies.md §4）：
 *   POST /api/agents/:id/messages       支持 replyToId / clientId
 *   POST /api/rooms/:rid/messages       支持 replyToId / clientId
 *   GET  /api/messages/:mid             单条消息
 *   GET  /api/messages/:mid/context?limit=50&roomId=|conversationId=
 *                                     有界上下文窗口（同容器前后各 ≤ limit/2），用于点击引用后定位
 * 错误码：reply_not_found / reply_cross_scope / reply_not_quotable（只带 {error, code}，不泄露内容）。
 *
 * 前端不信任客户端自填的作者 / 摘录 / 接收人；发送只传 replyToId（+ 幂等 clientId）。
 */
import { ApiError, api } from "./api";
import type { Message } from "./types";

export interface LocateResult {
	/** 目标消息；定位不到为 null */
	message: Message | null;
	/** 有界上下文（含目标）；用于插入后一起显示，避免目标孤立 */
	context: Message[];
	/** true = 网络 / 未知错误，可重试；false = 已确认不存在 / 越权 */
	retryable: boolean;
}

interface Scope {
	roomId?: string | null;
	conversationId?: string | null;
}

/** 定位一条可能不在当前列表里的消息（有界，不一次加载全历史）。 */
export async function locateMessage(messageId: string, scope: Scope = {}): Promise<LocateResult> {
	const q = new URLSearchParams({ limit: "50" });
	if (scope.roomId) q.set("roomId", scope.roomId);
	if (scope.conversationId) q.set("conversationId", scope.conversationId);
	try {
		const rows = await api<Message[]>(`/api/messages/${encodeURIComponent(messageId)}/context?${q}`);
		if (!Array.isArray(rows)) return { message: null, context: [], retryable: true };
		return { message: rows.find((m) => m.id === messageId) ?? null, context: rows, retryable: true };
	} catch (e) {
		// 404 / 403（不存在、跨容器、不可引用）→ 已确认定位不到，不重试
		if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 410)) return { message: null, context: [], retryable: false };
		return { message: null, context: [], retryable: true };
	}
}

export const locateAgentMessage = (conversationId: string | null | undefined, messageId: string) => locateMessage(messageId, { conversationId });
export const locateRoomMessage = (roomId: string, messageId: string) => locateMessage(messageId, { roomId });
