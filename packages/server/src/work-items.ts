/**
 * 长期任务（任务责任）与单次执行分层：首期在群里贯通。
 *
 * 设计见 docs/design/durable-work-items.md。要点：
 *  - 这里只存“责任”：任务是什么、谁负责、完成标准、业务状态、核验结论、修订号；
 *    真正的执行仍由 rooms 的 room_turns（以及后续可关联的 subagents / tasks）调度，本模块不建 runner、不唤醒模型。
 *  - 业务状态与「当前有没有执行」分开：执行结束最多让任务停在待核验，只有管理者或用户显式核验通过才完成。
 *  - 每次执行都记在一个任务修订（revision）上；改派 / 编辑 / 暂停 / 取消会推进修订，
 *    迟到的结果只能追加历史，不能覆盖最新的任务责任。
 *  - 服务端绑定 actor：成员工具里的 actor 来自会话闭包，HTTP 里用户就是用户；
 *    不接受请求体里的 verifiedBy / actor 自报身份。
 */
import { Type } from "typebox";
import { bus } from "./bus.ts";
import { db, now, uid } from "./db.ts";
import { insertMessage } from "./messages.ts";

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
/** 负责人还能继续接活的终态之外的状态（用于成员移出后的“待改派”）。 */
const OPEN_STATUSES: WorkStatus[] = ["pending", "active", "blocked", "review"];

/**
 * actor 由宿主绑定：group 工具的 actor 必须带上它所在的 roomId，同一个管理者跨两个群时
 * 不能在 A 群的工具里改 B 群的任务；HTTP 用户动作是全局用户，不受 room 限制。
 */
export type WorkActor = { kind: "user" } | { kind: "agent"; agentId: string; roomId?: string };
export type WorkRunStatus = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

interface WorkItemRow {
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
	created_by: string;
	source_message_id: string | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}
