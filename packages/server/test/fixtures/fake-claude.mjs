#!/usr/bin/env node
// 假的 `claude`：只给单测用，绝不调用真实的 claude。
// 读 --mcp-config（内联 JSON 或文件），按环境变量 FAKE_CLAUDE_SCENARIO 输出 stream-json，
// 并像真的 claude 一样通过 HTTP 调工具桥的 MCP（tools/call 带 _meta["claudecode/toolUseId"]）。
// 场景：text | env-dump | not-logged-in | two-tools | cancel | hang | interject
//       | meta（回报收到的参数和首条消息）| one-tool | bash-approval（调 Pi 的 bash，e2e 走审批卡）| tool-interject | stall | resume-missing | image-tool | think
// 另外支持 `--version`、`auth status`（FAKE_CLAUDE_LOGGED_IN=0 时模拟未登录，退出码 1）。
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (argv[0] === "--version") {
	console.log("2.1.293 (Claude Code)");
	process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
	const ok = process.env.FAKE_CLAUDE_LOGGED_IN !== "0";
	console.log(JSON.stringify({ loggedIn: ok, authMethod: ok ? "claude.ai" : "none", apiProvider: "firstParty" }));
	process.exit(ok ? 0 : 1);
}

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "text";
const resumeId = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : null;
const sessionId = resumeId ?? `fake-session-${process.pid}`;
const cfgArg = argv[argv.indexOf("--mcp-config") + 1];
const cfg = JSON.parse(readFileSync(cfgArg, "utf8")); // 真的 claude 也是读文件：令牌不放命令行
const bridge = cfg.mcpServers.pia;

// ---- 读 stdin 的用户消息（首条消息和插话）
const queue = [];
const waiters = [];
createInterface({ input: process.stdin }).on("line", (line) => {
	let m;
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	if (m.type !== "user") return;
	const c = m.message.content;
	const text = typeof c === "string" ? c : c.map((b) => (b.type === "image" ? `[image:${b.source?.media_type}]` : (b.text ?? ""))).join("");
	const w = waiters.shift();
	if (w) w(text);
	else queue.push(text);
});
const nextUser = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));

// ---- MCP（streamable HTTP，POST）
let rpcId = 0;
async function rpc(method, params, { id, signal } = {}) {
	const body = id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: id ?? ++rpcId, method, params };
	const res = await fetch(bridge.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...bridge.headers }, body: JSON.stringify(body), signal });
	if (res.status === 202) return null;
	if (!res.ok) throw new Error(`bridge HTTP ${res.status}`);
	return res.json();
}
async function handshake() {
	await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
	await rpc("notifications/initialized", undefined, { id: null });
	const list = await rpc("tools/list", {});
	return list.result.tools.map((t) => `mcp__pia__${t.name}`);
}
const callTool = (toolUseId, name, args, opts) => rpc("tools/call", { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId, progressToken: toolUseId } }, opts);

// ---- 输出 stream-json
const se = (event) => out({ type: "stream_event", event, session_id: sessionId });
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
function init(tools) {
	out({ type: "system", subtype: "init", session_id: sessionId, tools, model: "claude-sonnet-5", mcp_servers: [{ name: "pia", status: "connected" }] });
	out({ type: "system", subtype: "status", status: "requesting", session_id: sessionId });
}
function streamText(text) {
	se({ type: "message_start", message: { id: "msg_t", usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } });
	se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	for (const part of text.match(/.{1,6}/gs) ?? []) se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
	se({ type: "content_block_stop", index: 0 });
	se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
	se({ type: "message_stop" });
}
const result = (text, isError = false) =>
	out({ type: "result", subtype: "success", is_error: isError, stop_reason: "end_turn", result: text, session_id: sessionId, total_cost_usd: 0.01, usage });
function streamToolUses(calls) {
	se({ type: "message_start", message: { id: "msg_tools", usage: { input_tokens: 100, output_tokens: 0 } } });
	calls.forEach((c, i) => se({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: `mcp__pia__${c.name}`, input: {} } }));
	calls.forEach((c, i) => {
		const json = JSON.stringify(c.args);
		se({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(0, 4) } });
		se({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(4) } });
		se({ type: "content_block_stop", index: i });
	});
	se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 16 } });
	se({ type: "message_stop" });
}
const toolResultLine = (id, text, isError = false) =>
	out({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", ...(isError ? { is_error: true } : {}), content: [{ type: "text", text }] }] } });
const textOfResult = (r) => r?.result?.content?.map((b) => (b.type === "image" ? `[image:${b.mimeType}]` : b.text)).join("") ?? `error:${JSON.stringify(r?.error)}`;

const first = await nextUser();

if (scenario === "not-logged-in") {
	out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: sessionId, terminal_reason: "api_error", usage });
	process.exit(1);
}
if (scenario === "env-dump") {
	init([]);
	const flagValue = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
	const sp = flagValue("--system-prompt-file") ?? flagValue("--append-system-prompt-file");
	const mode = (p) => (statSync(p).mode & 0o777).toString(8);
	const files = {
		dir: dirname(cfgArg),
		dirMode: mode(dirname(cfgArg)),
		mcpConfig: cfgArg,
		mcpConfigMode: mode(cfgArg),
		mcpConfigText: readFileSync(cfgArg, "utf8"),
		systemPrompt: sp,
		systemPromptMode: sp ? mode(sp) : null,
		systemPromptText: sp ? readFileSync(sp, "utf8") : null,
	};
	result(JSON.stringify({ env: process.env, argv, cwd: process.cwd(), files }));
	process.exit(0);
}

