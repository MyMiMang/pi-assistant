/**
 * 防护与决定（docs/design/group-collaboration.md「防护只做三件事」，用户定：卡住和反复退回由管理者自己解决，办法用尽才报告）。
 * 卡住没进展（超时）和反复卡在同一处（exec.ts 用指纹判断）、反复退回，都走同一个三级阶梯，不再自动把「换方法 / 改派 / 暂停」三选一丢给用户：
 *  1. 第 1 级：唤醒管理者，要求它自己处理（看执行记录和最后的错误，带纠正让负责人重做、拆小）；
 *  2. 第 2 级「最后提醒」：原样重做停用，必须换做法（改派给别的成员、拆小或自己接手）；每个任务只给一次；
 *  3. 第 3 级「已用尽办法」：系统标受阻，叫醒管理者向用户说清问题、需要用户帮什么或哪个决定无权拍板；系统的失败总结和推送是兜底，不是提问。
 * 用户只在两种情况下被问：需要用户才能给的东西（批准 / 授权、登录凭据，见 askNeed）；管理者用 work_ask_user 主动问真正的取舍。
 * 阶梯级数记在 escalation.rung（真实进展会清掉上报，卡住阶梯重新计）；「最后提醒发过没有」按事件算（finalWarned），用户的动作才清掉。
 * 不设固定次数 / 费用 / 令牌上限；这里只做检测和上报。
 */
import { db, now } from "../db.ts";
import { notify } from "../push.ts";
import { requests } from "../requests.ts";
import { postWorkFeedback } from "./correction.ts";
import { nextRung, stallStep, type Escalation, type EscalationKind, type EscalationLevel, type Rung } from "../stuck.ts";
import { userOnlyNeed } from "../subagent-stuck.ts";
import { port } from "./ports.ts";
import { agentName, clip, emit, escalationOf, event, fail, getWorkItemDetail, itemRow, needsUserOf, roomNotice, roomRow, type NeedsUser, type WorkActor, type WorkItemRow } from "./store.ts";

export const STALL_MS = () => Number(process.env.PIA_WORK_STALL_MS) || 20 * 60_000;
const SYSTEM: WorkActor = { kind: "user" };
/** 办法用尽的标记：blocker 以它开头，看板和失败总结据此识别。 */
export const EXHAUSTED_MARK = "已用尽办法";
/** 第 1 级的要求：管理者自己处理，不要问用户。 */
export const HANDLE_HINT = "请你自己处理，不要问用户要不要等：先看负责人的执行记录和最后的错误，判断卡在哪；再带针对性的纠正让负责人重做（退回时写清怎么改，或重新派活），或者把任务拆小。";
/** 第 3 级：办法用尽后由管理者向用户说明（系统总结和推送只是兜底），用户定：说清问题、需要用户帮什么或哪个决定无权拍板。 */
export const REPORT_HINT = "办法已经用尽。请你在群里直接跟用户说清楚：问题是什么、试过什么、卡在哪；需要用户帮你什么（资源 / 批准 / 凭据），或者哪个决定超出了群目标、你无权拍板。需要用户回答的用 work_ask_user 问，给具体选项；不要再原样重做。";
/** 第 2 级（最后提醒）的要求：原样重做已停用，必须换做法。 */
export const SWITCH_HINT = "原样重做已停用，必须换做法：改派给别的成员（work_update assign）、把任务拆小，或者你自己接手。这是最后一次提醒，下次仍不行系统会标「已用尽办法」，由你向用户说明问题和需要用户帮什么。";

/** 最后一次用户动作（开始 / 继续 / 重开 / 回答决定）之后的事件范围：计数、最后提醒都从这里重新算。 */
const SINCE_USER = "rowid > COALESCE((SELECT MAX(rowid) FROM work_item_events WHERE work_item_id = e.work_item_id AND ((kind IN ('started','continued') AND actor = 'user') OR kind IN ('reopened','decided'))), 0)";
const sinceUser = (itemId: string, kinds: string[]) => (db.prepare(`SELECT kind, detail FROM work_item_events e WHERE work_item_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) AND ${SINCE_USER} ORDER BY rowid`).all(itemId, ...kinds) as { kind: string; detail: string }[]);
/** 这个任务自上次用户动作以来是否已经给过管理者「最后提醒」。 */
const finalWarned = (itemId: string) => sinceUser(itemId, ["final_warning"]).length > 0;

/** 办法用尽时群里的失败总结：目标、试过什么（数事件）、卡在哪。 */
function failureSummary(item: WorkItemRow, why: string) {
	const evs = sinceUser(item.id, ["run.started", "verified.return", "reassigned", "escalated"]);
	const n = (k: string) => evs.filter((e) => e.kind === k).length;
	const tried = [["执行", n("run.started")], ["被退回", n("verified.return")], ["改派", n("reassigned")], ["上报", n("escalated")]].filter(([, c]) => c).map(([k, c]) => `${k} ${c} 次`).join("、") || "暂无记录";
	const lastReturn = evs.filter((e) => e.kind === "verified.return").map((e) => String((JSON.parse(e.detail) as { note?: string }).note ?? "")).pop();
	const where = [clip(why, 120), item.blocker && !item.blocker.startsWith(EXHAUSTED_MARK) ? `最近阻塞：${clip(item.blocker, 100)}` : "", lastReturn ? `最近退回：${clip(lastReturn, 100)}` : ""].filter(Boolean).join("；");
	return `任务「${clip(item.title, 40)}」${EXHAUSTED_MARK}，已请管理者向你说明问题和需要你帮什么。\n目标：${clip(item.title, 40)}；完成标准：${clip(item.done_criteria, 80) || "未写"}\n试过：${tried}\n卡在哪：${where}`;
}

