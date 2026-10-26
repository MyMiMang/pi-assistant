/**
 * antigravity 渠道（假 agy，绝不调用真实 agy）：纯文字 / 工具挂起与回填 / 并行工具 / 插话附加 / 停止 /
 * 长驻进程跨轮复用 / 模型与思考强度映射 / 系统提示变了重开 / 空闲退出后 --conversation 续用 / 续用失败改新开 / 单次请求 / 报错 / 运行目录不残留。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { normalizeContext, type AssistantMessage, type AssistantMessageEvent, type Message, type Model, type SimpleStreamOptions, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";
import { parseAgyModels } from "../src/cli-agents/agy-models.ts";
import { Type } from "../src/pi-adapter/index.ts";
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER, createAntigravityChannel, describeAgyError } from "../src/pi-adapter/cli-models/antigravity.ts";
import type { Env } from "../src/routes/common.ts";
import { mountToolBridgeRoutes } from "../src/routes/tool-bridge.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-agy.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "pia-agy-channel-"));
const runsRoot = join(dataDir, "cli-models", "agy-runs");
const logFile = join(dataDir, "log.jsonl");
const scenarioFile = join(dataDir, "scenario");
const setScenario = (s: string) => writeFileSync(scenarioFile, s);
setScenario("text");
const families = parseAgyModels(["claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)", "claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)", "claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)"].join("\n"));
let fakeCommand: string | null = FAKE;
let baseUrl = "";
let server: ReturnType<typeof serve>;
let channel: ReturnType<typeof createAntigravityChannel>;
const extraEnv = () => ({ FAKE_AGY_SCENARIO_FILE: scenarioFile, FAKE_AGY_LOG: logFile });
before(async () => {
	const app = new Hono<Env>();
	mountToolBridgeRoutes(app);
	server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((r) => server.once("listening", () => r()));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	channel = createAntigravityChannel({ dataDir, bridgeBaseUrl: () => baseUrl, command: () => fakeCommand, extraEnv, families, collectMs: 120 });
});
after(() => {
	channel.disposeAll();
	(server as unknown as import("node:http").Server).closeAllConnections();
	server.close();
	rmSync(dataDir, { recursive: true, force: true });
});

const model = (id = "claude-sonnet-5-5"): Model<string> => ({ id, name: id, api: ANTIGRAVITY_API, provider: ANTIGRAVITY_PROVIDER, baseUrl: "antigravity://local", input: ["text"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 }) as Model<string>;
const echoTool = { name: "echo", description: "回显", parameters: Type.Object({ text: Type.String() }) };
const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const toolResult = (id: string, text: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text }], isError: false, timestamp: 1 });
const ctx = (messages: Message[], tools: Array<typeof echoTool> = [echoTool], systemPrompt = "你是小微") => normalizeContext({ systemPrompt, messages, tools });

interface Run {
	events: AssistantMessageEvent[];
	message: AssistantMessage;
}
async function run(context: ReturnType<typeof ctx>, options: SimpleStreamOptions = {}, m = model(), ch = channel): Promise<Run> {
	const stream = ch.streamSimple(m as never, context, { sessionId: "s1", ...options });
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
/** 每次启动 agy 记一行 */
const launches = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { pid: number; argv: string[]; conversation: string | null; model: string }) : []);
const noLeftovers = () => assert.equal(channel.liveCount(), 0);

test("纯文字一轮：start 在前、文字事件成对、恰好一个 done；用量按 agent_response 步骤、cost 为 0", async () => {
	setScenario("text");
	const r = await run(ctx([user("你好")]), { sessionId: "text-1" });
	const t = types(r);
	assert.equal(t[0], "start");
	assert.equal(t.at(-1), "done", r.message.errorMessage ?? "");
	assert.equal(t.filter((x) => x === "done" || x === "error").length, 1);
	assert.equal(t.filter((x) => x === "text_start").length, t.filter((x) => x === "text_end").length);
	assert.ok(!t.some((x) => x.startsWith("thinking")), "没有思考块");
	assert.equal(textOf(r.message), "你好，收到：你好");
	assert.equal(r.message.stopReason, "stop");
	assert.deepEqual({ input: r.message.usage.input, output: r.message.usage.output, cacheRead: r.message.usage.cacheRead, total: r.message.usage.totalTokens }, { input: 100, output: 20, cacheRead: 30, total: 150 });
	assert.equal(r.message.usage.cost.total, 0);
	assert.ok(channel.store.get("text-1")?.claudeSessionId.startsWith("fake-conv-"), "对照表记下 agy 的会话 id");
	noLeftovers();
});

