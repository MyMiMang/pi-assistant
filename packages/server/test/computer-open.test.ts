/** 开电脑后同一轮可用：computer_open 开机后热注册电脑扩展并等 MCP 工具出现；就绪探测解析 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { computerLauncherExtension, MCP_PREFIX } = await import("@pi-assistant/ext-computer");
const { parseReadyProbe } = await import("../src/desktop.ts");

function fakePi() {
	const tools = new Map<string, { name: string; execute: (...a: unknown[]) => Promise<{ content: { type: string; text?: string }[] }> }>();
	const servers: string[] = [];
	const handlers: string[] = [];
	return {
		tools,
		servers,
		handlers,
		registerTool: (t: never) => tools.set((t as { name: string }).name, t),
		// 模拟 Pi：注册后 MCP 服务在后台连接，过一会儿工具才出现
		registerMcpServer: (name: string) => (servers.push(name), setTimeout(() => tools.set(`${MCP_PREFIX}get_screen_size`, { name: `${MCP_PREFIX}get_screen_size`, execute: async () => ({ content: [] }) }), 300)),
		on: (ev: string) => handlers.push(ev),
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
	};
}
const host = { target: "sandbox" as const, mcp: { command: "true", args: [] }, isPaused: () => false, request: async () => ({ approved: true }), screenshot: async () => Buffer.alloc(0), handoff: async () => "" };

test("computer_open：开机 → 同一会话热注册电脑工具 → 等 MCP 工具出现后返回“现在就能用”", async () => {
	const pi = fakePi();
	let started = 0;
	computerLauncherExtension({ start: async () => void started++, computer: host })(pi as never);
	assert.ok(pi.tools.has("computer_open"));
	assert.ok(!pi.tools.has(`${MCP_PREFIX}get_screen_size`));
	const r = await pi.tools.get("computer_open")!.execute("id", {});
	assert.equal(started, 1);
	assert.deepEqual(pi.servers, ["computer"]);
	assert.ok(pi.tools.has("computer_screenshot") && pi.tools.has("request_handoff"));
	assert.ok(pi.tools.has(`${MCP_PREFIX}get_screen_size`));
	assert.ok(pi.handlers.includes("tool_call") && pi.handlers.includes("tool_result"), "审批 / 暂停 / 记录钩子也要挂上");
	assert.match(r.content[0].text!, /现在就能用/);
	// 再调一次（例如关机后又开）：不会重复注册
	await pi.tools.get("computer_open")!.execute("id2", {});
	assert.equal(started, 2);
	assert.deepEqual(pi.servers, ["computer"]);
});

test("computer_open：MCP 迟迟连不上 → 超时后如实告诉模型，不假装可用；开机失败直接报错", async () => {
	const pi = { ...fakePi(), registerMcpServer: () => {} };
	computerLauncherExtension({ start: async () => {}, computer: host, waitMs: 500 })(pi as never);
	const r = await pi.tools.get("computer_open")!.execute("id", {});
	assert.match(r.content[0].text!, /还没连上/);
	const pi2 = fakePi();
	computerLauncherExtension({ start: async () => Promise.reject(new Error("引擎没装")), computer: host })(pi2 as never);
	await assert.rejects(pi2.tools.get("computer_open")!.execute("id", {}), /引擎没装/);
	assert.equal(pi2.servers.length, 0);
});

test("桌面就绪探测：X / 窗口管理器 / VNC / cua-driver / 屏幕非空白", () => {
	assert.deepEqual(parseReadyProbe("ok 0.153\n"), { ready: true, reason: "ok 0.153" });
	assert.deepEqual(parseReadyProbe("wait 屏幕还是空白"), { ready: false, reason: "屏幕还是空白" });
	assert.deepEqual(parseReadyProbe("wait VNC"), { ready: false, reason: "VNC" });
	assert.equal(parseReadyProbe("").ready, false);
});
