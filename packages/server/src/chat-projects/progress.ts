/**
 * 单聊项目的进度（docs/design/group-team.md §13）：纯逻辑，不碰数据库，便于单测。
 * 单聊没有任务清单，阶段完成由助理用 chat_stage_done 标记；这里把「已完成的阶段名」整理成和群聊项目一样的 ProjectProgress，
 * 界面的进度清单、顶部 chip、给模型看的文字（rooms/progress.ts 的 renderProgress）都能直接复用。
 */
import type { ProjectPlan } from "../rooms/plan.ts";
import type { ProjectProgress } from "../rooms/progress.ts";

/** 按已完成的阶段名算进度：第一个没完成的阶段是「进行中」，之后的「没开始」。 */
export function chatProgress(plan: ProjectPlan, doneStages: string[]): ProjectProgress {
	const doneSet = new Set(doneStages);
	const firstUnfinished = plan.stages.findIndex((s) => !doneSet.has(s.name));
	const stages = plan.stages.map((s, i) => ({ name: s.name, output: s.output, items: [], state: (doneSet.has(s.name) ? "done" : i === firstUnfinished ? "doing" : "todo") as "todo" | "doing" | "done" }));
	return { stages, other: [], done: stages.filter((s) => s.state === "done").length, total: stages.length, currentStage: firstUnfinished === -1 || !stages.length ? null : firstUnfinished };
}

/** 助理说的「阶段」是第几个（1 开始的序号）或阶段名（精确优先，其次包含）；找不到返回 -1。 */
export function findStage(plan: ProjectPlan, ref: unknown): number {
	const raw = String(ref ?? "").trim();
	if (!raw) return -1;
	if (/^\d+$/.test(raw)) {
		const n = Number(raw) - 1;
		return n >= 0 && n < plan.stages.length ? n : -1;
	}
	const exact = plan.stages.findIndex((s) => s.name === raw);
	if (exact !== -1) return exact;
	const low = raw.toLowerCase();
	return plan.stages.findIndex((s) => s.name && (s.name.toLowerCase().includes(low) || low.includes(s.name.toLowerCase())));
}

/** 聊天里那一条简短的阶段进度（系统消息）。 */
export const stageNotice = (title: string, stage: string, done: number, total: number, note: string) => `项目「${title}」：${stage}完成了（${done}/${total}）${note ? `——${note}` : ""}`;