interface WorkRunRow {
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
// 旧库补列：自动重试计数（只用于防止退回→自动重跑无限回环）。
if (!(db.prepare("PRAGMA table_info(work_items)").all() as { name: string }[]).some((c) => c.name === "auto_retries")) db.exec("ALTER TABLE work_items ADD COLUMN auto_retries INTEGER NOT NULL DEFAULT 0");
/** 一次退回后最多自动安排的连续重试次数；超过就停下等管理者/用户明确继续。 */
export const MAX_AUTO_RETRIES = 3;
// 已有执行表的关联列：只加列，不动原调度。
for (const [table, col, ddl] of [
	["room_turns", "work_item_id", "TEXT"],
	["room_turns", "work_run_id", "TEXT"],
] as const) {
	const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
	if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
db.exec("CREATE INDEX IF NOT EXISTS room_turns_work ON room_turns(work_item_id)");

// ---------------------------------------------------------------- 基础查询

const itemRow = (id: string) => db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as WorkItemRow | undefined;
const roomRow = (roomId: string) => db.prepare("SELECT id, name, manager_id FROM rooms WHERE id = ?").get(roomId) as { id: string; name: string; manager_id: string | null } | undefined;
const activeMember = (roomId: string, agentId: string) => !!db.prepare("SELECT 1 FROM room_members WHERE room_id = ? AND agent_id = ? AND left_at IS NULL AND deleted = 0").get(roomId, agentId);
const agentName = (id: string | null) => (id ? ((db.prepare("SELECT name FROM agents WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? "已删除成员") : "");
const isManager = (roomId: string, agentId: string) => roomRow(roomId)?.manager_id === agentId;
const actorKey = (a: WorkActor) => (a.kind === "user" ? "user" : a.agentId);
const actorName = (a: WorkActor) => (a.kind === "user" ? "用户" : agentName(a.agentId));
const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);
const emit = (roomId: string | null) => {
	bus.emit({ type: "work.items", roomId });
	bus.emit({ type: "rooms.changed", roomId });
};

/** 群里的系统提示：关键节点一句话（不是每条工具调用 / 心跳），保证用户不打开看板也知道。 */
function roomNotice(roomId: string | null, text: string, workItemId: string) {
	if (!roomId) return;
	try {
		insertMessage({ agentId: "", roomId, role: "system", content: text.slice(0, 600), meta: { kind: "work-event", workItemId } });
	} catch {
		/* 群已删：忽略 */
	}
}

function event(workItemId: string, kind: string, actor: WorkActor, revision: number, detail: Record<string, unknown> = {}) {
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
function fail(message: string, code?: string): never {
	throw new WorkItemError(message, code);
}

function requireRoom(roomId: string) {
	const r = roomRow(roomId);
	if (!r) fail("群不存在", "room_not_found");
	return r;
}

/** 管理者 / 用户才能改责任或验收；成员只能提交自己的。 */
function requireManagerOrUser(item: WorkItemRow, actor: WorkActor) {
	if (actor.kind === "user") return;
	// 群工具里的 actor 固定带 roomId：同一个管理者在别的群里也不能动这个任务。
	if (actor.roomId && item.room_id !== actor.roomId) fail("这个任务不在当前群，不能在这里改", "not_manager");
	if (!item.room_id || !isManager(item.room_id, actor.agentId)) fail("只有管理者或用户能改这个任务", "not_manager");
}

function requireOwner(item: WorkItemRow, actor: WorkActor) {
	if (actor.kind === "user") fail("这是成员提交结果的动作，不能由用户代提交", "owner_only");
	if (item.owner_agent_id !== actor.agentId) fail("只能提交自己负责的任务", "not_owner");
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

// ---------------------------------------------------------------- 读写

export interface WorkItemSummary {
	id: string;
	roomId: string | null;
	title: string;
	status: WorkStatus;
	statusLabel: string;
	ownerAgentId: string | null;
	ownerName: string;
	latestProgress: string;
	blocker: string | null;
	revision: number;
	autoRetries: number;
	updatedAt: number;
	createdAt: number;
	runState: "none" | "queued" | "running" | "submitted" | "finished" | "failed" | "cancelled" | "interrupted";
}

const latestRun = (itemId: string) => db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(itemId) as WorkRunRow | undefined;
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
	return {
		id: row.id,
		roomId: row.room_id,
		title: row.title,
		status: row.status,
		statusLabel: WORK_STATUS_LABEL[row.status] ?? row.status,
		ownerAgentId: row.owner_agent_id,
		ownerName: agentName(row.owner_agent_id),
		latestProgress: row.latest_progress,
		blocker: row.blocker,
		revision: row.revision,
		autoRetries: row.auto_retries,
		updatedAt: row.updated_at,
		createdAt: row.created_at,
		runState: runStateOf(latestRun(row.id)),
	};
}

/** 有界列表：默认只返回未完成 + 最近完成的（已完成 / 已取消折叠在 UI 里，接口可分页）。 */
/**
 * 有界列表：默认只返回未完成 + 最近完成的（已完成 / 已取消折叠在 UI 里，接口可分页）。
 * 排序固定为 updated_at DESC, id DESC（id 唯一，避免同一毫秒 updated_at 分页时漏条 / 翻页重复）。
 * 游标：`before` 单独用保持旧行为；`before` + `beforeId` 用 (updated_at, id) 组合游标。
 */
export function listWorkItems(
	roomId: string,
	o: { status?: WorkStatus | "open"; limit?: number; before?: number; beforeId?: string } = {},
) {
	const limit = Math.min(Math.max(Number(o.limit ?? 100) || 100, 1), 200);
	const where = ["room_id = ?"];
	const args: unknown[] = [roomId];
	if (o.status === "open") where.push("status IN ('pending','active','blocked','review','paused')");
	else if (o.status) {
		where.push("status = ?");
		args.push(o.status);
	}
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
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	return {
		items: page.map(summary),
		counts,
		hasMore: rows.length > limit,
		nextBefore: rows.length > limit ? last.updated_at : null,
		nextBeforeId: rows.length > limit ? last.id : null,
	};
}

export function getWorkItemDetail(id: string) {
	const row = itemRow(id);
	if (!row) fail("任务不存在", "not_found");
	const runs = db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(id) as unknown as WorkRunRow[];
	const events = db.prepare("SELECT * FROM work_item_events WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").all(id) as unknown as WorkEventRow[];
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
			createdAt: r.created_at,
			startedAt: r.started_at,
			finishedAt: r.finished_at,
			submittedAt: r.submitted_at,
			stale: r.revision !== row.revision,
		})),
		events: events.map((e) => ({ id: e.id, kind: e.kind, actor: e.actor, actorName: e.actor === "user" ? "用户" : agentName(e.actor), revision: e.revision, detail: safeJson(e.detail), createdAt: e.created_at })),
	};
}
const safeJson = (s: string): Record<string, unknown> => {
	try {
		const v = JSON.parse(s);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
};

/** 来源消息必须真的在这个群里，才记成可信来源；否则置空，不凭空挂到旧消息上。 */
function trustedSource(roomId: string, messageId: string | null | undefined): string | null {
	if (!messageId) return null;
	const m = db.prepare("SELECT room_id, role FROM messages WHERE id = ?").get(messageId) as { room_id: string | null; role: string } | undefined;
	return m && m.room_id === roomId && m.role === "user" ? messageId : null;
}

export interface CreateWorkItemInput {
	roomId: string;
	title: string;
	requirement?: string;
	doneCriteria?: string;
	ownerAgentId?: string | null;
	/** true（默认）= 创建后马上按负责人开始一次执行；false = 只记责任，等之后再继续。 */
	start?: boolean;
	sourceMessageId?: string | null;
	taskText?: string;
}

export function createWorkItem(input: CreateWorkItemInput, actor: WorkActor) {
	const room = requireRoom(input.roomId);
	requireManagerOrUser({ room_id: room.id } as WorkItemRow, actor);
	const title = clip(input.title, 200);
	if (!title) fail("任务要有名字", "invalid_title");
	const owner = input.ownerAgentId && activeMember(room.id, input.ownerAgentId) ? input.ownerAgentId : null;
	if (input.ownerAgentId && !owner) fail("负责人不是这个群的可用成员", "invalid_owner");
	const t = now();
	const id = uid("wi");
	const requirement = clip(input.requirement, 8000);
	const doneCriteria = clip(input.doneCriteria, 4000);
	// 只有需求 + 完成标准都明确、且负责人存在时才进入进行中；否则先停在待安排，避免拿笼统默认去执行。
	const ready = !!owner && !!requirement && !!doneCriteria;
	const status = ready && input.start !== false ? "active" : "pending";
	db.prepare(
		"INSERT INTO work_items(id, scope_kind, room_id, title, requirement, done_criteria, owner_agent_id, status, revision, latest_progress, created_by, source_message_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(id, "room", room.id, title, requirement, doneCriteria, owner, status, 1, status === "active" ? "进行中" : owner ? "已记录任务，等待补齐信息 / 开始" : "已记录任务，等待安排", actorKey(actor), trustedSource(room.id, input.sourceMessageId), t, t);
	event(id, "created", actor, 1, { title, ownerAgentId: owner });
	const row = itemRow(id)!;
	if (owner && input.start !== false && !ready) {
		db.prepare("UPDATE work_items SET latest_progress = ? WHERE id = ?").run(`信息不全，先别执行：缺${[!row.requirement ? "要做什么" : "", !row.done_criteria ? "完成标准" : ""].filter(Boolean).join("、")}`, id);
		event(id, "needs_clarification", actor, 1, { requirement: !!row.requirement, doneCriteria: !!row.done_criteria });
	}
	if (owner && input.start !== false && ready) {
		const run = createRun(row, owner, { task: clip(input.taskText, 4000) || workPrompt(row) });
		void dispatchRun(row, run).catch((e) => failRun(row, run, e));
	}
	emit(room.id);
	return getWorkItemDetail(id);
}

function workPrompt(item: WorkItemRow) {
	return [
		`【长期任务】${item.title}`,
		item.requirement ? `要求：${item.requirement}` : "",
		item.done_criteria ? `完成标准：${item.done_criteria}` : "",
		`任务编号：${item.id}（提交时用这个编号，不要在回复里自己认定完成）`,
	].filter(Boolean).join("\n");
}

function createRun(item: WorkItemRow, owner: string, o: { task: string; execKind?: string; execId?: string | null }): WorkRunRow {
	const id = uid("wr");
	db.prepare("INSERT INTO work_item_runs(id, work_item_id, revision, owner_agent_id, exec_kind, exec_id, status, task, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(
		id, item.id, item.revision, owner, o.execKind ?? "room_turn", o.execId ?? null, "queued", clip(o.task, 8000), now(),
	);
	return db.prepare("SELECT * FROM work_item_runs WHERE id = ?").get(id) as unknown as WorkRunRow;
}

/** 真正派发由 rooms 负责；这里只调用现成的群调度入口，不新建 runner。
 *  `explicit` 只用于用户明确的新执行授权（HTTP start / continue）：群本轮暂停时也会真的派一次；
 *  管理者自动改要求 / 自动重试则必须尊重群暂停与群预算，不能绕。
 */
async function dispatchRun(item: WorkItemRow, run: WorkRunRow, opts: { explicit?: boolean } = {}) {
	const { enqueueWorkTurn } = await import("./rooms/index.ts");
	const turnId = enqueueWorkTurn(item.room_id!, run.owner_agent_id, run.task, run.id, item.id, opts);
	db.prepare("UPDATE work_item_runs SET exec_id = ?, exec_kind = 'room_turn' WHERE id = ?").run(turnId, run.id);
}
function failRun(item: WorkItemRow, run: WorkRunRow, e: unknown) {
	const msg = e instanceof Error ? e.message : String(e);
	db.prepare("UPDATE work_item_runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(msg.slice(0, 1000), now(), run.id);
	db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, updated_at = ? WHERE id = ? AND revision = ?").run(`无法开始执行：${msg.slice(0, 300)}`, now(), item.id, item.revision);
	event(item.id, "dispatch.failed", { kind: "user" }, item.revision, { error: msg.slice(0, 500) });
}

/**
 * 给 room_assign 的可选 workItemId 用：只登记一条“这一次派活属于这个任务”的执行记录（还没开始跑）。
 * 校验和 start 同一条门：任务在本群、负责人是这位成员且在群里、需求 / 完成标准齐、状态允许派活；
 * 不齐就不建立 run，避免“先建执行后失败”的白跑和 fail-open。
 */
export function queueAssignmentForWorkItem(roomId: string, agentId: string, workItemId: string) {
	const row = itemRow(workItemId);
	if (!row || row.room_id !== roomId) fail("任务不存在或不在这个群", "not_found");
	if (row.owner_agent_id !== agentId) fail("这个任务的负责人不是该成员；先改派再派活", "not_owner");
	if (!["pending", "active", "blocked"].includes(row.status)) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能直接派活`, "bad_status");
	if (!row.requirement || !row.done_criteria) fail("任务还缺要做什么或完成标准，先补齐再派活", "needs_clarification");
	if (!activeMember(roomId, agentId)) fail("负责人不是这个群的可用成员", "invalid_owner");
	if (row.status === "pending") db.prepare("UPDATE work_items SET status = 'active', updated_at = ? WHERE id = ? AND revision = ?").run(now(), row.id, row.revision);
	const pending = db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? AND status IN ('queued','running') ORDER BY created_at LIMIT 1").get(row.id) as WorkRunRow | undefined;
	if (pending) {
		if (pending.revision === row.revision && pending.exec_id === null && pending.status === "queued") return pending;
		fail("这个任务已有执行在进行，不能重复派活", "already_running");
	}
	const retry = !!db.prepare("SELECT 1 FROM work_item_runs WHERE work_item_id = ? LIMIT 1").get(row.id);
	if (retry) {
		if (row.auto_retries >= MAX_AUTO_RETRIES) fail("自动重试已达上限，需用户明确新的执行授权", "retry_limit");
		// 改派/改要求会把blocked变active，也不能借此让room_assign漏记重新执行。
		db.prepare("UPDATE work_items SET auto_retries = auto_retries + 1 WHERE id = ?").run(row.id);
	}
	return createRun(itemRow(row.id)!, agentId, { task: workPrompt(itemRow(row.id)!) });
}

/**
 * 群“继续 / 重启后继续”时决定一条被暂停的派活回合怎么落地（不新建 runner、不绕过上限）。
 * - rebind：原执行确认没开始（run / turn 都没有 started_at，例如到上限时被撤回的排队回合）→
 *   用同一个集中 createRun 给同一任务、同一修订新建一次执行，交给群队列精确绑定；
 *   这不是额外一次自动重试（原来那次已经登记过、只是还没开始），所以不重复计数。
 * - manager_check：旧执行已经开始（结果不明 / 可能已有副作用）→ 不重放旧命令，交管理者 resume 回合检查进度。
 * - skip：任务已取消 / 完成 / 改派 / 修订变了 / 已有新执行 → 不自动复活。
 */
export type PendingWorkTurnPlan =
	| { action: "rebind"; title: string; workItemId: string; workRunId: string; task: string }
	| { action: "manager_check"; title: string; workItemId: string }
	| { action: "skip"; title: string; reason: string };

export function planPendingWorkTurn(o: { roomId: string; workItemId: string; workRunId: string; turnId?: string }): PendingWorkTurnPlan {
	const item = itemRow(o.workItemId);
	const run = db.prepare("SELECT * FROM work_item_runs WHERE id = ? AND work_item_id = ?").get(o.workRunId, o.workItemId) as WorkRunRow | undefined;
	const title = item?.title ?? "任务";
	if (!item || !run || item.room_id !== o.roomId) return { action: "skip", title, reason: "任务或这次执行已经不存在" };
	if (!["active", "blocked"].includes(item.status)) return { action: "skip", title, reason: `任务当前是「${WORK_STATUS_LABEL[item.status]}」，需要用户明确继续` };
	if (!item.owner_agent_id || item.owner_agent_id !== run.owner_agent_id) return { action: "skip", title, reason: "负责人已经变了，按新责任重新安排" };
	if (!activeMember(o.roomId, item.owner_agent_id)) return { action: "skip", title, reason: "负责人已不在群里" };
	if (run.revision !== item.revision) return { action: "skip", title, reason: "任务要求已经更新，旧执行不能直接接着跑" };
	if (db.prepare("SELECT 1 FROM work_item_runs WHERE work_item_id = ? AND id != ? AND status IN ('queued','running') LIMIT 1").get(item.id, run.id)) return { action: "skip", title, reason: "任务已有新的执行在进行" };
	const turn = o.turnId ? (db.prepare("SELECT started_at FROM room_turns WHERE id = ? AND room_id = ? AND work_run_id = ?").get(o.turnId, o.roomId, run.id) as { started_at: number | null } | undefined) : undefined;
	if (o.turnId && !turn) return { action: "skip", title, reason: "旧回合与这次执行无法核实，不能重放" };
	const started = !!run.started_at || !!turn?.started_at || ["running", "done", "error"].includes(run.status);
	if (started) return { action: "manager_check", title, workItemId: item.id };
	if (run.status !== "queued" && run.status !== "cancelled" && run.status !== "interrupted") return { action: "skip", title, reason: "这次执行已经结束" };
	db.prepare("UPDATE work_item_runs SET status = 'cancelled', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status = 'queued'").run(now(), run.id);
	const fresh = createRun(item, item.owner_agent_id, { task: run.task });
	return { action: "rebind", title, workItemId: item.id, workRunId: fresh.id, task: run.task };
}

/**
 * 群调度开始一轮时调用：只用「这一轮自己在 room_turns 里绑定的 run」挂任务，
 * 不再按 agent 找“最老的无 exec_id 排队”，否则普通 @ 会把无关旧任务认领走。
 * 返回要补进提示词的任务块；没有绑定就返回 null（普通 @ / 派活完全不变）。
 */
export function attachTurnToWork(roomId: string, agentId: string, turnId: string): string | null {
	const turn = db.prepare("SELECT id, room_id, work_item_id, work_run_id FROM room_turns WHERE id = ? AND room_id = ?").get(turnId, roomId) as
		| { id: string; room_id: string; work_item_id: string | null; work_run_id: string | null }
		| undefined;
	if (!turn) return null;
	const run = (turn.work_run_id
		? (db.prepare("SELECT * FROM work_item_runs WHERE id = ?").get(turn.work_run_id) as WorkRunRow | undefined)
		: (db.prepare("SELECT * FROM work_item_runs WHERE exec_kind = 'room_turn' AND exec_id = ?").get(turnId) as WorkRunRow | undefined)) ?? undefined;
	if (!run || run.status !== "queued") return null;
	if (turn.work_item_id && turn.work_item_id !== run.work_item_id) return null;
	const item = itemRow(run.work_item_id);
	// scope / owner / revision / 状态都要对得上，否则不挂任务（也不能写 room_turns 的任务关联）。
	if (!item || item.room_id !== roomId || item.owner_agent_id !== agentId) {
		db.prepare("UPDATE work_item_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(now(), run.id);
		return null;
	}
	if (run.revision !== item.revision || !["active", "blocked"].includes(item.status)) {
		db.prepare("UPDATE work_item_runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(now(), run.id);
		event(item.id, "run.stale", { kind: "agent", agentId }, run.revision, { runId: run.id, turnId });
		return null;
	}
	db.prepare("UPDATE work_item_runs SET exec_id = COALESCE(exec_id, ?), status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(turnId, now(), run.id);
	db.prepare("UPDATE room_turns SET work_item_id = ?, work_run_id = ? WHERE id = ? AND room_id = ?").run(run.work_item_id, run.id, turnId, roomId);
	if (item.status === "blocked") db.prepare("UPDATE work_items SET status = 'active', updated_at = ? WHERE id = ? AND revision = ?").run(now(), item.id, item.revision);
	event(item.id, "run.started", { kind: "agent", agentId }, run.revision, { runId: run.id, turnId });
	emit(roomId);
	return `${workPrompt(item)}\n这是第 ${run.revision} 次修订的执行。做完后用 work_submit 提交结果（或报告阻塞）；不要自行把任务标成完成。`;
}

/** 群回合结束（成功 / 失败 / 取消）：只记录执行，绝不自动把任务标成完成或待核验。 */
export function noteRoomTurnEnd(turnId: string, status: "done" | "error" | "cancelled" | "interrupted", text: string, error?: string | null) {
	const run = db.prepare("SELECT * FROM work_item_runs WHERE exec_kind = 'room_turn' AND exec_id = ?").get(turnId) as WorkRunRow | undefined;
	if (!run) return;
	if (["cancelled", "interrupted"].includes(run.status) && status !== "done") return; // 已经由暂停 / 取消 / 重启记录过
	const runStatus: WorkRunStatus = status === "done" ? "done" : status === "error" ? "error" : status;
	const result = clip(text, 20_000);
	db.prepare("UPDATE work_item_runs SET status = ?, result = COALESCE(result, ?), error = ?, finished_at = ? WHERE id = ?").run(runStatus, result || null, error?.slice(0, 1000) ?? null, now(), run.id);
	const item = itemRow(run.work_item_id);
	if (!item) return;
	const current = item.revision === run.revision;
	if (!current) {
		event(item.id, "run.late", { kind: "agent", agentId: run.owner_agent_id }, run.revision, { runId: run.id, status: runStatus });
		return;
	}
	// 执行结束 ≠ 任务完成：最多更新“最近进度”，等负责人提交 / 管理者核验。
	const progress = status === "error" ? `执行出错：${(error ?? "").slice(0, 300)}` : status === "cancelled" ? "执行已取消" : status === "interrupted" ? "执行中断（服务重启），可继续" : `执行结束，等待提交结果${result ? `：${result.slice(0, 200)}` : ""}`;
	if (["active", "blocked"].includes(item.status)) {
		// 执行失败且没有别的执行：明确标成受阻（而不是无执行却永远“进行中”），仍需成员提交或管理者处理。
		const nextStatus: WorkStatus = status === "error" && item.status === "active" ? "blocked" : item.status;
		const blocker = status === "error" ? `执行失败：${(error ?? "").slice(0, 500)}` : status === "interrupted" ? "执行中断（服务重启）" : item.blocker;
		db.prepare("UPDATE work_items SET status = ?, latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(nextStatus, progress, blocker, now(), item.id, item.revision);
	}
	if (status === "error") roomNotice(item.room_id, `任务「${item.title}」这次执行失败了：${(error ?? "").slice(0, 200)}。还在原任务上，可以继续或改派。`, item.id);
	else if (status === "interrupted") roomNotice(item.room_id, `任务「${item.title}」执行中断（服务重启），可继续。`, item.id);
	event(item.id, "run.finished", { kind: "agent", agentId: run.owner_agent_id }, run.revision, { runId: run.id, status: runStatus });
	emit(item.room_id);
}

/** 本轮正在执行的群回合里绑定着的那个 run（宿主上下文，不信模型自报 runId）。 */
function currentTurnWorkRun(roomId: string, agentId: string): { turnId: string; run: WorkRunRow } | null {
	const turn = db.prepare("SELECT id, work_item_id, work_run_id FROM room_turns WHERE room_id = ? AND agent_id = ? AND status = 'running' ORDER BY started_at DESC, rowid DESC LIMIT 1").get(roomId, agentId) as
		| { id: string; work_item_id: string | null; work_run_id: string | null }
		| undefined;
	if (!turn?.work_run_id) return null;
	const run = db.prepare("SELECT * FROM work_item_runs WHERE id = ?").get(turn.work_run_id) as WorkRunRow | undefined;
	if (!run || run.work_item_id !== turn.work_item_id) return null;
	return { turnId: turn.id, run };
}

/** 成员提交：只认自己、只认本轮真实执行的 run、只认当前修订；晚到的提交只留历史。 */
export function submitWorkItem(o: { roomId: string; workItemId?: string; actor: WorkActor; result?: string; blocker?: string; runId?: string }) {
	const actor = o.actor;
	if (actor.kind === "user") fail("成员提交结果不能由用户代提交", "owner_only");
	// 提交必须有真实执行上下文：这一轮必须真的绑着本任务的 run，不能凭 workItemId 交别的回合 / 其他修订。
	const ctx = currentTurnWorkRun(o.roomId, actor.agentId);
	if (!ctx) fail("当前这轮不是任务执行，不能提交（需要在本任务的派活回合里用 work_submit）", "no_run_context");
	const run = ctx.run;
	if (o.runId && o.runId !== run.id) fail("提交只能绑定本轮真实执行，不能指定其他 run", "bad_run");
	if (run.owner_agent_id !== actor.agentId) fail("只能提交自己负责的任务", "not_owner");
	let row: WorkItemRow | undefined = o.workItemId ? itemRow(o.workItemId) : itemRow(run.work_item_id);
	if (!row || row.room_id !== o.roomId) fail("没有可提交的任务", "not_found");
	if (row.id !== run.work_item_id) fail("这一轮执行的是另一个任务，不能改交其他任务", "not_owner");
	const result = clip(o.result, 20_000);
	const blocker = clip(o.blocker, 2000);
	if (!result && !blocker) fail("提交要写结果或阻塞原因", "empty_submit");
	// 负责人已经不是这个人：如果确实是他自己这一轮的执行，就把结果作为历史保留（不覆盖最新责任）。
	if (row.owner_agent_id !== actor.agentId) {
		event(row.id, "submit.late", actor, row.revision, { result: result.slice(0, 500), blocker: blocker.slice(0, 500), runId: run.id });
		emit(row.room_id);
		return { applied: false as const, item: getWorkItemDetail(row.id) };
	}
	// 晚到的结果：修订或负责人已经变了 → 只记历史
	if (!submissionApplies({ itemRevision: row.revision, itemOwner: row.owner_agent_id, itemStatus: row.status, runRevision: run.revision, runOwner: run.owner_agent_id })) {
		event(row.id, "submit.late", actor, row.revision, { result: result.slice(0, 500), blocker: blocker.slice(0, 500), runId: run.id });
		emit(row.room_id);
		return { applied: false as const, item: getWorkItemDetail(row.id) };
	}
	const t = now();
	db.prepare("UPDATE work_items SET status = ?, latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(
		blocker ? "blocked" : "review", blocker ? `受阻：${blocker}` : `已提交，等待核验：${result.slice(0, 300)}`, blocker || null, t, row.id, row.revision,
	);
	db.prepare("UPDATE work_item_runs SET status = COALESCE(NULLIF(status, 'queued'), 'running'), result = ?, blocker = ?, submitted_at = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?").run(result || null, blocker || null, t, t, run.id);
	// 群里留一张结果卡：用户可以引用这张卡指出问题，服务端据此可信定位到同一个任务。
	insertMessage({
		agentId: actor.agentId,
		roomId: row.room_id,
		role: "card",
		meta: { kind: "work-result", workItemId: row.id, roomId: row.room_id, runId: run.id, title: row.title, ownerAgentId: actor.agentId, status: blocker ? "blocked" : "review", summary: (blocker || result).slice(0, 1000), revision: row.revision },
	});
	event(row.id, blocker ? "submitted.blocked" : "submitted", actor, row.revision, { runId: run.id, result: result.slice(0, 1000), blocker: blocker.slice(0, 500) });
	if (blocker) roomNotice(row.room_id, `任务「${row.title}」被 ${agentName(actor.agentId)} 标为受阻：${blocker.slice(0, 200)}。原任务保持，等管理者处理。`, row.id);
	emit(row.room_id);
	return { applied: true as const, item: getWorkItemDetail(row.id) };
}

/** 核验：只有管理者 / 用户；必须有检查结论；通过才算完成，退回则开一个新修订继续。 */
export async function verifyWorkItem(o: { workItemId: string; actor: WorkActor; verdict: "pass" | "return"; note: string }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!canAct(row.status, "verify")) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，还不能核验`, "bad_status");
	const note = clip(o.note, 4000);
	if (!note) fail("核验要写检查结论（看到了什么、为什么通过或退回）", "needs_conclusion");
	if (o.verdict !== "pass" && o.verdict !== "return") fail("核验结论只会是通过或退回", "bad_verdict");
	const t = now();
	if (o.verdict === "pass") {
		const verification = JSON.stringify({ verdict: "pass", note, by: actorKey(o.actor), byName: actorName(o.actor), at: t, revision: row.revision });
		db.prepare("UPDATE work_items SET status = 'done', latest_progress = ?, blocker = NULL, verification = ?, completed_at = ?, auto_retries = 0, updated_at = ? WHERE id = ? AND revision = ?").run(`已核验完成：${note.slice(0, 300)}`, verification, t, t, row.id, row.revision);
		event(row.id, "verified.pass", o.actor, row.revision, { note: note.slice(0, 2000) });
		roomNotice(row.room_id, `任务「${row.title}」核验通过：${note.slice(0, 300)}`, row.id);
	} else {
		const revision = row.revision + 1;
		db.prepare("UPDATE work_items SET status = 'active', revision = ?, latest_progress = ?, blocker = NULL, updated_at = ? WHERE id = ? AND revision = ?").run(revision, `已退回修改：${note.slice(0, 300)}`, t, row.id, row.revision);
		event(row.id, "verified.return", o.actor, revision, { note: note.slice(0, 2000), fromRevision: row.revision });
		roomNotice(row.room_id, `任务「${row.title}」退回修改：${note.slice(0, 300)}`, row.id);
		// 退回本身就是明确的改进要求 + 原授权仍有效：直接安排原任务下一次执行，不用用户再催「继续」。
		// 但尊重暂停 / 取消 / 群本轮暂停 / 权限：只在这些都不阻断时自动跑，并限制连续自动重试次数。
		const fresh = itemRow(row.id)!;
		const room = fresh.room_id ? roomRow(fresh.room_id) : undefined;
		const roomPaused = room ? !!(db.prepare("SELECT paused FROM rooms WHERE id = ?").get(room.id) as { paused: string | null } | undefined)?.paused : true;
		const ownerOk = !!fresh.owner_agent_id && !!fresh.room_id && activeMember(fresh.room_id, fresh.owner_agent_id);
		if (!ownerOk) {
			db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run("退回后负责人已不在群里，待改派", "负责人不可用", now(), fresh.id, fresh.revision);
			roomNotice(fresh.room_id, `任务「${fresh.title}」退回后负责人不在群里，已标为待改派。`, fresh.id);
		} else if (roomPaused) {
			db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run("已退回修改；群本轮已暂停，等继续后再安排执行", "群本轮已暂停", now(), fresh.id, fresh.revision);
			roomNotice(fresh.room_id, `任务「${fresh.title}」已退回修改；群里本轮已暂停，点继续后才会重新安排。`, fresh.id);
		} else if (fresh.auto_retries >= MAX_AUTO_RETRIES) {
			db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(`已自动重试 ${MAX_AUTO_RETRIES} 次仍在退回，先停下等确认`, "自动重试已达上限", now(), fresh.id, fresh.revision);
			roomNotice(fresh.room_id, `任务「${fresh.title}」连续自动重试 ${MAX_AUTO_RETRIES} 次仍未通过，已停下等管理者 / 用户确认下一步。`, fresh.id);
		} else {
			db.prepare("UPDATE work_items SET auto_retries = auto_retries + 1, updated_at = ? WHERE id = ? AND revision = ?").run(now(), fresh.id, fresh.revision);
			event(fresh.id, "auto_retry", o.actor, fresh.revision, { retry: fresh.auto_retries + 1 });
			const run = createRun(fresh, fresh.owner_agent_id!, { task: workPrompt(fresh) });
			emit(fresh.room_id);
			try {
				await dispatchRun(fresh, run);
			} catch (e) {
				failRun(fresh, run, e);
			}
		}
	}
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}

export function editWorkItem(o: { workItemId: string; actor: WorkActor; title?: string; requirement?: string; doneCriteria?: string; ownerAgentId?: string | null }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (row.status === "cancelled" || row.status === "done") fail("已完成或已取消的任务不能再改；需要新工作请新建任务", "bad_status");
	const fields: string[] = [];
	const args: unknown[] = [];
	let revision = row.revision;
	let owner = row.owner_agent_id;
	let status = row.status;
	if (o.title !== undefined) {
		const v = clip(o.title, 200);
		if (!v) fail("任务名字不能为空", "invalid_title");
		fields.push("title = ?");
		args.push(v);
	}
	let contentChanged = false;
	if (o.requirement !== undefined && clip(o.requirement, 8000) !== row.requirement) (fields.push("requirement = ?"), args.push(clip(o.requirement, 8000)), (contentChanged = true));
	if (o.doneCriteria !== undefined && clip(o.doneCriteria, 4000) !== row.done_criteria) (fields.push("done_criteria = ?"), args.push(clip(o.doneCriteria, 4000)), (contentChanged = true));
	if (contentChanged && row.revision === revision) {
		// 新要求 = 新修订：旧的执行结果只能作为历史，不能拿来给新要求判完成。
		// 注意：自动重试计数不能在这里清 0，否则管理者“edit → return”就能无限重跑绕过上限；
		// 只有用户明确的新执行授权（HTTP start / continue）或核验通过才重置。
		revision++;
		fields.push("revision = ?", "latest_progress = ?");
		args.push(revision, "要求已更新，等待按新要求执行");
	}
	if (o.ownerAgentId !== undefined && o.ownerAgentId !== owner) {
		if (o.ownerAgentId && !activeMember(row.room_id!, o.ownerAgentId)) fail("新负责人不是这个群的可用成员", "invalid_owner");
		owner = o.ownerAgentId;
		revision++;
		status = owner ? (row.status === "pending" ? "pending" : "active") : "pending";
		fields.push("owner_agent_id = ?", "revision = ?", "status = ?", "latest_progress = ?", "blocker = NULL");
		args.push(owner, revision, status, owner ? `已改派给 ${agentName(owner)}，等待新的执行` : "已取消负责人，等待重新安排");
	}
	if (fields.length === 0) return getWorkItemDetail(row.id);
	fields.push("updated_at = ?");
	args.push(now(), row.id);
	db.prepare(`UPDATE work_items SET ${fields.join(", ")} WHERE id = ?`).run(...(args as never[]));
	event(row.id, owner !== row.owner_agent_id ? "reassigned" : "edited", o.actor, revision, { ownerAgentId: owner, fromRevision: row.revision });
	if (revision !== row.revision) void cancelWorkRuns(row.id, { abortCurrent: false });
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}

/** 重开：已完成 / 已取消的任务在用户明确要求修改时恢复为原任务（保留原验收历史，不新建副本）。 */
export function reopenWorkItem(o: { workItemId: string; actor: WorkActor; note?: string }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!["done", "cancelled"].includes(row.status)) fail("只有已完成或已取消的任务需要重开", "bad_status");
	if (!row.owner_agent_id || !activeMember(row.room_id!, row.owner_agent_id)) fail("原负责人已不在群里，请先改派再重开", "owner_left");
	const revision = row.revision + 1;
	const note = clip(o.note, 1000);
	db.prepare("UPDATE work_items SET status = 'active', revision = ?, latest_progress = ?, blocker = NULL, verification = NULL, completed_at = NULL, auto_retries = 0, updated_at = ? WHERE id = ? AND revision = ?").run(
		revision, note ? `已重开：${note}` : "已重开，等待按新要求执行", now(), row.id, row.revision,
	);
	event(row.id, "reopened", o.actor, revision, { from: row.status, note });
	roomNotice(row.room_id, `任务「${row.title}」已重开，接着在原任务上修改。`, row.id);
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}

// ---------------------------------------------------------------- 开始 / 继续 / 暂停 / 取消

export async function startWorkItem(o: { workItemId: string; actor: WorkActor }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!canAct(row.status, "start")) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能开始`, "bad_status");
	if (o.actor.kind === "agent" && row.auto_retries >= MAX_AUTO_RETRIES) fail("自动重试已达上限，需用户明确新的执行授权", "retry_limit");
	if (!row.owner_agent_id) fail("先指定负责人再开始", "no_owner");
	if (!row.requirement || !row.done_criteria) fail("先补清要做什么和完成标准再开始；不要把笼统默认当成用户已确认的标准", "needs_clarification");
	if (!activeMember(row.room_id!, row.owner_agent_id)) fail("负责人已不在群里，请先改派", "owner_left");
	const revision = row.revision + 1;
	const t = now();
	// 只有用户明确的新执行授权才清自动重试计数；管理者工具调用不能借此绕过上限。
	const resetRetries = o.actor.kind === "user" ? 1 : 0;
	db.prepare("UPDATE work_items SET status = 'active', revision = ?, latest_progress = '进行中', blocker = NULL, auto_retries = CASE WHEN ? THEN 0 ELSE auto_retries END, updated_at = ? WHERE id = ? AND revision = ?").run(revision, resetRetries, t, row.id, row.revision);
	event(row.id, "started", o.actor, revision);
	const cur = itemRow(row.id)!;
	const run = createRun(cur, cur.owner_agent_id!, { task: workPrompt(cur) });
	emit(row.room_id);
	try {
		await dispatchRun(cur, run, { explicit: o.actor.kind === "user" });
	} catch (e) {
		failRun(cur, run, e);
		emit(row.room_id);
		throw e instanceof WorkItemError ? e : new WorkItemError(e instanceof Error ? e.message : String(e), "dispatch_failed");
	}
	return getWorkItemDetail(row.id);
}

/** 继续：暂停 / 受阻 / 已退回后重开一次执行；没有负责人就退回待安排。 */
export async function continueWorkItem(o: { workItemId: string; actor: WorkActor }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!["active", "blocked", "paused"].includes(row.status)) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能继续`, "bad_status");
	if (o.actor.kind === "agent" && row.auto_retries >= MAX_AUTO_RETRIES) fail("自动重试已达上限，需用户明确新的执行授权", "retry_limit");
	const live = db.prepare("SELECT 1 FROM work_item_runs WHERE work_item_id = ? AND status IN ('queued','running') LIMIT 1").get(row.id);
	if (live) fail("这个任务已经有执行在进行，等它结束或先暂停", "already_running");
	if (!row.owner_agent_id || !row.requirement || !row.done_criteria) {
		const missing = [!row.owner_agent_id ? "负责人" : "", !row.requirement ? "要做什么" : "", !row.done_criteria ? "完成标准" : ""].filter(Boolean).join("、");
		db.prepare("UPDATE work_items SET status = 'pending', revision = revision + 1, latest_progress = ?, updated_at = ? WHERE id = ?").run(`等待补齐：${missing}`, now(), row.id);
		event(row.id, "needs_clarification", o.actor, row.revision + 1, { missing });
		emit(row.room_id);
		fail(`还缺${missing}，先补清再继续；不要用笼统默认代替用户确认的标准`, "needs_clarification");
	}
	if (!activeMember(row.room_id!, row.owner_agent_id)) {
		db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = '负责人已不在群里，待改派', updated_at = ? WHERE id = ?").run(now(), row.id);
		emit(row.room_id);
		fail("负责人已不在群里，请先改派", "owner_left");
	}
	const revision = row.revision + 1;
	const t = now();
	// 用户明确继续可重新授权；管理者每次自动再派都占同一计数，不能改用continue绕过退回上限。
	const resetRetries = o.actor.kind === "user" ? 1 : 0;
	db.prepare("UPDATE work_items SET status = 'active', revision = ?, latest_progress = '进行中', blocker = NULL, auto_retries = CASE WHEN ? THEN 0 ELSE auto_retries + 1 END, updated_at = ? WHERE id = ? AND revision = ?").run(revision, resetRetries, t, row.id, row.revision);
	event(row.id, "continued", o.actor, revision);
	const cur = itemRow(row.id)!;
	const run = createRun(cur, cur.owner_agent_id!, { task: workPrompt(cur) });
	emit(row.room_id);
	try {
		await dispatchRun(cur, run, { explicit: o.actor.kind === "user" });
	} catch (e) {
		failRun(cur, run, e);
		emit(row.room_id);
		throw e instanceof WorkItemError ? e : new WorkItemError(e instanceof Error ? e.message : String(e), "dispatch_failed");
	}
	return getWorkItemDetail(row.id);
}

/** 取消本任务关联的排队 / 运行中执行；不误停别的群、主会话或其他成员。 */
async function cancelWorkRuns(itemId: string, o: { abortCurrent: boolean }) {
	const item = itemRow(itemId);
	const roomId = item?.room_id ?? null;
	const runs = db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? AND status IN ('queued','running')").all(itemId) as unknown as WorkRunRow[];
	if (!runs.length) return;
	// 先把业务执行记录落成 cancelled（同步），再做群回合取消 / 中止（异步）；调用方即使不 await 也不会留下假“运行中”。
	for (const run of runs) db.prepare("UPDATE work_item_runs SET status = 'cancelled', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status IN ('queued','running')").run(now(), run.id);
	if (!roomId) return; // 没有群的任务不可能有群回合
	const { cancelWorkTurn } = await import("./rooms/index.ts");
	for (const run of runs) {
		const turnId = run.exec_id ?? (db.prepare("SELECT id FROM room_turns WHERE work_run_id = ? AND room_id = ? AND status IN ('queued','running') ORDER BY created_at LIMIT 1").get(run.id, roomId) as { id: string } | undefined)?.id;
		if (run.exec_kind === "room_turn" && turnId) await cancelWorkTurn(roomId, turnId, o.abortCurrent);
	}
}

/**
 * 群队列取消 / 用户停止 / 重启：同步关联的执行记录。
 * 否则内存队列已经撤回了回合，但 work_item_runs 还停在 queued，看板一直显示排队中，continue 还会被“已有执行”挡住。
 */
export function onRoomTurnsClosed(turnIds: string[], status: "cancelled" | "interrupted") {
	if (!turnIds.length) return 0;
	let n = 0;
	const t = now();
	for (const turnId of turnIds) {
		const turn = db.prepare("SELECT id, room_id, work_item_id, work_run_id FROM room_turns WHERE id = ?").get(turnId) as
			| { id: string; room_id: string; work_item_id: string | null; work_run_id: string | null }
			| undefined;
		if (!turn) continue;
		const run = (turn.work_run_id
			? (db.prepare("SELECT * FROM work_item_runs WHERE id = ?").get(turn.work_run_id) as WorkRunRow | undefined)
			: (db.prepare("SELECT * FROM work_item_runs WHERE exec_kind = 'room_turn' AND exec_id = ?").get(turnId) as WorkRunRow | undefined)) ?? undefined;
		if (!run) continue;
		const res = db.prepare("UPDATE work_item_runs SET status = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status IN ('queued','running')").run(status, t, run.id);
		if (!res.changes) continue;
		const item = itemRow(run.work_item_id);
		if (!item) continue;
		const progress = status === "interrupted" ? "执行中断（服务重启），可继续" : "执行已取消";
		if (item.revision === run.revision && ["active", "blocked"].includes(item.status)) db.prepare("UPDATE work_items SET latest_progress = ?, updated_at = ? WHERE id = ? AND revision = ?").run(progress, t, item.id, item.revision);
		event(item.id, status === "interrupted" ? "run.interrupted" : "run.cancelled", { kind: "user" }, run.revision, { runId: run.id, turnId });
		emit(item.room_id);
		n++;
	}
	return n;
}

/**
 * 用户停止整个群：把本群正在负责（进行中 / 受阻）的任务标成 paused，并推进修订。
 * 这样“新一轮无关话题 / 自动重试 / 管理者顺手 continue”都不能把停止前的工作自动复活；
 * 只有用户明确的继续（看板 / 群内明确说继续）才会重新安排。只动本群任务，不碰别的群。
 */
export function pauseRoomWorkOnStop(roomId: string) {
	const rows = db.prepare("SELECT * FROM work_items WHERE room_id = ? AND status IN ('active','blocked')").all(roomId) as unknown as WorkItemRow[];
	const t = now();
	for (const row of rows) {
		db.prepare("UPDATE work_items SET status = 'paused', revision = ?, latest_progress = ?, updated_at = ? WHERE id = ? AND revision = ?").run(row.revision + 1, "群聊已停止，等用户明确继续", t, row.id, row.revision);
		event(row.id, "room.stopped", { kind: "user" }, row.revision + 1);
	}
	if (rows.length) emit(roomId);
	return rows.length;
}

export async function pauseWorkItem(o: { workItemId: string; actor: WorkActor }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!canAct(row.status, "pause")) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能暂停`, "bad_status");
	const revision = row.revision + 1;
	db.prepare("UPDATE work_items SET status = 'paused', revision = ?, latest_progress = '已暂停，等待继续', updated_at = ? WHERE id = ? AND revision = ?").run(revision, now(), row.id, row.revision);
	event(row.id, "paused", o.actor, revision);
	roomNotice(row.room_id, `任务「${row.title}」已暂停。`, row.id);
	await cancelWorkRuns(row.id, { abortCurrent: true });
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}

export async function cancelWorkItem(o: { workItemId: string; actor: WorkActor }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!canAct(row.status, "cancel")) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能取消`, "bad_status");
	const revision = row.revision + 1;
	db.prepare("UPDATE work_items SET status = 'cancelled', revision = ?, latest_progress = '已取消', updated_at = ? WHERE id = ? AND revision = ?").run(revision, now(), row.id, row.revision);
	event(row.id, "cancelled", o.actor, revision);
	roomNotice(row.room_id, `任务「${row.title}」已取消。`, row.id);
	await cancelWorkRuns(row.id, { abortCurrent: true });
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}

