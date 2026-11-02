/**
 * 判断记录（决策 0025）：助理每次「主动做事」的判断记一行——做了什么、依据、对上哪些规则、结果。
 * 提醒面板里可看；试运行的「本来会做」也记在这里（input 里存着原样的推进参数，点「就这么做」时照它真做一次）；
 * 用户点「这类以后别做」→ outcome = vetoed，之后巡检提示里列出来，同类判断带上。
 * 只读写 db（不 import proactive.ts，避免循环）。
 */
import { db, now, uid } from "./db.ts";

db.exec(`CREATE TABLE IF NOT EXISTS proactive_judgments (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, item_id TEXT, conversation_id TEXT, room_id TEXT,
 kind TEXT NOT NULL, title TEXT NOT NULL, basis TEXT NOT NULL DEFAULT '', rules TEXT NOT NULL DEFAULT '[]',
 mode TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT, input TEXT NOT NULL DEFAULT '{}',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS proactive_judgments_agent ON proactive_judgments(agent_id, created_at);
CREATE INDEX IF NOT EXISTS proactive_judgments_item ON proactive_judgments(item_id);
`);

/** trial 试运行（等用户决定）/ confirmed 试运行后用户点了「就这么做」/ vetoed 用户点了「这类以后别做」/ to_reminder 没依据，转成了提醒 / 其余同推进结果 */
export type Outcome = "trial" | "confirmed" | "vetoed" | "to_reminder" | "started" | "steered" | "queued" | "inbox" | "held" | "rejected" | "cancelled";
export interface JudgmentRow {
	id: string;
	agent_id: string;
	item_id: string | null;
	conversation_id: string | null;
	room_id: string | null;
	kind: string;
	title: string;
	basis: string;
	rules: string;
	mode: string;
	outcome: Outcome;
	reason: string | null;
	input: string;
	created_at: number;
	updated_at: number;
}

export function recordJudgment(j: { agentId: string; itemId?: string | null; conversationId?: string | null; roomId?: string | null; kind: string; title: string; basis: string; rules: { ruleId: string; reason: string }[]; mode: string; outcome: Outcome; reason?: string | null; input: unknown }, t = now()): string {
	const id = uid("pj");
	db.prepare("INSERT INTO proactive_judgments(id, agent_id, item_id, conversation_id, room_id, kind, title, basis, rules, mode, outcome, reason, input, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
		id, j.agentId, j.itemId ?? null, j.conversationId ?? null, j.roomId ?? null, j.kind, j.title.slice(0, 100), j.basis.slice(0, 400), JSON.stringify(j.rules), j.mode, j.outcome, j.reason ?? null, JSON.stringify(j.input), t, t,
	);
	return id;
}
export function setOutcome(id: string, outcome: Outcome, reason: string | null, t = now()) {
	db.prepare("UPDATE proactive_judgments SET outcome = ?, reason = COALESCE(?, reason), updated_at = ? WHERE id = ?").run(outcome, reason, t, id);
}
export const judgmentOfItem = (itemId: string) => db.prepare("SELECT * FROM proactive_judgments WHERE item_id = ? ORDER BY created_at DESC LIMIT 1").get(itemId) as JudgmentRow | undefined;
export const listJudgments = (agentId: string, limit = 30) => db.prepare("SELECT * FROM proactive_judgments WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?").all(agentId, limit) as unknown as JudgmentRow[];
/** 还在等用户决定的试运行卡片对应的提醒编号（收件箱显示「就这么做 / 这类以后别做」用） */
export const trialItemIds = (agentId?: string): Set<string> =>
	new Set((db.prepare(`SELECT item_id FROM proactive_judgments WHERE outcome = 'trial' AND item_id IS NOT NULL${agentId ? " AND agent_id = ?" : ""}`).all(...(agentId ? [agentId] : [])) as { item_id: string }[]).map((r) => r.item_id));
/** 用户否掉过的做法（最近 10 条，给巡检提示用） */
export const avoidedList = (agentId: string): string[] =>
	(db.prepare("SELECT title, kind FROM proactive_judgments WHERE agent_id = ? AND outcome = 'vetoed' ORDER BY updated_at DESC LIMIT 10").all(agentId) as { title: string; kind: string }[]).map((r) => `${r.title}（${r.kind}）`);
