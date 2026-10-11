import { bus } from "./bus.ts";
import { db, now, uid } from "./db.ts";

export interface MessageRow {
	id: string;
	agent_id: string;
	task_id: string | null;
	role: "user" | "assistant" | "tool" | "system" | "card";
	content: string;
	meta: string;
	status: string;
	created_at: number;
	updated_at: number;
}
export type Message = Omit<MessageRow, "meta"> & { meta: Record<string, unknown> };

export const toMessage = (r: MessageRow): Message => ({ ...r, meta: JSON.parse(r.meta) });

export function insertMessage(m: {
	agentId: string;
	taskId?: string | null;
	role: MessageRow["role"];
	content?: string;
	meta?: Record<string, unknown>;
	status?: string;
}): Message {
	const t = now();
	const row: MessageRow = {
		id: uid("m"),
		agent_id: m.agentId,
		task_id: m.taskId ?? null,
		role: m.role,
		content: m.content ?? "",
		meta: JSON.stringify(m.meta ?? {}),
		status: m.status ?? "done",
		created_at: t,
		updated_at: t,
	};
	db.prepare(
		"INSERT INTO messages(id, agent_id, task_id, role, content, meta, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
	).run(row.id, row.agent_id, row.task_id, row.role, row.content, row.meta, row.status, row.created_at, row.updated_at);
	const msg = toMessage(row);
	bus.emit({ type: "message.created", message: msg });
	if (!row.task_id && (row.role === "assistant" || row.role === "card")) db.prepare("UPDATE agents SET unread = unread + 1 WHERE id = ?").run(row.agent_id);
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

export function listMessages(agentId: string, opts: { taskId?: string | null; before?: number; limit?: number }) {
	const limit = Math.min(opts.limit ?? 200, 500);
	const rows = (opts.taskId
		? db.prepare("SELECT * FROM messages WHERE task_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(opts.taskId, opts.before ?? Number.MAX_SAFE_INTEGER, limit)
		: db
				.prepare("SELECT * FROM messages WHERE agent_id = ? AND task_id IS NULL AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
				.all(agentId, opts.before ?? Number.MAX_SAFE_INTEGER, limit)) as unknown as MessageRow[];
	return rows.reverse().map(toMessage);
}
