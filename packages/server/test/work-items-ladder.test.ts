/** 群任务的卡住 / 反复退回三级阶梯（管理者自己处理 → 最后提醒 → 已用尽办法），以及只有用户能给的东西才问用户。环境见 work-items-harness.ts。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { W, db, mgr, now, room, row, runRows, settle, started, submit, user, a, checkPrompts, makeItem, wakes } from "./work-items-harness.ts";

/** 这个任务的某类事件（按发生顺序） */
const evs = (id: string, kind: string) => db.prepare("SELECT detail FROM work_item_events WHERE work_item_id = ? AND kind = ? ORDER BY rowid").all(id, kind) as { detail: string }[];
const pendingQuestions = (id: string) => (db.prepare("SELECT COUNT(*) AS n FROM requests WHERE kind = 'question' AND status = 'pending' AND json_extract(payload, '$.question') LIKE ?").get(`%${row(id).title}%`) as { n: number }).n;
/** 提交 → 退回一轮（执行跑完，管理者核验退回） */
async function returnOnce(id: string, note: string) {
	const c = await started(id);
	submit(c, { result: "又一版" });
	c.finish();
	await settle();
	await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "return", note });
}
const systemNotices = (roomId: string) => (db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'system' ORDER BY rowid").all(roomId) as { content: string }[]).map((m) => m.content);

test("反复退回仍不通过：不问用户，原样重做停用并要管理者换做法；改派后新负责人有完整次数，再撞到直接「已用尽办法」", async () => {
	const id = makeItem("wa", true);
	const notes = ["缺检查点", "来源链接不对", "格式不统一", "第三节漏了图表"];
	for (let i = 0; i < 4; i++) await returnOnce(id, notes[i]);
	await settle();
	const d = row(id);
	assert.equal(d.status, "blocked");
	assert.equal(d.board, "stuck", "落在卡住组，不进等你决定");
	assert.equal(d.needsUser, null, "不问用户");
	assert.equal(pendingQuestions(id), 0);
	assert.equal(d.escalation?.rung, 2, "第 2 级：最后提醒");
	assert.match(d.blocker ?? "", /原样重做已停用/);
	assert.equal(evs(id, "final_warning").length, 1);
	assert.equal(runRows(id).filter((r) => r.status === "running").length, 0, "没有偷偷再跑");
	assert.ok(!checkPrompts().some((p) => p.includes(id) && /最后一次提醒/.test(p)), "管理者自己核验的这一次：最后提醒在工具返回里，不另外唤醒");
	// 管理者原样继续：被拒，且这是最后提醒之后的又一次 → 已用尽办法
	await assert.rejects(() => W.continueWorkItem({ workItemId: id, actor: mgr }), /已用尽办法/);
	assert.match(row(id).blocker ?? "", /^已用尽办法/);
	assert.equal(evs(id, "exhausted").length, 1);
	assert.equal(row(id).needsUser, null, "已用尽办法是通知不是提问");
	// 用户动作清掉计数和「最后提醒」记录
	await W.continueWorkItem({ workItemId: id, actor: user });
	assert.equal(row(id).autoRetries, 0);
	assert.equal(row(id).escalation, null);
	const c0 = await started(id);
	submit(c0, { result: "用户让继续后的一版" });
	c0.finish();
	await settle();
	// 记录已清：再到上限，重新从最后提醒开始
	db.prepare("UPDATE work_items SET auto_retries = ? WHERE id = ?").run(3, id);
	await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "return", note: "用户继续后仍缺检查点" });
	assert.equal(row(id).escalation?.rung, 2, "用户动作后最后提醒重新可用");
	// 管理者改派给乙：auto_retries 清零，新负责人有完整次数；最后提醒不会再给第二次
	W.editWorkItem({ workItemId: id, actor: mgr, ownerAgentId: "wb" });
	assert.equal(row(id).autoRetries, 0);
	assert.equal(row(id).status, "active");
	await W.continueWorkItem({ workItemId: id, actor: mgr });
	for (let i = 0; i < 5 && row(id).status !== "blocked"; i++) await returnOnce(id, `乙的第 ${i} 版：还是不行 ${["缺图", "缺表", "缺注", "缺源", "缺页"][i]}`);
	assert.equal(row(id).status, "blocked");
	assert.match(row(id).blocker ?? "", /^已用尽办法/, "换人后再撞到第 2 级的条件，直接已用尽办法");
	assert.equal(row(id).board, "stuck");
	assert.equal(row(id).needsUser, null);
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("办法用尽：群里写失败总结（目标 / 试过什么 / 卡在哪）并推送给用户，不设等你决定；用户继续后照常工作", async () => {
	const { pushLog } = await import("../src/push.ts");
	const id = makeItem("wa", true);
	db.prepare("UPDATE work_items SET title = ? WHERE id = ?").run("失败总结探针", id);
	const p0 = pushLog.length;
	for (let i = 0; i < 3; i++) await returnOnce(id, "缺检查点");
	// 同一理由第 3 次退回已是最后提醒；管理者仍原样续做、又被同样的理由退回 → 用尽
	assert.equal(row(id).escalation?.rung, 2);
	await W.continueWorkItem({ workItemId: id, actor: mgr });
	await returnOnce(id, "缺检查点");
	const d = row(id);
	assert.equal(d.board, "stuck");
	assert.equal(d.needsUser, null);
	assert.equal(d.escalation?.rung, 3);
	const summary = systemNotices(room.id).filter((t) => t.includes("失败总结探针") && t.includes("已用尽办法")).pop() ?? "";
	assert.match(summary, /目标：失败总结探针；完成标准：结果里能看到检查点/);
	assert.match(summary, /试过：.*执行 \d+ 次.*被退回 \d+ 次/);
	assert.match(summary, /卡在哪：.*最近退回：缺检查点/);
	assert.ok(pushLog.length > p0 && pushLog.slice(p0).some((x) => /办法用尽/.test(x.title)), "推送给用户");
	assert.equal(pushLog.slice(p0).filter((x) => /办法用尽/.test(x.title)).length, 1);
	// 再被管理者拒绝不会重复通知
	db.prepare("UPDATE work_items SET auto_retries = 3 WHERE id = ?").run(id);
	await assert.rejects(() => W.continueWorkItem({ workItemId: id, actor: mgr }), /已用尽办法/);
	assert.equal(systemNotices(room.id).filter((t) => t.includes("失败总结探针") && t.includes("已用尽办法")).length, 1);
	assert.equal(pushLog.slice(p0).filter((x) => /办法用尽/.test(x.title)).length, 1);
	// 用户在看板上继续，照现有逻辑工作
	await W.userAction(id, "continue", {});
	assert.equal(row(id).status, "active");
	assert.equal(row(id).escalation, null);
	assert.equal(row(id).blocker, null);
	await started(id);
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("retry limit：管理者再派被拒但不问用户，报错里是换做法指引；再撞到就是已用尽办法；改派清计数但最后提醒只给一次", async () => {
	const id = makeItem("wa", true);
	const c = await started(id);
	c.finish({ text: "没提交" });
	await settle();
	db.prepare("UPDATE work_items SET auto_retries = ? WHERE id = ?").run(3, id);
	const reject = (fn: () => unknown) => assert.throws(fn, (e: Error & { code?: string }) => e.code === "retry_limit" && /换做法/.test(e.message) && /改派给别的成员/.test(e.message) && !/等你决定/.test(e.message));
	reject(() => W.dispatchFromRoom(room.id, "wa", id));
	assert.equal(row(id).needsUser, null, "不问用户");
	assert.equal(pendingQuestions(id), 0);
	assert.equal(row(id).escalation?.rung, 2);
	assert.equal(evs(id, "final_warning").length, 1);
	// 管理者仍原样再派：已用尽办法
	assert.throws(() => W.dispatchFromRoom(room.id, "wa", id), (e: Error) => /已用尽办法/.test(e.message));
	assert.match(row(id).blocker ?? "", /^已用尽办法/);
	assert.equal(evs(id, "exhausted").length, 1);
	// 用户在看板上改派：计数清零；用户的继续清掉最后提醒记录，下一轮又能从最后提醒开始
	W.editWorkItem({ workItemId: id, actor: user, ownerAgentId: "wb" });
	assert.equal(row(id).autoRetries, 0);
	await W.continueWorkItem({ workItemId: id, actor: user });
	const c2 = await started(id);
	c2.finish({ text: "乙也没提交" });
	await settle();
	db.prepare("UPDATE work_items SET auto_retries = ? WHERE id = ?").run(3, id);
	reject(() => W.dispatchFromRoom(room.id, "wb", id));
	// 管理者改派回甲：auto_retries 清零，但最后提醒已经给过 → 再撞直接用尽
	W.editWorkItem({ workItemId: id, actor: mgr, ownerAgentId: "wa" });
	assert.equal(row(id).autoRetries, 0);
	db.prepare("UPDATE work_items SET auto_retries = ? WHERE id = ?").run(3, id);
	assert.throws(() => W.dispatchFromRoom(room.id, "wa", id), (e: Error) => /已用尽办法/.test(e.message));
	assert.equal(evs(id, "exhausted").length, 2, "用户动作之后新的一轮用尽，各通知一次");
	// 修改要求不清重试计数（防死循环）
	W.editWorkItem({ workItemId: id, actor: mgr, requirement: "换个说法的要求" });
	assert.equal(row(id).autoRetries, 3);
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("同样的退回理由出现第三次：算反复卡在同一处，进最后提醒（卡住组、不问用户）", async () => {
	const id = makeItem("wa", true);
	for (let i = 0; i < 3; i++) await returnOnce(id, `第 ${i + 1} 次：还是缺第 3 行检查点`);
	await settle();
	assert.equal(row(id).board, "stuck");
	assert.equal(row(id).needsUser, null);
	assert.equal(row(id).escalation?.rung, 2);
	assert.equal(row(id).status, "blocked");
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("执行失败：明确受阻并叫管理者；同样的失败反复出现 → 第 1 级，再 → 最后提醒（不问用户）", async () => {
	const id = makeItem("wa", true);
	const fails = async () => {
		const c = await started(id);
		c.finish({ error: "连接 api.example.com 超时（第 3 次）" });
		await settle();
	};
	const w0 = wakes(room.id);
	await fails();
	assert.equal(row(id).status, "blocked");
	assert.equal(row(id).board, "stuck");
	assert.ok(wakes(room.id) > w0);
	assert.ok(checkPrompts().some((p) => p.includes(id) && /不要问用户要不要等/.test(p)), "唤醒文案要求管理者自己处理");
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND role = 'system' AND content LIKE '%这次执行失败了%'").get(room.id));
	await W.continueWorkItem({ workItemId: id, actor: user });
	await fails();
	assert.equal(row(id).escalation?.kind, "repeat");
	assert.equal(row(id).escalation?.level, "manager");
	assert.equal(row(id).escalation?.rung, 1);
	await W.continueWorkItem({ workItemId: id, actor: user });
	await fails();
	await settle();
	assert.equal(row(id).board, "stuck", "第三次同样卡住 → 最后提醒，仍在卡住组");
	assert.equal(row(id).escalation?.rung, 2);
	assert.equal(row(id).needsUser, null);
	assert.ok(checkPrompts().some((p) => p.includes(`任务「${row(id).title}」`) && /最后一次提醒/.test(p) && /改派给别的成员/.test(p)), "唤醒原因里带最后提醒和换做法（看板没变时只写「和上次一样」，按任务名找）");
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("卡住没进展三级：叫管理者 → 最后提醒 → 已用尽办法（不设等你决定、有失败总结）；汇报进展清掉上报", async () => {
	const { pushLog } = await import("../src/push.ts");
	const id = makeItem("wa", true);
	db.prepare("UPDATE work_items SET title = ? WHERE id = ?").run("卡住三级探针", id);
	const c = await started(id);
	const t0 = now();
	const w0 = wakes(room.id);
	assert.equal(await W.checkStalls(t0 + 1000, 60_000), 0, "没到时间不打扰");
	assert.ok((await W.checkStalls(t0 + 61_000, 60_000)) >= 1);
	assert.equal(row(id).escalation?.kind, "stall");
	assert.equal(row(id).escalation?.rung, 1);
	assert.equal(row(id).board, "stuck");
	assert.ok(wakes(room.id) > w0, "第 1 级唤醒管理者");
	assert.equal(await W.checkStalls(t0 + 70_000, 60_000), 0, "刚叫过管理者，等它处理");
	W.reportProgress({ workItemId: id, conversationId: c.conv, actor: a, note: "数据拉完了，开始写" });
	assert.equal(row(id).escalation, null, "有进展就清掉上报，阶梯重新计");
	assert.equal(row(id).latestProgress, "数据拉完了，开始写");
	const t1 = now();
	await W.checkStalls(t1 + 61_000, 60_000);
	assert.equal(row(id).escalation?.rung, 1, "进展之后重新从第 1 级开始");
	const w1 = wakes(room.id);
	await W.checkStalls(t1 + 122_000, 60_000);
	await settle();
	assert.equal(row(id).escalation?.rung, 2, "管理者介入后仍没进展 → 最后提醒");
	assert.equal(row(id).board, "stuck");
	assert.equal(row(id).needsUser, null);
	assert.ok(wakes(room.id) > w1);
	assert.equal(evs(id, "final_warning").length, 1);
	assert.ok(checkPrompts().some((p) => p.includes(id) && /最后一次提醒/.test(p)));
	// 又有一次进展再卡住：最后提醒不再给第二次，直接已用尽办法
	W.reportProgress({ workItemId: id, conversationId: c.conv, actor: a, note: "又做了一点" });
	const t2 = now();
	const p0 = pushLog.length;
	await W.checkStalls(t2 + 61_000, 60_000);
	assert.equal(row(id).escalation?.rung, 1);
	const w2 = wakes(room.id);
	await W.checkStalls(t2 + 122_000, 60_000);
	await settle();
	const d = row(id);
	assert.equal(d.escalation?.rung, 3);
	assert.ok(wakes(room.id) > w2, "用尽时叫醒管理者，由它向用户说明问题和需要用户帮什么");
	assert.ok(checkPrompts().some((t) => /卡住三级探针/.test(t) && /需要用户帮你什么/.test(t)), "唤醒里带上向用户说明的要求");
	assert.equal(d.status, "blocked");
	assert.match(d.blocker ?? "", /^已用尽办法/);
	assert.equal(d.board, "stuck", "看板在卡住组");
	assert.equal(d.needsUser, null, "是通知不是提问");
	assert.equal(pendingQuestions(id), 0);
	assert.equal(evs(id, "exhausted").length, 1);
	const summary = systemNotices(room.id).filter((t) => t.includes("卡住三级探针") && t.includes("已用尽办法")).pop() ?? "";
	assert.match(summary, /已请管理者向你说明/);
	assert.match(summary, /目标：卡住三级探针/);
	assert.match(summary, /试过：.*上报 \d+ 次/);
	assert.match(summary, /卡在哪：.*没有进展/);
	assert.ok(pushLog.slice(p0).some((x) => /办法用尽/.test(x.title)));
	assert.equal(await W.checkStalls(t2 + 999_000, 60_000), 0, "用尽之后不再重复上报");
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("只有用户能给的东西才问用户：批准 / 凭据类的失败或阻塞，直接问要什么，不走阶梯", async () => {
	const id = makeItem("wa", true);
	const c = await started(id);
	c.finish({ error: "工具调用未获批准：bash 需要授权" });
	await settle();
	const d = row(id);
	assert.equal(d.board, "decision");
	assert.match(d.needsUser?.question ?? "", /^任务「.+」需要你：批准这一步操作或给出相应权限（/);
	assert.deepEqual(d.needsUser?.options, ["已处理，继续", "先暂停这个任务"]);
	assert.equal(d.escalation, null, "没有走阶梯");
	assert.equal(evs(id, "final_warning").length, 0);
	await W.userAction(id, "decide", { answer: "已处理，继续" });
	assert.equal(row(id).needsUser, null);
	// 成员提交的阻塞是缺登录凭据
	await W.continueWorkItem({ workItemId: id, actor: user });
	const c2 = await started(id);
	submit(c2, { blocker: "缺少 API key，没法调用数据接口" });
	assert.equal(row(id).board, "decision");
	assert.match(row(id).needsUser?.question ?? "", /需要你：登录或提供有效的凭据/);
	await W.cancelWorkItem({ workItemId: id, actor: user });
	// 其它阻塞不问用户，只叫管理者
	const id2 = makeItem("wa", true);
	const c3 = await started(id2);
	submit(c3, { blocker: "接口返回格式变了，解析不了" });
	assert.equal(row(id2).needsUser, null);
	assert.equal(row(id2).board, "stuck");
	await W.cancelWorkItem({ workItemId: id2, actor: user });
});

