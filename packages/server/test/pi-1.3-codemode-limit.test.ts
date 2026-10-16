/**
 * Pi 1.3.0 codemode worker 上限回归（真实 Pi 会话 + 本地 fake MCP）。
 *
 * 1.3.0 起 codemode 的 worker 在一个进程里**跨会话共享**，上限 2，且「取消但未真正退出」的 worker 仍占额度
 * （upstream #10748）。我们一个 Node 进程里会同时跑主会话 / 后台任务 / 子代理，第 3 个在跑脚本的会话应拿到
 * 可读的错误（而不是挂起 / 排队），并且不得被无限自动重试。
 *
 * 本用例只用公开链路：createPiSession + codemode 扩展 + stdio fake MCP（slow_read 每个 1.5s 占住 worker）。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { approvalExtension } from "@pi-assistant/ext-approval";
import { config } from "../src/config.ts";
import { createPiSession, disposeSession, PiModels, promptSession, type AgentSession } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "mock-mcp-discovery.mjs");
const PROVIDER = "fauxworker";
const MODEL = "faux-worker";
type Msg = { role: string; content: unknown; toolName?: string };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");

const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: MODEL, name: "worker 测试", input: ["text"] } as never], tokensPerSecond: 10000 });
/** 每个会话脚本化：第一次给 codemode 的调用，拿到 toolResult 后收尾。预置多份，避免并发请求抢同一个队列。 */
const makeStep = () => (ctx: { messages: Msg[] }) => {
	const done = ctx.messages.some((m) => m.role === "toolResult" && m.toolName === "codemode");
	return done ? fauxAssistantMessage("完成") : fauxAssistantMessage([fauxToolCall("codemode", { code: "await tools.mcp__demo__slow_read({}); await tools.mcp__demo__slow_read({}); return 'ok';" } as never)]);
};
faux.setResponses(Array.from({ length: 24 }, makeStep));
const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
const mm = faux.getModel();
models.registerProvider(PROVIDER, { baseUrl: mm.baseUrl, api: mm.api, models: [{ id: MODEL, name: mm.name, api: mm.api, input: ["text"], cost: mm.cost, contextWindow: mm.contextWindow, maxTokens: mm.maxTokens, baseUrl: mm.baseUrl }], colors: null, docs: "" } as never);
await models.setRuntimeApiKey(PROVIDER, "k");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(session: AgentSession, ms = 20000) {
	const end = Date.now() + ms;
	while (session.isStreaming && Date.now() < end) await sleep(50);
}
let seq = 0;
async function mk() {
	const name = `worker-${++seq}`;
	const ws = join(config.workspaceRoot, name);
	mkdirSync(ws, { recursive: true });
	return createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, name),
		sessionDir: join(config.agentsDir, name, "sessions"),
		model: { provider: PROVIDER, id: MODEL },
		systemPromptAppend: ["worker 测试"],
		extensions: [{ name: "approval", factory: approvalExtension({ workspace: ws, guard: { target: "host" }, hostAccess: () => true, request: async () => ({ approved: true }) }) }],
		mcpServers: [{ name: "demo", config: { type: "stdio", command: process.execPath, args: [FIXTURE], exposure: "codemode", description: "worker 测试" } }],
	});
}
const codemodeText = (s: AgentSession) => (s.messages as Msg[]).filter((m) => m.toolName === "codemode").map(textOf).join("\n");

test("1.3 codemode：3 并发跨会话，第 3 个拿到可读上限错误且不挂起 / 不无限重试", { timeout: 60000 }, async () => {
	const a = await mk();
	const b = await mk();
	const c = await mk();
	try {
		const ready = async (s: AgentSession) => {
			for (let i = 0; i < 150 && !s.getActiveToolNames().includes("codemode"); i++) await sleep(100);
			return s.getActiveToolNames().includes("codemode");
		};
		for (const [name, s] of [
			["A", a],
			["B", b],
			["C", c],
		] as const) assert.ok(await ready(s), `${name} 的 codemode 应被激活：${s.getActiveToolNames().join(",")}`);

		// 前两个会话先占住 2 个 worker（每个脚本 ≈3s）
		const pa = promptSession(a, "跑脚本 A");
		await sleep(900);
		const pb = promptSession(b, "跑脚本 B");
		await sleep(900);
		// 第三个在两者仍在跑时进入：应立刻拿到上限错误
		const pc = promptSession(c, "跑脚本 C");
		await Promise.all([pa.catch(() => {}), pb.catch(() => {}), pc.catch(() => {})]);
		await Promise.all([settle(a), settle(b), settle(c)]);

		const textA = codemodeText(a);
		const textB = codemodeText(b);
		const textC = codemodeText(c);
		console.log(`[worker] A=${textA.slice(0, 120).replace(/\n/g, " ")}\n[worker] B=${textB.slice(0, 120).replace(/\n/g, " ")}\n[worker] C=${textC.slice(0, 200).replace(/\n/g, " ")}`);
		const limitHit = [textA, textB, textC].filter((t) => /worker limit reached|workers are still running or shutting down/i.test(t));
		assert.equal(limitHit.length, 1, `应恰好有一个会话拿到 worker 上限错误：${limitHit.length}`);
		assert.match(limitHit[0], /Retry after they exit/i, "错误信息应给出可重试提示");
		assert.equal(c.isStreaming, false, "拿到上限错误后会话不应挂起");
		const oks = [textA, textB, textC].filter((t) => /Script completed/i.test(t));
		assert.ok(oks.length >= 2, `至少两个脚本应正常完成：${oks.length}`);
	} finally {
		await Promise.all([disposeSession(a), disposeSession(b), disposeSession(c)]);
	}
});
