/**
 * antigravity 渠道的端到端：真实的 Pi 会话（createPiSession）选 `antigravity` 模型，挂一个简单工具，
 * 底下是假 agy（绝不调用真实 agy）。证明 Pi 真的执行了工具、把结果交回同一个 agy 进程，
 * 第二轮用户消息复用同一个长驻进程，用量照填、cost 为 0；模型目录里家族 + 思考档位正确。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "../src/config.ts";
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

test("渠道注册后：每个家族一项，思考档位按 agy 的档位，没有选择的家族不给思考强度，不声明能看图", () => {
	const list = models.listModels(ANTIGRAVITY_PROVIDER);
	assert.deepEqual(list.map((m) => m.id), ["claude-sonnet-5-5", "gemini-4-argon", "gpt-oss-120b"]);
	assert.deepEqual(list.map((m) => m.name), ["Antigravity · Claude Sonnet 5.5", "Antigravity · Gemini 4 Argon", "Antigravity · GPT-OSS 120B"]);
	assert.ok(list.every((m) => !m.input.includes("image")));
	assert.deepEqual(list[0].thinking, ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(list[1].thinking, ["off", "low", "high", "xhigh", "max"], "假 agy 的 gemini 只有 low / high");
	assert.deepEqual(list[2].thinking, ["off"], "只有一个档位：没有思考强度");
});

test("Pi 会话端到端：Pi 执行工具并把结果交回同一个 agy 进程；下一轮复用进程", { timeout: 60000 }, async () => {
	const ws = join(config.workspaceRoot, "agy-e2e");
	mkdirSync(ws, { recursive: true });
	const ran: string[] = [];
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
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, "agy-e2e"),
		sessionDir: join(config.agentsDir, "agy-e2e", "sessions"),
		model: { provider: ANTIGRAVITY_PROVIDER, id: "claude-sonnet-5-5" },
		thinking: "high",
		systemPromptAppend: ["你是测试助理。"],
		extensions: [],
		tools: ["echo"],
		customTools: [echo] as never,
		minimalExtensions: true,
		inMemorySession: true,
	});
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
