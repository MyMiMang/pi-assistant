import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

/**
 * 长期任务（任务责任）与单次执行分离的定向测试。
 *
 * 边界：只读写本进程临时数据目录（test/setup.ts 强制），不起模型 / 浏览器 / 付费调用。
 * 执行是负责人在自己的隐藏任务会话上派的帮手（work-items/exec.ts → spawnSubagent kind=work）：这里装一个可控的帮手 driver——
 * 帮手的执行挂起等测试决定怎么结束（完成 / 出错 / 被停）；群会话的回合（管理者被唤醒）用假的 AgentRuntime.turn 立即结束并记下来。
 */
process.env.PIA_MOCK = "1";
const { db, now } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore()); // 只用内存凭据：帮手按 mock 模型登记，不调用任何真实模型
const R = await import("../src/runtime.ts");
const S = await import("../src/subagents.ts");
const rooms = await import("../src/rooms/index.ts");
const W = await import("../src/work-items.ts");
const { requests } = await import("../src/requests.ts");
const { roomOfConversation } = await import("../src/messages.ts");

type Res = { ok: boolean; aborted: boolean; error?: string; text: string; tokens: number };
type Call = { agentId: string; conv: string; prompt: string; helperId?: string; finish: (r?: Partial<Res>) => void; done: boolean };
const calls: Call[] = [];
const proto = Object.getPrototypeOf(R.runtime("wm", "conv_probe")) as Record<string, unknown>;
proto.turn = function (this: { id: string; conversationId: string }, prompt: string) {
	calls.push({ agentId: this.id, conv: this.conversationId, prompt, done: true, finish: () => {} });
	return Promise.resolve<Res>({ ok: true, aborted: false, text: "", tokens: 0 }); // 群会话：管理者被唤醒的回合直接结束
};
proto.modelFor = () => ({ provider: "mock", id: "echo" });
S.setSubagentDriver({
	run: (r, connect, input) => new Promise<string>((resolve, reject) => {
		const c: Call = { agentId: r.agent_id, conv: r.conversation_id, prompt: input?.text ?? r.task, helperId: r.id, done: false, finish: (x = {}) => {
			if (c.done) return;
			c.done = true;
			if (x.error) reject(new Error(x.error));
			else resolve(x.text ?? "");
		} };
		calls.push(c);
		connect(async () => c.finish({ aborted: true }), async () => {});
	}),
	notify: async () => {},
});

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
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
const a: Actor = { kind: "agent", agentId: "wa" };
const b: Actor = { kind: "agent", agentId: "wb" };

