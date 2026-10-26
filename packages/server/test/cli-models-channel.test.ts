import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { normalizeContext, type AssistantMessage, type AssistantMessageEvent, type Message, type Model, type SimpleStreamOptions, type ToolResultMessage, type UserMessage } from "@earendil-works/pi-ai";
import { toolBridge } from "../src/cli-agents/tool-bridge.ts";
import { Type } from "../src/pi-adapter/index.ts";
import { CLAUDE_CODE_API, CLAUDE_CODE_PROVIDER, createClaudeCodeChannel } from "../src/pi-adapter/cli-models/claude-code.ts";
import type { Env } from "../src/routes/common.ts";
import { mountToolBridgeRoutes } from "../src/routes/tool-bridge.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "pia-cc-channel-"));
let server: ReturnType<typeof serve>;
let baseUrl = "";
let scenario = "text";
let fakeCommand: string | null = FAKE;
before(async () => {
	const app = new Hono<Env>();
	mountToolBridgeRoutes(app);
	server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((r) => server.once("listening", () => r()));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
	channel.disposeAll();
	(server as unknown as import("node:http").Server).closeAllConnections();
	server.close();
	rmSync(dataDir, { recursive: true, force: true });
});

const channel = createClaudeCodeChannel({ dataDir, bridgeBaseUrl: () => baseUrl, command: () => fakeCommand, extraEnv: () => ({ FAKE_CLAUDE_SCENARIO: scenario }) });
const model = (id = "sonnet"): Model<string> => ({ id, name: id, api: CLAUDE_CODE_API, provider: CLAUDE_CODE_PROVIDER, baseUrl: "claude-code://local", input: ["text", "image"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 }) as Model<string>;
const echoTool = { name: "echo", description: "回显", parameters: Type.Object({ text: Type.String() }) };
const waitTool = { name: "wait", description: "等", parameters: Type.Object({}) };

const user = (content: UserMessage["content"]): UserMessage => ({ role: "user", content, timestamp: 1 });
const toolResult = (id: string, text: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "echo", content: [{ type: "text", text }], isError: false, timestamp: 1, ...extra });
const ctx = (messages: Message[], tools: Array<typeof echoTool | typeof waitTool> = [echoTool, waitTool], systemPrompt = "你是小微") => normalizeContext({ systemPrompt, messages, tools });

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
const noLeftovers = () => assert.equal(channel.liveCount(), 0);

test("纯文字一轮：start 在前、文字事件成对、恰好一个 done、用量填好且 cost 为 0", async () => {
	scenario = "text";
	const r = await run(ctx([user("你好")]), { sessionId: "text-1" });
	const t = types(r);
	assert.equal(t[0], "start");
	assert.equal(t.at(-1), "done", r.message.errorMessage ?? "");
	assert.equal(t.filter((x) => x === "done" || x === "error").length, 1);
	assert.equal(t.filter((x) => x === "text_start").length, t.filter((x) => x === "text_end").length);
	assert.equal(textOf(r.message), "你好，收到：你好");
	assert.equal(r.message.stopReason, "stop");
	assert.deepEqual({ input: r.message.usage.input, output: r.message.usage.output, cacheRead: r.message.usage.cacheRead, cacheWrite: r.message.usage.cacheWrite, total: r.message.usage.totalTokens }, { input: 100, output: 20, cacheRead: 3, cacheWrite: 4, total: 127 });
	assert.equal(r.message.usage.cost.total, 0);
	noLeftovers();
});

test("思考块：thinking 事件成对，思考文字进消息", async () => {
	scenario = "think";
	const r = await run(ctx([user("想想")]), { sessionId: "think-1" });
	assert.deepEqual(types(r).filter((t) => t.startsWith("thinking")), ["thinking_start", "thinking_delta", "thinking_end"]);
	assert.deepEqual(r.message.content.map((b) => b.type), ["thinking", "text"]);
	assert.equal(textOf(r.message), "想好了");
});

