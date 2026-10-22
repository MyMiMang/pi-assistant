/**
 * 群里的项目（docs/design/group-team.md §1–3、决策 0019）：取代原来的「自主推进」开关。
 *  - 表 room_projects：一个群可以同时有几个项目；proposed（方案卡等用户确认）→ active（进行中）→ done / stopped；proposed 也可以 dismissed。
 *  - 方案卡（meta.kind = "room-plan"）由管理者用 room_plan 发出；进行中改方案写进 draft，用户确认后覆盖 plan，取消就丢掉 draft。
 *  - 「群里有 active 项目」就是原来「自主推进开着」的判断（collab / scheduler / 群规则）。
 *  - 迁移：旧的 rooms.autonomy 转成一个 active 项目，进行中的任务挂上 project_id（服务启动时跑，幂等）。
 * 方案的规范化 / 渲染是纯逻辑，在 plan.ts。
 */
import { db, now, uid } from "../db.ts";
import { getMessage, insertMessage, updateMessage } from "../messages.ts";
import { notify } from "../push.ts";
import { continueWorkItem, itemsOfProject, pauseWorkItem } from "../work-items.ts";
import { projectEnded, projectStarted, wakeManager } from "./collab.ts";
import { clipTitle, goalOnlyPlan, normalizePlan, type ProjectPlan } from "./plan.ts";
import { projectProgress, projectSig, projectStallStep, type ProjectProgress } from "./progress.ts";
import { changed, memberConversation, sys } from "./store.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS room_projects (
  id TEXT PRIMARY KEY, room_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  plan TEXT NOT NULL, draft TEXT, card_message_id TEXT, summary TEXT, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, confirmed_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS room_projects_room ON room_projects(room_id, status);
