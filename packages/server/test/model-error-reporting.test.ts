/** 服务失败 → 真实Pi → runtime落库；临时根/内存凭据/loopback，不读用户账户或请求付费服务。 */
import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { createConversation } from "../src/conversations.ts";
import { db, now, setSetting } from "../src/db.ts";
import { initModels, models } from "../src/models.ts";
import { lastAssistantError, modelErrorMessage, subscribeSession, type AgentEvent, type AgentSession } from "../src/pi-adapter/index.ts";
import { bindSession, disposeConversationRuntime, runtime, tasks } from "../src/runtime.ts";
import { getSubagent } from "../src/subagents.ts";
import { memoryCredentialStore } from "./in-memory-credentials.ts";

function adapterEvents(message: Record<string, unknown>, start = true) {
	let listener: (e: unknown) => void = () => {};
	const fake = { subscribe: (fn: typeof listener) => { listener = fn; return () => {}; }, sessionManager: { getEntries: () => [] } } as unknown as AgentSession;
	const events: AgentEvent[] = [];
	subscribeSession(fake, (e) => events.push(e));
	if (start) listener({ type: "message_start", message: { role: "assistant" } });
	listener({ type: "message_end", message: { role: "assistant", content: [], ...message } });
	return events.find((e) => e.type === "assistant_end") as Extract<AgentEvent, { type: "assistant_end" }>;
}

test("Codex额度错误没有start也归一化出可见错误；错误对象只取可读字段并脱敏", () => {
	const quota = adapterEvents({ stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min." }, false);
	assert.match(quota.error!, /ChatGPT usage limit/);
	assert.equal(quota.aborted, false);
	const nested = modelErrorMessage({ error: { code: "insufficient_quota", message: "credit balance exhausted", authorization: "do-not-display" }, headers: { authorization: "never-display" } });
	assert.match(nested, /insufficient_quota.*credit balance exhausted/);
	assert.doesNotMatch(nested, /do-not-display|never-display|object Object/);
	assert.doesNotMatch(modelErrorMessage(new Error("unauthorized Bearer fixture-secret-key")), /fixture-secret-key/);
	assert.match(adapterEvents({ stopReason: "error", errorMessage: "" }).error!, /未提供具体原因/);
});

test("停止保留aborted而非额度失败；合法tool-only携带标记；errorMessage不被非error stop吞掉", () => {
	const stopped = adapterEvents({ stopReason: "aborted", errorMessage: "Request was aborted" });
	assert.equal(stopped.aborted, true); assert.equal(stopped.error, undefined);
	// Pi 有时把用户停止记成 error + 中止原文：按停止处理；超时不算停止
	const stoppedAsError = adapterEvents({ stopReason: "error", errorMessage: "This operation was aborted" });
	assert.equal(stoppedAsError.aborted, true); assert.equal(stoppedAsError.error, undefined);
	assert.equal(lastAssistantError({ messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" }] } as never), undefined);
	assert.equal(adapterEvents({ stopReason: "error", errorMessage: "The operation was aborted due to timeout" }).aborted, false);
	assert.equal(adapterEvents({ stopReason: "toolUse", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }] }).hasToolCalls, true);
	assert.match(adapterEvents({ stopReason: "stop", errorMessage: "insufficient_quota" }).error!, /insufficient_quota/);
	assert.equal(lastAssistantError({ messages: [{ role: "assistant", content: [], stopReason: "stop" }] } as never), "这次未收到回复，服务未提供具体原因");
	assert.equal(lastAssistantError({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "已思考" }], stopReason: "stop" }] } as never), undefined);
});

test("lastAssistantError：同一轮前面已有可见输出，最后的空回复不算失败；整轮全空仍失败；插话不切断一轮", () => {
	const empty = { role: "assistant", content: [], stopReason: "stop" };
	const withTool = { role: "assistant", content: [{ type: "text", text: "好了" }, { type: "toolCall", id: "t", name: "deliver_file", arguments: {} }], stopReason: "toolUse" };
	const run = (...messages: unknown[]) => lastAssistantError({ messages } as never);
	assert.equal(run({ role: "user", content: "请交付" }, withTool, { role: "toolResult", content: [] }, empty), undefined);
	assert.equal(run({ role: "user", content: "请交付" }, empty), "这次未收到回复，服务未提供具体原因");
	assert.equal(run({ role: "user", content: "旧一轮" }, withTool, { role: "user", content: "新一轮" }, empty), "这次未收到回复，服务未提供具体原因", "上一轮的输出不算本轮");
	assert.equal(run({ role: "user", content: "请交付" }, withTool, { role: "user", content: "（你工作时用户发来的新消息）\n补充" }, empty), undefined);
	assert.match(run({ role: "user", content: "x" }, withTool, { role: "assistant", content: [], stopReason: "error", errorMessage: "usage_limit_reached" })!, /usage_limit_reached/);
});

