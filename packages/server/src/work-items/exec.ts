/**
 * 长期任务的执行（决策 0014 第 5 步）：每次执行是负责人派的一个「帮手」（subagents kind=work），
 * 挂在负责人**自己的**隐藏任务会话上（它自己的记忆、权限、电脑），不进群的发言队列、不占群的每轮上限，
 * 群「停止」也不会停它（只能单个暂停 / 一键全停）。重启续跑、卡住处理、停止、并发上限都复用帮手那一套。
 *
 * 任务会话通过 work_exec_conversations 映射回来源群：群里能看到帮手卡片（在做什么、做到哪一步、结果）、
 * 审批卡片、提交的结果卡；工具步骤和命令输出留在帮手详情里（谁能看见 helper-scope.ts 的设置）。
 * 管理者只在关键事件被唤醒（提交、卡住、执行结束没提交、超时没进展、反复卡在同一处）。
 */
import { createConversation } from "../conversations.ts";
import { db, now, uid } from "../db.ts";
import { insertMessage } from "../messages.ts";
import { bus } from "../bus.ts";
import { helperScope } from "../helper-scope.ts";
import { memory } from "../memory/index.ts";
import { getAgent, runtime } from "../runtime.ts";
import { getSubagent, isActiveSubagent, isLiveSubagent, messageSubagent, spawnSubagent, stopSubagent, type Subagent } from "../subagents.ts";
import { fingerprint, repeatLevel, type EscalationLevel } from "../stuck.ts";
import { port } from "./ports.ts";
import {
	agentName,
	clip,
	emit,
	event,
	fail,
	getWorkItemDetail,
	itemRow,
	roomNotice,
	roomRow,
	submissionApplies,
	type WorkActor,
	type WorkItemRow,
	type WorkRunRow,
	type WorkRunStatus,
} from "./store.ts";
import { askNeed, escalate, HANDLE_HINT } from "./watch.ts";

const runRow = (id: string) => db.prepare("SELECT * FROM work_item_runs WHERE id = ?").get(id) as WorkRunRow | undefined;

/** 正在跑的执行：runId → 负责人和它的任务会话（用于提交校验、暂停中止、把同伴回复送进去） */
const live = new Map<string, { itemId: string; agentId: string; conversationId: string }>();
export const liveRunOf = (itemId: string) => [...live.entries()].find(([, v]) => v.itemId === itemId)?.[0] ?? null;

export interface ExecConversation {
	conversation_id: string;
	work_item_id: string;
	agent_id: string;
	room_id: string | null;
}
export const execOf = (conversationId: string | null | undefined) =>
	conversationId ? (db.prepare("SELECT * FROM work_exec_conversations WHERE conversation_id = ?").get(conversationId) as ExecConversation | undefined) : undefined;
export const execConversationsOfRoom = (roomId: string) => (db.prepare("SELECT conversation_id FROM work_exec_conversations WHERE room_id = ?").all(roomId) as { conversation_id: string }[]).map((r) => r.conversation_id);

/** 负责人在这个任务上的会话：同一个人接着用同一个会话（保留上下文），改派给别人就是另一个会话。 */
export function execConversation(item: WorkItemRow, agentId: string): string {
	const row = db.prepare("SELECT w.conversation_id FROM work_exec_conversations w JOIN conversations c ON c.id = w.conversation_id WHERE w.work_item_id = ? AND w.agent_id = ? ORDER BY w.created_at DESC LIMIT 1").get(item.id, agentId) as { conversation_id: string } | undefined;
	if (row) return row.conversation_id;
	const c = createConversation(agentId, `任务：${item.title}`.slice(0, 60), { makeCurrent: false });
	db.prepare("UPDATE conversations SET hidden = 1 WHERE id = ?").run(c.id);
	db.prepare("INSERT INTO work_exec_conversations(conversation_id, work_item_id, agent_id, room_id, created_at) VALUES(?,?,?,?,?)").run(c.id, item.id, agentId, item.room_id, now());
	return c.id;
}