// ---------------------------------------------------------------- 与群生命周期 / 重启的衔接

/** 移出成员：标受阻待改派，不自动转给管理者，也不继续调度。 */
export function onRoomMemberRemoved(roomId: string, agentId: string) {
	const rows = db.prepare("SELECT * FROM work_items WHERE room_id = ? AND owner_agent_id = ? AND status IN ('pending','active','blocked','review')").all(roomId, agentId) as unknown as WorkItemRow[];
	for (const row of rows) {
		db.prepare("UPDATE work_items SET status = 'blocked', revision = revision + 1, latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(
			`负责人 ${agentName(agentId)} 已移出群聊，待改派`, "负责人已移出群聊", now(), row.id, row.revision,
		);
		event(row.id, "owner.left", { kind: "user" }, row.revision + 1, { agentId });
		cancelWorkRuns(row.id, { abortCurrent: true }).catch(() => {});
	}
	if (rows.length) emit(roomId);
}

/** 删群：按原删除语义清掉本群的任务与关联（执行行由 rooms 自己删）。 */
export function deleteRoomWorkItems(roomId: string) {
	const ids = (db.prepare("SELECT id FROM work_items WHERE room_id = ?").all(roomId) as { id: string }[]).map((r) => r.id);
	for (const id of ids) {
		db.prepare("DELETE FROM work_item_events WHERE work_item_id = ?").run(id);
		db.prepare("DELETE FROM work_item_runs WHERE work_item_id = ?").run(id);
	}
	db.prepare("DELETE FROM work_items WHERE room_id = ?").run(roomId);
}