test("一个工具：以 toolUse 结束、调用挂着 → Pi 回填 → 同一个进程接着答完；整轮只起一个进程", async () => {
	setScenario("one-tool");
	const n = launches().length;
	const first = await run(ctx([user("查一下")]), { sessionId: "tool-1" });
	assert.equal(first.message.stopReason, "toolUse");
	assert.equal(first.events.at(-1)?.type, "done");
	assert.equal(textOf(first.message), "我来查一下。");
	const calls = callsOf(first.message);
	assert.equal(calls.length, 1);
	assert.deepEqual({ name: calls[0].name, arguments: calls[0].arguments }, { name: "echo", arguments: { text: "hi" } });
	assert.match(calls[0].id, /^agy-[^-]+-\d+$|^agy-.+-\d+$/);
	assert.equal(channel.liveCount(), 1);
	const second = await run(ctx([user("查一下"), first.message, toolResult(calls[0].id, "ECHO:hi")]), { sessionId: "tool-1" });
	assert.equal(textOf(second.message), "got:ECHO:hi");
	assert.equal(second.message.stopReason, "stop");
	assert.equal(launches().length, n + 1);
	noLeftovers();
});

test("并行两个工具：一段里两个 toolCall，两个结果按各自的配对键回填", async () => {
	setScenario("two-tools");
	const first = await run(ctx([user("同时查")]), { sessionId: "par-1" });
	assert.equal(first.message.stopReason, "toolUse");
	const calls = callsOf(first.message);
	assert.deepEqual(calls.map((c) => c.arguments), [{ text: "A" }, { text: "B" }]);
	assert.notEqual(calls[0].id, calls[1].id);
	const second = await run(ctx([user("同时查"), first.message, toolResult(calls[1].id, "RB"), toolResult(calls[0].id, "RA")]), { sessionId: "par-1" });
	assert.equal(textOf(second.message), "got:RA|RB");
	noLeftovers();
});

test("插话：有挂起的工具时附在工具结果文字后面", async () => {
	setScenario("one-tool");
	const first = await run(ctx([user("干活")]), { sessionId: "steer-1" });
	const id = callsOf(first.message)[0].id;
	const second = await run(ctx([user("干活"), first.message, toolResult(id, "R"), user("顺便说一句")]), { sessionId: "steer-1" });
	assert.equal(textOf(second.message), "got:R\n\n[用户插话] 顺便说一句");
	noLeftovers();
});