export function workPrompt(item: WorkItemRow) {
	return [
		`【长期任务】${item.title}`,
		item.requirement ? `要求：${item.requirement}` : "",
		item.done_criteria ? `完成标准：${item.done_criteria}` : "",
		`任务编号：${item.id}（提交时用这个编号，不要在回复里自己认定完成）`,
	].filter(Boolean).join("\n");
}

function execPrompt(item: WorkItemRow, run: WorkRunRow) {
	const room = item.room_id ? roomRow(item.room_id) : undefined;
	const lastReturn = db.prepare("SELECT detail FROM work_item_events WHERE work_item_id = ? AND kind IN ('verified.return','decided') ORDER BY created_at DESC, rowid DESC LIMIT 1").get(item.id) as { detail: string } | undefined;
	const note = lastReturn ? String((JSON.parse(lastReturn.detail) as { note?: string; answer?: string }).note ?? (JSON.parse(lastReturn.detail) as { answer?: string }).answer ?? "") : "";
	return [
		`（群聊「${room?.name ?? ""}」的长期任务 · 你是 ${agentName(run.owner_agent_id)}）`,
		`管理者 ${agentName(room?.manager_id ?? null) || "管理者"} 给你分配了任务：${item.title}`,
		workPrompt(item),
		run.task && run.task !== workPrompt(item) ? `派活说明：${run.task.slice(0, 2000)}` : "",
		note && item.revision > 1 ? `最近一次意见：${note.slice(0, 1000)}` : "",
		`这是第 ${run.revision} 次修订的执行，由你的帮手在你自己的任务会话里进行（用你自己的记忆、权限和电脑），不占群里的发言。群里能看到你在做什么和结果，工具步骤留在详情里。`,
		"做完用 work_submit 提交结果（产物在哪、怎么检查）；做不下去就用 work_submit 写清真实阻塞；中途有阶段性进展用 work_report。不要自行把任务标成完成，也不要只聊天不干活。",
	].filter(Boolean).join("\n");
}

