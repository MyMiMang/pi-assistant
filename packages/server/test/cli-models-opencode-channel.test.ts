/**
 * opencode 渠道 = 通用 ACP 后端（假 opencode，绝不调用真实 opencode）：纯文字 + 思考 / 用量（只有最后一次调用）/ 工具挂起与回填 /
 * 并行工具（桥收到的调用为准，ACP 通知晚到也能收齐）/ 插话附加 / 停止 / 长驻进程跨轮复用 / 模型与思考强度会话级切换 / 系统提示变了重开 /
 * 空闲退出后 session/resume 续用 / 续用失败改新开 / 单次请求 / 权限请求 / 报错 / 配置文件与环境 / 运行目录不残留。
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
import { Type } from "../src/pi-adapter/index.ts";
import { OPENCODE_API, OPENCODE_PROVIDER, createOpencodeChannel } from "../src/pi-adapter/cli-models/opencode.ts";
import type { Env } from "../src/routes/common.ts";
import { mountToolBridgeRoutes } from "../src/routes/tool-bridge.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-opencode.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "pia-oc-channel-"));
const runsRoot = join(dataDir, "cli-models", "opencode-runs");
const logFile = join(dataDir, "log.jsonl");
const scenarioFile = join(dataDir, "scenario");
const setScenario = (s: string) => writeFileSync(scenarioFile, s);
setScenario("text");
let fakeCommand: string | null = FAKE;
let baseUrl = "";
let server: ReturnType<typeof serve>;
let channel: ReturnType<typeof createOpencodeChannel>;
const extraEnv = () => ({ FAKE_OPENCODE_SCENARIO_FILE: scenarioFile, FAKE_OPENCODE_LOG: logFile });
before(async () => {
	const app = new Hono<Env>();
	mountToolBridgeRoutes(app);
	server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((r) => server.once("listening", () => r()));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	channel = createOpencodeChannel({ dataDir, bridgeBaseUrl: () => baseUrl, command: () => fakeCommand, extraEnv, collectMs: 400, settleMs: 40 });
});
after(() => {
	channel.disposeAll();
	(server as unknown as import("node:http").Server).closeAllConnections();
	server.close();
	rmSync(dataDir, { recursive: true, force: true });
});

const model = (id = "opencode/beam-free"): Model<string> => ({ id, name: id, api: OPENCODE_API, provider: OPENCODE_PROVIDER, baseUrl: "opencode://local", input: ["text", "image"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000 }) as Model<string>;
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
/** 每次启动 acp 记一行 */
const launches = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { pid: number; argv: string[]; cwd: string; configPath: string; prompt: string }) : []);
const noLeftovers = () => assert.equal(channel.liveCount(), 0);

test("纯文字一轮：先思考再文字、块成对、恰好一个 done；用量取回包里最后一次调用的、思考算进输出、cost 为 0", async () => {
	setScenario("text");
	const r = await run(ctx([user("你好")]), { sessionId: "text-1" });
	const t = types(r);
	assert.equal(t[0], "start");
	assert.equal(t.at(-1), "done", r.message.errorMessage ?? "");
	assert.equal(t.filter((x) => x === "done" || x === "error").length, 1);
	assert.equal(t.filter((x) => x === "text_start").length, t.filter((x) => x === "text_end").length);
	assert.equal(t.filter((x) => x === "thinking_start").length, 1);
	assert.ok(t.indexOf("thinking_end") < t.indexOf("text_start"), "文字开始前思考块已关");
	assert.deepEqual(r.message.content.map((b) => b.type), ["thinking", "text"]);
	assert.equal(textOf(r.message), "你好，收到：你好");
	assert.equal(r.message.stopReason, "stop");
	assert.deepEqual({ input: r.message.usage.input, output: r.message.usage.output, cacheRead: r.message.usage.cacheRead, total: r.message.usage.totalTokens }, { input: 100, output: 25, cacheRead: 30, total: 155 });
	assert.equal(r.message.usage.cost.total, 0);
	assert.ok(channel.store.get("text-1")?.claudeSessionId.startsWith("ses_fake_"), "对照表记下会话 id");
	noLeftovers();
});