/**
 * 重启：把“发出去了但不知道结果”的执行标成中断，任务状态保持原样（不自动完成、不自动重派）。
 * 用户点继续时才新建一次执行。
 */
export function bootstrapWorkItems() {
	const rows = db.prepare("SELECT * FROM work_item_runs WHERE status IN ('queued','running')").all() as unknown as WorkRunRow[];
	let n = 0;
	for (const run of rows) {
		db.prepare("UPDATE work_item_runs SET status = 'interrupted', finished_at = ? WHERE id = ? AND status IN ('queued','running')").run(now(), run.id);
		const item = itemRow(run.work_item_id);
		if (!item) continue;
		if (item.revision === run.revision && ["active", "blocked"].includes(item.status)) db.prepare("UPDATE work_items SET latest_progress = '执行中断（服务重启），可继续', updated_at = ? WHERE id = ? AND revision = ?").run(now(), item.id, item.revision);
		event(item.id, "run.interrupted", { kind: "user" }, run.revision, { runId: run.id });
		n++;
	}
	return n;
}

// ---------------------------------------------------------------- 群里自然语言纠正：任务识别 / 澄清 / 权限

export type WorkIntent = { correction: boolean; reopen: boolean; continue: boolean };
const CORRECTION_WORDS = /改(一下|成|为|改)?|修改|调整|补充|完善|修正|不对|有问题|错误|不符合|缺(少|了)?|漏了|退回|重做|重来|再改|不是这样|不满足|没达到/;
const REOPEN_WORDS = /重开|重新做|再做|再改|改成|改为|改到|改一下|修改|调整|补充|修正|退回|重做|重来|更新要求|接着改/;
const CONTINUE_WORDS = /继续|接着|再跑|重新开始|重开|恢复|再来一次/;
export function detectWorkIntent(text: string): WorkIntent {
	const t = String(text ?? "");
	return { correction: CORRECTION_WORDS.test(t), reopen: REOPEN_WORDS.test(t), continue: CONTINUE_WORDS.test(t) };
}

