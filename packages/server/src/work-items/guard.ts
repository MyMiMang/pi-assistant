/**
 * 长期任务的纯逻辑（不碰数据库 / 模型，便于单测）：
 *  - 看板分组：进行中 / 卡住 / 等你决定 / 已完成（另有收起的「已停止」）
 *  - 防护只做检测，不设固定次数上限、不提示费用：
 *      卡住没进展（超时无任何动静）、反复卡在同一处（同一错误 / 阻塞 / 退回理由重复）。
 *    命中先报管理者，管理者处理后仍没进展再报用户。
 *  「只聊不干活」是群对话层面的检测，在 rooms/logic.ts（chatterStep）。
 */

export type BoardGroup = "decision" | "stuck" | "doing" | "done" | "stopped";
export const BOARD_GROUPS: BoardGroup[] = ["decision", "stuck", "doing", "done", "stopped"];
export const BOARD_LABEL: Record<BoardGroup, string> = { decision: "等你决定", stuck: "卡住", doing: "进行中", done: "已完成", stopped: "已停止" };

export type EscalationLevel = "manager" | "user";
export type EscalationKind = "stall" | "repeat" | "retry";
export interface Escalation {
	kind: EscalationKind;
	level: EscalationLevel;
	at: number;
	note: string;
}

/** 一个任务在看板上属于哪一组。需要用户决定的永远最先（高亮），其次是卡住。 */
export function boardGroupOf(o: { status: string; needsUser: boolean; escalation: Escalation | null }): BoardGroup {
	if (o.status === "done") return "done";
	if (o.status === "paused" || o.status === "cancelled") return "stopped";
	if (o.needsUser) return "decision";
	if (o.status === "blocked" || o.escalation) return "stuck";
	return "doing";
}

/**
 * 「同一处」的指纹：去掉数字、路径、编号、标点和空白差异，只比较说法本身。
 * 太短（< 4 个字）不算，免得「失败」「不行」这种泛泛的话互相撞上。
 */
export function fingerprint(text: string | null | undefined): string {
	const t = String(text ?? "")
		.toLowerCase()
		.replace(/\bwi_[a-z0-9]+\b/g, "")
		.replace(/(?:[a-z]:)?[\\/][^\s，,。；;：:）)]+/gi, "")
		.replace(/[0-9]+/g, "")
		.replace(/[\s\p{P}\p{S}]+/gu, "")
		.slice(0, 60);
	return t.length >= 4 ? t : "";
}

/**
 * 反复卡在同一处：这次的指纹在本任务之前的阻塞 / 失败 / 退回里出现过几次。
 * 第 2 次 → 报管理者（换方法、改派或拆小，不要原样重试）；第 3 次及以后 → 报用户决定。
 */
export function repeatLevel(previous: string[], fp: string): EscalationLevel | null {
	if (!fp) return null;
	const seen = previous.filter((x) => x === fp).length;
	if (seen >= 2) return "user";
	if (seen === 1) return "manager";
	return null;
}

/**
 * 卡住没进展：从最后一次动静（执行里的任何消息 / 工具、提交、汇报、改要求、上一次上报）算起超过 stallMs。
 * 先报管理者；管理者被叫过之后仍然一点动静都没有，再报用户。已经在等用户决定的不再重复上报。
 */
export function stallStep(o: { status: string; needsUser: boolean; lastActivityAt: number; escalation: Escalation | null; now: number; stallMs: number }): EscalationLevel | null {
	if (!["active", "blocked", "review"].includes(o.status) || o.needsUser) return null;
	const esc = o.escalation && o.escalation.at >= o.lastActivityAt ? o.escalation : null;
	const since = Math.max(o.lastActivityAt, esc?.at ?? 0);
	if (o.now - since < o.stallMs) return null;
	if (!esc) return "manager";
	if (esc.level === "manager") return "user";
	return null;
}
