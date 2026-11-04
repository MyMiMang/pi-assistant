/**
 * 决策 0027：后台任务并进帮手。
 * - 给模型的 spawn_task 工具不存在（ext-delivery 只留 spawn_subagent）；
 * - 单聊主会话派帮手 → 聊天里一张帮手卡片，状态跟着帮手更新；
 * - 群会话 / 下一层帮手 / 带来源（routine 等）的不插卡片。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryCredentialStore } from "./in-memory-credentials.ts";
process.env.PIA_MOCK = "1";
const { db, now } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore());
await import("../src/runtime.ts");
const { announceHelper } = await import("../src/agent-runtime/background-tasks.ts");
const { spawnSubagent, getSubagent, stopSubagent } = await import("../src/subagents.ts");
const { createConversation } = await import("../src/conversations.ts");
const { listMessages } = await import("../src/messages.ts");
const { deliveryExtension } = await import("@pi-assistant/ext-delivery");

db.prepare("INSERT INTO agents(id, name, avatar, color, persona, created_at) VALUES(?,?,'🔧','#888','',?)").run("hc-test", "测试", Date.now());
const model = { provider: "mock", id: "echo" };
// 帮手用可控 driver：不起真实模型，停止时结束
const { setSubagentDriver } = await import("../src/subagents.ts");
setSubagentDriver({
	run: (_r, connect) => new Promise<string>((resolve) => connect(async () => resolve(""), async () => {})),
	notify: async () => {},
});
const cards = (conv: string) => listMessages("hc-test", { conversationId: conv }).filter((m) => m.role === "card" && m.meta.kind === "task");
const wait = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); };

test("模型工具里没有 spawn_task，派活只有 spawn_subagent；task_wait 不再有 task_id", () => {
	const tools: { name: string; parameters: { properties: Record<string, unknown> } }[] = [];
	const host = { deliverFile: async () => ({ fileId: "", name: "" }), ask: async () => "", subagents: { spawn: async () => ({ id: "x" }), list: () => [], message: async () => {}, stop: async () => true }, waits: { register: () => ({ id: "", kind: "", dueAt: null, intervalMs: 0 }), list: () => [], refresh: async () => ({ status: "", detail: "", fired: false }), cancel: () => true } };
	deliveryExtension(host as never)({ registerTool: (t: never) => tools.push(t) } as never);
	const names = tools.map((t) => t.name);
	assert.ok(names.includes("spawn_subagent"));
	assert.ok(!names.includes("spawn_task"));
	assert.ok(!("task_id" in tools.find((t) => t.name === "task_wait")!.parameters.properties));
});

test("单聊主会话派的帮手：插一张卡片，状态随帮手更新", async () => {
	const conv = createConversation("hc-test").id;
	const h = spawnSubagent("hc-test", conv, model, { task: "统计工作区文件：列出工作区所有文件并统计数量，给出简短总结，写得很长很长很长很长" });
	announceHelper(h);
	const c = cards(conv);
	assert.equal(c.length, 1);
	assert.equal(c[0].meta.helper, true);
	assert.equal(c[0].meta.taskId, h.id);
	assert.equal(c[0].meta.title, h.task.slice(0, 40));
	await stopSubagent(h.id);
	await wait(() => cards(conv)[0].meta.status === "cancelled");
	assert.equal(cards(conv)[0].meta.status, "cancelled", "帮手停止后卡片状态同步");
});

test("群会话 / 下一层帮手 / 带来源（定时）的帮手不插卡片", async () => {
	db.prepare("INSERT INTO room_members(room_id, agent_id, conversation_id, name, avatar, color, joined_at) VALUES('hc-room','hc-test','hc-roomconv','小助','A','#000',?)").run(now());
	const room = spawnSubagent("hc-test", "hc-roomconv", model, { task: "群里的活" });
	announceHelper(room);
	const conv = createConversation("hc-test").id;
	const top = spawnSubagent("hc-test", conv, model, { task: "上一层", kind: undefined });
	const nested = spawnSubagent("hc-test", conv, model, { task: "下一层", parentSubagentId: top.id });
	announceHelper(nested);
	const routine = spawnSubagent("hc-test", conv, model, { task: "定时活", kind: "routine" });
	announceHelper(routine);
	assert.equal(listMessages("hc-test", { conversationId: "hc-roomconv" }).filter((m) => m.meta.kind === "task").length, 0);
	assert.equal(cards(conv).length, 0);
	for (const id of [room.id, top.id, nested.id, routine.id]) await stopSubagent(id);
	assert.ok(getSubagent(top.id));
});
