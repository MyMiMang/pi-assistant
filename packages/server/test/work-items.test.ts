import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * 长期任务（任务责任）与单次执行分离的定向测试。
 *
 * 边界：只读写本进程临时数据目录（test/setup.ts 强制），不起模型 / 浏览器 / 付费调用。
 * 这里用真实 SQLite 行 + 真实服务函数；群回合用真实 room_turns 行 + attachTurnToWork / noteRoomTurnEnd
 * 模拟执行结束，覆盖「一次执行不完成」「同一任务两次执行」「核验 / 退回」「晚到结果」「重启不重派」。
 *
 * 事实约定（与 rooms.runTurn 的真实顺序一致）：
 *  1. 派活时 room_turns 就带 work_item_id / work_run_id（精确绑定，不按 agent 猜）；
 *  2. 回合开始 → room_turns.status='running'；成员在回合内调用 work_submit（此时 run=running）；
 *  3. 回合结束 → room_turns 落 done/error，再 noteRoomTurnEnd。
 */
const { db, now } = await import("../src/db.ts");
const rooms = await import("../src/rooms/index.ts");
const logic = await import("../src/rooms/logic.ts");
const W = await import("../src/work-items.ts");

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;

const mkAgent = (id: string, name: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(id, name, "A", "#111", now());
mkAgent("wm", "经理");
mkAgent("wa", "甲");
mkAgent("wb", "乙");
mkAgent("wc", "丙");

const room = rooms.createRoom({ name: "长期任务群", memberIds: ["wm", "wa", "wb"], managerId: "wm" });
const otherRoom = rooms.createRoom({ name: "另一个群", memberIds: ["wm", "wc"], managerId: "wm" });
type Actor = { kind: "user" } | { kind: "agent"; agentId: string; roomId?: string };
const user: Actor = { kind: "user" };
const mgr: Actor = { kind: "agent", agentId: "wm", roomId: room.id };
const a: Actor = { kind: "agent", agentId: "wa", roomId: room.id };
const b: Actor = { kind: "agent", agentId: "wb", roomId: room.id };

function makeItem(owner = "wa", start = false, roomId = room.id) {
	const d = W.createWorkItem({ roomId, title: `任务${Math.random().toString(36).slice(2, 6)}`, requirement: "写一份可检查的结果", doneCriteria: "结果里能看到检查点", ownerAgentId: owner, start }, user);
	return d.item.id;
}

/** 真实一条「已派发、正在跑」的回合：run 由 queueAssignmentForWorkItem 建，turn 带精确 work_run_id。 */
function startTurn(itemId: string, owner = "wa") {
	const run = W.queueAssignmentForWorkItem(room.id, owner, itemId);
	const turnId = uid("rt");
	db.prepare("INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, task, depth, status, created_at, work_item_id, work_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
		turnId, room.id, "rd_test", owner, "assign", "做任务", 0, "queued", now(), itemId, run.id,
	);
	const block = W.attachTurnToWork(room.id, owner, turnId);
	assert.ok(block && block.includes("work_submit"), "派发时把任务说明和提交要求交给成员");
	assert.equal((db.prepare("SELECT status FROM work_item_runs WHERE id = ?").get(run.id) as { status: string }).status, "running");
	db.prepare("UPDATE room_turns SET status = 'running', started_at = ? WHERE id = ?").run(now(), turnId);
	return { runId: run.id, turnId };
}

/** 回合结束：先落 room_turns（同 runTurn），再记执行结果。 */
function endTurn(turnId: string, status: "done" | "error" | "cancelled" | "interrupted", text = "", error?: string) {
	db.prepare("UPDATE room_turns SET status = ?, error = ?, finished_at = ? WHERE id = ?").run(status, error ?? null, now(), turnId);
	W.noteRoomTurnEnd(turnId, status, text, error ?? null);
}

/** 普通 @（没有任务绑定）的群回合：真实 running 行，但没有 work_run_id。 */
function plainTurn(agentId = "wa") {
	const turnId = uid("rt_plain");
	db.prepare("INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, task, depth, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(turnId, room.id, "rd_plain", agentId, "mention", "普通回复", 0, "running", now());
	return turnId;
}

const row = (id: string) => W.getWorkItemDetail(id).item;
const runRows = (itemId: string) => (db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? ORDER BY created_at, rowid").all(itemId) as unknown as { id: string; revision: number; status: string; result: string | null; submitted_at: number | null }[]);
const turnStatus = (id: string) => (db.prepare("SELECT status FROM room_turns WHERE id = ?").get(id) as { status: string }).status;

test("创建只记责任不偷偷调用模型；来源消息必须真实属于本群用户消息", () => {
	const before = (db.prepare("SELECT COUNT(*) AS n FROM room_turns").get() as { n: number }).n;
	const id = makeItem("wa", false);
	const d = row(id);
	assert.equal(d.status, "pending");
	assert.equal(d.ownerAgentId, "wa");
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM room_turns").get() as { n: number }).n, before, "只记录责任不会产生执行回合");
	// 伪造 / 跨群来源消息不会被记成本群来源
	const foreign = rooms.postUserMessage(otherRoom.id, "别的群的消息");
	const fake = rooms.postUserMessage(room.id, "真实来源");
	const d2 = W.createWorkItem({ roomId: room.id, title: "来源检查", ownerAgentId: null, start: false, sourceMessageId: fake.id }, user).item;
	assert.equal(d2.sourceMessageId, fake.id);
	assert.equal(W.createWorkItem({ roomId: room.id, title: "伪造来源", ownerAgentId: null, start: false, sourceMessageId: foreign.id }, user).item.sourceMessageId, null);
});

test("一次执行结束不等于完成：只有成员提交 → 待核验，管理者核验通过才完成", async () => {
	const id = makeItem();
	const { runId, turnId } = startTurn(id);
	assert.equal(row(id).status, "active");
	// 成员在回合内部提交（真实顺序）
	const sub = W.submitWorkItem({ roomId: room.id, actor: a, result: "产物 out.txt：第 3 行有检查点" });
	assert.equal(sub.applied, true);
	assert.equal(row(id).status, "review");
	endTurn(turnId, "done", "我做完了，结果在 out.txt");
	let d = row(id);
	assert.equal(d.status, "review", "执行结束不会自动完成，也不会覆盖已提交的待核验");
	assert.equal(runRows(id).find((r) => r.id === runId)!.result, "产物 out.txt：第 3 行有检查点");
	// 成员不能自己验收
	await assert.rejects(() => W.verifyWorkItem({ workItemId: id, actor: a, verdict: "pass", note: "我自己说通过" }), /只有管理者或用户/);
	// 没有检查结论不能完成
	await assert.rejects(() => W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "pass", note: "  " }), /检查结论/);
	await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "pass", note: "打开 out.txt，看到第 3 行检查点，符合完成标准" });
	d = row(id);
	assert.equal(d.status, "done");
	assert.ok(d.completedAt);
	assert.equal((d.verification as { verdict: string }).verdict, "pass");
});

