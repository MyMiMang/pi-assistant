/**
 * 电脑操作记录：助理在“助理电脑”和“这台电脑”上的每个动作（含被拒绝、被暂停拦下的）都记下来，任何模式都记录。
 * 助理电脑的动作完成后附一张整屏截图，便于在「电脑 › 操作记录」里逐步回看。保留最近 2000 条 / 截图 300 张。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionLogEntry } from "@pi-assistant/ext-computer";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db, now, uid } from "./db.ts";

const shotDir = () => join(config.dataDir, "action-shots");
const KEEP = 2000;
const KEEP_SHOTS = 300;

export interface ActionRow {
	id: string;
	call_id: string;
	agent_id: string;
	task_id: string | null;
	target: "sandbox" | "host";
	tool: string;
	input: string;
	summary: string;
	outcome: "running" | "done" | "error" | "blocked";
	approval: string | null;
	detail: string | null;
	shot: string | null;
	started_at: number;
	finished_at: number | null;
}
/** 截图前把输入里的长文本截短、去掉可能的密码字段 */
const redact = (input: Record<string, unknown>) =>
	JSON.stringify(input, (k, v) => (/pass|secret|token/i.test(k) ? "••••" : typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}…` : v));

export function recordAction(agentId: string, taskId: string | null, e: ActionLogEntry, screenshot?: () => Promise<Buffer>) {
	const t = now();
	if (e.phase === "start" || e.phase === "blocked") {
		const id = uid("act");
		db.prepare("INSERT INTO action_log(id, call_id, agent_id, task_id, target, tool, input, summary, outcome, approval, detail, started_at, finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
			id, e.callId, agentId, taskId, e.target, e.tool, redact(e.input), e.summary, e.phase === "blocked" ? "blocked" : "running", e.approval ?? null, e.detail ?? null, t, e.phase === "blocked" ? t : null,
		);
		emit(agentId, id);
		prune();
		return id;
	}
	const row = db.prepare("SELECT id FROM action_log WHERE call_id = ? AND agent_id = ? ORDER BY started_at DESC LIMIT 1").get(e.callId, agentId) as { id: string } | undefined;
	if (!row) return null;
	db.prepare("UPDATE action_log SET outcome = ?, detail = ?, finished_at = ? WHERE id = ?").run(e.phase, e.detail ?? null, t, row.id);
	emit(agentId, row.id);
	if (screenshot && e.target === "sandbox" && !/^(get_|list_|zoom$|start_session|end_session)/.test(e.tool))
		void screenshot()
			.then((png) => {
				mkdirSync(shotDir(), { recursive: true });
				writeFileSync(join(shotDir(), `${row.id}.png`), png);
				db.prepare("UPDATE action_log SET shot = ? WHERE id = ?").run(`${row.id}.png`, row.id);
				emit(agentId, row.id);
			})
			.catch(() => {});
	return row.id;
}
const emit = (agentId: string, id: string) => bus.emit({ type: "action.logged", agentId, id } as never);

function prune() {
	const old = db.prepare("SELECT id, shot FROM action_log ORDER BY started_at DESC LIMIT -1 OFFSET ?").all(KEEP) as { id: string; shot: string | null }[];
	for (const r of old) {
		if (r.shot) rmSync(join(shotDir(), r.shot), { force: true });
		db.prepare("DELETE FROM action_log WHERE id = ?").run(r.id);
	}
	const shots = db.prepare("SELECT id, shot FROM action_log WHERE shot IS NOT NULL ORDER BY started_at DESC LIMIT -1 OFFSET ?").all(KEEP_SHOTS) as { id: string; shot: string }[];
	for (const r of shots) {
		rmSync(join(shotDir(), r.shot), { force: true });
		db.prepare("UPDATE action_log SET shot = NULL WHERE id = ?").run(r.id);
	}
}

export function listActions(o: { agentId?: string; target?: string; before?: number; limit?: number } = {}) {
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (o.agentId) (where.push("agent_id = ?"), args.push(o.agentId));
	if (o.target) (where.push("target = ?"), args.push(o.target));
	if (o.before) (where.push("started_at < ?"), args.push(o.before));
	const rows = db.prepare(`SELECT * FROM action_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ?`).all(...args, Math.min(o.limit ?? 100, 500)) as unknown as ActionRow[];
	return rows.map((r) => ({ ...r, input: JSON.parse(r.input) as Record<string, unknown> }));
}
export function actionShot(id: string): Buffer | null {
	const r = db.prepare("SELECT shot FROM action_log WHERE id = ?").get(id) as { shot: string | null } | undefined;
	if (!r?.shot) return null;
	const f = join(shotDir(), r.shot);
	return existsSync(f) ? readFileSync(f) : null;
}
export function clearActions(agentId?: string) {
	const rows = (agentId ? db.prepare("SELECT shot FROM action_log WHERE agent_id = ? AND shot IS NOT NULL").all(agentId) : db.prepare("SELECT shot FROM action_log WHERE shot IS NOT NULL").all()) as { shot: string }[];
	for (const r of rows) rmSync(join(shotDir(), r.shot), { force: true });
	if (agentId) db.prepare("DELETE FROM action_log WHERE agent_id = ?").run(agentId);
	else db.prepare("DELETE FROM action_log").run();
}
