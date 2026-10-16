import { bus } from "./bus.ts";
import { currentConversation, touchConversation } from "./conversations.ts";
import { db, now, uid } from "./db.ts";

/**
 * 引用快照（服务端生成，客户端只读）。见 docs/design/message-replies.md §3。
 * 只包含引用时刻的有界子集，不是原消息的完整复制；原消息删除时会被 scrub。
 */
export interface ReplySnapshot {
	messageId: string;
	/** 作者：user 的 id 为空串；assistant 的 id 为 agentId */
	author: { id: string; name: string; role: "user" | "assistant"; avatar?: string };
	/** 来源容器：群或单聊对话 */
	source: { kind: "room" | "conversation"; id: string };
	/** 原文摘录，≤2000 字符；不含 tool / system / 密钥 / 二进制 */
	excerpt: string;
	truncated: boolean;
	/** 快照生成后，原消息被编辑过 */
	edited: boolean;
	attachments?: { fileId: string; name: string; mime: string; size: number }[];
	createdAt: number;
	/** 原消息已被删除：excerpt / attachments 清空，仅保留“不可用”标记 */
	unavailable?: boolean;
}

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
	reply_to_id?: string | null;
	reply_snapshot?: string | null;
	client_id?: string | null;
}
export type Message = Omit<MessageRow, "meta" | "reply_to_id" | "reply_snapshot" | "client_id"> & {
	meta: Record<string, unknown>;
	/** 被引用消息 id（无引用为 null） */
	replyToId?: string | null;
	/** 引用快照（无引用为 null） */
	reply?: ReplySnapshot | null;
};

const safeParse = <T>(s: string | null | undefined, fallback: T): T => {
	if (!s) return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

export const toMessage = (r: MessageRow): Message => {
	const { reply_snapshot, client_id, reply_to_id, ...rest } = r;
	void client_id;
	return { ...rest, meta: safeParse(r.meta, {}), replyToId: reply_to_id ?? null, reply: safeParse<ReplySnapshot | null>(reply_snapshot, null) };
};

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
	/** 引用：被引用消息 id + 服务端生成的快照 */
	replyToId?: string | null;
	replySnapshot?: ReplySnapshot | null;
	/** 幂等键：同一容器内重复投递只落一条 */
	clientId?: string | null;
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
		reply_to_id: m.replyToId ?? null,
		reply_snapshot: m.replySnapshot ? JSON.stringify(m.replySnapshot) : null,
		client_id: m.clientId ?? null,
	};
	// 后台任务里产生的卡片也显示在群里（任务的 conversation_id 就是成员的群内对话）
	row.room_id = m.roomId !== undefined ? m.roomId : roomOfConversation(row.conversation_id);
	if (row.subagent_id) row.room_id = null;
	if (row.room_id && row.task_id && row.role !== "card") row.room_id = null;
	db.prepare(
		"INSERT INTO messages(id, agent_id, conversation_id, task_id, role, content, meta, status, created_at, updated_at, room_id, subagent_id, reply_to_id, reply_snapshot, client_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		row.id, row.agent_id, row.conversation_id, row.task_id, row.role, row.content, row.meta, row.status,
		row.created_at, row.updated_at, row.room_id ?? null, row.subagent_id ?? null,
		row.reply_to_id ?? null, row.reply_snapshot ?? null, row.client_id ?? null,
	);
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

