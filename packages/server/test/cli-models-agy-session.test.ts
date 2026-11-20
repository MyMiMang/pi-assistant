/**
 * antigravity 渠道的端到端：真实的 Pi 会话（createPiSession）选 `antigravity` 模型，挂一个简单工具，
 * 底下是假 agy（绝不调用真实 agy）。证明 Pi 真的执行了工具、把结果交回同一个 agy 进程，
 * 第二轮用户消息复用同一个长驻进程，用量照填、cost 为 0；模型目录里家族 + 思考档位正确。
 */
import { isTempDataDir } from "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bindSession } from "../src/agent-runtime/bind-session.ts";
import { config } from "../src/config.ts";
import { db } from "../src/db.ts";
import { usageSummary } from "../src/usage/index.ts";
import { listAgyModels } from "../src/cli-agents/detect.ts";
import { ANTIGRAVITY_PROVIDER, registerAntigravityProvider } from "../src/pi-adapter/cli-models/antigravity.ts";
import { createPiSession, defineTool, disposeSession, lastAssistantText, PiModels, promptSession, Type } from "../src/pi-adapter/index.ts";
import type { Env } from "../src/routes/common.ts";
import { mountToolBridgeRoutes } from "../src/routes/tool-bridge.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-agy.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "pia-agy-session-"));
const scenarioFile = join(dataDir, "scenario");
const setScenario = (s: string) => writeFileSync(scenarioFile, s);
let server: ReturnType<typeof serve>;
let channel: Awaited<ReturnType<typeof registerAntigravityProvider>>;
let models: PiModels;
before(async () => {
	assert.ok(isTempDataDir(dirname(config.dbPath)), "SQLite 必须用临时数据目录");
	setScenario("one-tool");
	const app = new Hono<Env>();
	mountToolBridgeRoutes(app);
	server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((r) => server.once("listening", () => r()));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
	channel = await registerAntigravityProvider(models, { dataDir, bridgeBaseUrl: () => baseUrl, command: () => FAKE, extraEnv: () => ({ FAKE_AGY_SCENARIO_FILE: scenarioFile }), families: await listAgyModels(FAKE), collectMs: 100 });
});
after(() => {
	channel.disposeAll();
	(server as unknown as import("node:http").Server).closeAllConnections();
	server.close();
	rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("渠道注册后：每个家族一项，思考档位按 agy 的档位，没有选择的家族不给思考强度，声明能看图（经 look_at_image 工具看）", () => {
	const list = models.listModels(ANTIGRAVITY_PROVIDER);
	assert.deepEqual(list.map((m) => m.id), ["claude-sonnet-5-5", "gemini-4-argon", "gpt-oss-120b"]);
	assert.deepEqual(list.map((m) => m.name), ["Antigravity · Claude Sonnet 5.5", "Antigravity · Gemini 4 Argon", "Antigravity · GPT-OSS 120B"]);
	assert.ok(list.every((m) => m.input.includes("image")), "图片换成提示后经 look_at_image 工具看");
	assert.deepEqual(list[0].thinking, ["low", "medium", "high"]);
	assert.deepEqual(list[1].thinking, ["low", "high"], "假 agy 的 gemini 只有 low / high");
	assert.deepEqual(list[2].thinking, ["medium"], "单档仅公布目录确认的 medium，不冒充 off");
});

async function createAgyTestSession(id: string, ran: string[]) {
	const ws = join(config.workspaceRoot, id);
	mkdirSync(ws, { recursive: true });
	const echo = defineTool({
		name: "echo",
		label: "回显",
		description: "把文字原样返回",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_id, params) => {
			ran.push(params.text);
			return { content: [{ type: "text", text: `ECHO:${params.text}` }], details: {} };
		},
	});
	return createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, id),
		sessionDir: join(config.agentsDir, id, "sessions"),
		model: { provider: ANTIGRAVITY_PROVIDER, id: "claude-sonnet-5-5" },
		thinking: "high",
		systemPromptAppend: ["你是测试助理。"],
		extensions: [],
		tools: ["echo"],
		customTools: [echo] as never,
		minimalExtensions: true,
		inMemorySession: true,
	});
}

test("Pi 会话端到端：Pi 执行工具并把结果交回同一个 agy 进程；下一轮复用进程", { timeout: 60000 }, async () => {
	const ran: string[] = [];
	const session = await createAgyTestSession("agy-e2e", ran);
	try {
		await promptSession(session, "帮我回显");
		for (let i = 0; i < 400 && session.isStreaming; i++) await sleep(25);
		assert.deepEqual(ran, ["hi"], "Pi 真的执行了工具");
		assert.equal(lastAssistantText(session), "got:ECHO:hi", "结果交回了同一个 agy，它接着答完");
		const msgs = (session.messages as Array<{ role: string; stopReason?: string; usage?: { cost: { total: number }; totalTokens: number } }>).filter((m) => m.role !== "system");
		assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(msgs[1].stopReason, "toolUse");
		assert.equal(msgs[3].stopReason, "stop");
		assert.ok(msgs.filter((m) => m.role === "assistant").every((m) => m.usage!.cost.total === 0 && m.usage!.totalTokens > 0));
		assert.equal(channel.liveCount(), 0);

		// 第二轮：对照表对得上、进程还在 → 同一个进程，只发新增的用户内容，思考强度拼进模型 id
		setScenario("meta");
		await promptSession(session, "第二句");
		for (let i = 0; i < 400 && session.isStreaming; i++) await sleep(25);
		const info = JSON.parse(lastAssistantText(session)) as { first: string; model: string; seq: number; tools: string[] };
		assert.equal(info.first, "第二句");
		assert.equal(info.model, "claude-sonnet-5-5-high");
		assert.equal(info.seq, 2, "同一个长驻进程里的第二轮");
		assert.deepEqual(info.tools, ["echo"]);
	} finally {
		await disposeSession(session);
	}
});

