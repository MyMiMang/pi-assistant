#!/usr/bin/env node
// 仅测试的 stdio ACP。只访问测试提供的回环 HTTP MCP，不执行命令或调用模型。
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (x) => process.stdout.write(`${JSON.stringify(x)}\n`);
const scenario = process.env.FAKE_NATIVE_SCENARIO ?? "meta";
const log = (x) => { if (process.env.FAKE_NATIVE_LOG) appendFileSync(process.env.FAKE_NATIVE_LOG, `${JSON.stringify(x)}\n`); };
const reply = (id, result) => send({ id, result });
const update = (s, u) => send({ method: "session/update", params: { sessionId: s, update: u } });
const say = (s, text) => update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const options = [{ optionId: "always", kind: "allow_always" }, ...(scenario === "no-once" ? [] : [{ optionId: "once", kind: "allow_once" }]), { optionId: "no", kind: "reject_once" }];
const pending = new Map();
let mcp = [];
let promptId;
let sessionId = "native-session";
let sequence = 0;
const configs = [{ id: "chosen-model", category: "model", currentValue: "model-a", options: [{ value: "model-a" }, { value: "model-b" }] }];
async function bridgeCall() {
	const server = mcp[0];
	const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])) };
	const post = (id, method, params) => fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).then((r) => r.status === 202 ? null : r.json());
	await post(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-native", version: "1" } });
	return post(2, "tools/call", { name: "echo", arguments: { text: "bridge" } });
}
async function handle(m) {
	const p = m.params ?? {};
	log({ method: m.method, params: p });
	switch (m.method) {
		case "initialize": return reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: scenario !== "no-load", mcpCapabilities: { http: scenario !== "no-http" }, promptCapabilities: { image: true } }, authMethods: [{ id: "oauth", name: "Official browser login" }] });
		case "session/new":
		case "session/load": {
			sessionId = p.sessionId ?? sessionId;
			mcp = p.mcpServers;
			if (m.method === "session/load") {
				say(sessionId, "OLD BEFORE LOAD");
				update(sessionId, { sessionUpdate: "tool_call", toolCallId: "old", title: "old write", status: "in_progress" });
				setTimeout(() => update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "old", status: "completed" }), 10);
			}
			return reply(m.id, { sessionId, ...(scenario === "no-config" ? {} : { configOptions: configs }) });
		}
		case "session/set_config_option": return reply(m.id, { configOptions: configs });
		case "session/resume": return send({ id: m.id, error: { code: -32601, message: "resume forbidden" } });
		case "session/prompt": {
			promptId = m.id;
			sequence++;
			if (scenario === "hang" || scenario === "unknown-event") {
				say(sessionId, "started");
				return;
			}
			if (["permission", "no-once", "bad-session", "malformed"].includes(scenario)) {
				send({ id: `perm-${sequence}`, method: "session/request_permission", params: { sessionId: scenario === "bad-session" ? "foreign" : sessionId, ...(scenario === "malformed" ? {} : { toolCall: { toolCallId: "native-1", title: "Write" } }), options } });
				// 按 ACP：被取消的批准不自行结束这一轮，等 session/cancel 回 cancelled（否则宿主可能在 cancel 送达前关进程）
				pending.set(`perm-${sequence}`, (r) => { if (r?.outcome?.outcome === "cancelled") return; say(sessionId, JSON.stringify(r)); reply(m.id, { stopReason: "end_turn" }); });
				return;
			}
			if (scenario === "tools" || scenario === "mixed") {
				update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "native-1", status: "in_progress", rawInput: { path: "test.txt" } });
				update(sessionId, { sessionUpdate: "tool_call", toolCallId: "native-1", title: "pia_native-name", kind: "edit", status: "pending", locations: [{ path: "test.txt", line: 1 }] });
				if (scenario === "mixed") say(sessionId, JSON.stringify(await bridgeCall()));
				update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "native-1", status: "completed", rawOutput: "done" });
			} else say(sessionId, JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv.slice(2), prompt: p.prompt, mcp, settings: process.env.GEMINI_CLI_HOME ? JSON.parse(readFileSync(`${process.env.GEMINI_CLI_HOME}/.gemini/settings.json`, "utf8")) : undefined }));
			return reply(m.id, { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } });
		}
		case "session/cancel": if (promptId) reply(promptId, { stopReason: "cancelled" }); return;
		default: return send({ id: m.id, error: { code: -32601, message: "unsupported" } });
	}
}
createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.method) void handle(m);
	else if (pending.has(m.id)) { log({ permissionReply: m }); pending.get(m.id)(m.result); pending.delete(m.id); }
}).on("close", () => process.exit(0));
