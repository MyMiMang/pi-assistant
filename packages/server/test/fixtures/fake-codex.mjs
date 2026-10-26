#!/usr/bin/env node
// 假的 `codex`：只给单测 / e2e 用，绝不调用真实的 codex。
// 支持 `--version`、`login status`（CODEX_HOME 下有 logged-out 文件（或 FAKE_CODEX_LOGGED_IN=0）时退出码 1）、`app-server`（JSON-RPC over stdio）。
// 环境变量：FAKE_CODEX_SCENARIO / FAKE_CODEX_SCENARIO_FILE（场景；文件优先，每轮重新读）、FAKE_CODEX_MCP（假装用户配置里有这些 MCP，逗号分隔）、
// FAKE_CODEX_ARGS_FILE（每次 app-server 启动把 argv 追加一行 JSON）、FAKE_CODEX_STATE（线程表存放的 JSON 文件，跨进程续用）、
// FAKE_CODEX_LOG（每个请求追加一行 JSON，单测看收到了什么）。
// 场景：text | one-tool | meta | hang | steer | not-logged-in | crash | server-requests | image-tool | think | e2e-bash
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
	console.log("codex-cli 0.161.0");
	process.exit(0);
}
if (argv[0] === "login" && argv[1] === "status") {
	// 环境白名单会挡掉自定义变量；CODEX_HOME 放行，所以用「该目录下有 logged-out 文件」表示未登录
	const ok = process.env.FAKE_CODEX_LOGGED_IN !== "0" && !(process.env.CODEX_HOME && existsSync(join(process.env.CODEX_HOME, "logged-out")));
	console.log(ok ? "Logged in using ChatGPT" : "Not logged in");
	process.exit(ok ? 0 : 1);
}
if (argv[0] !== "app-server") process.exit(2);