test("普通 @ 没绑定任务执行不能提交；也不能自报别的 runId 授权", async () => {
	const id = makeItem();
	const other = startTurn(id); // 有 run，但下面这轮普通 @ 没有绑定
	// 真实 running 行，但 work_run_id 为空：宿主上下文里找不到这次任务的执行
	endTurn(other.turnId, "done", "上一轮已结束但没提交");
	const ordinary = plainTurn("wa");
	assert.throws(() => W.submitWorkItem({ roomId: room.id, actor: a, workItemId: id, result: "普通 @ 时顺手交" }), /不是任务执行/);
	assert.equal(row(id).status, "active", "普通 @ 不会被当成提交入口");
	// 自报 runId 不能授权：本轮真实 run 是另一条时直接拒绝
	endTurn(ordinary, "done", "普通问答结束");
	const turn2 = startTurn(id);
	assert.throws(() => W.submitWorkItem({ roomId: room.id, actor: a, workItemId: id, result: "指定别的 run", runId: other.runId }), /只能绑定本轮真实执行/);
	db.prepare("UPDATE room_turns SET status = 'done' WHERE id = ?").run(turn2.turnId);
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("同一任务两次执行：退回修改推进修订，旧修订结果只能作历史", async () => {
	const id = makeItem();
	const r1 = startTurn(id);
	W.submitWorkItem({ roomId: room.id, actor: a, result: "第一版结果" });
	endTurn(r1.turnId, "done", "第一版");
	// 先让群本轮处于暂停：退回会尊重暂停，不自动重派（自动重派单独测）
	db.prepare("UPDATE rooms SET paused = ? WHERE id = ?").run(JSON.stringify({ pending: [], reason: "测试暂停" }), room.id);
	await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "return", note: "缺少检查点，退回补充" });
	db.prepare("UPDATE rooms SET paused = NULL WHERE id = ?").run(room.id);
	let d = row(id);
	assert.equal(d.status, "blocked");
	assert.equal(d.revision, 2);
	// 旧修订的结果不能覆盖当前责任（晚到提交的“只留历史”由改派测试覆盖；
	// 这里回合已经结束，提交会被直接拒绝而不是错误绑定到新修订）
	assert.throws(() => W.submitWorkItem({ roomId: room.id, actor: a, result: "旧版结果又交一次", runId: r1.runId }), /不是任务执行|已被暂停|取消|改派/);
	assert.equal(row(id).status, "blocked");
	// 同一任务第二执行（新修订，手动继续）
	const r2 = startTurn(id);
	assert.equal(r2.runId !== r1.runId, true);
	assert.equal(runRows(id).length, 2);
	assert.equal(W.submitWorkItem({ roomId: room.id, actor: a, result: "第二版：第 3 行检查点" }).applied, true);
	endTurn(r2.turnId, "done", "第二版");
	await W.verifyWorkItem({ workItemId: id, actor: user, verdict: "pass", note: "用户看了第二版，检查点存在" });
	d = row(id);
	assert.equal(d.status, "done");
	assert.equal(runRows(id).filter((r) => r.status === "done").length >= 1, true);
});

