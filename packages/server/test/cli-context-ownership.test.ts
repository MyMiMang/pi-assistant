import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { config } from "../src/config.ts";
import { abortSession, applyModelSettings, compactSession, contextUsage, createPiSession, disposeSession, injectContext, lastAssistantText, PiModels, promptSession, sessionStats, subscribeSession, triggerHidden, type AgentEvent, type ExtensionFactory } from "../src/pi-adapter/index.ts";
import { cliOwnsContext, setContextRecoveryFallback } from "../src/pi-adapter/context-ownership.ts";
import { compactionFallbackExtension } from "../src/pi-adapter/compaction-fallback.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

let serial = 0;
const textOf = (m: { content: unknown }) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "";
async function fixture(t: TestContext, opts: { provider?: string; dynamic?: boolean; compact?: ExtensionFactory; defaultSummary?: boolean } = {}) {
	const provider = opts.provider ?? "antigravity";
	const api = opts.dynamic ? `${provider}-acp-native` : `ownership-fixture-${++serial}`;
	const fm = { provider, api, id: "mock", name: "Mock CLI", baseUrl: "mock://local", reasoning: false, contextWindow: 32_000, maxTokens: 1_000, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	type Response = AssistantMessage | ((ctx: Context) => AssistantMessage);
	let responses: Response[] = [];
	const faux = { getModel: () => fm, setResponses: (r: Response[]) => { responses = [...r]; } };
	const requestedProviders: string[] = [];
	const streamSimple = (model: Model<string>, ctx: Context) => {
		requestedProviders.push(model.provider);
		const stream = createAssistantMessageEventStream();
		const response = responses.shift();
		assert.ok(response, "Mock 请求次数超过预期");
		const m = { ...(typeof response === "function" ? response(ctx) : response), provider: model.provider, model: model.id, api: model.api, timestamp: Date.now() };
		stream.push({ type: "start", partial: m });
		if (m.stopReason === "error") stream.push({ type: "error", reason: "error", error: m });
		else stream.push({ type: "done", reason: "stop", message: m });
		return stream;
	};
	// compact() 的公开低层函数不经 session ModelRuntime，需同样注册临时协议。
	registerApiProvider({ api, stream: streamSimple, streamSimple } as never, api);
	t.after(() => unregisterApiProviders(api));
	const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
	models.registerProvider(provider, { api, baseUrl: fm.baseUrl, streamSimple, models: [{ ...fm, id: "mock" }] });
	await models.setRuntimeApiKey(provider, "local-fixture");
	const cwd = join(config.workspaceRoot, `ownership-${++serial}`);
	mkdirSync(cwd, { recursive: true });
	let compactCalls = 0;
	const compact: ExtensionFactory = opts.compact ?? ((pi) => {
		pi.on("session_before_compact", (event) => {
			compactCalls++;
			return { compaction: { summary: "已完成历史步骤；继续当前请求。", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
		});
	});
	const s = await createPiSession({ models, cwd, agentDir: join(cwd, "agent"), sessionDir: join(cwd, "sessions"), model: { provider, id: "mock" }, systemPromptAppend: [], extensions: opts.defaultSummary ? [{ name: "fallback", factory: compactionFallbackExtension }] : [{ name: "fixture-compact", factory: compact }], minimalExtensions: true, inMemorySession: true, tools: [] });
	const events: AgentEvent[] = [];
	const off = subscribeSession(s, (e) => events.push(e));
	t.after(async () => { off(); await disposeSession(s); });
	const reply = (text = "完成", tokens = 500): AssistantMessage => ({ role: "assistant", content: text ? [{ type: "text", text }] : [], provider, model: "mock", api, timestamp: Date.now(), stopReason: "stop", usage: { input: tokens ? tokens - 50 : 0, output: tokens ? 30 : 0, cacheRead: tokens ? 10 : 0, cacheWrite: tokens ? 10 : 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	const overflow = (): AssistantMessage => ({ ...reply("", 0), stopReason: "error", errorMessage: "重开会话历史超过上限，先整理上下文再继续（context window exceeded）" });
	const seed = async () => {
		faux.setResponses([reply("历史回复" + "甲".repeat(90_000)), reply("最近回复" + "乙".repeat(90_000))]);
		await promptSession(s, "旧历史");
		await promptSession(s, "最近历史");
	};
	return { s, faux, models, events, reply, overflow, seed, streamSimple, requestedProviders, compactCalls: () => compactCalls };
}

test("CLI 判定包含四家、配置表 native 和动态 native 协议；不误判普通 API", () => {
	for (const provider of ["antigravity", "codex", "claude-code", "opencode-cli", "gemini-cli"]) assert.equal(cliOwnsContext({ provider, id: "x" }), true);
	assert.equal(cliOwnsContext({ provider: "test-native", id: "x", api: "test-native-acp-native" }), true);
	assert.equal(cliOwnsContext({ provider: "other", id: "x", api: "test-native-acp-native" }), false);
	assert.equal(cliOwnsContext({ provider: "openai", id: "x", api: "openai-responses" }), false);
});

test("Pi 1.5.0 实测：禁 compaction 后 overflow 也不自动整理 / 重试", async (t) => {
	const f = await fixture(t);
	await f.seed();
	assert.equal(f.s.settingsManager.getCompactionSettings(f.s.model).enabled, false);
	f.faux.setResponses([f.overflow() as never]);
	await f.s.prompt("原生 Pi 溢出测试");
	assert.equal(f.compactCalls(), 0);
	assert.equal(f.s.messages.at(-1)?.role, "assistant");
	assert.equal((f.s.messages.at(-1) as { stopReason: string }).stopReason, "error");
	assert.equal(f.events.filter((e) => e.type === "compaction_start").length, 0);
});

test("CLI 超阈值不整理，手动仍可整理，普通模型恢复自动整理；切换设置不落全局", async (t) => {
	const f = await fixture(t);
	await f.seed();
	f.faux.setResponses([f.reply("工具自己管理", 31_500) as never, f.reply("下一轮", 31_500) as never]);
	await promptSession(f.s, "高用量");
	await promptSession(f.s, "下一轮仍不整理");
	assert.equal(f.compactCalls(), 0);
	await compactSession(f.s);
	assert.equal(f.compactCalls(), 1);
	const ordinary = "ownership-api";
	const fm = f.faux.getModel();
	f.models.registerProvider(ordinary, { api: fm.api, baseUrl: fm.baseUrl, streamSimple: f.streamSimple, models: [{ ...fm, provider: ordinary, id: "mock" }] });
	await f.models.setRuntimeApiKey(ordinary, "local-fixture");
	await applyModelSettings(f.s, f.models, { provider: ordinary, id: "mock" }, "off");
	assert.equal(f.s.settingsManager.getCompactionSettings(f.s.model).enabled, true);
	// 公开 setModel 也经过 model_select，不局限于应用的 applyModelSettings。
	await f.s.setModel(f.models.getModel("antigravity", "mock")!);
	assert.equal(f.s.settingsManager.getCompactionSettings(f.s.model).enabled, false);
	await f.s.setModel(f.models.getModel(ordinary, "mock")!);
	f.faux.setResponses([f.reply("API 高用量" + "丙".repeat(90_000), 31_500) as never]);
	await promptSession(f.s, "普通 API");
	assert.ok(f.compactCalls() >= 2, "普通模型应恢复阈值整理");
});

test("明确溢出：公开手动整理一次后安全继续，用户 / 附件只入历史一次，settled 只发最终结果", async (t) => {
	const f = await fixture(t);
	await f.seed();
	f.events.length = 0;
	const payloads: string[][] = [];
	f.faux.setResponses([
		((ctx: { messages: { role: string; content: unknown }[] }) => { payloads.push(ctx.messages.filter((m) => m.role === "user").map(textOf)); return f.overflow(); }) as never,
		((ctx: { messages: { role: string; content: unknown }[] }) => { payloads.push(ctx.messages.filter((m) => m.role === "user").map(textOf)); return f.reply("恢复完成"); }) as never,
	]);
	await promptSession(f.s, "用户唯一输入", [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }]);
	assert.equal(f.s.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "user" && Array.isArray(e.message.content) && e.message.content.some((b) => b.type === "image")).length, 1);
	assert.equal(f.compactCalls(), 1);
	assert.equal(lastAssistantText(f.s), "恢复完成");
	assert.equal(f.s.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "user" && textOf(e.message).includes("用户唯一输入")).length, 1);
	assert.ok(payloads.every((p) => p.filter((x) => x.includes("用户唯一输入")).length === 1));
	assert.equal(f.events.filter((e) => e.type === "settled").length, 1);
	assert.equal(f.events.at(-1)?.type, "settled");
});

test("溢出恢复经真实 Pi 手动摘要请求；摘要和继续都使用临时 Mock", async (t) => {
	const f = await fixture(t, { defaultSummary: true });
	await f.seed();
	f.events.length = 0;
	f.faux.setResponses([f.overflow(), f.reply("历史步骤已经完成，保留当前用户请求。"), f.reply("当前轮次前缀摘要，用户请求尚未完成。"), f.reply("默认摘要后完成")]);
	await promptSession(f.s, "当前待答请求");
	assert.equal(lastAssistantText(f.s), "默认摘要后完成", JSON.stringify({ last: f.s.messages.at(-1), events: f.events.filter((e) => e.type === "compaction_end") }));
	assert.equal(f.events.filter((e) => e.type === "compaction_end" && e.ok).length, 1);
	assert.equal(f.events.filter((e) => e.type === "settled").length, 1);
	assert.equal(f.s.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "user" && textOf(e.message).includes("当前待答请求")).length, 1);
});

test("溢出摘要遭 400 拒绝时复用手动入口的默认备用模型，恢复后会话模型不变", async (t) => {
	const f = await fixture(t, { defaultSummary: true });
	await f.seed();
	const fm = f.faux.getModel();
	f.models.registerProvider("summary-backup", { api: fm.api, baseUrl: fm.baseUrl, streamSimple: f.streamSimple, models: [{ ...fm, provider: "summary-backup", id: "mock" }] });
	await f.models.setRuntimeApiKey("summary-backup", "local-fixture");
	setContextRecoveryFallback(() => ({ provider: "summary-backup", id: "mock" }));
	t.after(() => setContextRecoveryFallback(() => null));
	const refusal = { ...f.overflow(), errorMessage: "400: input refused" };
	f.faux.setResponses([f.overflow(), refusal, f.reply("备用摘要"), f.reply("当前轮次前缀摘要"), f.reply("备用摘要后完成")]);
	await promptSession(f.s, "保留当前用户请求");
	assert.equal(lastAssistantText(f.s), "备用摘要后完成");
	assert.ok(f.requestedProviders.includes("summary-backup"), "摘要请求必须实际发给默认备用模型");
	assert.equal(f.s.model?.provider, "antigravity");
});

test("连续溢出只恢复一次；隐藏唤醒也走同一路径", async (t) => {
	const f = await fixture(t, { provider: "fixture-native", dynamic: true });
	await f.seed();
	f.events.length = 0;
	f.faux.setResponses([f.overflow() as never, f.overflow() as never]);
	await triggerHidden(f.s, "test-wake", "继续测试任务");
	assert.equal(f.compactCalls(), 1);
	assert.equal(f.events.filter((e) => e.type === "settled").length, 1);
	assert.equal((f.s.messages.at(-1) as { stopReason: string }).stopReason, "error");
});

test("整理失败、用户停止、带正文或工具调用的错误均不继续重放", async (t) => {
	for (const mode of ["fail", "abort", "visible", "tool", "network"] as const) {
		let s: Awaited<ReturnType<typeof createPiSession>>;
		const f = await fixture(t, { compact: (pi) => { pi.on("session_before_compact", () => { if (mode === "abort") void abortSession(s); return { cancel: true }; }); } });
		s = f.s;
		await f.seed();
		f.events.length = 0;
		const error = f.overflow();
		if (mode === "visible") error.content = [{ type: "text", text: "已执行部分步骤" }];
		if (mode === "tool") error.content = [{ type: "toolCall", id: "uncertain", name: "write", arguments: {} }];
		if (mode === "network") { error.errorMessage = "invalid request"; }
		f.faux.setResponses([error as never]);
		if (mode === "visible" || mode === "tool" || mode === "network") await promptSession(s, "测试");
		else await assert.rejects(promptSession(s, "测试"), /cancelled/);
		assert.equal(s.messages.filter((m) => m.role === "custom" && m.customType === "cli-context-recovery").length, 0);
		assert.equal(f.events.filter((e) => e.type === "settled").length, 1);
	}
});

test("CLI 圆环只取当前模型工具 reported，含缓存，不加 Pi 估算；未知不借用其他模型", async (t) => {
	const f = await fixture(t);
	assert.deepEqual(contextUsage(f.s), { tokens: null, contextWindow: 32_000 });
	await f.seed();
	assert.equal(contextUsage(f.s).tokens, 500);
	await injectContext(f.s, "extra", "新增 Pi 历史".repeat(1000));
	assert.equal(contextUsage(f.s).tokens, 500);
	assert.equal(sessionStats(f.s).tokens, 500);
	assert.equal(sessionStats(f.s).percent, 1.6);
	f.faux.setResponses([f.reply("没有上报用量", 0) as never]);
	await promptSession(f.s, "下一句");
	assert.equal(contextUsage(f.s).tokens, 500, "保留最近一次有效工具报告");
	f.s.model!.id = "other";
	assert.equal(contextUsage(f.s).tokens, null);
});
