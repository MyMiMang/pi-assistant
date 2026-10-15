#!/usr/bin/env node
// 工具发现 / codemode 验证用 stdio MCP 服务器（只在单测里跑）。
// 每个 tools/call 都把工具名追加到 COUNTER_FILE（如果给了），用来证明：
//  - 取消 / 超时后，脚本里排在后面的有副作用步骤没有被执行；
//  - 嵌套调用确实到了 MCP 服务器（不是被脚本层“假返回”）。
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const COUNTER = process.env.COUNTER_FILE;
const record = (name) => {
	if (COUNTER) appendFileSync(COUNTER, `${name}\n`);
};

const tools = [
	{ name: "get_weather", description: "查询城市天气", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
	{ name: "send_note", description: "给某人发一条便签（有副作用）", inputSchema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } } }, annotations: { destructiveHint: true } },
	// 慢只读工具：睡一会儿再记录，用来在“读到一半”时取消
	{ name: "slow_read", description: "很慢的只读查询", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
	// 只在被调用时才记录的关键副作用工具
	{ name: "final_delete", description: "删除远端记录（有副作用）", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
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
	if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-mcp-discovery", version: "1.0.0" }, instructions: "验证用服务：天气、便签、慢查询、删除" } });
	if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
	if (m.method === "tools/call") {
		const name = m.params?.name;
		const a = m.params?.arguments ?? {};
		if (name === "slow_read") {
			// 1.5 秒后才记录并返回：取消发生在这一步时，后面的 final_delete 不应被执行
			setTimeout(() => {
				record("slow_read");
				send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "slow_read 完成" }] } });
			}, 1500);
			return;
		}
		record(name);
		const text =
			name === "get_weather" ? `${a.city ?? "?"}：晴，22°C（mock-mcp-discovery）` : name === "send_note" ? `已发送给 ${a.to}：${a.text}` : name === "final_delete" ? "已删除" : `未知工具 ${name}`;
		return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
	}
	if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
	send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});
