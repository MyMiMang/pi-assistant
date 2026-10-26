/**
 * codex 渠道（假 codex app-server，绝不调用真实 codex）：纯文字 / 思考 / 工具挂起与回填 / 插话 / 停止 /
 * 续用与重开 / MCP 名字禁用 / 进程崩溃 / 审批与提问一律拒绝 / 整理上下文的单次请求。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { normalizeContext, type AssistantMessage, type AssistantMessageEvent, type Message, type Model, type SimpleStreamOptions, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";
import { Type } from "../src/pi-adapter/index.ts";
import { CODEX_API, CODEX_PROVIDER, createCodexChannel } from "../src/pi-adapter/cli-models/codex.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "pia-codex-channel-"));
const argsFile = join(dataDir, "args.jsonl");
const logFile = join(dataDir, "log.jsonl");
const stateFile = join(dataDir, "state.json");
const scenarioFile = join(dataDir, "scenario");
const setScenario = (s: string) => writeFileSync(scenarioFile, s);
setScenario("text");
let fakeCommand: string | null = FAKE;
const channel = createCodexChannel({
	dataDir,
	command: () => fakeCommand,
	extraEnv: () => ({ FAKE_CODEX_SCENARIO_FILE: scenarioFile, FAKE_CODEX_ARGS_FILE: argsFile, FAKE_CODEX_LOG: logFile, FAKE_CODEX_STATE: stateFile }),
});
after(() => {
	channel.disposeAll();
	rmSync(dataDir, { recursive: true, force: true });
});

const model = (id = "gpt-6.1-sol"): Model<string> => ({ id, name: id, api: CODEX_API, provider: CODEX_PROVIDER, baseUrl: "codex://local", input: ["text", "image"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 258_400, maxTokens: 64_000 }) as Model<string>;
const echoTool = { name: "echo", description: "回显", parameters: Type.Object({ text: Type.String() }) };
const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const toolResult = (id: string, text: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text }], isError: false, timestamp: 1, ...extra });
const ctx = (messages: Message[], tools: Array<typeof echoTool> = [echoTool], systemPrompt = "你是小微") => normalizeContext({ systemPrompt, messages, tools });

interface Run {
	events: AssistantMessageEvent[];
	message: AssistantMessage;
}
async function run(context: ReturnType<typeof ctx>, options: SimpleStreamOptions = {}, m = model()): Promise<Run> {
	const stream = channel.streamSimple(m as never, context, { sessionId: "s1", ...options });
	const events: AssistantMessageEvent[] = [];
	for await (const e of stream) events.push(e);
	return { events, message: await stream.result() };
}
const textOf = (m: AssistantMessage) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
const types = (r: Run) => r.events.map((e) => e.type);
const callsOf = (m: AssistantMessage) => m.content.filter((b) => b.type === "toolCall");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 8000) {
	const t = Date.now();
	while (!cond()) {
		if (Date.now() - t > ms) throw new Error(`等待超时：${what}`);
		await sleep(10);
	}
}
const logLines = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : []);
const argLines = () => (existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
const noLeftovers = () => assert.equal(channel.liveCount(), 0);

test("纯文字一轮：start 在前、文字事件成对、恰好一个 done；用量取 last、cost 为 0", async () => {
	setScenario("text");
	const r = await run(ctx([user("你好")]), { sessionId: "text-1" });
	const t = types(r);
	assert.equal(t[0], "start");
	assert.equal(t.at(-1), "done", r.message.errorMessage ?? "");
	assert.equal(t.filter((x) => x === "done" || x === "error").length, 1);
	assert.equal(t.filter((x) => x === "text_start").length, t.filter((x) => x === "text_end").length);
	assert.equal(textOf(r.message), "你好，收到：你好");
	assert.equal(r.message.stopReason, "stop");
	// inputTokens 100 含缓存 3 + 写缓存 4 → 新输入 93
	assert.deepEqual({ input: r.message.usage.input, output: r.message.usage.output, cacheRead: r.message.usage.cacheRead, cacheWrite: r.message.usage.cacheWrite, total: r.message.usage.totalTokens }, { input: 93, output: 20, cacheRead: 3, cacheWrite: 4, total: 120 });
	assert.equal(r.message.usage.cost.total, 0);
	noLeftovers();
});

test("思考摘要进 thinking 块", async () => {
	setScenario("think");
	const r = await run(ctx([user("想想")]), { sessionId: "think-1" });
	assert.deepEqual(types(r).filter((t) => t.startsWith("thinking")), ["thinking_start", "thinking_delta", "thinking_end"]);
	assert.deepEqual(r.message.content.map((b) => b.type), ["thinking", "text"]);
});

test("一个工具：以 toolUse 结束、请求挂着 → Pi 回填 → 同一个线程接着答完", async () => {
	setScenario("one-tool");
	const first = await run(ctx([user("查一下")]), { sessionId: "tool-1" });
	assert.equal(first.message.stopReason, "toolUse");
	assert.equal(first.events.at(-1)?.type, "done");
	assert.equal(textOf(first.message), "我来调工具。");
	const calls = callsOf(first.message);
	assert.equal(calls.length, 1);
	assert.deepEqual({ name: calls[0].name, arguments: calls[0].arguments }, { name: "echo", arguments: { text: "hi" } });
	assert.ok(calls[0].id.startsWith("call_"), "id 沿用 Codex 的 callId");
	assert.equal(channel.liveCount(), 1);
	assert.equal(logLines().some((l) => "response" in l && l.result?.contentItems), false, "结果回来之前不回包");
	const second = await run(ctx([user("查一下"), first.message, toolResult(calls[0].id, "ECHO:hi")]), { sessionId: "tool-1" });
	assert.equal(textOf(second.message), "got:ECHO:hi");
	assert.equal(second.message.stopReason, "stop");
	const resp = logLines().filter((l) => "response" in l).at(-1)!;
	assert.deepEqual(resp.result, { success: true, contentItems: [{ type: "inputText", text: "ECHO:hi" }] });
	noLeftovers();
});

test("工具结果里的图片用 inputImage 回填；出错的结果 success=false", async () => {
	setScenario("image-tool");
	const first = await run(ctx([user("看图")]), { sessionId: "img-1" });
	const id = callsOf(first.message)[0].id;
	const second = await run(ctx([user("看图"), first.message, toolResult(id, "截图", { content: [{ type: "text", text: "截图" }, { type: "image", data: "QUJD", mimeType: "image/png" }], isError: true })]), { sessionId: "img-1" });
	assert.equal(textOf(second.message), "got:截图[img]");
	const resp = logLines().filter((l) => "response" in l).at(-1)!;
	assert.equal(resp.result.success, false);
	assert.deepEqual(resp.result.contentItems[1], { type: "inputImage", imageUrl: "data:image/png;base64,QUJD" });
});

test("插话：随结果一起，先 turn/steer 再回包", async () => {
	setScenario("steer");
	const first = await run(ctx([user("干活")]), { sessionId: "steer-1" });
	const id = callsOf(first.message)[0].id;
	const second = await run(ctx([user("干活"), first.message, toolResult(id, "R"), user("顺便说一句")]), { sessionId: "steer-1" });
	assert.equal(textOf(second.message), "got:R steered:顺便说一句");
	const seq = logLines().filter((l) => l.method === "turn/steer" || "response" in l).map((l) => l.method ?? "response");
	assert.deepEqual(seq.slice(-2), ["turn/steer", "response"]);
	noLeftovers();
});

test("停止（工具交回 Pi 期间）：turn/interrupt，挂着的请求回已取消，进行中表清空", async () => {
	setScenario("hang");
	const ac = new AbortController();
	const first = await run(ctx([user("等")]), { sessionId: "abort-2", signal: ac.signal });
	assert.equal(first.message.stopReason, "toolUse");
	assert.equal(channel.liveCount(), 1);
	ac.abort();
	await until(() => channel.liveCount() === 0, "进行中一轮被清掉");
	await until(() => logLines().some((l) => l.method === "turn/interrupt"), "发了 turn/interrupt");
});

test("停止（正在说话时）：以 aborted 结束，块配对", async () => {
	setScenario("text");
	const ac = new AbortController();
	const stream = channel.streamSimple(model() as never, ctx([user("说说说说说说")]), { sessionId: "abort-1", signal: ac.signal });
	const events: AssistantMessageEvent[] = [];
	let aborted = false;
	for await (const e of stream) {
		events.push(e);
		if (e.type === "text_delta" && !aborted) {
			aborted = true;
			ac.abort();
		}
	}
	const msg = await stream.result();
	assert.ok(msg.stopReason === "aborted" || msg.stopReason === "stop");
	assert.equal(events.filter((e) => e.type === "text_start").length, events.filter((e) => e.type === "text_end").length);
	await until(() => channel.liveCount() === 0, "清空");
});

test("signal 一开始就是中止的：直接 aborted，不起线程", async () => {
	const ac = new AbortController();
	ac.abort();
	const n = logLines().length;
	const r = await run(ctx([user("你好")]), { sessionId: "pre-abort", signal: ac.signal });
	assert.equal(r.message.stopReason, "aborted");
	assert.equal(logLines().length, n);
});

test("第二轮续用线程：只发新增用户内容；已加载的线程不重复 resume；参数正确", async () => {
	setScenario("meta");
	const first = await run(ctx([user("第一句")], [echoTool], "系统提示一"), { sessionId: "res-1", reasoning: "minimal" });
	const i1 = JSON.parse(textOf(first.message));
	assert.deepEqual({ resumed: i1.resumed, model: i1.model, effort: i1.effort, summary: i1.summary, instructions: i1.instructions, tools: i1.tools, ephemeral: i1.ephemeral, approvalPolicy: i1.approvalPolicy, sandbox: i1.sandbox }, { resumed: false, model: "gpt-6.1-sol", effort: "low", summary: "auto", instructions: "系统提示一", tools: ["echo"], ephemeral: false, approvalPolicy: "never", sandbox: "read-only" });
	const tid = channel.store.get("res-1")?.claudeSessionId;
	assert.equal(tid, i1.thread);
	const second = await run(ctx([user("第一句"), first.message, user("第二句")], [echoTool], "系统提示一"), { sessionId: "res-1", reasoning: "high" });
	const i2 = JSON.parse(textOf(second.message));
	assert.equal(i2.thread, tid, "续用同一个线程");
	assert.equal(i2.input, "第二句");
	assert.equal(i2.effort, "high");
	assert.equal(logLines().filter((l) => l.method === "thread/resume").length, 0, "同一进程里线程还在，不必 resume");
});

test("工具集或系统提示变了：开新线程，历史渲染成文字", async () => {
	setScenario("meta");
	const first = await run(ctx([user("一")], [echoTool], "提示A"), { sessionId: "chg-1" });
	const t1 = JSON.parse(textOf(first.message)).thread;
	const other = { name: "other", description: "别的", parameters: Type.Object({}) };
	const second = await run(ctx([user("一"), first.message, user("二")], [echoTool, other as never], "提示A"), { sessionId: "chg-1" });
	const i2 = JSON.parse(textOf(second.message));
	assert.notEqual(i2.thread, t1);
	assert.deepEqual(i2.tools, ["echo", "other"]);
	assert.match(i2.input, /用户：一[\s\S]*助理：[\s\S]*二/);
	const third = await run(ctx([user("一"), first.message, user("二"), second.message, user("三")], [echoTool, other as never], "提示B"), { sessionId: "chg-1" });
	const i3 = JSON.parse(textOf(third.message));
	assert.notEqual(i3.thread, i2.thread, "系统提示变了也开新线程");
	assert.equal(i3.instructions, "提示B");
});

test("整理过上下文 / 换过模型：新开线程", async () => {
	setScenario("meta");
	const first = await run(ctx([user("第一句")]), { sessionId: "fresh-1" });
	const compacted = await run(ctx([user("【摘要】之前聊了第一句"), user("第二句")]), { sessionId: "fresh-1" });
	const c = JSON.parse(textOf(compacted.message));
	assert.notEqual(c.thread, JSON.parse(textOf(first.message)).thread);
	assert.match(c.input, /之前聊了第一句[\s\S]*第二句/);
	const a = await run(ctx([user("你好")]), { sessionId: "fresh-2" });
	const sw = await run(ctx([user("你好"), a.message, user("换模型")]), { sessionId: "fresh-2" }, model("gpt-6-luna"));
	const s = JSON.parse(textOf(sw.message));
	assert.equal(s.model, "gpt-6-luna");
	assert.notEqual(s.thread, JSON.parse(textOf(a.message)).thread);
});

test("没有工具的单次请求（整理上下文）：ephemeral 线程、不带工具、不进对照表", async () => {
	setScenario("meta");
	const r = await run(ctx([user("请总结")], [], "你是总结助手"), { sessionId: "compact-1" });
	const i = JSON.parse(textOf(r.message));
	assert.equal(i.ephemeral, true);
	assert.deepEqual(i.tools, []);
	assert.equal(channel.store.get("compact-1"), undefined);
	await until(() => logLines().some((l) => l.method === "thread/unsubscribe"), "总结线程用完卸载");
});

test("进程崩溃：进行中的一轮以 error 结束；下次请求重启并 thread/resume", async () => {
	setScenario("meta");
	const first = await run(ctx([user("一")]), { sessionId: "crash-1" });
	const tid = JSON.parse(textOf(first.message)).thread;
	setScenario("crash");
	const crashed = await run(ctx([user("一"), first.message, user("二")]), { sessionId: "crash-1" });
	assert.equal(crashed.message.stopReason, "error");
	assert.match(crashed.message.errorMessage ?? "", /意外退出/);
	assert.equal(channel.store.get("crash-1"), undefined);
	// 线程是存在状态文件里的，换成另一个会话用它：先造一个能续用的对照项
	setScenario("meta");
	const again = await run(ctx([user("一"), first.message, user("三")]), { sessionId: "crash-1" });
	assert.equal(again.message.stopReason, "stop", again.message.errorMessage ?? "");
	assert.ok(JSON.parse(textOf(again.message)).thread);
	assert.ok(tid);
	// 正常结束后对照表在；重启 hub（进程没了）再来一轮，应当 thread/resume 同一线程
	const tid2 = channel.store.get("crash-1")!.claudeSessionId;
	channel.hub.stop();
	await until(() => !channel.hub.running, "进程退出");
	const n = logLines().filter((l) => l.method === "thread/resume").length;
	const resumed = await run(ctx([user("一"), first.message, user("三"), again.message, user("四")]), { sessionId: "crash-1" });
	const ri = JSON.parse(textOf(resumed.message));
	assert.equal(ri.thread, tid2);
	assert.equal(ri.resumed, true);
	assert.equal(logLines().filter((l) => l.method === "thread/resume").length, n + 1);
});

test("续用的线程 codex 找不到：自动改成新线程重来一次", async () => {
	setScenario("meta");
	const first = await run(ctx([user("一")]), { sessionId: "gone-1" });
	writeFileSync(stateFile, "{}"); // 把假 codex 的线程表清空
	channel.hub.stop();
	await until(() => !channel.hub.running, "进程退出");
	const second = await run(ctx([user("一"), first.message, user("二")]), { sessionId: "gone-1" });
	assert.equal(second.message.stopReason, "stop", second.message.errorMessage ?? "");
	assert.equal(second.events.filter((e) => e.type === "start").length, 1);
	assert.match(JSON.parse(textOf(second.message)).input, /用户：一/);
});

test("未登录 / 失败：中文说明带原文", async () => {
	setScenario("not-logged-in");
	const r = await run(ctx([user("你好")]), { sessionId: "login-1" });
	assert.equal(r.message.stopReason, "error");
	assert.match(r.message.errorMessage ?? "", /codex login/);
	assert.match(r.message.errorMessage ?? "", /Not logged in/);
	assert.equal(channel.store.get("login-1"), undefined);
	noLeftovers();
});

test("找不到 codex：中文错误，只有一个 error 事件", async () => {
	fakeCommand = null;
	channel.hub.stop();
	try {
		const r = await run(ctx([user("你好")]), { sessionId: "nocmd-1" });
		assert.equal(r.message.stopReason, "error");
		assert.match(r.message.errorMessage ?? "", /没有找到 codex 命令/);
		assert.equal(r.events.filter((e) => e.type === "error").length, 1);
	} finally {
		fakeCommand = FAKE;
	}
});

test("Codex 发来审批 / 提问请求：审批一律拒绝，提问回不可用", async () => {
	setScenario("server-requests");
	const r = await run(ctx([user("去删")]), { sessionId: "req-1" });
	assert.match(textOf(r.message), /approval:\{"decision":"decline"\}/);
	assert.match(textOf(r.message), /input:\{"error":\{"code":-32000/);
});

test("用户配置里有 MCP：先探测名字，再带 enabled=false 重启；名字只探测一次", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-codex-mcp-"));
	const args = join(dir, "args.jsonl");
	const ch = createCodexChannel({ dataDir: dir, command: () => FAKE, extraEnv: () => ({ FAKE_CODEX_MCP: "node_repl,my.server", FAKE_CODEX_ARGS_FILE: args }) });
	const lines = () => (existsSync(args) ? readFileSync(args, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
	const msgs = (id: string) => [user("你好")].map((m) => m) && ctx([user(id)]);
	try {
		const stream = ch.streamSimple(model() as never, msgs("你好"), { sessionId: "mcp-1" });
		for await (const _ of stream);
		const started = lines();
		assert.equal(started.length, 2, "探测进程 + 带禁用参数的正式进程");
		assert.equal(started[0].some((a) => a.startsWith("mcp_servers.")), false);
		assert.ok(started[1].includes("mcp_servers.node_repl.enabled=false"));
		assert.ok(started[1].includes('mcp_servers."my.server".enabled=false'), "带点的名字要加引号");
		assert.deepEqual(ch.hub.disabledMcpNames, ["node_repl", "my.server"]);
		for (const f of ["shell_tool", "plugins", "multi_agent"]) assert.ok(started[1].includes(f));
		ch.hub.stop();
		await until(() => !ch.hub.running, "进程退出");
		for await (const _ of ch.streamSimple(model() as never, msgs("再来"), { sessionId: "mcp-2" }));
		assert.equal(lines().length, 3, "之后重启直接带禁用参数，不再探测");
		assert.ok(lines()[2].includes("mcp_servers.node_repl.enabled=false"));
	} finally {
		ch.disposeAll();
		rmSync(dir, { recursive: true, force: true });
	}
});
