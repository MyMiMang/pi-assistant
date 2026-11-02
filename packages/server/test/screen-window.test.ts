/** 电脑操控的旧截图只留最近几张：纯逻辑 + 真实 Pi 会话里 context 钩子确实生效 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { computerExtension, isComputerTool, PRUNED_NOTE, pruneOldScreens } from "@pi-assistant/ext-computer";
import { config } from "../src/config.ts";
import { createPiSession, disposeSession, PiModels, promptSession } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

type M = { role: string; toolName?: string; content: unknown };
const img = (n: number) => ({ type: "image", data: `img${n}`, mimeType: "image/png" });
const shot = (n: number, toolName = "mcp__hostpc__get_desktop_state"): M => ({ role: "toolResult", toolName, content: [{ type: "text", text: `屏幕${n}` }, img(n)] });
const shots = (n: number) => Array.from({ length: n }, (_, i) => shot(i));
const imageCount = (ms: M[]) => ms.reduce((a, m) => a + (Array.isArray(m.content) ? m.content.filter((b: { type: string }) => b.type === "image").length : 0), 0);
const prune = (ms: M[]) => pruneOldScreens(ms, isComputerTool);

test("12 张截图：清最老的 5 张，剩 7 张；3 张、7 张不清", () => {
	const ms = shots(12);
	const out = prune(ms);
	assert.equal(imageCount(out), 7);
	for (let i = 0; i < 5; i++) assert.equal((out[i].content as { text: string }[])[1].text, PRUNED_NOTE);
	assert.equal((out[5].content as { type: string }[])[1].type, "image");
	for (const n of [3, 7]) {
		const m = shots(n);
		assert.equal(prune(m), m, `${n} 张原样返回同一数组`);
	}
	assert.equal(imageCount(prune(shots(8))), 3);
});

test("文字块保留；用户图片和非电脑工具的图片不动；没有要清的返回原数组", () => {
	const user: M = { role: "user", content: [{ type: "text", text: "看图" }, img(99)] };
	const other = shot(98, "look_at_image");
	const ms = [user, other, ...shots(12)];
	const out = prune(ms);
	assert.equal(out[0], user);
	assert.equal(out[1], other);
	assert.equal((out[2].content as { text: string }[])[0].text, "屏幕0");
	assert.equal(imageCount(out), 2 + 7);
	const same = [user, other];
	assert.equal(prune(same), same);
});

test("不改原对象；没改的消息是同一对象；清两次结果一样", () => {
	const ms = [{ role: "user", content: "hi" } as M, ...shots(12)];
	const before = structuredClone(ms);
	const out = prune(ms);
	assert.deepEqual(ms, before);
	assert.equal(out[0], ms[0]);
	assert.equal(out[12], ms[12]);
	assert.notEqual(out[1], ms[1]);
	assert.deepEqual(prune(out), out);
	// 第 13 张进来：张数 13 -> 清 10 的批次；已清掉的不再计入，所以不会再多清
	assert.equal(imageCount(prune(out)), 7);
});

test("真实 Pi 会话：context 钩子生效，模型收到的旧截图被换成提示（助理电脑 + 用户电脑两份扩展同时挂）", async () => {
	const PROVIDER = "fauxscreen";
	const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: "m", name: "截图测试", input: ["text", "image"] } as never], tokensPerSecond: 10000 });
	const seen: number[][] = [];
	const notes: number[] = [];
	let calls = 0;
	const step = (ctx: { messages: M[] }) => {
		const rs = ctx.messages.filter((m) => m.role === "toolResult");
		seen.push([imageCount(ctx.messages)]);
		notes.push(rs.filter((m) => JSON.stringify(m.content).includes("较早的屏幕截图已省略")).length);
		return ++calls <= 10 ? fauxAssistantMessage([fauxToolCall("mcp__computer__snap", {})]) : fauxAssistantMessage("好了");
	};
	faux.setResponses(Array.from({ length: 12 }, () => step as never));
	const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
	const m = faux.getModel();
	models.registerProvider(PROVIDER, { baseUrl: m.baseUrl, api: m.api, models: [{ id: "m", name: m.name, api: m.api, input: ["text", "image"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl }], colors: null, docs: "" } as never);
	await models.setRuntimeApiKey(PROVIDER, "k");
	const ws = join(config.workspaceRoot, "screen-window");
	mkdirSync(ws, { recursive: true });
	const base = { isPaused: () => false, request: async () => ({ approved: true }), mcp: { command: "true", args: [] } };
	// 吞掉 MCP 注册（不起真实驱动），其余交给 Pi
	const noMcp = (factory: (pi: never) => void) => (pi: Record<string, unknown>) => factory(new Proxy(pi, { get: (t, k: string) => (k === "registerMcpServer" ? () => {} : typeof t[k] === "function" ? (t[k] as (...a: unknown[]) => unknown).bind(t) : t[k]) }) as never);
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, "screen-window"),
		sessionDir: join(config.agentsDir, "screen-window", "sessions"),
		model: { provider: PROVIDER, id: "m" },
		systemPromptAppend: ["测试"],
		extensions: [
			{ name: "computer", factory: noMcp(computerExtension({ ...base, target: "sandbox" })) as never },
			{ name: "hostpc", factory: noMcp(computerExtension({ ...base, target: "host", approvals: () => "none" })) as never },
			{
				name: "probe",
				factory: ((pi: { registerTool: (t: unknown) => void }) =>
					pi.registerTool({
						name: "mcp__computer__snap",
						label: "snap",
						description: "截图",
						parameters: Type.Object({}),
						async execute() {
							return { content: [{ type: "text", text: "屏幕" }, img(1)], details: undefined };
						},
					})) as never,
			},
		],
	});
	try {
		await promptSession(session, "开始");
	} finally {
		await disposeSession(session);
	}
	assert.ok(calls >= 11, `模型应被调用 11 次，实际 ${calls}`);
	assert.equal(seen[seen.length - 1][0], 5, "10 张里清最老 5 张，剩 5 张");
	assert.equal(notes[notes.length - 1], 5, "模型收到 5 个提示文字");
	assert.equal(notes[0], 0);
});
