/**
 * 长期任务（任务责任）的数据层：表结构、行读取、权限门、看板列表 / 详情。
 *
 * 设计见 docs/design/durable-work-items.md 与 docs/design/group-collaboration.md。要点：
 *  - 这里只存“责任”：任务是什么、谁负责、完成标准、业务状态、核验结论、修订号；
 *    执行在负责人自己的隐藏会话里（exec.ts），用它自己的记忆、权限、电脑，不占群的发言回合。
 *  - 业务状态与「当前有没有执行」分开：执行结束最多让任务停在待核验，只有管理者或用户显式核验通过才完成。
 *  - 每次执行都记在一个任务修订（revision）上；改派 / 编辑 / 暂停 / 取消会推进修订，
 *    迟到的结果只能追加历史，不能覆盖最新的任务责任。
 *  - 服务端绑定 actor：工具里的 actor 来自会话闭包，HTTP 里用户就是用户；不接受请求体自报身份。
 */
import { bus } from "../bus.ts";
import { db, now, uid } from "../db.ts";
import { getFile } from "../files.ts";
import { insertMessage } from "../messages.ts";
import { BOARD_GROUPS, BOARD_LABEL, boardGroupOf, type BoardGroup } from "./guard.ts";
import type { Escalation } from "../stuck.ts";

export const WORK_STATUSES = ["pending", "active", "blocked", "review", "done", "paused", "cancelled"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
	pending: "待安排",
	active: "进行中",
	blocked: "受阻",
	review: "待核验",
	done: "已完成",
	paused: "已暂停",
	cancelled: "已取消",
};

/**
 * actor 由宿主绑定：group 工具的 actor 必须带上它所在的 roomId，同一个管理者跨两个群时
 * 不能在 A 群的工具里改 B 群的任务；HTTP 用户动作是全局用户，不受 room 限制。
 */
export type WorkActor = { kind: "user" } | { kind: "agent"; agentId: string; roomId?: string };
export type WorkRunStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

export interface NeedsUser {
	question: string;
	options: string[];
	reason: string;
	requestId: string | null;
	at: number;
}
export interface WorkItemRow {
	id: string;
	scope_kind: string;
	room_id: string | null;
	conversation_id: string | null;
	title: string;
	requirement: string;
	done_criteria: string;
	owner_agent_id: string | null;
	status: WorkStatus;
	revision: number;
	latest_progress: string;
	blocker: string | null;
	verification: string | null;
	auto_retries: number;
	needs_user: string | null;
	escalation: string | null;
	last_progress_at: number | null;
	created_by: string;
	source_message_id: string | null;
	/** 属于群里的哪个项目（rooms/projects.ts；没有就是平时的任务） */
	project_id: string | null;
	/** 前置任务编号（JSON 数组，空数组用 "[]"）；全部完成才能开始，见 deps.ts */
	depends_on: string;
	/** 属于方案里的哪个阶段（和 plan.stages[].name 对应，可空） */
	stage: string | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}
export interface WorkRunRow {
	id: string;
	work_item_id: string;
	revision: number;
	owner_agent_id: string;
	exec_kind: string;
	exec_id: string | null;
	status: WorkRunStatus;
	task: string;
	result: string | null;
	blocker: string | null;
	error: string | null;
	/** 交接说明：做了什么、东西在哪、接手的人要注意什么、还有什么没做 */
	handoff: string | null;
	/** 成果文件的 file id（JSON 数组） */
	files: string | null;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
	submitted_at: number | null;
}
interface WorkEventRow {
	id: string;
	work_item_id: string;
	kind: string;
	actor: string;
	revision: number;
	detail: string;
	created_at: number;
}

