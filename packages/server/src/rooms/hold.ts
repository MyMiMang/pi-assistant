/**
 * 关键点前的暂缓（docs/design/group-team.md §6「关键节点确认」）：任务模块自动开始下游任务前问一声（RoomPort.holdForCheckpoint），
 * 方案有关键点且阶段刚完成时，别的阶段的下游先暂缓，任务编号记在 room_projects.held（JSON 数组）；
 * 管理者一次回合结束后（releaseAfterManagerTurn）、服务重启后（releaseAllHeld），项目没有在等用户看的关键点就放行（startReleased）；
 * 有关键点卡片在等用户就继续暂缓，用户答复后管理者被叫醒，那一回合结束时再放行。项目停下 / 完成时在 projects.ts 里清掉。
 * 判断是纯逻辑（hold-logic.ts）。
 */
import { db, now } from "../db.ts";
import { itemsOfProject, parseStringArray, startReleased } from "../work-items.ts";
import { waitingOf } from "./checkpoint.ts";
import { shouldHold, splitHeld } from "./hold-logic.ts";
import { activeProjects, getProject, projectView, type ProjectRow } from "./projects.ts";
import { queuedFor } from "./scheduler.ts";
import { getRoom } from "./store.ts";

const setHeld = (projectId: string, ids: string[]) => void db.prepare("UPDATE room_projects SET held = ?, updated_at = ? WHERE id = ?").run(ids.length ? JSON.stringify(ids) : null, now(), projectId);

/** RoomPort.holdForCheckpoint：要暂缓就记进 held 并返回 true（任务模块不开始它）。 */
export function holdForCheckpoint(projectId: string, upstreamId: string, dependentId: string): boolean {
	const p = getProject(projectId);
	if (!p || p.status !== "active") return false;
	const held = parseStringArray(p.held);
	const hold = shouldHold({ plan: projectView(p).plan, items: itemsOfProject(p.id), notified: parseStringArray(p.stages_done), upstreamId, dependentId, alreadyHeld: held.includes(dependentId) });
	if (hold && !held.includes(dependentId)) setHeld(p.id, [...held, dependentId]);
	return hold;
}

/** 放行一个项目的暂缓任务：没有关键点卡片在等用户才放行，返回开始的任务数；项目不在进行中就只清掉。 */
export function releaseHeld(p: ProjectRow): number {
	const held = parseStringArray(p.held);
	if (!held.length) return 0;
	if (p.status !== "active") return setHeld(p.id, []), 0;
	if (waitingOf(p.waiting)) return 0;
	const { start } = splitHeld(held, itemsOfProject(p.id));
	setHeld(p.id, []);
	return start.filter(startReleased).length;
}

/**
 * 管理者在这个群的一次回合结束后：放行这个群进行中项目的暂缓任务。
 * 管理者还有排着的回合（比如刚被阶段完成叫醒、还没来得及请用户看关键点）时先不放，等那一回合结束。
 */
export function releaseAfterManagerTurn(roomId: string, agentId: string) {
	const r = getRoom(roomId);
	if (!r?.manager_id || agentId !== r.manager_id || queuedFor(roomId, null, agentId)) return;
	for (const p of activeProjects(roomId)) releaseHeld(getProject(p.id)!);
}

/** 服务重启后：有暂缓任务而没有在等用户的关键点的项目，放行一次。 */
export function releaseAllHeld() {
	for (const p of db.prepare("SELECT * FROM room_projects WHERE held IS NOT NULL").all() as unknown as ProjectRow[]) releaseHeld(p);
}