`);
// 旧库补列：项目级卡住计数、上次检查的进展指纹、已经改计划几次（§6「项目级进度检查」，决策 0019 第 3 步）
for (const [col, ddl] of [
	["stalls", "INTEGER NOT NULL DEFAULT 0"],
	["progress_sig", "TEXT"],
	["replans", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
	if (!(db.prepare("PRAGMA table_info(room_projects)").all() as { name: string }[]).some((c) => c.name === col)) db.exec(`ALTER TABLE room_projects ADD COLUMN ${col} ${ddl}`);
}
/** 换过办法仍连续卡住 3 次，不再让管理者自己处理，系统直接向用户报告（和单任务阶梯的「已用尽办法」同一思路）。 */
const REPLAN_EXHAUSTED = 2;

export type ProjectStatus = "proposed" | "active" | "done" | "stopped" | "dismissed";
export interface ProjectRow {
	id: string;
	room_id: string;
	title: string;
	status: ProjectStatus;
	plan: string;
	draft: string | null;
	card_message_id: string | null;
	summary: string | null;
	created_by: string;
	created_at: number;
	confirmed_at: number | null;
	ended_at: number | null;
	updated_at: number;
	stalls: number;
	progress_sig: string | null;
	replans: number;
}
export interface ProjectJson {
	id: string;
	roomId: string;
	title: string;
	status: ProjectStatus;
	plan: ProjectPlan;
	draft: ProjectPlan | null;
	cardMessageId: string | null;
	summary: string | null;
	createdAt: number;
	confirmedAt: number | null;
	endedAt: number | null;
	progress: ProjectProgress;
}

/** 给 HTTP 用的错误：status 404 = 项目不存在（message 固定 "not_found"），409 = 状态不对（message 是给用户看的一句话）。 */
export class ProjectError extends Error {
	status: 404 | 409;
	constructor(message: string, status: 404 | 409 = 409) {
		super(message);
		this.status = status;
	}
}

const parsePlan = (s: string | null) => {
	if (!s) return null;
	try {
		return normalizePlan(JSON.parse(s));
	} catch {
		return normalizePlan({});
	}
};
export const getProject = (id: string) => db.prepare("SELECT * FROM room_projects WHERE id = ?").get(id) as ProjectRow | undefined;
/** 默认只给 proposed / active（按创建时间升序）；all = 全部（含已结束，按创建时间降序）。 */
export const projectsOf = (roomId: string, all = false) =>
	db.prepare(all ? "SELECT * FROM room_projects WHERE room_id = ? ORDER BY created_at DESC, rowid DESC" : "SELECT * FROM room_projects WHERE room_id = ? AND status IN ('proposed','active') ORDER BY created_at, rowid").all(roomId) as unknown as ProjectRow[];
export const activeProjects = (roomId: string) => db.prepare("SELECT * FROM room_projects WHERE room_id = ? AND status = 'active' ORDER BY created_at, rowid").all(roomId) as unknown as ProjectRow[];
export const hasActiveProject = (roomId: string) => !!db.prepare("SELECT 1 FROM room_projects WHERE room_id = ? AND status = 'active' LIMIT 1").get(roomId);
/** planText 要的形状 */
export const projectView = (r: ProjectRow) => ({ id: r.id, title: r.title, plan: parsePlan(r.plan)! });

export function projectJson(r: ProjectRow): ProjectJson {
	return {
		id: r.id, roomId: r.room_id, title: r.title, status: r.status, plan: parsePlan(r.plan)!, draft: parsePlan(r.draft), cardMessageId: r.card_message_id, summary: r.summary,
		createdAt: r.created_at, confirmedAt: r.confirmed_at, endedAt: r.ended_at,
		progress: projectProgress(parsePlan(r.plan)!, itemsOfProject(r.id)),
	};
}

function requireProject(roomId: string, projectId: string) {
	const p = getProject(projectId);
	if (!p || p.room_id !== roomId) throw new ProjectError("not_found", 404);
	return p;
}
/** 当前方案卡还在等用户时改成 status（确认 / 先不做 / 被新方案取代）。 */
function settleCard(p: ProjectRow, status: "confirmed" | "dismissed" | "superseded") {
	const m = p.card_message_id ? getMessage(p.card_message_id) : undefined;
	if (m?.meta.status === "pending") updateMessage(m.id, { meta: { status } });
}
/** 方案卡还在等用户，而且卡片发出之后群里有用户本人的消息（room_project_start 的防护：不能替用户确认）。 */
export function userRepliedToCard(p: ProjectRow) {
	const m = p.card_message_id ? getMessage(p.card_message_id) : undefined;
	if (m?.meta.status !== "pending") return false;
	return !!db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND role = 'user' AND rowid > (SELECT rowid FROM messages WHERE id = ?) LIMIT 1").get(p.room_id, m.id);
}
const notice = (p: ProjectRow, text: string, event: "started" | "revised" | "done" | "stopped" | "dismissed" | "stalled") => sys(p.room_id, text, { kind: "room-project", projectId: p.id, event });
const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);
/** 方案卡还在等用户时才需要检查「用户发话过没有」；项目已经结束太久没有卡片，直接按「没发话过」算。 */
export function userRepliedAfterStop(p: ProjectRow): boolean {
	if (!p.ended_at) return false;
	return !!db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND role = 'user' AND created_at > ? LIMIT 1").get(p.room_id, p.ended_at);
}

/**
 * 管理者出方案卡（room_plan）：
 *  - 不带 projectId：新建 proposed 项目；
 *  - 带 projectId、项目还在 proposed：更新方案（和项目名）；
 *  - 带 projectId、项目进行中：写进 draft，发「改过的方案」卡（revision）请用户重新确认。
 * 新卡发出时，这个项目之前还在等用户的卡改成 superseded。plan 由调用方先用 plan.ts 的 checkPlan 校验过。
 */
export function proposePlan(o: { roomId: string; managerId: string; title: string; plan: ProjectPlan; projectId?: string }) {
	const t = now();
	let id = o.projectId ?? "";
	let revision = false;
	if (id) {
		const p = requireProject(o.roomId, id);
		if (p.status === "proposed") db.prepare("UPDATE room_projects SET title = ?, plan = ?, updated_at = ? WHERE id = ?").run(clipTitle(o.title, o.plan.goal) || p.title, JSON.stringify(o.plan), t, id);
		else if (p.status === "active") {
			db.prepare("UPDATE room_projects SET draft = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(o.plan), t, id);
			revision = true;
		} else throw new ProjectError(`项目「${p.title}」已经结束了，不能再改方案；要做新的事，不带 projectId 重新出方案。`);
		settleCard(p, "superseded");
	} else {
		id = uid("pj");
		db.prepare("INSERT INTO room_projects(id, room_id, title, status, plan, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, o.roomId, clipTitle(o.title, o.plan.goal) || "新项目", "proposed", JSON.stringify(o.plan), o.managerId, t, t);
	}
	const p = getProject(id)!;
	const card = insertMessage({ agentId: o.managerId, conversationId: memberConversation(o.roomId, o.managerId), role: "card", meta: { kind: "room-plan", roomId: o.roomId, projectId: id, title: p.title, plan: o.plan, revision, status: "pending" } });
	db.prepare("UPDATE room_projects SET card_message_id = ? WHERE id = ?").run(card.id, id);
	changed(o.roomId);
	return { project: getProject(id)!, revision };
}

/**
 * 确认方案（用户点「就这么干」，或用户在群里说可以后管理者用 room_project_start）：
 * proposed → active；进行中且有 draft → draft 覆盖 plan。by = "user" 时唤醒管理者开始派活（管理者自己调用时它正在回合里，不再唤醒）。
 */
export function confirmProject(roomId: string, projectId: string, by: "user" | "manager" = "user") {
	const p = requireProject(roomId, projectId);
	const t = now();
	if (p.status === "proposed") {
		db.prepare("UPDATE room_projects SET status = 'active', confirmed_at = ?, updated_at = ? WHERE id = ?").run(t, t, p.id);
		settleCard(p, "confirmed");
		notice(p, `方案已确认，项目「${p.title}」开始了。管理者会按分工把任务派下去，成员之间可以直接配合；只有需要你看一眼或拍板的事才会找你。`, "started");
		projectStarted(roomId, by === "manager");
		if (by === "user") wakeManager(roomId, `用户确认了项目「${p.title}」的方案：按方案的分工和阶段，用 work_create（带 projectId）把第一批任务派给对口成员，开始推进`);
	} else if (p.status === "active" && p.draft) {
		db.prepare("UPDATE room_projects SET plan = draft, draft = NULL, updated_at = ? WHERE id = ?").run(t, p.id);
		settleCard(p, "confirmed");
		notice(p, `改过的方案已确认，项目「${p.title}」按新方案继续。`, "revised");
		if (by === "user") wakeManager(roomId, `用户确认了项目「${p.title}」改过的方案：按新方案调整任务，继续推进`);
	} else throw new ProjectError("这份方案已经处理过了");
	changed(roomId);
	return getProject(p.id)!;
}

/** 用户点「先不做」：proposed → dismissed；进行中有 draft → 丢掉 draft，按原方案继续。 */
export function dismissProject(roomId: string, projectId: string) {
	const p = requireProject(roomId, projectId);
	const t = now();
	if (p.status === "proposed") {
		db.prepare("UPDATE room_projects SET status = 'dismissed', ended_at = ?, updated_at = ? WHERE id = ?").run(t, t, p.id);
		settleCard(p, "dismissed");
		notice(p, "这份方案先不做了。", "dismissed");
	} else if (p.status === "active" && p.draft) {
		db.prepare("UPDATE room_projects SET draft = NULL, updated_at = ? WHERE id = ?").run(t, p.id);
		settleCard(p, "dismissed");
		notice(p, `改过的方案先不用，项目「${p.title}」按原方案继续。`, "dismissed");
	} else throw new ProjectError("这份方案已经处理过了");
	changed(roomId);
	return getProject(p.id)!;
}

/** 用户在项目面板停下项目：active → stopped，暂停这个项目下还没结束的任务（保留进度）。 */
export async function stopProject(roomId: string, projectId: string) {
	const p = requireProject(roomId, projectId);
	if (p.status !== "active") throw new ProjectError(p.status === "proposed" ? "这个项目还没开始，不用停；不想做就在方案卡上点「先不做」" : "这个项目已经结束了");
	const t = now();
	db.prepare("UPDATE room_projects SET status = 'stopped', draft = NULL, summary = ?, ended_at = ?, updated_at = ? WHERE id = ?").run("用户停下了这个项目，进度保留", t, t, p.id);
	settleCard(p, "superseded");
	projectEnded(roomId);
	const items = db.prepare("SELECT id FROM work_items WHERE project_id = ? AND status IN ('pending','active','blocked','review')").all(p.id) as { id: string }[];
	for (const it of items) await pauseWorkItem({ workItemId: it.id, actor: { kind: "user" } }).catch(() => {});
	notice(p, `项目「${p.title}」已停下，进度保留；想继续就在群里跟管理者说。`, "stopped");
	changed(roomId);
	return getProject(p.id)!;
}

/** 停下后接着做（面板「接着做」按钮，或用户在群里说后管理者调 room_project_resume）：stopped → active，恢复暂停的任务。 */
export async function resumeProject(roomId: string, projectId: string) {
	const p = requireProject(roomId, projectId);
	if (p.status !== "stopped") throw new ProjectError(p.status === "active" ? "这个项目正在进行中，不用恢复" : "这个项目不是已停下的状态，不能恢复");
	const t = now();
	db.prepare("UPDATE room_projects SET status = 'active', ended_at = NULL, updated_at = ? WHERE id = ?").run(t, p.id);
	const items = db.prepare("SELECT id FROM work_items WHERE project_id = ? AND status = 'paused'").all(p.id) as { id: string }[];
	for (const it of items) await continueWorkItem({ workItemId: it.id, actor: { kind: "user" } }).catch(() => {});
	notice(p, `项目「${p.title}」接着做，从停下的地方继续。`, "started");
	projectStarted(roomId, false);
	wakeManager(roomId, `用户要求项目「${p.title}」接着做：对照进度清单，从停下的地方继续推进`);
	changed(roomId);
	return getProject(p.id)!;
}

/**
 * 项目级进度检查（docs/design/group-team.md §6「项目级进度检查」，管理者被叫醒时对每个 active 项目算一次）：
 * 卡住到 3 次要求管理者先说清原因再改计划；已经改过 ≥2 次计划后又卡到 3 次，不再让它自己来，系统直接报告用户。
 * 返回 "ok"（没到阈值）/ "replan"（要求改计划，调用方把要求文字接进唤醒内容）/ "exhausted"（已经报告，不用再提示）。
 */
export function checkProjectStall(p: ProjectRow): "ok" | "replan" | "exhausted" {
	const done = (db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE project_id = ? AND status = 'done'").get(p.id) as { n: number }).n;
	const submits = (db.prepare("SELECT COUNT(*) AS n FROM work_item_events e JOIN work_items w ON w.id = e.work_item_id WHERE w.project_id = ? AND e.kind = 'submitted'").get(p.id) as { n: number }).n;
	const sig = projectSig({ done, submits });
	const impossible = !!db
		.prepare("SELECT 1 FROM work_item_events e JOIN work_items w ON w.id = e.work_item_id WHERE w.project_id = ? AND e.kind = 'verified.impossible' AND e.created_at > ? LIMIT 1")
		.get(p.id, p.updated_at);
	const stalls = projectStallStep({ stalls: p.stalls, lastSig: p.progress_sig, sig, impossible });
	if (stalls < 3) {
		db.prepare("UPDATE room_projects SET stalls = ?, progress_sig = ?, updated_at = ? WHERE id = ?").run(stalls, sig, now(), p.id);
		return "ok";
	}
	if (p.replans >= REPLAN_EXHAUSTED) {
		// 换过办法仍然卡住：不再要求管理者自己想办法，系统直接写清楚并推送用户（和单任务的「已用尽办法」同一思路）。
		db.prepare("UPDATE room_projects SET stalls = 0, progress_sig = ?, updated_at = ? WHERE id = ?").run(sig, now(), p.id);
		notice(p, `项目「${p.title}」反复卡住，已经换过 ${p.replans} 次办法仍没有新进展。需要你看一下卡在哪、要不要调整方向。`, "stalled");
		notify({ title: `${p.title}：需要你看一下`, body: "项目反复卡住，换过办法仍没有进展", tag: `project-stalled-${p.id}`, url: `/?room=${p.room_id}` });
		return "exhausted";
	}
	db.prepare("UPDATE room_projects SET stalls = ?, progress_sig = ?, updated_at = ? WHERE id = ?").run(stalls, sig, now(), p.id);
	return "replan";
}

/** 管理者记一次改计划（room_project_replan）：卡住计数清零，改计划次数 +1，群里说明卡在哪、怎么改。 */
export function replanProject(roomId: string, projectId: string, o: { why: string; change: "retry" | "reassign" | "split" | "approach" | "plan"; detail: string }) {
	const p = requireProject(roomId, projectId);
	if (p.status !== "active") throw new ProjectError("这个项目不在进行中，不用改计划");
	const label = { retry: "带着改进意见重做", reassign: "换更对口的成员", split: "把任务拆小", approach: "换一种做法", plan: "改方案" }[o.change];
	db.prepare("UPDATE room_projects SET stalls = 0, replans = replans + 1, updated_at = ? WHERE id = ?").run(now(), p.id);
	notice(p, `项目「${p.title}」卡住了：${clip(o.why, 200)}。改法：${label}——${clip(o.detail, 300)}`, "stalled");
	changed(roomId);
	return getProject(p.id)!;
}

/** 管理者交付后结束项目（room_project_done）：active → done，结果总结发到群里。 */
export function finishProject(roomId: string, projectId: string, summary: string) {
	const p = requireProject(roomId, projectId);
	if (p.status !== "active") throw new ProjectError(p.status === "proposed" ? "这个项目还没开始（方案还在等用户确认）" : "这个项目已经结束了");
	const t = now();
	db.prepare("UPDATE room_projects SET status = 'done', draft = NULL, summary = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(summary, t, t, p.id);
	settleCard(p, "superseded");
	projectEnded(roomId);
	notice(p, `项目「${p.title}」已完成。结果：${summary}`, "done");
	changed(roomId);
	return getProject(p.id)!;
}

/** 旧的 room-goal 卡片确认：直接建一个 active 项目（方案只有目标和完成标准）。 */
export function startGoalProject(roomId: string, by: string, goal: string, doneCriteria: string) {
	const plan = goalOnlyPlan(goal, doneCriteria);
	if (!plan.goal || !plan.doneCriteria) throw new Error("目标和完成标准都要写清楚");
	const id = uid("pj");
	const t = now();
	db.prepare("INSERT INTO room_projects(id, room_id, title, status, plan, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, roomId, clipTitle("", plan.goal), "proposed", JSON.stringify(plan), by, t, t);
	return confirmProject(roomId, id, "user");
}

/** 迁移旧的自主推进（服务启动时跑，幂等）：rooms.autonomy → 一个 active 项目；进行中的任务挂上它；autonomy 清空。 */
export function migrateAutonomy() {
	let n = 0;
	for (const r of db.prepare("SELECT id, autonomy FROM rooms WHERE autonomy IS NOT NULL").all() as { id: string; autonomy: string }[]) {
		let a: { goal?: unknown; doneCriteria?: unknown; startedAt?: unknown } = {};
		try {
			a = JSON.parse(r.autonomy) ?? {};
		} catch {
			/* 坏数据：直接清掉 */
		}
		const plan = goalOnlyPlan(String(a.goal ?? ""), String(a.doneCriteria ?? ""));
		if (plan.goal) {
			const id = uid("pj");
			const at = typeof a.startedAt === "number" ? a.startedAt : now();
			db.prepare("INSERT INTO room_projects(id, room_id, title, status, plan, created_by, created_at, confirmed_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, r.id, clipTitle("", plan.goal), "active", JSON.stringify(plan), "migration", at, at, now());
			db.prepare("UPDATE work_items SET project_id = ? WHERE room_id = ? AND project_id IS NULL AND status IN ('active','blocked','review','paused')").run(id, r.id);
			n++;
		}
		db.prepare("UPDATE rooms SET autonomy = NULL WHERE id = ?").run(r.id);
	}
	return n;
}