test("停止（工具交回 Pi 期间）：SIGINT 结束进程，进行中表清空，运行目录删掉", async () => {
	setScenario("hang");
	const ac = new AbortController();
	const had = new Set(readdirSync(runsRoot)); // 前面的用例还有空闲进程，只看这一个的目录
	const first = await run(ctx([user("等")]), { sessionId: "abort-2", signal: ac.signal });
	assert.equal(first.message.stopReason, "toolUse");
	assert.equal(channel.liveCount(), 1);
	const mine = readdirSync(runsRoot).filter((d) => !had.has(d));
	assert.equal(mine.length, 1);
	ac.abort();
	await until(() => channel.liveCount() === 0, "进行中一轮被清掉");
	await until(() => !existsSync(join(runsRoot, mine[0])), "运行目录删掉");
	assert.equal(channel.store.get("abort-2"), undefined);
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

test("signal 一开始就是中止的：直接 aborted，不起进程", async () => {
	const ac = new AbortController();
	ac.abort();
	const n = launches().length;
	const r = await run(ctx([user("你好")]), { sessionId: "pre-abort", signal: ac.signal });
	assert.equal(r.message.stopReason, "aborted");
	assert.equal(launches().length, n);
});

test("第二轮复用同一个长驻进程：只发新增内容；模型家族 + 思考强度拼成完整 id；强度变了换进程但续用同一会话", async () => {
	setScenario("meta");
	const n = launches().length;
	const first = await run(ctx([user("第一句")]), { sessionId: "res-1", reasoning: "medium" });
	const i1 = JSON.parse(textOf(first.message));
	assert.deepEqual({ conversation: i1.conversation, first: i1.first, model: i1.model, agent: i1.agent, seq: i1.seq, tools: i1.tools, alwaysLoad: i1.alwaysLoad }, { conversation: null, first: "第一句", model: "claude-sonnet-5-5-medium", agent: "pia", seq: 1, tools: ["echo"], alwaysLoad: true });
	const conv = channel.store.get("res-1")!.claudeSessionId;
	const second = await run(ctx([user("第一句"), first.message, user("第二句")]), { sessionId: "res-1", reasoning: "medium" });
	const i2 = JSON.parse(textOf(second.message));
	assert.equal(i2.first, "第二句", "只发新增的用户内容");
	assert.equal(i2.seq, 2, "同一个进程里的第二轮");
	assert.equal(launches().length, n + 1, "没有再起进程");
	// xhigh → high：模型 id 变了，换进程，但用 --conversation 续用同一个会话
	const third = await run(ctx([user("第一句"), first.message, user("第二句"), second.message, user("第三句")]), { sessionId: "res-1", reasoning: "xhigh" });
	const i3 = JSON.parse(textOf(third.message));
	assert.equal(i3.model, "claude-sonnet-5-5-high");
	assert.equal(i3.conversation, conv, "续用同一个会话");
	assert.equal(i3.first, "第三句");
	assert.equal(launches().length, n + 2);
	noLeftovers();
});

test("系统提示或工具集变了：新进程新会话，历史渲染成文字", async () => {
	setScenario("meta");
	const first = await run(ctx([user("一")], [echoTool], "提示A"), { sessionId: "chg-1" });
	const c1 = channel.store.get("chg-1")!.claudeSessionId;
	const second = await run(ctx([user("一"), first.message, user("二")], [echoTool], "提示B"), { sessionId: "chg-1" });
	const i2 = JSON.parse(textOf(second.message));
	assert.equal(i2.conversation, null, "新会话");
	assert.notEqual(channel.store.get("chg-1")!.claudeSessionId, c1);
	assert.match(i2.first, /用户：一[\s\S]*助理：[\s\S]*二/);
	const other = { name: "other", description: "别的", parameters: Type.Object({}) };
	const third = await run(ctx([user("一"), first.message, user("二"), second.message, user("三")], [echoTool, other as never], "提示B"), { sessionId: "chg-1" });
	const i3 = JSON.parse(textOf(third.message));
	assert.deepEqual(i3.tools, ["echo", "other"]);
	assert.equal(i3.conversation, null);
});

test("整理过上下文 / 换过模型：新开会话", async () => {
	setScenario("meta");
	const first = await run(ctx([user("第一句")]), { sessionId: "fresh-1" });
	const compacted = await run(ctx([user("【摘要】之前聊了第一句"), user("第二句")]), { sessionId: "fresh-1" });
	const c = JSON.parse(textOf(compacted.message));
	assert.equal(c.conversation, null);
	assert.match(c.first, /之前聊了第一句[\s\S]*第二句/);
	const a = await run(ctx([user("你好")]), { sessionId: "fresh-2" });
	const sw = await run(ctx([user("你好"), a.message, user("换模型")]), { sessionId: "fresh-2" }, model("gpt-oss-120b"));
	const s = JSON.parse(textOf(sw.message));
	assert.equal(s.model, "gpt-oss-120b", "不认识的家族原样当完整 id");
	assert.equal(s.conversation, null);
	assert.ok(first);
});

test("没有工具的单次请求（整理上下文）：不进对照表，用完就关进程", async () => {
	setScenario("meta");
	const r = await run(ctx([user("请总结")], [], "你是总结助手"), { sessionId: "compact-1" });
	const i = JSON.parse(textOf(r.message));
	assert.deepEqual(i.tools, []);
	assert.equal(channel.store.get("compact-1"), undefined);
	await until(() => readdirSync(runsRoot).length === 0 || channel.liveCount() === 0, "单次进程收尾");
});

test("空闲退出后下一轮用 --conversation 续用；续用的会话 agy 找不到：自动改成新开会话", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-agy-idle-"));
	const log = join(dir, "log.jsonl");
	const ch = createAntigravityChannel({ dataDir: dir, bridgeBaseUrl: () => baseUrl, command: () => FAKE, extraEnv: () => ({ FAKE_AGY_SCENARIO_FILE: scenarioFile, FAKE_AGY_LOG: log }), families, idleMs: 150 });
	const lines = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { conversation: string | null; pid: number });
	try {
		setScenario("meta");
		const first = await run(ctx([user("一")]), { sessionId: "idle-1" }, model(), ch);
		const conv = ch.store.get("idle-1")!.claudeSessionId;
		await until(() => readdirSync(join(dir, "cli-models", "agy-runs")).length === 0, "空闲进程退出", 5000);
		const second = await run(ctx([user("一"), first.message, user("二")]), { sessionId: "idle-1" }, model(), ch);
		const i2 = JSON.parse(textOf(second.message));
		assert.equal(i2.conversation, conv, "用 --conversation 续用");
		assert.equal(i2.first, "二");
		assert.equal(lines().length, 2);
		// 续用失败：进程带 --conversation 起来就退出（agy 找不到会话），改成新开
		await until(() => readdirSync(join(dir, "cli-models", "agy-runs")).length === 0, "空闲进程退出", 5000);
		setScenario("resume-missing");
		const third = await run(ctx([user("一"), first.message, user("二"), second.message, user("三")]), { sessionId: "idle-1" }, model(), ch);
		assert.equal(third.message.stopReason, "stop", third.message.errorMessage ?? "");
		assert.equal(third.events.filter((e) => e.type === "start").length, 1);
		assert.match(textOf(third.message), /用户：一/);
		assert.equal(lines().at(-1)!.conversation, null, "最后一次是新开的会话");
	} finally {
		ch.disposeAll();
		rmSync(dir, { recursive: true, force: true });
		setScenario("text");
	}
});

