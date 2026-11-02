/**
 * 发出去、助理还没看到的消息可以撤回（docs/design/recall-pending-message.md）。
 * 临时数据 + Mock 模型。Pi 层用真实会话验证「队列里 3 条撤回中间那条」；服务层验证消息状态 / 群里排队 / 已送达拒绝。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sandboxExtension } from "@pi-assistant/ext-sandbox";
import { config } from "../src/config.ts";
import { db, now } from "../src/db.ts";
import { getMessage, insertMessage } from "../src/messages.ts";
import { makeBackgroundBashTool } from "../src/pi-adapter/bg-shell.ts";
import { createPiSession, PiModels, promptSession, recallQueuedSteer } from "../src/pi-adapter/index.ts";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "../src/pi-adapter/mock-provider.ts";
import { EncryptedCredentialStore } from "../src/secrets.ts";

const models = await PiModels.create({ credentials: new EncryptedCredentialStore(), modelsPath: null, allowNetwork: false });
await registerMockProvider(models);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 15000) => {
	const t = Date.now();
	while (!f()) {
		if (Date.now() - t > ms) throw new Error("等待条件超时");
		await sleep(25);
	}
};
const userTexts = (s: { messages: unknown[] }) =>
	(s.messages as { role: string; content: unknown }[]).filter((m) => m.role === "user" || m.role === "custom").map((m) => (typeof m.content === "string" ? m.content : (m.content as { text?: string }[]).map((c) => c.text ?? "").join("")));

async function busySession(name: string) {
	const ws = join(config.workspaceRoot, name);
	mkdirSync(ws, { recursive: true });
	const own = { key: `conv:${name}`, agentId: name, conversationId: name };
	const s = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, name),
		sessionDir: join(config.agentsDir, name, "sessions"),
		model: { provider: MOCK_PROVIDER, id: MOCK_MODEL },
		systemPromptAppend: [],
		extensions: [{ name: "sandbox", factory: sandboxExtension({ workspace: ws, mode: "workspace", makeBashTool: ((cwd: string, o: never) => makeBackgroundBashTool(cwd, o, own)) as never }) }],
	});
	const run = promptSession(s, "慢慢数"); // 三步、每步 2 秒：期间有三个工具边界
	await until(() => s.isStreaming);
	return { s, run };
}

test("Pi 层：队列里 3 条，撤回中间那条；剩下 2 条原顺序、原内容（含前缀）、都能送达，自定义消息也在", async () => {
	const { s, run } = await busySession("rc-pi");
	await promptSession(s, "第一条 A");
	await promptSession(s, "第二条 B");
	await promptSession(s, "第三条 C");
	await s.sendCustomMessage({ customType: "pia_bg_job", content: "（后台命令结束）x", display: false }, { triggerTurn: true });
	assert.equal(s.getSteeringMessages().length, 3);
	const before = s.agent.steeringMode;
	assert.equal(recallQueuedSteer(s, "第二条 B"), true);
	assert.equal(s.agent.steeringMode, before, "模式已还原");
	assert.equal(recallQueuedSteer(s, "第二条 B"), false, "已经不在队列里");
	assert.equal(recallQueuedSteer(s, "根本没发过"), false);
	await run;
	await until(() => !s.isStreaming);
	const texts = userTexts(s);
	assert.ok(!texts.some((t) => t.includes("第二条 B")), "助理收不到被撤回的那条");
	const a = texts.findIndex((t) => t.includes("第一条 A"));
	const c = texts.findIndex((t) => t.includes("第三条 C"));
	const x = texts.findIndex((t) => t.includes("（后台命令结束）x"));
	assert.ok(a > 0 && c > a && x > 0, `都送达且顺序不变：${JSON.stringify(texts)}`);
	assert.ok(texts[a].startsWith("（你工作时用户发来的新消息）"), "插话前缀保留");
	s.dispose();
});

test("Pi 层：已经送达（进了上下文）的不能撤回；没在跑的也不能", async () => {
	const { s, run } = await busySession("rc-pi2");
	await promptSession(s, "第一条 A");
	await until(() => userTexts(s).some((t) => t.includes("第一条 A")));
	assert.equal(recallQueuedSteer(s, "第一条 A"), false);
	await run;
	assert.equal(recallQueuedSteer(s, "第一条 A"), false);
	s.dispose();
});

// ---------------------------------------------------------------- 服务层

const { recallUserMessage } = await import("../src/recall.ts");
const { runtimes } = await import("../src/agent-runtime/agent-runtime.ts");
const { states, fresh } = await import("../src/rooms/queue.ts");

test("单聊：未送达可撤回（变成灰色提示、保留原文供重新编辑）；已送达 409；撤回幂等", () => {
	const m1 = insertMessage({ agentId: "ra", conversationId: "rc1", role: "user", content: "改成 B 方案", meta: { delivery: "queued" } });
	const m2 = insertMessage({ agentId: "ra", conversationId: "rc1", role: "user", content: "已经读到的", meta: { delivery: "delivered" } });
	runtimes.set("rc1", { recallSteering: (id: string) => id === m1.id } as never);
	const bad = recallUserMessage(m2.id);
	assert.equal(bad.ok, false);
	assert.equal(getMessage(m2.id)?.role, "user", "没动");
	const r = recallUserMessage(m1.id);
	assert.deepEqual(r, { ok: true, text: "改成 B 方案" });
	const after = getMessage(m1.id)!;
	assert.equal(after.role, "system");
	assert.equal(after.meta.recalled, true);
	assert.equal(after.meta.recalledText, "改成 B 方案");
	assert.deepEqual(recallUserMessage(m1.id), { ok: true, text: "改成 B 方案" });
	assert.equal(recallUserMessage("nope").ok, false);
	runtimes.delete("rc1");
});

test("群里：排队没轮到可撤回（取消排队回合）；有成员已开始读就不行", () => {
	const room = "rr1";
	const s = fresh();
	states.set(room, s);
	const mk = (content: string) => insertMessage({ agentId: "", roomId: room, conversationId: null, role: "user", content });
	const turn = (id: string, msg: string, status: string) => db.prepare("INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, depth, status, created_at, source_message_id) VALUES(?,?,?,?,?,?,?,?,?)").run(id, room, s.roundId, "a1", "user", 0, status, now(), msg);
	const queued = mk("还在排队的");
	turn("t1", queued.id, "queued");
	s.queue.push({ turnId: "t1", agentId: "a1", reason: "user", depth: 0 } as never);
	assert.equal(recallUserMessage(queued.id).ok, true);
	assert.equal(s.queue.length, 0);
	assert.equal((db.prepare("SELECT status FROM room_turns WHERE id = 't1'").get() as { status: string }).status, "cancelled");
	assert.equal(getMessage(queued.id)?.meta.recalled, true);
	const read = mk("已经被读到的");
	turn("t2", read.id, "running");
	assert.equal(recallUserMessage(read.id).ok, false);
	assert.equal(getMessage(read.id)?.role, "user");
	// 等当前发言结束后重新安排的（replan）
	const re = mk("等重新安排的");
	s.replan = { mentions: [], quote: null, sourceMessageId: re.id, workCtx: null };
	assert.equal(recallUserMessage(re.id).ok, true);
	assert.equal(s.replan, null);
	states.delete(room);
});