function makeItem(owner = "wa", start = false, roomId = room.id) {
	return W.createWorkItem({ roomId, title: `任务${Math.random().toString(36).slice(2, 6)}`, requirement: "写一份可检查的结果", doneCriteria: "结果里能看到检查点", ownerAgentId: owner, start }, user).item.id;
}
const row = (id: string) => W.getWorkItemDetail(id).item;
const runRows = (itemId: string) => db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ? ORDER BY created_at, rowid").all(itemId) as unknown as { id: string; revision: number; status: string; result: string | null; submitted_at: number | null; exec_kind: string }[];
const lastExec = (itemId: string) => [...calls].reverse().find((c) => W.execOf(c.conv)?.work_item_id === itemId);
const wakes = (roomId: string) => (db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ? AND reason = 'check'").get(roomId) as { n: number }).n;
const checkPrompts = () => calls.filter((c) => /任务看板有变化/.test(c.prompt)).map((c) => c.prompt);
async function started(itemId: string) {
	await settle();
	const c = lastExec(itemId);
	assert.ok(c && !c.done, "执行已经在负责人的任务会话里开始");
	return c!;
}
const submit = (c: Call, p: { result?: string; blocker?: string }, actor: Actor = { kind: "agent", agentId: c.agentId }) => W.submitWorkItem({ workItemId: W.execOf(c.conv)!.work_item_id, conversationId: c.conv, actor, ...p });

test("创建只记责任不偷偷调用模型；来源消息必须真实属于本群用户消息", () => {
	const before = calls.length;
	const id = makeItem("wa", false);
	assert.equal(row(id).status, "pending");
	assert.equal(calls.length, before, "只记录责任不会产生执行");
	const foreign = rooms.postUserMessage(otherRoom.id, "别的群的消息");
	const fake = rooms.postUserMessage(room.id, "真实来源");
	assert.equal(W.createWorkItem({ roomId: room.id, title: "来源检查", ownerAgentId: null, start: false, sourceMessageId: fake.id }, user).item.sourceMessageId, fake.id);
	assert.equal(W.createWorkItem({ roomId: room.id, title: "伪造来源", ownerAgentId: null, start: false, sourceMessageId: foreign.id }, user).item.sourceMessageId, null);
});

test("执行在负责人自己的隐藏任务会话里跑，不占群回合；执行结束不等于完成，提交后才待核验，核验通过才完成", async () => {
	const turnsBefore = (db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ? AND reason != 'check'").get(room.id) as { n: number }).n;
	const id = makeItem("wa", true);
	const c = await started(id);
	assert.equal(c.agentId, "wa");
	const conv = db.prepare("SELECT hidden, agent_id FROM conversations WHERE id = ?").get(c.conv) as { hidden: number; agent_id: string };
	assert.deepEqual([conv.hidden, conv.agent_id], [1, "wa"], "是甲自己的隐藏会话（自己的记忆 / 权限 / 电脑）");
	assert.equal(roomOfConversation(c.conv), room.id, "任务会话的消息归进来源群");
	assert.match(c.prompt, /给你分配了任务/);
	assert.match(c.prompt, new RegExp(`任务编号：${id}`));
	assert.doesNotMatch(c.prompt, /（管理者）/);
	assert.equal(runRows(id)[0].exec_kind, "helper", "执行跑在负责人的帮手上");
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ? AND reason != 'check'").get(room.id) as { n: number }).n, turnsBefore, "不进群的发言队列");
	// 结束但没提交：任务不完成，管理者被叫醒
	const w0 = wakes(room.id);
	c.finish({ text: "我做了一些事" });
	await settle();
	assert.equal(row(id).status, "active");
	assert.match(row(id).latestProgress, /没有提交结果/);
	assert.ok(wakes(room.id) > w0, "执行结束没提交 → 唤醒管理者");
	// 继续：同一个人接着用同一个任务会话
	await W.continueWorkItem({ workItemId: id, actor: user });
	const c2 = await started(id);
	assert.equal(c2.conv, c.conv, "同一负责人复用任务会话（保留上下文）");
	const w1 = wakes(room.id);
	assert.equal(submit(c2, { result: "产物 out.txt，第 3 行检查点" }).applied, true);
	assert.equal(row(id).status, "review");
	assert.ok(wakes(room.id) > w1, "提交 → 唤醒管理者核验");
	assert.ok(checkPrompts().some((p) => p.includes(id) && /待核验/.test(p)), "管理者醒来读到看板摘要");
	c2.finish({ text: "已提交" });
	await settle();
	assert.equal(row(id).status, "review", "执行结束不会把待核验改回去");
	await assert.rejects(() => W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "pass", note: "" }), /检查结论/);
	await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "pass", note: "读了 out.txt，第 3 行检查点在" });
	assert.equal(row(id).status, "done");
});