export function createRun(item: WorkItemRow, owner: string, o: { task: string }): WorkRunRow {
	const id = uid("wr");
	db.prepare("INSERT INTO work_item_runs(id, work_item_id, revision, owner_agent_id, exec_kind, exec_id, status, task, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, item.id, item.revision, owner, "session", null, "queued", clip(o.task, 8000), now());
	return runRow(id)!;
}

/** 有真实进展：记时间、清掉上报（卡住计时从这里重新算），群里「只聊不干活」计数清零。 */
export function recordProgress(item: Pick<WorkItemRow, "id" | "room_id">) {
	db.prepare("UPDATE work_items SET last_progress_at = ?, escalation = NULL WHERE id = ?").run(now(), item.id);
	if (item.room_id) port()?.noteProgress(item.room_id);
}

/** 派出一次执行：立刻派负责人的帮手开始（不排进群队列，帮手名额满了就排队），结束后回到 finishRun。 */
export function dispatchRun(item: WorkItemRow, run: WorkRunRow) {
	const conv = execConversation(item, run.owner_agent_id);
	const a = getAgent(run.owner_agent_id);
	const model = a ? runtime(run.owner_agent_id, conv).modelFor(a) : null;
	if (!model) throw new Error("负责人没有可用的模型");
	live.set(run.id, { itemId: item.id, agentId: run.owner_agent_id, conversationId: conv });
	let h: Subagent;
	try {
		h = spawnSubagent(run.owner_agent_id, conv, model, { task: execPrompt(itemRow(item.id) ?? item, run), kind: "work", title: `任务：${item.title}`.slice(0, 60), workRunId: run.id, scope: helperScope(run.owner_agent_id, conv) });
	} catch (e) {
		live.delete(run.id);
		throw e;
	}
	const t = now();
	db.prepare("UPDATE work_item_runs SET status = 'running', started_at = ?, exec_kind = 'helper', exec_id = ? WHERE id = ? AND status = 'queued'").run(t, h.id, run.id);
	db.prepare("UPDATE work_items SET status = CASE WHEN status = 'blocked' THEN 'active' ELSE status END, updated_at = ? WHERE id = ? AND revision = ?").run(t, item.id, item.revision);
	recordProgress(item);
	event(item.id, "run.started", { kind: "agent", agentId: run.owner_agent_id }, run.revision, { runId: run.id, conversationId: conv, helperId: h.id });
	emit(item.room_id);
}

/** 执行帮手到终态：映射成这次执行的结束（帮手续聊后再次结束不重复记）。 */
function helperEnded(r: Subagent) {
	const run = r.work_run_id ? runRow(r.work_run_id) : undefined;
	if (!run || !["queued", "running"].includes(run.status) || run.exec_id !== r.id) return;
	live.delete(run.id);
	const status: WorkRunStatus = r.status === "done" ? "done" : r.status === "stopped" ? "cancelled" : r.status === "lost" ? "interrupted" : "error";
	try {
		finishRun(run.id, status, r.result_summary ?? "", status === "error" ? r.error_reason || "执行失败" : null);
	} catch (e) {
		console.warn(`[work] 收尾失败：${e instanceof Error ? e.message : e}`);
	}
}
bus.on((e) => {
	const r = (e as { type: string; subagent?: Subagent }).type === "subagent.updated" ? (e as { subagent?: Subagent }).subagent : undefined;
	if (r?.kind === "work" && !isLiveSubagent(r.status)) helperEnded(r);
});
const helperOfRun = (runId: string) => {
	const run = runRow(runId);
	return run?.exec_kind === "helper" && run.exec_id ? getSubagent(run.exec_id) : undefined;
};

/**
 * 核验通过后：这一修订的执行帮手（含它们派的下一层）写下的记忆草稿自动转正（决策 0014）。
 * 没通过核验的修订、不属于任务的草稿都不动，仍等主会话确认。返回转正了几条。
 */
export async function promoteRunMemories(itemId: string, revision: number) {
	const runs = db.prepare("SELECT exec_id, owner_agent_id FROM work_item_runs WHERE work_item_id = ? AND revision = ? AND exec_kind = 'helper' AND exec_id IS NOT NULL").all(itemId, revision) as { exec_id: string; owner_agent_id: string }[];
	let n = 0;
	for (const owner of new Set(runs.map((r) => r.owner_agent_id))) {
		const top = runs.filter((r) => r.owner_agent_id === owner).map((r) => r.exec_id);
		const kids = top.flatMap((id) => (db.prepare("SELECT id FROM subagents WHERE parent_subagent_id = ?").all(id) as { id: string }[]).map((k) => k.id));
		const ids = new Set([...top, ...kids]);
		for (const d of await memory.listDrafts(owner)) {
			if (!d.taskId || !ids.has(d.taskId)) continue;
			await memory.promote(owner, d.id, { actor: "main" });
			n++;
		}
	}
	if (n) event(itemId, "memory.promoted", { kind: "user" }, revision, { count: n });
	return n;
}

/** 派发本身失败（负责人不可用等）：执行记失败、任务明确受阻，不留假“进行中”。 */
export function failRun(item: WorkItemRow, run: WorkRunRow, e: unknown) {
	const msg = e instanceof Error ? e.message : String(e);
	db.prepare("UPDATE work_item_runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(msg.slice(0, 1000), now(), run.id);
	db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, updated_at = ? WHERE id = ? AND revision = ?").run(`无法开始执行：${msg.slice(0, 300)}`, now(), item.id, item.revision);
	event(item.id, "dispatch.failed", { kind: "user" }, item.revision, { error: msg.slice(0, 500) });
}

/** 这条阻塞 / 失败 / 退回理由在本任务里出现过几次（反复卡在同一处）。 */
export function repeatOf(itemId: string, text: string): { fp: string; level: EscalationLevel | null } {
	const fp = fingerprint(text);
	if (!fp) return { fp, level: null };
	const prev = (db.prepare("SELECT detail FROM work_item_events WHERE work_item_id = ? AND kind IN ('submitted.blocked','run.finished','verified.return')").all(itemId) as { detail: string }[]).map((r) => String((JSON.parse(r.detail) as { fp?: string }).fp ?? ""));
	return { fp, level: repeatLevel(prev, fp) };
}

/**
 * 卡住时：原因是只有用户能给的东西（批准 / 登录凭据）就直接问用户要这个；
 * 否则重复的按「反复卡在同一处」走阶梯（第 2 次第 1 级、第 3 次起升级）；第一次只是叫管理者自己处理。
 */
function stuck(item: WorkItemRow, what: string, rep: { level: EscalationLevel | null }) {
	if (askNeed(item.id, what)) return;
	if (rep.level) escalate(item.id, "repeat", rep.level, `反复卡在同一处：${what.slice(0, 160)}`);
	else if (item.room_id) port()?.wakeManager(item.room_id, `${agentName(item.owner_agent_id)} 在任务「${item.title}」上卡住了：${what.slice(0, 200)}。${HANDLE_HINT}`, item.id);
}

/** 一次执行结束（成功 / 失败 / 取消）：只记录执行，绝不自动把任务标成完成或待核验。 */
export function finishRun(runId: string, status: WorkRunStatus, text: string, error?: string | null) {
	const run = runRow(runId);
	if (!run) return;
	if (["cancelled", "interrupted"].includes(run.status) && status !== "done") return; // 已经由暂停 / 取消 / 重启记录过
	const result = clip(text, 20_000);
	const rep = status === "error" ? repeatOf(run.work_item_id, error ?? "") : { fp: "", level: null };
	db.prepare("UPDATE work_item_runs SET status = ?, result = COALESCE(result, ?), error = ?, finished_at = ? WHERE id = ?").run(status, result || null, error?.slice(0, 1000) ?? null, now(), run.id);
	const item = itemRow(run.work_item_id);
	if (!item) return;
	if (item.revision !== run.revision) {
		event(item.id, "run.late", { kind: "agent", agentId: run.owner_agent_id }, run.revision, { runId: run.id, status });
		emit(item.room_id);
		return;
	}
	const submitted = !!runRow(run.id)?.submitted_at;
	// 执行结束 ≠ 任务完成：最多更新“最近进度”，等负责人提交 / 管理者核验。
	const progress = status === "error" ? `执行出错：${(error ?? "").slice(0, 300)}` : status === "cancelled" ? "执行已取消" : status === "interrupted" ? "执行中断（服务重启），可继续" : `执行结束，没有提交结果${result ? `：${result.slice(0, 200)}` : ""}`;
	if (["active", "blocked"].includes(item.status) && !submitted) {
		// 执行失败：明确标成受阻（而不是无执行却永远“进行中”），仍需管理者处理。
		const nextStatus = status === "error" && item.status === "active" ? "blocked" : item.status;
		const blocker = status === "error" ? `执行失败：${(error ?? "").slice(0, 500)}` : status === "interrupted" ? "执行中断（服务重启）" : item.blocker;
		db.prepare("UPDATE work_items SET status = ?, latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(nextStatus, progress, blocker, now(), item.id, item.revision);
	}
	event(item.id, "run.finished", { kind: "agent", agentId: run.owner_agent_id }, run.revision, { runId: run.id, status, ...(rep.fp ? { fp: rep.fp } : {}) });
	if (status === "error") {
		roomNotice(item.room_id, `任务「${item.title}」这次执行失败了：${(error ?? "").slice(0, 200)}。还在原任务上，已请管理者处理。`, item.id);
		stuck(item, `执行失败：${error ?? ""}`, rep);
	} else if (status === "interrupted") roomNotice(item.room_id, `任务「${item.title}」执行中断（服务重启），可继续。`, item.id);
	else if (status === "done" && !submitted && ["active", "blocked"].includes(item.status) && item.room_id) {
		port()?.wakeManager(item.room_id, `${agentName(run.owner_agent_id)} 的任务「${item.title}」这次执行结束了，但没有提交结果`, item.id);
	}
	if (status === "done" && result && item.room_id) port()?.peerMentions(item.room_id, run.owner_agent_id, result);
	emit(item.room_id);
}

/** 宿主绑定的执行上下文：只认这个任务会话里正在跑的那次执行，不信模型自报 runId。 */
function liveContext(itemId: string, agentId: string, conversationId: string) {
	const entry = [...live.entries()].find(([, v]) => v.itemId === itemId && v.agentId === agentId && v.conversationId === conversationId);
	return entry ? runRow(entry[0]) : undefined;
}

/** 成员提交：只认自己、只认本任务会话里真实在跑的执行、只认当前修订；晚到的提交只留历史。 */
export function submitWorkItem(o: { workItemId: string; conversationId: string; actor: WorkActor; result?: string; blocker?: string }) {
	const actor = o.actor;
	if (actor.kind === "user") fail("成员提交结果不能由用户代提交", "owner_only");
	const exec = execOf(o.conversationId);
	if (!exec || exec.work_item_id !== o.workItemId || exec.agent_id !== actor.agentId) fail("只能在这个任务自己的执行会话里提交", "no_run_context");
	const run = liveContext(o.workItemId, actor.agentId, o.conversationId);
	if (!run) fail("当前没有这项任务的执行在进行，不能提交", "no_run_context");
	const row = itemRow(o.workItemId);
	if (!row) fail("没有可提交的任务", "not_found");
	const result = clip(o.result, 20_000);
	const blocker = clip(o.blocker, 2000);
	if (!result && !blocker) fail("提交要写结果或阻塞原因", "empty_submit");
	// 晚到的结果：负责人 / 修订已经变了，或这次执行已被暂停 / 取消 → 只记历史
	if (row.owner_agent_id !== actor.agentId || run.status !== "running" || !submissionApplies({ itemRevision: row.revision, itemOwner: row.owner_agent_id, itemStatus: row.status, runRevision: run.revision, runOwner: run.owner_agent_id })) {
		event(row.id, "submit.late", actor, row.revision, { result: result.slice(0, 500), blocker: blocker.slice(0, 500), runId: run.id });
		emit(row.room_id);
		return { applied: false as const, item: getWorkItemDetail(row.id) };
	}
	const rep = blocker ? repeatOf(row.id, blocker) : { fp: "", level: null };
	const t = now();
	db.prepare("UPDATE work_items SET status = ?, latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(
		blocker ? "blocked" : "review", blocker ? `受阻：${blocker}` : `已提交，等待核验：${result.slice(0, 300)}`, blocker || null, t, row.id, row.revision,
	);
	db.prepare("UPDATE work_item_runs SET result = ?, blocker = ?, submitted_at = ? WHERE id = ?").run(result || null, blocker || null, t, run.id);
	recordProgress(row);
	// 群里留一张结果卡：用户可以引用这张卡指出问题，服务端据此可信定位到同一个任务。
	insertMessage({
		agentId: actor.agentId,
		roomId: row.room_id,
		role: "card",
		meta: { kind: "work-result", workItemId: row.id, roomId: row.room_id, runId: run.id, title: row.title, ownerAgentId: actor.agentId, status: blocker ? "blocked" : "review", summary: (blocker || result).slice(0, 1000), revision: row.revision },
	});
	event(row.id, blocker ? "submitted.blocked" : "submitted", actor, row.revision, { runId: run.id, result: result.slice(0, 1000), blocker: blocker.slice(0, 500), ...(rep.fp ? { fp: rep.fp } : {}) });
	if (blocker) {
		roomNotice(row.room_id, `任务「${row.title}」被 ${agentName(actor.agentId)} 标为受阻：${blocker.slice(0, 200)}。原任务保持，已请管理者处理。`, row.id);
		stuck(row, blocker, rep);
	} else if (row.room_id) port()?.wakeManager(row.room_id, `${agentName(actor.agentId)} 提交了任务「${row.title}」的结果，等你核验`, row.id);
	emit(row.room_id);
	return { applied: true as const, item: getWorkItemDetail(row.id) };
}

/** 阶段性进展：只更新最近进度和计时，不改状态；让「卡住没进展」的检测知道它还在干活。 */
export function reportProgress(o: { workItemId: string; conversationId: string; actor: WorkActor; note: string }) {
	if (o.actor.kind === "user") fail("进展由负责人汇报", "owner_only");
	const run = liveContext(o.workItemId, o.actor.agentId, o.conversationId);
	if (!run || run.status !== "running") fail("当前没有这项任务的执行在进行", "no_run_context");
	const row = itemRow(o.workItemId)!;
	const note = clip(o.note, 1000);
	if (!note) fail("写一句做到哪了", "empty");
	if (row.revision !== run.revision) return getWorkItemDetail(row.id);
	db.prepare("UPDATE work_items SET latest_progress = ?, updated_at = ? WHERE id = ? AND revision = ?").run(note, now(), row.id, row.revision);
	recordProgress(row);
	event(row.id, "progress", o.actor, row.revision, { note: note.slice(0, 500) });
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}

/** 取消本任务的排队 / 运行中执行；只中止这个任务会话，不误停别的群、主会话或其他成员。 */
export async function cancelWorkRuns(itemId: string, o: { abortCurrent: boolean }) {
	const runs = db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? AND status IN ('queued','running')").all(itemId) as unknown as WorkRunRow[];
	// 先把业务执行记录落成 cancelled（同步），再做中止（异步）；调用方即使不 await 也不会留下假“运行中”。
	for (const run of runs) db.prepare("UPDATE work_item_runs SET status = 'cancelled', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status IN ('queued','running')").run(now(), run.id);
	if (!o.abortCurrent) return;
	for (const run of runs) {
		live.delete(run.id);
		const h = run.exec_kind === "helper" && run.exec_id ? getSubagent(run.exec_id) : undefined;
		if (h && isLiveSubagent(h.status)) await stopSubagent(h.id).catch(() => {});
	}
}

/** 自主模式下同伴在群里回复了正在执行任务的成员：作为插话送进它的任务会话（下一个工具边界生效）。 */
export function steerToLiveRun(roomId: string, agentId: string, text: string) {
	for (const [runId, l] of live) {
		if (l.agentId !== agentId || itemRow(l.itemId)?.room_id !== roomId) continue;
		const h = helperOfRun(runId);
		if (h && isActiveSubagent(h.status)) void messageSubagent(h.id, text).catch(() => {});
		return true;
	}
	return false;
}

/**
 * 重启：帮手执行交给帮手的重启判定（安全就续跑、不安全标中断待核验），这里只接回执行上下文；
 * 旧版在会话里跑的执行（“发出去了但不知道结果”）标成中断，任务状态保持原样（不自动完成、不自动重派）。
 * 之后由「卡住没进展」的检测叫管理者来决定是否继续。
 */
export function bootstrapWorkItems() {
	const rows = db.prepare("SELECT * FROM work_item_runs WHERE status IN ('queued','running')").all() as unknown as WorkRunRow[];
	let n = 0;
	for (const run of rows) {
		const h = helperOfRun(run.id);
		if (h && isLiveSubagent(h.status)) {
			const conv = h.conversation_id;
			live.set(run.id, { itemId: run.work_item_id, agentId: run.owner_agent_id, conversationId: conv });
			continue;
		}
		if (h) { helperEnded(h); n++; continue; }
		db.prepare("UPDATE work_item_runs SET status = 'interrupted', finished_at = ? WHERE id = ? AND status IN ('queued','running')").run(now(), run.id);
		const item = itemRow(run.work_item_id);
		if (!item) continue;
		if (item.revision === run.revision && ["active", "blocked"].includes(item.status)) db.prepare("UPDATE work_items SET latest_progress = '执行中断（服务重启），可继续', updated_at = ? WHERE id = ? AND revision = ?").run(now(), item.id, item.revision);
		event(item.id, "run.interrupted", { kind: "user" }, run.revision, { runId: run.id });
		n++;
	}
	return n;
}
