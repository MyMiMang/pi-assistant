/**
 * 防护与决定（docs/design/group-collaboration.md「防护只做三件事」）：
 *  - 卡住没进展（超时）→ 先叫管理者；管理者介入后仍没动静 → 问用户；
 *  - 反复卡在同一处（exec.ts 用指纹判断）→ 同样先管理者、再用户；
 *  - 用户只在「等你决定」时被打扰：一张提问卡片 + 推送，回答后由管理者按决定继续。
 * 不设固定次数 / 费用 / 令牌上限；这里只做检测和上报。
 */
import { db, now } from "../db.ts";
import { requests } from "../requests.ts";
import { postWorkFeedback } from "./correction.ts";
import { stallStep, type Escalation, type EscalationKind, type EscalationLevel } from "../stuck.ts";
import { port } from "./ports.ts";
import { agentName, clip, emit, escalationOf, event, fail, getWorkItemDetail, itemRow, needsUserOf, roomNotice, type NeedsUser, type WorkActor, type WorkItemRow } from "./store.ts";

export const STALL_MS = () => Number(process.env.PIA_WORK_STALL_MS) || 20 * 60_000;
const SYSTEM: WorkActor = { kind: "user" };
const DEFAULT_OPTIONS = ["换个方法继续", "改派给其他成员", "先暂停这个任务"];