/** 第 3 级：标受阻、记事件、群里写失败总结、推送给用户。不设 needs_user（这是通知不是提问）；已经是用尽状态不重复通知。 */
function exhaust(item: WorkItemRow, kind: EscalationKind, why: string, at?: number, wake = true) {
	if (escalationOf(item)?.rung === 3) return;
	const t = now();
	const summary = failureSummary(item, why);
	const esc: Escalation = { kind, level: "user", at: at ?? t, note: clip(`${EXHAUSTED_MARK}：${why}`, 300), rung: 3 };
	// 待核验的任务保持待核验（结果还在等核验，用户能直接核验）；其它标受阻
	const status = item.status === "review" ? "review" : "blocked";
	db.prepare("UPDATE work_items SET status = ?, blocker = ?, latest_progress = ?, escalation = ?, updated_at = ? WHERE id = ?").run(status, clip(`${EXHAUSTED_MARK}：${why}`, 500), `${EXHAUSTED_MARK}，已向用户报告失败总结`, JSON.stringify(esc), t, item.id);
	event(item.id, "exhausted", SYSTEM, item.revision, { why: clip(why, 300), summary });
	roomNotice(item.room_id, summary, item.id);
	// wake=false：调用方就是管理者自己的工具调用，向用户说明的要求直接写在它的报错里
	if (item.room_id && wake) port()?.wakeManager(item.room_id, `任务「${item.title}」${EXHAUSTED_MARK}：${clip(why, 200)}。${REPORT_HINT}`, item.id);
	if (item.room_id) notify({ title: `${roomRow(item.room_id)?.name ?? "群聊"}：任务办法用尽了`, body: `任务「${item.title}」${clip(why, 100)}`, tag: `exhausted-${item.id}`, url: `/?room=${item.room_id}` });
	emit(item.room_id);
}

/**
 * 上报一级。level：manager = 第 1 级；user = 上一级之后仍没解决，升到下一级（最后提醒；给过一次后直接是已用尽办法）。
 * 返回落在第几级；任务已结束 / 在等用户时返回 null。wake=false：调用方就是管理者自己的工具调用，结果直接写进它的报错里，不再另外唤醒。
 */
export function escalate(itemId: string, kind: EscalationKind, level: EscalationLevel, note: string, o: { wake?: boolean; prev?: Escalation | null; at?: number } = {}): Rung | null {
	const item = itemRow(itemId);
	if (!item || ["done", "paused", "cancelled"].includes(item.status) || item.needs_user) return null;
	const rung = nextRung({ level, escalation: o.prev === undefined ? escalationOf(item) : o.prev, finalWarned: finalWarned(item.id) });
	if (rung === 3) {
		exhaust(item, kind, note, o.at, o.wake !== false);
		return rung;
	}
	const esc: Escalation = { kind, level: "manager", at: o.at ?? now(), note: clip(note, 300), rung };
	db.prepare("UPDATE work_items SET escalation = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(esc), now(), item.id);
	event(item.id, "escalated", SYSTEM, item.revision, { ...esc });
	if (rung === 2) event(item.id, "final_warning", SYSTEM, item.revision, { note: esc.note });
	roomNotice(item.room_id, rung === 1 ? `任务「${item.title}」${esc.note}，已请管理者处理。` : `任务「${item.title}」${esc.note}，已提醒管理者换做法（最后一次提醒）。`, item.id);
	if (item.room_id && o.wake !== false) port()?.wakeManager(item.room_id, `任务「${item.title}」${esc.note}。${rung === 1 ? HANDLE_HINT : SWITCH_HINT}`, item.id);
	emit(item.room_id);
	return rung;
}

/**
 * 卡住 / 失败 / 阻塞的原因如果是只有用户能给的东西（批准 / 授权、登录凭据，userOnlyNeed 判断），直接问用户要这个具体的东西，不走阶梯。
 * 返回 true = 已经交给用户（调用方不再往下走阶梯）。
 */
export function askNeed(itemId: string, text: string | null | undefined): boolean {
	const need = userOnlyNeed(text);
	const item = itemRow(itemId);
	if (!need || !item || ["done", "paused", "cancelled"].includes(item.status)) return false;
	if (!item.needs_user) void askUserDecision(item.id, { question: `任务「${item.title}」需要你：${need}（${clip(text, 120)}）`, options: ["已处理，继续", "先暂停这个任务"], reason: clip(text, 300) }).catch(() => {});
	return true;
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
		const pending = requests.question(mc.agentId, null, question, options, true, mc.conversationId, item.project_id ? { projectId: item.project_id } : {});
		nu.requestId = requests.pendingQuestionId(mc.conversationId, question);
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
		const esc = escalationOf(item);
		const level = stallStep({ active: true, needsUser: false, lastActivityAt: last, escalation: esc, now: at, stallMs });
		if (!level) continue;
		const mins = Math.max(1, Math.round((at - last) / 60_000));
		const who = item.status === "review" ? "管理者" : agentName(item.owner_agent_id) || "负责人";
		// 上报之后又有新动静就不算数了（卡住阶梯因真实进展重新计），和 stallStep 用同一个判断
		escalate(item.id, "stall", level, level === "manager" ? `已经 ${mins} 分钟没有进展（${who}）` : `管理者介入后仍然 ${mins} 分钟没有进展`, { prev: esc && esc.at >= last ? esc : null, at });
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
