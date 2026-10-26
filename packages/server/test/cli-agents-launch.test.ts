import "./setup.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bridgeMcpConfig, buildClaudeArgs, buildClaudeEnv, buildCliEnv, commonCliDirs, fromClaudeToolName, toClaudeToolName } from "../src/cli-agents/launch.ts";

const dirty: NodeJS.ProcessEnv = {
	HOME: "/Users/x",
	PATH: "/usr/bin:/bin",
	USER: "x",
	LANG: "zh_CN.UTF-8",
	TMPDIR: "/var/folders/x/T/",
	https_proxy: "http://127.0.0.1:7890",
	ANTHROPIC_AUTH_TOKEN: "sk-ant-secret",
	ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
	ANTHROPIC_API_KEY: "sk-ant-key",
	OPENAI_API_KEY: "sk-openai",
	AWS_SECRET_ACCESS_KEY: "aws",
	GITHUB_TOKEN: "ghp",
	CFFIXED_USER_HOME: "/tmp/fake",
	PIA_DATA_DIR: "/tmp/pia",
};

test("claude 环境：白名单，去掉 ANTHROPIC_* 和其他密钥，加固定开关", () => {
	const env = buildClaudeEnv({ baseEnv: dirty, realHome: "/Users/x" });
	assert.equal(env.HOME, "/Users/x");
	assert.ok(env.PATH?.startsWith("/usr/bin:/bin"), "原 PATH 保持在最前面");
	assert.equal(env.USER, "x");
	assert.equal(env.LANG, "zh_CN.UTF-8");
	assert.equal(env.TMPDIR, "/var/folders/x/T/");
	assert.equal(env.https_proxy, "http://127.0.0.1:7890", "小写代理变量也保留");
	for (const k of Object.keys(env)) assert.doesNotMatch(k, /^ANTHROPIC_|API_KEY|TOKEN|SECRET|^PIA_|CFFIXED/, k);
	assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
	assert.equal(env.MCP_TOOL_TIMEOUT, "3600000");
	assert.equal(env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, "0");
});

test("claude 环境：服务跑在合成 HOME 下时用 OS 账户家目录，合成 TMPDIR 不传", () => {
	const env = buildClaudeEnv({ baseEnv: { ...dirty, HOME: "/tmp/pia-test-1", TMPDIR: "/tmp/pia-test-1/tmp" }, realHome: "/Users/x" });
	assert.equal(env.HOME, "/Users/x");
	assert.equal(env.TMPDIR, undefined);
});

test("claude 环境：额外变量最后加上；不改传入的环境对象", () => {
	const base = { ...dirty };
	const env = buildClaudeEnv({ baseEnv: base, realHome: "/Users/x", extra: { FAKE_CLAUDE_SCENARIO: "text" } });
	assert.equal(env.FAKE_CLAUDE_SCENARIO, "text");
	assert.deepEqual(base, dirty);
});

test("claude 参数：内置工具全关、只许工具桥、配置和系统提示走文件、不加 --setting-sources", () => {
	const args = buildClaudeArgs({ mcpConfigPath: "/tmp/p/mcp.json", systemPromptFile: "/tmp/p/sp.txt", model: "sonnet", effort: "high", resumeSessionId: "sess-1" });
	const at = (flag: string) => args[args.indexOf(flag) + 1];
	assert.equal(args[0], "-p");
	assert.equal(at("--input-format"), "stream-json");
	assert.equal(at("--output-format"), "stream-json");
	assert.ok(args.includes("--include-partial-messages") && args.includes("--verbose"));
	assert.equal(at("--tools"), "");
	assert.ok(args.includes("--strict-mcp-config"));
	assert.equal(at("--mcp-config"), "/tmp/p/mcp.json");
	assert.equal(at("--allowedTools"), "mcp__pia__*");
	assert.equal(at("--system-prompt-snapshot"), "off");
	assert.equal(at("--system-prompt-file"), "/tmp/p/sp.txt");
	assert.ok(!args.includes("--system-prompt"));
	assert.equal(at("--model"), "sonnet");
	assert.equal(at("--effort"), "high");
	assert.equal(at("--resume"), "sess-1");
	assert.ok(!args.includes("--setting-sources"));
	assert.ok(!args.includes("--bare"));
});

