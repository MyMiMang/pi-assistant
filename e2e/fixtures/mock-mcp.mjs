#!/usr/bin/env node
// 最小的 stdio MCP 服务器（测试用）：两个工具，一个只读、一个有副作用
import { createInterface } from "node:readline";
const tools = [
	{ name: "get_weather", description: "查询城市天气", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
	{ name: "send_note", description: "给某人发一条便签", inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } } }, annotations: { destructiveHint: true } },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	let m;
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	if (m.id === undefined) return;
	if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp", version: "1.0.0" }, instructions: "测试用天气服务" } });
	if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
	if (m.method === "tools/call") {
		const a = m.params?.arguments ?? {};
		const text = m.params?.name === "get_weather" ? `${a.city ?? "?"}：晴，22°C（mock-mcp）` : `已发送给 ${a.to}：${a.text}`;
		return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
	}
	if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
	send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});
