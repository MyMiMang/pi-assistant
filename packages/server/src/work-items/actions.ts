/**
 * 长期任务的状态动作：创建、派活、核验、编辑、开始 / 继续 / 暂停 / 取消，以及群生命周期的衔接。
 * 执行本身在 exec.ts（负责人自己的任务会话）；这里只改“责任”。
 * 群 → 任务的唯一入口是 onRoomWorkEvent；任务不跟群「停止」走（停群不停任务，只能单个暂停或一键全停）。
 */
import { db, now, uid } from "../db.ts";
import { cancelWorkRuns, createRun, dispatchRun, failRun, promoteRunMemories, recordProgress, repeatOf, workPrompt } from "./exec.ts";
import {
	activeMember,
	actorKey,
	actorName,
	agentName,
	canAct,
	clip,
	emit,
	event,
	fail,
	getWorkItemDetail,
	itemRow,
	MAX_AUTO_RETRIES,
	requireManagerOrUser,
	requireRoom,
	roomNotice,
	trustedSource,
	WORK_STATUS_LABEL,
	WorkItemError,
	type WorkActor,
	type WorkItemRow,
	type WorkRunRow,
} from "./store.ts";
import { answerDecision, escalate, EXHAUSTED_MARK, REPORT_HINT, SWITCH_HINT } from "./watch.ts";

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
	/** 属于群里的哪个项目（调用方校验过是本群进行中的项目） */
	projectId?: string | null;
}

/** 立刻在负责人的任务会话里开跑；派发本身失败就明确标受阻。 */
function launch(item: WorkItemRow, run: WorkRunRow, rethrow = false) {
	try {
		dispatchRun(item, run);
	} catch (e) {
		failRun(item, run, e);
		emit(item.room_id);
		if (rethrow) throw e instanceof WorkItemError ? e : new WorkItemError(e instanceof Error ? e.message : String(e), "dispatch_failed");
	}
}

/**
 * 反复重做仍不通过：管理者不能再原样重派，也不去问用户（不是费用 / 次数上限，只是卡在同一处）。
 * 第一次给「最后提醒」（报错里写清怎么换做法）；给过之后同一个任务再撞到就标「已用尽办法」向用户报告失败总结。
 * 换人（改派给不同成员）会让新负责人有完整的重做次数，但最后提醒不会再给第二次。
 */
function retryLimitReached(row: WorkItemRow): never {
	const rung = escalate(row.id, "retry", "user", `已经重做 ${MAX_AUTO_RETRIES} 次仍未通过`, { wake: false });
	if (rung === null) fail("这个任务正在等用户决定，先不要再派活", "retry_limit");
	fail(rung === 3 ? `这个任务${EXHAUSTED_MARK}（已重做 ${MAX_AUTO_RETRIES} 次仍未通过，最后提醒后仍没换做法）。${REPORT_HINT}` : `这个任务已经反复重做 ${MAX_AUTO_RETRIES} 次仍未通过，${SWITCH_HINT}`, "retry_limit");
}

export function createWorkItem(input: CreateWorkItemInput, actor: WorkActor) {
	const room = requireRoom(input.roomId);
	requireManagerOrUser({ room_id: room.id }, actor);
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
		"INSERT INTO work_items(id, scope_kind, room_id, title, requirement, done_criteria, owner_agent_id, status, revision, latest_progress, created_by, source_message_id, project_id, last_progress_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(id, "room", room.id, title, requirement, doneCriteria, owner, status, 1, status === "active" ? "进行中" : owner ? "已记录任务，等待补齐信息 / 开始" : "已记录任务，等待安排", actorKey(actor), trustedSource(room.id, input.sourceMessageId), input.projectId ?? null, t, t, t);
	event(id, "created", actor, 1, { title, ownerAgentId: owner });
	const row = itemRow(id)!;
	if (owner && input.start !== false && !ready) {
		db.prepare("UPDATE work_items SET latest_progress = ? WHERE id = ?").run(`信息不全，先别执行：缺${[!row.requirement ? "要做什么" : "", !row.done_criteria ? "完成标准" : ""].filter(Boolean).join("、")}`, id);
		event(id, "needs_clarification", actor, 1, { requirement: !!row.requirement, doneCriteria: !!row.done_criteria });
	}
	if (owner && input.start !== false && ready) launch(row, createRun(row, owner, { task: clip(input.taskText, 4000) || workPrompt(row) }));
	emit(room.id);
	return getWorkItemDetail(id);
}

