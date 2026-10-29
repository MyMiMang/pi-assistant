/**
 * opencode 渠道的端到端：真实的 Pi 会话（createPiSession）选 `opencode` 模型，挂一个简单工具，
 * 底下是假 opencode（绝不调用真实 opencode）。证明 Pi 真的执行了工具、把结果交回同一个 opencode 进程，
 * 第二轮用户消息复用同一个长驻进程，用量照填、cost 为 0；模型目录里名字带来源、思考档位按 variants。
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
import { listOpencodeModels } from "../src/cli-agents/detect.ts";
import { OPENCODE_PROVIDER, registerOpencodeProvider } from "../src/pi-adapter/cli-models/opencode.ts";
import { createPiSession, defineTool, disposeSession, lastAssistantText, PiModels, promptSession, Type } from "../src/pi-adapter/index.ts";
import type { Env } from "../src/routes/common.ts";
import { mountToolBridgeRoutes } from "../src/routes/tool-bridge.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-opencode.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "pia-oc-session-"));
const scenarioFile = join(dataDir, "scenario");
const setScenario = (s: string) => writeFileSync(scenarioFile, s);
let server: ReturnType<typeof serve>;
let channel: Awaited<ReturnType<typeof registerOpencodeProvider>>;
let models: PiModels;
before(async () => {
	setScenario("one-tool");
	const app = new Hono<Env>();
	mountToolBridgeRoutes(app);
	server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((r) => server.once("listening", () => r()));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
	channel = await registerOpencodeProvider(models, { dataDir, bridgeBaseUrl: () => baseUrl, command: () => FAKE, extraEnv: () => ({ FAKE_OPENCODE_SCENARIO_FILE: scenarioFile }), models: await listOpencodeModels(FAKE, { dataDir }), collectMs: 100 });
});
after(() => {
	channel.disposeAll();
	(server as unknown as import("node:http").Server).closeAllConnections();
	server.close();
	rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("渠道注册后：不支持工具调用的模型没有；名字带来源；思考档位按 variants；图片按能力声明", () => {
	const list = models.listModels(OPENCODE_PROVIDER);
	assert.deepEqual(list.map((m) => m.id), ["opencode/beam-free", "opencode/claude-fable-5", "opencode-go/deepseek-v4.1-flash", "opencode-go/mimo-v2.5-pro"]);
	assert.deepEqual(list.map((m) => m.name), ["Beam Free（OpenCode Zen 免费）", "Claude Fable 5（OpenCode Zen 按量）", "DeepSeek V4.1 Flash（OpenCode Go）", "MiMo V2.5 Pro（OpenCode Go）"]);
	assert.deepEqual(list.map((m) => m.input.includes("image")), [false, true, true, false]);
	assert.deepEqual(list[0].thinking, ["off", "low", "medium", "high"]);
	assert.deepEqual(list[2].thinking, ["off", "low", "high", "max"], "variants 只有 low / high / max");
	assert.deepEqual(list[3].thinking, ["off"], "没有 variants：不给思考强度");
});

test("Pi 会话端到端：Pi 执行工具并把结果交回同一个 opencode 进程；下一轮复用进程", { timeout: 60000 }, async () => {
	const ws = join(config.workspaceRoot, "oc-e2e");
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
		agentDir: join(config.agentsDir, "oc-e2e"),
		sessionDir: join(config.agentsDir, "oc-e2e", "sessions"),
		model: { provider: OPENCODE_PROVIDER, id: "opencode-go/deepseek-v4.1-flash" },
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
		assert.equal(lastAssistantText(session), "got:ECHO:hi", "结果交回了同一个 opencode，它接着答完");
		const msgs = (session.messages as Array<{ role: string; stopReason?: string; usage?: { cost: { total: number }; totalTokens: number } }>).filter((m) => m.role !== "system");
		assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(msgs[1].stopReason, "toolUse");
		assert.equal(msgs[3].stopReason, "stop");
		assert.ok(msgs.filter((m) => m.role === "assistant").every((m) => m.usage!.cost.total === 0));
		assert.ok(msgs[3].usage!.totalTokens > 0, "最后一段有用量");
		assert.equal(channel.liveCount(), 0);

		setScenario("meta");
		await promptSession(session, "第二句");
		for (let i = 0; i < 400 && session.isStreaming; i++) await sleep(25);
		const info = JSON.parse(lastAssistantText(session)) as { first: string; model: string; effort: string; seq: number; tools: string[] };
		assert.equal(info.first, "第二句");
		assert.equal(info.model, "opencode-go/deepseek-v4.1-flash");
		assert.equal(info.effort, "high");
		assert.equal(info.seq, 2, "同一个长驻进程里的第二轮");
		assert.deepEqual(info.tools, ["echo"]);
	} finally {
		await disposeSession(session);
	}
});