/** 上报：manager = 写进看板「卡住」并唤醒管理者；user = 进「等你决定」并问用户。 */
export async function escalate(itemId: string, kind: EscalationKind, level: EscalationLevel, note: string) {
	const item = itemRow(itemId);
	if (!item || ["done", "paused", "cancelled"].includes(item.status) || item.needs_user) return;
	const esc: Escalation = { kind, level, at: now(), note: clip(note, 300) };
	db.prepare("UPDATE work_items SET escalation = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(esc), now(), item.id);
	event(item.id, "escalated", SYSTEM, item.revision, { ...esc });
	if (level === "manager") {
		roomNotice(item.room_id, `任务「${item.title}」${esc.note}，已请管理者处理。`, item.id);
		if (item.room_id) port()?.wakeManager(item.room_id, `任务「${item.title}」${esc.note}`, item.id);
		emit(item.room_id);
		return;
	}
	await askUserDecision(item.id, { question: `任务「${item.title}」${esc.note}。下一步怎么办？`, options: DEFAULT_OPTIONS, reason: esc.note });
}

/**
 * 把一个任务放进「等你决定」：看板高亮 + 管理者在群里的一张提问卡片（带推送）。
 * 卡片回答和看板回答走同一个 answerDecision，谁先到算谁，另一个自动作废。
 */
export async function askUserDecision(itemId: string, o: { question: string; options?: string[]; reason?: string }) {
	const item = itemRow(itemId);
	if (!item) fail("任务不存在", "not_found");
	if (["done", "cancelled"].includes(item.status)) fail("任务已结束，不需要再决定", "bad_status");
	const question = clip(o.question, 600);
	if (!question) fail("写清要用户决定什么", "empty");
	const options = (o.options ?? []).map((s) => clip(s, 80)).filter(Boolean).slice(0, 6);
	const nu: NeedsUser = { question, options, reason: clip(o.reason, 300), requestId: null, at: now() };
	const mc = item.room_id ? port()?.managerConversation(item.room_id) : null;
	if (mc) {
		const pending = requests.question(mc.agentId, null, question, options, true, mc.conversationId);
		// create() 同步落库：按插入顺序取刚建的这张（同一毫秒里可能还有别的提问，不能只按时间取）
		const r = db.prepare("SELECT id FROM requests WHERE conversation_id = ? AND status = 'pending' AND kind = 'question' AND json_extract(payload, '$.question') = ? ORDER BY rowid DESC LIMIT 1").get(mc.conversationId, question) as { id: string } | undefined;
		nu.requestId = r?.id ?? null;
		const requestId = nu.requestId;
		void pending
			.then((ans) => {
				// 只认用户真的回答了（群停止 / 过期等系统收尾不算决定）
				const row = db.prepare("SELECT status, resolved_by FROM requests WHERE id = ?").get(requestId) as { status: string; resolved_by: string | null } | undefined;
				if (row?.status === "answered" && row.resolved_by !== "system" && ans.answer) return answerDecision(itemId, ans.answer, { requestId });
			})
			.catch(() => {});
	}
	db.prepare("UPDATE work_items SET needs_user = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(nu), now(), item.id);
	event(item.id, "needs_user", SYSTEM, item.revision, { question, reason: nu.reason });
	roomNotice(item.room_id, `任务「${item.title}」等你决定：${question.slice(0, 200)}`, item.id);
	emit(item.room_id);
	return getWorkItemDetail(item.id);
}

/** 用户的决定：清掉「等你决定」和上报，重置“反复卡住”计数，交给管理者按决定继续。幂等。 */
export async function answerDecision(itemId: string, answer: string, o: { requestId?: string | null } = {}) {
	const item = itemRow(itemId);
	if (!item) fail("任务不存在", "not_found");
	const nu = needsUserOf(item);
	if (!nu) {
		if (o.requestId) return getWorkItemDetail(item.id); // 看板已经先答了
		fail("这个任务现在不需要你决定", "no_decision");
	}
	if (o.requestId && nu.requestId !== o.requestId) return getWorkItemDetail(item.id); // 过期卡片
	const a = clip(answer, 2000);
	if (!a) fail("写一句你的决定", "empty");
	db.prepare("UPDATE work_items SET needs_user = NULL, escalation = NULL, auto_retries = 0, last_progress_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), item.id);
	event(item.id, "decided", { kind: "user" }, item.revision, { answer: a.slice(0, 1000), question: nu.question });
	// 看板先答：把群里那张卡片一并收掉（它的回调会因 needs_user 已清而直接返回）
	if (!o.requestId && nu.requestId && (db.prepare("SELECT status FROM requests WHERE id = ?").get(nu.requestId) as { status: string } | undefined)?.status === "pending") {
		requests.resolve(nu.requestId, { answer: a }, "user");
	}
	emit(item.room_id);
	if (item.room_id) await postWorkFeedback(item.id, `关于任务「${item.title}」，我的决定：${a}`).catch(() => {});
	return getWorkItemDetail(item.id);
}

/** 最后一次活动：显式进展、执行开始、任务会话里的最新消息（工具调用 / 回复都算）。 */
function lastActivity(item: WorkItemRow) {
	const msg = db.prepare("SELECT MAX(m.created_at) AS t FROM messages m JOIN work_exec_conversations w ON w.conversation_id = m.conversation_id WHERE w.work_item_id = ?").get(item.id) as { t: number | null };
	const run = db.prepare("SELECT MAX(COALESCE(finished_at, started_at, created_at)) AS t FROM work_item_runs WHERE work_item_id = ?").get(item.id) as { t: number | null };
	return Math.max(item.last_progress_at ?? 0, msg.t ?? 0, run.t ?? 0, item.created_at);
}

/** 卡住检测（定时调用，测试可直接调）：只看进行中 / 受阻 / 待核验、还没在等用户的任务。 */
export async function checkStalls(at = now(), stallMs = STALL_MS()) {
	const rows = db.prepare("SELECT * FROM work_items WHERE status IN ('active','blocked','review') AND needs_user IS NULL").all() as unknown as WorkItemRow[];
	let n = 0;
	for (const item of rows) {
		const last = lastActivity(item);
		const level = stallStep({ active: true, needsUser: false, lastActivityAt: last, escalation: escalationOf(item), now: at, stallMs });
		if (!level) continue;
		const mins = Math.max(1, Math.round((at - last) / 60_000));
		const who = item.status === "review" ? "管理者" : agentName(item.owner_agent_id) || "负责人";
		await escalate(item.id, "stall", level, level === "manager" ? `已经 ${mins} 分钟没有进展（${who}）` : `管理者介入后仍然 ${mins} 分钟没有进展`);
		n++;
	}
	return n;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startWorkWatch() {
	if (timer) return;
	timer = setInterval(() => void checkStalls().catch((e) => console.warn(`[work] 卡住检测失败：${e instanceof Error ? e.message : e}`)), Math.min(60_000, Math.max(5_000, STALL_MS() / 2)));
	timer.unref?.();
}
