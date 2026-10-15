#!/usr/bin/env node
// Pi 1.2 行为验证用 fake MCP 服务器（stdio，测试专用，绝不连真实服务）。
//
// 覆盖 1.2.0 里我们关心的 MCP 结果形状与资源行为：
//  - tools/call 返回 content 数组 / 空 content + structuredContent:null / 原始值 42 / 对象
//  - slow_result：3 秒后才回，用来验证取消（收到 notifications/cancelled 时记日志）
//  - resources/list：**故意不回答**，验证「不再预列举 resources」——即使服务挂着不回，
//    初始化、tools/list、tools/call 也不被挡住。
//
// 用法：node fake-mcp-1.2.mjs [日志文件路径]
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG = process.argv[2] ?? "";
const log = (event, extra = "") => {
	if (LOG) appendFileSync(LOG, `${event}${extra ? ` ${extra}` : ""}\n`);
};

const tools = [
	{ name: "multi_text", description: "返回多条文本", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
	{ name: "null_result", description: "空 content + structuredContent=null", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
	{ name: "primitive_result", description: "structuredContent 是原始值 42", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
	{ name: "structured_result", description: "structuredContent 是对象", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
	{ name: "slow_result", description: "3 秒后才返回，用于取消测试", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
	let m;
	try {
		m = JSON.parse(line);
	} catch {
		return;
	}
	const method = m.method;
	if (m.id === undefined) {
		// 通知：取消请求
		if (method === "notifications/cancelled") log("cancelled", String(m.params?.requestId ?? ""));
		return;
	}
	log("req", method);
	if (method === "initialize")
		return send({
			jsonrpc: "2.0",
			id: m.id,
			result: {
				protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {}, resources: {} },
				serverInfo: { name: "fake-mcp-1.2", version: "1.0.0" },
			},
		});
	if (method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
	// 故意不回：模拟“资源列表卡住”，用来证明它不阻工具发现（Pi 1.2 不再预列举 resources）
	if (method === "resources/list") return log("resources_list_hang");
	if (method === "tools/call") {
		const name = m.params?.name;
		if (name === "slow_result") return void setTimeout(() => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "slow done" }] } }), 3000);
		if (name === "multi_text") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "第一行" }, { type: "text", text: "第二行" }] } });
		if (name === "null_result") return send({ jsonrpc: "2.0", id: m.id, result: { content: [], structuredContent: null } });
		if (name === "primitive_result") return send({ jsonrpc: "2.0", id: m.id, result: { content: [], structuredContent: 42 } });
		if (name === "structured_result") return send({ jsonrpc: "2.0", id: m.id, result: { content: [], structuredContent: { ok: true, items: [1, 2, 3] } } });
		return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `unknown ${name}` }] } });
	}
	if (method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
	send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});

process.stdin.on("end", () => process.exit(0));
