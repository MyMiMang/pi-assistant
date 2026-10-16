/**
 * 助理级子代理上限（并发 / 最长运行）的集中有效值 + 排队 / 超时的 owner 语义。
 *
 * 覆盖用户已确认的行为（契约见 docs/design/settings-functional-backend.md）：
 *   - 没覆盖 = 继承全局默认（旧库 / 旧 API 行为不变）；
 *   - 覆盖存独立键，只影响该助理，不改全局、不 copy 给其它助理、不碰 subagentModel 候选池；
 *   - 并发**按助理分别计数**（不回退成全局池）；改上限对下一个 pump 生效；
 *   - 超时按**该任务的 owner agentId** 取有效 maxMinutes。
 *
 * 边界：临时数据目录 + 内存 CredentialStore + 假 driver；不联网、不碰真实数据 / 钥匙串。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Subagent, SubagentEvent } from "../src/subagents.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

process.env.PIA_MOCK = "1";
const { db, getSetting } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore());
const s = await import("../src/subagents.ts");
const { createConversation } = await import("../src/conversations.ts");

db.prepare("INSERT INTO agents(id, name, avatar, color, persona, created_at) VALUES(?,?,'🔧','#888','',?)").run("lim-a", "上限A", Date.now());
db.prepare("INSERT INTO agents(id, name, avatar, color, persona, created_at) VALUES(?,?,'🔧','#888','',?)").run("lim-b", "上限B", Date.now());
const convA = createConversation("lim-a").id;
const convB = createConversation("lim-b").id;
const model = { provider: "mock", id: "echo" };
const tick = () => new Promise((r) => setTimeout(r, 20));
const status = (id: string) => s.getSubagent(id)!.status;

/** 可控 driver：run 一直挂着，直到显式完成（completeNext）或停止。 */
let resolvers: ((v: string) => void)[] = [];
function manualDriver() {
	resolvers = [];
	s.setSubagentDriver({
		run: (_r: Subagent, connect: (stop: () => Promise<void>, message: (t: string, id?: string) => Promise<void>) => void) =>
			new Promise<string>((resolve) => {
				resolvers.push(resolve);
				connect(async () => resolve("停止"), async () => {});
			}),
		notify: async (_r: Subagent, _e: SubagentEvent) => {},
	});
}
const completeNext = () => resolvers.shift()?.("结果");
const spawn = (agentId: string, conv: string, task: string) => s.spawnSubagent(agentId, conv, model, { task });

test("有效值：无覆盖继承全局默认；覆盖只影响该助理，不改全局、不 copy、不碰候选池", () => {
	s.saveSubagentSettings({ maxConcurrent: 10, maxMinutes: 60 });
	assert.deepEqual(s.getSubagentSettings("lim-a"), { maxConcurrent: 10, maxMinutes: 60 });
	assert.deepEqual(s.getSubagentSettings(), { maxConcurrent: 10, maxMinutes: 60 });

	const a = s.saveAgentSubagentLimits("lim-a", { maxConcurrent: 3 });
	assert.deepEqual(a, { settings: { maxConcurrent: 3, maxMinutes: 60 }, overrides: { maxConcurrent: 3 }, defaults: { maxConcurrent: 10, maxMinutes: 60 } });
	// B 完全不受影响：没有覆盖记录，也不继承 A 的值
	assert.deepEqual(s.agentSubagentLimits("lim-b"), {});
	assert.deepEqual(s.getSubagentSettings("lim-b"), { maxConcurrent: 10, maxMinutes: 60 });
	// 全局默认没被改写；也没有给任何助理写候选池
	assert.deepEqual(s.subagentSettings(), { maxConcurrent: 10, maxMinutes: 60 });
	assert.deepEqual(s.agentSubagentPool("lim-a"), []);
	assert.deepEqual(s.agentSubagentPool("lim-b"), []);
	// 覆盖是独立键，不是全局 key 的副本
	assert.deepEqual(getSetting("subagentLimits:lim-a", null), { maxConcurrent: 3 });
	assert.equal(getSetting("subagentLimits:lim-b", null), null);

	// patch：只改 maxMinutes 时并发覆盖保留
	assert.deepEqual(s.saveAgentSubagentLimits("lim-a", { maxMinutes: 30 }).settings, { maxConcurrent: 3, maxMinutes: 30 });
	// null 清除 → 继承全局默认（该键一起清掉）
	assert.deepEqual(s.saveAgentSubagentLimits("lim-a", { maxConcurrent: null }), { settings: { maxConcurrent: 10, maxMinutes: 30 }, overrides: { maxMinutes: 30 }, defaults: { maxConcurrent: 10, maxMinutes: 60 } });
	assert.deepEqual(getSetting("subagentLimits:lim-a", null), { maxMinutes: 30 });
	s.saveAgentSubagentLimits("lim-a", { maxMinutes: null });
	assert.deepEqual(s.agentSubagentLimits("lim-a"), {});

	// 非法值拒绝且不落库
	assert.throws(() => s.saveAgentSubagentLimits("lim-a", { maxConcurrent: 0 }), /并发上限/);
	assert.throws(() => s.saveAgentSubagentLimits("lim-a", { maxConcurrent: 101 }), /并发上限/);
	assert.throws(() => s.saveAgentSubagentLimits("lim-a", { maxConcurrent: 1.5 }), /并发上限/);
	assert.throws(() => s.saveAgentSubagentLimits("lim-a", { maxMinutes: 0 }), /最长运行时间/);
	assert.deepEqual(s.agentSubagentLimits("lim-a"), {});
});