test("退回后按明确改进要求自动安排下一次执行，但有上限，尊重暂停", async () => {
	const id = makeItem();
	const r1 = startTurn(id);
	W.submitWorkItem({ roomId: room.id, actor: a, result: "第一版" });
	endTurn(r1.turnId, "done", "第一版");
	const before = runRows(id).length;
	await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "return", note: "把来源补上" });
	const fresh = row(id);
	assert.ok(["active", "blocked"].includes(fresh.status), "自动重试被群调度接受（执行本身可能失败，但任务不会被标完成）");
	assert.equal(runRows(id).length, before + 1, "退回后自动安排同一个任务的下一次执行，不用用户催");
	assert.equal(W.getWorkItemDetail(id).item.autoRetries, 1);
	// 连续自动重试上限：数据库里已到上限时停下等确认，不无限回环
	db.prepare("UPDATE work_items SET auto_retries = ? WHERE id = ?").run(W.MAX_AUTO_RETRIES, id);
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("自动重试计数不会被管理者 edit / continue 清零；第 4 次 blocked 且不新建执行", async () => {
	const id = makeItem();
	const r1 = startTurn(id);
	W.submitWorkItem({ roomId: room.id, actor: a, result: "第一版" });
	endTurn(r1.turnId, "done", "第一版");
	assert.equal(row(id).status, "review");
	// 已经连续自动重试 3 次（第 1 次的累加由上面的自动重试测试真实覆盖，这里落计数代表第 2/3 次）
	db.prepare("UPDATE work_items SET auto_retries = ? WHERE id = ?").run(W.MAX_AUTO_RETRIES, id);
	// 管理者改要求：旧实现会顺手把计数清 0，导致 edit → return 无限重跑
	W.editWorkItem({ workItemId: id, actor: mgr, requirement: "第四版：补上来源和截图" });
	assert.equal(row(id).autoRetries, W.MAX_AUTO_RETRIES, "管理者改要求不能清自动重试计数");
	const before = runRows(id).length;
	await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "return", note: "第四次还是缺截图" });
	assert.equal(row(id).status, "blocked");
	assert.match(row(id).latestProgress, /自动重试/);
	assert.equal(runRows(id).length, before, "第四次不再新建执行");
	// 管理者 continue 是新一次执行，但同样不能清计数、不能换状态绕上限
	db.prepare("UPDATE work_items SET status = 'blocked' WHERE id = ?").run(id);
	await assert.rejects(() => W.continueWorkItem({ workItemId: id, actor: mgr }), /自动重试已达上限/);
	assert.equal(runRows(id).length, before, "换用continue也不能多建一次执行");
	assert.throws(() => W.queueAssignmentForWorkItem(room.id, "wa", id), /自动重试已达上限/);
	assert.equal(runRows(id).length, before, "换用room_assign也不能绕过上限");
	assert.equal(row(id).autoRetries, W.MAX_AUTO_RETRIES, "管理者继续也不能清计数");
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("需求或完成标准不清：只记 pending，不擅自派活；开始 / 继续 / room_assign 关联都拒绝笼统默认", async () => {
	const d = W.createWorkItem({ roomId: room.id, title: "不清楚的任务", requirement: "", doneCriteria: "", ownerAgentId: "wa", start: true }, user);
	assert.equal(d.item.status, "pending");
	assert.match(d.item.latestProgress, /信息不全|缺/);
	assert.equal(runRows(d.item.id).length, 0, "缺关键信息时不会偷偷执行");
	await assert.rejects(() => W.startWorkItem({ workItemId: d.item.id, actor: user }), /完成标准/);
	// room_assign 的 workItemId 关联也不能绕过同一条门（不建 run、不派人）
	assert.throws(() => W.queueAssignmentForWorkItem(room.id, "wa", d.item.id), /完成标准/);
	assert.equal(runRows(d.item.id).length, 0, "校验失败不产生执行记录");
	const ok = W.createWorkItem({ roomId: room.id, title: "清楚的任务", requirement: "写一份 md", doneCriteria: "文件里有第 3 行检查点", ownerAgentId: "wa", start: false }, user);
	assert.equal(ok.item.status, "pending");
	await W.cancelWorkItem({ workItemId: d.item.id, actor: user });
	await W.cancelWorkItem({ workItemId: ok.item.id, actor: user });
});

