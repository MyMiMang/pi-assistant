import { bus } from "./bus.ts";
import { currentConversation, touchConversation } from "./conversations.ts";
import { db, now, uid } from "./db.ts";

export interface MessageRow {
	id: string;
	agent_id: string;
	conversation_id: string | null;
	task_id: string | null;
	subagent_id?: string | null;
	role: "user" | "assistant" | "tool" | "system" | "card";
	content: string;
	room_id?: string | null;
	meta: string;
	status: string;
	created_at: number;
	updated_at: number;
}
export type Message = Omit<MessageRow, "meta"> & { meta: Record<string, unknown> };

export const toMessage = (r: MessageRow): Message => ({ ...r, meta: JSON.parse(r.meta) });

/** 对话 → 群（成员的群内隐藏对话）。缓存：对话归属不会变 */
const roomOfConv = new Map<string, string | null>();
export function roomOfConversation(conv: string | null | undefined): string | null {
	if (!conv) return null;
	if (roomOfConv.has(conv)) return roomOfConv.get(conv)!;
	const r = (db.prepare("SELECT room_id FROM room_members WHERE conversation_id = ?").get(conv) as { room_id: string } | undefined)?.room_id ?? null;
	if (r) roomOfConv.set(conv, r);
	return r;
}

export function insertMessage(m: {
	agentId: string;
	/** 默认进入助理的当前对话 */
	conversationId?: string | null;
	taskId?: string | null;
	subagentId?: string | null;
	role: MessageRow["role"];
	content?: string;
	meta?: Record<string, unknown>;
	status?: string;
	/** 直接写进群（用户消息 / 群系统消息）；不传 = 按对话自动判断 */
	roomId?: string | null;
}): Message {
	const t = now();
	const row: MessageRow = {
		id: uid("m"),
		agent_id: m.agentId,
		conversation_id: m.conversationId !== undefined || m.roomId ? (m.conversationId ?? null) : currentConversation(m.agentId),
		task_id: m.taskId ?? null,
		subagent_id: m.subagentId ?? null,
		role: m.role,
		content: m.content ?? "",
		meta: JSON.stringify(m.meta ?? {}),
		status: m.status ?? "done",
		created_at: t,
		updated_at: t,
	};
	// 后台任务里产生的卡片也显示在群里（任务的 conversation_id 就是成员的群内对话）
	row.room_id = m.roomId !== undefined ? m.roomId : roomOfConversation(row.conversation_id);
	if (row.subagent_id) row.room_id = null;
	if (row.room_id && row.task_id && row.role !== "card") row.room_id = null;
	db.prepare(
		"INSERT INTO messages(id, agent_id, conversation_id, task_id, role, content, meta, status, created_at, updated_at, room_id, subagent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(row.id, row.agent_id, row.conversation_id, row.task_id, row.role, row.content, row.meta, row.status, row.created_at, row.updated_at, row.room_id ?? null, row.subagent_id ?? null);
	if (!row.task_id && !row.subagent_id && row.conversation_id && row.role !== "tool") touchConversation(row.conversation_id, row.role === "user" ? row.content : undefined);
	const msg = toMessage(row);
	bus.emit({ type: "message.created", message: msg });
	if (row.room_id) {
		if (row.role === "assistant" || row.role === "card") db.prepare("UPDATE rooms SET unread = unread + 1, updated_at = ? WHERE id = ?").run(t, row.room_id);
		else db.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").run(t, row.room_id);
	} else if (!row.task_id && !row.subagent_id && (row.role === "assistant" || row.role === "card")) db.prepare("UPDATE agents SET unread = unread + 1 WHERE id = ?").run(row.agent_id);
	return msg;
}

export function getMessage(id: string): Message | undefined {
	const r = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
	return r ? toMessage(r) : undefined;
}

export function updateMessage(id: string, patch: { content?: string; meta?: Record<string, unknown>; status?: string }, emit = true) {
	const cur = getMessage(id);
	if (!cur) return;
	const meta = patch.meta ? { ...cur.meta, ...patch.meta } : cur.meta;
	db.prepare("UPDATE messages SET content = ?, meta = ?, status = ?, updated_at = ? WHERE id = ?").run(
		patch.content ?? cur.content,
		JSON.stringify(meta),
		patch.status ?? cur.status,
		now(),
		id,
	);
	const next = getMessage(id)!;
	if (emit) bus.emit({ type: "message.updated", message: next });
	return next;
}

export function deleteMessage(id: string) {
	const cur = getMessage(id);
	if (!cur) return;
	db.prepare("DELETE FROM messages WHERE id = ?").run(id);
	bus.emit({ type: "message.deleted", id, agentId: cur.agent_id, taskId: cur.task_id });
}

/** 群消息（按插入顺序，before = rowid 分页） */
export function listRoomMessages(roomId: string, opts: { before?: number; limit?: number } = {}) {
	const limit = Math.min(opts.limit ?? 200, 500);
	const rows = db.prepare("SELECT rowid AS seq, * FROM messages WHERE room_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?").all(roomId, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as (MessageRow & { seq: number })[];
	return rows.reverse().map((r) => ({ ...toMessage(r), seq: r.seq }));
}

export function listMessages(agentId: string, opts: { taskId?: string | null; conversationId?: string; before?: number; limit?: number }) {
	const conv = opts.conversationId ?? currentConversation(agentId);
	const limit = Math.min(opts.limit ?? 200, 500);
	const rows = (opts.taskId
		? db.prepare("SELECT * FROM messages WHERE task_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(opts.taskId, opts.before ?? Number.MAX_SAFE_INTEGER, limit)
		: db
				.prepare("SELECT * FROM messages WHERE agent_id = ? AND conversation_id = ? AND task_id IS NULL AND subagent_id IS NULL AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
				.all(agentId, conv, opts.before ?? Number.MAX_SAFE_INTEGER, limit)) as unknown as MessageRow[];
	return rows.reverse().map(toMessage);
}