db.exec(`
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY, scope_kind TEXT NOT NULL DEFAULT 'room', room_id TEXT, conversation_id TEXT,
  title TEXT NOT NULL, requirement TEXT NOT NULL DEFAULT '', done_criteria TEXT NOT NULL DEFAULT '',
  owner_agent_id TEXT, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  latest_progress TEXT NOT NULL DEFAULT '', blocker TEXT, verification TEXT,
  auto_retries INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL, source_message_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
CREATE INDEX IF NOT EXISTS work_items_room ON work_items(room_id, status, updated_at);
CREATE INDEX IF NOT EXISTS work_items_owner ON work_items(owner_agent_id, status);
CREATE TABLE IF NOT EXISTS work_item_runs (
  id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, revision INTEGER NOT NULL, owner_agent_id TEXT NOT NULL,
  exec_kind TEXT NOT NULL DEFAULT 'room_turn', exec_id TEXT, status TEXT NOT NULL DEFAULT 'queued',
  task TEXT NOT NULL DEFAULT '', result TEXT, blocker TEXT, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, submitted_at INTEGER);
CREATE INDEX IF NOT EXISTS work_item_runs_item ON work_item_runs(work_item_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS work_item_runs_exec ON work_item_runs(exec_kind, exec_id) WHERE exec_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS work_item_events (
  id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
  revision INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS work_item_events_item ON work_item_events(work_item_id, created_at);
`);
// 旧库补列：自动重试计数、等用户决定、防护上报、最后进展时间、所属项目、前置任务、所属阶段
for (const [col, ddl] of [
	["auto_retries", "INTEGER NOT NULL DEFAULT 0"],
	["needs_user", "TEXT"],
	["escalation", "TEXT"],
	["last_progress_at", "INTEGER"],
	["project_id", "TEXT"],
	["depends_on", "TEXT NOT NULL DEFAULT '[]'"],
	["stage", "TEXT"],
] as const) {
	if (!(db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[]).some((c) => c.name === col)) db.exec(`ALTER TABLE work_items ADD COLUMN ${col} ${ddl}`);
}
// 旧库补列：交接说明、成果文件
for (const [col, ddl] of [
	["handoff", "TEXT"],
	["files", "TEXT"],
] as const) {
	if (!(db.prepare("PRAGMA table_info(work_item_runs)").all() as { name: string }[]).some((c) => c.name === col)) db.exec(`ALTER TABLE work_item_runs ADD COLUMN ${col} ${ddl}`);
}
/** 退回后连续自动重做几次仍不通过，就算「反复卡在同一处」，停下来请用户决定（不是费用上限）。 */
export const MAX_AUTO_RETRIES = 3;

// ---------------------------------------------------------------- 基础查询

