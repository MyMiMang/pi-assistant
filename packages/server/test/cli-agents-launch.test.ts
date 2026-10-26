import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeMcpConfig, buildClaudeArgs, buildClaudeEnv, fromClaudeToolName, toClaudeToolName } from "../src/cli-agents/launch.ts";

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
	assert.equal(env.PATH, "/usr/bin:/bin");
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