export interface WorkReference {
	matches: { id: string; title: string; status: WorkStatus; statusLabel: string; ownerName: string }[];
	ambiguous: boolean;
	byQuote: boolean;
}

/** 只读有界：编号 / 任务名 / 引用的结果卡三种可信指代；不猜、不检索旧消息。 */
export function resolveWorkReferences(roomId: string, text: string, quoteMessageId?: string | null, ownWorkItemId?: string | null): WorkReference {
	const found = new Map<string, WorkItemRow>();
	// 看板反馈入口由服务端写入的 workItemId（用户消息自己的 meta），可信且优先；
	// 客户端提交群消息时不能自带这个字段（postUserMessage 只接受服务端传入）。
	if (ownWorkItemId) {
		const row = itemRow(ownWorkItemId);
		if (row && row.room_id === roomId) found.set(row.id, row);
	}
	const ids = new Set([...String(text ?? "").matchAll(/\bwi_[a-z0-9]+\b/gi)].map((m) => m[0]));
	for (const id of ids) {
		const row = itemRow(id);
		if (row && row.room_id === roomId) found.set(row.id, row);
	}
	if (quoteMessageId) {
		const m = db.prepare("SELECT room_id, meta FROM messages WHERE id = ?").get(quoteMessageId) as { room_id: string | null; meta: string } | undefined;
		if (m && m.room_id === roomId) {
			const meta = safeJson(m.meta);
			if (meta.kind === "work-result" && typeof meta.workItemId === "string") {
				const row = itemRow(meta.workItemId);
				if (row && row.room_id === roomId) found.set(row.id, row);
			}
		}
	}
	const body = String(text ?? "");
	if (body.trim().length >= 2) {
		for (const row of db.prepare("SELECT * FROM work_items WHERE room_id = ? ORDER BY updated_at DESC LIMIT 200").all(roomId) as unknown as WorkItemRow[]) {
			if (row.title.length >= 2 && body.includes(row.title)) found.set(row.id, row);
		}
	}
	const matches = [...found.values()].map((row) => ({ id: row.id, title: row.title, status: row.status, statusLabel: WORK_STATUS_LABEL[row.status], ownerName: agentName(row.owner_agent_id) }));
	return { matches, ambiguous: matches.length > 1, byQuote: !!quoteMessageId };
}

