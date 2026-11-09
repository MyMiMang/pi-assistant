/** 本地假安装器验证 npm/uv 预装，不联网、不读用户缓存。 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { InstallRunnerDeps } from "../src/mcp-install.ts";
const { parseRunner, pickNpmBin, npmName, resolveMcpCommand, syncMcpDownloads, ensureMcpPackage, mcpDownloadId } = await import("../src/mcp-install.ts");
const { saveMcp, testMcp, deleteMcp, mcpServersFor } = await import("../src/mcp.ts");
const { downloadInfo } = await import("../src/downloads.ts");
const fakeInstall: InstallRunnerDeps = {
	npm: () => ({ node: process.execPath, npm: "/fake/npm-cli.js" }),
	uv: async () => "/fake/uv",
	run: async (command, args, env, cwd) => {
		if (args.some((a) => a.includes("nonexistent"))) throw new Error("fake package not found");
		if (command === "/fake/uv") {
			mkdirSync(env.UV_TOOL_BIN_DIR, { recursive: true });
			writeFileSync(join(env.UV_TOOL_BIN_DIR, process.platform === "win32" ? "mcp-server-time.exe" : "mcp-server-time"), "fake uv executable");
		} else {
			const pkg = join(cwd!, "node_modules/@modelcontextprotocol/server-memory");
			mkdirSync(pkg, { recursive: true });
			writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@modelcontextprotocol/server-memory", bin: "entry.mjs" }));
			copyFileSync(join(import.meta.dirname, "fixtures/fake-mcp-1.2.mjs"), join(pkg, "entry.mjs"));
			chmodSync(join(pkg, "entry.mjs"), 0o755);
		}
		await delay(1150);
	},
};

test("识别 npx / uvx 写法及共享npm bin选择", () => {
	assert.deepEqual(parseRunner({ type: "stdio", command: "npx", args: ["-y", "pkg@1.2", "x"] }), { kind: "npm", spec: "pkg@1.2", rest: ["x"] });
	assert.deepEqual(parseRunner({ type: "stdio", command: "C:\\nodejs\\npx.cmd", args: ["-p", "@a/b", "b-cli"] }), { kind: "npm", spec: "@a/b", bin: "b-cli", rest: [] });
	assert.equal(parseRunner({ type: "stdio", command: "uvx", args: ["--from", "git+https://x/y", "tool"] })?.bin, "tool");
	assert.equal(parseRunner({ type: "stdio", command: "uv", args: ["tool", "run", "mcp-server-fetch==1.0"] })?.bin, "mcp-server-fetch");
	assert.equal(parseRunner({ type: "stdio", command: "node", args: ["server.js"] }), null);
	assert.equal(parseRunner({ type: "stdio", command: "npx", args: ["--registry", "x", "pkg"] }), null);
	assert.equal(parseRunner({ type: "http" }), null);
	assert.equal(npmName("@scope/pkg@1.0.0"), "@scope/pkg");
	assert.equal(pickNpmBin({ name: "@s/foo", bin: "cli.js" }), "foo");
	assert.equal(pickNpmBin({ name: "foo", bin: { a: "1", foo: "2" } }), "foo");
	assert.equal(pickNpmBin({ name: "foo", bin: { only: "1" } }), "only");
});

test("假npm安装：统一字节进度、命令解析与实际假MCP连接", async () => {
	const config = { type: "stdio" as const, command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] };
	const row = saveMcp({ name: "memtest", config });
	try {
		syncMcpDownloads();
		const id = mcpDownloadId(row.id);
		assert.equal(downloadInfo(id)?.state, "missing");
		let sawBytes = 0;
		const timer = setInterval(() => { sawBytes = Math.max(sawBytes, downloadInfo(id)?.received ?? 0); }, 50);
		try { await ensureMcpPackage(row.id, fakeInstall); } finally { clearInterval(timer); }
		assert.equal(downloadInfo(id)?.state, "ready", JSON.stringify(downloadInfo(id)));
		assert.ok(sawBytes > 0);
		const cmd = resolveMcpCommand(config);
		assert.equal(cmd.command, process.execPath);
		assert.match(cmd.args[0], /mcp-packages.*node_modules/);
		const saved = mcpServersFor("any").find((s) => s.name === "memtest")!.config;
		assert.equal(saved.type, "stdio");
		assert.equal(saved.type === "stdio" && saved.command, cmd.command);
		const result = await testMcp(row.id, { timeoutMs: 10_000 });
		assert.ok(result.ok, JSON.stringify(result));
		assert.ok(result.tools!.some((x) => x.name === "multi_text"));
	} finally { deleteMcp(row.id); syncMcpDownloads(); }
});

test("假npm安装失败：可重试并保留原命令", async () => {
	const row = saveMcp({ name: "nopkg", config: { type: "stdio", command: "npx", args: ["-y", "@pia-nonexistent/zzz"] } });
	try {
		await ensureMcpPackage(row.id, fakeInstall);
		assert.equal(downloadInfo(mcpDownloadId(row.id))?.state, "error");
		assert.equal(downloadInfo(mcpDownloadId(row.id))?.canStart, true);
		const saved = mcpServersFor("any").find((s) => s.name === "nopkg")!.config;
		assert.equal(saved.type, "stdio");
		assert.equal(saved.type === "stdio" && saved.command, "npx");
	} finally { deleteMcp(row.id); syncMcpDownloads(); }
});

test("假uv安装：私有工具与缓存目录、保留启动参数", async () => {
	const row = saveMcp({ name: "timetest", config: { type: "stdio", command: "uvx", args: ["mcp-server-time", "--local-timezone=Asia/Shanghai"] } });
	try {
		await ensureMcpPackage(row.id, fakeInstall);
		assert.equal(downloadInfo(mcpDownloadId(row.id))?.state, "ready");
		const command = resolveMcpCommand({ type: "stdio", command: "uvx", args: ["mcp-server-time", "--local-timezone=Asia/Shanghai"] });
		assert.match(command.command, /mcp-packages.*bin/);
		assert.deepEqual(command.args, ["--local-timezone=Asia/Shanghai"]);
	} finally { deleteMcp(row.id); syncMcpDownloads(); }
});
