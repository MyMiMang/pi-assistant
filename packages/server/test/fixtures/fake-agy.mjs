#!/usr/bin/env node
// 假的 `agy`（Antigravity CLI）：只给单测 / e2e 用，绝不调用真实的 agy。
// 读运行目录（cwd）里的 `.agents/plugins/pia/mcp_config.json`，像真的 agy 一样以 MCP 客户端身份通过 HTTP 调工具桥
//（先发非标准的 server/discover，再 initialize / tools/list；tools/call 带 progressToken `<uuid>:<step_index>`），
// 长驻：stdin 每行 `{"event":"user","message":{"content":"…"}}` 一轮，按场景输出 NDJSON（init / step_update / result）。
// 场景取自 FAKE_AGY_SCENARIO_FILE（每轮重读，e2e 里中途切换）或 FAKE_AGY_SCENARIO：
//   text | one-tool | two-tools | bash-approval（调 Pi 的 bash，e2e 走审批卡）| meta（回报收到的参数和首条消息）| env-dump（回报运行目录文件）
//   | hang（调工具后一直等，SIGINT 才结束）| tool-timeout（agy 自己掐断工具）| error（result 报错）| not-logged-in | resume-missing | crash
// 另外支持 `--version`、`models`（FAKE_AGY_LOGGED_IN=0 或脚本旁有 agy-logged-out 文件时模拟未登录，退出码 1）。FAKE_AGY_LOG=<文件> 时每次启动追加一行 JSON。
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv[0] === "--version") {
	console.log("1.4.7");
	process.exit(0);
}
if (argv[0] === "models") {
	// 服务进程的环境白名单会挡掉自定义变量：也认「脚本旁边有 agy-logged-out 文件」
	if (process.env.FAKE_AGY_LOGGED_IN === "0" || existsSync(join(dirname(process.argv[1]), "agy-logged-out"))) {
		console.error("Error: Please sign in to view available models.");
		process.exit(1);
	}
	console.log("Fetching available models...");
	for (const [id, name] of [
		["claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"],
		["claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"],
		["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
		["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
		["gemini-4-argon-high", "Gemini 4 Argon (High)"],
		["gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"],
	])
		console.log(`${id}\t${name}`);
	process.exit(0);
}
const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const conversationArg = flag("--conversation");
const conversationId = conversationArg ?? `fake-conv-${process.pid}-${Date.now().toString(36)}`;
const scenarioOf = () => {
	const f = process.env.FAKE_AGY_SCENARIO_FILE;
	if (f) {
		try {
			return readFileSync(f, "utf8").trim() || "text";
		} catch {}
	}
	return process.env.FAKE_AGY_SCENARIO ?? "text";
};
if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ pid: process.pid, argv, conversation: conversationArg, model: flag("--model") })}\n`);

const cfgPath = join(process.cwd(), ".agents", "plugins", "pia", "mcp_config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8")); // 真的 agy 也是读文件：令牌不放命令行
const bridge = cfg.mcpServers.pia;

// ---- MCP（streamable HTTP，POST）
let rpcId = 0;
async function rpc(method, params, { id, expectError } = {}) {
	const body = id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: id ?? ++rpcId, method, params };
	const res = await fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...bridge.headers }, body: JSON.stringify(body) });
	if (res.status === 202) return null;
	if (!res.ok && !expectError) throw new Error(`bridge HTTP ${res.status}`);
	return res.json();
}
async function handshake() {
	await rpc("server/discover", {}, { expectError: true }); // 非标准请求：桥回「方法不存在」，不影响后面
	await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "antigravity-client", version: "v1.0.0" } });
	await rpc("notifications/initialized", undefined, { id: null });
	const list = await rpc("tools/list", {});
	return list.result.tools;
}

let step = 0;
const stepUpdate = (s) => out({ event: "step_update", step_update: { conversation_id: conversationId, ...s } });
const usage = { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 30, total_tokens: 120 };
function respond(text) {
	const idx = step++;
	for (const part of text.match(/.{1,8}/gs) ?? [""]) stepUpdate({ step_index: idx, state: "ACTIVE", step_type: "agent_response", text_delta: part });
	stepUpdate({ step_index: idx, state: "DONE", step_type: "agent_response", text_delta: "\n", duration_seconds: 0.1, usage });
}
const resultOk = (text, turns = 1) => out({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: `${text}\n`, duration_seconds: 0.5, num_turns: turns, usage: { input_tokens: 200, output_tokens: 40, thinking_tokens: 0, cache_read_tokens: 60, total_tokens: 240 } } });
const resultErr = (error) => out({ event: "result", result: { conversation_id: conversationId, status: "ERROR", error, duration_seconds: 0.1, num_turns: 1, usage: {} } });
const toolName = (n) => `mcp_pia_pia_${n}`;
const textOfResult = (r) => r?.result?.content?.map((b) => (b.type === "image" ? `[image:${b.mimeType}]` : b.text)).join("") ?? `error:${JSON.stringify(r?.error)}`;
/** 一次工具调用：stdout 的 tool 步骤 + 对工具桥的 tools/call（progressToken 末段 = step_index） */
function startTool(name, args) {
	const idx = step++;
	stepUpdate({ step_index: idx, state: "ACTIVE", step_type: "tool", tool_name: toolName(name), tool_info: { name: toolName(name), parameters: args } });
	const rid = ++rpcId;
	const promise = rpc("tools/call", { name, arguments: args, _meta: { progressToken: `00000000-aaaa-bbbb-cccc-dddddddddddd:${idx}`, "antigravity.google/conversation_id": conversationId } }, { id: rid });
	return { idx, rid, name, args, promise };
}
const finishTool = (t, r) => stepUpdate({ step_index: t.idx, state: "DONE", step_type: "tool", tool_name: toolName(t.name), duration_seconds: 0.1, tool_info: { name: toolName(t.name), parameters: t.args, output: textOfResult(r) } });

process.on("SIGINT", () => {
	resultErr("interrupted");
	process.exit(1);
});

let tools = [];
async function turn(text, seq) {
	const scenario = scenarioOf();
	stepUpdate({ step_index: step++, state: "DONE", step_type: "user_input" });
	if (scenario === "not-logged-in") {
		resultErr("Error: Please sign in to continue.");
		process.exit(3);
	}
	if (scenario === "crash") {
		console.error("AGY_ERROR: boom");
		process.exit(2);
	}
	if (scenario === "error") return resultErr("模型出错了");
	if (scenario === "meta") {
		respond(JSON.stringify({ conversation: conversationArg, first: text, model: flag("--model"), agent: flag("--agent"), seq, argv, tools: tools.map((t) => t.name), alwaysLoad: tools.every((t) => t._meta?.["antigravity/alwaysLoad"] === true) }));
		return resultOk("meta");
	}
	if (scenario === "env-dump") {
		const mode = (p) => (statSync(p).mode & 0o777).toString(8);
		const dir = process.cwd();
		const agentPath = join(dir, ".agents", "agents", "pia.md");
		respond(
			JSON.stringify({
				dir,
				dirMode: mode(dir),
				mcpConfigMode: mode(cfgPath),
				mcpConfigText: readFileSync(cfgPath, "utf8"),
				agentMode: mode(agentPath),
				agentText: readFileSync(agentPath, "utf8"),
				pluginJson: readFileSync(join(dir, ".agents", "plugins", "pia", "plugin.json"), "utf8"),
				entries: readdirSync(dir),
				envKeys: Object.keys(process.env).sort(),
			}),
		);
		return resultOk("env");
	}
	if (scenario === "one-tool" || scenario === "bash-approval") {
		respond("我来查一下。");
		const [name, args] = scenario === "bash-approval" ? ["bash", { command: "rm -f old-notes.txt && echo 已删除 old-notes.txt" }] : ["echo", { text: "hi" }];
		const t = startTool(name, args);
		const r = await t.promise;
		finishTool(t, r);
		const final = `got:${textOfResult(r)}`;
		respond(final);
		return resultOk(final);
	}
	if (scenario === "two-tools") {
		respond("同时查两个。");
		const a = startTool("echo", { text: "A" });
		const b = startTool("echo", { text: "B" });
		const [ra, rb] = await Promise.all([a.promise, b.promise]);
		finishTool(a, ra);
		finishTool(b, rb);
		const final = `got:${textOfResult(ra)}|${textOfResult(rb)}`;
		respond(final);
		return resultOk(final);
	}
	if (scenario === "tool-timeout") {
		const t = startTool("echo", { text: "slow" });
		await sleep(200);
		// agy 自己的超时：对桥发 notifications/cancelled，tool 步骤报 ERROR，模型据此继续
		await rpc("notifications/cancelled", { requestId: t.rid, reason: "timeout" }, { id: null });
		stepUpdate({ step_index: t.idx, state: "ERROR", step_type: "tool", tool_name: toolName("echo"), tool_info: { name: toolName("echo"), parameters: t.args } });
		const r = await t.promise;
		respond(`tool-cancelled:${textOfResult(r)}`);
		return resultOk("timeout");
	}
	if (scenario === "hang") {
		const t = startTool("echo", { text: "wait" });
		await t.promise; // abort 时桥回「已取消」
		await sleep(60_000); // 等 SIGINT
		return;
	}
	// text：回一句话
	const final = `你好，收到：${text}`;
	respond(final);
	resultOk(final);
}

if (scenarioOf() === "resume-missing" && conversationArg) {
	console.error("AGY_ERROR: conversation not found");
	process.exit(3);
}
tools = await handshake();
out({ event: "init", conversation_id: conversationId, init: { model: flag("--model"), cwd: process.cwd(), agent: flag("--agent"), permission_mode: "request-review", tools: ["list_resources"] } });

// 一条消息一轮，按顺序执行；stdin 关闭后收摊退出
let chain = Promise.resolve();
let seq = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
	let m;
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	if (m.event !== "user") return; // 别的 event 值被静默忽略（和真 agy 一致）
	const text = typeof m.message?.content === "string" ? m.message.content : "";
	chain = chain.then(() => turn(text, ++seq)).catch((e) => console.error(String(e)));
}).on("close", () => chain.then(() => process.exit(0)));