let mode: "quota" | "empty" | "partial" = "quota", requests = 0;
const relay = createServer(async (req, res) => {
	for await (const _ of req) { /* 只消费，不记录请求或headers */ }
	requests++;
	res.writeHead(200, { "content-type": "text/event-stream" });
	if (mode === "quota") {
		res.end(`data: ${JSON.stringify({ error: { code: "usage_limit_reached", type: "insufficient_quota", message: "You have hit your ChatGPT usage limit. Try again later." } })}\n\n`);
		return;
	}
	const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: "error-fixture", object: "chat.completion.chunk", model: "error-fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	res.write(chunk({ role: "assistant", content: mode === "partial" ? "已有部分结果" : "" }));
	if (mode === "partial") res.write(`data: ${JSON.stringify({ error: { code: "insufficient_quota", message: "credit balance exhausted" } })}\n\n`);
	else res.write(chunk({}, "stop"));
	res.end("data: [DONE]\n\n");
});
const port = await new Promise<number>((resolve) => relay.listen(0, "127.0.0.1", () => resolve((relay.address() as { port: number }).port)));
await initModels(memoryCredentialStore());
const PROVIDER = "error-report-fixture", MODEL = "error-fixture", AGENT = "error-report-agent";
models.registerProvider(PROVIDER, { api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: MODEL, name: "错误回归", input: ["text"], reasoning: false, contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
await models.setRuntimeApiKey(PROVIDER, "fixture-only");
setSetting("skillSuggest", { enabled: false });
db.prepare("INSERT INTO agents(id,name,avatar,color,created_at,model_provider,model_id) VALUES(?,?,?,?,?,?,?)").run(AGENT, "错误验证", "测", "#000", now(), PROVIDER, MODEL);
const conversations: string[] = [];
after(async () => {
	for (const id of conversations) await disposeConversationRuntime(id);
	relay.closeAllConnections();
	await new Promise<void>((r) => relay.close(() => r()));
});
const messages = (id: string) => db.prepare("SELECT content,status,meta FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY rowid").all(id) as { content: string; status: string; meta: string }[];
const until = async (fn: () => boolean) => { const end = Date.now() + 12000; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); } assert.fail("loopback流程12秒内未收尾"); };

test("没有start的最终事件也持久可见：quota/空结果/正文/停止，纯工具中间不留空引用", () => {
	const conv = createConversation(AGENT, "缺少start事件"); conversations.push(conv.id);
	let listener: (e: unknown) => void = () => {};
	const fake = { subscribe: (fn: typeof listener) => { listener = fn; return () => {}; }, sessionManager: { getEntries: () => [] } } as unknown as AgentSession;
	const unbind = bindSession(fake, AGENT, conv.id, null, () => {});
	try {
		const end = (fields: Record<string, unknown>) => listener({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop", ...fields } });
		end({ stopReason: "error", errorMessage: "usage_limit_reached" });
		assert.equal(messages(conv.id).at(-1)?.status, "error");
		assert.match(JSON.parse(messages(conv.id).at(-1)!.meta).error, /usage_limit_reached/);
		end({});
		assert.equal(messages(conv.id).at(-1)?.status, "error");
		assert.match(JSON.parse(messages(conv.id).at(-1)!.meta).error, /未收到回复/);
		end({ content: [{ type: "text", text: "直接结束的正文仍可见" }] });
		assert.equal(messages(conv.id).at(-1)?.content, "直接结束的正文仍可见");
		assert.equal(messages(conv.id).at(-1)?.status, "done");
		end({ stopReason: "aborted" });
		assert.equal(messages(conv.id).at(-1)?.status, "interrupted");
		const before = messages(conv.id).length;
		end({ stopReason: "toolUse", content: [{ type: "toolCall", id: "only-tool", name: "read", arguments: {} }] });
		assert.equal(messages(conv.id).length, before, "纯工具占位创建后删除，不留引用或空错误");
	} finally { unbind(); }
	const before = messages(conv.id).length;
	const unbindOptional = bindSession(fake, AGENT, conv.id, null, () => {}, undefined, undefined, undefined, () => true);
	try {
		listener({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } });
		assert.equal(messages(conv.id).length, before, "宿主技能用途内部轮明确允许无输出，不冒充服务失败");
		listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "（这一轮先停在这里，等你回复。）" }], stopReason: "stop" } });
		assert.equal(messages(conv.id).length, before, "技能用途内部轮只该出卡片：模型多说的话不留");
		listener({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "usage_limit_reached" } });
		assert.equal(messages(conv.id).length, before + 1, "即使允许内部无输出，真实quota错误仍须落库可见");
		assert.equal(messages(conv.id).at(-1)?.status, "error");
	} finally { unbindOptional(); }
});

test("额度失败与空最终回复在原对话落error，不吞成空done；部分正文保留，既有错误不会要求额外模型来解释", async () => {
	for (const next of ["quota", "empty", "partial"] as const) {
		mode = next;
		const conv = createConversation(AGENT, next); conversations.push(conv.id);
		await runtime(AGENT, conv.id).send("请给出这一轮结果");
		await until(() => messages(conv.id).some((m) => m.status === "error") && !runtime(AGENT, conv.id).busy);
		const last = messages(conv.id).at(-1)!;
		assert.equal(last.status, "error");
		const error = JSON.parse(last.meta).error;
		if (next === "quota") assert.match(error, /usage limit/);
		if (next === "empty") assert.match(error, /未收到回复.*未提供具体原因/);
		if (next === "partial") { assert.match(error, /credit balance exhausted/); assert.equal(last.content, "已有部分结果"); }
	}
	assert.equal(requests, 3, "每轮一次真实loopback请求；没有为了显示报错再调用模型");
});