test("一个工具：以 toolUse 结束、调用挂着 → Pi 回填 → 同一个进程接着答完；整轮只起一个进程；中间段没有用量、最后一段有", async () => {
	setScenario("one-tool");
	const n = launches().length;
	const first = await run(ctx([user("查一下")]), { sessionId: "tool-1" });
	assert.equal(first.message.stopReason, "toolUse");
	assert.equal(first.events.at(-1)?.type, "done");
	assert.equal(textOf(first.message), "我来查一下。");
	assert.equal(first.message.usage.totalTokens, 0, "被工具打断的段拿不到用量（ACP 只在回包里给最后一次调用的）");
	const calls = callsOf(first.message);
	assert.equal(calls.length, 1);
	assert.deepEqual({ name: calls[0].name, arguments: calls[0].arguments }, { name: "echo", arguments: { text: "hi" } });
	assert.match(calls[0].id, /^acp-[0-9a-f]{6}-rpc-\d+$/);
	assert.equal(channel.liveCount(), 1);
	const second = await run(ctx([user("查一下"), first.message, toolResult(calls[0].id, "ECHO:hi")]), { sessionId: "tool-1" });
	assert.equal(textOf(second.message), "got:ECHO:hi");
	assert.equal(second.message.stopReason, "stop");
	assert.equal(second.message.usage.totalTokens, 155);
	assert.equal(launches().length, n + 1);
	noLeftovers();
});

test("并行两个工具：桥收到的调用为准（和 ACP 通知顺序相反也各回各的）", async () => {
	setScenario("two-tools");
	const first = await run(ctx([user("同时查")]), { sessionId: "par-1" });
	assert.equal(first.message.stopReason, "toolUse");
	const calls = callsOf(first.message);
	assert.deepEqual(calls.map((c) => c.arguments).sort((a, b) => String(a.text).localeCompare(String(b.text))), [{ text: "A" }, { text: "B" }]);
	assert.notEqual(calls[0].id, calls[1].id);
	const byText = (t: string) => calls.find((c) => (c.arguments as { text: string }).text === t)!;
	const second = await run(ctx([user("同时查"), first.message, toolResult(byText("B").id, "RB"), toolResult(byText("A").id, "RA")]), { sessionId: "par-1" });
	assert.equal(textOf(second.message), "got:RA|RB", "每个结果回给了自己的调用");
	noLeftovers();
});

