/**
 * Pi 1.2.0 的扩展触发回合（triggerHidden / sendCustomMessage）与系统提示稳定性验证。
 *
 * 1.2.0 起 before_agent_start 对扩展触发的 run 也触发，但事件没有 prompt。这里用**真实 Pi 会话** +
 * 本地 faux 模型，验证的是「模型实际收到的内容」，不是 handler 返回值：
 *  1. triggerHidden（公开 sendCustomMessage triggerTurn）唤醒回合：记忆 bootContext 照常注入，
 *     但没有用户原话 → context 收到空 query（不做本轮召回）
 *  2. 一轮里第一次工具调用之后的下一步，systemPrompt 与首步完全一致（不在中途重算），
 *     且 context 一轮只被调用一次
 *  3. 唤醒回合里 skill_save 拿到的 userText 是空，不会把上一轮用户原话当成授权依据
 *  4. injectContext（nextTurn）会在下一轮真的进入上下文；忙时 steer 的插话在下一个工具边界送达；
 *     abort 后会话不卡死，新消息照常能发
 *
 * 用临时目录、内存凭据、本地假模型；不触发任何真实后台唤醒 / 不发真实消息。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { memoryExtension, type MemoryHost } from "@pi-assistant/ext-memory";
import { skillsExtension, type SkillsHost } from "@pi-assistant/ext-skills";
import { config } from "../src/config.ts";
import { abortSession, createPiSession, disposeSession, injectContext, PiModels, promptSession, subscribeSession, triggerHidden, Type, type AgentEvent, type ExtensionAPI } from "../src/pi-adapter/index.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const PROVIDER = "faux-boot";
const MODEL = "faux-boot-1";
const MARKER = "bootContext标记：用户叫灯灯大王";
const textOf = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as { text?: string }[]).map((b) => b.text ?? "").join("") : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = { systemPrompt: string; transcript: string; roles: string[] };
const steps: Step[] = [];

const faux = registerFauxProvider({ api: PROVIDER, provider: PROVIDER, models: [{ id: MODEL, name: "唤醒测试模型", input: ["text"] } as never], tokensPerSecond: 1000 });
const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
const fm = faux.getModel();
models.registerProvider(PROVIDER, { baseUrl: fm.baseUrl, api: fm.api, models: [{ id: MODEL, name: fm.name, api: fm.api, input: ["text"], cost: fm.cost, contextWindow: fm.contextWindow, maxTokens: fm.maxTokens, baseUrl: fm.baseUrl }] });
await models.setRuntimeApiKey(PROVIDER, "faux-key");

const step = (ctx: { messages: { role: string; content: unknown; customType?: string; toolsAdded?: { name: string }[] }[]; systemPrompt?: string }) => {
	faux.appendResponses([step as never]);
	const sys = ctx.messages.filter((x) => x.role === "system");
	const systemPrompt = [ctx.systemPrompt ?? "", ...sys.map(textOf)].filter(Boolean).join("\n");
	const tools = sys.flatMap((x) => x.toolsAdded ?? []);
	const msgs = ctx.messages.filter((x) => x.role !== "system");
	const last = msgs[msgs.length - 1];
	const transcript = msgs.map(textOf).join("\n");
	steps.push({ systemPrompt, transcript, roles: msgs.map((x) => x.role) });
	if (last?.role === "toolResult") return fauxAssistantMessage("工具已返回。");
	if (/先等待/.test(transcript)) return fauxAssistantMessage([fauxText("开始。"), fauxToolCall("waiter", {})]);
	if (/保存技能/.test(transcript)) return fauxAssistantMessage([fauxToolCall("skill_save", { name: "weekly-report-x", description: "写一份周报", body: "步骤" })]);
	if (/慢慢来/.test(transcript)) return fauxAssistantMessage([fauxText("慢慢做。"), fauxToolCall("waiter", {})]);
	return fauxAssistantMessage("收到。");
};
faux.setResponses([step as never]);

function waiterExtension(ms: number) {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "waiter",
			label: "等待",
			description: "测试用：等待一小段时间后返回",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			execute: async () => {
				await sleep(ms);
				return { content: [{ type: "text" as const, text: "等到了" }], details: undefined };
			},
		});
	};
}

type Hosts = { queries: string[]; confirmCreate: { userText: string }[]; observed: string[] };
async function newSession(name: string, opts: { waiterMs?: number } = {}) {
	const hosts: Hosts = { queries: [], confirmCreate: [], observed: [] };
	const ws = join(config.workspaceRoot, name);
	mkdirSync(ws, { recursive: true });
	const memory: MemoryHost = {
		context: async (q) => (hosts.queries.push(q), `## 关于用户与长期事实\n- [m1] (user/fact) ${MARKER}`),
		remember: async () => ({ id: "m1" }),
		recall: async () => [],
		forget: async () => true,
		onChange: () => {},
	};
	const skills: SkillsHost = {
		list: () => [],
		get: () => undefined,
		search: () => [],
		dupThreshold: 0.8,
		save: () => ({ name: "x", path: "", version: 1 }),
		remove: () => true,
		confirmCreate: async (i) => (hosts.confirmCreate.push(i), false),
		confirmUpdate: async () => false,
		confirm: async () => false,
		observe: (t) => hosts.observed.push(t.userText),
	};
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, name),
		sessionDir: join(config.agentsDir, name, "sessions"),
		model: { provider: PROVIDER, id: MODEL },
		systemPromptAppend: ["你是测试助理。"],
		extensions: [
			{ name: "memory", factory: memoryExtension(memory) },
			{ name: "skills", factory: skillsExtension(skills) },
			...(opts.waiterMs ? [{ name: "waiter", factory: waiterExtension(opts.waiterMs) }] : []),
		],
	});
	return { session, hosts };
}

const settle = async (session: { isStreaming: boolean }) => {
	for (let i = 0; i < 400 && session.isStreaming; i++) await sleep(25);
};

test("triggerHidden 唤醒回合：bootContext 注入到模型系统提示，但 context 收到空 query（不做本轮召回）", async () => {
	steps.length = 0;
	const { session, hosts } = await newSession("boot-hidden");
	await promptSession(session, "你好呀");
	await settle(session);
	assert.deepEqual(hosts.queries, ["你好呀"], "用户回合用原话召回");
	assert.ok(steps.at(-1)!.systemPrompt.includes(MARKER), "用户回合也注入了记忆块");

	await triggerHidden(session, "proactive", "到点提醒：该喝水了");
	await settle(session);
	assert.equal(hosts.queries.at(-1), "", "唤醒回合传空 query（没有用户原话，不做本轮召回）");
	assert.ok(steps.at(-1)!.systemPrompt.includes(MARKER), "唤醒回合模型照样收到 bootContext / 已记事实");
	assert.match(steps.at(-1)!.transcript, /到点提醒：该喝水了/, "唤醒内容确实进了上下文");
	await disposeSession(session);
});

test("一轮内工具调用后的下一步 systemPrompt 不变；context 一轮只调用一次", async () => {
	steps.length = 0;
	const { session, hosts } = await newSession("boot-stable", { waiterMs: 50 });
	await promptSession(session, "先等待再继续");
	await settle(session);
	assert.equal(hosts.queries.length, 1, "同一轮里 context 只被调用一次（不在工具后重算系统提示）");
	const turnSteps = steps.slice();
	assert.ok(turnSteps.length >= 2, `期望至少两步（工具前 / 工具后），实际 ${turnSteps.length}`);
	assert.equal(turnSteps[0].systemPrompt, turnSteps[1].systemPrompt, "工具调用后的 systemPrompt 与首步一致");
	assert.ok(turnSteps.every((s) => s.systemPrompt.includes(MARKER)), "每步都带着记忆块");
	await disposeSession(session);
});

test("唤醒回合里的 skill_save 拿不到上一轮用户原话（不会误授权）", async () => {
	steps.length = 0;
	const { session, hosts } = await newSession("boot-skill");
	await promptSession(session, "把周报的写法做成技能");
	await settle(session);
	await triggerHidden(session, "proactive", "保存技能：周报");
	await settle(session);
	assert.equal(hosts.confirmCreate.length, 1, "唤醒回合确实尝试创建技能");
	assert.equal(hosts.confirmCreate[0].userText, "", "授权判断的 userText 是空，不是上一轮用户原话");
	await disposeSession(session);
});

test("injectContext（nextTurn）下一轮可见；忙时 steer 的插话在工具边界送达", async () => {
	steps.length = 0;
	const { session } = await newSession("boot-inject", { waiterMs: 400 });
	await injectContext(session, "note", "下一轮要看到这条便签");
	await promptSession(session, "先等待再继续");
	await settle(session);
	assert.match(steps.at(-1)!.transcript, /下一轮要看到这条便签/, "nextTurn 注入在下一轮进入上下文");

	// 忙时插话：等工具开始后 steer，插话应在工具边界的下一步被模型读到
	steps.length = 0;
	let steered = false;
	const unsub = subscribeSession(session, (e: AgentEvent) => {
		if (e.type === "tool_start" && e.name === "waiter" && !steered) {
			steered = true;
			void promptSession(session, "我插一句：再加张图");
		}
	});
	await promptSession(session, "先等待再继续");
	await settle(session);
	unsub();
	assert.ok(steered, "工具确实启动了（否则没验证到 steer）");
	assert.match(steps.at(-1)!.transcript, /我插一句：再加张图/, "插话在下一个工具边界被模型读到，没有丢");
	await disposeSession(session);
});

test("abort 忙时的回合后会话不卡死，新消息仍能发出", async () => {
	steps.length = 0;
	const { session } = await newSession("boot-abort", { waiterMs: 3000 });
	let started = false;
	const unsub = subscribeSession(session, (e: AgentEvent) => {
		if (e.type === "tool_start" && e.name === "waiter" && !started) {
			started = true;
			abortSession(session);
		}
	});
	const p = promptSession(session, "慢慢来");
	await settle(session);
	await p.catch(() => {});
	unsub();
	assert.ok(started, "慢工具确实启动了");
	assert.equal(session.isStreaming, false, "abort 后回合结束");
	await promptSession(session, "回头再说");
	await settle(session);
	assert.ok(session.getLastAssistantText(), "abort 之后还能正常继续对话");
	await disposeSession(session);
});
