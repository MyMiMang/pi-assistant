/**
 * 从消息另开会话分支（单聊）。
 *
 * 设计契约见 docs/design/session-fork.md。只用 Pi 公开 API：
 *  - 锚点 = user 消息，由服务端持久化的 meta.piEntryId 映射到 Pi entry（不信任前端下传的文件名 / 下标）；
 *  - `pi-adapter.forkSessionAt` 用 `SessionManager.createBranchedSession(leafId)` 只读源会话文件、另写新会话文件（头带 parentSession）；
 *  - 不建 AgentSession、不调用模型、不重放工具、不复制排队任务 / 等待 / 审批单 / 用量账单。
 */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { createConversation, getConversation, setConversationSession, type ConversationRow } from "./conversations.ts";import { db, now, uid } from "./db.ts";
import { workspaceOf } from "./files.ts";
import { getMessage, roomOfConversation, type Message, type MessageRow } from "./messages.ts";
import { forkSessionAt, resolveForkPoint } from "./pi-adapter/index.ts";
import { getAgent, runtime } from "./runtime.ts";

export type ForkErrorCode = "not_found" | "fork_cross_scope" | "fork_anchor_not_supported" | "fork_anchor_unmapped" | "fork_no_session" | "fork_busy" | "fork_failed";

export class ForkError extends Error {
	constructor(
		readonly code: ForkErrorCode,
		message: string,
		readonly status: 400 | 403 | 404 | 409 | 500 = 409,
	) {
		super(message);
	}
}

export interface ForkResult {
	conversationId: string;
	agentId: string;
	draft: string | null;
	forkedFrom: { conversationId: string; messageId: string; entryId: string };
	created: boolean;
}

interface ForkRow {
	id: string;
	conversation_id: string;
	agent_id: string;
	source_conversation_id: string;
	source_message_id: string;
	source_entry_id: string;
	parent_session: string | null;
	client_id: string | null;
	created_at: number;
}

const findFork = (sourceConversationId: string, clientId: string) =>
	db.prepare("SELECT * FROM conversation_forks WHERE source_conversation_id = ? AND client_id = ? ORDER BY rowid DESC LIMIT 1").get(sourceConversationId, clientId) as ForkRow | undefined;

/** 复制一行源消息到新对话：只读、去掉旧对话的用量 / 投递状态，附件引用与引用快照原样保留（不拷 blob）。 */
function copyMessage(source: MessageRow, conversationId: string): string {
	const meta = (() => {
		try {
			return JSON.parse(source.meta) as Record<string, unknown>;
		} catch {
			return {} as Record<string, unknown>;
		}
	})();
	const { usage, delivery, error, ...keep } = meta as { usage?: unknown; delivery?: unknown; error?: unknown; [k: string]: unknown };
	void usage;
	void delivery;
	void error;
	const next = { ...keep, readonly: true, forked: { conversationId: source.conversation_id, messageId: source.id } };
	const id = uid("m");
	const t = now();
	db.prepare(
		"INSERT INTO messages(id, agent_id, conversation_id, task_id, role, content, meta, status, created_at, updated_at, room_id, subagent_id, reply_to_id, reply_snapshot, client_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		id, source.agent_id, conversationId, null, source.role, source.content, JSON.stringify(next), "done",
		source.created_at, t, null, null, source.reply_to_id ?? null, source.reply_snapshot ?? null, null,
	);
	return id;
}

function titleFor(msg: Message): string {
	const text = String(msg.content ?? "").replace(/\s+/g, " ").trim();
	return `从「${text.slice(0, 20) || "消息"}」分支`;
}

/**
 * 放回新对话输入框的正文（不自动发送）：以 app 里用户原话为准，不带我们内部的插话前缀 / 引用上下文包装；
 * 只有空正文（例如只发附件）时才退回 Pi entry 文本，并去掉插话前缀。
 */
function draftText(msgContent: string, piText: string): string | null {
	if (String(msgContent ?? "").trim()) return msgContent;
	const t = piText.replace(/^（你工作时用户发来的新消息）\n?/, "").trim();
	return t || null;
}

/**
 * 建分支。抛 `ForkError`（fail-closed，调用方按 code 给明确提示）。
 * `clientId` 用于幂等：同一源对话内重复投递只创建一个新对话。
 */