test("排队：并发按助理分别计数；改上限对下一次 pump 生效", async () => {
	manualDriver();
	s.saveSubagentSettings({ maxConcurrent: 10, maxMinutes: 60 });
	s.saveAgentSubagentLimits("lim-a", { maxConcurrent: 1 });
	s.saveAgentSubagentLimits("lim-b", { maxConcurrent: 1 });
	const a1 = spawn("lim-a", convA, "A1");
	const a2 = spawn("lim-a", convA, "A2");
	const b1 = spawn("lim-b", convB, "B1");
	const b2 = spawn("lim-b", convB, "B2");
	await tick();
	// 各助理各有 1 个在跑、1 个排队：全局只有 1 个名额时 B 会被 A 占满（这里证明不是全局池）
	assert.deepEqual([status(a1.id), status(a2.id), status(b1.id), status(b2.id)], ["running", "queued", "running", "queued"]);
	assert.equal(s.hasSubagentCapacity("lim-a"), false);
	assert.equal(s.hasSubagentCapacity("lim-b"), false);

	// A 提到 2 → pump 后 A2 开始；B 不受影响
	s.saveAgentSubagentLimits("lim-a", { maxConcurrent: 2 });
	await tick();
	assert.equal(status(a2.id), "running");
	assert.equal(status(b2.id), "queued");

	// 完成一个再放开：终态会 pump 该助理的下一个
	completeNext();
	await tick();
	assert.equal(status(a1.id), "done");
	completeNext(); // a2
	await tick();
	// B 提高上限后才补位
	s.saveAgentSubagentLimits("lim-b", { maxConcurrent: 2 });
	await tick();
	assert.equal(status(b2.id), "running");
	await s.stopAgentSubagents("lim-a");
	await s.stopAgentSubagents("lim-b");
});

test("超时按 owner 助理的有效 maxMinutes：A 的短超时不会误杀 B", async () => {
	manualDriver();
	s.saveSubagentSettings({ maxConcurrent: 10, maxMinutes: 60 });
	s.saveAgentSubagentLimits("lim-a", { maxMinutes: 0.001 }); // 60ms
	const a = spawn("lim-a", convA, "A 短超时");
	const b = spawn("lim-b", convB, "B 默认 60 分钟");
	await tick();
	assert.equal(status(a.id), "running");
	assert.equal(status(b.id), "running");
	await s.checkSubagents(Date.now() + 200);
	assert.equal(status(a.id), "timeout");
	assert.equal(status(b.id), "running");
	await s.stopAgentSubagents("lim-a");
	await s.stopAgentSubagents("lim-b");
	s.deleteAgentSubagentLimits("lim-a");
	assert.deepEqual(s.agentSubagentLimits("lim-a"), {});
});