test("提交只认这个任务会话里正在跑的执行：群会话 / 别人 / 执行结束后都不能提交", async () => {
	const id = makeItem("wa", true);
	const c = await started(id);
	const roomConv = rooms.memberConversation(room.id, "wa");
	assert.throws(() => W.submitWorkItem({ workItemId: id, conversationId: roomConv, actor: a, result: "从群会话交" }), /只能在这个任务自己的执行会话里提交/);
	assert.throws(() => W.submitWorkItem({ workItemId: id, conversationId: c.conv, actor: b, result: "替别人交" }), /只能在这个任务自己的执行会话里提交/);
	assert.throws(() => W.submitWorkItem({ workItemId: id, conversationId: c.conv, actor: user, result: "用户代交" }), /不能由用户代提交/);
	c.finish({ text: "" });
	await settle();
	assert.throws(() => submit(c, { result: "结束后才交" }), /没有这项任务的执行在进行/);
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("退回修改推进修订并自动安排下一次执行；改派后旧执行的迟到结果只留历史", async () => {
	const id = makeItem("wa", true);
	const c = await started(id);
	submit(c, { result: "第一版" });
	c.finish();
	await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "return", note: "缺第 3 行检查点" });
	assert.equal(row(id).revision, 2);
	const c2 = await started(id);
	assert.notEqual(c2, c);
	assert.match(c2.prompt, /最近一次意见：缺第 3 行检查点/);
	// 执行中改派给乙：修订推进；甲那次还在跑，它的提交只进历史
	W.editWorkItem({ workItemId: id, actor: user, ownerAgentId: "wb" });
	assert.equal(row(id).ownerAgentId, "wb");
	assert.equal(submit(c2, { result: "甲的旧结果" }).applied, false);
	assert.doesNotMatch(row(id).latestProgress, /甲的旧结果/);
	c2.finish({ text: "甲交的旧结果" });
	await settle();
	assert.ok(W.getWorkItemDetail(id).runs.some((x) => x.ownerAgentId === "wa" && x.stale), "旧执行历史保留并标记过期");
	assert.ok(W.getWorkItemDetail(id).events.some((e) => e.kind === "submit.late"));
	// 改派给乙后乙用自己的任务会话
	await W.continueWorkItem({ workItemId: id, actor: user });
	const c3 = await started(id);
	assert.equal(c3.agentId, "wb");
	assert.notEqual(c3.conv, c.conv);
	await W.cancelWorkItem({ workItemId: id, actor: user });
	assert.equal(c3.done, true, "取消会中止它的任务会话");
});