export function forkConversation(input: { conversationId: string; messageId: string; clientId?: string | null }): ForkResult {
	const source = getConversation(input.conversationId);
	if (!source) throw new ForkError("not_found", "对话不存在", 404);
	if (!getAgent(source.agent_id)) throw new ForkError("not_found", "助理不存在", 404);
	// 群内隐藏对话 / 群消息不在本轮范围：群聊分支另议，不能把群上下文无授权复制进单聊
	if (roomOfConversation(source.id)) throw new ForkError("fork_cross_scope", "群聊里的对话不能这样另开，群分支另议", 403);

	const msg = getMessage(input.messageId);
	if (!msg) throw new ForkError("not_found", "消息不存在", 404);
	if (msg.agent_id !== source.agent_id || msg.conversation_id !== source.id || msg.room_id || msg.subagent_id || msg.task_id) throw new ForkError("fork_cross_scope", "这条消息不属于该对话", 403);
	if (msg.role !== "user") throw new ForkError("fork_anchor_not_supported", "只有你发的消息可以另开分支", 409);

	// 幂等：同一 clientId 直接返回已建的分支对话（不重复建会话文件 / 不重复复制消息）
	if (input.clientId) {
		const dup = findFork(source.id, input.clientId);
		if (dup) return { conversationId: dup.conversation_id, agentId: dup.agent_id, draft: null, forkedFrom: { conversationId: source.id, messageId: input.messageId, entryId: dup.source_entry_id }, created: false };
	}

	const entryId = (msg.meta as { piEntryId?: unknown }).piEntryId;
	if (typeof entryId !== "string" || !entryId) throw new ForkError("fork_anchor_unmapped", "这条消息还没写进 Pi 会话，暂时不能从这里分支", 409);

	const sourceFile = source.session_file;
	if (!sourceFile || !existsSync(sourceFile)) throw new ForkError("fork_no_session", "这个对话还没有可用的 Pi 会话文件", 409);

	// 正在流式输出：不 abort 用户任务，明确让等这一轮结束
	if (runtime(source.agent_id, source.id).busy) throw new ForkError("fork_busy", "助理正在这一轮里工作，等它做完再从这里另开", 409);

	const point = resolveForkPoint(sourceFile, entryId);
	if (!point) throw new ForkError("fork_failed", "在源会话里找不到这条消息，无法分支", 500);
	if (point.role !== "user") throw new ForkError("fork_anchor_not_supported", "只有你发的消息可以另开分支", 409);

	const sessionDir = join(config.agentsDir, source.agent_id, "sessions");
	let branch: ReturnType<typeof forkSessionAt>;
	try {
		branch = forkSessionAt(sourceFile, point.parentId, { cwd: workspaceOf(source.agent_id), sessionDir });
	} catch (e) {
		throw new ForkError("fork_failed", e instanceof Error ? e.message : "创建分支会话失败", 500);
	}

	const conv: ConversationRow = createConversation(source.agent_id, titleFor(msg), { makeCurrent: false });
	// 建对话 / 写分支记录 / 投影消息任一步失败：只清理本次自己新建的会话文件与对话行，绝不碰源会话；
	// clientId 幂等冲突时回退到已存在的那条（并发 / 重试都只留一个对话，不无界堆磁盘文件）
	try {
		// 分支为前缀（有历史）→ 直接用新会话文件；分支点在首条消息之前 → 只记父关系，首条消息落盘时才写文件
		if (branch.sessionFile) setConversationSession(conv.id, branch.sessionFile);
		db.prepare(
			"INSERT INTO conversation_forks(id, conversation_id, agent_id, source_conversation_id, source_message_id, source_entry_id, parent_session, client_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
		).run(uid("fk"), conv.id, conv.agent_id, source.id, msg.id, entryId, branch.sessionFile ? null : branch.parentSession, input.clientId ?? null, now());

		// 把分支前缀投影成新对话的消息行：按 Pi entry id 反查源 app 消息，命中才复制（缺映射不猜、不错位）
		for (const id of branch.entryIds) {
			const row = db
				.prepare("SELECT * FROM messages WHERE conversation_id = ? AND json_extract(meta, '$.piEntryId') = ? ORDER BY rowid LIMIT 1")
				.get(source.id, id) as MessageRow | undefined;
			if (row) copyMessage(row, conv.id);
		}
		db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), conv.id);
	} catch (e) {
		if (branch.sessionFile) {
			try {
				unlinkSync(branch.sessionFile);
			} catch {
				/* 已被清掉：忽略 */
			}
		}
		db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conv.id);
		db.prepare("DELETE FROM conversations WHERE id = ?").run(conv.id);
		if (input.clientId) {
			const dup = findFork(source.id, input.clientId);
			if (dup) return { conversationId: dup.conversation_id, agentId: dup.agent_id, draft: null, forkedFrom: { conversationId: source.id, messageId: input.messageId, entryId: dup.source_entry_id }, created: false };
		}
		throw new ForkError("fork_failed", e instanceof Error ? e.message : "创建分支失败", 500);
	}

	return { conversationId: conv.id, agentId: conv.agent_id, draft: draftText(msg.content, point.text), forkedFrom: { conversationId: source.id, messageId: msg.id, entryId }, created: true };
}
