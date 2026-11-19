import { createHash } from "node:crypto";
import { markdownToPlain } from "./channels/caps.ts";
import { db } from "./db.ts";
import { stripThinking } from "./thinking.ts";

export type SearchScope = { kind: "conversation"; id: string; agentId: string } | { kind: "room"; id: string };
type Row = { id: string; seq: number; created_at: number; content: string; role: "user" | "assistant"; speaker: string | null };
const PAGE = 30;
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export function searchMessages(scope: SearchScope, raw: string, cursor?: string) {
	const q = fold(raw.trim());
	if (!q || q.length > 200) return null;
	const signature = createHash("sha256").update(JSON.stringify([scope, q])).digest("hex");
	const parts = cursor?.match(/^([a-f0-9]{64})\.(\d{1,16})\.(\d{1,16})$/);
	if (cursor !== undefined && (!parts || parts[1] !== signature || !Number.isSafeInteger(Number(parts[2])) || !Number.isSafeInteger(Number(parts[3])))) return null;
	const inScope = scope.kind === "room" ? "m.room_id = ?" : "m.conversation_id = ? AND m.agent_id = ? AND m.room_id IS NULL";
	const args = scope.kind === "room" ? [scope.id] : [scope.id, scope.agentId];
	const rows = db.prepare(`SELECT m.id, m.rowid AS seq, m.created_at, m.content, m.role,
		CASE WHEN m.role = 'user' THEN json_extract(CASE WHEN json_valid(m.meta) THEN m.meta ELSE '{}' END, '$.from.name') ELSE a.name END AS speaker
		FROM messages m LEFT JOIN agents a ON a.id = m.agent_id WHERE ${inScope}
		AND m.task_id IS NULL AND m.subagent_id IS NULL AND m.role IN ('user','assistant') AND m.content != ''
		${parts ? "AND (m.created_at, m.rowid) < (?, ?)" : ""} ORDER BY m.created_at DESC, m.rowid DESC`)
		.iterate(...args, ...(parts ? [Number(parts[2]), Number(parts[3])] : [])) as Iterable<Row>;
	const items = [];
	let last: Row | undefined;
	for (const row of rows) {
		const text = row.role === "user" ? row.content : markdownToPlain(stripThinking(row.content), { visibleLabelsOnly: true });
		const pos = fold(text).indexOf(q);
		if (pos < 0) continue;
		if (items.length === PAGE && last) return { items, nextCursor: `${signature}.${last.created_at}.${last.seq}` };
		const start = Math.max(0, pos - 36);
		const end = Math.min(text.length, pos + q.length + 56);
		items.push({ id: row.id, speaker: (typeof row.speaker === "string" && row.speaker.trim()) || (row.role === "user" ? "用户" : "助理"), createdAt: row.created_at, snippet: `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}` });
		last = row;
	}
	return { items, nextCursor: null };
}
