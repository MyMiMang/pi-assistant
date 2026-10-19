import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

/**
 * 群里的帮手（决策 0014 第 5 步）：角色范围、最多一层嵌套、执行详情可见性、群任务执行跑在帮手上、核验通过后执行记忆转正。
 * 边界：临时数据目录（setup.ts）+ 内存凭据 + mock 模型登记；帮手用可控 driver，不起任何真实模型。
 */
process.env.PIA_MOCK = "1";
const { db, now } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore());
const R = await import("../src/runtime.ts");
const S = await import("../src/subagents.ts");
const H = await import("../src/helper-scope.ts");
const rooms = await import("../src/rooms/index.ts");
const W = await import("../src/work-items.ts");
const { roomHooks } = await import("../src/agent-runtime/room-hooks.ts");
const { insertMessage } = await import("../src/messages.ts");
const { createConversation } = await import("../src/conversations.ts");
const { memory } = await import("../src/memory/index.ts");

const model = { provider: "mock", id: "echo" };
const proto = Object.getPrototypeOf(R.runtime("gd", "conv_probe")) as Record<string, unknown>;
proto.turn = () => Promise.resolve({ ok: true, aborted: false, text: "", tokens: 0 }); // 群会话回合（管理者被唤醒）直接结束
proto.modelFor = () => model;
const runs = new Map<string, (r: { text?: string; error?: string }) => void>();
const notified: string[] = [];
S.setSubagentDriver({
	run: (r, connect) => new Promise<string>((resolve, reject) => {
		const end = (x: { text?: string; error?: string }) => { runs.delete(r.id); if (x.error) reject(new Error(x.error)); else resolve(x.text ?? ""); };
		runs.set(r.id, end);
		connect(async () => end({ text: "" }), async () => {});
	}),
	notify: async (r) => { notified.push(r.id); },
});
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const mk = (id: string, name: string, persona: string) => db.prepare("INSERT INTO agents(id, name, avatar, color, persona, created_at) VALUES(?,?,?,?,?,?)").run(id, name, "A", "#111", persona, now());
mk("gd", "导演", "你在群里的角色：导演\n统筹分工、核验成片");
mk("gw", "小编", "你在群里的角色：编剧\n负责写剧本和分镜台词");
mk("ga", "小美", "你在群里的角色：美术\n负责画分镜图");
const room = rooms.createRoom({ name: "短片组", memberIds: ["gd", "gw", "ga"], managerId: "gd" });
const { memberConversation } = await import("../src/rooms/store.ts");
const convOf = (agentId: string) => memberConversation(room.id, agentId);

test("角色范围：编剧派的帮手自动带上它代表谁、职责、不归它管的角色，不直接找成员 / 协调者；单聊不加", () => {
	const scope = H.helperScope("gw", convOf("gw"))!;
	assert.match(scope, /代表群「短片组」里的 小编（角色：编剧）/);
	assert.match(scope, /负责写剧本和分镜台词/);
	assert.match(scope, /小美（美术）/);
	assert.match(scope, /导演（协调者）/);
	assert.match(scope, /不要替他们做/);
	assert.match(scope, /不要直接联系群里的其他成员或协调者 导演/);
	assert.match(scope, /超出范围：…」交回给 小编/);
	assert.doesNotMatch(scope, /小编（编剧）/, "自己不在「不归你管」里");
	assert.equal(H.helperScope("gw", createConversation("gw").id), null, "单聊派的帮手不加群角色范围");
	assert.match(H.scopedContext(scope, undefined, "参考第一版")!, /^完成标准：完成上面的子任务/);
	assert.match(H.scopedContext(scope, "三场戏都有台词", undefined)!, /完成标准：三场戏都有台词/);
	assert.equal(H.scopedContext(null, "x", "上下文"), "上下文", "不在群里不改原说明");
});

