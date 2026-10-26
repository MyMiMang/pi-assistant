/**
 * Codex 的纯逻辑和进程管理（假 codex，绝不调用真实 codex）：事件转换、启动参数 / 环境白名单、检测、
 * hub 的空闲退出与模型列表、请求超时 / 进程退出时的 reject。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answerServerRequest, codexUsage, createCodexEventConverter } from "../src/cli-agents/codex-events.ts";
import { CodexHub } from "../src/cli-agents/codex-hub.ts";
import { buildCodexArgs, buildCodexEnv, CODEX_DISABLED_FEATURES, tomlKey } from "../src/cli-agents/codex-launch.ts";
import { detectCodex, findCodexCommand } from "../src/cli-agents/detect.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const T = "thr_1";
const run = (c: ReturnType<typeof createCodexEventConverter>, ...msgs: Array<[string, Record<string, unknown>]>) => msgs.flatMap(([m, p]) => c.notification(m, { threadId: T, ...p }));

test("正文：started → delta → completed 变成成对的 text 事件；没有增量时用完整文字补上", () => {
	const c = createCodexEventConverter(T);
	const ev = run(c, ["item/started", { item: { type: "agentMessage", id: "m1" } }], ["item/agentMessage/delta", { itemId: "m1", delta: "你" }], ["item/agentMessage/delta", { itemId: "m1", delta: "好" }], ["item/completed", { item: { type: "agentMessage", id: "m1", text: "你好" } }]);
	assert.deepEqual(ev.map((e) => e.type), ["text_start", "text_delta", "text_delta", "text_end"]);
	const bare = run(c, ["item/started", { item: { type: "agentMessage", id: "m2" } }], ["item/completed", { item: { type: "agentMessage", id: "m2", text: "整段" } }]);
	assert.deepEqual(bare.map((e) => e.type), ["text_start", "text_delta", "text_end"]);
});

test("思考摘要：多段之间隔一行；没有摘要的思考项不产生空块", () => {
	const c = createCodexEventConverter(T);
	const ev = run(c, ["item/started", { item: { type: "reasoning", id: "r1" } }], ["item/reasoning/summaryTextDelta", { itemId: "r1", delta: "甲", summaryIndex: 0 }], ["item/reasoning/summaryTextDelta", { itemId: "r1", delta: "乙", summaryIndex: 1 }], ["item/completed", { item: { type: "reasoning", id: "r1", summary: ["甲", "乙"] } }]);
	assert.deepEqual(ev.map((e) => (e.type === "thinking_delta" ? e.text : e.type)), ["thinking_start", "甲", "\n\n", "乙", "thinking_end"]);
	assert.deepEqual(run(c, ["item/started", { item: { type: "reasoning", id: "r2" } }], ["item/completed", { item: { type: "reasoning", id: "r2", summary: [] } }]), []);
});

test("item/tool/call 服务端请求：转成 toolCall 开始 + 结束 + tool_request（带回包用的 id）", () => {
	const c = createCodexEventConverter(T);
	const ev = c.serverRequest(7, "item/tool/call", { threadId: T, turnId: "t", callId: "call_1", tool: "echo", arguments: { text: "hi" } });
	assert.deepEqual(ev, [{ type: "tool_call_start", id: "call_1", name: "echo" }, { type: "tool_call_end", id: "call_1", name: "echo", args: { text: "hi" } }, { type: "tool_request", rpcId: 7, callId: "call_1", name: "echo", args: { text: "hi" } }]);
	assert.equal(c.serverRequest(8, "item/commandExecution/requestApproval", { threadId: T }), null, "别的请求不归事件转换管");
	assert.deepEqual(c.serverRequest(9, "item/tool/call", { threadId: "别的线程", callId: "x", tool: "echo", arguments: {} }), []);
});

test("用量：取 last，inputTokens 含缓存要扣掉；别的线程的消息忽略", () => {
	assert.deepEqual(codexUsage({ inputTokens: 100, cachedInputTokens: 3, cacheWriteInputTokens: 4, outputTokens: 20 }), { input: 93, output: 20, cacheRead: 3, cacheWrite: 4 });
	assert.deepEqual(codexUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	const c = createCodexEventConverter(T);
	assert.deepEqual(run(c, ["thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 10, outputTokens: 2 } } }]), [{ type: "usage", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } }]);
	assert.deepEqual(c.notification("thread/tokenUsage/updated", { threadId: "other", tokenUsage: { last: {} } }), []);
});

test("turn/completed：状态和错误原因；重试中的 error 不算", () => {
	const c = createCodexEventConverter(T);
	run(c, ["error", { willRetry: true, error: { message: "暂时的" } }]);
	assert.deepEqual(run(c, ["turn/completed", { turn: { status: "completed", error: null } }]), [{ type: "turn_end", status: "completed" }]);
	run(c, ["error", { willRetry: false, error: { message: "Not logged in" } }]);
	assert.deepEqual(run(c, ["turn/completed", { turn: { status: "failed", error: null } }]), [{ type: "turn_end", status: "failed", error: "Not logged in" }]);
	assert.deepEqual(run(c, ["turn/completed", { turn: { status: "interrupted" } }]), [{ type: "turn_end", status: "interrupted" }]);
});

test("不认识的服务端请求：审批拒绝、提问回不可用、其余报不支持", () => {
	assert.deepEqual(answerServerRequest("item/commandExecution/requestApproval"), { result: { decision: "decline" } });
	assert.deepEqual(answerServerRequest("item/fileChange/requestApproval"), { result: { decision: "decline" } });
	assert.deepEqual(answerServerRequest("execCommandApproval"), { result: { decision: "denied" } });
	assert.deepEqual(answerServerRequest("mcpServer/elicitation/request"), { result: { action: "decline" } });
	assert.ok("error" in answerServerRequest("item/tool/requestUserInput"));
	assert.ok("error" in answerServerRequest("something/else"));
});

test("启动参数：关掉自带功能，固定配置，MCP 逐个按名字关（特殊名字加引号）", () => {
	const args = buildCodexArgs(["node_repl", "a.b", "有空 格"]);
	assert.equal(args[0], "app-server");
	for (const f of CODEX_DISABLED_FEATURES) assert.ok(args.some((a, i) => a === f && args[i - 1] === "--disable"), `--disable ${f}`);
	for (const c of ['web_search="disabled"', "skills.bundled.enabled=false", "include_environment_context=false", "project_doc_max_bytes=0"]) assert.ok(args.includes(c));
	assert.ok(args.includes("mcp_servers.node_repl.enabled=false"));
	assert.ok(args.includes('mcp_servers."a.b".enabled=false'));
	assert.ok(args.includes('mcp_servers."有空 格".enabled=false'));
	assert.equal(args.some((a) => a.startsWith("mcp_servers.") && a.includes("={}")), false);
	assert.equal(buildCodexArgs().some((a) => a.startsWith("mcp_servers.")), false, "没有 MCP 名字就不写这个键（写了会让 app-server 起不来）");
	assert.equal(tomlKey("ok-name_1"), "ok-name_1");
});

test("环境白名单：不带任何密钥，只放行 CODEX_HOME 等必要变量", () => {
	const env = buildCodexEnv({ baseEnv: { PATH: "/usr/bin", HOME: "/h", CODEX_HOME: "/c", OPENAI_API_KEY: "sk-x", ANTHROPIC_API_KEY: "a", GITHUB_TOKEN: "g", HTTPS_PROXY: "http://p" }, realHome: null, extra: { FAKE_CODEX_SCENARIO: "text" } });
	assert.equal(env.CODEX_HOME, "/c");
	assert.equal(env.HTTPS_PROXY, "http://p");
	assert.equal(env.FAKE_CODEX_SCENARIO, "text");
	for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) assert.equal(env[k], undefined, k);
});

test("检测：已登录 / 未登录（只看退出码）/ 没装", async () => {
	const ok = await detectCodex({ command: FAKE });
	assert.deepEqual({ installed: ok.installed, loggedIn: ok.loggedIn, version: ok.version }, { installed: true, loggedIn: true, version: "0.161.0" });
	const home = mkdtempSync(join(tmpdir(), "pia-cx-detect-"));
	writeFileSync(join(home, "logged-out"), "");
	const out = await detectCodex({ command: FAKE, baseEnv: { PATH: process.env.PATH, CODEX_HOME: home } });
	assert.deepEqual({ installed: out.installed, loggedIn: out.loggedIn }, { installed: true, loggedIn: false });
	assert.equal(JSON.stringify(out).includes("Not logged"), false, "不转述命令输出");
	const none = await detectCodex({ command: join(home, "no-such-codex") });
	assert.equal(none.installed, false);
	assert.equal((findCodexCommand({ env: { PATH: home }, home: null, platform: "linux" }) ?? "").startsWith(home), false);
});

test("hub：模型列表（隐藏的不要、思考档位、能否看图）；用完即关；空闲超时退出；退出后能再起", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-cx-hub-"));
	const hub = new CodexHub({ command: () => FAKE, cwd: () => dir, idleMs: 150 });
	try {
		const list = await hub.listModels();
		assert.deepEqual(list.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-luna"]);
		assert.deepEqual(list[1].efforts, ["low", "medium", "high"]);
		assert.deepEqual(list.map((m) => m.image), [true, false]);
		assert.equal(list[0].isDefault, true);
		assert.equal(hub.running, true);
		const pid = hub.pid;
		const t0 = Date.now();
		while (hub.running && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
		assert.equal(hub.running, false, "空闲超时后进程退出");
		await hub.listModels();
		assert.equal(hub.running, true);
		assert.notEqual(hub.pid, pid, "重新起了一个进程");
		hub.setActive("t", true);
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(hub.running, true, "有进行中的线程时不空闲退出");
		hub.stopIfIdle();
		assert.equal(hub.running, true);
		hub.setActive("t", false);
		hub.stopIfIdle();
		assert.equal(hub.running, false);
	} finally {
		hub.dispose();
	}
});

test("hub：没有 codex 命令时给中文说明；dispose 之后不再启动", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pia-cx-hub2-"));
	const none = new CodexHub({ command: () => null, cwd: () => dir });
	await assert.rejects(() => none.listModels(), /没有找到 codex 命令/);
	const hub = new CodexHub({ command: () => FAKE, cwd: () => dir });
	hub.dispose();
	await assert.rejects(() => hub.listModels(), /已关闭/);
});
