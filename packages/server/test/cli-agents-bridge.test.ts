import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { cancelledResult, textResult, toolBridge, type BridgeCall, type Tool } from "../src/cli-agents/tool-bridge.ts";
import { mountToolBridgeRoutes, TOOL_BRIDGE_PATH } from "../src/routes/tool-bridge.ts";
import type { Env } from "../src/routes/common.ts";

const tools: Tool[] = [
	{ name: "echo", description: "回显", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
	{ name: "wait", inputSchema: { type: "object" } },
];
const callMsg = (rpcId: number, name: string, toolUseId: string | null, args: object = {}) => ({
	jsonrpc: "2.0",
	id: rpcId,
	method: "tools/call",
	params: { name, arguments: args, ...(toolUseId ? { _meta: { "claudecode/toolUseId": toolUseId, progressToken: rpcId } } : {}) },
});
const resultOf = (r: unknown) => (r as { result: { content: { text: string }[]; isError?: boolean } }).result;
const textOf = (r: unknown) => resultOf(r).content[0].text;

test("握手：initialize、notifications/initialized、ping、tools/list", async () => {
	const run = toolBridge.register({ tools });
	const init = (await run.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "2" } } })) as any;
	assert.equal(init.result.protocolVersion, "2025-06-18");
	assert.ok(init.result.capabilities.tools);
	const odd = (await run.handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })) as any;
	assert.equal(odd.result.protocolVersion, "2025-11-25");
	assert.equal(await run.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
	assert.deepEqual(((await run.handleMessage({ jsonrpc: "2.0", id: 3, method: "ping" })) as any).result, {});
	const list = (await run.handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" })) as any;
	assert.deepEqual(list.result.tools.map((t: Tool) => t.name), ["echo", "wait"]);
	assert.ok(list.result.tools.every((t: any) => t._meta["antigravity/alwaysLoad"] === true), "每个工具带 alwaysLoad（agy 才会直接给模型）");
	assert.equal(run.tools[0]._meta, undefined, "不污染原工具清单");
	const discover = (await run.handleMessage({ jsonrpc: "2.0", id: 9, method: "server/discover" })) as any;
	assert.equal(discover.error.code, -32601, "agy 启动时发的非标准 server/discover：方法不存在");
	const bad = (await run.handleMessage({ jsonrpc: "2.0", id: 5, method: "resources/list" })) as any;
	assert.equal(bad.error.code, -32601);
	const unknown = (await run.handleMessage(callMsg(6, "nope", "toolu_x"))) as any;
	assert.equal(unknown.error.code, -32602);
	run.close();
});

test("两个工具同时在途：按 toolUseId 配对，不看回填顺序", async () => {
	const seen: BridgeCall[] = [];
	const run = toolBridge.register({ tools, onCall: (c) => seen.push(c) });
	const a = run.handleMessage(callMsg(10, "echo", "toolu_A", { text: "a" }));
	const b = run.handleMessage(callMsg(11, "echo", "toolu_B", { text: "b" }));
	assert.deepEqual(run.pendingIds().sort(), ["toolu_A", "toolu_B"]);
	assert.deepEqual(seen.map((c) => [c.toolUseId, c.name, c.args]), [["toolu_A", "echo", { text: "a" }], ["toolu_B", "echo", { text: "b" }]]);
	assert.equal(run.resolveTool("toolu_B", textResult("RB")), true); // 后发的先回
	assert.equal(textOf(await b), "RB");
	assert.deepEqual(run.pendingIds(), ["toolu_A"]);
	assert.equal(run.resolveTool("toolu_A", textResult("RA")), true);
	const ra = (await a) as any;
	assert.equal(ra.id, 10, "响应带回自己的 JSON-RPC id");
	assert.equal(textOf(ra), "RA");
	assert.equal(run.resolveTool("toolu_A", textResult("again")), false, "回填两次：忽略");
	run.close();
});

test("结果比 tools/call 先到：先存着，调用一到直接返回", async () => {
	const run = toolBridge.register({ tools });
	assert.equal(run.resolveTool("toolu_E", textResult("EARLY")), true);
	assert.equal(run.resolveTool("toolu_E", textResult("second")), false);
	assert.deepEqual(run.pendingIds(), []);
	assert.equal(textOf(await run.handleMessage(callMsg(20, "echo", "toolu_E"))), "EARLY");
	run.close();
});

test("没带 toolUseId 的调用用 rpc-<id> 兜底，仍可回填", async () => {
	const seen: BridgeCall[] = [];
	const run = toolBridge.register({ tools, onCall: (c) => seen.push(c) });
	const p = run.handleMessage(callMsg(30, "echo", null));
	assert.equal(seen[0].toolUseId, "rpc-30");
	run.resolveTool("rpc-30", textResult("ok"));
	assert.equal(textOf(await p), "ok");
	run.close();
});

test("notifications/cancelled：挂起的调用返回已取消，之后回填被忽略", async () => {
	const cancelled: string[] = [];
	const run = toolBridge.register({ tools, onCancelled: (id) => cancelled.push(id) });
	const p = run.handleMessage(callMsg(40, "wait", "toolu_W"));
	assert.equal(await run.handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 40, reason: "timeout" } }), null);
	assert.deepEqual(resultOf(await p), cancelledResult());
	assert.deepEqual(cancelled, ["toolu_W"]);
	assert.deepEqual(run.pendingIds(), []);
	assert.equal(run.resolveTool("toolu_W", textResult("late")), false);
	// 取消后同一个 id 再来 tools/call 也直接返回已取消
	assert.deepEqual(resultOf(await run.handleMessage(callMsg(41, "wait", "toolu_W"))), cancelledResult());
	// 取消一个不存在的请求：无事发生
	await run.handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999 } });
	run.close();
});

