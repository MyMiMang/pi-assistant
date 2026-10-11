/**
 * 对话：每个助理可以有多个对话，每个对话对应一个独立的 Pi 会话文件（JSONL）。
 * agents.conversation_id 记录“当前对话”（新消息默认进入这里）。
 */
import { bus } from "./bus.ts";
import { db, now, uid } from "./db.ts";

export interface ConversationRow {
	id: string;
	agent_id: string;
	title: string;
	session_file: string | null;
	created_at: number;
	updated_at: number;
}

export const getConversation = (id: string) => db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;

export function listConversations(agentId: string) {
	return db
		.prepare(
			`SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.task_id IS NULL AND m.role IN ('user','assistant')) AS message_count,
			 (SELECT content FROM messages m WHERE m.conversation_id = c.id AND m.task_id IS NULL AND m.role IN ('user','assistant') ORDER BY created_at DESC LIMIT 1) AS last
			 FROM conversations c WHERE c.agent_id = ? ORDER BY c.updated_at DESC`,
		)
		.all(agentId) as unknown as (ConversationRow & { message_count: number; last: string | null })[];
}

export function createConversation(agentId: string, title = ""): ConversationRow {
	const id = uid("c");
	const t = now();
	db.prepare("INSERT INTO conversations(id, agent_id, title, created_at, updated_at) VALUES(?,?,?,?,?)").run(id, agentId, title, t, t);
	db.prepare("UPDATE agents SET conversation_id = ? WHERE id = ?").run(id, agentId);
	bus.emit({ type: "conversations.changed", agentId, current: id });
	return getConversation(id)!;
}

/** 助理当前对话；没有就新建一个。 */
export function currentConversation(agentId: string): string {
	const row = db.prepare("SELECT a.conversation_id AS id FROM agents a JOIN conversations c ON c.id = a.conversation_id WHERE a.id = ?").get(agentId) as { id: string } | undefined;
	if (row) return row.id;
	const latest = db.prepare("SELECT id FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 1").get(agentId) as { id: string } | undefined;
	if (latest) {
		db.prepare("UPDATE agents SET conversation_id = ? WHERE id = ?").run(latest.id, agentId);
		return latest.id;
	}
	return createConversation(agentId).id;
}

export function setCurrentConversation(agentId: string, id: string) {
	const c = getConversation(id);
	if (!c || c.agent_id !== agentId) return false;
	db.prepare("UPDATE agents SET conversation_id = ? WHERE id = ?").run(id, agentId);
	bus.emit({ type: "conversations.changed", agentId, current: id });
	return true;
}

export function setConversationSession(id: string, file: string) {
	db.prepare("UPDATE conversations SET session_file = ? WHERE id = ?").run(file, id);
}

/** 有新消息时刷新时间；首条用户消息自动成为标题。 */
export function touchConversation(id: string, userText?: string) {
	const c = getConversation(id);
	if (!c) return;
	if (userText && !c.title.trim()) {
		const title = userText.replace(/\s+/g, " ").trim().slice(0, 30);
		db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(title, now(), id);
		bus.emit({ type: "conversations.changed", agentId: c.agent_id });
	} else db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), id);
}

export function renameConversation(id: string, title: string) {
	const c = getConversation(id);
	if (!c) return;
	db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title.slice(0, 60), id);
	bus.emit({ type: "conversations.changed", agentId: c.agent_id });
}

/** 删除对话（消息一并删除；Pi 会话文件留在磁盘上不动）。删的是当前对话时切到最近的另一个。 */
export function deleteConversation(id: string) {
	const c = getConversation(id);
	if (!c) return null;
	db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
	db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
	const cur = db.prepare("SELECT conversation_id FROM agents WHERE id = ?").get(c.agent_id) as { conversation_id: string | null };
	if (cur?.conversation_id === id) db.prepare("UPDATE agents SET conversation_id = NULL WHERE id = ?").run(c.agent_id);
	const next = currentConversation(c.agent_id);
	bus.emit({ type: "conversations.changed", agentId: c.agent_id, current: next });
	return c;
}
