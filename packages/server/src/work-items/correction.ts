/**
 * 群里自然语言纠正：识别用户在说哪个任务（编号 / 任务名 / 引用的结果卡）、本轮允许哪些动作，
 * 并给管理者准备“关于长期任务”的上下文。只读有界，不猜、不检索旧消息。
 */
import { db } from "../db.ts";
import { currentSource, rooms } from "./ports.ts";
import { agentName, clip, fail, itemRow, safeJson, WORK_STATUS_LABEL, type WorkItemRow, type WorkStatus } from "./store.ts";

export type WorkIntent = { correction: boolean; reopen: boolean; continue: boolean };
const CORRECTION_WORDS = /改(一下|成|为|改)?|修改|调整|补充|完善|修正|不对|有问题|错误|不符合|缺(少|了)?|漏了|退回|重做|重来|再改|不是这样|不满足|没达到/;
const REOPEN_WORDS = /重开|重新做|再做|再改|改成|改为|改到|改一下|修改|调整|补充|修正|退回|重做|重来|更新要求|接着改/;
const CONTINUE_WORDS = /继续|接着|再跑|重新开始|重开|恢复|再来一次/;
export function detectWorkIntent(text: string): WorkIntent {
	const t = String(text ?? "");
	return { correction: CORRECTION_WORDS.test(t), reopen: REOPEN_WORDS.test(t), continue: CONTINUE_WORDS.test(t) };
}

export interface WorkReference {
	matches: { id: string; title: string; status: WorkStatus; statusLabel: string; ownerName: string }[];
	ambiguous: boolean;
	byQuote: boolean;
}

/** 只读有界：编号 / 任务名 / 引用的结果卡三种可信指代；不猜、不检索旧消息。 */
export function resolveWorkReferences(roomId: string, text: string, quoteMessageId?: string | null, ownWorkItemId?: string | null): WorkReference {
	const found = new Map<string, WorkItemRow>();
	// 看板反馈入口由服务端写入的 workItemId（用户消息自己的 meta），可信且优先；
	// 客户端提交群消息时不能自带这个字段（postUserMessage 只接受服务端传入）。
	if (ownWorkItemId) {
		const row = itemRow(ownWorkItemId);
		if (row && row.room_id === roomId) found.set(row.id, row);
	}
	const ids = new Set([...String(text ?? "").matchAll(/\bwi_[a-z0-9]+\b/gi)].map((m) => m[0]));
	for (const id of ids) {
		const row = itemRow(id);
		if (row && row.room_id === roomId) found.set(row.id, row);
	}
	if (quoteMessageId) {
		const m = db.prepare("SELECT room_id, meta FROM messages WHERE id = ?").get(quoteMessageId) as { room_id: string | null; meta: string } | undefined;
		if (m && m.room_id === roomId) {
			const meta = safeJson(m.meta);
			if (meta.kind === "work-result" && typeof meta.workItemId === "string") {
				const row = itemRow(meta.workItemId);
				if (row && row.room_id === roomId) found.set(row.id, row);
			}
		}
	}
	const body = String(text ?? "");
	if (body.trim().length >= 2) {
		for (const row of db.prepare("SELECT * FROM work_items WHERE room_id = ? ORDER BY updated_at DESC LIMIT 200").all(roomId) as unknown as WorkItemRow[]) {
			if (row.title.length >= 2 && body.includes(row.title)) found.set(row.id, row);
		}
	}
	const matches = [...found.values()].map((row) => ({ id: row.id, title: row.title, status: row.status, statusLabel: WORK_STATUS_LABEL[row.status], ownerName: agentName(row.owner_agent_id) }));
	return { matches, ambiguous: matches.length > 1, byQuote: !!quoteMessageId };
}

/** 本轮（这一条用户消息）允许的任务动作：新消息自动作废旧许可，避免暂停 / 已取消被任意消息复活。 */
interface RoundAllow { messageId: string; feedback: Set<string>; allowContinue: Set<string>; allowReopen: Set<string> }
const roundAllow = new Map<string, RoundAllow>();
export function roundAllows(roomId: string, itemId: string, kind: "continue" | "reopen") {
	const messageId = currentSource(roomId);
	const a = roundAllow.get(roomId);
	if (!a || !messageId || a.messageId !== messageId) return false;
	return (kind === "continue" ? a.allowContinue : a.allowReopen).has(itemId);
}

/**
 * 给管理者准备一条“关于长期任务”的上下文，并登记本轮许可。
 * 多个匹配时只给候选、要求先问一个澄清问题；状态不同许可不同（暂停只允许明确继续，完成/取消只允许明确重开）。
 */
