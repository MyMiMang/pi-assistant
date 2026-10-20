/**
 * 卡住检测的共用规则（决策 0014 第 3 步）：群任务、群对话和单聊帮手（子代理）都用这一份，纯逻辑、不碰数据库。
 * 只做检测和分级，不设固定次数 / 费用上限：
 *  - 卡住没进展：超过一段时间没有任何动静；
 *  - 反复卡在同一处：同一错误 / 阻塞 / 退回理由（按指纹）重复出现；
 *  - 只聊不干活：群成员之间来回叫醒却没有任务进展。
 * 群任务的上报是三级阶梯（决策 0014 的同款思路，不再自动问用户三选一）：
 *  第 1 级 管理者自己处理（带纠正重做 / 拆小）；第 2 级「最后提醒」（原样重做停用，必须换做法：改派 / 拆小 / 自己接手）；
 *  第 3 级「已用尽办法」（系统标受阻，群里写失败总结并推送给用户，是通知不是提问）。
 * 这里的 level：「manager」= 第 1 级；「user」= 上一级之后仍没解决、升到下一级（stallStep / repeatLevel 只给出这个信号，
 * 具体第几级由 nextRung 按已有的上报和“是否发过最后提醒”算）。群对话「只聊不干活」（chatterStep）仍直接请用户。
 * 单聊帮手只复用指纹和反复判定，卡住由主会话自己解决（见 subagent-stuck.ts）。
 */

export type EscalationLevel = "manager" | "user";
export type EscalationKind = "stall" | "repeat" | "retry" | "chatter";
export interface Escalation {
	kind: EscalationKind;
	level: EscalationLevel;
	at: number;
	note: string;
	/** 阶梯第几级（1 管理者自己处理 / 2 最后提醒 / 3 已用尽办法）；旧数据没有，按 1 级算 */
	rung?: Rung;
}
export type Rung = 1 | 2 | 3;

/**
 * 这次上报落在阶梯第几级：level 为 manager 是第 1 级；为 user 是在已有上报的基础上升一级。
 * 最后提醒（第 2 级）每个任务只给一次（finalWarned，用户的动作会清掉这个记录）：已经给过就直接第 3 级。
 */
export function nextRung(o: { level: EscalationLevel; escalation: Escalation | null; finalWarned: boolean }): Rung {
	const want = o.level === "manager" ? 1 : (o.escalation?.rung ?? 1) + 1;
	return want >= 3 || (want === 2 && o.finalWarned) ? 3 : (want as Rung);
}

/**
 * 「同一处」的指纹：去掉数字、路径、编号、标点和空白差异，只比较说法本身。
 * 太短（< 4 个字）不算，免得「失败」「不行」这种泛泛的话互相撞上。
 */
export function fingerprint(text: string | null | undefined): string {
	const t = String(text ?? "")
		.toLowerCase()
		.replace(/\b(?:wi|sa)_[a-z0-9]+\b/g, "")
		.replace(/(?:[a-z]:)?[\\/][^\s，,。；;：:）)]+/gi, "")
		.replace(/[0-9]+/g, "")
		.replace(/[\s\p{P}\p{S}]+/gu, "")
		.slice(0, 60);
	return t.length >= 4 ? t : "";
}

/**
 * 反复卡在同一处：这次的指纹在之前的阻塞 / 失败 / 退回里出现过几次。
 * 第 2 次 → 第 1 级（换方法、改派或拆小，不要原样重试）；第 3 次及以后 → 升到下一级（最后提醒 / 已用尽办法）。
 */
export function repeatLevel(previous: string[], fp: string): EscalationLevel | null {
	if (!fp) return null;
	const seen = previous.filter((x) => x === fp).length;
	if (seen >= 2) return "user";
	if (seen === 1) return "manager";
	return null;
}

/**
 * 卡住没进展：从最后一次动静（消息 / 工具、提交、汇报、改要求、上一次上报）算起超过 stallMs。
 * 先叫管理者（第 1 级）；它被叫过之后仍然一点动静都没有，就升到下一级（见 nextRung）。不在进行中、或已经在等用户的不再上报。
 */
export function stallStep(o: { active: boolean; needsUser: boolean; lastActivityAt: number; escalation: Escalation | null; now: number; stallMs: number }): EscalationLevel | null {
	if (!o.active || o.needsUser) return null;
	const esc = o.escalation && o.escalation.at >= o.lastActivityAt ? o.escalation : null;
	const since = Math.max(o.lastActivityAt, esc?.at ?? 0);
	if (o.now - since < o.stallMs) return null;
	if (!esc) return "manager";
	if (esc.level === "manager") return "user";
	return null;
}

/**
 * 「只聊不干活」：成员之间连续来回（peer 回合）却没有任何任务进展，就累加；有进展清零。
 * 到阈值先叫管理者，到两倍阈值再请用户（并暂停成员互相叫醒，直到有进展或用户发话）。
 */
export function chatterStep(streak: number, o: { progressed: boolean; threshold: number }): { streak: number; level: EscalationLevel | null } {
	if (o.progressed) return { streak: 0, level: null };
	const next = streak + 1;
	const t = Math.max(2, o.threshold);
	return { streak: next, level: next === t ? "manager" : next === t * 2 ? "user" : null };
}