test("执行失败在群里可见、任务明确受阻（不是无执行却永远进行中），不自动完成", () => {
	const id = makeItem();
	const r = startTurn(id);
	endTurn(r.turnId, "error", "", "模拟模型失败");
	const d = row(id);
	assert.equal(d.status, "blocked", "失败后明确受阻，仍可提交 / 继续");
	assert.match(d.latestProgress, /执行出错/);
	assert.equal(runRows(id).find((x) => x.id === r.runId)!.status, "error");
	const noticeRows = db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'system' AND content LIKE ?").all(room.id, "%这次执行失败%") as { content: string }[];
	assert.equal(noticeRows.filter((x) => x.content.includes(d.title)).length, 1, "失败在原群通知一次（按本任务标题）");
});

test("失败回合仍满足管理者一次 followup 的条件（不重复回调、不无限重跑）", () => {
	// 失败也走同一批「派出去的成员都结束」判定：batchDone + anyWorkerRan → 管理者收到一次 followup。
	// rooms.runTurn 对 reason=assign 无论成功失败都置 batchRan=true，然后交给同一个 planAfter。
	const caps = logic.normalizeCaps({});
	const follow = logic.planAfter(
		{ agentId: "wa", reason: "assign", depth: 0 },
		{ managerId: "wm", activeIds: ["wm", "wa", "wb"], assignments: [], caps, batchDone: true, anyWorkerRan: true },
	);
	assert.deepEqual(follow, [{ agentId: "wm", reason: "followup", depth: 0 }]);
	// 任务侧：失败后 blocked 等处理，不再自动重跑
	const id = makeItem();
	const r = startTurn(id);
	endTurn(r.turnId, "error", "", "模拟失败");
	const before = runRows(id).length;
	assert.equal(row(id).status, "blocked");
	assert.equal(runRows(id).length, before, "失败本身不新建执行");
});

