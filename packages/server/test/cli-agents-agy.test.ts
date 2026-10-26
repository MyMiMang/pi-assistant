/**
 * Antigravity（agy）接入的 cli-agents 层单测：启动文件 / 参数 / 环境、`agy models` 解析、事件转换、检测，
 * 以及长驻进程（`AgyProcess`）配假 agy（fixtures/fake-agy.mjs）：并行工具收齐、配对、续用参数、SIGINT 中止、空闲退出、运行目录清理。
 * 绝不调用真实 agy。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { convertAgyLine, type AgyEvent } from "../src/cli-agents/agy-events.ts";
import { agyAgentFile, agyCallKey, agyMcpConfig, agyRunDirs, agyRunFiles, buildAgyArgs, buildAgyEnv, fromAgyToolName } from "../src/cli-agents/agy-launch.ts";
import { effortsOf, agyThinkingMap, parseAgyModels, resolveAgyModel } from "../src/cli-agents/agy-models.ts";
import { AgyProcess, type AgyExit, type AgyItem, type AgyProcessOptions } from "../src/cli-agents/agy-process.ts";
import { detectAgy, findAgyCommand, listAgyModels } from "../src/cli-agents/detect.ts";
import { textResult, toolBridge, type Tool } from "../src/cli-agents/tool-bridge.ts";
import type { Env } from "../src/routes/common.ts";
import { mountToolBridgeRoutes } from "../src/routes/tool-bridge.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-agy.mjs");
const MODELS_TEXT = readModelsText();
function readModelsText(): string {
	return ["Fetching available models...", "gemini-4-argon-medium\tGemini 4 Argon (Medium)", "gemini-4-argon-high\tGemini 4 Argon (High)", "gemini-4-argon-low\tGemini 4 Argon (Low)", "claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)", "claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)", "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)", ""].join("\n");
}
const tools: Tool[] = [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 8000) {
	const t = Date.now();
	while (!cond()) {
		if (Date.now() - t > ms) throw new Error(`等待超时：${what}`);
		await sleep(10);
	}
}

// ---------------------------------------------------------------- 纯函数
test("启动参数：-p 空串在最后；续用带 --conversation；环境只留白名单", () => {
	assert.deepEqual(buildAgyArgs({ model: "claude-sonnet-5-5-high" }), ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "claude-sonnet-5-5-high", "--agent", "pia", "-p", ""]);
	const resumed = buildAgyArgs({ model: "m", conversationId: "c-1" });
	assert.deepEqual(resumed.slice(-4), ["--conversation", "c-1", "-p", ""]);
	const env = buildAgyEnv({ baseEnv: { HOME: "/Users/x", PATH: "/bin", GEMINI_API_KEY: "secret", GOOGLE_API_KEY: "k", ANTHROPIC_API_KEY: "a", HTTPS_PROXY: "http://p" }, realHome: "/Users/x" });
	assert.equal(env.HOME, "/Users/x");
	assert.equal(env.HTTPS_PROXY, "http://p");
	for (const k of Object.keys(env)) assert.doesNotMatch(k, /KEY|SECRET|TOKEN/, k);
});

test("运行目录文件：代理 / 插件 / MCP 配置的内容，含令牌的都是 0600", () => {
	const files = agyRunFiles({ systemPrompt: "你是 X。\n第二行", bridgeUrl: "http://127.0.0.1:1/internal/tool-bridge/r", token: "tok" });
	assert.deepEqual(files.map((f) => f.path), [".agents/agents/pia.md", ".agents/plugins/pia/plugin.json", ".agents/plugins/pia/mcp_config.json"]);
	assert.ok(files.every((f) => f.mode === 0o600));
	assert.deepEqual(agyRunDirs(files), [".agents/agents", ".agents/plugins/pia"]);
	const md = files[0].content;
	assert.match(md, /^---\nname: pia\n/);
	for (const k of ["mainAgent: true", "excludeDefaultComponents: true", "tools: []", "inheritMcp: false"]) assert.ok(md.includes(k), k);
	assert.ok(md.endsWith("---\n你是 X。\n第二行\n"));
	assert.deepEqual(JSON.parse(files[1].content), { name: "pia", description: "Pi Assistant 的工具桥", version: "1" });
	assert.deepEqual(JSON.parse(files[2].content), { mcpServers: { pia: { url: "http://127.0.0.1:1/internal/tool-bridge/r", headers: { Authorization: "Bearer tok" }, timeoutSeconds: 3600 } } });
	assert.match(agyAgentFile(undefined), /只使用提供给你的工具/, "没有系统提示时给一句兜底");
});

test("工具名前缀和配对键：progressToken 末段的 step_index", () => {
	assert.deepEqual(fromAgyToolName("mcp_pia_pia_echo_text"), { name: "echo_text", mine: true });
	assert.deepEqual(fromAgyToolName("list_resources"), { name: "list_resources", mine: false });
	assert.equal(agyCallKey({ progressToken: "2c57f566-93e7-4bee-ab44-a2bda7112615:3" }), "3");
	assert.equal(agyCallKey({ progressToken: "no-step" }), undefined);
	assert.equal(agyCallKey({ progressToken: 7 }), undefined);
	assert.equal(agyCallKey({}), undefined);
});

test("agy models 解析：按家族去重、档位映射、没有档位后缀的原样保留", () => {
	const fams = parseAgyModels(MODELS_TEXT);
	assert.deepEqual(fams.map((f) => [f.id, f.name, effortsOf(f)]), [
		["gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]],
		["claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "high"]],
		["gpt-oss-120b", "GPT-OSS 120B", ["medium"]],
	]);
	assert.equal(resolveAgyModel(fams, "gemini-4-argon", "low"), "gemini-4-argon-low");
	assert.equal(resolveAgyModel(fams, "gemini-4-argon", undefined), "gemini-4-argon-medium", "没指定取 medium");
	assert.equal(resolveAgyModel(fams, "gemini-4-argon", "minimal"), "gemini-4-argon-medium", "minimal 在 Pi 里没有对应档位，当没指定");
	assert.equal(resolveAgyModel(fams, "gemini-4-argon", "xhigh"), "gemini-4-argon-high", "比 high 更高的档位取 high");
	assert.equal(resolveAgyModel(fams, "gemini-4-argon", "max"), "gemini-4-argon-high");
	assert.equal(resolveAgyModel(fams, "claude-sonnet-5-5", "medium"), "claude-sonnet-5-5-high", "想要的档位没有就取最近的");
	assert.equal(resolveAgyModel(fams, "gpt-oss-120b", "high"), "gpt-oss-120b-medium");
	assert.equal(resolveAgyModel(fams, "unknown-model", "low"), "unknown-model", "不认识的原样返回");
	assert.equal(resolveAgyModel(parseAgyModels("plain-model\t纯模型 (x)\n"), "plain-model", "high"), "plain-model");
	assert.equal(agyThinkingMap(fams[2]), undefined, "只有一个档位：没有思考强度选项");
	assert.deepEqual(agyThinkingMap(fams[0]), { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" });
	assert.deepEqual(parseAgyModels("Error: Please sign in\n"), []);
});

test("事件转换：init / 文字 / 用量（不含缓存读取）/ 工具步骤 / result / 非 JSON 行", () => {
	const step = (s: object) => JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", ...s } });
	assert.deepEqual(convertAgyLine(JSON.stringify({ event: "init", conversation_id: "c-1", init: { model: "m", agent: "pia", tools: ["a"] } })), [{ type: "init", sessionId: "c-1", tools: [], model: "m" }]);
	assert.deepEqual(convertAgyLine(step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "你好" })), [{ type: "text_delta", text: "你好" }]);
	assert.deepEqual(convertAgyLine(step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\n", usage: { input_tokens: 294, output_tokens: 94, thinking_tokens: 0, cache_read_tokens: 1209, total_tokens: 388 } })), [{ type: "message_end", stopReason: "end_turn", usage: { input: 294, output: 94, cacheRead: 1209, cacheWrite: 0 } }]);
	assert.deepEqual(convertAgyLine(step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "尾巴", usage: {} })).map((e) => e.type), ["text_delta", "message_end"], "DONE 带真文字也保留");
	assert.deepEqual(convertAgyLine(step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "mcp_pia_pia_echo", tool_info: { name: "mcp_pia_pia_echo", parameters: { text: "x" } } })), [{ type: "tool_step", stepIndex: 2, state: "ACTIVE", name: "echo", mine: true, args: { text: "x" } }]);
	assert.deepEqual(convertAgyLine(step({ step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "list_resources" })), [{ type: "tool_step", stepIndex: 3, state: "ACTIVE", name: "list_resources", mine: false, args: {} }]);
	assert.deepEqual(convertAgyLine(step({ step_index: 0, state: "DONE", step_type: "user_input" })), []);
	assert.deepEqual(convertAgyLine(step({ step_index: 9, state: "DONE", step_type: "error_message", text_delta: "炸了" })), [{ type: "step_error", text: "炸了" }]);
	const ok = convertAgyLine(JSON.stringify({ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "全文\n", usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3 } } }));
	assert.deepEqual(ok, [{ type: "result", sessionId: "c", isError: false, text: "全文\n", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 } }]);
	const bad = convertAgyLine(JSON.stringify({ event: "result", result: { conversation_id: "c", status: "ERROR", error: "interrupted" } }));
	assert.deepEqual(bad[0], { type: "result", sessionId: "c", isError: true, text: "interrupted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
	assert.deepEqual(convertAgyLine("not json"), [{ type: "unparsed", line: "not json" }]);
	assert.deepEqual(convertAgyLine("  "), []);
	assert.deepEqual(convertAgyLine('{"event":"whatever"}'), []);
});

// ---------------------------------------------------------------- 检测
test("检测：假 agy 已登录 / 未登录 / 没装；模型列表从 agy models 解析", async () => {
	const ok = await detectAgy({ command: FAKE });
	assert.deepEqual({ ...ok, command: undefined }, { installed: true, command: undefined, version: "1.4.7", loggedIn: true });
	const out = await detectAgy({ command: FAKE, extraEnv: { FAKE_AGY_LOGGED_IN: "0" } });
	assert.equal(out.installed, true);
	assert.equal(out.loggedIn, false);
	assert.match(out.error ?? "", /sign in/);
	assert.deepEqual((await listAgyModels(FAKE)).map((f) => f.id), ["claude-sonnet-5-5", "gemini-4-argon", "gpt-oss-120b"]);
	await assert.rejects(listAgyModels(FAKE, { extraEnv: { FAKE_AGY_LOGGED_IN: "0" } }), /sign in/);
	assert.equal(findAgyCommand({ env: { PATH: "/nonexistent" }, home: null, platform: "linux" }), null, "PATH 里没有 = 找不到（不走本机真实目录）");
	const missing = await detectAgy({ command: join(tmpdir(), "no-such-agy") });
	assert.equal(missing.installed, false);
});

// ---------------------------------------------------------------- 进程
let server: ReturnType<typeof serve>;
let baseUrl = "";
const runsRoot = mkdtempSync(join(tmpdir(), "pia-fake-agy-"));
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
	rmSync(runsRoot, { recursive: true, force: true });
});

function start(scenario: string, extra: Partial<AgyProcessOptions> = {}, message: string | null = "hi") {
	const items: AgyItem[] = [];
	const proc = new AgyProcess({ command: FAKE, runsRoot, bridgeBaseUrl: baseUrl, tools, model: "claude-sonnet-5-5-high", systemPrompt: "SYSTEM-PROMPT", extraEnv: { FAKE_AGY_SCENARIO: scenario }, ...extra });
	const exits: AgyExit[] = [];
	proc.attach({ onItem: (i) => items.push(i), onExit: (x) => exits.push(x) });
	proc.start();
	if (message !== null) assert.equal(proc.sendUserMessage(message), true);
	return { proc, items, exits };
}
const resultsOf = (items: AgyItem[]) => items.filter((i): i is Extract<AgyEvent, { type: "result" }> => i.type === "result");
const textOf = (items: AgyItem[]) => items.filter((i) => i.type === "text_delta").map((i) => (i as { text: string }).text).join("");

test("一轮纯文字：init 带会话 id、文字、用量、result；进程保持长驻，关 stdin 才退出；运行目录最后删掉", async () => {
	const before = toolBridge.size;
	const { proc, items } = start("text");
	await until(() => resultsOf(items).length === 1, "第一轮 result");
	assert.equal(items[0].type, "init");
	assert.equal(proc.conversationId, (items[0] as { sessionId: string }).sessionId);
	assert.equal(textOf(items), "你好，收到：hi");
	assert.deepEqual(items.find((i) => i.type === "message_end"), { type: "message_end", stopReason: "end_turn", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0 } });
	assert.equal(proc.dead, false, "result 之后进程还活着（长驻）");
	const dir = proc.runDir!;
	assert.ok(existsSync(dir));
	// 第二轮在同一个进程里
	items.length = 0;
	proc.sendUserMessage("再来一句");
	await until(() => resultsOf(items).length === 1, "第二轮 result");
	assert.equal(textOf(items), "你好，收到：再来一句");
	assert.ok(!items.some((i) => i.type === "init"), "第二轮没有重新 init");
	proc.shutdown();
	const exit = await proc.done;
	assert.equal(exit.code, 0);
	assert.equal(exit.aborted, false);
	assert.equal(existsSync(dir), false, "运行目录已删");
	assert.equal(toolBridge.size, before, "工具桥已注销");
});

test("运行目录：0700 / 0600、内容、环境里没有密钥，agy 的 cwd 就是运行目录", async () => {
	const { proc, items } = start("env-dump", {}, "dump");
	await until(() => resultsOf(items).length === 1, "env-dump result");
	const info = JSON.parse(textOf(items)) as { dir: string; dirMode: string; mcpConfigMode: string; mcpConfigText: string; agentMode: string; agentText: string; entries: string[]; envKeys: string[] };
	assert.equal(info.dir.replace(/^\/private/, ""), proc.runDir!.replace(/^\/private/, ""));
	assert.equal(info.dirMode, "700");
	assert.equal(info.mcpConfigMode, "600");
	assert.equal(info.agentMode, "600");
	assert.deepEqual(info.entries, [".agents"]);
	const cfg = JSON.parse(info.mcpConfigText).mcpServers.pia;
	assert.equal(cfg.url, `${baseUrl}/internal/tool-bridge/${proc.bridgeRun.id}`);
	assert.equal(cfg.headers.Authorization, `Bearer ${proc.bridgeRun.token}`);
	assert.equal(cfg.timeoutSeconds, 3600);
	assert.ok(info.agentText.endsWith("---\nSYSTEM-PROMPT\n"));
	for (const k of info.envKeys) assert.doesNotMatch(k, /API_KEY|SECRET|^ANTHROPIC|^GEMINI/, k);
	proc.shutdown();
	await proc.done;
	assert.equal(existsSync(info.dir), false);
});

test("命令行参数：--model / --agent / 续用的 --conversation；token 不在命令行", async () => {
	const { proc, items } = start("meta", { conversationId: "conv-77" }, "第一句");
	await until(() => resultsOf(items).length === 1, "meta result");
	const info = JSON.parse(textOf(items)) as { conversation: string; first: string; model: string; agent: string; argv: string[]; tools: string[]; alwaysLoad: boolean };
	assert.equal(info.conversation, "conv-77");
	assert.equal(info.first, "第一句");
	assert.equal(info.model, "claude-sonnet-5-5-high");
	assert.equal(info.agent, "pia");
	assert.deepEqual(info.tools, ["echo"]);
	assert.equal(info.alwaysLoad, true, "tools/list 带 alwaysLoad");
	assert.ok(!info.argv.join(" ").includes(proc.bridgeRun.token), "令牌不进命令行");
	assert.ok(!info.argv.join(" ").includes("SYSTEM-PROMPT"), "系统提示不进命令行");
	proc.shutdown();
	await proc.done;
});

test("一个工具：tool_call 事件带配对键（step_index）和 Pi 用的 id；300 毫秒后 tools_ready；回填后接着答完", async () => {
	const { proc, items } = start("one-tool", { collectMs: 50 });
	await until(() => items.some((i) => i.type === "tools_ready"), "tools_ready");
	const calls = items.filter((i): i is Extract<AgyItem, { type: "tool_call" }> => i.type === "tool_call");
	assert.equal(calls.length, 1);
	assert.deepEqual([calls[0].name, calls[0].args], ["echo", { text: "hi" }]);
	assert.match(calls[0].key, /^\d+$/);
	assert.equal(calls[0].id, `agy-${proc.conversationId!.slice(0, 8)}-${calls[0].key}`);
	const step = items.find((i) => i.type === "tool_step" && i.state === "ACTIVE") as Extract<AgyEvent, { type: "tool_step" }>;
	assert.equal(String(step.stepIndex), calls[0].key, "stdout 的 tool 步骤 step_index 和 tools/call 的配对键一致");
	assert.equal(step.mine, true);
	assert.deepEqual(proc.bridgeRun.pendingIds(), [calls[0].key]);
	assert.equal(proc.resolveTool(calls[0].key, textResult("ECHO:hi")), true);
	await until(() => resultsOf(items).length === 1, "result");
	assert.equal(textOf(items), "我来查一下。got:ECHO:hi");
	proc.shutdown();
	await proc.done;
});

test("并行两个工具：只发一次 tools_ready（收齐窗口内到的都算这一批），按 step_index 各自回填", async () => {
	const { proc, items } = start("two-tools", { collectMs: 150 });
	await until(() => items.some((i) => i.type === "tools_ready"), "tools_ready");
	const calls = items.filter((i): i is Extract<AgyItem, { type: "tool_call" }> => i.type === "tool_call");
	assert.deepEqual(calls.map((c) => c.args.text), ["A", "B"]);
	assert.equal(items.filter((i) => i.type === "tools_ready").length, 1);
	assert.ok(items.findIndex((i) => i.type === "tools_ready") > items.findIndex((i) => i === calls[1]), "tools_ready 在两个调用之后");
	assert.notEqual(calls[0].key, calls[1].key);
	assert.deepEqual(proc.bridgeRun.pendingIds().sort(), [calls[0].key, calls[1].key].sort());
	proc.resolveTool(calls[1].key, textResult("RB")); // 后发的先回
	proc.resolveTool(calls[0].key, textResult("RA"));
	await until(() => resultsOf(items).length === 1, "result");
	assert.equal(textOf(items), "同时查两个。got:RA|RB");
	proc.shutdown();
	await proc.done;
});

test("agy 自己掐断工具（notifications/cancelled）：挂起的调用返回已取消，之后回填被忽略，模型继续", async () => {
	const { proc, items } = start("tool-timeout", { collectMs: 20 });
	await until(() => resultsOf(items).length === 1, "result");
	assert.match(textOf(items), /^tool-cancelled:已取消$/);
	const call = items.find((i) => i.type === "tool_call") as Extract<AgyItem, { type: "tool_call" }>;
	assert.equal(proc.resolveTool(call.key, textResult("late")), false);
	assert.ok(items.some((i) => i.type === "tool_step" && i.state === "ERROR"));
	proc.shutdown();
	await proc.done;
});

test("abort：挂起的工具返回已取消、发 SIGINT、agy 以 interrupted 结束，进程退出、运行目录删掉", async () => {
	const before = toolBridge.size;
	const { proc, items, exits } = start("hang", { collectMs: 20 });
	await until(() => items.some((i) => i.type === "tools_ready"), "tools_ready");
	const dir = proc.runDir!;
	proc.abort();
	const exit = await proc.done;
	assert.equal(exit.aborted, true);
	assert.equal(exit.signal === "SIGINT" || exit.code === 1, true, `被 SIGINT 中断：${exit.code}/${exit.signal}`);
	assert.deepEqual(resultsOf(items).map((r) => [r.isError, r.text]), [[true, "interrupted"]]);
	assert.equal(exits.length, 1);
	assert.equal(existsSync(dir), false);
	assert.equal(toolBridge.size, before);
	assert.equal(proc.resolveTool("1", textResult("x")), false);
});

test("空闲到时自己退出（关 stdin），标记 idle；detach 之后才开始计时", async () => {
	const { proc, items } = start("text", { idleMs: 150 });
	await until(() => resultsOf(items).length === 1, "result");
	await sleep(250);
	assert.equal(proc.dead, false, "这一轮还没 detach，不计空闲");
	// 重新 attach 再 detach：模拟一轮结束后释放
	const off = proc.attach({ onItem: () => {}, onExit: () => {} });
	off();
	const exit = await proc.done;
	assert.equal(exit.idle, true);
	assert.equal(exit.code, 0);
	assert.equal(proc.runDir, undefined);
});

test("进程没起来（命令不存在）：done 带 spawnError，运行目录不残留", async () => {
	const before = readdirSync(runsRoot).length;
	const exits: AgyExit[] = [];
	const proc = new AgyProcess({ command: join(tmpdir(), "no-such-agy-cmd"), runsRoot, bridgeBaseUrl: baseUrl, tools, model: "m" });
	proc.attach({ onItem: () => {}, onExit: (x) => exits.push(x) });
	proc.start();
	const exit = await proc.done;
	assert.ok(exit.spawnError);
	assert.equal(exits.length, 1);
	assert.equal(readdirSync(runsRoot).length, before);
});

test("没起来的命令不是可执行文件时同样干净收尾（权限不足）", async () => {
	const file = join(runsRoot, "not-exec");
	writeFileSync(file, "x");
	chmodSync(file, 0o644);
	const proc = new AgyProcess({ command: file, runsRoot, bridgeBaseUrl: baseUrl, tools, model: "m" });
	proc.start();
	const exit = await proc.done;
	assert.ok(exit.spawnError);
});