const mcp = (process.env.FAKE_CODEX_MCP ?? "").split(",").filter(Boolean);
// 真的 codex 对不存在的 MCP 写 enabled=false 会让 initialize 永远不回；假的照做
for (let i = 0; i < argv.length; i++) {
	const m = /^mcp_servers\.(?:"([^"]+)"|([^.]+))\.enabled=false$/.exec(argv[i + 1] ?? "");
	if (argv[i] === "-c" && m && !mcp.includes(m[1] ?? m[2])) setInterval(() => {}, 1000);
}
if (process.env.FAKE_CODEX_ARGS_FILE) appendFileSync(process.env.FAKE_CODEX_ARGS_FILE, `${JSON.stringify(argv)}\n`);
const log = (o) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(o)}\n`);

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 常驻进程里场景要能中途换：优先读 FAKE_CODEX_SCENARIO_FILE
const scenario = () => (process.env.FAKE_CODEX_SCENARIO_FILE && existsSync(process.env.FAKE_CODEX_SCENARIO_FILE) ? readFileSync(process.env.FAKE_CODEX_SCENARIO_FILE, "utf8").trim() : (process.env.FAKE_CODEX_SCENARIO ?? "text"));
const stateFile = process.env.FAKE_CODEX_STATE;
const threads = new Map(stateFile && existsSync(stateFile) ? Object.entries(JSON.parse(readFileSync(stateFile, "utf8"))) : []);
const saveThreads = () => stateFile && writeFileSync(stateFile, JSON.stringify(Object.fromEntries(threads)));
const loaded = new Set();
let nextTid = 1;
let nextTurn = 1;
let nextReq = 1000;
const serverReqs = new Map();
const steers = [];
const turns = new Map(); // turnId -> { threadId, interrupted }

const textOfInput = (input) => input.map((i) => (i.type === "text" ? i.text : i.type === "image" ? `[image:${i.url.slice(5, i.url.indexOf(";"))}]` : "")).join("");
const serverRequest = (method, params) => new Promise((resolve) => {
	const id = nextReq++;
	serverReqs.set(id, resolve);
	out({ id, method, params });
});
const note = (method, params) => out({ method, params });
const usage = { totalTokens: 127, inputTokens: 100, cachedInputTokens: 3, cacheWriteInputTokens: 4, outputTokens: 20, reasoningOutputTokens: 5 };
const tokenUsage = (threadId, turnId) => note("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: usage, last: usage, modelContextWindow: 258400 } });
async function say(threadId, turnId, itemId, text) {
	note("item/started", { threadId, turnId, item: { type: "agentMessage", id: itemId, text: "" } });
	for (const part of text.match(/.{1,6}/gs) ?? []) note("item/agentMessage/delta", { threadId, turnId, itemId, delta: part });
	note("item/completed", { threadId, turnId, item: { type: "agentMessage", id: itemId, text } });
}
function think(threadId, turnId, text) {
	note("item/started", { threadId, turnId, item: { type: "reasoning", id: "rs_1", summary: [], content: [] } });
	note("item/reasoning/summaryTextDelta", { threadId, turnId, itemId: "rs_1", delta: text, summaryIndex: 0 });
	note("item/completed", { threadId, turnId, item: { type: "reasoning", id: "rs_1", summary: [text], content: [] } });
}
const end = (threadId, turnId, status = "completed", error = null) => {
	note("thread/status/changed", { threadId, status: { type: "idle" } });
	note("turn/completed", { threadId, turn: { id: turnId, items: [], status, error: error ? { message: error } : null } });
};
async function callTool(threadId, turnId, tool, args, callId) {
	note("item/started", { threadId, turnId, item: { type: "dynamicToolCall", id: callId, tool, arguments: args, status: "inProgress" } });
	const res = await serverRequest("item/tool/call", { threadId, turnId, callId, namespace: null, tool, arguments: args });
	return res;
}
const resultText = (res) => (res?.contentItems ?? []).map((c) => (c.type === "inputText" ? c.text : "[img]")).join("");

async function runTurn(threadId, turnId, input) {
	const t = threads.get(threadId);
	const user = textOfInput(input);
	const tools = t.tools ?? [];
	note("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
	note("turn/started", { threadId, turn: { id: turnId, items: [], status: "inProgress" } });
	const sc = scenario();
	const interrupted = () => turns.get(turnId)?.interrupted;
	if (sc === "crash") process.exit(1);
	if (sc === "not-logged-in") {
		note("error", { threadId, turnId, willRetry: false, error: { message: "Not logged in. Please run codex login" } });
		return end(threadId, turnId, "failed");
	}
	if (sc === "think") think(threadId, turnId, "先想一想");
	if (sc === "meta") {
		const body = { thread: threadId, resumed: t.resumed === true, model: t.model, effort: turns.get(turnId).effort, summary: turns.get(turnId).summary, tools: tools.map((x) => x.name), instructions: t.instructions, input: user, ephemeral: t.ephemeral === true, mcp, cwd: t.cwd, approvalPolicy: t.approvalPolicy, sandbox: t.sandbox };
		await say(threadId, turnId, "msg_1", JSON.stringify(body));
		tokenUsage(threadId, turnId);
		return end(threadId, turnId);
	}
	if (sc === "server-requests") {
		const a = await serverRequest("item/commandExecution/requestApproval", { threadId, turnId, itemId: "x", command: "rm -rf /" });
		const b = await serverRequest("item/tool/requestUserInput", { threadId, turnId, itemId: "y", questions: [] });
		await say(threadId, turnId, "msg_1", `approval:${JSON.stringify(a)} input:${JSON.stringify(b)}`);
		tokenUsage(threadId, turnId);
		return end(threadId, turnId);
	}
	if (["one-tool", "hang", "steer", "image-tool", "e2e-bash"].includes(sc)) {
		await say(threadId, turnId, "msg_0", "我来调工具。");
		const name = sc === "e2e-bash" ? "bash" : (tools.find((x) => x.name === "echo") ? "echo" : tools[0]?.name ?? "echo");
		const args = sc === "e2e-bash" ? { command: "rm -f old-notes.txt && echo 已删除 old-notes.txt" } : { text: "hi" };
		const res = await callTool(threadId, turnId, name, args, `call_${turnId}_1`);
		tokenUsage(threadId, turnId);
		if (interrupted()) return end(threadId, turnId, "interrupted");
		const extra = steers.length ? ` steered:${steers.map((s) => textOfInput(s)).join("|")}` : "";
		await say(threadId, turnId, "msg_1", `got:${resultText(res)}${extra}`);
		tokenUsage(threadId, turnId);
		return end(threadId, turnId);
	}
	await say(threadId, turnId, "msg_1", `你好，收到：${user}`);
	tokenUsage(threadId, turnId);
	return end(threadId, turnId);
}

const handlers = {
	initialize: () => ({ userAgent: "fake/0.161.0", codexHome: "/tmp/fake", platformFamily: "unix", platformOs: "macos" }),
	"config/read": () => ({ config: { model: "x", ...(mcp.length ? { mcp_servers: Object.fromEntries(mcp.map((n) => [n, { command: "x" }])) } : {}) }, origins: {} }),
	"model/list": () => ({
		data: [
			{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", hidden: false, isDefault: true, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort, description: "" })), inputModalities: ["text", "image"] },
			{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6-Luna", hidden: false, isDefault: false, supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: "" })), inputModalities: ["text"] },
			{ id: "hidden-one", model: "hidden-one", displayName: "Hidden", hidden: true, isDefault: false, supportedReasoningEfforts: [], inputModalities: ["text"] },
		],
		nextCursor: null,
	}),
	"thread/start": (p) => {
		const id = `thr_${process.pid}_${nextTid++}`;
		threads.set(id, { tools: p.dynamicTools ?? [], instructions: p.baseInstructions, model: p.model, ephemeral: p.ephemeral, cwd: p.cwd, approvalPolicy: p.approvalPolicy, sandbox: p.sandbox });
		loaded.add(id);
		saveThreads();
		return { thread: { id, ephemeral: p.ephemeral === true }, model: p.model };
	},
	"thread/resume": (p) => {
		const t = threads.get(p.threadId);
		if (!t) throw new Error(`no rollout found for thread id ${p.threadId}`);
		t.resumed = true;
		t.instructions = p.baseInstructions ?? t.instructions;
		t.model = p.model ?? t.model;
		loaded.add(p.threadId);
		return { thread: { id: p.threadId } };
	},
	"turn/start": (p) => {
		if (!loaded.has(p.threadId)) throw new Error("thread not loaded");
		const turnId = `turn_${nextTurn++}`;
		turns.set(turnId, { threadId: p.threadId, interrupted: false, effort: p.effort ?? null, summary: p.summary ?? null });
		steers.length = 0;
		setTimeout(() => void runTurn(p.threadId, turnId, p.input), 5);
		return { turn: { id: turnId, items: [], status: "inProgress" } };
	},
	"turn/steer": (p) => {
		if (!turns.has(p.expectedTurnId)) throw new Error("expectedTurnId mismatch");
		steers.push(p.input);
		return { turnId: p.expectedTurnId };
	},
	"turn/interrupt": (p) => {
		const t = turns.get(p.turnId);
		if (t) t.interrupted = true;
		setTimeout(() => {
			for (const [id, r] of serverReqs) {
				serverReqs.delete(id);
				r(undefined);
			}
			if (scenario() === "hang") end(p.threadId, p.turnId, "interrupted");
		}, 20);
		return {};
	},
	"thread/unsubscribe": () => ({}),
};

createInterface({ input: process.stdin }).on("line", (line) => {
	let m;
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	if (m.id !== undefined && m.method === undefined) {
		const r = serverReqs.get(m.id);
		serverReqs.delete(m.id);
		log({ response: m.id, result: m.result, error: m.error });
		r?.(m.error ? { error: m.error } : m.result);
		return;
	}
	if (m.id === undefined) return; // initialized 等通知
	log({ method: m.method, params: m.params });
	const h = handlers[m.method];
	try {
		if (!h) throw new Error(`unknown method ${m.method}`);
		out({ id: m.id, result: h(m.params ?? {}) });
	} catch (e) {
		out({ id: m.id, error: { code: -32000, message: e.message } });
	}
});
process.stdin.on("end", () => process.exit(0));