test("最多一层：帮手派的下一层继承同样的范围，第二层不能再派；下一层的结果交给上一层，不唤醒主会话", async () => {
	const conv = convOf("gw");
	const scope = H.helperScope("gw", conv);
	const top = S.spawnSubagent("gw", conv, model, { task: "写三场戏的剧本", scope });
	const kid = S.spawnSubagent("gw", conv, model, { task: "先写第一场", parentSubagentId: top.id });
	assert.equal(kid.parent_subagent_id, top.id);
	assert.equal(kid.scope, scope, "下一层继承角色范围");
	assert.throws(() => S.spawnSubagent("gw", conv, model, { task: "再往下派", parentSubagentId: kid.id }), /最多再派一层/);
	await settle();
	const seen = new Set<string>();
	const waiting = H.awaitChildResults(top.id, seen, () => true);
	runs.get(kid.id)!({ text: "第一场写好了：scene1.md" });
	const note = await waiting;
	assert.match(note!, /先写第一场.*完成：第一场写好了：scene1\.md/);
	assert.equal(await H.awaitChildResults(top.id, seen, () => true), null, "已经交过的不重复");
	await S.deliverSubagentEvents();
	await settle();
	assert.ok(!notified.includes(kid.id), "下一层的事件不唤醒主会话（上一层收）");
	// 上一层被停：还在跑的下一层一并停掉
	const kid2 = S.spawnSubagent("gw", conv, model, { task: "写第二场", parentSubagentId: top.id });
	await settle();
	await S.stopSubagent(top.id);
	await settle();
	assert.equal(S.getSubagent(kid2.id)!.status, "stopped");
});

test("帮手没有群发言工具；群任务执行的帮手只多 work_submit / work_report", async () => {
	const conv = convOf("gw");
	const h = S.spawnSubagent("gw", conv, model, { task: "查资料" });
	assert.deepEqual(roomHooks!.extensions("gw", conv, h.id), [], "普通帮手：没有 room_* / work_* 工具，不能直接找成员或协调者");
	assert.ok(roomHooks!.extensions("gw", conv, null).some((e) => e.name === "pia-room"), "成员自己仍有群工具");
	await S.stopSubagent(h.id);
});

test("可见性：群里别的成员默认只看到帮手概况（谁派的、在做什么、当前步骤、结果），完整步骤只有派它的助理和用户能看；一个设置可改", async () => {
	const conv = convOf("gw");
	const h = S.spawnSubagent("gw", conv, model, { task: "写第三场的台词", title: "第三场台词" });
	await settle();
	insertMessage({ agentId: "gw", conversationId: conv, subagentId: h.id, role: "tool", content: "$ cat secret-draft.md\n很长的命令输出", meta: { toolName: "bash", status: "done" } });
	insertMessage({ agentId: "gw", conversationId: conv, subagentId: h.id, role: "assistant", content: "台词写到一半了" });
	assert.equal(H.groupHelperDetail(), "owner", "默认：只有派它的助理和用户");
	const peer = H.peerHelperView("ga", convOf("ga"), S.getSubagent(h.id)) as Record<string, unknown>;
	assert.equal(peer.spawnedBy, "小编");
	assert.equal(peer.title, "第三场台词");
	assert.equal(peer.status, "running");
	assert.equal(peer.currentStep, "bash");
	assert.equal(peer.progress, "台词写到一半了");
	assert.ok(!("steps" in peer) && !JSON.stringify(peer).includes("secret-draft"), "没有工具步骤 / 命令输出");
	assert.equal(H.peerHelperView("gw", convOf("gw"), S.getSubagent(h.id)), null, "自己派的走完整记录，不走概况");
	assert.equal(H.peerHelperView("ga", createConversation("ga").id, S.getSubagent(h.id)), null, "不在同一个群看不到");
	assert.ok(H.roomHelpers(room.id, "ga").some((r) => r.id === h.id), "群里能列出别人派的帮手");
	assert.match(JSON.stringify(H.helperSteps(h.id)), /secret-draft/, "完整步骤（派它的助理 / 用户详情页）");
	H.setGroupHelperDetail("group");
	assert.match(JSON.stringify(H.peerHelperView("ga", convOf("ga"), S.getSubagent(h.id))), /secret-draft/, "改成 group 后群成员也能看完整详情");
	H.setGroupHelperDetail("owner");
	assert.throws(() => H.setGroupHelperDetail("all"), /owner|group/);
	runs.get(h.id)!({ text: "第三场台词完成" });
	await settle();
	assert.equal((H.peerHelperView("ga", convOf("ga"), S.getSubagent(h.id)) as { result: string }).result, "第三场台词完成");
});