test("bindSession：收尾空回复不留错误；整轮全空仍报错；Pi 自动重试成功标 retried、最终失败记 retryFailed", () => {
	const conv = createConversation(AGENT, "收尾空回复与自动重试"); conversations.push(conv.id);
	let listener: (e: unknown) => void = () => {};
	const fake = { subscribe: (fn: typeof listener) => { listener = fn; return () => {}; }, sessionManager: { getEntries: () => [] } } as unknown as AgentSession;
	const unbind = bindSession(fake, AGENT, conv.id, null, () => {});
	const end = (fields: Record<string, unknown>) => listener({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop", ...fields } });
	const metaOf = (i: number) => JSON.parse(messages(conv.id).at(i)!.meta);
	try {
		// 一轮：正文 + 交付文件工具调用，随后模型空回复
		end({ stopReason: "toolUse", content: [{ type: "text", text: "文件已生成" }, { type: "toolCall", id: "d1", name: "deliver_file", arguments: {} }] });
		listener({ type: "tool_execution_start", toolCallId: "d1", toolName: "deliver_file", args: {} });
		listener({ type: "tool_execution_end", toolCallId: "d1", toolName: "deliver_file", isError: false, result: { content: [{ type: "text", text: "ok" }] } });
		const before = messages(conv.id).length;
		end({});
		assert.equal(messages(conv.id).length, before, "收尾空回复删除，不留红色错误");
		listener({ type: "agent_settled" });
		// 新一轮整轮全空：仍然报错
		end({});
		assert.equal(messages(conv.id).at(-1)?.status, "error");
		assert.match(metaOf(-1).error, /未收到回复/);
		listener({ type: "agent_settled" });
		// 自动重试成功
		end({ stopReason: "error", errorMessage: "Connection error." });
		listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 5, delayMs: 1000, errorMessage: "Connection error." });
		assert.deepEqual(metaOf(-1).retry, { attempt: 1, max: 5 });
		end({ content: [{ type: "text", text: "重试后的回复" }] });
		listener({ type: "auto_retry_end", success: true, attempt: 1 });
		const retried = messages(conv.id).at(-2)!;
		assert.equal(retried.status, "error");
		assert.equal(JSON.parse(retried.meta).retried, true);
		assert.equal(JSON.parse(retried.meta).retry, null);
		assert.match(JSON.parse(retried.meta).error, /Connection error/, "保留原错误原文");
		assert.equal(messages(conv.id).at(-1)?.status, "done");
		listener({ type: "agent_settled" });
		// 重试最终失败：前面的尝试折叠，最后一条保持错误并记 retryFailed
		end({ stopReason: "error", errorMessage: "Connection error." });
		listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 1000, errorMessage: "Connection error." });
		end({ stopReason: "error", errorMessage: "Connection error." });
		listener({ type: "auto_retry_start", attempt: 2, maxAttempts: 2, delayMs: 1000, errorMessage: "Connection error." });
		end({ stopReason: "error", errorMessage: "Connection error." });
		listener({ type: "auto_retry_end", success: false, attempt: 2, finalError: "Connection error." });
		assert.equal(metaOf(-3).retried, true);
		assert.equal(metaOf(-2).retried, true);
		assert.equal(metaOf(-1).retryFailed, 2);
		assert.equal(metaOf(-1).retried, undefined);
		assert.equal(messages(conv.id).at(-1)?.status, "error");
	} finally { unbind(); }
});

test("后台任务模型额度失败不再误标done/空完成通知，直接在原对话留失败原因", async () => {
	mode = "quota";
	const conv = createConversation(AGENT, "后台失败"); conversations.push(conv.id);
	const before = requests;
	const task = tasks.spawn(AGENT, "额度失败探针", "请整理验证结果", { conversationId: conv.id });
	await until(() => ["failed", "done"].includes(getSubagent(task.id)?.status ?? ""));
	assert.equal(getSubagent(task.id)?.status, "failed");
	assert.match(getSubagent(task.id)?.error_reason ?? "", /usage limit/);
	assert.ok(!getSubagent(task.id)?.result_summary);
	const notice = db.prepare("SELECT content,meta FROM messages WHERE conversation_id = ? AND role = 'system' AND status = 'error'").all(conv.id) as { content: string; meta: string }[];
	assert.ok(notice.some((m) => /后台任务.*失败.*usage limit/.test(m.content)));
	const failure = JSON.parse(notice.at(-1)!.meta);
	assert.equal(failure.kind, "task-error");
	assert.equal(failure.taskTitle, "额度失败探针");
	assert.match(failure.error, /usage limit/);
	assert.equal(requests - before, 1, "报告额度耗尽不用另一个必定失败的推理轮");
});
