/**
 * codex 渠道的端到端：真实的 Pi 会话（createPiSession）选 `codex` 模型，挂一个简单工具，
 * 底下是假 codex app-server（绝不调用真实 codex）。证明 Pi 真的执行了工具、把结果交回同一个 Codex 线程，
 * 第二轮用户消息续用同一线程，用量照填、cost 为 0；模型目录里有 model/list 的模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { config } from "../src/config.ts";
import { CODEX_PROVIDER, registerCodexProvider } from "../src/pi-adapter/cli-models/codex.ts";
import { createPiSession, defineTool, disposeSession, lastAssistantText, PiModels, promptSession, Type } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "pia-cx-session-"));
const scenarioFile = join(dataDir, "scenario");
const setScenario = (s: string) => writeFileSync(scenarioFile, s);
let channel: Awaited<ReturnType<typeof registerCodexProvider>>;
let models: PiModels;
before(async () => {
	setScenario("one-tool");
	models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
	channel = await registerCodexProvider(models, { dataDir, command: () => FAKE, extraEnv: () => ({ FAKE_CODEX_SCENARIO_FILE: scenarioFile }) });
});
after(() => {
	channel.disposeAll();
	rmSync(dataDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("渠道注册后：模型来自 model/list，能看图与否、思考档位按模型", () => {
	const list = models.listModels(CODEX_PROVIDER);
	assert.deepEqual(list.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-luna"]);
	assert.deepEqual(list.map((m) => m.name), ["Codex · GPT-6.1-Sol", "Codex · GPT-6-Luna"]);
	assert.deepEqual(list.map((m) => m.input.includes("image")), [true, false]);
	assert.deepEqual(list[0].thinking, ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(list[1].thinking, ["off", "low", "medium", "high"]);
});

test("Pi 会话端到端：Pi 执行工具并把结果交回同一个 Codex 线程；下一轮续用", { timeout: 60000 }, async () => {
	const ws = join(config.workspaceRoot, "cx-e2e");
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
		agentDir: join(config.agentsDir, "cx-e2e"),
		sessionDir: join(config.agentsDir, "cx-e2e", "sessions"),
		model: { provider: CODEX_PROVIDER, id: "gpt-6.1-sol" },
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
		assert.equal(lastAssistantText(session), "got:ECHO:hi", "结果交回了同一个线程，它接着答完");
		const msgs = (session.messages as Array<{ role: string; stopReason?: string; usage?: { cost: { total: number }; totalTokens: number } }>).filter((m) => m.role !== "system");
		assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
		assert.equal(msgs[1].stopReason, "toolUse");
		assert.equal(msgs[3].stopReason, "stop");
		assert.ok(msgs.filter((m) => m.role === "assistant").every((m) => m.usage!.cost.total === 0));
		assert.ok(msgs[3].usage!.totalTokens > 0);
		assert.equal(channel.liveCount(), 0);

		// 第二轮：对照表对得上 → 同一个线程，只发新增的用户内容，思考强度传下去
		setScenario("meta");
		await promptSession(session, "第二句");
		for (let i = 0; i < 400 && session.isStreaming; i++) await sleep(25);
		const info = JSON.parse(lastAssistantText(session)) as { thread: string; input: string; effort: string; model: string; tools: string[] };
		assert.ok(info.thread, "续用的线程");
		assert.equal(info.input, "第二句");
		assert.equal(info.effort, "high");
		assert.equal(info.model, "gpt-6.1-sol");
		assert.deepEqual(info.tools, ["echo"]);
	} finally {
		await disposeSession(session);
	}
});
