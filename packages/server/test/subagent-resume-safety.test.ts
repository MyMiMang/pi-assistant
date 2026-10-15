/**
 * 子代理续跑安全实证（会话级，进程内；不花钱、不碰钥匙串、不起 main）：
 *   node --import tsx --import ./test/setup.ts --test test/subagent-resume-safety.test.ts
 *
 * 只经公开 Pi SDK：PiModels.create({ credentials: memoryCredentialStore() }) + createPiSession，
 * 用本地 faux provider 脚本化模型。验证用户 2026-10-22 的核心要求：
 *   副作用工具执行一次后模型连接中断 → 自动续跑恢复时**不重放该副作用**（count 仍为 1），
 *   且落库会话里 toolCall 与 toolResult 配平（可据此证明自动续跑安全）。
 *
 * 注意：这里证明的是「同进程内连接类中断的续跑不重放副作用」；跨进程崩溃时结果未知的调用
 * 由 assessResumeSafety 判定为不安全并禁止自动续跑（见 subagent-resume.test.ts 单测）。
 */
import "../test/setup.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { branchMessagesOf, createPiSession, disposeSession, PiModels, promptSession, readSessionFileMessages, sessionFileOf } from "../src/pi-adapter/index.ts";
import { assessResumeSafety, classifyResume, shouldAutoRetrySafely, TRANSPORT_RETRY_PROMPT } from "../src/subagent-resume.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

const PROVIDER = "resume-safety-mock";
const MODEL = "flaky";

test("副作用工具执行一次后模型连接中断，续跑恢复不重放副作用（count 仍为 1）", async () => {
	const sideEffects: string[] = [];
	const faux = registerFauxProvider({ provider: PROVIDER, models: [{ id: MODEL, name: "flaky", input: ["text"] } as never], tokensPerSecond: 100 });
	let toolDone = false;
	const step = (ctx: { messages: { role: string; toolName?: string }[] }) => {
		faux.appendResponses([step as never]); // 自续：faux provider 的应答队列每轮消费一个
		const msgs = ctx.messages.filter((m) => m.role !== "system");
		const last = msgs[msgs.length - 1];
		if (last?.role === "toolResult" && last.toolName === "side_effect") {
			toolDone = true;
			// 工具已经真实执行（副作用已发生），此时模型连接中断；续跑必须不重放它。
			// 用 EHOSTUNREACH 让 Pi 自身不重试（它不在 Pi 的 retryable 列表里），只走我们这层的续跑判定。
			throw new Error("EHOSTUNREACH 模拟副作用完成后模型连接中断");
		}
		if (toolDone) return fauxAssistantMessage("已核验：副作用只发生一次，任务完成");
		return fauxAssistantMessage([fauxText("先做一次副作用。"), fauxToolCall("side_effect", { note: "once" })]);
	};
	faux.setResponses([step as never]);
	const m = faux.getModel();

	const models = await PiModels.create({ credentials: memoryCredentialStore(), modelsPath: null, allowNetwork: false });
	models.registerProvider(PROVIDER, {
		baseUrl: m.baseUrl,
		api: m.api,
		models: [{ id: MODEL, name: "flaky", api: m.api, reasoning: false, input: ["text"], cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens, baseUrl: m.baseUrl }],
	});
	await models.setRuntimeApiKey(PROVIDER, "test");

	const ws = mkdtempSync(join(tmpdir(), "pia-resume-safety-"));
	const agentDir = join(ws, "agent");
	mkdirSync(agentDir, { recursive: true });
	const session = await createPiSession({
		models,
		cwd: ws,
		agentDir,
		sessionDir: join(agentDir, "sessions"),
		model: { provider: PROVIDER, id: MODEL },
		systemPromptAppend: ["你是测试助理。"],
		extensions: [
			{
				name: "side-effect",
				factory: ((pi: { registerTool: (t: unknown) => void }) => {
					pi.registerTool({
						name: "side_effect",
						label: "副作用（测试）",
						description: "记录一次外部副作用，返回已计数次数（测试用）。",
						parameters: Type.Object({ note: Type.String() }),
						async execute() {
							sideEffects.push("x");
							return { content: [{ type: "text" as const, text: `side effect #${sideEffects.length}` }], details: undefined };
						},
					});
				}) as never,
			},
		],
	});
	try {
		await promptSession(session, "请执行一次副作用");
		assert.equal(sideEffects.length, 1, "副作用工具应先执行一次（模型连接随后中断）");
		// 连接中断后，runtime 的自动续跑只发「先核验、不重做」的续跑提示（不重发原任务）；这里复现同一动作
		const beforeResume = assessResumeSafety(branchMessagesOf(session));
		assert.equal(beforeResume.safe, true, `副作用结果已落库，续跑应安全：${beforeResume.reason}`);
		const errMsg = session.messages.map((m) => (m as { errorMessage?: string }).errorMessage).filter(Boolean).pop();
		assert.ok(errMsg && classifyResume(errMsg).cls === "transport", `应识别为连接类中断：${errMsg}`);
		assert.equal(shouldAutoRetrySafely(errMsg, 1, beforeResume), true, "无未知副作用时允许自动续跑");
		await promptSession(session, TRANSPORT_RETRY_PROMPT);
		assert.equal(sideEffects.length, 1, "续跑后副作用不得被重放（count 仍为 1）");
		assert.match(session.getLastAssistantText() ?? "", /副作用只发生一次/);
		// 落库会话里调用与结果配平 → 自动续跑安全
		const branch = branchMessagesOf(session);
		const safety = assessResumeSafety(branch);
		assert.equal(safety.safe, true, safety.reason);
		assert.equal(safety.pendingToolCalls.length, 0);
		// 落库文件可独立读回并复核（崩溃恢复就是走这条路径）
		const file = sessionFileOf(session);
		assert.ok(file, "应有落库 session 文件");
		const fromFile = readSessionFileMessages(file!);
		assert.ok(fromFile && fromFile.length > 0, "应能从落库文件读回消息");
		assert.equal(assessResumeSafety(fromFile!).safe, true, "落库文件复核也应为安全");
	} finally {
		await disposeSession(session);
	}
});