/** 本轮（这一条用户消息）允许的任务动作：新消息自动作废旧许可，避免暂停 / 已取消被任意消息复活。 */
interface RoundAllow { messageId: string; feedback: Set<string>; allowContinue: Set<string>; allowReopen: Set<string> }
const roundAllow = new Map<string, RoundAllow>();
function roundAllows(roomId: string, itemId: string, kind: "continue" | "reopen") {
	const messageId = sourceProvider?.(roomId) ?? null;
	const a = roundAllow.get(roomId);
	if (!a || !messageId || a.messageId !== messageId) return false;
	return (kind === "continue" ? a.allowContinue : a.allowReopen).has(itemId);
}

/**
 * 给管理者准备一条“关于长期任务”的上下文，并登记本轮许可。
 * 多个匹配时只给候选、要求先问一个澄清问题；状态不同许可不同（暂停只允许明确继续，完成/取消只允许明确重开）。
 */
export function buildWorkCorrectionContext(roomId: string, ref: WorkReference, text: string, messageId: string): string | null {
	if (!ref.matches.length) return null;
	const intent = detectWorkIntent(text);
	const allow: RoundAllow = { messageId, feedback: new Set(), allowContinue: new Set(), allowReopen: new Set() };
	if (ref.ambiguous) {
		roundAllow.set(roomId, allow);
		return [
			"【关于长期任务】用户这条消息可能指到多个任务，系统没有替你猜：",
			...ref.matches.slice(0, 6).map((m) => `- 「${m.title}」（编号 ${m.id}，${m.statusLabel}，负责人 ${m.ownerName}）`),
			"先只问一个必要的澄清问题（哪一项任务），不要修改任何任务、不要派活。",
		].join("\n");
	}
	const m = ref.matches[0];
	const row = itemRow(m.id)!;
	allow.feedback.add(m.id);
	if (intent.continue) allow.allowContinue.add(m.id);
	if (intent.reopen) allow.allowReopen.add(m.id);
	roundAllow.set(roomId, allow);
	if (row.status === "done" || row.status === "cancelled") {
		if (intent.reopen) {
			return [
				`【关于长期任务】「${row.title}」（编号 ${row.id}，当前${WORK_STATUS_LABEL[row.status]}，负责人 ${agentName(row.owner_agent_id)}）`,
				"用户明确要求在这个任务上继续修改。步骤：用 work_update action=reopen 恢复原任务（保留原验收历史），再用 work_update action=edit 把用户这次的具体新要求写进 requirement / doneCriteria，然后用 work_update action=continue 安排原负责人下一次执行。不要新建副本，也不要直接标完成。",
				"原完成标准：",
				row.done_criteria || "（没有写）",
			].join("\n");
		}
		return [
			`【关于长期任务】「${row.title}」（编号 ${row.id}，当前${WORK_STATUS_LABEL[row.status]}，负责人 ${agentName(row.owner_agent_id)}）`,
			"用户提到了这个任务，但没有明确说要重开 / 再改。只回答或询问，不要改状态、不要重新派活。",
		].join("\n");
	}
	if (row.status === "paused") {
		if (intent.continue) {
			return [
				`【关于长期任务】「${row.title}」（编号 ${row.id}，当前已暂停，负责人 ${agentName(row.owner_agent_id)}）`,
				"用户明确说继续。如还有具体修改要求，先用 work_update action=edit 写进 requirement / doneCriteria，再用 work_update action=continue 安排原任务下一次执行；不要标完成。",
			].join("\n");
		}
		return `【关于长期任务】「${row.title}」（编号 ${row.id}，当前已暂停）。用户没有明确说继续，不要自动恢复执行；回答或询问即可。`;
	}
	if (!intent.correction) {
		return [
			`【关于长期任务】「${row.title}」（编号 ${row.id}，当前${WORK_STATUS_LABEL[row.status]}，负责人 ${agentName(row.owner_agent_id)}，第 ${row.revision} 次修订）`,
			"用户提到了这个任务。如果只是问进展，就回答；用户没有提出具体问题时不要改要求、不要重新派活、不要验收。",
			`最近进度：${row.latest_progress || "暂无"}`,
		].join("\n");
	}
	return [
		`【关于长期任务】「${row.title}」（编号 ${row.id}，当前${WORK_STATUS_LABEL[row.status]}，负责人 ${agentName(row.owner_agent_id)}，第 ${row.revision} 次修订）`,
		"用户是在对这项任务提反馈 / 纠正。把所有改动都放在这同一个任务上（不要新建副本）：",
		"1) 用 work_update action=edit 把用户明确提出的新要求写进 requirement / doneCriteria；",
		row.status === "review" ? "2) 任务正在待核验：用 work_verify verdict=return，note 写用户指出的具体问题，退回修改；" : "2) 如果任务在待核验，用 work_verify verdict=return 退回；",
		"3) 用 work_update action=continue 安排原任务下一次执行（负责人不变）；",
		"4) 不要因为用户说话就标完成；只有检查过新结果后才能 work_verify pass。用户没有说清的具体内容先问一个澄清问题，不要臆造。",
		`最近进度：${row.latest_progress || "暂无"}`,
		`原完成标准：${row.done_criteria || "（没有写）"}`,
	].join("\n");
}

