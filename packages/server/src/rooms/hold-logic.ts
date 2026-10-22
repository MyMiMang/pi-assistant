/**
 * 关键点前的暂缓（docs/design/group-team.md §6「关键节点确认」）：纯逻辑，不碰数据库，便于单测。
 * 方案里有关键点时，一个阶段刚完成，依赖它的「别的阶段」下游任务先不自动开始，等管理者（和用户）确认后再放行；
 * 判断「刚完成」和 stages.ts 一致：阶段全部完成且还没通知过（room_projects.stages_done 里没有）。
 */
import type { ProjectPlan } from "./plan.ts";
import { projectProgress } from "./progress.ts";
import type { WorkItemSummary } from "../work-items.ts";

/** 这个下游任务现在要不要暂缓：已经在暂缓名单里继续暂缓；否则要同时满足——方案有关键点、两个任务都写了阶段且不同、上游所在阶段刚完成。 */
export function shouldHold(o: { plan: ProjectPlan; items: WorkItemSummary[]; notified: string[]; upstreamId: string; dependentId: string; alreadyHeld: boolean }): boolean {
	if (o.alreadyHeld) return true;
	if (!o.plan.checkpoints.length) return false;
	const up = o.items.find((i) => i.id === o.upstreamId);
	const dep = o.items.find((i) => i.id === o.dependentId);
	if (!up?.stage || !dep?.stage || up.stage === dep.stage) return false;
	const stage = projectProgress(o.plan, o.items).stages.find((s) => s.name === up.stage);
	return !!stage && stage.state === "done" && !o.notified.includes(stage.name);
}

/** 放行时把暂缓名单分成「该开始的」和「不用动的」：仍是 pending 且前置都已完成的开始；别的状态（管理者改派 / 取消 / 编辑过、已开始）只从名单里移除。 */
export function splitHeld(held: string[], items: WorkItemSummary[]): { start: string[]; drop: string[] } {
	const start: string[] = [];
	const drop: string[] = [];
	for (const id of held) {
		const it = items.find((i) => i.id === id);
		(it && it.status === "pending" && it.dependsOn.every((d) => d.status === "done") ? start : drop).push(id);
	}
	return { start, drop };
}
