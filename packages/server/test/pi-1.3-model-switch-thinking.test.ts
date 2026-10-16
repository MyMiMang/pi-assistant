/**
 * Pi 1.3.0 模型切换：切换前模型产生的 thinking **不**再作为正文发给新模型（payload 级实证）。
 *
 * 背景：上游 #10995 修了「原地切模型后，旧模型的 thinking 被当普通文本喂给新模型」——
 * 新模型会把别人的推理内容当成自己可见回复的一部分（错误归因 / 上下文污染）。
 * 我们生产在 `runtime.ts` 用公开 `applyModelSettings`（= `session.setModel`）**原地**切模型、不重建会话，
 * 所以这条行为变化直接影响我们。之前只验了「思考档位目录无回归」，**没有在 payload 层断言**，
 * 是本轮 1.3 验收唯一剩下的价值缺口。
 *
 * 本用例不经 UI 展示推测，而是用真实 loopback OpenAI 兼容中转（`e2e/mock-openai.mjs`）
 * 记录 new provider 实际收到的 HTTP 请求体（openai-completions 内部会走 pi-ai 的
 * `transformMessages`），断言：
 *  - 旧 thinking 标记**不出现**在任何消息里（1.2 的 bug shape 是它会以文本出现）；
 *  - 切换前的普通用户文字、引用历史、本次选用技能正文**仍在**（没有误伤正常上下文）。
 *
 * 只用公开 SDK 调用点；数据目录 / 工作区由 `test/setup.ts` 强制为临时目录 + 内存凭据，
 * 不碰真实云 / 用户数据 / 系统钥匙串。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxThinking, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { startMockOpenAI } from "../../../e2e/mock-openai.mjs";
import { config } from "../src/config.ts";
import { customProviders, initModels, models } from "../src/models.ts";
import { applyModelSettings, createPiSession, disposeSession, promptSession, skillCommand } from "../src/pi-adapter/index.ts";
import { composeQuotedInput, formatQuotedContext } from "../src/replies.ts";
import { saveSkill, skillPaths } from "../src/skills.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const THINKING_MARKER = "内部推理标记-THINK-7f3a：用户口令是甲子九号";
const USER_TEXT_A = "记住：口令是甲子九号";
const USER_TEXT_B = "现在回答第二个问题";
const QUOTE_EXCERPT = "被引用的历史：上一轮说的是乙丑三号";
const SKILL_NAME = "switch-thinking-skill";
const SKILL_BODY_MARKER = "技能正文标记-SKILL-9c1b";

// 切换目标：真实 loopback OpenAI 兼容中转，HTTP 请求体可回放（不连真实云，假 Key）。
const relay = await startMockOpenAI({ port: 0, key: "sk-switch" });
after(() => relay.close());
await initModels(memoryCredentialStore());
const target = await customProviders.save(null, {
	name: "1.3 切换目标",
	api: "openai-completions",
	baseUrl: relay.url,
	apiKey: "sk-switch",
	models: [{ id: "switch-target" }],
});
after(() => customProviders.remove(target.id));

// 切换前模型：faux，能产出**真正的 thinking block**（生产里由推理模型产出），双方都只有 text 能力。
const faux = registerFauxProvider({ provider: "fauxswitch", models: [{ id: "faux-switch", reasoning: true, input: ["text"] } as never], tokensPerSecond: 10000 });
const fm = faux.getModel();
models.registerProvider("fauxswitch", { baseUrl: fm.baseUrl, api: fm.api, models: [{ id: fm.id, name: fm.name, api: fm.api, input: ["text"], cost: fm.cost, contextWindow: fm.contextWindow, maxTokens: fm.maxTokens, baseUrl: fm.baseUrl }], colors: null, docs: "" } as never);
await models.setRuntimeApiKey("fauxswitch", "faux-key");
faux.setResponses([fauxAssistantMessage([fauxThinking(THINKING_MARKER), fauxText("好，我记住了。")]) as never]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(session: Awaited<ReturnType<typeof createPiSession>>, ms = 15000) {
	const end = Date.now() + ms;
	while (session.isStreaming && Date.now() < end) await sleep(50);
}

test("1.3 模型切换：旧 thinking 不进新 provider payload；用户文字 / 引用 / 技能仍在", async () => {
	const skill = saveSkill({ name: SKILL_NAME, description: "模型切换 payload 验证技能", body: `步骤：${SKILL_BODY_MARKER}。` });
	const name = "switch-thinking";
	const ws = join(config.workspaceRoot, name);
	mkdirSync(ws, { recursive: true });
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir: join(config.agentsDir, name),
		sessionDir: join(config.agentsDir, name, "sessions"),
		model: { provider: "fauxswitch", id: "faux-switch" },
		systemPromptAppend: ["你是模型切换 payload 测试助理。"],
		extensions: [],
		skillPaths: skillPaths(),
		skillFilter: (s) => s.name === SKILL_NAME,
	});
	try {
		await promptSession(session, USER_TEXT_A);
		await settle(session);
		// 切换前的转录里必须有 thinking block —— 这样下面 payload 里没有它才说明是「跨模型丢弃」，
		// 而不是「本来就没产生」（1.2 的 bug shape：它会以文本出现在新 provider 的 payload 里）。
		const messages = (session as unknown as { agent: { state: { messages: { role: string; content?: unknown }[] } } }).agent.state.messages;
		const thinkingInTranscript = messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && (m.content as { type?: string; thinking?: string }[]).some((b) => b.type === "thinking" && String(b.thinking).includes(THINKING_MARKER)));
		assert.ok(thinkingInTranscript, "切换前助理消息应带 thinking block");

		// 原地切模型（生产路径：runtime.ts → applyModelSettings → session.setModel），历史保留不重建
		assert.ok(await applyModelSettings(session, models, { provider: target.id, id: "switch-target" }, "off"), "应发生模型切换");

		// 引用历史 + 本次选用技能：都用生产 helper 拼进本轮输入
		const quote = formatQuotedContext({
			messageId: "m-prev-1",
			author: { id: "", name: "我", role: "user" },
			source: { kind: "conversation", id: "c1" },
			excerpt: QUOTE_EXCERPT,
			truncated: false,
			edited: false,
			createdAt: Date.now(),
		} as never);
		const cmd = skillCommand(session, [{ id: skill.id, name: skill.name, filePath: skill.path }]);
		assert.ok(cmd, "应定位到已加载的技能");
		await promptSession(session, composeQuotedInput(USER_TEXT_B, quote), undefined, cmd);
		await settle(session);
	} finally {
		await disposeSession(session);
	}

	const bodies = relay.seen.filter((s) => s.method === "POST" && s.url === "/v1/chat/completions").map((s) => s.body);
	assert.ok(bodies.length >= 1, "新 provider 应收到请求");
	const payload = bodies[bodies.length - 1];
	console.log(`[切换] new provider payload 字节=${payload.length} 含thinking=${payload.includes(THINKING_MARKER)} 含旧正文=${payload.includes("好，我记住了。")} 含技能=${payload.includes(SKILL_BODY_MARKER)} 含引用=${payload.includes(QUOTE_EXCERPT)}`);
	assert.ok(!payload.includes(THINKING_MARKER), `旧 thinking 不得作为正文发给新模型；实际 payload：${payload}`);
	assert.ok(payload.includes(USER_TEXT_A), "切换前的普通用户文字仍在");
	// 正对照：旧模型的**正文**回复仍在 payload 里 —— 证明不是「整条 assistant 消息被丢掉」，
	// 而是只有 thinking 被跨模型丢弃。
	assert.ok(payload.includes("好，我记住了。"), "旧模型的正文回复仍应保留");
	assert.ok(payload.includes(USER_TEXT_B), "切换后的用户问题仍在");
	assert.ok(payload.includes(QUOTE_EXCERPT), "引用历史仍在");
	assert.ok(payload.includes(SKILL_BODY_MARKER), "本次选用技能正文仍在");
});
