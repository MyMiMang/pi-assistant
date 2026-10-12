/** MCP 包预装：识别 npx / uvx，装进我们的目录（统一下载进度），会话改用装好的可执行文件；真实安装 + 连接 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
const { parseRunner, pickNpmBin, npmName, resolveMcpCommand, syncMcpDownloads, ensureMcpPackage, mcpDownloadId } = await import("../src/mcp-install.ts");
const { saveMcp, testMcp, deleteMcp } = await import("../src/mcp.ts");
const mcpMod = await import("../src/mcp.ts");
const mcpServersFor = (a: string) => mcpMod.mcpServersFor(a) as unknown as { name: string; config: { command: string; args: string[] } }[];
const { downloadInfo, trackDownload } = await import("../src/downloads.ts");

test("识别 npx / uvx 写法；其他命令不碰", () => {
	assert.deepEqual(parseRunner({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }), { kind: "npm", spec: "@modelcontextprotocol/server-memory", rest: [] });
	assert.deepEqual(parseRunner({ type: "stdio", command: "C:\\nodejs\\npx.cmd", args: ["--yes", "pkg@1.2", "--port", "1"] }), { kind: "npm", spec: "pkg@1.2", rest: ["--port", "1"] });
	assert.deepEqual(parseRunner({ type: "stdio", command: "npx", args: ["-p", "@a/b", "b-cli", "x"] }), { kind: "npm", spec: "@a/b", bin: "b-cli", rest: ["x"] });
	assert.deepEqual(parseRunner({ type: "stdio", command: "uvx", args: ["mcp-server-time", "--local-timezone=Asia/Shanghai"] }), { kind: "uv", spec: "mcp-server-time", bin: "mcp-server-time", rest: ["--local-timezone=Asia/Shanghai"] });
	assert.deepEqual(parseRunner({ type: "stdio", command: "uvx", args: ["--from", "git+https://x/y", "tool"] }), { kind: "uv", spec: "git+https://x/y", bin: "tool", rest: [] });
	assert.deepEqual(parseRunner({ type: "stdio", command: "uv", args: ["tool", "run", "mcp-server-fetch==1.0"] })?.bin, "mcp-server-fetch");
	assert.equal(parseRunner({ type: "stdio", command: "node", args: ["server.js"] }), null);
	assert.equal(parseRunner({ type: "stdio", command: "npx", args: ["--registry", "x", "pkg"] }), null);
	assert.equal(parseRunner({ type: "http" }), null);
	assert.equal(npmName("@scope/pkg@1.0.0"), "@scope/pkg");
	assert.equal(pickNpmBin({ name: "@s/foo", bin: "cli.js" }), "foo");
	assert.equal(pickNpmBin({ name: "foo", bin: { a: "1", foo: "2" } }), "foo");
	assert.equal(pickNpmBin({ name: "foo", bin: { only: "1" } }), "only");
});

test("真实 npx 型 MCP：登记下载 → 安装（字节进度）→ 已下载 → 会话和测试连接都用装好的可执行文件", { timeout: 240_000 }, async () => {
	const row = saveMcp({ name: "memtest", config: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } });
	syncMcpDownloads();
	const id = mcpDownloadId(row.id);
	assert.equal(downloadInfo(id)?.state, "missing");
	assert.equal(downloadInfo(id)?.group, "MCP 服务");
	let sawBytes = 0;
	const t = setInterval(() => (sawBytes = Math.max(sawBytes, downloadInfo(id)?.received ?? 0)), 100);
	await ensureMcpPackage(row.id);
	clearInterval(t);
	assert.equal(downloadInfo(id)?.state, "ready", JSON.stringify(downloadInfo(id)));
	assert.ok(sawBytes > 0, "下载中要有字节进度");
	const cmd = resolveMcpCommand({ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] });
	assert.match(cmd.command, /mcp-packages.*node_modules[\\/]\.bin/);
	assert.equal(mcpServersFor("any")[0].config.command, cmd.command);
	const r = await testMcp(row.id, { timeoutMs: 30_000 });
	assert.ok(r.ok, JSON.stringify(r));
	assert.ok(r.tools!.some((x) => x.name === "create_entities"));
	deleteMcp(row.id);
	syncMcpDownloads();
	assert.equal(downloadInfo(id), null);
});

test("装不上（包不存在）→ 出错可重试，仍按原命令运行", { timeout: 120_000 }, async () => {
	const row = saveMcp({ name: "nopkg", config: { type: "stdio", command: "npx", args: ["-y", "@pia-nonexistent/zzz-not-a-pkg"] } });
	await ensureMcpPackage(row.id);
	const d = downloadInfo(mcpDownloadId(row.id))!;
	assert.equal(d.state, "error");
	assert.ok(d.canStart);
	assert.equal(mcpServersFor("any").find((s) => s.name === "nopkg")!.config.command, "npx");
	deleteMcp(row.id);
	void trackDownload;
});

test("真实 uvx 型 MCP：uv tool install 到我们的目录，连接成功", { timeout: 300_000 }, async () => {
	const row = saveMcp({ name: "timetest", config: { type: "stdio", command: "uvx", args: ["mcp-server-time", "--local-timezone=Asia/Shanghai"] } });
	await ensureMcpPackage(row.id);
	const d = downloadInfo(mcpDownloadId(row.id))!;
	assert.equal(d.state, "ready", JSON.stringify(d));
	const s = mcpServersFor("any").find((x) => x.name === "timetest")!;
	assert.match(s.config.command, /mcp-packages.*bin/);
	assert.deepEqual(s.config.args, ["--local-timezone=Asia/Shanghai"]);
	const r = await testMcp(row.id, { timeoutMs: 60_000 });
	assert.ok(r.ok, JSON.stringify(r));
	assert.ok(r.tools!.some((x) => x.name === "get_current_time"));
	deleteMcp(row.id);
});
