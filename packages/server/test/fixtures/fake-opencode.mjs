#!/usr/bin/env node
// 假的 `opencode`：只给单测 / e2e 用，绝不调用真实的 opencode，不联网、不花钱。
// 支持：`--version`、`models --verbose`（真实输出的形状：`<provider>/<model>` 一行 + 一段 JSON）、`acp --cwd <目录>`（ACP：JSON-RPC over stdio）。
// `acp` 像真的一样：读 OPENCODE_CONFIG 指的配置文件（里面有系统提示）、以 MCP 客户端身份通过 http 调 `session/new` 给的工具桥
//（Authorization 头从 mcpServers[].headers 数组里取；tools/call 不带任何可配对的 id，只有 MCP 请求 id），ACP 的 tool_call 通知先于 MCP 请求。
// 场景取自 FAKE_OPENCODE_SCENARIO_FILE（每轮重读，e2e 里中途切换）或 FAKE_OPENCODE_SCENARIO：
//   text | one-tool | bash-approval（调 Pi 的 bash，e2e 走审批卡）| two-tools（并行，MCP 到达顺序和 ACP 通知相反）| two-tools-late（第二个 MCP 请求晚 150 毫秒）
//   | meta（回报收到的提示 / 模型 / 思考强度 / mcpServers）| env-dump（回报配置文件和环境）| permission（向客户端要一次权限）
//   | hang（调工具后一直等，session/cancel 才结束）| hang-text（一直说话，session/cancel 才结束）| error | not-logged-in | resume-missing（session/resume 报找不到，其余同 meta）| bad-model | crash
// FAKE_OPENCODE_LOG=<文件> 时每次 `acp` 启动追加一行 JSON。
import { appendFileSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);

const MODELS = [
	{ ref: "opencode/beam-free", name: "Beam Free", provider: "opencode", free: true, efforts: ["low", "medium", "high"], image: false, tools: true },
	{ ref: "opencode/claude-fable-5", name: "Claude Fable 5", provider: "opencode", free: false, efforts: ["low", "high", "max"], image: true, tools: true },
	{ ref: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "opencode-go", free: false, efforts: ["low", "high", "max"], image: true, tools: true },
	{ ref: "opencode-go/mimo-v2.5-pro", name: "MiMo V2.5 Pro", provider: "opencode-go", free: false, efforts: [], image: false, tools: true },
	{ ref: "opencode/no-tools-model", name: "No Tools", provider: "opencode", free: true, efforts: [], image: false, tools: false },
];

if (argv[0] === "--version") {
	console.log("1.18.35");
	process.exit(0);
}
if (argv[0] === "models") {
	for (const m of MODELS) {
		console.log(m.ref);
		console.log(
			JSON.stringify(
				{
					id: m.ref.split("/")[1],
					providerID: m.provider,
					name: m.name,
					status: "active",
					cost: m.free ? { input: 0, output: 0, cache: { read: 0, write: 0 } } : { input: 1, output: 5, cache: { read: 0.1, write: 1 } },
					limit: { context: 200000, output: 32000 },
					capabilities: { toolcall: m.tools, reasoning: m.efforts.length > 0, input: { text: true, image: m.image } },
					variants: Object.fromEntries(m.efforts.map((e) => [e, { reasoningEffort: e }])),
				},
				null,
				2,
			),
		);
	}
	process.exit(0);
}
if (argv[0] !== "acp") {
	console.error(`unknown command: ${argv.join(" ")}`);
	process.exit(2);
}

const cwd = argv.includes("--cwd") ? argv[argv.indexOf("--cwd") + 1] : process.cwd();
const scenarioOf = () => {
	const f = process.env.FAKE_OPENCODE_SCENARIO_FILE;
	if (f) {
		try {
			return readFileSync(f, "utf8").trim() || "text";
		} catch {}
	}
	return process.env.FAKE_OPENCODE_SCENARIO ?? "text";
};
const configPath = process.env.OPENCODE_CONFIG;
const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {}; // 真的 opencode 也是读文件：系统提示不放命令行 / 环境变量
if (process.env.FAKE_OPENCODE_LOG) appendFileSync(process.env.FAKE_OPENCODE_LOG, `${JSON.stringify({ pid: process.pid, argv, cwd: process.cwd(), configPath, prompt: config.agent?.build?.prompt })}\n`);

// ---- 会话状态
const sessions = new Map(); // sessionId -> { model, effort, mcp }
let nextSession = 1;
let seq = 0;
let cancelled = false;
let wakeCancel = () => {};
const cancelPromise = () => new Promise((r) => (wakeCancel = r));

const configOptions = (s) => {
	const m = MODELS.find((x) => x.ref === s.model);
	return [
		{ id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: MODELS.filter((x) => x.tools).map((x) => ({ value: x.ref, name: x.name })) },
		...(m && m.efforts.length ? [{ id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: s.effort, options: [...m.efforts, "default"].map((v) => ({ value: v, name: v })) }] : []),
		{ id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }] },
	];
};