test("一个工具：以 toolUse 结束（claude 进程不结束）→ Pi 回填 → 同一个 claude 接着答完", async () => {
	scenario = "one-tool";
	const first = await run(ctx([user("查一下")]), { sessionId: "tool-1" });
	assert.equal(first.message.stopReason, "toolUse");
	assert.equal(first.events.at(-1)?.type, "done");
	assert.equal(textOf(first.message), "我来查一下。");
	const calls = callsOf(first.message);
	assert.equal(calls.length, 1);
	assert.deepEqual({ id: calls[0].id, name: calls[0].name, arguments: calls[0].arguments }, { id: "toolu_1", name: "echo", arguments: { text: "hi" } });
	assert.ok(types(first).includes("toolcall_start") && types(first).includes("toolcall_end"));
	assert.equal(channel.liveCount(), 1, "claude 进程还在进行中运行表里");
	const second = await run(ctx([user("查一下"), first.message, toolResult("toolu_1", "ECHO:hi")]), { sessionId: "tool-1" });
	assert.equal(textOf(second.message), "got:ECHO:hi");
	assert.equal(second.message.stopReason, "stop");
	assert.equal(types(second)[0], "start");
	noLeftovers();
});

test("两个工具同时在途：一条消息里两个 toolCall，两个结果都回填后继续", async () => {
	scenario = "two-tools";
	const first = await run(ctx([user("同时查两个")]), { sessionId: "two-1" });
	assert.equal(first.message.stopReason, "toolUse");
	assert.deepEqual(callsOf(first.message).map((c) => c.id), ["toolu_A", "toolu_B"]);
	assert.deepEqual(callsOf(first.message).map((c) => c.arguments), [{ text: "a" }, { text: "b" }]);
	const second = await run(ctx([user("同时查两个"), first.message, toolResult("toolu_A", "RA"), toolResult("toolu_B", "RB")]), { sessionId: "two-1" });
	assert.equal(textOf(second.message), "A=RA;B=RB");
	noLeftovers();
});

test("工具结果里的图片也回填给 claude", async () => {
	scenario = "image-tool";
	const first = await run(ctx([user("看图")]), { sessionId: "img-1" });
	const second = await run(ctx([user("看图"), first.message, toolResult("toolu_1", "截图", { content: [{ type: "text", text: "截图" }, { type: "image", data: "QUJD", mimeType: "image/png" }] })]), { sessionId: "img-1" });
	assert.equal(textOf(second.message), "got:截图[image:image/png]");
});

test("续接时 context 里多了新的用户消息（插话）：随结果一起交给同一个 claude", async () => {
	scenario = "tool-interject";
	const first = await run(ctx([user("干活")]), { sessionId: "inter-1" });
	const second = await run(ctx([user("干活"), first.message, toolResult("toolu_1", "R"), user("顺便说一句")]), { sessionId: "inter-1" });
	assert.equal(textOf(second.message), "got:R|extra:顺便说一句");
	noLeftovers();
});

test("claude 报错：未登录给中文说明并带原文；工具桥和对照表不留东西", async () => {
	scenario = "not-logged-in";
	const r = await run(ctx([user("你好")]), { sessionId: "login-1" });
	assert.equal(r.message.stopReason, "error");
	assert.equal(r.events.at(-1)?.type, "error");
	assert.match(r.message.errorMessage ?? "", /本机 Claude Code 未登录，请在终端运行 claude auth login/);
	assert.match(r.message.errorMessage ?? "", /Not logged in/);
	assert.equal(channel.store.get("login-1"), undefined);
	noLeftovers();
});

test("找不到 claude：中文错误，直接以 error 结束", async () => {
	fakeCommand = null;
	try {
		const r = await run(ctx([user("你好")]), { sessionId: "nocmd-1" });
		assert.equal(r.message.stopReason, "error");
		assert.match(r.message.errorMessage ?? "", /没有找到 claude 命令/);
		assert.equal(r.events.filter((e) => e.type === "error").length, 1);
	} finally {
		fakeCommand = FAKE;
	}
});

