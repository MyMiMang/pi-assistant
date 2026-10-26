import "./setup.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { ClaudeRun, type ClaudeRunOptions } from "../src/cli-agents/claude-process.ts";
import { detectClaude, findClaudeCommand } from "../src/cli-agents/detect.ts";
import type { ClaudeEvent } from "../src/cli-agents/events.ts";
import { textResult, toolBridge, type Tool } from "../src/cli-agents/tool-bridge.ts";
import type { Env } from "../src/routes/common.ts";
import { mountToolBridgeRoutes } from "../src/routes/tool-bridge.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
const tools: Tool[] = [
	{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
	{ name: "wait", inputSchema: { type: "object" } },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 8000) {
	const t = Date.now();
	while (!cond()) {
		if (Date.now() - t > ms) throw new Error(`等待超时：${what}`);
		await sleep(10);
	}
}

let server: ReturnType<typeof serve>;
let baseUrl = "";
const cwd = mkdtempSync(join(tmpdir(), "pia-fake-claude-"));
before(async () => {
	const app = new Hono<Env>();
	mountToolBridgeRoutes(app);
	server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
	await new Promise<void>((r) => server.once("listening", () => r()));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
	(server as unknown as import("node:http").Server).closeAllConnections();
	server.close();
	rmSync(cwd, { recursive: true, force: true });
});

function start(scenario: string, extra: Partial<ClaudeRunOptions> = {}, message: string | null = "hi") {
	const events: ClaudeEvent[] = [];
	const run = new ClaudeRun({
		command: FAKE,
		cwd,
		bridgeBaseUrl: baseUrl,
		tools,
		extraEnv: { FAKE_CLAUDE_SCENARIO: scenario },
		onEvent: (e) => events.push(e),
		...extra,
	});
	run.start();
	if (message !== null) assert.equal(run.sendUserMessage(message), true);
	return { run, events };
}
const resultOf = (events: ClaudeEvent[]) => events.find((e): e is Extract<ClaudeEvent, { type: "result" }> => e.type === "result");

test("一轮纯文字：init、流式文字、用量、result；运行结束后工具桥注销", async () => {
	const before = toolBridge.size;
	const { run, events } = start("text", { args: { model: "sonnet", resumeSessionId: "sess-9" } });
	const exit = await run.done;
	assert.equal(exit.code, 0);
	assert.equal(exit.aborted, false);
	assert.deepEqual(events[0], { type: "init", sessionId: "sess-9", tools: ["mcp__pia__echo", "mcp__pia__wait"], model: "claude-sonnet-5" });
	assert.equal(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join(""), "你好，收到：hi");
	const end = events.find((e) => e.type === "message_end");
	assert.deepEqual(end, { type: "message_end", stopReason: "end_turn", usage: { input: 100, output: 20, cacheRead: 3, cacheWrite: 4 } });
	assert.deepEqual(resultOf(events), { type: "result", sessionId: "sess-9", isError: false, text: "你好，收到：hi", usage: { input: 100, output: 20, cacheRead: 3, cacheWrite: 4 } });
	assert.equal(toolBridge.size, before);
});

test("进程拿到的环境是白名单，参数里有工具桥配置，工作目录是给定的目录", async () => {
	const SECRET_PROMPT = "你是小微。群规则：绝密规则 ZZZ-SECRET-PROMPT";
	const { run, events } = start("env-dump", {
		args: { systemPrompt: SECRET_PROMPT },
		baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_BASE_URL: "http://x", OPENAI_API_KEY: "k", GITHUB_TOKEN: "t" },
	});
	await run.done;
	const dump = JSON.parse(resultOf(events)!.text) as { env: Record<string, string>; argv: string[]; cwd: string; files: Record<string, string> };
	assert.deepEqual(Object.keys(dump.env).filter((k) => /^ANTHROPIC_|API_KEY|TOKEN/.test(k)), []);
	assert.equal(dump.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
	assert.equal(dump.env.MCP_TOOL_TIMEOUT, "3600000");
	assert.equal(dump.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, "0");
	assert.equal(dump.argv[dump.argv.indexOf("--tools") + 1], "");
	const mcp = JSON.parse(dump.files.mcpConfigText);
	assert.match(mcp.mcpServers.pia.url, new RegExp(`^${baseUrl}/internal/tool-bridge/[0-9a-f]+$`));
	const token = (mcp.mcpServers.pia.headers.Authorization as string).replace("Bearer ", "");
	assert.ok(token.length >= 20);
	// 令牌和系统提示都走私有临时文件（目录 0700、文件 0600），命令行里看不到原文
	assert.equal(dump.files.dirMode, "700");
	assert.equal(dump.files.mcpConfigMode, "600");
	assert.equal(dump.files.systemPromptMode, "600");
	assert.equal(dump.files.systemPromptText, SECRET_PROMPT);
	assert.equal(dump.argv[dump.argv.indexOf("--mcp-config") + 1], dump.files.mcpConfig);
	assert.equal(dump.argv[dump.argv.indexOf("--system-prompt-file") + 1], dump.files.systemPrompt);
	const cmdline = dump.argv.join("\n");
	assert.ok(!cmdline.includes(token) && !cmdline.includes("ZZZ-SECRET-PROMPT") && !cmdline.includes("Bearer"));
	assert.equal(existsSync(dump.files.dir), false, "正常结束后临时目录已删除");
	assert.equal(realpathSync(dump.cwd), realpathSync(cwd));
});

test("一轮里两个工具同时在途：一个结果先到、一个后到，都按 id 配对", async () => {
	const calls: string[] = [];
	const { run, events } = start("two-tools", {
		onToolCall: (c) => {
			calls.push(c.toolUseId);
			if (c.toolUseId === "toolu_B") setTimeout(() => ctl.run.resolveTool("toolu_B", textResult("RB")), 30);
		},
	});
	const ctl = { run };
	// A 的参数一收完（tools/call 之前）就回填：结果先到
	await until(() => events.some((e) => e.type === "tool_call_end" && e.id === "toolu_A"), "tool_call_end A");
	assert.deepEqual(events.filter((e) => e.type === "tool_call_end").map((e) => (e as { args: unknown }).args)[0], { text: "a" });
	assert.equal(run.resolveTool("toolu_A", textResult("RA")), true);
	await run.done;
	assert.deepEqual(calls, ["toolu_B"], "A 的结果先到，不会再登记成挂起的调用");
	assert.equal(resultOf(events)!.text, "A=RA;B=RB");
	const types = events.map((e) => e.type);
	assert.ok(types.indexOf("message_end") < types.indexOf("result"));
	const me = events.find((e) => e.type === "message_end") as { stopReason: string };
	assert.equal(me.stopReason, "tool_use");
	assert.deepEqual(events.filter((e) => e.type === "tool_result").map((e) => [(e as { toolUseId: string }).toolUseId, (e as { text: string }).text]), [["toolu_A", "RA"], ["toolu_B", "RB"]]);
});

test("两个工具都挂起后，先回填后发的那个", async () => {
	const seen: string[] = [];
	const { run, events } = start("two-tools", { onToolCall: (c) => seen.push(c.toolUseId) });
	await until(() => seen.length === 2, "两个 tools/call 都到");
	assert.deepEqual([...run.bridgeRun.pendingIds()].sort(), ["toolu_A", "toolu_B"]);
	assert.equal(run.resolveTool("toolu_B", textResult("second-first")), true);
	await sleep(50);
	assert.deepEqual(run.bridgeRun.pendingIds(), ["toolu_A"], "A 还在等");
	assert.equal(run.resolveTool("toolu_A", textResult("first-last")), true);
	await run.done;
	assert.equal(resultOf(events)!.text, "A=first-last;B=second-first");
});

test("claude 自己超时取消（notifications/cancelled）：挂起的调用取消，之后回填被忽略", async () => {
	const cancelled: string[] = [];
	const called: string[] = [];
	const { run, events } = start("cancel", { onToolCall: (c) => called.push(c.toolUseId), onToolCancelled: (id) => cancelled.push(id) });
	await run.done;
	assert.deepEqual(called, ["toolu_C"]);
	assert.deepEqual(cancelled, ["toolu_C"]);
	assert.equal(run.resolveTool("toolu_C", textResult("too late")), false);
	assert.deepEqual(events.find((e) => e.type === "tool_result"), { type: "tool_result", toolUseId: "toolu_C", isError: true, text: "The operation timed out." });
	assert.equal(resultOf(events)!.text, "cancel-done");
});

test("abort：挂起的调用全部取消，进程结束，工具桥注销", async () => {
	const called: string[] = [];
	const { run, events } = start("hang", { onToolCall: (c) => called.push(c.toolUseId) });
	await until(() => called.length === 1, "tools/call 到达");
	assert.deepEqual(run.bridgeRun.pendingIds(), ["toolu_H"]);
	const id = run.bridgeRun.id;
	const token = run.bridgeRun.token;
	const dir = run.privateDir!;
	assert.equal(existsSync(join(dir, "mcp.json")), true, "运行中配置文件在");
	run.abort();
	assert.deepEqual(run.bridgeRun.pendingIds(), []);
	assert.equal(run.resolveTool("toolu_H", textResult("late")), false);
	const exit = await run.done;
	assert.equal(exit.aborted, true);
	assert.equal(exit.signal, "SIGTERM");
	assert.equal(toolBridge.authorize(id, token), undefined);
	assert.equal(existsSync(dir), false, "abort 后临时目录已删除");
	assert.equal(resultOf(events), undefined, "被中止的运行没有正常 result");
	assert.equal(run.sendUserMessage("after abort"), false);
});

test("插话：往 stdin 写第二条消息，并入同一轮", async () => {
	const { run, events } = start("interject", {}, "第一句");
	await until(() => events.some((e) => e.type === "text_delta"), "claude 开始回答");
	assert.equal(run.sendUserMessage("加一句"), true);
	assert.equal(run.sendUserMessage([{ type: "text", text: "再来" }]), true);
	await run.done; // fake 只读第二条，收到后给出 result；第三条被忽略但不报错
	assert.equal(resultOf(events)!.text, "first:第一句|second:加一句");
	assert.equal(run.sendUserMessage("太晚了"), false, "result 之后 stdin 已关");
});

test("result.is_error（Not logged in）：原文保留，stderr 留作错误信息", async () => {
	const { run, events } = start("not-logged-in");
	const exit = await run.done;
	const r = resultOf(events)!;
	assert.equal(r.isError, true);
	assert.equal(r.text, "Not logged in · Please run /login");
	assert.equal(exit.code, 1);
});

test("claude 起不来（找不到可执行文件）：done 带 spawnError，不抛错", async () => {
	const before = toolBridge.size;
	const run = new ClaudeRun({ command: join(cwd, "no-such-claude"), cwd, bridgeBaseUrl: baseUrl, tools, args: { systemPrompt: "x" }, onEvent: () => {} });
	run.start();
	const dir = run.privateDir!;
	const exit = await run.done;
	assert.equal(existsSync(dir), false, "进程没起来也要删临时目录");
	assert.match(exit.spawnError ?? "", /ENOENT/);
	assert.equal(toolBridge.size, before);
});

test("检测：已登录 / 未登录 / 没装", async () => {
	const ok = await detectClaude({ command: FAKE });
	assert.deepEqual(ok, { installed: true, command: FAKE, version: "2.1.293", loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
	const out = await detectClaude({ command: FAKE, extraEnv: { FAKE_CLAUDE_LOGGED_IN: "0" } });
	assert.equal(out.installed, true);
	assert.equal(out.loggedIn, false);
	assert.equal(out.authMethod, "none");
	const none = await detectClaude({ command: join(cwd, "no-such-claude") });
	assert.equal(none.installed, false);
	assert.equal(none.loggedIn, false);
	assert.ok(none.error);
});

test("找 claude：PATH 里有就用，没有返回 null", () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-claude-bin-"));
	assert.notEqual(findClaudeCommand({ env: { PATH: dir }, home: null, platform: "linux" })?.startsWith(dir), true, "空目录里找不到（别处找到的真实 claude 只返回路径，不会被运行）");
	const bin = join(dir, "claude");
	writeFileSync(bin, "#!/bin/sh\n");
	chmodSync(bin, 0o755);
	assert.equal(findClaudeCommand({ env: { PATH: dir }, home: null, platform: "linux" }), bin);
	rmSync(dir, { recursive: true, force: true });
});