/** 幂等：同一容器（群 / 对话）+ clientId 已存在则返回那一条 */
export function getMessageByClientId(o: { roomId?: string | null; conversationId?: string | null; clientId: string }): Message | undefined {
	const r = o.roomId
		? (db.prepare("SELECT * FROM messages WHERE room_id = ? AND client_id = ? ORDER BY rowid DESC LIMIT 1").get(o.roomId, o.clientId) as MessageRow | undefined)
		: o.conversationId
			? (db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND client_id = ? ORDER BY rowid DESC LIMIT 1").get(o.conversationId, o.clientId) as MessageRow | undefined)
			: undefined;
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
	// 正文被改过：引用它的快照保留原版本，但标记 edited（用户可见）
	if (patch.content !== undefined && patch.content !== cur.content) markRepliesEdited(id);
	const next = getMessage(id)!;
	if (emit) bus.emit({ type: "message.updated", message: next });
	return next;
}

/** 把引用了某条消息的快照统一标记为“已编辑”（保留原摘录）。 */
export function markRepliesEdited(messageId: string) {
	const rows = db.prepare("SELECT id, reply_snapshot FROM messages WHERE reply_to_id = ?").all(messageId) as { id: string; reply_snapshot: string }[];
	for (const r of rows) {
		const snap = safeParse<ReplySnapshot | null>(r.reply_snapshot, null);
		if (!snap || snap.edited) continue;
		db.prepare("UPDATE messages SET reply_snapshot = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...snap, edited: true }), now(), r.id);
	}
}

/** 真删除一条消息：引用它的快照被 scrub，不保留已删除正文。 */
function scrubRepliesOf(messageId: string) {
	const rows = db.prepare("SELECT id, reply_snapshot FROM messages WHERE reply_to_id = ?").all(messageId) as { id: string; reply_snapshot: string }[];
	for (const r of rows) {
		const snap = safeParse<ReplySnapshot | null>(r.reply_snapshot, null);
		if (!snap) continue;
		const scrubbed: ReplySnapshot = { messageId: snap.messageId, author: snap.author, source: snap.source, excerpt: "", truncated: false, edited: snap.edited, createdAt: snap.createdAt, unavailable: true };
		db.prepare("UPDATE messages SET reply_snapshot = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(scrubbed), now(), r.id);
	}
}

export function deleteMessage(id: string) {
	const cur = getMessage(id);
	if (!cur) return;
	scrubRepliesOf(id);
	db.prepare("DELETE FROM messages WHERE id = ?").run(id);
	bus.emit({ type: "message.deleted", id, agentId: cur.agent_id, taskId: cur.task_id });
}

/**
 * 群消息（按插入顺序，稳定游标 before = rowid）。
 * rowid 单调递增，不受 created_at 相同影响：同一毫秒的多条消息不会在分页边界被跳过 / 重复。
 *
 * 前向分页（历史窗口「加载较新消息」）：`after=seq`，`rowid > after` 升序取回，不含游标本身。
 */
export function listRoomMessages(roomId: string, opts: { before?: number; after?: number; limit?: number } = {}) {
	const limit = Math.min(opts.limit ?? 200, 500);
	if (opts.after !== undefined) {
		const rows = db.prepare("SELECT rowid AS seq, * FROM messages WHERE room_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?").all(roomId, opts.after, limit) as unknown as (MessageRow & { seq: number })[];
		return rows.map((r) => ({ ...toMessage(r), seq: r.seq }));
	}
	const rows = db.prepare("SELECT rowid AS seq, * FROM messages WHERE room_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?").all(roomId, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as (MessageRow & { seq: number })[];
	return rows.reverse().map((r) => ({ ...toMessage(r), seq: r.seq }));
}

/**
 * 单聊 / 后台任务消息。倒序取回后反转为正序展示。
 *
 * 游标语义：
 *  - 传 `beforeSeq`（推荐，新客户端）：按 `(created_at, rowid)` 复合游标，稳定，不跳不重；
 *  - 只传 `before`（旧客户端 / 旧接口契约）：沿用 `created_at < before`，行为不变；
 *  - 传 `after` / `afterSeq`：**前向分页**（历史窗口「加载较新消息」），同一复合游标升序取更新的，不含游标本身；
 *  - 都不传：从最新一页开始。
 * 每条返回带 `seq`（rowid），供客户端下一页复用。
 */
export function listMessages(agentId: string, opts: { taskId?: string | null; conversationId?: string; before?: number; beforeSeq?: number; after?: number; afterSeq?: number; limit?: number }) {
	const conv = opts.conversationId ?? currentConversation(agentId);
	const limit = Math.min(opts.limit ?? 200, 500);
	if (opts.taskId) {
		const rows = db.prepare("SELECT rowid AS seq, * FROM messages WHERE task_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(opts.taskId, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as (MessageRow & { seq: number })[];
		return rows.reverse().map((r) => ({ ...toMessage(r), seq: r.seq }));
	}
	if (opts.after !== undefined || opts.afterSeq !== undefined) {
		const fwdComposite = opts.afterSeq !== undefined;
		const fwdFilter = fwdComposite ? "(created_at > ? OR (created_at = ? AND rowid > ?))" : "created_at > ?";
		const fwdParams: number[] = fwdComposite ? [opts.after ?? 0, opts.after ?? 0, opts.afterSeq!] : [opts.after ?? 0];
		const fwdRows = db
			.prepare(`SELECT rowid AS seq, * FROM messages WHERE agent_id = ? AND conversation_id = ? AND task_id IS NULL AND subagent_id IS NULL AND ${fwdFilter} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
			.all(agentId, conv, ...fwdParams, limit) as unknown as (MessageRow & { seq: number })[];
		return fwdRows.map((r) => ({ ...toMessage(r), seq: r.seq }));
	}
	const composite = opts.beforeSeq !== undefined;
	const filter = composite ? "(created_at < ? OR (created_at = ? AND rowid < ?))" : "created_at < ?";
	const params: number[] = composite ? [opts.before ?? Number.MAX_SAFE_INTEGER, opts.before ?? Number.MAX_SAFE_INTEGER, opts.beforeSeq!] : [opts.before ?? Number.MAX_SAFE_INTEGER];
	const rows = db
		.prepare(`SELECT rowid AS seq, * FROM messages WHERE agent_id = ? AND conversation_id = ? AND task_id IS NULL AND subagent_id IS NULL AND ${filter} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
		.all(agentId, conv, ...params, limit) as unknown as (MessageRow & { seq: number })[];
	return rows.reverse().map((r) => ({ ...toMessage(r), seq: r.seq }));
}