test("并行第二个调用晚到（超过安静窗口）：ACP 已报告两个工具，等够了再收齐", async () => {
	setScenario("two-tools-late");
	const first = await run(ctx([user("同时查")]), { sessionId: "par-2" });
	assert.equal(callsOf(first.message).length, 2, "两个调用在同一段里");
	const calls = callsOf(first.message);
	const second = await run(ctx([user("同时查"), first.message, toolResult(calls[0].id, "R1"), toolResult(calls[1].id, "R2")]), { sessionId: "par-2" });
	assert.equal(second.message.stopReason, "stop");
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

test("停止（工具交回 Pi 期间）：session/cancel 后进程退出，进行中表清空，运行目录删掉", async () => {
	setScenario("hang");
	const ac = new AbortController();
	const had = new Set(existsSync(runsRoot) ? readdirSync(runsRoot) : []);
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

test("停止（正在说话时）：以 aborted 结束，块配对，进程结束", async () => {
	setScenario("hang-text");
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
	assert.equal(msg.stopReason, "aborted");
	assert.equal(events.filter((e) => e.type === "text_start").length, events.filter((e) => e.type === "text_end").length);
	await until(() => channel.liveCount() === 0, "清空");
	setScenario("text");
});

test("signal 一开始就是中止的：直接 aborted，不起进程", async () => {
	const ac = new AbortController();
	ac.abort();
	const n = launches().length;
	const r = await run(ctx([user("你好")]), { sessionId: "pre-abort", signal: ac.signal });
	assert.equal(r.message.stopReason, "aborted");
	assert.equal(launches().length, n);
});

test("第二轮复用同一个长驻进程：只发新增内容；模型和思考强度会话级切换（不重开）；图片作为 image 块", async () => {
	setScenario("meta");
	const n = launches().length;
	const first = await run(ctx([user("第一句")]), { sessionId: "res-1", reasoning: "high" }, model("opencode-go/deepseek-v4.1-flash"));
	const i1 = JSON.parse(textOf(first.message));
	assert.deepEqual({ first: i1.first, model: i1.model, effort: i1.effort, seq: i1.seq, tools: i1.tools, cwd: i1.cwd.endsWith("opencode-work") || i1.cwd.includes("opencode-work") }, { first: "第一句", model: "opencode-go/deepseek-v4.1-flash", effort: "high", seq: 1, tools: ["echo"], cwd: true });
	assert.deepEqual(i1.mcp, { type: "http", name: "pia", urlPath: i1.mcp.urlPath, headerNames: ["Authorization"], bearer: true });
	assert.match(i1.mcp.urlPath, /^\/internal\/tool-bridge\/<run>$/);
	assert.deepEqual(i1.argv.slice(0, 2), ["acp", "--cwd"]);
	const second = await run(ctx([user("第一句"), first.message, user("第二句")]), { sessionId: "res-1", reasoning: "high" }, model("opencode-go/deepseek-v4.1-flash"));
	const i2 = JSON.parse(textOf(second.message));
	assert.equal(i2.first, "第二句", "只发新增的用户内容");
	assert.equal(i2.seq, 2, "同一个进程里的第二轮");
	assert.equal(i2.sessionId, i1.sessionId);
	assert.equal(launches().length, n + 1, "没有再起进程");
	// 换模型 + 不指定思考强度（回到 default）+ 带图片：还是同一个进程同一个会话
	const img = user([{ type: "text", text: "看图" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
	const third = await run(ctx([user("第一句"), first.message, user("第二句"), second.message, img]), { sessionId: "res-1" }, model("opencode/claude-fable-5"));
	const i3 = JSON.parse(textOf(third.message));
	assert.equal(i3.model, "opencode/claude-fable-5");
	assert.equal(i3.effort, "default");
	assert.equal(i3.sessionId, i1.sessionId, "同一个会话");
	assert.deepEqual(i3.blocks, ["text", "image"]);
	assert.equal(launches().length, n + 1);
	noLeftovers();
});

test("系统提示或工具集变了：新进程新会话，历史渲染成文字；配置文件里是新的系统提示", async () => {
	setScenario("meta");
	const n = launches().length;
	const first = await run(ctx([user("一")], [echoTool], "提示A"), { sessionId: "chg-1" });
	const c1 = channel.store.get("chg-1")!.claudeSessionId;
	const second = await run(ctx([user("一"), first.message, user("二")], [echoTool], "提示B"), { sessionId: "chg-1" });
	const i2 = JSON.parse(textOf(second.message));
	assert.notEqual(i2.sessionId, c1, "新会话");
	assert.match(i2.first, /用户：一[\s\S]*助理：[\s\S]*二/);
	const ls = launches().slice(n);
	assert.deepEqual(ls.map((l) => l.prompt), ["提示A", "提示B"]);
	const other = { name: "other", description: "别的", parameters: Type.Object({}) };
	const third = await run(ctx([user("一"), first.message, user("二"), second.message, user("三")], [echoTool, other as never], "提示B"), { sessionId: "chg-1" });
	assert.deepEqual(JSON.parse(textOf(third.message)).tools, ["echo", "other"]);
});

test("没有工具的单次请求（整理上下文）：不进对照表，用完就关进程", async () => {
	setScenario("meta");
	const r = await run(ctx([user("请总结")], [], "你是总结助手"), { sessionId: "compact-1" });
	assert.deepEqual(JSON.parse(textOf(r.message)).tools, []);
	assert.equal(channel.store.get("compact-1"), undefined);
	await until(() => channel.liveCount() === 0, "单次进程收尾");
});

test("空闲退出后下一轮用 session/resume 续用；续用的会话找不到：自动改成新开会话", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-oc-idle-"));
	const log = join(dir, "log.jsonl");
	const ch = createOpencodeChannel({ dataDir: dir, bridgeBaseUrl: () => baseUrl, command: () => FAKE, extraEnv: () => ({ FAKE_OPENCODE_SCENARIO_FILE: scenarioFile, FAKE_OPENCODE_LOG: log }), idleMs: 150 });
	const lines = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pid: number });
	const runs = join(dir, "cli-models", "opencode-runs");
	try {
		setScenario("meta");
		const first = await run(ctx([user("一")]), { sessionId: "idle-1" }, model(), ch);
		const sid = ch.store.get("idle-1")!.claudeSessionId;
		await until(() => readdirSync(runs).length === 0, "空闲进程退出", 5000);
		const second = await run(ctx([user("一"), first.message, user("二")]), { sessionId: "idle-1" }, model(), ch);
		const i2 = JSON.parse(textOf(second.message));
		assert.equal(i2.sessionId, sid, "用 session/resume 续用同一个会话");
		assert.equal(i2.first, "二");
		assert.equal(lines().length, 2);
		await until(() => readdirSync(runs).length === 0, "空闲进程退出", 5000);
		setScenario("resume-missing");
		const third = await run(ctx([user("一"), first.message, user("二"), second.message, user("三")]), { sessionId: "idle-1" }, model(), ch);
		assert.equal(third.message.stopReason, "stop", third.message.errorMessage ?? "");
		assert.equal(third.events.filter((e) => e.type === "start").length, 1);
		assert.match(textOf(third.message), /用户：一/);
		assert.notEqual(JSON.parse(textOf(third.message)).sessionId, sid, "新开的会话");
	} finally {
		ch.disposeAll();
		rmSync(dir, { recursive: true, force: true });
		setScenario("text");
	}
});

test("命令行的权限请求一律回「允许一次」", async () => {
	setScenario("permission");
	const r = await run(ctx([user("你好")]), { sessionId: "perm-1" });
	assert.equal(textOf(r.message), 'permission:{"outcome":{"outcome":"selected","optionId":"once"}}');
	setScenario("text");
});

test("报错：中文说明带原文；登录问题提示 opencode auth login；切不了模型也是错误；进程不留", async () => {
	setScenario("error");
	const r = await run(ctx([user("你好")]), { sessionId: "err-1" });
	assert.equal(r.message.stopReason, "error");
	assert.match(r.message.errorMessage ?? "", /OpenCode 出错：.*模型出错了/);
	assert.equal(channel.store.get("err-1"), undefined);
	setScenario("not-logged-in");
	const login = await run(ctx([user("你好")]), { sessionId: "err-2" });
	assert.equal(login.message.stopReason, "error");
	assert.match(login.message.errorMessage ?? "", /本机 OpenCode 未登录，请在终端运行 opencode auth login/);
	assert.match(login.message.errorMessage ?? "", /Authentication failed/);
	setScenario("text");
	const bad = await run(ctx([user("你好")]), { sessionId: "err-3" }, model("nobody/nothing"));
	assert.equal(bad.message.stopReason, "error");
	assert.match(bad.message.errorMessage ?? "", /Model not found: nobody\/nothing/);
	await until(() => channel.liveCount() === 0, "清空");
});

test("进程崩溃：以 error 结束，带 stderr；找不到命令：中文错误、只有一个 error 事件", async () => {
	setScenario("crash");
	const crashed = await run(ctx([user("一")]), { sessionId: "crash-1" });
	assert.equal(crashed.message.stopReason, "error");
	assert.match(crashed.message.errorMessage ?? "", /意外退出.*OPENCODE_ERROR: boom/);
	fakeCommand = null;
	try {
		const r = await run(ctx([user("你好")]), { sessionId: "nocmd-1" });
		assert.equal(r.message.stopReason, "error");
		assert.match(r.message.errorMessage ?? "", /没有找到 opencode 命令/);
		assert.equal(r.events.filter((e) => e.type === "error").length, 1);
	} finally {
		fakeCommand = FAKE;
		setScenario("text");
	}
});

test("运行目录和环境：配置文件 0600 在 0700 目录、系统提示只在配置文件里、权限全 deny、配置目录隔离、白名单环境", async () => {
	setScenario("env-dump");
	const r = await run(ctx([user("你好")], [echoTool], "绝密提示-xyz"), { sessionId: "env-1" });
	const d = JSON.parse(textOf(r.message));
	assert.equal(d.dirMode, "700");
	assert.equal(d.configMode, "600");
	const cfg = JSON.parse(d.configText);
	assert.equal(cfg.agent.build.prompt, "绝密提示-xyz");
	assert.deepEqual(cfg.permission, { "*": "deny", "pia_*": "allow" });
	assert.equal(d.xdgConfig, join(dataDir, "cli-models", "opencode-config"));
	assert.equal(d.flags.OPENCODE_DISABLE_CLAUDE_CODE, "1");
	assert.equal(d.flags.OPENCODE_CONFIG, d.configPath);
	assert.ok(!JSON.stringify([d.argv, d.envKeys]).includes("绝密提示"), "系统提示不在命令行 / 环境变量里");
	assert.ok(!d.envKeys.some((k: string) => /API_KEY|TOKEN|SECRET/.test(k)), "不带密钥");
	setScenario("text");
});

test("关闭渠道：所有长驻进程结束，运行目录一个不剩", async () => {
	setScenario("text");
	await run(ctx([user("留一个空闲进程")]), { sessionId: "dispose-1" });
	assert.ok(readdirSync(runsRoot).length >= 1, "空闲进程还在，运行目录在");
	channel.disposeAll();
	await until(() => readdirSync(runsRoot).length === 0, "运行目录全删");
});