/**
 * room_assign 带 workItemId：校验和 start 同一条门（任务在本群、负责人是这位成员、需求 / 完成标准齐、状态允许），
 * 然后直接在负责人的任务会话里开跑——不进群的发言队列、不占群每轮上限。不齐就不建 run，避免白跑和 fail-open。
 */
export function dispatchFromRoom(roomId: string, agentId: string, workItemId: string, task?: string) {
	const row = itemRow(workItemId);
	if (!row || row.room_id !== roomId) fail("任务不存在或不在这个群", "not_found");
	if (row.owner_agent_id !== agentId) fail("这个任务的负责人不是该成员；先改派再派活", "not_owner");
	if (!["pending", "active", "blocked"].includes(row.status)) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能直接派活`, "bad_status");
	if (!row.requirement || !row.done_criteria) fail("任务还缺要做什么或完成标准，先补齐再派活", "needs_clarification");
	if (!activeMember(roomId, agentId)) fail("负责人不是这个群的可用成员", "invalid_owner");
	if (db.prepare("SELECT 1 FROM work_item_runs WHERE work_item_id = ? AND status IN ('queued','running') LIMIT 1").get(row.id)) fail("这个任务已有执行在进行，不能重复派活", "already_running");
	const retry = !!db.prepare("SELECT 1 FROM work_item_runs WHERE work_item_id = ? LIMIT 1").get(row.id);
	if (retry) {
		if (row.auto_retries >= MAX_AUTO_RETRIES) retryLimitReached(row);
		db.prepare("UPDATE work_items SET auto_retries = auto_retries + 1 WHERE id = ?").run(row.id);
	}
	if (row.status === "pending") db.prepare("UPDATE work_items SET status = 'active', latest_progress = '进行中', updated_at = ? WHERE id = ? AND revision = ?").run(now(), row.id, row.revision);
	const cur = itemRow(row.id)!;
	const run = createRun(cur, agentId, { task: clip(task, 4000) || workPrompt(cur) });
	launch(cur, run);
	return run;
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
	recordProgress(row);
	if (o.verdict === "pass") {
		const verification = JSON.stringify({ verdict: "pass", note, by: actorKey(o.actor), byName: actorName(o.actor), at: t, revision: row.revision });
		db.prepare("UPDATE work_items SET status = 'done', latest_progress = ?, blocker = NULL, verification = ?, completed_at = ?, auto_retries = 0, needs_user = NULL, escalation = NULL, updated_at = ? WHERE id = ? AND revision = ?").run(`已核验完成：${note.slice(0, 300)}`, verification, t, t, row.id, row.revision);
		event(row.id, "verified.pass", o.actor, row.revision, { note: note.slice(0, 2000) });
		roomNotice(row.room_id, `任务「${row.title}」核验通过：${note.slice(0, 300)}`, row.id);
		await promoteRunMemories(row.id, row.revision).catch((e) => console.warn(`[work] 执行记忆转正失败：${e instanceof Error ? e.message : e}`));
		emit(row.room_id);
		return getWorkItemDetail(row.id);
	}
	const rep = repeatOf(row.id, note);
	const revision = row.revision + 1;
	db.prepare("UPDATE work_items SET status = 'active', revision = ?, latest_progress = ?, blocker = NULL, updated_at = ? WHERE id = ? AND revision = ?").run(revision, `已退回修改：${note.slice(0, 300)}`, t, row.id, row.revision);
	event(row.id, "verified.return", o.actor, revision, { note: note.slice(0, 2000), fromRevision: row.revision, ...(rep.fp ? { fp: rep.fp } : {}) });
	roomNotice(row.room_id, `任务「${row.title}」退回修改：${note.slice(0, 300)}`, row.id);
	// 退回本身就是明确的改进要求 + 原授权仍有效：直接安排原任务下一次执行，不用用户再催「继续」。
	// 任务执行不占群的发言 / 上限，群本轮暂停也不挡它；只在负责人不在、或反复退回时停下。
	const fresh = itemRow(row.id)!;
	const ownerOk = !!fresh.owner_agent_id && !!fresh.room_id && activeMember(fresh.room_id, fresh.owner_agent_id);
	if (!ownerOk) {
		db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run("退回后负责人已不在群里，待改派", "负责人不可用", now(), fresh.id, fresh.revision);
		roomNotice(fresh.room_id, `任务「${fresh.title}」退回后负责人不在群里，已标为待改派。`, fresh.id);
	} else if (fresh.auto_retries >= MAX_AUTO_RETRIES || rep.level === "user") {
		// 反复退回：不再原样重做，也不问用户——管理者换做法（最后提醒，唤醒只在用户核验时需要；管理者自己核验的结果直接在工具返回里）；给过之后再撞就是已用尽办法
		const rung = escalate(fresh.id, "retry", "user", `反复退回仍未通过（最近：${note.slice(0, 120)}）`, { wake: o.actor.kind === "user" });
		if (rung !== 3) db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(`已重做 ${fresh.auto_retries} 次仍在退回，原样重做已停用`, "原样重做已停用，等管理者换做法（改派 / 拆小 / 自己接手）", now(), fresh.id, fresh.revision);
	} else {
		db.prepare("UPDATE work_items SET auto_retries = auto_retries + 1, updated_at = ? WHERE id = ? AND revision = ?").run(now(), fresh.id, fresh.revision);
		event(fresh.id, "auto_retry", o.actor, fresh.revision, { retry: fresh.auto_retries + 1 });
		launch(itemRow(fresh.id)!, createRun(fresh, fresh.owner_agent_id!, { task: workPrompt(fresh) }));
		if (rep.level === "manager" && o.actor.kind === "user") escalate(fresh.id, "repeat", "manager", `又因同样的问题被退回：${note.slice(0, 120)}`);
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
	if (o.title !== undefined) {
		const v = clip(o.title, 200);
		if (!v) fail("任务名字不能为空", "invalid_title");
		fields.push("title = ?");
		args.push(v);
	}
	let contentChanged = false;
	if (o.requirement !== undefined && clip(o.requirement, 8000) !== row.requirement) (fields.push("requirement = ?"), args.push(clip(o.requirement, 8000)), (contentChanged = true));
	if (o.doneCriteria !== undefined && clip(o.doneCriteria, 4000) !== row.done_criteria) (fields.push("done_criteria = ?"), args.push(clip(o.doneCriteria, 4000)), (contentChanged = true));
	if (contentChanged) {
		// 新要求 = 新修订：旧的执行结果只能作为历史。自动重试计数不在这里清 0（否则 edit → return 可无限重跑）。
		revision++;
		fields.push("revision = ?", "latest_progress = ?");
		args.push(revision, "要求已更新，等待按新要求执行");
	}
	if (o.ownerAgentId !== undefined && o.ownerAgentId !== owner) {
		if (o.ownerAgentId && !activeMember(row.room_id!, o.ownerAgentId)) fail("新负责人不是这个群的可用成员", "invalid_owner");
		owner = o.ownerAgentId;
		revision++;
		const status = owner ? (row.status === "pending" ? "pending" : "active") : "pending";
		// 改派 = 换做法：新负责人有完整的重做次数；但「最后提醒」每个任务只给一次（按事件算，见 watch.ts），换人后再撞到就是已用尽办法
		fields.push("owner_agent_id = ?", "revision = ?", "status = ?", "latest_progress = ?", "blocker = NULL");
		if (owner) fields.push("auto_retries = 0");
		args.push(owner, revision, status, owner ? `已改派给 ${agentName(owner)}，等待新的执行` : "已取消负责人，等待重新安排");
	}
	if (fields.length === 0) return getWorkItemDetail(row.id);
	fields.push("updated_at = ?");
	args.push(now(), row.id);
	db.prepare(`UPDATE work_items SET ${fields.join(", ")} WHERE id = ?`).run(...(args as never[]));
	recordProgress(row);
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
	db.prepare("UPDATE work_items SET status = 'active', revision = ?, latest_progress = ?, blocker = NULL, verification = NULL, completed_at = NULL, auto_retries = 0, last_progress_at = ?, updated_at = ? WHERE id = ? AND revision = ?").run(
		revision, note ? `已重开：${note}` : "已重开，等待按新要求执行", now(), now(), row.id, row.revision,
	);
	event(row.id, "reopened", o.actor, revision, { from: row.status, note });
	roomNotice(row.room_id, `任务「${row.title}」已重开，接着在原任务上修改。`, row.id);
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}

/** 开始 / 继续共用：推进修订、（用户动作时）清重试计数和待决定，然后在负责人的任务会话里开跑。 */
function relaunch(row: WorkItemRow, actor: WorkActor, kind: "started" | "continued") {
	const revision = row.revision + 1;
	const user = actor.kind === "user" ? 1 : 0;
	// 只有用户明确的新执行授权才清计数；管理者每次再派都占同一计数（continue 额外 +1），不能借此绕过「反复卡住」。
	const bump = kind === "continued" ? "auto_retries + 1" : "auto_retries";
	db.prepare(`UPDATE work_items SET status = 'active', revision = ?, latest_progress = '进行中', blocker = NULL, auto_retries = CASE WHEN ? THEN 0 ELSE ${bump} END, needs_user = CASE WHEN ? THEN NULL ELSE needs_user END, updated_at = ? WHERE id = ? AND revision = ?`).run(revision, user, user, now(), row.id, row.revision);
	event(row.id, kind, actor, revision);
	const cur = itemRow(row.id)!;
	emit(row.room_id);
	launch(cur, createRun(cur, cur.owner_agent_id!, { task: workPrompt(cur) }), true);
	return getWorkItemDetail(row.id);
}

export async function startWorkItem(o: { workItemId: string; actor: WorkActor }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!canAct(row.status, "start")) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能开始`, "bad_status");
	if (o.actor.kind === "agent" && row.auto_retries >= MAX_AUTO_RETRIES) retryLimitReached(row);
	if (!row.owner_agent_id) fail("先指定负责人再开始", "no_owner");
	if (!row.requirement || !row.done_criteria) fail("先补清要做什么和完成标准再开始；不要把笼统默认当成用户已确认的标准", "needs_clarification");
	if (!activeMember(row.room_id!, row.owner_agent_id)) fail("负责人已不在群里，请先改派", "owner_left");
	return relaunch(row, o.actor, "started");
}