/** 看板的“在群里继续”：服务端创建一条带可信任务关联的用户消息，再走正常群路由。 */
export async function postWorkFeedback(workItemId: string, text: string) {
	const row = itemRow(workItemId);
	if (!row) fail("任务不存在", "not_found");
	const body = clip(text, 20_000);
	if (!body) fail("写一句要补充或修改什么", "empty");
	const { postUserMessage } = await import("./rooms/index.ts");
	return postUserMessage(row.room_id!, body, { workItemId: row.id, from: { kind: "user" } });
}

// ---------------------------------------------------------------- 工具（群里）

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/** 管理者才能记录 / 改派 / 核验；成员只能提交自己的。actor 来自群会话闭包，不接受模型自报。 */
export function workItemTools(roomId: string, agentId: string) {
	// 群工具里的 actor 固定绑定当前 roomId：同一个管理者在别的群不能改这里的任务。
	const actor: WorkActor = { kind: "agent", agentId, roomId };
	const manager = isManager(roomId, agentId);
	return (pi: { registerTool: (t: unknown) => void }) => {
		pi.registerTool({
			name: "work_create",
			label: "记录长期任务",
			description:
				(manager ? "（管理者）把需要长期负责、可能多次执行或交接的工作记录成任务，并（默认）马上派给一位成员开始。临时问答、一次工具步骤不要建任务；普通文字回复也不能当验收。目标 / 范围 / 关键约束 / 完成标准不清楚时，先用一句话问清最必要的问题，不要替用户编造需求或笼统的完成标准。\n" : "") +
				"只有管理者能用。任务与单次执行分开：改派 / 退回 / 继续都会保留历史，执行结束不会自动完成。",
			parameters: Type.Object({
				title: Type.String({ description: "任务名字（简短具体）" }),
				requirement: Type.Optional(Type.String({ description: "要做成什么、背景和约束" })),
				doneCriteria: Type.Optional(Type.String({ description: "完成标准：怎样才算做成（可检查）" })),
				owner: Type.Optional(Type.String({ description: "负责人名字（群成员）" })),
				start: Type.Optional(Type.Boolean({ description: "是否马上派给负责人开始，默认是；只记录责任时传 false" })),
			}),
			async execute(_id: string, p: { title: string; requirement?: string; doneCriteria?: string; owner?: string; start?: boolean }) {
				if (!manager) return text("只有管理者能记录长期任务。");
				const owner = p.owner ? memberByName(roomId, p.owner) : null;
				if (p.owner && !owner) return text(`找不到成员「${p.owner}」，可用成员：${memberNames(roomId)}`);
				if (!String(p.requirement ?? "").trim() || !String(p.doneCriteria ?? "").trim()) return text("先别记录执行：目标 / 范围或完成标准还不清楚。先问用户一个关键问题（怎样检查算做完），得到明确回答后再用 work_create；方法和技术细节可以自己定。");
				try {
					const { item } = createWorkItem(
						{ roomId, title: p.title, requirement: p.requirement, doneCriteria: p.doneCriteria, ownerAgentId: owner?.id ?? null, start: p.start !== false && !!owner, sourceMessageId: currentSource(roomId), taskText: [p.title, p.requirement, p.doneCriteria].filter(Boolean).join("\n") },
						actor,
					);
					emit(roomId);
					return text(`已记录任务「${item.title}」（编号 ${item.id}，${item.statusLabel}${owner ? `，负责人 ${owner.name}` : ""}${owner && p.start !== false ? "，已开始执行" : ""}）。完成后成员要提交结果，再由你核验；核验时用 work_verify 写清检查结论。`);
				} catch (e) {
					return text(e instanceof Error ? e.message : String(e));
				}
			},
		});
		pi.registerTool({
			name: "work_submit",
			label: "提交任务结果",
			description: "（成员）把自己负责的任务结果或阻塞提交给管理者核验。只能提交自己的任务，不能改状态或负责人。执行结束不等于任务完成，必须提交。",
			parameters: Type.Object({
				result: Type.Optional(Type.String({ description: "实际做了什么、产物在哪里、怎么检查" })),
				blocker: Type.Optional(Type.String({ description: "做不下去的真实原因（没有就不填）" })),
				workItemId: Type.Optional(Type.String({ description: "同时负责多个任务时指定任务编号" })),
			}),
			async execute(_id: string, p: { result?: string; blocker?: string; workItemId?: string }) {
				try {
					const r = submitWorkItem({ roomId, actor, workItemId: p.workItemId, result: p.result, blocker: p.blocker });
					return text(r.applied ? `已提交，等待核验。${r.item.item.blocker ? "已标为受阻。" : ""}` : "这次结果属于旧修订（任务已改派 / 退回 / 暂停或取消），已作为历史保留，未覆盖当前任务。");
				} catch (e) {
					return text(e instanceof Error ? e.message : String(e));
				}
			},
		});
		pi.registerTool({
			name: "work_verify",
			label: "核验任务",
			description: "（管理者）核验成员提交的任务。note 必须写检查结论（实际看到了什么、为什么通过或退回）；只有通过才完成，退回后任务保持进行中、可重新安排执行。核验完要在群里用一两句话说明结论和交付在哪里；失败或阻塞也要在原群说清楚（不要只更新看板，也不要逐个工具细节刷屏）。",
			parameters: Type.Object({
				workItemId: Type.String({ description: "任务编号" }),
				verdict: Type.Union([Type.Literal("pass"), Type.Literal("return")], { description: "pass = 通过完成；return = 退回修改" }),
				note: Type.String({ description: "检查结论（必填）" }),
			}),
			async execute(_id: string, p: { workItemId: string; verdict: "pass" | "return"; note: string }) {
				try {
					const r = await verifyWorkItem({ workItemId: p.workItemId, actor, verdict: p.verdict, note: p.note });
					emit(roomId);
					return text(`已${p.verdict === "pass" ? "核验通过，任务完成" : "退回修改，任务保持进行中"}：${r.item.title}`);
				} catch (e) {
					return text(e instanceof Error ? e.message : String(e));
				}
			},
		});
		pi.registerTool({
			name: "work_list",
			label: "查看长期任务",
			description: "（管理者）查看这个群里的长期任务及状态、负责人、最近进度。成员也可以用来看自己相关的任务。",
			parameters: Type.Object({ status: Type.Optional(Type.Union(WORK_STATUSES.map((s) => Type.Literal(s)))) }),
			async execute(_id: string, p: { status?: WorkStatus }) {
				const out = listWorkItems(roomId, { status: p.status, limit: 30 });
				if (!out.items.length) return text("这个群还没有长期任务。");
				return text(out.items.map((x) => `- ${x.title}（编号 ${x.id}，${x.statusLabel}）负责人 ${x.ownerName}；${x.latestProgress || "暂无进度"}`).join("\n"));
			},
		});
		pi.registerTool({
			name: "work_update",
			label: "改长期任务",
			description: "（管理者）改派负责人、编辑要求 / 完成标准，或暂停 / 取消 / 继续一个长期任务。",
			parameters: Type.Object({
				workItemId: Type.String({ description: "任务编号" }),
				action: Type.Union([Type.Literal("assign"), Type.Literal("edit"), Type.Literal("continue"), Type.Literal("pause"), Type.Literal("cancel"), Type.Literal("reopen")]),
				owner: Type.Optional(Type.String({ description: "改派时的负责人名字" })),
				title: Type.Optional(Type.String()),
				requirement: Type.Optional(Type.String()),
				doneCriteria: Type.Optional(Type.String()),
			}),
			async execute(_id: string, p: { workItemId: string; action: "assign" | "edit" | "continue" | "pause" | "cancel" | "reopen"; owner?: string; title?: string; requirement?: string; doneCriteria?: string }) {
				try {
					let d;
					if (p.action === "assign" || p.action === "edit") {
						const owner = p.owner ? memberByName(roomId, p.owner) : undefined;
						if (p.owner && !owner) return text(`找不到成员「${p.owner}」`);
						d = editWorkItem({ workItemId: p.workItemId, actor, title: p.title, requirement: p.requirement, doneCriteria: p.doneCriteria, ...(p.action === "assign" ? { ownerAgentId: owner?.id ?? null } : {}) });
					} else if (p.action === "pause") d = await pauseWorkItem({ workItemId: p.workItemId, actor });
					else if (p.action === "cancel") d = await cancelWorkItem({ workItemId: p.workItemId, actor });
					else if (p.action === "reopen") {
						if (!roundAllows(roomId, p.workItemId, "reopen")) return text("这条用户消息没有明确要求重开这个任务；先问清用户是不是要改，再重开。");
						d = reopenWorkItem({ workItemId: p.workItemId, actor, note: "用户要求在群里修改" });
					} else {
						if (!roundAllows(roomId, p.workItemId, "continue") && ["paused"].includes(itemRow(p.workItemId)?.status ?? "")) return text("任务已暂停。用户没有明确说继续，先不要自动恢复执行。");
						d = await continueWorkItem({ workItemId: p.workItemId, actor });
					}
					const label = { assign: "改派", edit: "更新要求", continue: "继续", pause: "暂停", cancel: "取消", reopen: "重开" }[p.action];
					return text(`已${label}「${d.item.title}」：${d.item.statusLabel}${d.item.ownerName ? `，负责人 ${d.item.ownerName}` : ""}。`);
				} catch (e) {
					return text(e instanceof Error ? e.message : String(e));
				}
			},
		});
	};
}

