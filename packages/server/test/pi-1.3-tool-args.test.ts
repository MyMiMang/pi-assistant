/**
 * Pi 1.3.0 工具参数解析回归（upstream #10897 / #10868）。
 *
 * 1.3.0 起，工具调用最终参数字符串不是合法 JSON 对象时，不再「只跑已解析的前缀字段」，而是带着
 * `argumentsError` 校验失败，并把模型发出的原始参数回给模型。本用例用 faux provider 直接构造一个
 * 带 `argumentsError` 的工具调用（不经过真实 provider 的流式解析），验证**执行侧的安全属性**：
 * 工具不会拿残缺参数执行、模型能看到错误与原始参数文本。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { config } from "../src/config.ts";
import { createPiSession, disposeSession, PiModels, promptSession } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const PROVIDER = "fauxargs";
const MODEL = "faux-args";
type Msg = { role: string; content: unknown; toolName?: string };
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");

const RAW = '{"path":"args-broken.txt","content":"hello"'; // 故意少一个 }
const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: MODEL, name: "参数解析测试", input: ["text"] } as never], tokensPerSecond: 10000 });
const badCall = { type: "toolCall", id: "call-broken-1", name: "write", arguments: {}, argumentsError: `Invalid JSON. Raw arguments: ${RAW}` } as never;
const step = (ctx: { messages: Msg[] }) => {
	const done = ctx.messages.some((m) => m.role === "toolResult");
	return fauxAssistantMessage(done ? "收到" : [badCall]);
};
const respond = (ctx: { messages: Msg[] }) => {
	faux.appendResponses([respond as never]);
	return step(ctx);
};
faux.setResponses([respond as never]);
const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
const mm = faux.getModel();
models.registerProvider(PROVIDER, { baseUrl: mm.baseUrl, api: mm.api, models: [{ id: MODEL, name: mm.name, api: mm.api, input: ["text"], cost: mm.cost, contextWindow: mm.contextWindow, maxTokens: mm.maxTokens, baseUrl: mm.baseUrl }], colors: null, docs: "" } as never);
await models.setRuntimeApiKey(PROVIDER, "k");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("1.3 参数坏 JSON：校验失败、不执行部分字段、模型看到原始参数", { timeout: 30000 }, async () => {
	const ws = join(config.workspaceRoot, "args-broken");
	mkdirSync(ws, { recursive: true });
	const target = join(ws, "args-broken.txt");
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, "args-broken"),
		sessionDir: join(config.agentsDir, "args-broken", "sessions"),
		model: { provider: PROVIDER, id: MODEL },
		systemPromptAppend: ["参数解析测试"],
		extensions: [],
	});
	try {
		await promptSession(session, "写个文件");
		for (let i = 0; i < 300 && session.isStreaming; i++) await sleep(50);
		const results = (session.messages as Msg[]).filter((m) => m.role === "toolResult").map(textOf).join("\n");
		console.log(`[args] toolResult=${results.slice(0, 300).replace(/\n/g, " ")}`);
		assert.ok(!existsSync(target), "坏 JSON 不应创建文件（不拿残缺字段执行）");
		assert.match(results, /args-broken\.txt|Invalid JSON|arguments|原始/, `模型应看到错误与原始参数：${results.slice(0, 200)}`);
	} finally {
		await disposeSession(session);
	}
});