export const itemRow = (id: string) => db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as WorkItemRow | undefined;
export const roomRow = (roomId: string) => db.prepare("SELECT id, name, manager_id, paused FROM rooms WHERE id = ?").get(roomId) as { id: string; name: string; manager_id: string | null; paused: string | null } | undefined;
export const activeMember = (roomId: string, agentId: string) => !!db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND agent_id = ? AND left_at IS NULL AND deleted = 0").get(roomId, agentId);
export const agentName = (id: string | null) => (id ? ((db.prepare("SELECT name FROM agents WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "已删除成员") : "");
export const isManager = (roomId: string, agentId: string) => roomRow(roomId)?.manager_id === agentId;
export const actorKey = (a: WorkActor) => (a.kind === "user" ? "user" : a.agentId);
export const actorName = (a: WorkActor) => (a.kind === "user" ? "用户" : agentName(a.agentId));
export const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);
/** 按名字找成员（精确优先，其次忽略大小写；可带 @）：派活、改派、找同事共用这一份。 */
export function findByName<T extends { name: string }>(members: T[], name: string): T | undefined {
	const want = String(name ?? "").replace(/^[@＠]/, "").trim();
	if (!want) return undefined;
	return members.find((m) => m.name === want) ?? members.find((m) => m.name.toLowerCase() === want.toLowerCase());
}
export const emit = (roomId: string | null) => {
	bus.emit({ type: "work.items", roomId });
	bus.emit({ type: "rooms.changed", roomId });
};
export const safeJson = (s: string | null | undefined): Record<string, unknown> => {
	try {
		const v = JSON.parse(s ?? "");
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};
export const needsUserOf = (row: WorkItemRow) => (row.needs_user ? (safeJson(row.needs_user) as unknown as NeedsUser) : null);
export const escalationOf = (row: WorkItemRow) => (row.escalation ? (safeJson(row.escalation) as unknown as Escalation) : null);

/** 字符串数组字段的通用解析（前置任务编号 / 成果文件 id），坏数据按空数组算。 */
export function parseStringArray(s: string | null | undefined): string[] {
	try {
		const v = JSON.parse(s ?? "[]");
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
	} catch {
		return [];
	}
}
export const parseDepends = parseStringArray;
export const stringifyDepends = (ids: string[]) => JSON.stringify([...new Set(ids)]);

/** 群里的系统提示：关键节点一句话（不是每条工具调用 / 心跳），保证用户不打开看板也知道。 */
export function roomNotice(roomId: string | null, text: string, workItemId: string) {
	if (!roomId) return;
	try {
		// 任务属于哪个项目就带上 projectId（群里同时有几个项目时，界面按项目筛选 / 标项目名）
		const projectId = workItemId ? (db.prepare("SELECT project_id FROM work_items WHERE id = ?").get(workItemId) as { project_id: string | null } | undefined)?.project_id : null;
		insertMessage({ agentId: "", roomId, role: "system", content: text.slice(0, 600), meta: { kind: "work-event", workItemId, ...(projectId ? { projectId } : {}) } });
	} catch {
		/* 群已删：忽略 */
	}
}

export function event(workItemId: string, kind: string, actor: WorkActor, revision: number, detail: Record<string, unknown> = {}) {
	db.prepare("INSERT INTO work_item_events(id, work_item_id, kind, actor, revision, detail, created_at) VALUES(?,?,?,?,?,?,?)").run(uid("we"), workItemId, kind, actorKey(actor), revision, JSON.stringify(detail), now());
}

/** 统一的错误：message 直接给用户看；code 给前端 / 测试判断。 */
export class WorkItemError extends Error {
	code: string;
	constructor(message: string, code = "work_item_error") {
		super(message);
		this.code = code;
	}
}
export function fail(message: string, code?: string): never {
	throw new WorkItemError(message, code);
}

export function requireRoom(roomId: string) {
	const r = roomRow(roomId);
	if (!r) fail("群不存在", "room_not_found");
	return r;
}

/** 管理者 / 用户才能改责任或验收；成员只能提交自己的。 */
export function requireManagerOrUser(item: Pick<WorkItemRow, "room_id">, actor: WorkActor) {
	if (actor.kind === "user") return;
	// 群工具里的 actor 固定带 roomId：同一个管理者在别的群里也不能动这个任务。
	if (actor.roomId && item.room_id !== actor.roomId) fail("这个任务不在当前群，不能在这里改", "not_manager");
	if (!item.room_id || !isManager(item.room_id, actor.agentId)) fail("只有管理者或用户能改这个任务", "not_manager");
}

// ---------------------------------------------------------------- 纯状态判断（可单测）

/** 执行结果要不要算作当前责任：修订 + 负责人 + 状态都要对得上。 */
export function submissionApplies(o: { itemRevision: number; itemOwner: string | null; itemStatus: WorkStatus; runRevision: number; runOwner: string }): boolean {
	return o.itemRevision === o.runRevision && o.itemOwner === o.runOwner && (o.itemStatus === "active" || o.itemStatus === "blocked");
}

/** 状态动作是否合法；不合法就不改任何东西（fail closed）。 */
export function canAct(status: WorkStatus, action: "start" | "continue" | "pause" | "cancel" | "verify" | "submit"): boolean {
	if (action === "verify") return status === "review";
	if (action === "submit") return status === "active" || status === "blocked";
	if (action === "pause" || action === "cancel") return !["done", "cancelled"].includes(status);
	if (action === "start") return status === "pending" || status === "blocked";
	if (action === "continue") return status === "active" || status === "blocked" || status === "paused";
	return false;
}

// ---------------------------------------------------------------- 读

export interface WorkItemSummary {
	id: string;
	roomId: string | null;
	projectId: string | null;
	title: string;
	status: WorkStatus;
	statusLabel: string;
	board: BoardGroup;
	boardLabel: string;
	ownerAgentId: string | null;
	ownerName: string;
	latestProgress: string;
	blocker: string | null;
	needsUser: NeedsUser | null;
	escalation: Escalation | null;
	revision: number;
	autoRetries: number;
	updatedAt: number;
	createdAt: number;
	runState: "none" | "queued" | "running" | "submitted" | "finished" | "failed" | "cancelled" | "interrupted";
	/** 前置任务（依赖自动推进 + 界面显示用） */
	dependsOn: { id: string; title: string; status: WorkStatus; statusLabel: string }[];
	/** 属于方案里的哪个阶段（没写或对不上项目方案就是 null） */
	stage: string | null;
}

export const latestRun = (itemId: string) => db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(itemId) as WorkRunRow | undefined;
/** 执行概览：只读最近一次执行，不把全量执行日志塞进列表。 */
export function runStateOf(r: WorkRunRow | undefined): WorkItemSummary["runState"] {
	if (!r) return "none";
	if (r.status === "queued") return "queued";
	if (r.status === "running") return "running";
	if (r.submitted_at) return "submitted";
	if (r.status === "error") return "failed";
	if (r.status === "cancelled") return "cancelled";
	if (r.status === "interrupted") return "interrupted";
	return "finished";
}

export function summary(row: WorkItemRow): WorkItemSummary {
	const needsUser = needsUserOf(row);
	const escalation = escalationOf(row);
	const board = boardGroupOf({ status: row.status, needsUser: !!needsUser, escalation });
	return {
		id: row.id,
		roomId: row.room_id,
		projectId: row.project_id ?? null,
		title: row.title,
		status: row.status,
		statusLabel: WORK_STATUS_LABEL[row.status] ?? row.status,
		board,
		boardLabel: BOARD_LABEL[board],
		ownerAgentId: row.owner_agent_id,
		ownerName: agentName(row.owner_agent_id),
		latestProgress: row.latest_progress,
		blocker: row.blocker,
		needsUser,
		escalation,
		revision: row.revision,
		autoRetries: row.auto_retries,
		updatedAt: row.updated_at,
		createdAt: row.created_at,
		runState: runStateOf(latestRun(row.id)),
		dependsOn: parseDepends(row.depends_on)
			.map((id) => itemRow(id))
			.filter((d): d is WorkItemRow => !!d)
			.map((d) => ({ id: d.id, title: d.title, status: d.status, statusLabel: WORK_STATUS_LABEL[d.status] ?? d.status })),
		stage: row.stage ?? null,
	};
}

/** 看板分组对应的 SQL 条件（与 guard.boardGroupOf 一致）。 */
const GROUP_WHERE: Record<BoardGroup, string> = {
	decision: "status NOT IN ('done','paused','cancelled') AND needs_user IS NOT NULL",
	stuck: "status NOT IN ('done','paused','cancelled') AND needs_user IS NULL AND (status = 'blocked' OR escalation IS NOT NULL)",
	doing: "status IN ('pending','active','review') AND needs_user IS NULL AND escalation IS NULL",
	done: "status = 'done'",
	stopped: "status IN ('paused','cancelled')",
};

/**
 * 有界列表：默认只返回未完成 + 最近完成的（已完成 / 已停止折叠在 UI 里，接口可分页）。
 * 排序固定为 updated_at DESC, id DESC（id 唯一，避免同一毫秒 updated_at 分页时漏条 / 翻页重复）。
 * 游标：`before` 单独用保持旧行为；`before` + `beforeId` 用 (updated_at, id) 组合游标。
 */
export function listWorkItems(
	roomId: string,
	o: { status?: WorkStatus | "open"; group?: BoardGroup; limit?: number; before?: number; beforeId?: string } = {},
) {
	const limit = Math.min(Math.max(Number(o.limit ?? 100) || 100, 1), 200);
	const where = ["room_id = ?"];
	const args: unknown[] = [roomId];
	if (o.status === "open") where.push("status IN ('pending','active','blocked','review','paused')");
	else if (o.status) {
		where.push("status = ?");
		args.push(o.status);
	}
	if (o.group && GROUP_WHERE[o.group]) where.push(`(${GROUP_WHERE[o.group]})`);
	const beforeId = typeof o.beforeId === "string" && o.beforeId.trim() ? o.beforeId.trim() : null;
	if (o.before && beforeId) {
		where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
		args.push(o.before, o.before, beforeId);
	} else if (o.before) {
		where.push("updated_at < ?");
		args.push(o.before);
	} else if (beforeId) {
		// 只给 id 时按该行的 updated_at 定位，避免客户端漏传 before 就整页重复
		const anchor = itemRow(beforeId);
		if (anchor && anchor.room_id === roomId) {
			where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
			args.push(anchor.updated_at, anchor.updated_at, anchor.id);
		}
	}
	const rows = db.prepare(`SELECT * FROM work_items WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...(args as never[]), limit + 1) as unknown as WorkItemRow[];
	const counts: Record<string, number> = {};
	for (const st of WORK_STATUSES) counts[st] = 0;
	for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM work_items WHERE room_id = ? GROUP BY status").all(roomId) as { status: string; n: number }[]) counts[r.status] = r.n;
	const groups: Record<string, number> = {};
	for (const g of BOARD_GROUPS) groups[g] = (db.prepare(`SELECT COUNT(*) AS n FROM work_items WHERE room_id = ? AND (${GROUP_WHERE[g]})`).get(roomId) as { n: number }).n;
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	return {
		items: page.map(summary),
		counts,
		groups,
		hasMore: rows.length > limit,
		nextBefore: rows.length > limit ? last.updated_at : null,
		nextBeforeId: rows.length > limit ? last.id : null,
	};
}

/** 一个项目下的全部任务摘要（不分页；给项目进度清单用，见 rooms/progress.ts）。 */
export function itemsOfProject(projectId: string): WorkItemSummary[] {
	return (db.prepare("SELECT * FROM work_items WHERE project_id = ? ORDER BY created_at, id").all(projectId) as unknown as WorkItemRow[]).map(summary);
}

export function getWorkItemDetail(id: string) {
	const row = itemRow(id);
	if (!row) fail("任务不存在", "not_found");
	const runs = db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(id) as unknown as WorkRunRow[];
	const events = db.prepare("SELECT * FROM work_item_events WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").all(id) as unknown as WorkEventRow[];
	const filesOf = new Map<string, { fileId: string; name: string }>();
	for (const fid of new Set(runs.flatMap((r) => parseStringArray(r.files)))) {
		const f = getFile(fid);
		if (f) filesOf.set(fid, { fileId: f.id, name: f.name });
	}
	return {
		item: {
			...summary(row),
			requirement: row.requirement,
			doneCriteria: row.done_criteria,
			verification: row.verification ? (JSON.parse(row.verification) as Record<string, unknown>) : null,
			createdBy: row.created_by,
			sourceMessageId: row.source_message_id,
			completedAt: row.completed_at,
		},
		runs: runs.map((r) => ({
			id: r.id,
			revision: r.revision,
			ownerAgentId: r.owner_agent_id,
			ownerName: agentName(r.owner_agent_id),
			execKind: r.exec_kind,
			execId: r.exec_id,
			status: r.status,
			result: r.result,
			blocker: r.blocker,
			error: r.error,
			handoff: r.handoff,
			files: parseStringArray(r.files).map((fid) => filesOf.get(fid)).filter((f): f is { fileId: string; name: string } => !!f),
			createdAt: r.created_at,
			startedAt: r.started_at,
			finishedAt: r.finished_at,
			submittedAt: r.submitted_at,
			stale: r.revision !== row.revision,
		})),
		events: events.map((e) => ({ id: e.id, kind: e.kind, actor: e.actor, actorName: e.actor === "user" ? "用户" : agentName(e.actor), revision: e.revision, detail: safeJson(e.detail), createdAt: e.created_at })),
	};
}

/** 来源消息必须真的在这个群里，才记成可信来源；否则置空，不凭空挂到旧消息上。 */
export function trustedSource(roomId: string, messageId: string | null | undefined): string | null {
	if (!messageId) return null;
	const m = db.prepare("SELECT room_id, role FROM messages WHERE id = ?").get(messageId) as { room_id: string | null; role: string } | undefined;
	return m && m.room_id === roomId && m.role === "user" ? messageId : null;
}

/**
 * 给管理者的看板摘要：被唤醒时只读这一段 + 最近进展，不读全量历史。
 * 等你决定 / 卡住的排在前面；已完成只给数量。projectTitle：按项目编号取项目名（群模块传入），任务后面标上所属项目。
 */
export function boardDigest(roomId: string, max = 20, projectTitle?: (projectId: string) => string | undefined): string {
	const rows = db.prepare("SELECT * FROM work_items WHERE room_id = ? AND status NOT IN ('done','cancelled') ORDER BY updated_at DESC LIMIT ?").all(roomId, max) as unknown as WorkItemRow[];
	const done = (db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE room_id = ? AND status = 'done'").get(roomId) as { n: number }).n;
	const order: BoardGroup[] = ["decision", "stuck", "doing", "stopped"];
	const items = rows.map(summary).sort((a, b) => order.indexOf(a.board) - order.indexOf(b.board));
	if (!items.length) return done ? `任务看板：没有未完成的任务（已完成 ${done} 个）。` : "任务看板：还没有长期任务。";
	return [
		`任务看板（未完成 ${items.length} 个${done ? `，已完成 ${done} 个` : ""}）：`,
		...items.map((x) => `- 【${x.boardLabel}】${x.title}（编号 ${x.id}，${x.statusLabel}，负责人 ${x.ownerName || "未安排"}${x.projectId && projectTitle?.(x.projectId) ? `，项目「${projectTitle(x.projectId)}」` : ""}）${x.needsUser ? `等用户决定：${x.needsUser.question}` : x.escalation ? `上报：${x.escalation.note}` : x.latestProgress || "暂无进度"}`),
	].join("\n");
}
