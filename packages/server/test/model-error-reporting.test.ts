/** 服务失败 → 真实Pi → runtime落库；临时根/内存凭据/loopback，不读用户账户或请求付费服务。 */
import "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { createConversation } from "../src/conversations.ts";
import { db, now, setSetting } from "../src/db.ts";
import { initModels, models } from "../src/models.ts";
import { lastAssistantError, modelErrorMessage, subscribeSession, type AgentEvent, type AgentSession } from "../src/pi-adapter/index.ts";
import { bindSession, disposeConversationRuntime, getTask, runtime, tasks } from "../src/runtime.ts";
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
	assert.equal(adapterEvents({ stopReason: "toolUse", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }] }).hasToolCalls, true);
	assert.match(adapterEvents({ stopReason: "stop", errorMessage: "insufficient_quota" }).error!, /insufficient_quota/);
	assert.equal(lastAssistantError({ messages: [{ role: "assistant", content: [], stopReason: "stop" }] } as never), "这次未收到回复，服务未提供具体原因");
	assert.equal(lastAssistantError({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "已思考" }], stopReason: "stop" }] } as never), undefined);
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

test("后台任务模型额度失败不再误标done/空完成通知，直接在原对话留失败原因", async () => {
	mode = "quota";
	const conv = createConversation(AGENT, "后台失败"); conversations.push(conv.id);
	const before = requests;
	const task = tasks.spawn(AGENT, "额度失败探针", "请整理验证结果", { conversationId: conv.id });
	await until(() => ["failed", "done"].includes(getTask(task.id)?.status ?? ""));
	assert.equal(getTask(task.id)?.status, "failed");
	assert.match(getTask(task.id)?.error ?? "", /usage limit/);
	assert.equal(getTask(task.id)?.result, null);
	const notice = db.prepare("SELECT content,meta FROM messages WHERE conversation_id = ? AND role = 'system' AND status = 'error'").all(conv.id) as { content: string; meta: string }[];
	assert.ok(notice.some((m) => /后台任务.*失败.*usage limit/.test(m.content)));
	const failure = JSON.parse(notice.at(-1)!.meta);
	assert.equal(failure.kind, "task-error");
	assert.equal(failure.taskTitle, "额度失败探针");
	assert.match(failure.error, /usage limit/);
	assert.equal(requests - before, 1, "报告额度耗尽不用另一个必定失败的推理轮");
});
