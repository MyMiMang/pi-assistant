/**
 * 阶段完成通知（docs/design/group-team.md §6，决策 0019 第 5 步）：任务核验通过后，项目的某个阶段从「进行中」变成「已完成」时，
 * 叫醒管理者给用户一个简短的进度通知（方案里有关键点的先走 room_checkpoint）；最后一个阶段完成则提醒管理者核对完成标准、交付。
 * 管理者自己在一轮里核验通过、让阶段完成时不另叫醒：提醒随 work_verify 的结果回给它，这一轮就处理。
 * 判断「刚完成」是纯逻辑（progress.ts 的 newlyDoneStages），已通知过的阶段名持久化在 room_projects.stages_done，每个阶段只通知一次。
 * 任务模块不 import 群模块：由 RoomPort.stageMaybeDone 调进来。
 */
import { db } from "../db.ts";
import { itemsOfProject, parseStringArray } from "../work-items.ts";
import { wakeManager } from "./collab.ts";
import { getProject, projectView } from "./projects.ts";
import { getRoom } from "./store.ts";
import { ALL_DONE_MARK, newlyDoneStages, projectProgress, stageDoneReason } from "./progress.ts";

export function stageMaybeDone(projectId: string, byAgentId?: string): string | null {
	const p = getProject(projectId);
	if (!p || p.status !== "active") return null;
	const plan = projectView(p).plan;
	const notified = parseStringArray(p.stages_done);
	const { names, allDone } = newlyDoneStages(projectProgress(plan, itemsOfProject(p.id)), notified);
	if (!names.length && !allDone) return null;
	db.prepare("UPDATE room_projects SET stages_done = ? WHERE id = ?").run(JSON.stringify([...notified, ...names, ...(allDone ? [ALL_DONE_MARK] : [])]), p.id);
	const reason = stageDoneReason({ title: p.title, projectId: p.id, names, allDone, checkpoints: plan.checkpoints, held: parseStringArray(p.held).length > 0 });
	// 管理者自己在这一轮里核验通过、让阶段完成：提醒写进它的工具结果，同一轮里处理；再另排一轮会把同样的进度又说一遍
	if (byAgentId && byAgentId === getRoom(p.room_id)?.manager_id) return reason;
	wakeManager(p.room_id, reason, undefined, p.id);
	return null;
}