test("进程没有 result 就退出：以 error 结束，带退出码", async () => {
	scenario = "unknown-crash";
	// 未知场景会输出 result；这里用不存在的可执行文件模拟「进程起不来」
	const saved = fakeCommand;
	fakeCommand = join(dataDir, "不存在的claude");
	try {
		const r = await run(ctx([user("你好")]), { sessionId: "crash-1" });
		assert.equal(r.message.stopReason, "error");
		assert.match(r.message.errorMessage ?? "", /无法启动 claude|意外退出/);
	} finally {
		fakeCommand = saved;
	}
	noLeftovers();
});

test("abort（正在说话时）：以 aborted 结束，进程被结束", async () => {
	scenario = "stall";
	const ac = new AbortController();
	const stream = channel.streamSimple(model() as never, ctx([user("说")]), { sessionId: "abort-1", signal: ac.signal });
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
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(events.filter((e) => e.type === "text_start").length, events.filter((e) => e.type === "text_end").length, "出错前补齐没关的块");
	assert.ok(msg.errorMessage);
	noLeftovers();
});

test("abort（工具交回 Pi 期间）：挂着的 claude 被结束，工具桥注销", async () => {
	scenario = "hang";
	const before = toolBridge.size;
	const ac = new AbortController();
	const first = await run(ctx([user("等")]), { sessionId: "abort-2", signal: ac.signal });
	assert.equal(first.message.stopReason, "toolUse");
	assert.equal(channel.liveCount(), 1);
	ac.abort();
	await until(() => channel.liveCount() === 0 && toolBridge.size <= before, `进程被结束 live=${channel.liveCount()} bridge=${toolBridge.size} before=${before}`);
});

test("signal 一开始就是中止的：直接 aborted，不起进程", async () => {
	scenario = "text";
	const ac = new AbortController();
	ac.abort();
	const r = await run(ctx([user("你好")]), { sessionId: "pre-abort", signal: ac.signal });
	assert.equal(r.message.stopReason, "aborted");
	noLeftovers();
});

test("第二轮续用会话：只发新增的用户内容，带 --resume；model / effort / 系统提示正确传下去", async () => {
	scenario = "meta";
	const first = await run(ctx([user("第一句")], undefined, "系统提示一"), { sessionId: "res-1", reasoning: "minimal" });
	const info1 = JSON.parse(textOf(first.message));
	assert.equal(info1.resume, null);
	assert.equal(info1.model, "sonnet");
	assert.equal(info1.effort, "low");
	assert.equal(info1.systemPrompt, "系统提示一");
	assert.equal(info1.noPersist, false);
	assert.deepEqual(info1.tools, ["mcp__pia__echo", "mcp__pia__wait"]);
	const sid = channel.store.get("res-1")?.claudeSessionId;
	assert.ok(sid, "记下了 claude 会话 id");
	const second = await run(ctx([user("第一句"), first.message, user("第二句")], undefined, "系统提示二"), { sessionId: "res-1", reasoning: "high" });
	const info2 = JSON.parse(textOf(second.message));
	assert.equal(info2.resume, sid);
	assert.equal(info2.first, "第二句", "只发新增的用户内容，不重发历史");
	assert.equal(info2.effort, "high");
	assert.equal(info2.systemPrompt, "系统提示二", "每轮的系统提示都是新的");
	// 第三轮继续续用同一个会话
	const third = await run(ctx([user("第一句"), first.message, user("第二句"), second.message, user("第三句")]), { sessionId: "res-1" });
	assert.equal(JSON.parse(textOf(third.message)).resume, sid);
	assert.equal(JSON.parse(textOf(third.message)).first, "第三句");
});