test("群任务执行跑在负责人的帮手上（带角色范围）；核验通过后这次执行写的记忆草稿自动转正，退回的不转", async () => {
	const item = W.createWorkItem({ roomId: room.id, title: "写剧本", requirement: "三场戏", doneCriteria: "每场都有台词", ownerAgentId: "gw", start: true }, { kind: "user" }).item;
	await settle();
	const run = db.prepare("SELECT * FROM work_item_runs WHERE work_item_id = ?").get(item.id) as { exec_kind: string; exec_id: string };
	assert.equal(run.exec_kind, "helper");
	const h = S.getSubagent(run.exec_id)!;
	assert.equal(h.kind, "work");
	assert.match(h.scope ?? "", /小编（角色：编剧）/);
	assert.match(h.scope ?? "", /所属群任务：写剧本（任务的完成标准：每场都有台词）/);
	assert.ok(roomHooks!.extensions("gw", h.conversation_id, h.id).some((e) => e.name === "pia-work-exec"), "执行帮手能提交");
	const draft = await memory.remember("gw", h.conversation_id, { content: "导演偏好短句台词", kind: "fact", actor: "subagent", taskId: h.id, subagentId: h.id });
	assert.equal(draft.status, "draft");
	W.submitWorkItem({ workItemId: item.id, conversationId: h.conversation_id, actor: { kind: "agent", agentId: "gw" }, result: "script.md 三场都有台词" });
	runs.get(h.id)!({ text: "已提交" });
	await settle();
	assert.equal(S.getSubagent(h.id)!.status, "done");
	await W.verifyWorkItem({ workItemId: item.id, actor: { kind: "user" }, verdict: "pass", note: "看过 script.md" });
	const after = (await memory.list("gw", undefined, undefined, { parent: true })).find((i) => i.text === "导演偏好短句台词");
	assert.ok(after && after.status !== "draft", `核验通过后转正（现在是 ${after?.status}）`);
	assert.ok(db.prepare("SELECT 1 FROM work_item_events WHERE work_item_id = ? AND kind = 'memory.promoted'").get(item.id));
	// 不属于任务的帮手草稿不动
	const loose = S.spawnSubagent("gw", convOf("gw"), model, { task: "随手查" });
	await memory.remember("gw", convOf("gw"), { content: "随手查到的猜测", kind: "fact", actor: "subagent", taskId: loose.id, subagentId: loose.id });
	assert.equal(await W.promoteRunMemories(item.id, 1), 0);
	assert.ok((await memory.listDrafts("gw")).some((d) => d.text === "随手查到的猜测"), "不属于任务的草稿保持草稿");
	await S.stopSubagent(loose.id);
});

test("群转录：别的成员看到「谁的帮手、在做什么、当前步骤 / 结果」，看不到工具输出", async () => {
	const { buildTranscript } = await import("../src/rooms/logic.ts");
	const card = (status: string, extra: Record<string, unknown> = {}) => ({ seq: 1, role: "card" as const, agentId: "gw", content: "", status: "done", meta: { kind: "subagent", subagentId: "sa_x", currentStep: "bash", subagent: { title: "第三场台词", task: "写第三场", status, ...extra } } });
	const names = (id: string) => ({ gw: "小编" })[id] ?? id;
	assert.equal(buildTranscript([card("running")], "ga", names).text, "[小编 的帮手] 第三场台词（进行中，当前步骤：bash）");
	assert.equal(buildTranscript([card("done", { result_summary: "台词写好了：scene3.md" })], "ga", names).text, "[小编 的帮手] 第三场台词（已完成：台词写好了：scene3.md）");
});