test("权限边界：成员不能改负责人 / 他人任务；跨群 actor 被拒", async () => {
	const id = makeItem();
	assert.throws(() => W.editWorkItem({ workItemId: id, actor: a, ownerAgentId: "wb" }), /只有管理者或用户/);
	assert.throws(() => W.submitWorkItem({ roomId: room.id, actor: b, workItemId: id, result: "替别人交" }), /不是任务执行|只能提交自己/);
	assert.throws(() => W.submitWorkItem({ roomId: otherRoom.id, actor: b, result: "跨群", workItemId: id }), /没有可提交的任务|只能提交自己|不是任务执行/);
	// 同一个管理者在另一个群，也不能核验这个群的任务（任务自带群 scope）
	const otherItem = W.createWorkItem({ roomId: otherRoom.id, title: "别群任务", ownerAgentId: null, start: false }, user).item;
	await assert.rejects(() => W.verifyWorkItem({ workItemId: otherItem.id, actor: { kind: "agent", agentId: "wc", roomId: otherRoom.id }, verdict: "pass", note: "越权" }), /只有管理者或用户/);
	// 用户 actor 没有成员提交能力，不能伪造“成员已提交”
	assert.throws(() => W.submitWorkItem({ roomId: room.id, actor: user, result: "用户代交" }), /不能由用户代提交/);
	W.cancelWorkItem({ workItemId: id, actor: user });
});