test("agy 报错：中文说明带原文；登录问题提示 agy；地区限制单独提示；进程不留", async () => {
	setScenario("error");
	const r = await run(ctx([user("你好")]), { sessionId: "err-1" });
	assert.equal(r.message.stopReason, "error");
	assert.match(r.message.errorMessage ?? "", /Antigravity 出错：模型出错了/);
	assert.equal(channel.store.get("err-1"), undefined);
	setScenario("not-logged-in");
	const login = await run(ctx([user("你好")]), { sessionId: "err-2" });
	assert.equal(login.message.stopReason, "error");
	assert.match(login.message.errorMessage ?? "", /本机 Antigravity 未登录，请在终端运行 agy/);
	assert.match(login.message.errorMessage ?? "", /sign in/);
	assert.match(describeAgyError("FAILED_PRECONDITION: User location is not supported for the API use."), /Gemini 模型在部分地区不可用/);
	noLeftovers();
});

test("进程崩溃：以 error 结束，带 stderr；找不到 agy：中文错误、只有一个 error 事件", async () => {
	setScenario("crash");
	const crashed = await run(ctx([user("一")]), { sessionId: "crash-1" });
	assert.equal(crashed.message.stopReason, "error");
	assert.match(crashed.message.errorMessage ?? "", /意外退出.*AGY_ERROR: boom/);
	fakeCommand = null;
	try {
		const r = await run(ctx([user("你好")]), { sessionId: "nocmd-1" });
		assert.equal(r.message.stopReason, "error");
		assert.match(r.message.errorMessage ?? "", /没有找到 agy 命令/);
		assert.equal(r.events.filter((e) => e.type === "error").length, 1);
	} finally {
		fakeCommand = FAKE;
		setScenario("text");
	}
});

test("关闭渠道：所有长驻进程结束，运行目录一个不剩", async () => {
	setScenario("text");
	await run(ctx([user("留一个空闲进程")]), { sessionId: "dispose-1" });
	assert.ok(readdirSync(runsRoot).length >= 1, "空闲进程还在，运行目录在");
	channel.disposeAll();
	await until(() => readdirSync(runsRoot).length === 0, "运行目录全删");
});