async function checkUsage(id: string, scenarios: string[], expected: number[], restartAfter?: number, expectedText?: string[]) {
	const ran: string[] = [];
	const session = await createAgyTestSession(id, ran);
	const unbind = bindSession(session, id, id, null, () => {});
	try {
		for (const [i, scenario] of scenarios.entries()) {
			if (i === restartAfter) channel.disposeAll(); // 关真实假进程，保留会话对照表走 --conversation 恢复
			setScenario(scenario);
			await promptSession(session, `合成用量测试 ${scenario}`);
		}
		const rows = db.prepare(`SELECT m.content, m.status, json_extract(m.meta, '$.usage.input') AS messageInput,
			json_extract(m.meta, '$.usage.output') AS messageOutput, json_extract(m.meta, '$.usage.cacheRead') AS messageCacheRead,
			u.input, u.output, u.cache_read, u.cost FROM usage_calls u JOIN messages m ON m.id = u.message_id
			WHERE u.agent_id = ? ORDER BY u.rowid`).all(id);
		const assistants = db.prepare("SELECT content, status FROM messages WHERE agent_id = ? AND role = 'assistant' ORDER BY rowid").all(id);
		const { totals } = usageSummary({ range: "all", agentId: id });
		const evidence = JSON.stringify({ ran, assistants, rows, totals });
		assert.deepEqual(ran, scenarios.flatMap((s, i) => ["usage-result-only", "usage-result-repeat", "usage-partial-step"].includes(s) ? [] : [`turn-${i + 1}`]), evidence);
		assert.equal(assistants.filter((m) => m.status === "error").length, scenarios.filter((s) => s === "usage-error").length, evidence);
		if (restartAfter !== undefined) assert.deepEqual(assistants.map((m) => m.content), ["result-only:fresh:1", "result-only:resumed:1", "result-only:resumed:2"], evidence);
		assert.deepEqual(rows.map((r) => [r.messageInput, r.messageOutput, r.messageCacheRead]), rows.map((r) => [r.input, r.output, r.cache_read]), evidence);
		assert.deepEqual(rows.map((r) => [r.input, r.output, r.cache_read]), expected.map((n) => [n, n / 5, n * 0.3]), evidence);
		const total = expected.reduce((sum, n) => sum + n, 0);
		assert.ok(rows.every((r) => r.cost === null), evidence);
		assert.deepEqual([totals.calls, totals.input, totals.output, totals.cacheRead, totals.unknownCalls], [expected.length, total, total / 5, total * 0.3, expected.length], evidence);
		if (expectedText) assert.deepEqual(assistants.map(m => m.content), expectedText, evidence);
		console.log(`AGY_USAGE ${id}: ${evidence}`);
	} finally {
		unbind();
		await disposeSession(session);
	}
}

test("相同用量的独立步骤分别计入 SQLite，累计成功回执不重复计算", { timeout: 20000 }, () => checkUsage("agy-usage-steps", ["usage-steps", "usage-steps"], [100, 100, 100, 100]));
test("跨轮工具后缺步用量，只用累计差额补足，不重复计入历史", { timeout: 20000 }, () => checkUsage("agy-usage-missing", ["usage-steps", "usage-missing"], [100, 100, 100, 100]));
test("工具后只收到成功累计回执，不能重加历史与已落账的前一步", { timeout: 20000 }, () => checkUsage("agy-usage-no-done", ["usage-steps", "usage-no-done"], [100, 100, 100, 100]));
test("工具后错误回执不重复计入本轮已记和历史用量", { timeout: 20000 }, () => checkUsage("agy-usage-error", ["usage-steps", "usage-error"], [100, 100, 100, 0]));
test("仅累计回执：新会话首轮可入账，后续只记可验证差额", { timeout: 20000 }, () => checkUsage("agy-usage-result-only", ["usage-result-only", "usage-result-repeat"], [100, 100]));
test("恢复进程没有累计基线，首条只建立基线，下一条可计差额", { timeout: 20000 }, () => checkUsage("agy-usage-resumed", ["usage-result-only", "usage-result-only", "usage-result-only"], [100, 0, 100], 1));
test("尾段已有 input，累计回执只补 output 和 cacheRead", { timeout: 20000 }, () => checkUsage("agy-partial", ["usage-partial-step"], [100], undefined, ["first:1"]));
test("同轮 DONE 重放不重复记账或文字；不同索引及后续轮复用索引照常记账", { timeout: 20000 }, () => checkUsage("agy-replay", ["usage-replay-step", "usage-replay-step"], [100, 100, 100, 100], undefined, ["first:1", "last:1", "first:2", "last:2"]));
test("缺步骤身份不按等值去重", { timeout: 20000 }, () => checkUsage("agy-unidentified", ["usage-no-step-id"], [100, 100], undefined, ["first:1", "last:1"]));
