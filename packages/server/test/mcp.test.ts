process.env.PIA_MOCK = "1";
await import("./setup.ts");
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
const { config } = await import("../src/config.ts");
const mcp = await import("../src/mcp.ts");
const modelsMod = await import("../src/models.ts");
const { createPiSession, disposeSession, promptSession, lastAssistantText } = await import("../src/pi-adapter/index.ts");
const fixture = join(import.meta.dirname, "..", "..", "..", "e2e", "fixtures", "mock-mcp.mjs");

test("MCP：校验、保存（加密 + 打码）、测试连接拿到工具列表", async () => {
	assert.throws(() => mcp.saveMcp({ name: "bad name", config: { type: "stdio", command: "node" } }), /名称/);
	assert.throws(() => mcp.saveMcp({ name: "x", config: { type: "stdio", command: "npx -y foo" } }), /参数/);
	assert.throws(() => mcp.saveMcp({ name: "x", config: { type: "http", url: "https://a.com/sse" } }), /SSE/);
	const r = mcp.saveMcp({ name: "demo", config: { type: "stdio", command: process.execPath, args: [fixture], env: { API_TOKEN: "s3cret" } } });
	assert.ok(!r.config.includes("s3cret"), "配置应加密存储");
	assert.equal(mcp.redact(mcp.configOf(r)).env!.API_TOKEN, "••••••");
	// 编辑时传回打码值 = 保持原值
	const r2 = mcp.saveMcp({ id: r.id, name: "demo", config: { ...mcp.redact(mcp.configOf(r)) } });
	assert.equal(mcp.configOf(r2).env!.API_TOKEN, "s3cret");
	const t = await mcp.testMcp(r.id);
	assert.ok(t.ok, JSON.stringify(t));
	assert.deepEqual(t.tools!.map((x) => x.name), ["get_weather", "send_note"]);
	assert.equal(t.tools![0].readOnly, true);
	assert.equal(mcp.getMcp(r.id)!.status, "ok");
	assert.throws(() => mcp.saveMcp({ name: "Demo", config: { type: "stdio", command: "node" } }), /同名/);
});

test("MCP：按助理启用", () => {
	const r = mcp.listMcp()[0];
	assert.equal(mcp.mcpServersFor("a1").length, 1);
	mcp.setMcpEnabled(r.id, true, ["a2"]);
	assert.equal(mcp.mcpServersFor("a1").length, 0);
	assert.equal(mcp.mcpServersFor("a2").length, 1);
	mcp.setMcpEnabled(r.id, false);
	assert.equal(mcp.mcpServersFor("a2").length, 0);
	mcp.setMcpEnabled(r.id, true, null);
});

test("MCP：会话里由 Pi 连接并调用工具（经我们的配置，不读 mcp.json）", async () => {
	await modelsMod.initModels();
	const ws = join(config.workspaceRoot, "mcp");
	mkdirSync(ws, { recursive: true });
	const session = await createPiSession({
		models: modelsMod.models,
		cwd: ws,
		agentDir: join(config.agentsDir, "mcp"),
		sessionDir: join(config.agentsDir, "mcp", "sessions"),
		model: { provider: "mock", id: "echo" },
		systemPromptAppend: [],
		extensions: [],
		mcpServers: mcp.mcpServersFor("a1"),
	});
	await promptSession(session, "查一下上海天气");
	for (let i = 0; i < 100 && session.isStreaming; i++) await new Promise((r) => setTimeout(r, 100));
	assert.match(lastAssistantText(session), /晴，22°C（mock-mcp）/);
	disposeSession(session);
	mcp.deleteMcp(mcp.listMcp()[0].id);
	assert.equal(mcp.listMcp().length, 0);
});
