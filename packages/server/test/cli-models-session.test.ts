/**
 * claude-code 渠道的端到端：真实的 Pi 会话（createPiSession）选 `claude-code` 模型，挂一个简单工具，
 * 底下是假 claude（绝不调用真实 claude）。证明 Pi 真的执行了工具、把结果交回同一个 claude，
 * 第二轮用户消息用 `--resume`，用量照填、cost 为 0。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "../src/config.ts";
import { registerClaudeCodeProvider, CLAUDE_CODE_PROVIDER } from "../src/pi-adapter/cli-models/claude-code.ts";
import { createPiSession, defineTool, disposeSession, lastAssistantText, PiModels, promptSession, Type } from "../src/pi-adapter/index.ts";
import type { Env } from "../src/routes/common.ts";
import { mountToolBridgeRoutes } from "../src/routes/tool-bridge.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "pia-cc-session-"));
let server: ReturnType<typeof serve>;
let scenario = "one-tool";
let channel: Awaited<ReturnType<typeof registerClaudeCodeProvider>>;
let models: PiModels;
before(async () => {
	const app = new Hono<Env>();
	mountToolBridgeRoutes(app);
	server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((r) => server.once("listening", () => r()));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
	channel = await registerClaudeCodeProvider(models, { dataDir, bridgeBaseUrl: () => baseUrl, command: () => FAKE, extraEnv: () => ({ FAKE_CLAUDE_SCENARIO: scenario }) });
});
after(() => {
	channel.disposeAll();
	(server as unknown as import("node:http").Server).closeAllConnections();
	server.close();
	rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("渠道注册后：三个模型出现在 Pi 的模型目录，能看图，思考强度档位正确", () => {
	const list = models.listModels(CLAUDE_CODE_PROVIDER);
	assert.deepEqual(list.map((m) => m.id), ["opus", "sonnet", "haiku"]);
	assert.deepEqual(list.map((m) => m.name), ["Claude Code · Opus", "Claude Code · Sonnet", "Claude Code · Haiku"]);
	assert.ok(list.every((m) => m.input.includes("image")));
	const opus = list.find((m) => m.id === "opus")!;
	assert.deepEqual(opus.thinking, ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(list.find((m) => m.id === "haiku")!.thinking, ["off"]);
});

test("Pi 会话端到端：Pi 执行工具并把结果交回同一个 claude；下一轮用 --resume", { timeout: 60000 }, async () => {
	const ws = join(config.workspaceRoot, "cc-e2e");
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
		agentDir: join(config.agentsDir, "cc-e2e"),
		sessionDir: join(config.agentsDir, "cc-e2e", "sessions"),
		model: { provider: CLAUDE_CODE_PROVIDER, id: "sonnet" },
		thinking: "high",
		systemPromptAppend: ["你是测试助理。"],
		extensions: [],
		tools: ["echo"],
		customTools: [echo] as never,
		minimalExtensions: true,
		inMemorySession: true,
	});
	try {
		scenario = "one-tool";
		await promptSession(session, "帮我回显");
		for (let i = 0; i < 400 && session.isStreaming; i++) await sleep(25);
		assert.deepEqual(ran, ["hi"], "Pi 真的执行了工具");
		assert.equal(lastAssistantText(session), "got:ECHO:hi", "结果交回了同一个 claude，它接着答完");
		const msgs = (session.messages as Array<{ role: string; stopReason?: string; usage?: { cost: { total: number }; totalTokens: number } }>).filter((m) => m.role !== "system");
		const roles = msgs.map((m) => m.role);
		assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(msgs[1].stopReason, "toolUse");
		assert.equal(msgs[3].stopReason, "stop");
		assert.ok(msgs.filter((m) => m.role === "assistant").every((m) => m.usage!.cost.total === 0 && m.usage!.totalTokens > 0));
		assert.equal(channel.liveCount(), 0);

		// 第二轮：对照表对得上 → 只发新增的用户内容，并且带 --resume
		scenario = "meta";
		await promptSession(session, "第二句");
		for (let i = 0; i < 400 && session.isStreaming; i++) await sleep(25);
		const info = JSON.parse(lastAssistantText(session)) as { resume: string | null; first: string; effort: string; model: string };
		assert.ok(info.resume, "第二轮续用了 claude 会话");
		assert.equal(info.first, "第二句");
		assert.equal(info.effort, "high");
		assert.equal(info.model, "sonnet");
	} finally {
		await disposeSession(session);
	}
});
