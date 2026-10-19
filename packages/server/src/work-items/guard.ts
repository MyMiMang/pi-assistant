/**
 * 长期任务看板分组（纯逻辑）：进行中 / 卡住 / 等你决定 / 已完成（另有收起的「已停止」）。
 * 卡住检测（没进展 / 反复卡在同一处 / 只聊不干活）是共用规则，在 ../stuck.ts。
 */

import type { Escalation } from "../stuck.ts";

export type BoardGroup = "decision" | "stuck" | "doing" | "done" | "stopped";
export const BOARD_GROUPS: BoardGroup[] = ["decision", "stuck", "doing", "done", "stopped"];
export const BOARD_LABEL: Record<BoardGroup, string> = { decision: "等你决定", stuck: "卡住", doing: "进行中", done: "已完成", stopped: "已停止" };

/** 一个任务在看板上属于哪一组。需要用户决定的永远最先（高亮），其次是卡住。 */
export function boardGroupOf(o: { status: string; needsUser: boolean; escalation: Escalation | null }): BoardGroup {
	if (o.status === "done") return "done";
	if (o.status === "paused" || o.status === "cancelled") return "stopped";
	if (o.needsUser) return "decision";
	if (o.status === "blocked" || o.escalation) return "stuck";
	return "doing";
}
