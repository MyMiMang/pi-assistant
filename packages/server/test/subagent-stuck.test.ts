/**
 * 单聊帮手（子代理）卡住上报（决策 0014 第 3 步，规则复用 stuck.ts）：
 * 没进展 → 先叫醒主会话，主会话之后仍没动静 → 问用户；同一原因第 2 次失败 → 提示换方法，第 3 次 → 问用户。
 * 临时数据 + Mock + 内存凭据；driver 是可控假驱动，不跑模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Subagent, SubagentEvent } from "../src/subagents.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";
process.env.PIA_MOCK = "1";
const { db } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore());
const s = await import("../src/subagents.ts");
await import("../src/task-waits.ts");
const { requests } = await import("../src/requests.ts");
const { createConversation } = await import("../src/conversations.ts");
db.prepare("INSERT INTO agents(id, name, avatar, color, persona, created_at) VALUES(?,?,'🔧','#888','',?)").run("stuck-test", "测试", Date.now());
const conv = createConversation("stuck-test").id;
const tick = () => new Promise((r) => setTimeout(r, 20));
const woken: SubagentEvent[] = [];
s.setSubagentDriver({ run: (_r, connect) => new Promise<string>((resolve) => connect(async () => resolve("停止"), async () => {})), notify: async (_r: Subagent, e: SubagentEvent) => void woken.push(e) });
s.saveSubagentSettings({ maxMinutes: 600, maxConcurrent: 10 });
const question = (id: string) => db.prepare("SELECT * FROM requests WHERE task_id = ? AND kind = 'question' AND status = 'pending'").get(id) as { id: string; payload: string } | undefined;
const STALL = 180_000;

test("没进展：先叫醒主会话；主会话之后仍没动静再问用户；用户点停止就停", async () => {
	const r = s.spawnSubagent("stuck-test", conv, { provider: "mock", id: "echo" }, { task: "整理很多文件" });
	await tick();
	const t0 = s.getSubagent(r.id)!.last_activity_at;
	await s.checkSubagents(t0 + STALL + 1);
	assert.equal(s.getSubagent(r.id)!.status, "stalled");
	assert.ok(woken.some((e) => e.kind === "stalled" && e.subagent_id === r.id), "第一级：叫醒主会话");
	assert.equal(question(r.id), undefined, "还没到问用户的时候");
	await s.checkSubagents(t0 + 2 * STALL + 2);
	const q = question(r.id);
	assert.ok(q, "主会话处理后仍没动静：问用户");
	assert.match(JSON.parse(q.payload).question, /帮手「整理很多文件」.*没有进展/);
	requests.resolve(q.id, { answer: "停止这个帮手" }, "user");
	await tick(); await tick();
	assert.equal(s.getSubagent(r.id)!.status, "stopped");
});

test("没进展问用户后，帮手又有动静 → 提问自动收掉；用户选继续等 → 重新计时不再打扰", async () => {
	const r = s.spawnSubagent("stuck-test", conv, { provider: "mock", id: "echo" }, { task: "下载资料" });
	await tick();
	const t0 = s.getSubagent(r.id)!.last_activity_at;
	await s.checkSubagents(t0 + STALL + 1);
	await s.checkSubagents(t0 + 2 * STALL + 2);
	assert.ok(question(r.id));
	s.subagentActivity(r.id);
	assert.equal(question(r.id), undefined, "恢复进展后不再需要用户决定");
	assert.equal(s.getSubagent(r.id)!.status, "running");
	const t1 = Date.now();
	await s.checkSubagents(t1 + STALL + 1);
	await s.checkSubagents(t1 + 2 * STALL + 2);
	const q = question(r.id)!;
	requests.resolve(q.id, { answer: "继续等" }, "user");
	await tick();
	assert.equal(s.getSubagent(r.id)!.escalation, null);
	assert.ok(s.getSubagent(r.id)!.last_activity_at >= t1, "重新计时");
	await s.stopSubagent(r.id);
});

test("反复卡在同一处：第 2 次提示主会话换方法，第 3 次问用户；用户的决定交给主会话", async () => {
	const r = s.spawnSubagent("stuck-test", conv, { provider: "mock", id: "echo" }, { task: "部署网站" });
	await tick();
	const fail = (why: string) => {
		db.prepare("UPDATE subagents SET status = 'running' WHERE id = ?").run(r.id);
		s.finishSubagent(r.id, "failed", why);
		return s.getSubagent(r.id)!.error_reason ?? "";
	};
	assert.doesNotMatch(fail("连接 api.example.com 超时（第 1 次）"), /反复/);
	assert.match(fail("连接 api.example.com 超时（第 2 次）"), /反复卡在同一处，第 2 次：换个方法/);
	assert.equal(question(r.id), undefined);
	assert.match(fail("连接 api.example.com 超时（第 3 次）"), /第 3 次，已请用户决定/);
	const q = question(r.id)!;
	assert.match(JSON.parse(q.payload).question, /第 3 次卡在同一处/);
	assert.doesNotMatch(fail("磁盘空间不足，写入失败"), /反复/, "不同原因不算同一处");
	woken.length = 0;
	requests.resolve(q.id, { answer: "换成备用服务器再试" }, "user");
	await tick(); await tick();
	const d = woken.find((e) => e.kind === "decided");
	assert.ok(d, "用户的决定交给主会话");
	assert.match(d.reason, /换成备用服务器再试/);
});
