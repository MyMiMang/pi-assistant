/**
 * app 消息 ↔ Pi entry 的可信映射（session fork 的锚点解析）验证。
 *
 * 用**真实公开** Pi 会话 + 本地 faux 模型，驱动「一条 assistant 消息里两个并行工具调用」这种
 * 多条 message_end 可能落在同一 tick 的场景，验证 `entry_id` 事件给出的是**每条消息各自的**
 * entry id（按消息对象身份反查），不是同一个（读 leaf 会把同 tick 的几条都指到最后一条）。
 * 只用公开 API，不碰 SDK 私有字段。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { config } from "../src/config.ts";
import { createPiSession, disposeSession, PiModels, promptSession, subscribeSession, Type, type AgentEvent, type ExtensionAPI } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const PROVIDER = "faux-entry-map";
const MODEL = "faux-entry-map-1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const faux = registerFauxProvider({ api: PROVIDER, provider: PROVIDER, models: [{ id: MODEL, name: "映射测试模型", input: ["text"] } as never], tokensPerSecond: 1000 });
const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
const fm = faux.getModel();
models.registerProvider(PROVIDER, { baseUrl: fm.baseUrl, api: fm.api, models: [{ id: MODEL, name: fm.name, api: fm.api, input: ["text"], cost: fm.cost, contextWindow: fm.contextWindow, maxTokens: fm.maxTokens, baseUrl: fm.baseUrl }] });
await models.setRuntimeApiKey(PROVIDER, "faux-key");

/** 两个「并行」工具：都在同一 assistant 消息里被调用，结果几乎同时落盘 */
function twoToolsExtension() {
	return (pi: ExtensionAPI) => {
		for (const name of ["tool_a", "tool_b"]) {
			pi.registerTool({
				name,
				label: name,
				description: "测试用：立刻返回",
				parameters: Type.Object({}),
				annotations: { readOnlyHint: true },
				execute: async () => ({ content: [{ type: "text" as const, text: `${name}-done` }], details: undefined }),
			});
		}
	};
}

async function newSession(name: string) {
	const ws = join(config.workspaceRoot, name);
	mkdirSync(ws, { recursive: true });
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, name),
		sessionDir: join(config.agentsDir, name, "sessions"),
		model: { provider: PROVIDER, id: MODEL },
		systemPromptAppend: ["你是测试助理。"],
		extensions: [{ name: "two-tools", factory: twoToolsExtension() }],
	});
	return session;
}

const settle = async (session: { isStreaming: boolean }) => {
	for (let i = 0; i < 400 && session.isStreaming; i++) await sleep(25);
};

const textOf = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as { text?: string }[]).map((b) => b.text ?? "").join("") : "");

test("并行工具结果 / 连发同文本 user：每条消息各自拿到自己的 entry id，不互相顶替", async () => {
	const session = await newSession("entry-map-parallel");
	const events: Extract<AgentEvent, { type: "entry_id" }>[] = [];
	subscribeSession(session, (e) => {
		if (e.type === "entry_id") events.push(e);
	});

	// 第一步：一条 assistant 消息里并行调用两个工具；第二步（拿到两个 toolResult 后）收尾
	const scripted = (_ctx: { messages: { role: string; content: unknown }[] }) =>
		fauxAssistantMessage([fauxText("并行做两件事。"), fauxToolCall("tool_a", {}), fauxToolCall("tool_b", {})]);
	faux.setResponses([scripted as never, fauxAssistantMessage("都做完了。") as never]);

	const before = new Set(session.sessionManager.getEntries().map((e) => e.id));
	await promptSession(session, "同一句话");
	await settle(session);

	// 这次运行新追加的、适配层会映射的 message entry（system 不入映射）
	const mappedRoles = ["user", "assistant", "toolResult"];
	const appended = session.sessionManager.getEntries().filter((e) => !before.has(e.id) && e.type === "message" && mappedRoles.includes(((e as { message?: { role?: string } }).message?.role) ?? ""));
	const appendedIds = appended.map((e) => e.id).sort();
	const eventIds = events.map((e) => e.entryId).sort();

	// ① entry_id 事件的数量与集合 = 新追加的 message entry（不多不少、不重复指同一条）
	assert.ok(appended.length >= 4, `至少 user + assistant + 2×toolResult，实际 ${appended.length}`);
	assert.deepEqual(eventIds, appendedIds, "entry_id 事件与新追加的 message entry 一一对应");
	assert.equal(new Set(events.map((e) => e.entryId)).size, events.length, "每条 entry_id 各不相同（没有把同 tick 的几条都指到最后一条）");

	// ② 工具结果按 toolCallId 精确落到对应 entry（不靠顺序 / 文本猜）
	const toolEvents = events.filter((e) => e.role === "toolResult");
	assert.equal(toolEvents.length, 2, "两个 toolResult 各有一条 entry_id");
	for (const e of toolEvents) {
		const entry = session.sessionManager.getEntry(e.entryId);
		assert.ok(entry && entry.type === "message", "entry 存在且是 message");
		assert.equal((entry!.message as { role?: string }).role, "toolResult");
		assert.equal((entry!.message as { toolCallId?: string }).toolCallId, e.toolCallId, `entry id 精确对应 toolCallId=${e.toolCallId}`);
	}
	// 两个 toolResult 指向不同 entry
	assert.notEqual(toolEvents[0].entryId, toolEvents[1].entryId);

	// ③ user / assistant 也各自一条
	assert.equal(events.filter((e) => e.role === "user").length, 1);
	assert.equal(events.filter((e) => e.role === "assistant").length, 2, "首条（带工具调用）+ 收尾各一条 assistant");

	// ④ 连发同文本 user：两条各自拿到自己的 entry（文本相同也不能串）
	const user1 = events.find((e) => e.role === "user")!;
	const entry1 = (session.sessionManager.getEntry(user1.entryId) as { message: { role: string; content: unknown } }).message;
	assert.match(textOf(entry1), /同一句话/);

	faux.setResponses([fauxAssistantMessage("第二次也收到。") as never]);
	const before2 = new Set(session.sessionManager.getEntries().map((e) => e.id));
	events.length = 0;
	await promptSession(session, "同一句话");
	await settle(session);
	const user2 = events.find((e) => e.role === "user")!;
	const appended2 = session.sessionManager.getEntries().filter((e) => !before2.has(e.id) && e.type === "message" && mappedRoles.includes(((e as { message?: { role?: string } }).message?.role) ?? ""));
	assert.deepEqual(events.map((e) => e.entryId).sort(), appended2.map((e) => e.id).sort());
	assert.notEqual(user1.entryId, user2.entryId, "同文本的两条 user 拿到不同的 entry id");
	const entry2 = (session.sessionManager.getEntry(user2.entryId) as { message: { content: unknown } }).message;
	assert.match(textOf(entry2), /同一句话/);

	await disposeSession(session);
});