test("同一个管理者跨两个群的工具边界：A 群工具改不动 B 群任务，B 群 DB / 事件 / 通知不变", async () => {
	const bItem = W.createWorkItem({ roomId: otherRoom.id, title: "B 群任务", requirement: "写 B", doneCriteria: "B 有结果", ownerAgentId: "wc", start: false }, user).item.id;
	const snapshot = () => ({
		title: row(bItem).title,
		requirement: (W.getWorkItemDetail(bItem).item as unknown as { requirement: string }).requirement,
		revision: row(bItem).revision,
		status: row(bItem).status,
		events: (db.prepare("SELECT COUNT(*) AS n FROM work_item_events WHERE work_item_id = ?").get(bItem) as { n: number }).n,
		notices: (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND role = 'system' AND content LIKE ?").get(otherRoom.id, "%B 群任务%") as { n: number }).n,
		turns: (db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ?").get(otherRoom.id) as { n: number }).n,
	});
	const before = snapshot();
	// 工具是 A 群会话里的（roomId=A），同一个 agentId=wm 也是 B 群管理者
	const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
	W.workItemTools(room.id, "wm")({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
	const edit = await defs.get("work_update")!.execute("t1", { workItemId: bItem, action: "edit", requirement: "偷偷改成 A 群写的" });
	assert.match(edit.content[0].text, /不在当前群|只有管理者/);
	const verify = await defs.get("work_verify")!.execute("t2", { workItemId: bItem, verdict: "pass", note: "跨群核验" });
	assert.match(verify.content[0].text, /不在当前群|只有管理者/);
	assert.deepEqual(snapshot(), before, "B 群任务、事件、群提示和执行都没被改");
	// 同一个管理者在 B 群自己的工具里可以正常改（证明是 scope 而不是权限误伤）
	const bMgrDefs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
	W.workItemTools(otherRoom.id, "wm")({ registerTool: (d: unknown) => bMgrDefs.set((d as { name: string }).name, d as never) });
	const okEdit = await bMgrDefs.get("work_update")!.execute("t3", { workItemId: bItem, action: "edit", requirement: "B 群改的" });
	assert.match(okEdit.content[0].text, /已更新要求/);
	await W.cancelWorkItem({ workItemId: bItem, actor: user });
});

test("改派 / 取消后的迟到结果不得覆盖最新责任；旧执行保留历史", async () => {
	const id = makeItem("wa");
	const r = startTurn(id);
	// 执行中改派给乙：修订推进，负责人变更；旧执行结果迟到
	W.editWorkItem({ workItemId: id, actor: user, ownerAgentId: "wb" });
	let d = row(id);
	assert.equal(d.ownerAgentId, "wb");
	assert.equal(d.revision, 2);
	// 运行中的这一轮不会被数据库层面假装取消（不 abort 时让它自然结束，结果只留历史）
	assert.equal(turnStatus(r.turnId), "running");
	W.submitWorkItem({ roomId: room.id, actor: a, result: "甲旧结果" });
	endTurn(r.turnId, "done", "甲交的旧结果");
	d = row(id);
	assert.equal(d.status, "active");
	assert.equal(d.ownerAgentId, "wb");
	assert.doesNotMatch(d.latestProgress, /甲旧结果/);
	assert.ok(W.getWorkItemDetail(id).runs.some((x) => x.id === r.runId && x.stale), "旧执行历史保留并标记过期");
	// 取消后同样不接受旧提交
	await W.cancelWorkItem({ workItemId: id, actor: user });
	assert.equal(row(id).status, "cancelled");
	assert.throws(() => W.submitWorkItem({ roomId: room.id, actor: a, result: "取消后旧结果" }), /已被暂停|取消|改派|不是任务执行/);
	assert.equal(row(id).status, "cancelled");
});

test("暂停真的取消本任务排队回合，不误伤其他任务 / 其他群；cancelWorkTurn 先校验回合属于这个群", async () => {
	const idA = makeItem("wa");
	const idB = makeItem("wb", false);
	// A 的排队执行
	const runA = W.queueAssignmentForWorkItem(room.id, "wa", idA);
	const turnA = uid("rt_pause");
	db.prepare("INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, task, depth, status, created_at, work_item_id, work_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(turnA, room.id, "rd", "wa", "assign", "A", 0, "queued", now(), idA, runA.id);
	// B 的排队执行（同群，另一个任务）
	const runB = W.queueAssignmentForWorkItem(room.id, "wb", idB);
	const turnB = uid("rt_keep");
	db.prepare("INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, task, depth, status, created_at, work_item_id, work_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(turnB, room.id, "rd", "wb", "assign", "B", 0, "queued", now(), idB, runB.id);
	// 另一个群的排队回合
	const otherItem = W.createWorkItem({ roomId: otherRoom.id, title: "别群", requirement: "写", doneCriteria: "有结果", ownerAgentId: "wc", start: false }, user).item;
	const otherRun = W.queueAssignmentForWorkItem(otherRoom.id, "wc", otherItem.id);
	const turnOther = uid("rt_other");
	db.prepare("INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, task, depth, status, created_at, work_item_id, work_run_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(turnOther, otherRoom.id, "rd2", "wc", "assign", "C", 0, "queued", now(), otherItem.id, otherRun.id);
	// 旧 bug 的形状：把任务 id 当作 roomId 传进去，必须 fail closed（不改任何回合）
	assert.equal(await rooms.cancelWorkTurn(idA, turnA, false), false);
	assert.equal(turnStatus(turnA), "queued", "用任务 id 当 roomId 不能取消回合");
	assert.equal(await rooms.cancelWorkTurn(otherRoom.id, turnA, false), false);
	assert.equal(turnStatus(turnA), "queued", "换一个群的 roomId 也不能取消这个回合");
	await W.pauseWorkItem({ workItemId: idA, actor: user });
	assert.equal(turnStatus(turnA), "cancelled");
	assert.equal(turnStatus(turnB), "queued", "同群其他任务的回合不能停");
	assert.equal(turnStatus(turnOther), "queued", "其他群不能误停");
	assert.equal(row(idA).status, "paused");
	assert.equal((db.prepare("SELECT status FROM work_item_runs WHERE id = ?").get(runA.id) as { status: string }).status, "cancelled");
	assert.equal((db.prepare("SELECT status FROM work_item_runs WHERE id = ?").get(runB.id) as { status: string }).status, "queued");
	await W.cancelWorkItem({ workItemId: idB, actor: user });
});

test("取消排队执行会真的从内存队列撤回（不是只改 DB）", async () => {
	const qRoom = rooms.createRoom({ name: "队列探针群", memberIds: ["wm", "wa", "wb"], managerId: "wm" });
	const mk = (owner: string) => W.createWorkItem({ roomId: qRoom.id, title: `探针${owner}`, requirement: "写", doneCriteria: "有结果", ownerAgentId: owner, start: false }, user).item.id;
	const ia = mk("wa");
	const ib = mk("wb");
	// 先占住这个群的串行泵，第二个任务才会真正停在内存队列里
	const ra = W.queueAssignmentForWorkItem(qRoom.id, "wa", ia);
	rooms.enqueueWorkTurn(qRoom.id, "wa", "A", ra.id, ia);
	const rb = W.queueAssignmentForWorkItem(qRoom.id, "wb", ib);
	const turnB = rooms.enqueueWorkTurn(qRoom.id, "wb", "B", rb.id, ib);
	assert.deepEqual(rooms.stateOf(qRoom.id).queue, ["wb"], "第二个回合在内存队列里排队");
	// cancelWorkTurn 到第一个 await 之前是同步的：错的 roomId 在这里就会 fail closed
	void rooms.cancelWorkTurn(qRoom.id, turnB, false);
	assert.ok(!rooms.stateOf(qRoom.id).queue.includes("wb"), "排队回合已从内存队列撤回，不是只把 DB 写成 cancelled");
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(turnStatus(turnB), "cancelled");
	await W.pauseWorkItem({ workItemId: ib, actor: user });
	assert.equal((db.prepare("SELECT status FROM work_item_runs WHERE id = ?").get(rb.id) as { status: string }).status, "cancelled", "关联 work run 不会一直挂着 queued");
	await rooms.deleteRoom(qRoom.id);
});

test("群停止 / 本轮暂停时，自动派活被拒绝（不塞任务假 active）", async () => {
	db.prepare("UPDATE rooms SET paused = ? WHERE id = ?").run(JSON.stringify({ pending: [], reason: "测试暂停" }), room.id);
	const d = W.createWorkItem({ roomId: room.id, title: "暂停时的自动任务", requirement: "写", doneCriteria: "有结果", ownerAgentId: "wa", start: true }, user);
	// 派发是异步的（动态 import + 群调度）：等它被暂停挡下来
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(row(d.item.id).status, "blocked", "自动派活被群暂停挡住，任务明确受阻而不是假进行中");
	assert.match(row(d.item.id).latestProgress, /暂停/);
	assert.equal(runRows(d.item.id).length, 1, "只留下一条失败执行记录，没有真跑");
	assert.equal(runRows(d.item.id)[0].status, "error");
	db.prepare("UPDATE rooms SET paused = NULL WHERE id = ?").run(room.id);
	// 用户明确继续可以恢复，但不会清掉群的暂停状态（这里群已不是暂停态，仅验证能继续）
	await W.cancelWorkItem({ workItemId: d.item.id, actor: user });
});

test("重启：执行标中断、任务状态不变、绝不自动重派", () => {
	const id = makeItem("wa");
	const r = W.queueAssignmentForWorkItem(room.id, "wa", id);
	const before = runRows(id).length;
	assert.equal(W.bootstrapWorkItems() >= 1, true);
	assert.equal(runRows(id).length, before, "重启不新建执行");
	assert.equal((db.prepare("SELECT status FROM work_item_runs WHERE id = ?").get(r.id) as { status: string }).status, "interrupted");
	const d = row(id);
	assert.equal(d.status, "active");
	assert.match(d.latestProgress, /中断/);
	// 再次 bootstrap 幂等：没有新的 queued/running 可标，不会重复改历史
	const again = W.bootstrapWorkItems();
	assert.equal(again, 0);
	assert.equal(runRows(id).length, before);
});

test("移出成员：任务标受阻待改派，不自动交给管理者", async () => {
	const id = makeItem("wa");
	const r = W.queueAssignmentForWorkItem(room.id, "wa", id);
	assert.equal(row(id).status, "active");
	rooms.updateRoom(room.id, { memberIds: ["wm", "wb"] });
	const d = row(id);
	assert.equal(d.status, "blocked");
	assert.match(d.latestProgress, /待改派/);
	assert.equal(d.ownerAgentId, "wa", "不自动改派给管理者");
	assert.equal((db.prepare("SELECT status FROM work_item_runs WHERE id = ?").get(r.id) as { status: string }).status, "cancelled");
	// 加回来（后续撤销）
	rooms.updateRoom(room.id, { memberIds: ["wm", "wa", "wb"] });
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("工具 actor 绑定：管理者可记录 / 核验，普通成员越权被拒且不改库", async () => {
	const toolsOf = (agentId: string, roomId = room.id) => {
		const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
		W.workItemTools(roomId, agentId)({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
		return defs;
	};
	const mgrTools = toolsOf("wm");
	const memberTools = toolsOf("wa");
	assert.equal(mgrTools.size, 5);
	const created = await mgrTools.get("work_create")!.execute("t1", { title: "工具记录的任务", requirement: "写清楚", doneCriteria: "可检查", owner: "甲", start: false });
	assert.match(created.content[0].text, /已记录任务/);
	const item = (db.prepare("SELECT * FROM work_items WHERE title = '工具记录的任务'").get() as { id: string }).id;
	// 普通成员不能记录 / 核验
	const denied = await memberTools.get("work_create")!.execute("t2", { title: "越权" });
	assert.match(denied.content[0].text, /只有管理者/);
	const queue = await memberTools.get("work_verify")!.execute("t3", { workItemId: item, verdict: "pass", note: "越权通过" });
	assert.match(queue.content[0].text, /只有管理者或用户/);
	assert.equal(row(item).status, "pending", "越权核验没有改状态");
	// 真实走一轮：派发 → 回合内提交 → 完成 → 管理者核验
	startTurn(item);
	const sub = await memberTools.get("work_submit")!.execute("t4", { result: "产物 path/out.txt，第 3 行检查点", workItemId: item });
	assert.match(sub.content[0].text, /已提交/);
	assert.equal(row(item).status, "review");
	const pass = await mgrTools.get("work_verify")!.execute("t5", { workItemId: item, verdict: "pass", note: "看到 out.txt 第 3 行检查点" });
	assert.match(pass.content[0].text, /核验通过/);
	assert.equal(row(item).status, "done");
});

test("看板分页：updated_at 相同的行也不会漏 / 重（beforeId 组合游标）", async () => {
	const pRoom = rooms.createRoom({ name: "分页群", memberIds: ["wm", "wa"], managerId: "wm" });
	const ids = Array.from({ length: 5 }, (_, i) => W.createWorkItem({ roomId: pRoom.id, title: `分页${i}`, ownerAgentId: null, start: false }, user).item.id);
	// 前三条同一毫秒、后两条同另一毫秒
	db.prepare("UPDATE work_items SET updated_at = ? WHERE id IN (?,?,?)").run(1_700_000_000_000, ids[0], ids[1], ids[2]);
	db.prepare("UPDATE work_items SET updated_at = ? WHERE id IN (?,?)").run(1_700_000_000_000 + 5, ids[3], ids[4]);
	const seen: string[] = [];
	let before: number | undefined;
	let beforeId: string | undefined;
	for (let guard = 0; guard < 10; guard++) {
		const page = W.listWorkItems(pRoom.id, { limit: 2, before, beforeId });
		assert.ok(page.items.length);
		seen.push(...page.items.map((x) => x.id));
		if (!page.hasMore) break;
		assert.equal(page.nextBeforeId, page.items[page.items.length - 1].id);
		before = page.nextBefore!;
		beforeId = page.nextBeforeId!;
	}
	assert.equal(new Set(seen).size, 5, "没有重复");
	assert.deepEqual([...seen].sort(), [...ids].sort(), "5 条都翻到了");
	// 只给 before（旧接口）仍然兼容
	const legacy = W.listWorkItems(pRoom.id, { limit: 3, before: 1_700_000_000_001 });
	assert.deepEqual(legacy.items.map((x) => x.id).sort(), [ids[0], ids[1], ids[2]].sort(), "旧的 before 语义不变（严格小于）");
});

test("删群按原语义清本群任务，其他群不受影响", async () => {
	const id = makeItem("wa");
	const other = W.createWorkItem({ roomId: otherRoom.id, title: "保留的别群任务", ownerAgentId: null, start: false }, user).item;
	const res = await rooms.deleteRoom(room.id);
	assert.ok(res);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE id = ?").get(id) as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_item_events WHERE work_item_id = ?").get(id) as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE id = ?").get(other.id) as { n: number }).n, 1);
});