// ---- MCP（streamable HTTP，POST；每个会话一个客户端）
async function mcpClient(server) {
	const headers = Object.fromEntries((server.headers ?? []).map((h) => [h.name, h.value]));
	let id = 0;
	// 每个请求一条新连接（agent:false）：Node 自带的 fetch 在已有请求挂着时，第二条连接会被拖慢约 250 毫秒，会把「并行调用晚到」搅成别的问题
	const post = (body) =>
		new Promise((resolve, reject) => {
			const data = JSON.stringify(body);
			const req = http.request(server.url, { method: "POST", agent: false, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(data), ...headers } }, (res) => {
				let out = "";
				res.on("data", (c) => (out += c));
				res.on("end", () => (res.statusCode === 202 ? resolve(null) : res.statusCode >= 400 ? reject(new Error(`bridge HTTP ${res.statusCode}`)) : resolve(JSON.parse(out))));
			});
			req.on("error", reject);
			req.end(data);
		});
	const rpc = (method, params, notify = false) => post(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params });
	await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode", version: "1.18.35" } });
	await rpc("notifications/initialized", undefined, true);
	const list = await rpc("tools/list", {});
	return { tools: list.result.tools, call: (name, args) => rpc("tools/call", { name, arguments: args }) };
}
const textOfResult = (r) => r?.result?.content?.map((b) => (b.type === "image" ? `[image:${b.mimeType}]` : b.text)).join("") ?? `error:${JSON.stringify(r?.error)}`;

// ---- 一轮
const usage = { inputTokens: 100, outputTokens: 20, thoughtTokens: 5, cachedReadTokens: 30, totalTokens: 155 };
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const say = async (sessionId, text) => {
	for (const part of text.match(/.{1,8}/gs) ?? []) update(sessionId, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: part } });
};
const announce = (sessionId, name, n) => update(sessionId, { sessionUpdate: "tool_call", toolCallId: `call_${n}_${seq}`, title: `pia_${name}`, kind: "other", status: "pending", locations: [], rawInput: {} });
const finish = (sessionId, stopReason = "end_turn") => {
	update(sessionId, { sessionUpdate: "usage_update", used: 130, size: 200000, cost: { amount: 0.001, currency: "USD" } });
	return { stopReason, usage, _meta: {} };
};

