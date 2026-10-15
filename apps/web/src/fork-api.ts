/**
 * 「从消息另开会话分支」的前端适配层（单聊）。
 *
 * 契约（冻结，见 docs/design/session-fork.md §3）：
 *   POST /api/conversations/:cid/fork { messageId, clientId }
 *   → { conversationId, agentId, draft, forkedFrom, created }
 * 错误码：fork_cross_scope / fork_anchor_not_supported / fork_anchor_unmapped /
 *         fork_no_session / fork_busy / fork_failed。前端只传可信 messageId + 幂等 clientId，
 * 不传 session 文件名 / 下标（映射由服务端用持久化的 piEntryId 解析）。
 *
 * 只有**用户消息**能作为锚点：Pi 官方 /fork 只支持 user 消息（getUserMessagesForForking），
 * 非 user 的入口由 UI 隐藏、后端 fail-closed，不会偷偷从别的消息分支。
 */
import { ApiError, api } from "./api";
import type { Message } from "./types";

export interface ForkResult {
	conversationId: string;
	agentId: string;
	draft: string | null;
	forkedFrom: { conversationId: string; messageId: string; entryId: string };
	created: boolean;
}

/** 这条消息能不能「另开新对话」：单聊里的普通用户消息（工具 / 卡片 / 系统 / 群 / 子代理都不行）。 */
export function canFork(m: Pick<Message, "role"> & { meta?: Record<string, unknown>; subagent_id?: string | null; room_id?: string | null }): boolean {
	if (m.role !== "user") return false;
	if (m.subagent_id || m.room_id) return false;
	const meta = m.meta ?? {};
	if (meta.hidden || meta.visible === false || meta.kind === "hidden" || meta.kind === "system") return false;
	return true;
}

export function newForkClientId(): string {
	return `fk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function forkFromMessage(conversationId: string, messageId: string, clientId: string): Promise<ForkResult> {
	return api<ForkResult>(`/api/conversations/${encodeURIComponent(conversationId)}/fork`, { method: "POST", json: { messageId, clientId } });
}

const MESSAGES: Record<string, string> = {
	fork_cross_scope: "这条消息不属于当前对话，不能从这里分支",
	fork_anchor_not_supported: "只有你发的消息可以另开分支",
	fork_anchor_unmapped: "这条消息还没写进 Pi 会话，暂时不能从这里分支",
	fork_no_session: "这个对话还没有可用的会话文件",
	fork_busy: "助理正在这一轮里工作，等它做完再从这条消息另开",
	fork_failed: "创建分支失败",
};

export function forkErrorMessage(e: unknown): string {
	if (e instanceof ApiError) {
		const code = (e.data as { code?: string } | undefined)?.code;
		return (code && MESSAGES[code]) || e.message || "另开分支失败";
	}
	return e instanceof Error ? e.message : "另开分支失败";
}