const tools = await handshake();
init(tools);

if (scenario === "text") {
	streamText(`你好，收到：${first}`);
	result(`你好，收到：${first}`);
} else if (scenario === "two-tools") {
	streamToolUses([
		{ id: "toolu_A", name: "echo", args: { text: "a" } },
		{ id: "toolu_B", name: "echo", args: { text: "b" } },
	]);
	await sleep(150); // 让测试有机会在 tools/call 之前就回填（结果先到）
	const [ra, rb] = await Promise.all([callTool("toolu_A", "echo", { text: "a" }), callTool("toolu_B", "echo", { text: "b" })]);
	toolResultLine("toolu_A", textOfResult(ra));
	toolResultLine("toolu_B", textOfResult(rb));
	const final = `A=${textOfResult(ra)};B=${textOfResult(rb)}`;
	streamText(final);
	result(final);
} else if (scenario === "cancel") {
	streamToolUses([{ id: "toolu_C", name: "wait", args: {} }]);
	const ac = new AbortController();
	const id = ++rpcId;
	const p = callTool("toolu_C", "wait", {}, { id, signal: ac.signal }).catch(() => null);
	await sleep(200);
	ac.abort(); // 真的 claude 超时就是这样：断开请求，再发 notifications/cancelled
	await p;
	await rpc("notifications/cancelled", { requestId: id, reason: "timeout" }, { id: null });
	toolResultLine("toolu_C", "The operation timed out.", true);
	result("cancel-done");
} else if (scenario === "hang") {
	streamToolUses([{ id: "toolu_H", name: "wait", args: {} }]);
	const r = await callTool("toolu_H", "wait", {}).catch((e) => ({ error: String(e) }));
	result(`hang-returned:${textOfResult(r)}`);
} else if (scenario === "interject") {
	streamText("working");
	const second = await nextUser();
	result(`first:${first}|second:${second}`);
} else if (scenario === "meta") {
	const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
	const sp = flag("--system-prompt-file");
	const info = JSON.stringify({ resume: resumeId, first, model: flag("--model"), effort: flag("--effort"), noPersist: argv.includes("--no-session-persistence"), systemPrompt: sp ? readFileSync(sp, "utf8") : null, tools });
	streamText(info);
	result(info);
} else if (scenario === "think") {
	se({ type: "message_start", message: { id: "msg_k", usage: { input_tokens: 10, output_tokens: 0 } } });
	se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
	se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先想一想" } });
	se({ type: "content_block_stop", index: 0 });
	se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
	se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "想好了" } });
	se({ type: "content_block_stop", index: 1 });
	se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
	se({ type: "message_stop" });
	result("想好了");
} else if (scenario === "one-tool" || scenario === "tool-interject" || scenario === "image-tool" || scenario === "bash-approval") {
	// 先说一句话再调一个工具，等 Pi 回填结果后继续（tool-interject：之后还等一条插话；image-tool：只看结果里有没有图）
	se({ type: "message_start", message: { id: "msg_one", usage: { input_tokens: 100, output_tokens: 0 } } });
	se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我来查一下。" } });
	se({ type: "content_block_stop", index: 0 });
	// bash-approval：调 Pi 的 bash（e2e 里会走审批卡），其余场景调测试里挂的 echo
	const [toolName, toolArgs] = scenario === "bash-approval" ? ["bash", { command: "rm -f old-notes.txt && echo 已删除 old-notes.txt" }] : ["echo", { text: "hi" }];
	se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: `mcp__pia__${toolName}`, input: {} } });
	se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolArgs) } });
	se({ type: "content_block_stop", index: 1 });
	se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 16 } });
	se({ type: "message_stop" });
	const r = await callTool("toolu_1", toolName, toolArgs);
	toolResultLine("toolu_1", textOfResult(r));
	let final = `got:${textOfResult(r)}`;
	if (scenario === "tool-interject") final += `|extra:${await nextUser()}`;
	streamText(final);
	result(final);
} else if (scenario === "stall") {
	se({ type: "message_start", message: { id: "msg_s", usage: { input_tokens: 10, output_tokens: 0 } } });
	se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "说到一半" } });
	await sleep(60_000);
	result("never");
} else if (scenario === "resume-missing") {
	if (resumeId) result(`No conversation found with session ID: ${resumeId}`, true);
	else {
		streamText("新会话");
		result("新会话");
	}
} else {
	result(`unknown scenario ${scenario}`, true);
}
process.exit(0);