const pending = new Map();
async function prompt(sessionId, blocks) {
	const s = sessions.get(sessionId);
	const scenario = scenarioOf();
	const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
	seq++;
	cancelled = false;
	if (scenario === "error") throw Object.assign(new Error("模型出错了"), { code: -32603 });
	if (scenario === "not-logged-in") throw Object.assign(new Error("Authentication failed: no credentials (401)"), { code: -32603 });
	if (scenario === "crash") {
		console.error("OPENCODE_ERROR: boom");
		process.exit(2);
	}
	if (scenario === "meta" || scenario === "resume-missing") {
		update(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "m0", content: { type: "text", text: "先看看提示" } });
		await say(sessionId, JSON.stringify({ first: text, blocks: blocks.map((b) => b.type), model: s.model, effort: s.effort, sessionId, seq, tools: s.tools, mcp: s.mcpDesc, cwd: process.cwd(), argv }));
		return finish(sessionId);
	}
	if (scenario === "env-dump") {
		const dirOfConfig = dirname(configPath);
		await say(
			sessionId,
			JSON.stringify({
				configPath,
				dirMode: (statSync(dirOfConfig).mode & 0o777).toString(8),
				configMode: (statSync(configPath).mode & 0o777).toString(8),
				configText: readFileSync(configPath, "utf8"),
				envKeys: Object.keys(process.env).sort(),
				xdgConfig: process.env.XDG_CONFIG_HOME,
				flags: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("OPENCODE_"))),
				argv,
			}),
		);
		return finish(sessionId);
	}
	if (scenario === "permission") {
		const id = `perm-${seq}`;
		send({ id, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "x", title: "pia_echo" }, options: [{ optionId: "always", kind: "allow_always", name: "Always" }, { optionId: "once", kind: "allow_once", name: "Once" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
		const reply = await new Promise((r) => pending.set(id, r));
		await say(sessionId, `permission:${JSON.stringify(reply)}`);
		return finish(sessionId);
	}
	if (scenario === "hang-text") {
		const stop = cancelPromise();
		let go = true;
		void stop.then(() => (go = false));
		for (let i = 0; go && i < 400; i++) {
			await say(sessionId, "说说说说");
			await sleep(50);
		}
		return finish(sessionId, cancelled ? "cancelled" : "end_turn");
	}
	const client = s.mcp;
	if (scenario === "one-tool" || scenario === "bash-approval") {
		update(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "m0", content: { type: "text", text: "需要调用工具" } });
		await say(sessionId, "我来查一下。");
		const [name, args] = scenario === "bash-approval" ? ["bash", { command: "rm -f old-notes.txt && echo 已删除 old-notes.txt" }] : ["echo", { text: "hi" }];
		announce(sessionId, name, 0);
		const r = await client.call(name, args);
		await say(sessionId, `got:${textOfResult(r)}`);
		return finish(sessionId);
	}
	if (scenario === "two-tools" || scenario === "two-tools-late") {
		await say(sessionId, "同时查两个。");
		announce(sessionId, "echo", 0);
		announce(sessionId, "echo", 1);
		// MCP 请求的到达顺序和 ACP 通知相反（实测并行时就是这样）
		const b = client.call("echo", { text: "B" });
		if (scenario === "two-tools-late") await sleep(150);
		const a = client.call("echo", { text: "A" });
		const [rb, ra] = await Promise.all([b, a]);
		await say(sessionId, `got:${textOfResult(ra)}|${textOfResult(rb)}`);
		return finish(sessionId);
	}
	if (scenario === "hang") {
		const stop = cancelPromise();
		announce(sessionId, "echo", 0);
		const t = client.call("echo", { text: "wait" }); // 取消时桥回「已取消」
		await Promise.race([t, stop]);
		await stop;
		return finish(sessionId, "cancelled");
	}
	// text：回一句话（带思考）
	update(sessionId, { sessionUpdate: "agent_thought_chunk", messageId: "m0", content: { type: "text", text: "想一想" } });
	await say(sessionId, `你好，收到：${text}`);
	return finish(sessionId);
}

// ---- 请求分发
const reply = (id, result) => send({ id, result });
const fail = (id, e) => send({ id, error: { code: e.code ?? -32603, message: e.message } });
async function handle(m) {
	const p = m.params ?? {};
	switch (m.method) {
		case "initialize":
			return reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { resume: {} } }, authMethods: [], agentInfo: { name: "OpenCode", version: "1.18.35" } });
		case "session/new":
		case "session/resume": {
			if (m.method === "session/resume" && scenarioOf() === "resume-missing") return send({ id: m.id, error: { code: -32602, message: `Session ${p.sessionId} not found` } });
			const sessionId = m.method === "session/new" ? `ses_fake_${process.pid}_${nextSession++}` : p.sessionId;
			const s = sessions.get(sessionId) ?? { model: "opencode/beam-free", effort: "low" };
			const server = p.mcpServers?.[0];
			s.mcpDesc = server ? { type: server.type, name: server.name, urlPath: new URL(server.url).pathname.replace(/[0-9a-f]{16}$/, "<run>"), headerNames: (server.headers ?? []).map((h) => h.name), bearer: String(server.headers?.[0]?.value ?? "").startsWith("Bearer ") } : null;
			if (server) {
				const c = await mcpClient(server);
				s.mcp = c;
				s.tools = c.tools.map((t) => t.name);
			}
			sessions.set(sessionId, s);
			return reply(m.id, m.method === "session/new" ? { sessionId, configOptions: configOptions(s) } : { configOptions: configOptions(s) });
		}
		case "session/set_config_option": {
			const s = sessions.get(p.sessionId);
			if (!s) return send({ id: m.id, error: { code: -32602, message: "Session not found" } });
			if (p.configId === "model") {
				if (scenarioOf() === "bad-model" || !MODELS.some((x) => x.ref === p.value)) return send({ id: m.id, error: { code: -32602, message: `Model not found: ${p.value}` } });
				s.model = p.value;
				const m2 = MODELS.find((x) => x.ref === p.value);
				if (!m2.efforts.includes(s.effort)) s.effort = "default";
			} else if (p.configId === "effort") {
				const m2 = MODELS.find((x) => x.ref === s.model);
				if (![...m2.efforts, "default"].includes(p.value)) return send({ id: m.id, error: { code: -32602, message: `Invalid effort: ${p.value}` } });
				s.effort = p.value;
			}
			return reply(m.id, { configOptions: configOptions(s) });
		}
		case "session/prompt":
			try {
				return reply(m.id, await prompt(p.sessionId, p.prompt ?? []));
			} catch (e) {
				return fail(m.id, e);
			}
		default:
			return send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
	}
}

createInterface({ input: process.stdin })
	.on("line", (line) => {
		let m;
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		if (m.method === "session/cancel") {
			cancelled = true;
			wakeCancel();
		} else if (m.method && m.id !== undefined) void handle(m);
		else if (m.id !== undefined && pending.has(m.id)) {
			pending.get(m.id)(m.result);
			pending.delete(m.id);
		}
	})
	.on("close", () => process.exit(0));
