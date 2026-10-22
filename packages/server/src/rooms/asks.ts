/**
 * 成员之间可追踪的提问（表 room_asks，docs/design/group-team.md 第 5 节、决策 0019 第 4 步）：
 * 一个问题 = 一段小对话（thread），有轮数和状态。流程（发问 / 回答 / 交给管理者）在 ask-flow.ts，纯逻辑在 ask-logic.ts。
 */
import { db, now, uid } from "../db.ts";
import { getAgent } from "../runtime.ts";
import type { AskKind, AskStatus, ThreadEntry } from "./ask-logic.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS room_asks (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, project_id TEXT, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
  from_item TEXT, kind TEXT NOT NULL, target_item TEXT, status TEXT NOT NULL, rounds INTEGER NOT NULL DEFAULT 0,
  thread TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS room_asks_room ON room_asks(room_id, status);
CREATE INDEX IF NOT EXISTS room_asks_items ON room_asks(from_item, target_item);
`);

export interface AskRow {
	id: string;
	room_id: string;
	project_id: string | null;
	from_agent: string;
	to_agent: string;
	from_item: string | null;
	kind: AskKind;
	target_item: string | null;
	status: AskStatus;
	rounds: number;
	thread: string;
	created_at: number;
	updated_at: number;
}

export const getAsk = (id: string) => db.prepare("SELECT * FROM room_asks WHERE id = ?").get(id) as AskRow | undefined;
export const threadOf = (a: Pick<AskRow, "thread">): ThreadEntry[] => {
	try {
		return JSON.parse(a.thread) as ThreadEntry[];
	} catch {
		return [];
	}
};

export function createAsk(o: { roomId: string; projectId: string | null; from: string; to: string; fromItem: string | null; kind: AskKind; targetItem: string | null; text: string }): AskRow {
	const id = uid("ask");
	const t = now();
	db.prepare("INSERT INTO room_asks(id, room_id, project_id, from_agent, to_agent, from_item, kind, target_item, status, rounds, thread, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
		id, o.roomId, o.projectId, o.from, o.to, o.fromItem, o.kind, o.targetItem, "open", 0, JSON.stringify([{ by: o.from, text: o.text, at: t }]), t, t,
	);
	return getAsk(id)!;
}

/** 更新状态 / 轮数 / 对话（thread 传新增的一条）。 */
export function updateAsk(id: string, patch: { status?: AskStatus; rounds?: number; add?: ThreadEntry; to?: string }) {
	const cur = getAsk(id);
	if (!cur) return undefined;
	const thread = patch.add ? [...threadOf(cur), patch.add] : threadOf(cur);
	db.prepare("UPDATE room_asks SET status = ?, rounds = ?, thread = ?, to_agent = ?, updated_at = ? WHERE id = ?").run(patch.status ?? cur.status, patch.rounds ?? cur.rounds, JSON.stringify(thread), patch.to ?? cur.to_agent, now(), id);
	return getAsk(id)!;
}

/** 没人回答的提问（给超时检查用）。 */
export const unansweredAsks = () => db.prepare("SELECT * FROM room_asks WHERE status = 'open'").all() as unknown as AskRow[];

/** 这个群里提问者 / 被问者各自还没了结的提问里，针对某个任务的 open 上游提问。 */
export const openUpstreamAsk = (targetItem: string, toAgent: string) =>
	db.prepare("SELECT * FROM room_asks WHERE kind = 'upstream' AND target_item = ? AND to_agent = ? AND status IN ('open','escalated') ORDER BY created_at DESC").get(targetItem, toAgent) as AskRow | undefined;

const nameOf = (id: string) => getAgent(id)?.name ?? "成员";
/** 给界面看的：和某个任务有关的提问（它是提问时在做的任务，或被指有问题的上游任务）。 */
export function asksOfItem(itemId: string) {
	const rows = db.prepare("SELECT * FROM room_asks WHERE from_item = ? OR target_item = ? ORDER BY updated_at DESC LIMIT 20").all(itemId, itemId) as unknown as AskRow[];
	return rows.map((a) => {
		const thread = threadOf(a);
		const question = [...thread].reverse().find((e) => e.by === a.from_agent)?.text ?? "";
		return { id: a.id, to: a.to_agent, toName: nameOf(a.to_agent), from: a.from_agent, fromName: nameOf(a.from_agent), kind: a.kind, status: a.status, rounds: a.rounds, question, updatedAt: a.updated_at };
	});
}