test("历史对不上就新开会话并带上完整前文：整理过上下文、换过模型、对照表丢了", async () => {
	scenario = "meta";
	const first = await run(ctx([user("第一句")]), { sessionId: "fresh-1" });
	// 整理过上下文：前面的消息被摘要替换
	const compacted = await run(ctx([user("【摘要】之前聊了第一句"), user("第二句")]), { sessionId: "fresh-1" });
	const c = JSON.parse(textOf(compacted.message));
	assert.equal(c.resume, null);
	assert.match(c.first, /之前聊了第一句/);
	assert.match(c.first, /第二句/);
	// 换过模型
	const first2 = await run(ctx([user("你好")]), { sessionId: "fresh-2" });
	const switched = await run(ctx([user("你好"), first2.message, user("换个模型")]), { sessionId: "fresh-2" }, model("opus"));
	const sw = JSON.parse(textOf(switched.message));
	assert.equal(sw.resume, null);
	assert.equal(sw.model, "opus");
	assert.match(sw.first, /用户：你好[\s\S]*助理：[\s\S]*换个模型/);
	// 对照表丢了（别的 Pi 会话 id）
	const lost = await run(ctx([user("你好"), first2.message, user("还在吗")]), { sessionId: "fresh-never-seen" });
	assert.equal(JSON.parse(textOf(lost.message)).resume, null);
	assert.ok(first);
});

test("续用的会话 claude 找不到：自动改成新开会话重来一次", async () => {
	scenario = "meta";
	const first = await run(ctx([user("一")]), { sessionId: "gone-1" });
	scenario = "resume-missing";
	const second = await run(ctx([user("一"), first.message, user("二")]), { sessionId: "gone-1" });
	assert.equal(second.message.stopReason, "stop");
	assert.equal(textOf(second.message), "新会话");
	assert.equal(second.events.filter((e) => e.type === "start").length, 1);
});

test("没有工具的单次请求（整理上下文等）：不续用会话、不留 claude 会话记录、不进对照表", async () => {
	scenario = "meta";
	const c = ctx([user("请总结")], [], "你是总结助手");
	const r = await run(c, { sessionId: "compact-1" });
	const info = JSON.parse(textOf(r.message));
	assert.equal(info.noPersist, true);
	assert.equal(info.resume, null);
	assert.deepEqual(info.tools, []);
	assert.equal(channel.store.get("compact-1"), undefined);
	// 主循环里同一个会话的对照表不受影响
	const main = await run(ctx([user("你好")]), { sessionId: "compact-2" });
	const before = channel.store.get("compact-2");
	await run(ctx([user("请总结")], []), { sessionId: "compact-2" });
	assert.deepEqual(channel.store.get("compact-2"), before);
	assert.ok(main);
});

test("钩子：onPayload 可以替换要发的内容；onResponse / onProviderStreamEvent 被调用", async () => {
	scenario = "meta";
	const seen: string[] = [];
	let payload: Record<string, unknown> = {};
	const r = await run(ctx([user("原话")]), {
		sessionId: "hook-1",
		onPayload: (p) => {
			payload = p as Record<string, unknown>;
			return { ...(p as object), input: "被换掉的话" };
		},
		onResponse: (resp) => void seen.push(`response:${resp.status}`),
		onProviderStreamEvent: (e) => void seen.push((e as { type: string }).type),
	});
	assert.equal(JSON.parse(textOf(r.message)).first, "被换掉的话");
	assert.equal(payload.model, "sonnet");
	assert.ok(seen.includes("response:200") && seen.includes("init") && seen.includes("result"));
});

test("临时文件不残留：每次运行的私有目录都删掉了", async () => {
	scenario = "text";
	const before = readdirSync(tmpdir()).filter((n) => n.startsWith("pia-claude-"));
	await run(ctx([user("你好")]), { sessionId: "tmp-1" });
	const leftover = () => readdirSync(tmpdir()).filter((n) => n.startsWith("pia-claude-") && !before.includes(n));
	await until(() => leftover().length === 0, "私有目录被删掉（前面测试里被结束的进程可能还在收尾）", 3000).catch(() => {});
	assert.deepEqual(leftover(), []);
	assert.ok(existsSync(join(dataDir, "cli-models", "claude-sessions.json")), "对照表写进了数据目录");
});