/** 继续：暂停 / 受阻 / 已退回后重开一次执行；没有负责人就退回待安排。 */
export async function continueWorkItem(o: { workItemId: string; actor: WorkActor }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!["active", "blocked", "paused"].includes(row.status)) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能继续`, "bad_status");
	if (o.actor.kind === "agent" && row.auto_retries >= MAX_AUTO_RETRIES) retryLimitReached(row);
	if (db.prepare("SELECT 1 FROM work_item_runs WHERE work_item_id = ? AND status IN ('queued','running') LIMIT 1").get(row.id)) fail("这个任务已经有执行在进行，等它结束或先暂停", "already_running");
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
	return relaunch(row, o.actor, "continued");
}

async function stopItem(row: WorkItemRow, actor: WorkActor, to: "paused" | "cancelled") {
	const revision = row.revision + 1;
	db.prepare("UPDATE work_items SET status = ?, revision = ?, latest_progress = ?, needs_user = NULL, escalation = NULL, updated_at = ? WHERE id = ? AND revision = ?").run(to, revision, to === "paused" ? "已暂停，等待继续" : "已取消", now(), row.id, row.revision);
	event(row.id, to, actor, revision);
	await cancelWorkRuns(row.id, { abortCurrent: true });
}

export async function pauseWorkItem(o: { workItemId: string; actor: WorkActor }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!canAct(row.status, "pause")) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能暂停`, "bad_status");
	roomNotice(row.room_id, `任务「${row.title}」已暂停。`, row.id);
	await stopItem(row, o.actor, "paused");
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}