export function buildWorkCorrectionContext(roomId: string, ref: WorkReference, text: string, messageId: string): string | null {
	if (!ref.matches.length) return null;
	const intent = detectWorkIntent(text);
	const allow: RoundAllow = { messageId, feedback: new Set(), allowContinue: new Set(), allowReopen: new Set() };
	if (ref.ambiguous) {
		roundAllow.set(roomId, allow);
		return [
			"【关于长期任务】用户这条消息可能指到多个任务，系统没有替你猜：",
			...ref.matches.slice(0, 6).map((m) => `- 「${m.title}」（编号 ${m.id}，${m.statusLabel}，负责人 ${m.ownerName}）`),
			"先只问一个必要的澄清问题（哪一项任务），不要修改任何任务、不要派活。",
		].join("\n");
	}
	const m = ref.matches[0];
	const row = itemRow(m.id)!;
	allow.feedback.add(m.id);
	if (intent.continue) allow.allowContinue.add(m.id);
	if (intent.reopen) allow.allowReopen.add(m.id);
	roundAllow.set(roomId, allow);
	if (row.status === "done" || row.status === "cancelled") {
		if (intent.reopen) {
			return [
				`【关于长期任务】「${row.title}」（编号 ${row.id}，当前${WORK_STATUS_LABEL[row.status]}，负责人 ${agentName(row.owner_agent_id)}）`,
				"用户明确要求在这个任务上继续修改。步骤：用 work_update action=reopen 恢复原任务（保留原验收历史），再用 work_update action=edit 把用户这次的具体新要求写进 requirement / doneCriteria，然后用 work_update action=continue 安排原负责人下一次执行。不要新建副本，也不要直接标完成。",
				"原完成标准：",
				row.done_criteria || "（没有写）",
			].join("\n");
		}
		return [
			`【关于长期任务】「${row.title}」（编号 ${row.id}，当前${WORK_STATUS_LABEL[row.status]}，负责人 ${agentName(row.owner_agent_id)}）`,
			"用户提到了这个任务，但没有明确说要重开 / 再改。只回答或询问，不要改状态、不要重新派活。",
		].join("\n");
	}
	if (row.status === "paused") {
		if (intent.continue) {
			return [
				`【关于长期任务】「${row.title}」（编号 ${row.id}，当前已暂停，负责人 ${agentName(row.owner_agent_id)}）`,
				"用户明确说继续。如还有具体修改要求，先用 work_update action=edit 写进 requirement / doneCriteria，再用 work_update action=continue 安排原任务下一次执行；不要标完成。",
			].join("\n");
		}
		return `【关于长期任务】「${row.title}」（编号 ${row.id}，当前已暂停）。用户没有明确说继续，不要自动恢复执行；回答或询问即可。`;
	}
	if (!intent.correction) {
		return [
			`【关于长期任务】「${row.title}」（编号 ${row.id}，当前${WORK_STATUS_LABEL[row.status]}，负责人 ${agentName(row.owner_agent_id)}，第 ${row.revision} 次修订）`,
			"用户提到了这个任务。如果只是问进展，就回答；用户没有提出具体问题时不要改要求、不要重新派活、不要验收。",
			`最近进度：${row.latest_progress || "暂无"}`,
		].join("\n");
	}
	return [
		`【关于长期任务】「${row.title}」（编号 ${row.id}，当前${WORK_STATUS_LABEL[row.status]}，负责人 ${agentName(row.owner_agent_id)}，第 ${row.revision} 次修订）`,
		"用户是在对这项任务提反馈 / 纠正。把所有改动都放在这同一个任务上（不要新建副本）：",
		"1) 用 work_update action=edit 把用户明确提出的新要求写进 requirement / doneCriteria；",
		row.status === "review" ? "2) 任务正在待核验：用 work_verify verdict=return，note 写用户指出的具体问题，退回修改；" : "2) 如果任务在待核验，用 work_verify verdict=return 退回；",
		"3) 用 work_update action=continue 安排原任务下一次执行（负责人不变）；",
		"4) 不要因为用户说话就标完成；只有检查过新结果后才能 work_verify pass。用户没有说清的具体内容先问一个澄清问题，不要臆造。",
		`最近进度：${row.latest_progress || "暂无"}`,
		`原完成标准：${row.done_criteria || "（没有写）"}`,
	].join("\n");
}

/** 看板的“在群里继续”/ 用户的决定：服务端创建一条带可信任务关联的用户消息，再走正常群路由。 */
export async function postWorkFeedback(workItemId: string, text: string) {
	const row = itemRow(workItemId);
	if (!row) fail("任务不存在", "not_found");
	const body = clip(text, 20_000);
	if (!body) fail("写一句要补充或修改什么", "empty");
	const { postUserMessage } = await rooms();
	return postUserMessage(row.room_id!, body, { workItemId: row.id, from: { kind: "user" } });
}