function memberNames(roomId: string) {
	return (db.prepare("SELECT rm.agent_id AS id, COALESCE(a.name, rm.name) AS name FROM room_members rm LEFT JOIN agents a ON a.id = rm.agent_id WHERE rm.room_id = ? AND rm.left_at IS NULL AND rm.deleted = 0").all(roomId) as { id: string; name: string }[]).map((m) => m.name).join("、");
}
function memberByName(roomId: string, name: string) {
	const want = name.replace(/^[@＠]/, "").trim();
	const rows = db.prepare("SELECT rm.agent_id AS id, COALESCE(a.name, rm.name) AS name FROM room_members rm LEFT JOIN agents a ON a.id = rm.agent_id WHERE rm.room_id = ? AND rm.left_at IS NULL AND rm.deleted = 0").all(roomId) as { id: string; name: string }[];
	return rows.find((m) => m.name === want) ?? rows.find((m) => m.name.toLowerCase() === want.toLowerCase()) ?? null;
}
/** 当前这一轮的用户来源消息（由 rooms 提供；拿不到就不挂来源，不凭猜测关联旧消息）。 */
function currentSource(roomId: string): string | null {
	try {
		// 动态 require 会破坏 ESM 缓存；这里同步读取 rooms 里的可变状态由 rooms 注入。
		return sourceProvider?.(roomId) ?? null;
	} catch {
		return null;
	}
}
let sourceProvider: ((roomId: string) => string | null) | null = null;
export function setWorkSourceProvider(fn: (roomId: string) => string | null) {
	sourceProvider = fn;
}

/** HTTP 用户动作的入口：统一按用户 actor 执行，忽略请求体里的任何身份字段。 */
export async function userAction(workItemId: string, action: string, body: Record<string, unknown>) {
	const actor: WorkActor = { kind: "user" };
	switch (action) {
		case "start":
			return startWorkItem({ workItemId, actor });
		case "continue":
			return continueWorkItem({ workItemId, actor });
		case "pause":
			return pauseWorkItem({ workItemId, actor });
		case "cancel":
			return cancelWorkItem({ workItemId, actor });
		case "verify":
			return verifyWorkItem({ workItemId, actor, verdict: body.verdict === "return" ? "return" : "pass", note: String(body.note ?? "") });
		default:
			return fail("不认识的任务动作", "bad_action");
	}
}