export async function cancelWorkItem(o: { workItemId: string; actor: WorkActor }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	if (!canAct(row.status, "cancel")) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，不能取消`, "bad_status");
	roomNotice(row.room_id, `任务「${row.title}」已取消。`, row.id);
	await stopItem(row, o.actor, "cancelled");
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}

/** 看板「全部暂停」：只有用户；停群不停任务，要停全部任务用这里。只动本群。 */
export async function pauseAllWorkItems(roomId: string) {
	requireRoom(roomId);
	const rows = db.prepare("SELECT * FROM work_items WHERE room_id = ? AND status IN ('pending','active','blocked','review')").all(roomId) as unknown as WorkItemRow[];
	for (const row of rows) await stopItem(row, { kind: "user" }, "paused");
	if (rows.length) roomNotice(roomId, `已暂停这个群的全部 ${rows.length} 个任务。`, "");
	emit(roomId);
	return { paused: rows.length };
}

// ---------------------------------------------------------------- 与群生命周期的衔接（钩子①）

/** 移出成员：标受阻待改派，不自动转给管理者，也不继续调度。 */
function onRoomMemberRemoved(roomId: string, agentId: string) {
	const rows = db.prepare("SELECT * FROM work_items WHERE room_id = ? AND owner_agent_id = ? AND status IN ('pending','active','blocked','review')").all(roomId, agentId) as unknown as WorkItemRow[];
	for (const row of rows) {
		db.prepare("UPDATE work_items SET status = 'blocked', revision = revision + 1, latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(`负责人 ${agentName(agentId)} 已移出群聊，待改派`, "负责人已移出群聊", now(), row.id, row.revision);
		event(row.id, "owner.left", { kind: "user" }, row.revision + 1, { agentId });
		cancelWorkRuns(row.id, { abortCurrent: true }).catch(() => {});
	}
	if (rows.length) emit(roomId);
}

/** 删群：中止本群任务的执行，并按原删除语义清掉本群的任务与关联（成员自己的任务会话保留为它的记忆）。 */
function deleteRoomWorkItems(roomId: string) {
	const ids = (db.prepare("SELECT id FROM work_items WHERE room_id = ?").all(roomId) as { id: string }[]).map((r) => r.id);
	for (const id of ids) {
		void cancelWorkRuns(id, { abortCurrent: true }).catch(() => {});
		db.prepare("DELETE FROM work_item_events WHERE work_item_id = ?").run(id);
		db.prepare("DELETE FROM work_item_runs WHERE work_item_id = ?").run(id);
	}
	db.prepare("DELETE FROM work_exec_conversations WHERE room_id = ?").run(roomId);
	db.prepare("DELETE FROM work_items WHERE room_id = ?").run(roomId);
}

/** 钩子①（群 → 任务）：成员移出、删群从这里进来。群「停止」不在这里——停群不停任务。 */
export type RoomWorkEvent = { kind: "memberRemoved"; roomId: string; agentId: string } | { kind: "roomDeleted"; roomId: string };
export function onRoomWorkEvent(e: RoomWorkEvent) {
	if (e.kind === "memberRemoved") return onRoomMemberRemoved(e.roomId, e.agentId);
	return deleteRoomWorkItems(e.roomId);
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
		case "decide":
			return answerDecision(workItemId, String(body.answer ?? ""));
		default:
			return fail("不认识的任务动作", "bad_action");
	}
}