test("工具桥配置：streamable HTTP，令牌在 Authorization 头里", () => {
	const cfg = JSON.parse(bridgeMcpConfig("http://127.0.0.1:8787/internal/tool-bridge/r1", "tok"));
	assert.deepEqual(cfg.mcpServers.pia, { type: "http", url: "http://127.0.0.1:8787/internal/tool-bridge/r1", headers: { Authorization: "Bearer tok" } });
});

test("claude 参数：可选项不给就不出现；append 模式；路径必须是绝对路径", () => {
	const args = buildClaudeArgs({ mcpConfigPath: "/tmp/mcp.json", systemPromptFile: "/tmp/sp.txt", systemPromptMode: "append" });
	for (const f of ["--model", "--effort", "--resume", "--system-prompt-file"]) assert.ok(!args.includes(f), f);
	assert.equal(args[args.indexOf("--append-system-prompt-file") + 1], "/tmp/sp.txt");
	assert.ok(!buildClaudeArgs({ mcpConfigPath: "/tmp/mcp.json" }).some((a) => a.includes("system-prompt-file")));
	assert.throws(() => buildClaudeArgs({ mcpConfigPath: "relative/mcp.json" }), /mcpConfigPath/);
	assert.throws(() => buildClaudeArgs({ mcpConfigPath: '{"mcpServers":{}}' }), /mcpConfigPath/);
	assert.throws(() => buildClaudeArgs({ mcpConfigPath: "/tmp/mcp.json", systemPromptFile: "sp.txt" }), /systemPromptFile/);
});

test("工具名前缀互相转换，非桥的工具原样", () => {
	assert.equal(toClaudeToolName("memory_search"), "mcp__pia__memory_search");
	assert.equal(fromClaudeToolName("mcp__pia__memory_search"), "memory_search");
	assert.equal(fromClaudeToolName("web_search"), "web_search");
});

const SHORT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

test("补 PATH：原 PATH 在前，再补命令所在目录和常用目录，不重复", () => {
	const env = buildCliEnv({ baseEnv: { PATH: SHORT_PATH, HOME: "/Users/x" }, realHome: "/Users/x", command: "/x/y/codex", platform: "darwin" }, [], {});
	const dirs = (env.PATH ?? "").split(":");
	assert.deepEqual(dirs.slice(0, 4), ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
	assert.ok(dirs.includes("/x/y"));
	for (const d of commonCliDirs("/Users/x", "darwin")) assert.ok(dirs.includes(d), d);
	assert.ok(dirs.includes("/Users/x/.local/bin") && dirs.includes("/opt/homebrew/bin"));
	assert.equal(new Set(dirs).size, dirs.length);
	// 命令目录已在 PATH 里时不重复
	const again = buildCliEnv({ baseEnv: { PATH: "/usr/bin:/x/y" }, realHome: null, command: "/x/y/codex", platform: "darwin" }, [], {});
	assert.equal(again.PATH?.split(":").filter((d) => d === "/x/y").length, 1);
});

test("补 PATH：Windows 用分号，键名沿用 Path", () => {
	const env = buildCliEnv({ baseEnv: { Path: "C:\\Windows" }, realHome: "C:\\Users\\x", command: "C:\\tools\\codex.cmd", platform: "win32" }, [], {});
	assert.ok(env.Path?.startsWith("C:\\Windows;C:\\tools;"));
	assert.equal(env.PATH, undefined);
});

test("模拟 App 短 PATH 启动：补了命令目录才找得到 node", () => {
	if (process.platform === "win32") return;
	const dir = mkdtempSync(join(tmpdir(), "pia-path-"));
	try {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "node"), "#!/bin/sh\necho fake-node \"$@\"\nexit 0\n");
		writeFileSync(join(bin, "fakecli"), "#!/usr/bin/env node\nconsole.log('x')\n");
		chmodSync(join(bin, "node"), 0o755);
		chmodSync(join(bin, "fakecli"), 0o755);
		const command = join(bin, "fakecli");
		const fixed = buildCliEnv({ baseEnv: { PATH: SHORT_PATH }, realHome: null, command }, [], {});
		const ok = spawnSync(command, ["a"], { env: fixed, encoding: "utf8" });
		assert.equal(ok.status, 0, ok.stderr);
		assert.match(ok.stdout, /fake-node/);
		// 不补 PATH（原样传短 PATH）时，系统 PATH 里没有 node，起不来：证明这条测试确实复现了问题
		const broken = spawnSync(command, ["a"], { env: { PATH: SHORT_PATH }, encoding: "utf8" });
		assert.notEqual(broken.status, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
