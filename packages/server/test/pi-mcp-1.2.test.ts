/**
 * Pi 1.2.0 的 MCP 集成验证（真实本地 fake MCP，stdio）。
 *
 * 走的是**公开 Pi 会话 + 内置 MCP 扩展**这条真实链路（createPiSession 的 mcpServers →
 * createMcpExtension → pi-mcp 客户端 → 我们的 fake 服务器），不是绕过 ModelRuntime 直接拿
 * McpClient 连一次。模型是本地 faux provider，工具调用由它按 prompt 发起。
 *
 * 覆盖 1.2.0 上我们之前没验过的点：
 *  1. 握手 + tools/call 的四种结果形状：content 数组、structuredContent=null、原始值 42、对象
 *  2. 取消：慢工具在会话被 abort 时收到 notifications/cancelled
 *  3. resources/list 挂着不回，也不阻工具发现与调用（1.2 不再预列举 resources）
 *
 * 全程临时目录 + 内存凭据 + 本地进程，不碰真实云服务 / 用户数据 / 系统钥匙串。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { config } from "../src/config.ts";
import { abortSession, createPiSession, disposeSession, PiModels, promptSession, subscribeSession, type AgentEvent } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "fake-mcp-1.2.mjs");
const PROVIDER = "faux-mcptest";
const MODEL = "faux-mcp-1";

type Msg = { role: string; content: unknown; toolsAdded?: { name: string }[] };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");

/** 只按 prompt 指定的工具名发起一次调用，拿到工具结果后收尾。 */
const faux = registerFauxProvider({
	api: "faux-mcptest",
	provider: PROVIDER,
	models: [{ id: MODEL, name: "MCP 测试模型", input: ["text"] } as never],
	tokensPerSecond: 1000,
});
const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
const m = faux.getModel();
models.registerProvider(PROVIDER, { baseUrl: m.baseUrl, api: m.api, models: [{ id: MODEL, name: m.name, api: m.api, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl }], colors: null, docs: "" } as never);
await models.setRuntimeApiKey(PROVIDER, "faux-key");
const step = (ctx: { messages: Msg[] }) => {
	faux.appendResponses([step as never]);
	const tools = ctx.messages.filter((x) => x.role === "system").flatMap((x) => x.toolsAdded ?? []);
	const msgs = ctx.messages.filter((x) => x.role !== "system");
	const last = msgs[msgs.length - 1];
	if (last?.role === "toolResult") return fauxAssistantMessage(`工具返回：${textOf(last)}`);
	const want = textOf([...msgs].reverse().find((x) => x.role === "user") ?? { role: "user", content: "" }).match(/【MCP1\.2】(\S+)/)?.[1];
	const hit = tools.find((t) => t.name.endsWith(`__${want}`));
	return hit ? fauxAssistantMessage([fauxText("调用中。"), fauxToolCall(hit.name, {})]) : fauxAssistantMessage(`没有找到工具 ${want}`);
};
faux.setResponses([step as never]);

function fakeMcp(logPath: string) {
	return { name: "fake", config: { type: "stdio" as const, command: process.execPath, args: [FIXTURE, logPath], exposure: "direct" as const, description: "1.2 行为验证" } };
}

async function newSession(name: string, logPath: string) {
	const ws = join(config.workspaceRoot, name);
	mkdirSync(ws, { recursive: true });
	return createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, name),
		sessionDir: join(config.agentsDir, name, "sessions"),
		model: { provider: PROVIDER, id: MODEL },
		systemPromptAppend: ["你是测试助理。"],
		extensions: [],
		mcpServers: [fakeMcp(logPath)],
	});
}

test("MCP 1.2：握手 + content 数组 / structuredContent（null、原始值、对象）都经真实会话往返", async () => {
	const log = join(config.workspaceRoot, "mcp-log-1.txt");
	writeFileSync(log, "");
	const session = await newSession("mcp-shapes", log);
	const results: Record<string, string> = {};
	subscribeSession(session, (e: AgentEvent) => {
		if (e.type === "tool_end") results[e.name.replace(/^mcp__fake__/, "")] = e.resultText;
	});
	const ask = async (tool: string) => {
		await promptSession(session, `【MCP1.2】${tool}`);
		for (let i = 0; i < 200 && session.isStreaming; i++) await new Promise((r) => setTimeout(r, 50));
	};
	await ask("multi_text");
	await ask("null_result");
	await ask("primitive_result");
	await ask("structured_result");
	const calls = readFileSync(log, "utf8");
	assert.match(calls, /req tools\/list/, "工具列表被发现");
	assert.match(calls, /req tools\/call/, "工具真的被调用");
	assert.match(results.multi_text, /第一行[\s\S]*第二行/, "content 数组两条文本都在");
	assert.equal(results.null_result, "null", "空 content + structuredContent=null 回落到 JSON null");
	assert.equal(results.primitive_result, "42", "structuredContent 原始值 42");
	assert.match(results.structured_result, /"ok":\s*true[\s\S]*"items"/, "structuredContent 对象按 JSON 回落");
	await disposeSession(session);
});

test("MCP 1.2：resources/list 挂着不回，也不阻工具发现与调用（不预列举 resources）", async () => {
	const log = join(config.workspaceRoot, "mcp-log-2.txt");
	writeFileSync(log, "");
	const started = Date.now();
	const session = await newSession("mcp-resources", log);
	const elapsed = Date.now() - started;
	const events: string[] = [];
	subscribeSession(session, (e: AgentEvent) => events.push(e.type === "tool_start" ? `start:${e.name}` : e.type));
	await promptSession(session, "【MCP1.2】multi_text");
	for (let i = 0; i < 200 && session.isStreaming; i++) await new Promise((r) => setTimeout(r, 50));
	// 挂着的 resources/list 不能把会话建立或工具调用拖住（真挂住的话 create/handshake 早就超时）
	assert.ok(elapsed < 8000, `会话建立 ${elapsed}ms（startupWaitMs=8000，说明没有被 resources 拖住）`);
	assert.ok(events.some((e) => e.startsWith("start:mcp__fake__multi_text")), "MCP 工具已注册并可调用");
	const calls = readFileSync(log, "utf8");
	assert.match(calls, /req tools\/list/);
	assert.doesNotMatch(calls, /method not found/, "没有把 resources 请求当成错误处理");
	await disposeSession(session);
});

test("MCP 1.2：慢工具在会话 abort 时收到 notifications/cancelled", async () => {
	const log = join(config.workspaceRoot, "mcp-log-3.txt");
	writeFileSync(log, "");
	const session = await newSession("mcp-cancel", log);
	let aborted = false;
	subscribeSession(session, (e: AgentEvent) => {
		if (e.type === "tool_start" && e.name.endsWith("__slow_result") && !aborted) {
			aborted = true;
			// 等 MCP 请求真的发出去再 abort，否则取消的是“还没发”的调用，验证不到 notifications/cancelled
			setTimeout(() => abortSession(session), 250);
		}
	});
	await promptSession(session, "【MCP1.2】slow_result");
	for (let i = 0; i < 200 && session.isStreaming; i++) await new Promise((r) => setTimeout(r, 50));
	assert.ok(aborted, "慢工具确实启动了（否则这个测试没验证到取消）");
	const calls = readFileSync(log, "utf8");
	assert.match(calls, /req tools\/call/, "取消前请求已经发出");
	assert.match(calls, /cancelled/, "abort 后 MCP 客户端发出了 notifications/cancelled");
	await disposeSession(session);
});
