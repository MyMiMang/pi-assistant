/**
 * 核验（从 actions.ts 拆出）：只有管理者 / 用户；通过 / 退回 / 这条路走不通三种结论。
 * 通过后自动推进下游（launch.ts）、转正执行记忆、必要时把新版本交给下游（upstream.ts）。
 */
import { db, now } from "../db.ts";
import { cancelWorkRuns, createRun, promoteRunMemories, recordProgress, repeatOf, workPrompt } from "./exec.ts";
import { advanceDependents, launch } from "./launch.ts";
import { port } from "./ports.ts";
import { deliverNewVersion, passedBefore } from "./upstream.ts";
import { activeMember, actorKey, actorName, agentName, canAct, clip, emit, event, fail, getWorkItemDetail, itemRow, MAX_AUTO_RETRIES, requireManagerOrUser, roomNotice, WORK_STATUS_LABEL, type WorkActor } from "./store.ts";
import { escalate } from "./watch.ts";

/** 核验：只有管理者 / 用户；必须有检查结论；通过才算完成，退回则开一个新修订继续，走不通就标受阻并交给管理者改计划。 */
export async function verifyWorkItem(o: { workItemId: string; actor: WorkActor; verdict: "pass" | "return" | "impossible"; note: string }) {
	const row = itemRow(o.workItemId);
	if (!row) fail("任务不存在", "not_found");
	requireManagerOrUser(row, o.actor);
	// 管理者自己负责、没走任务会话、直接在群里做完的任务：允许它用「通过」收尾（写清产物在哪），否则这种任务永远停在待安排
	const selfDone = o.verdict === "pass" && o.actor.kind === "agent" && row.owner_agent_id === o.actor.agentId && (row.status === "pending" || row.status === "active");
	if (!selfDone && !canAct(row.status, "verify")) fail(`任务现在是「${WORK_STATUS_LABEL[row.status]}」，还不能核验`, "bad_status");
	const note = clip(o.note, 4000);
	if (!note) fail("核验要写检查结论（看到了什么、为什么通过、退回还是走不通）", "needs_conclusion");
	if (o.verdict !== "pass" && o.verdict !== "return" && o.verdict !== "impossible") fail("核验结论只会是通过、退回或这条路走不通", "bad_verdict");
	const t = now();
	recordProgress(row);
	if (o.verdict === "pass") {
		// 管理者自己直接做完了：停掉还在做同一件事的帮手，免得重复干活、做完又把同样的东西发进群
		if (selfDone) await cancelWorkRuns(row.id, { abortCurrent: true });
		const again = passedBefore(row.id); // 之前已经通过过一次：这次是新版本
		const verification = JSON.stringify({ verdict: "pass", note, by: actorKey(o.actor), byName: actorName(o.actor), at: t, revision: row.revision });
		db.prepare("UPDATE work_items SET status = 'done', latest_progress = ?, blocker = NULL, verification = ?, completed_at = ?, auto_retries = 0, needs_user = NULL, escalation = NULL, updated_at = ? WHERE id = ? AND revision = ?").run(`已核验完成：${note.slice(0, 300)}`, verification, t, t, row.id, row.revision);
		event(row.id, "verified.pass", o.actor, row.revision, { note: note.slice(0, 2000) });
		roomNotice(row.room_id, `任务「${row.title}」核验通过：${note.slice(0, 300)}`, row.id);
		await promoteRunMemories(row.id, row.revision).catch((e) => console.warn(`[work] 执行记忆转正失败：${e instanceof Error ? e.message : e}`));
		advanceDependents(row);
		const stageNote = row.project_id ? port()?.stageMaybeDone(row.project_id, o.actor.kind === "agent" ? o.actor.agentId : undefined) || null : null;
		if (again) deliverNewVersion(itemRow(row.id)!);
		emit(row.room_id);
		return { ...getWorkItemDetail(row.id), stageNote };
	}
	if (o.verdict === "impossible") {
		// 不自动重做、不算 auto_retries：这不是「没做好」，是「这条路走不通」，直接交给管理者换做法或改方案（见 room_project_replan）。
		const verification = JSON.stringify({ verdict: "impossible", note, by: actorKey(o.actor), byName: actorName(o.actor), at: t, revision: row.revision });
		db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, blocker = ?, verification = ?, updated_at = ? WHERE id = ? AND revision = ?").run(`这条路走不通：${note.slice(0, 300)}`, `这条路走不通：${note.slice(0, 500)}`, verification, t, row.id, row.revision);
		event(row.id, "verified.impossible", o.actor, row.revision, { note: note.slice(0, 2000) });
		roomNotice(row.room_id, `任务「${row.title}」这条路走不通：${note.slice(0, 300)}。不会自动重做，已交给管理者换办法或改方案。`, row.id);
		emit(row.room_id);
		return getWorkItemDetail(row.id);
	}
	const rep = repeatOf(row.id, note);
	const revision = row.revision + 1;
	db.prepare("UPDATE work_items SET status = 'active', revision = ?, latest_progress = ?, blocker = NULL, updated_at = ? WHERE id = ? AND revision = ?").run(revision, `已退回修改：${note.slice(0, 300)}`, t, row.id, row.revision);
	event(row.id, "verified.return", o.actor, revision, { note: note.slice(0, 2000), fromRevision: row.revision, ...(rep.fp ? { fp: rep.fp } : {}) });
	// 退回本身就是明确的改进要求 + 原授权仍有效：直接安排原任务下一次执行，不用用户再催「继续」。
	// 任务执行不占群的发言 / 上限，群本轮暂停也不挡它；只在负责人不在、或反复退回时停下。
	const fresh = itemRow(row.id)!;
	const ownerOk = !!fresh.owner_agent_id && !!fresh.room_id && activeMember(fresh.room_id, fresh.owner_agent_id);
	const repeated = fresh.auto_retries >= MAX_AUTO_RETRIES || rep.level === "user";
	// 群里说清为什么退回、接下来谁做什么（负责人不在群里时下面另有一条说明）
	roomNotice(row.room_id, `任务「${row.title}」退回修改：${note.slice(0, 300)}${!ownerOk ? "" : repeated ? "。已经反复退回，不再原样重做，由管理者换做法。" : `。${agentName(fresh.owner_agent_id)} 会按这个意见自动重做。`}`, row.id);
	if (!ownerOk) {
		db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run("退回后负责人已不在群里，待改派", "负责人不可用", now(), fresh.id, fresh.revision);
		roomNotice(fresh.room_id, `任务「${fresh.title}」退回后负责人不在群里，已标为待改派。`, fresh.id);
	} else if (repeated) {
		// 反复退回：不再原样重做，也不问用户——管理者换做法（最后提醒，唤醒只在用户核验时需要；管理者自己核验的结果直接在工具返回里）；给过之后再撞就是已用尽办法
		const rung = escalate(fresh.id, "retry", "user", `反复退回仍未通过（最近：${note.slice(0, 120)}）`, { wake: o.actor.kind === "user" });
		if (rung !== 3) db.prepare("UPDATE work_items SET status = 'blocked', latest_progress = ?, blocker = ?, updated_at = ? WHERE id = ? AND revision = ?").run(`已重做 ${fresh.auto_retries} 次仍在退回，原样重做已停用`, "原样重做已停用，等管理者换做法（改派 / 拆小 / 自己接手）", now(), fresh.id, fresh.revision);
	} else {
		db.prepare("UPDATE work_items SET auto_retries = auto_retries + 1, updated_at = ? WHERE id = ? AND revision = ?").run(now(), fresh.id, fresh.revision);
		event(fresh.id, "auto_retry", o.actor, fresh.revision, { retry: fresh.auto_retries + 1 });
		launch(itemRow(fresh.id)!, createRun(fresh, fresh.owner_agent_id!, { task: workPrompt(fresh) }));
		if (rep.level === "manager" && o.actor.kind === "user") escalate(fresh.id, "repeat", "manager", `又因同样的问题被退回：${note.slice(0, 120)}`);
	}
	emit(row.room_id);
	return getWorkItemDetail(row.id);
}
