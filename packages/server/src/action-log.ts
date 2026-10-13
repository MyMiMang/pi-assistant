/**
 * 电脑操作记录：助理在“助理电脑”和“这台电脑”上的每个动作（含被拒绝、被暂停拦下的）都记下来，任何模式都记录。
 * 不在用户界面显示（用户看不懂原始工具名），留给助理自己复盘：computer_action_history 工具可以读。
 * 助理电脑的动作完成后附一张整屏截图（排查用）。占用上限：最近 2000 条且不超过 30 天；截图最近 50 张、7 天内、合计不超过 100 MB。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionLogEntry } from "@pi-assistant/ext-computer";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db, now, uid } from "./db.ts";

const shotDir = () => join(config.dataDir, "action-shots");
const KEEP = 2000;
const KEEP_SHOTS = 50;
const KEEP_DAYS = 30;
const SHOT_DAYS = 7;
const SHOT_BYTES = 100 * 1024 * 1024;
const DAY = 86_400_000;
let pruned = 0;

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

function prune(force = false) {
	// 每条记录都触发，但最多每分钟真正清一次
	if (!force && Date.now() - pruned < 60_000) return;
	pruned = Date.now();
	const cut = now() - KEEP_DAYS * DAY;
	for (const r of db.prepare("SELECT id, shot FROM action_log WHERE started_at < ?").all(cut) as { id: string; shot: string | null }[]) {
		if (r.shot) rmSync(join(shotDir(), r.shot), { force: true });
		db.prepare("DELETE FROM action_log WHERE id = ?").run(r.id);
	}
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
	let bytes = 0;
	const shotCut = now() - SHOT_DAYS * DAY;
	for (const r of db.prepare("SELECT id, shot, started_at FROM action_log WHERE shot IS NOT NULL ORDER BY started_at DESC").all() as { id: string; shot: string; started_at: number }[]) {
		const f = join(shotDir(), r.shot);
		bytes += existsSync(f) ? statSync(f).size : 0;
		if (r.started_at < shotCut || bytes > SHOT_BYTES) {
			rmSync(f, { force: true });
			db.prepare("UPDATE action_log SET shot = NULL WHERE id = ?").run(r.id);
		}
	}
	// 截图目录里没有记录对应的孤儿文件（例如崩溃时写了一半）
	if (existsSync(shotDir())) {
		const keep = new Set((db.prepare("SELECT shot FROM action_log WHERE shot IS NOT NULL").all() as { shot: string }[]).map((r) => r.shot));
		for (const f of readdirSync(shotDir())) if (!keep.has(f)) rmSync(join(shotDir(), f), { force: true });
	}
}
/** 启动时清一次 */
export const pruneActions = () => prune(true);

/** 给助理复盘用的文字版操作记录（最新在前） */
export function actionHistoryText(agentId: string, o: { target?: "sandbox" | "host"; limit?: number; all?: boolean } = {}) {
	const rows = listActions({ agentId: o.all ? undefined : agentId, target: o.target, limit: Math.min(o.limit ?? 30, 200) });
	if (!rows.length) return "还没有电脑操作记录。";
	const label = { done: "完成", error: "出错", blocked: "被拦下", running: "进行中" } as const;
	return rows
		.map((r) => {
			const at = new Date(r.started_at).toLocaleString("zh-CN", { hour12: false });
			const who = o.all && r.agent_id !== agentId ? ` [${r.agent_id}]` : "";
			const extra = r.detail ? ` — ${r.detail.slice(0, 200)}` : "";
			return `${at} ${r.target === "host" ? "本机" : "助理电脑"}${who} ${r.tool} ${JSON.stringify(r.input).slice(0, 200)} → ${label[r.outcome]}${r.approval ? `（${r.approval}）` : ""}${extra}`;
		})
		.join("\n");
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