test("close（运行结束 / abort）：所有挂起的调用都返回已取消，运行被注销", async () => {
	const before = toolBridge.size;
	const run = toolBridge.register({ tools });
	const a = run.handleMessage(callMsg(50, "wait", "toolu_1"));
	const b = run.handleMessage(callMsg(51, "wait", "toolu_2"));
	run.resolveTool("toolu_3", textResult("early, never called"));
	run.close();
	assert.deepEqual(resultOf(await a), cancelledResult());
	assert.deepEqual(resultOf(await b), cancelledResult());
	assert.equal(run.resolveTool("toolu_1", textResult("late")), false);
	assert.deepEqual(resultOf(await run.handleMessage(callMsg(52, "wait", "toolu_4"))), cancelledResult());
	assert.equal(toolBridge.size, before);
	assert.equal(toolBridge.authorize(run.id, run.token), undefined);
});

// ---- HTTP 入口
const app = new Hono<Env>();
mountToolBridgeRoutes(app);
const post = (runId: string, token: string | undefined, body: unknown, opts: { remote?: string; headers?: Record<string, string> } = {}) =>
	app.request(
		`${TOOL_BRIDGE_PATH}/${runId}`,
		{ method: "POST", headers: { host: "127.0.0.1:8787", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers }, body: JSON.stringify(body) },
		{ incoming: { socket: { remoteAddress: opts.remote ?? "127.0.0.1" } } },
	);

test("HTTP：令牌对 + 本机 = 通；JSON 响应；通知回 202；GET 回 405", async () => {
	const run = toolBridge.register({ tools });
	const r = await post(run.id, run.token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
	assert.equal(r.status, 200);
	assert.equal(((await r.json()) as any).result.tools.length, 2);
	assert.equal((await post(run.id, run.token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
	assert.equal((await post(run.id, run.token, { jsonrpc: "2.0", id: 2, method: "ping" }, { remote: "::ffff:127.0.0.1" })).status, 200);
	const g = await app.request(`${TOOL_BRIDGE_PATH}/${run.id}`, { method: "GET", headers: { host: "127.0.0.1" } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
	assert.equal(g.status, 405);
	run.close();
});

test("HTTP：令牌错、没带令牌、运行不存在、运行已结束都是 401", async () => {
	const run = toolBridge.register({ tools });
	const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	assert.equal((await post(run.id, "wrong-token", body)).status, 401);
	assert.equal((await post(run.id, undefined, body)).status, 401);
	assert.equal((await post("nope", run.token, body)).status, 401);
	const other = toolBridge.register({ tools });
	assert.equal((await post(run.id, other.token, body)).status, 401, "别的运行的令牌不能用");
	run.close();
	assert.equal((await post(run.id, run.token, body)).status, 401);
	other.close();
});

test("HTTP：非本机请求被拒（远程地址、隧道转发头、外部 Host）", async () => {
	const run = toolBridge.register({ tools });
	const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	assert.equal((await post(run.id, run.token, body, { remote: "192.168.1.8" })).status, 403);
	assert.equal((await post(run.id, run.token, body, { headers: { "x-forwarded-for": "1.2.3.4" } })).status, 403);
	assert.equal((await post(run.id, run.token, body, { headers: { "cf-connecting-ip": "1.2.3.4" } })).status, 403);
	assert.equal((await post(run.id, run.token, body, { headers: { host: "evil.example.com" } })).status, 403);
	run.close();
});

test("HTTP：不是 JSON 回 400；tools/call 经 HTTP 挂起后可回填", async () => {
	const run = toolBridge.register({ tools });
	const bad = await app.request(`${TOOL_BRIDGE_PATH}/${run.id}`, { method: "POST", headers: { host: "127.0.0.1", authorization: `Bearer ${run.token}` }, body: "{not json" }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
	assert.equal(bad.status, 400);
	const p = post(run.id, run.token, callMsg(60, "echo", "toolu_H", { text: "h" }));
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(run.pendingIds(), ["toolu_H"]);
	run.resolveTool("toolu_H", textResult("via-http"));
	assert.equal(textOf(await (await p).json()), "via-http");
	run.close();
});

test("可换配对键：agy 用 progressToken 末段的 step_index，两个并行调用按它配对", async () => {
	const key = (meta: Record<string, unknown>) => (typeof meta.progressToken === "string" ? meta.progressToken.split(":").pop() : undefined);
	const seen: BridgeCall[] = [];
	const run = toolBridge.register({ tools, callKey: key, onCall: (c) => seen.push(c) });
	const call = (id: number, step: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: { n: step }, _meta: { progressToken: `uuid-1:${step}`, "antigravity.google/conversation_id": "c" } } });
	const a = run.handleMessage(call(70, 2));
	const b = run.handleMessage(call(71, 3));
	assert.deepEqual(seen.map((c) => c.toolUseId), ["2", "3"]);
	run.resolveTool("3", textResult("R3"));
	run.resolveTool("2", textResult("R2"));
	assert.equal(textOf(await a), "R2");
	assert.equal(textOf(await b), "R3");
	run.close();
});
