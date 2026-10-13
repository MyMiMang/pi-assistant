import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Subagent, SubagentEvent } from "../src/subagents.ts";
process.env.PIA_MOCK = "1";
const { db, setSetting } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels();
const s = await import("../src/subagents.ts");
const { createConversation } = await import("../src/conversations.ts");
const { listMessages, insertMessage } = await import("../src/messages.ts");
const { recordUsage, usageSummary } = await import("../src/usage/index.ts");
db.prepare("INSERT INTO agents(id, name, avatar, color, persona, created_at) VALUES(?,?,'🔧','#888','',?)").run("sub-test", "测试", Date.now());
const conv = createConversation("sub-test").id;
const model = { provider: "mock", id: "echo" };
const tick = () => new Promise((r) => setTimeout(r, 20));
function waitingDriver(notify: (r: Subagent, e: SubagentEvent) => Promise<void> = async () => {}) {
	s.setSubagentDriver({ run: (_r, connect) => new Promise<string>((resolve) => connect(async () => { resolve("停止"); }, async () => {})), notify });
}
const spawn = () => s.spawnSubagent("sub-test", conv, model, { task: "写代码" });
const events = (id: string) => db.prepare("SELECT * FROM subagent_events WHERE subagent_id = ?").all(id);

test("模型选择：默认跟随、允许清单内自动挑、显式限制、全局和助理指定", () => {
	assert.equal(s.chooseSubagentModel("sub-test", model, "写代码").model.id, "echo");
	s.saveSubagentSettings({ mode: "auto", allowed: [{ provider: "mock", id: "echo-think" }], maxMinutes: 60 });
	assert.equal(s.chooseSubagentModel("sub-test", model, "推理").model.id, "echo-think");
	assert.throws(() => s.chooseSubagentModel("sub-test", model, "", [], model), /允许清单/);
	s.saveSubagentSettings({ mode: "fixed", model, allowed: [], maxMinutes: 60 });
	assert.equal(s.chooseSubagentModel("sub-test", model, "").model.id, "echo");
	s.saveAgentSubagentChoice("sub-test", { mode: "fixed", model: { provider: "mock", id: "echo-think" } });
	assert.equal(s.chooseSubagentModel("sub-test", model, "").model.id, "echo-think");
	s.saveAgentSubagentChoice("sub-test", { mode: "follow" });
	s.saveSubagentSettings({ mode: "follow", allowed: [], maxMinutes: 60 });
});

test("并发 3、唯一终态、通知失败后重投，历史步骤不混入主会话且用量归属助理", async () => {
	let attempts = 0;
	waitingDriver(async () => { if (++attempts === 1) throw new Error("暂时投递失败"); });
	const rows = [spawn(), spawn(), spawn()];
	assert.throws(spawn, /3 个/);
	await tick();
	assert.equal(s.finishSubagent(rows[0].id, "done", "", "结果"), true);
	assert.equal(s.finishSubagent(rows[0].id, "failed", "迟到的错误"), false);
	await tick();
	assert.equal(events(rows[0].id).length, 1);
	await s.deliverSubagentEvents(); await tick();
	assert.ok((events(rows[0].id)[0] as { delivered_at: number }).delivered_at);
	const hidden = insertMessage({ agentId: "sub-test", conversationId: conv, subagentId: rows[0].id, role: "assistant", content: "后台步骤" });
	assert.ok(!listMessages("sub-test", { conversationId: conv }).some((m) => m.id === hidden.id));
	recordUsage({ agentId: "sub-test", conversationId: conv, subagentId: rows[0].id, provider: "mock", model: "echo", input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
	assert.equal(usageSummary({ agentId: "sub-test" }).totals.calls, 1);
	assert.equal((db.prepare("SELECT subagent_id FROM usage_calls WHERE agent_id = 'sub-test'").get() as { subagent_id: string }).subagent_id, rows[0].id);
	await s.stopAgentSubagents("sub-test");
});

test("执行抛错必进 failed，重复结束不再发事件", async () => {
	s.setSubagentDriver({ run: async () => { throw new Error("模型接口失败"); }, notify: async () => {} });
	const r = spawn(); await tick();
	assert.equal(s.getSubagent(r.id)!.status, "failed");
	assert.match(s.getSubagent(r.id)!.error_reason!, /模型接口失败/);
	assert.equal(events(r.id).length, 1);
});

test("看门狗：长工具豁免、停滞、恢复、最长时间超时", async () => {
	waitingDriver(); const r = spawn(); await tick();
	s.subagentActivity(r.id, 600_000);
	await s.checkSubagents(Date.now() + 181_000);
	assert.equal(s.getSubagent(r.id)!.status, "running");
	s.subagentActivity(r.id, 0);
	await s.checkSubagents(Date.now() + 181_000);
	assert.equal(s.getSubagent(r.id)!.status, "stalled");
	s.subagentActivity(r.id);
	assert.equal(s.getSubagent(r.id)!.status, "running");
	await s.checkSubagents(r.created_at + 60 * 60_000);
	assert.equal(s.getSubagent(r.id)!.status, "timeout");
	assert.deepEqual(events(r.id).map((e) => (e as { kind: string }).kind), ["stalled", "resumed", "timeout"]);
});

test("重启恢复：运行中任务标 lost，事件落库；终态不再恢复", async () => {
	waitingDriver(); const r = spawn(); await tick();
	s.recoverSubagents();
	assert.equal(s.getSubagent(r.id)!.status, "lost");
	assert.equal(events(r.id).length, 1);
	s.recoverSubagents();
	assert.equal(events(r.id).length, 1);
});
