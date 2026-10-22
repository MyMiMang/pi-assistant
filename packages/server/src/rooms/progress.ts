/**
 * 项目进度清单（docs/design/group-team.md §4、§6、§15 第二轮；决策 0019 第 3 步）：纯逻辑，不碰数据库，便于单测。
 *  - projectProgress：按方案阶段把任务分组，算每个阶段的状态和整体进度；
 *  - renderProgress：渲染成给管理者看的文字（唤醒时接在方案后面）；
 *  - projectSig / projectStallStep：项目级「卡住检测」的指纹和阶梯，持久化在 room_projects（projects.ts）。
 */
import type { ProjectPlan } from "./plan.ts";
import type { WorkItemSummary, WorkStatus } from "../work-items.ts";

export interface ProgressItem {
	id: string;
	title: string;
	ownerName: string;
	status: WorkStatus;
	statusLabel: string;
	/** 还没完成的前置任务标题 */
	waitingFor: string[];
}
export interface ProjectProgress {
	stages: { name: string; output: string; items: ProgressItem[]; state: "todo" | "doing" | "done" }[];
	/** 没写 stage 或 stage 和方案对不上的任务 */
	other: ProgressItem[];
	done: number;
	total: number;
	/** 第一个没完成的阶段下标；全部完成或没有阶段为 null */
	currentStage: number | null;
}

const toProgressItem = (it: WorkItemSummary): ProgressItem => ({
	id: it.id,
	title: it.title,
	ownerName: it.ownerName,
	status: it.status,
	statusLabel: it.statusLabel,
	waitingFor: it.dependsOn.filter((d) => d.status !== "done").map((d) => d.title),
});

/** 按方案阶段把任务分组，算每个阶段和整体的进度（不含已取消的任务）。 */
export function projectProgress(plan: ProjectPlan, items: WorkItemSummary[]): ProjectProgress {
	const live = items.filter((i) => i.status !== "cancelled");
	const stages = plan.stages.map((s) => {
		const stageItems = live.filter((it) => it.stage === s.name).map(toProgressItem);
		const state: "todo" | "doing" | "done" = stageItems.length === 0 ? "todo" : stageItems.every((x) => x.status === "done") ? "done" : "doing";
		return { name: s.name, output: s.output, items: stageItems, state };
	});
	const stageNames = new Set(plan.stages.map((s) => s.name));
	const other = live.filter((it) => !it.stage || !stageNames.has(it.stage)).map(toProgressItem);
	const done = live.filter((i) => i.status === "done").length;
	const firstUnfinished = stages.findIndex((s) => s.state !== "done");
	return { stages, other, done, total: live.length, currentStage: stages.length === 0 ? null : firstUnfinished === -1 ? null : firstUnfinished };
}

const STAGE_LABEL = { todo: "没开始", doing: "进行中", done: "已完成" } as const;

/** 渲染成给管理者看的进度清单文字：阶段一行 + 下面的任务行（状态 / 负责人 / 等谁）。 */
export function renderProgress(p: ProjectProgress): string {
	const line = (it: ProgressItem) => `  - ${it.title}：${it.statusLabel}，负责人 ${it.ownerName || "未安排"}${it.waitingFor.length ? `，等：${it.waitingFor.join("、")}` : ""}`;
	const stageLines = p.stages.flatMap((s, i) => [`${i + 1}. ${s.name}（${STAGE_LABEL[s.state]}）`, ...s.items.map(line)]);
	const otherLines = p.other.length ? ["其他任务：", ...p.other.map(line)] : [];
	return [`进度：已完成 ${p.done}/${p.total}`, ...stageLines, ...otherLines].join("\n");
}

/**
 * 项目进展指纹：只数「真正产出了东西」——已完成的任务数 + 成员提交结果的次数。
 * 退回、受阻、执行失败、修订号变化都不算进展（否则反复失败的任务会让指纹一直在变，卡住计数永远到不了 3）。
 */
export function projectSig(o: { done: number; submits: number }): string {
	return `done=${o.done}|submits=${o.submits}`;
}

/**
 * 项目级卡住阶梯（纯函数，单测覆盖抖动）：指纹变了算一次「有进展」，stalls −1（不清零，偶尔一次没进展不报警）；
 * 指纹没变就 +1；这次核验里出现过「这条路走不通」再额外 +1（走不通本身就是没进展，哪怕指纹因此变了）。
 * 第一次检查（lastSig 为 null）只记录起点，不计入阶梯。
 */
export function projectStallStep(o: { stalls: number; lastSig: string | null; sig: string; impossible: boolean }): number {
	if (o.lastSig === null) return o.stalls;
	let stalls = o.sig !== o.lastSig ? Math.max(0, o.stalls - 1) : o.stalls + 1;
	if (o.impossible) stalls += 1;
	return stalls;
}
