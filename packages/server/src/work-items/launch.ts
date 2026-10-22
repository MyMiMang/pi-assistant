/**
 * 开始一次执行与自动放行下游（从 actions.ts 拆出）：launch 在负责人的任务会话里开跑；retryLimitReached 反复重做的提示；
 * 前置任务核验通过后下游自动开始（advanceDependents）、暂缓的任务放行（startReleased）。
 */
import { db, now } from "../db.ts";
import { pendingDeps, readyDependents } from "./deps.ts";
import { createRun, dispatchRun, failRun, workPrompt } from "./exec.ts";
import { port } from "./ports.ts";
import { activeMember, agentName, emit, event, fail, itemRow, MAX_AUTO_RETRIES, parseDepends, roomNotice, WorkItemError, type WorkActor, type WorkItemRow, type WorkRunRow } from "./store.ts";
import { escalate, EXHAUSTED_MARK, REPORT_HINT, SWITCH_HINT } from "./watch.ts";

/** 系统自己推进（不是哪个用户/助理的动作）时用的 actor；和 watch.ts 的 SYSTEM 同一用法。 */
const SYSTEM: WorkActor = { kind: "user" };

/** 立刻在负责人的任务会话里开跑；派发本身失败就明确标受阻。 */
export function launch(item: WorkItemRow, run: WorkRunRow, rethrow = false) {
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
export function retryLimitReached(row: WorkItemRow): never {
	const rung = escalate(row.id, "retry", "user", `已经重做 ${MAX_AUTO_RETRIES} 次仍未通过`, { wake: false });
	if (rung === null) fail("这个任务正在等用户决定，先不要再派活", "retry_limit");
	fail(rung === 3 ? `这个任务${EXHAUSTED_MARK}（已重做 ${MAX_AUTO_RETRIES} 次仍未通过，最后提醒后仍没换做法）。${REPORT_HINT}` : `这个任务已经反复重做 ${MAX_AUTO_RETRIES} 次仍未通过，${SWITCH_HINT}`, "retry_limit");
}

/**
 * 开始一个前置都已完成的 pending 任务（不绕过 createRun + launch 这条现有的开始路径）；负责人不在群里就标受阻待改派并叫醒管理者。
 * upstream = 刚核验通过的前置任务（放行暂缓任务时没有）。advanceDependents 和 startReleased 共用。
 */
function startDependent(dep: WorkItemRow, upstream: WorkItemRow | null) {
	const revision = dep.revision + 1;
	if (!dep.owner_agent_id || !dep.room_id || !activeMember(dep.room_id, dep.owner_agent_id)) {
		db.prepare("UPDATE work_items SET status = 'blocked', revision = ?, latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(revision, "前置任务已完成，但负责人不可用，待改派", "负责人不可用，待改派", now(), dep.id, dep.revision);
		event(dep.id, "owner.unavailable", SYSTEM, revision, { upstream: upstream?.id });
		roomNotice(dep.room_id, `任务「${dep.title}」的前置任务${upstream ? `「${upstream.title}」` : ""}已完成，但负责人不在群里，已标为待改派。`, dep.id);
		if (dep.room_id) port()?.wakeManager(dep.room_id, `任务「${dep.title}」的负责人不可用，待改派`, dep.id);
		emit(dep.room_id);
		return;
	}
	db.prepare("UPDATE work_items SET status = 'active', revision = ?, latest_progress = '前置任务已完成，自动开始', blocker = NULL, updated_at = ? WHERE id = ? AND revision = ?").run(revision, now(), dep.id, dep.revision);
	event(dep.id, "started", SYSTEM, revision, { auto: true, upstream: upstream?.id });
	roomNotice(dep.room_id, upstream ? `「${upstream.title}」已完成，「${dep.title}」自动开始，交给 ${agentName(dep.owner_agent_id)}。` : `「${dep.title}」的前置任务都已完成，自动开始，交给 ${agentName(dep.owner_agent_id)}。`, dep.id);
	const cur = itemRow(dep.id)!;
	launch(cur, createRun(cur, cur.owner_agent_id!, { task: workPrompt(cur) }));
	emit(dep.room_id);
}

/**
 * 一个任务核验通过后，所有依赖它、状态 pending、且全部前置都已完成的下游任务自动开始。
 * 项目方案里有关键点、且这次核验让这个任务所在的阶段刚完成时，别的阶段的下游先暂缓（RoomPort.holdForCheckpoint，由群模块决定并记下），等管理者确认后由 startReleased 放行。
 */
export function advanceDependents(item: WorkItemRow) {
	for (const dep of readyDependents(item.id)) {
		if (item.project_id && dep.project_id === item.project_id && port()?.holdForCheckpoint(item.project_id, item.id, dep.id)) {
			db.prepare("UPDATE work_items SET latest_progress = ?, updated_at = ? WHERE id = ? AND revision = ?").run("等管理者确认下一阶段（方案里有要请你看的关键点）", now(), dep.id, dep.revision);
			emit(dep.room_id);
			continue;
		}
		startDependent(dep, item);
	}
}

/** 放行暂缓的任务：还是 pending 且前置都已完成才开始（被管理者改派 / 取消 / 编辑过的按新状态，不是 pending 就不动）；开始了返回 true。 */
export function startReleased(itemId: string): boolean {
	const dep = itemRow(itemId);
	if (!dep || dep.status !== "pending" || pendingDeps(parseDepends(dep.depends_on)).length) return false;
	startDependent(dep, null);
	return true;
}