test("反复退回仍不通过：不再自动重做，放进「等你决定」，管理者不能自己再派；用户决定后交回管理者", async () => {
	const id = makeItem("wa", true);
	const notes = ["缺检查点", "来源链接不对", "格式不统一", "第三节漏了图表"];
	for (let i = 0; i < 4; i++) {
		const c = await started(id);
		submit(c, { result: `第 ${i + 1} 版` });
		c.finish();
		await settle();
		await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "return", note: notes[i] });
	}
	await settle();
	const d = row(id);
	assert.equal(d.status, "blocked");
	assert.equal(d.board, "decision");
	assert.equal(d.boardLabel, "等你决定");
	assert.ok(d.needsUser?.requestId, "管理者在群里发了提问卡片");
	const req = db.prepare("SELECT status, room_id, kind FROM requests WHERE id = ?").get(d.needsUser!.requestId!) as { status: string; room_id: string; kind: string };
	assert.deepEqual([req.status, req.room_id, req.kind], ["pending", room.id, "question"]);
	assert.equal(runRows(id).filter((r) => r.status === "running").length, 0, "没有偷偷再跑");
	await assert.rejects(() => W.continueWorkItem({ workItemId: id, actor: mgr }), /等你决定/);
	// 用户在看板上回答：清掉等待、重置计数，并把决定作为用户消息交给管理者
	await W.userAction(id, "decide", { answer: "换个方法继续" });
	const after = row(id);
	assert.equal(after.needsUser, null);
	assert.equal(after.autoRetries, 0);
	assert.equal((db.prepare("SELECT status FROM requests WHERE id = ?").get(d.needsUser!.requestId!) as { status: string }).status, "answered", "群里那张卡片一起收掉");
	const msg = db.prepare("SELECT content, meta FROM messages WHERE room_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1").get(room.id) as { content: string; meta: string };
	assert.match(msg.content, /我的决定：换个方法继续/);
	assert.equal(JSON.parse(msg.meta).workItemId, id);
	await assert.rejects(() => W.userAction(id, "decide", { answer: "再答一次" }), /不需要你决定/);
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("同样的退回理由出现第三次：算反复卡在同一处，直接请用户决定", async () => {
	const id = makeItem("wa", true);
	for (let i = 0; i < 3; i++) {
		const c = await started(id);
		submit(c, { result: `第 ${i + 1} 版` });
		c.finish();
		await settle();
		await W.verifyWorkItem({ workItemId: id, actor: mgr, verdict: "return", note: `第 ${i + 1} 次：还是缺第 3 行检查点` });
	}
	await settle();
	assert.equal(row(id).board, "decision");
	assert.match(row(id).needsUser?.question ?? "", /反复退回/);
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("执行失败：明确受阻并叫管理者；同样的失败反复出现 → 先上报管理者，再请用户决定", async () => {
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
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND role = 'system' AND content LIKE '%这次执行失败了%'").get(room.id));
	await W.continueWorkItem({ workItemId: id, actor: user });
	await fails();
	assert.equal(row(id).escalation?.kind, "repeat");
	assert.equal(row(id).escalation?.level, "manager");
	await W.continueWorkItem({ workItemId: id, actor: user });
	await fails();
	await settle();
	assert.equal(row(id).board, "decision", "第三次同样卡住 → 等你决定");
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("卡住没进展：超时先上报管理者，仍没动静再问用户；汇报进展清掉上报", async () => {
	const id = makeItem("wa", true);
	const c = await started(id);
	const t0 = now();
	assert.equal(await W.checkStalls(t0 + 1000, 60_000), 0, "没到时间不打扰");
	const n1 = await W.checkStalls(t0 + 61_000, 60_000);
	assert.ok(n1 >= 1);
	assert.equal(row(id).escalation?.kind, "stall");
	assert.equal(row(id).board, "stuck");
	W.reportProgress({ workItemId: id, conversationId: c.conv, actor: a, note: "数据拉完了，开始写" });
	assert.equal(row(id).escalation, null, "有进展就清掉上报");
	assert.equal(row(id).latestProgress, "数据拉完了，开始写");
	const t1 = now();
	await W.checkStalls(t1 + 61_000, 60_000);
	await W.checkStalls(t1 + 122_000, 60_000);
	await settle();
	assert.equal(row(id).board, "decision", "管理者介入后仍没进展 → 问用户");
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("停群不停任务：群停止后任务执行和它的审批、等你决定的卡片都保留；看板「全部暂停」才停", async () => {
	const sRoom = rooms.createRoom({ name: "停群不停任务", memberIds: ["wm", "wa", "wb"], managerId: "wm" });
	const ia = makeItem("wa", true, sRoom.id);
	const ib = makeItem("wb", true, sRoom.id);
	const ca = await started(ia);
	await started(ib);
	void requests.approval("wa", null, "bash", { command: "ls" }, "列目录", "low", ca.conv);
	const roomConv = rooms.memberConversation(sRoom.id, "wm");
	void requests.question("wm", null, "群里的普通提问", [], true, roomConv);
	await W.askUserDecision(ib, { question: "要不要换数据源？", options: ["换", "不换"] });
	await rooms.stop(sRoom.id);
	assert.equal(row(ia).status, "active");
	assert.equal(ca.done, false, "任务执行没被停");
	const pend = (conv: string) => (db.prepare("SELECT status FROM requests WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1").get(conv) as { status: string }).status;
	assert.equal(pend(ca.conv), "pending", "任务会话里的审批保留");
	assert.equal((db.prepare("SELECT status FROM requests WHERE id = ?").get(row(ib).needsUser!.requestId!) as { status: string }).status, "pending", "等你决定的卡片保留");
	assert.equal((db.prepare("SELECT status FROM requests WHERE conversation_id = ? AND json_extract(payload, '$.question') = '群里的普通提问'").get(roomConv) as { status: string }).status, "answered", "群会话里的普通提问照常收掉");
	// 停群期间不唤醒管理者
	const w0 = wakes(sRoom.id);
	submit(ca, { result: "停群期间交的" });
	assert.equal(row(ia).status, "review");
	assert.equal(wakes(sRoom.id), w0, "群已停止：不唤醒管理者（看板仍可见）");
	const r = await W.pauseAllWorkItems(sRoom.id);
	assert.equal(r.paused, 2);
	assert.equal(row(ia).status, "paused");
	assert.equal(row(ib).status, "paused");
	assert.equal(row(ib).needsUser, null);
	await settle();
	assert.equal(lastExec(ib)!.done, true, "全部暂停中止了执行");
	await rooms.deleteRoom(sRoom.id);
});

test("看板分组：进行中 / 卡住 / 等你决定 / 已完成 / 已停止 与 group 过滤一致", async () => {
	const gRoom = rooms.createRoom({ name: "分组群", memberIds: ["wm", "wa"], managerId: "wm" });
	const doing = makeItem("wa", false, gRoom.id);
	const stuck = makeItem("wa", false, gRoom.id);
	const decide = makeItem("wa", false, gRoom.id);
	const stopped = makeItem("wa", false, gRoom.id);
	db.prepare("UPDATE work_items SET status = 'blocked' WHERE id = ?").run(stuck);
	await W.askUserDecision(decide, { question: "选哪个方案？", options: ["A", "B"] });
	await W.pauseWorkItem({ workItemId: stopped, actor: user });
	const out = W.listWorkItems(gRoom.id);
	assert.deepEqual(out.groups, { decision: 1, stuck: 1, doing: 1, done: 0, stopped: 1 });
	assert.deepEqual(W.listWorkItems(gRoom.id, { group: "decision" }).items.map((x) => x.id), [decide]);
	assert.deepEqual(W.listWorkItems(gRoom.id, { group: "stuck" }).items.map((x) => x.id), [stuck]);
	assert.deepEqual(W.listWorkItems(gRoom.id, { group: "doing" }).items.map((x) => x.id), [doing]);
	assert.match(W.boardDigest(gRoom.id), /【等你决定】[\s\S]*【卡住】[\s\S]*【进行中】/);
	await rooms.deleteRoom(gRoom.id);
});

test("需求或完成标准不清：只记 pending，不擅自派活；room_assign 关联也拒绝", async () => {
	const id = W.createWorkItem({ roomId: room.id, title: "笼统任务", ownerAgentId: "wa", start: true }, user).item.id;
	await settle();
	assert.equal(row(id).status, "pending");
	assert.equal(runRows(id).length, 0);
	await assert.rejects(() => W.startWorkItem({ workItemId: id, actor: user }), /完成标准/);
	assert.throws(() => W.dispatchFromRoom(room.id, "wa", id), /完成标准/);
	const ok = makeItem("wa", false);
	assert.throws(() => W.dispatchFromRoom(room.id, "wb", ok), /负责人不是该成员/);
	assert.throws(() => W.dispatchFromRoom(otherRoom.id, "wa", ok), /不在这个群/);
	W.dispatchFromRoom(room.id, "wa", ok, "按说明做");
	await started(ok);
	assert.throws(() => W.dispatchFromRoom(room.id, "wa", ok), /已有执行在进行/);
	await W.cancelWorkItem({ workItemId: ok, actor: user });
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("权限边界：成员不能改负责人；同一个管理者跨群的工具改不动别群任务", async () => {
	const id = makeItem();
	assert.throws(() => W.editWorkItem({ workItemId: id, actor: { kind: "agent", agentId: "wa", roomId: room.id }, ownerAgentId: "wb" }), /只有管理者或用户/);
	const bItem = W.createWorkItem({ roomId: otherRoom.id, title: "B 群任务", requirement: "写 B", doneCriteria: "B 有结果", ownerAgentId: "wc", start: false }, user).item.id;
	const before = JSON.stringify(row(bItem));
	const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
	W.workItemTools(room.id, "wm")({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
	assert.match((await defs.get("work_update")!.execute("t1", { workItemId: bItem, action: "edit", requirement: "偷偷改" })).content[0].text, /不在当前群|只有管理者/);
	assert.match((await defs.get("work_ask_user")!.execute("t2", { workItemId: bItem, question: "跨群提问" })).content[0].text, /不在这个群/);
	assert.equal(JSON.stringify(row(bItem)), before);
	await W.cancelWorkItem({ workItemId: id, actor: user });
	await W.cancelWorkItem({ workItemId: bItem, actor: user });
});

test("工具分工：群里管理者有记录 / 核验 / 改 / 请用户决定，成员只能看；提交和汇报只在任务会话里", async () => {
	const toolsOf = (factory: (pi: { registerTool: (t: unknown) => void }) => void) => {
		const defs = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
		factory({ registerTool: (d: unknown) => defs.set((d as { name: string }).name, d as never) });
		return defs;
	};
	const mgrTools = toolsOf(W.workItemTools(room.id, "wm"));
	const memberTools = toolsOf(W.workItemTools(room.id, "wa"));
	assert.deepEqual([...mgrTools.keys()].sort(), ["work_ask_user", "work_create", "work_list", "work_update", "work_verify"]);
	assert.deepEqual([...memberTools.keys()], ["work_list"]);
	await mgrTools.get("work_create")!.execute("t1", { title: "工具记录的任务", requirement: "写清楚", doneCriteria: "可检查", owner: "甲" });
	const item = (db.prepare("SELECT id FROM work_items WHERE title = '工具记录的任务'").get() as { id: string }).id;
	const c = await started(item);
	const execTools = toolsOf(W.workExecTools(item, "wa", c.conv));
	assert.deepEqual([...execTools.keys()].sort(), ["work_list", "work_report", "work_submit"]);
	assert.match((await execTools.get("work_submit")!.execute("t2", { workItemId: "wi_other", result: "x" })).content[0].text, /只负责任务/);
	assert.match((await execTools.get("work_report")!.execute("t3", { note: "做了一半" })).content[0].text, /已记录进展/);
	assert.match((await execTools.get("work_submit")!.execute("t4", { result: "产物 out.txt" })).content[0].text, /已提交/);
	assert.match((await mgrTools.get("work_verify")!.execute("t5", { workItemId: item, verdict: "pass", note: "看到 out.txt" })).content[0].text, /核验通过/);
	c.finish();
	assert.equal(row(item).status, "done");
});

test("重启：执行帮手走帮手的重启判定——还在跑的接回执行上下文；无法确认进度的标中断，任务状态不变、绝不自动重派", async () => {
	const id = makeItem("wa", true);
	const c = await started(id);
	const before = runRows(id).length;
	assert.equal(W.bootstrapWorkItems(), 0, "帮手还在跑：只接回执行上下文，不标中断");
	assert.equal(runRows(id)[0].status, "running");
	S.recoverSubagents(); // 模拟重启：这个帮手还没落库会话，无法确认做到哪一步 → 中断待核验
	await settle();
	assert.equal(S.getSubagent(c.helperId!)!.status, "lost");
	assert.equal(runRows(id).length, before, "重启不新建执行");
	assert.equal(runRows(id)[0].status, "interrupted");
	assert.equal(row(id).status, "active");
	assert.match(row(id).latestProgress, /中断/);
	assert.equal(W.bootstrapWorkItems(), 0, "幂等");
	c.finish();
	await settle();
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("移出成员：任务标受阻待改派，执行中止，不自动交给管理者", async () => {
	const id = makeItem("wa", true);
	const c = await started(id);
	rooms.updateRoom(room.id, { memberIds: ["wm", "wb"] });
	await settle();
	assert.equal(row(id).status, "blocked");
	assert.match(row(id).latestProgress, /待改派/);
	assert.equal(row(id).ownerAgentId, "wa");
	assert.equal(c.done, true);
	rooms.updateRoom(room.id, { memberIds: ["wm", "wa", "wb"] });
	await W.cancelWorkItem({ workItemId: id, actor: user });
});

test("看板分页：updated_at 相同的行也不会漏 / 重（beforeId 组合游标）", () => {
	const pRoom = rooms.createRoom({ name: "分页群", memberIds: ["wm", "wa"], managerId: "wm" });
	const ids = Array.from({ length: 5 }, (_, i) => W.createWorkItem({ roomId: pRoom.id, title: `分页${i}`, ownerAgentId: null, start: false }, user).item.id);
	db.prepare("UPDATE work_items SET updated_at = ? WHERE id IN (?,?,?)").run(1_700_000_000_000, ids[0], ids[1], ids[2]);
	db.prepare("UPDATE work_items SET updated_at = ? WHERE id IN (?,?)").run(1_700_000_000_000 + 5, ids[3], ids[4]);
	const seen: string[] = [];
	let before: number | undefined;
	let beforeId: string | undefined;
	for (let guard = 0; guard < 10; guard++) {
		const page = W.listWorkItems(pRoom.id, { limit: 2, before, beforeId });
		seen.push(...page.items.map((x) => x.id));
		if (!page.hasMore) break;
		before = page.nextBefore!;
		beforeId = page.nextBeforeId!;
	}
	assert.equal(new Set(seen).size, 5);
	assert.deepEqual([...seen].sort(), [...ids].sort());
	const legacy = W.listWorkItems(pRoom.id, { limit: 3, before: 1_700_000_000_001 });
	assert.deepEqual(legacy.items.map((x) => x.id).sort(), [ids[0], ids[1], ids[2]].sort());
});

test("删群：中止本群任务执行、清本群任务，其他群不受影响", async () => {
	const dRoom = rooms.createRoom({ name: "要删的群", memberIds: ["wm", "wa"], managerId: "wm" });
	const id = makeItem("wa", true, dRoom.id);
	const c = await started(id);
	const other = W.createWorkItem({ roomId: otherRoom.id, title: "保留的别群任务", ownerAgentId: null, start: false }, user).item;
	await rooms.deleteRoom(dRoom.id);
	await settle();
	assert.equal(c.done, true);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE id = ?").get(id) as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_exec_conversations WHERE work_item_id = ?").get(id) as { n: number }).n, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE id = ?").get(other.id) as { n: number }).n, 1);
});

test("群继续：旧版本绑着长期任务的暂停回合不重放，只提示去看板继续", async () => {
	const cRoom = rooms.createRoom({ name: "旧回合群", memberIds: ["wm", "wa"], managerId: "wm" });
	const id = makeItem("wa", false, cRoom.id);
	db.prepare("UPDATE rooms SET paused = ? WHERE id = ?").run(JSON.stringify({ pending: [{ agentId: "wa", reason: "assign", task: "旧", depth: 1, workItemId: id }], reason: "服务重启" }), cRoom.id);
	assert.equal(rooms.continueRoom(cRoom.id), true);
	await settle();
	assert.equal(runRows(id).length, 0, "不从群里重放任务执行");
	assert.ok(db.prepare("SELECT 1 FROM messages WHERE room_id = ? AND content LIKE '%任务看板上点继续%'").get(cRoom.id));
	await rooms.stop(cRoom.id, false);
	await rooms.deleteRoom(cRoom.id);
});
