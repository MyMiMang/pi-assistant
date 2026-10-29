/**
 * ACP 通用后端和 OpenCode 适配的纯逻辑：通知 → 事件、用量、思考强度挑选、权限选项、OpenCode 启动参数 / 环境 / 配置文件、
 * `opencode models --verbose` 解析、登录凭据路径。不起进程。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { acpUsageOf, configValues, convertAcpUpdate, pickAllowOption, pickEffort } from "../src/cli-agents/acp-events.ts";
import { buildOpencodeArgs, buildOpencodeEnv, opencodeAuthPath, opencodeConfig, opencodeConfigHome, opencodeMcpServers, opencodeProfile } from "../src/cli-agents/opencode-launch.ts";
import { opencodeThinkingMap, parseOpencodeModels } from "../src/cli-agents/opencode-models.ts";

const upd = (u: Record<string, unknown>) => ({ sessionId: "s", update: u });

test("通知 → 事件：文字 / 思考增量、我们工具的 tool_call、上下文占用；别的忽略", () => {
	assert.deepEqual(convertAcpUpdate(upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } }), "pia_"), [{ type: "text_delta", text: "你好" }]);
	assert.deepEqual(convertAcpUpdate(upd({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想" } }), "pia_"), [{ type: "thinking_delta", text: "想" }]);
	assert.deepEqual(convertAcpUpdate(upd({ sessionUpdate: "tool_call", toolCallId: "c1", title: "pia_echo" }), "pia_"), [{ type: "our_tool_call", id: "c1" }]);
	assert.deepEqual(convertAcpUpdate(upd({ sessionUpdate: "tool_call", toolCallId: "c2", title: "bash" }), "pia_"), [], "不是我们的工具不数");
	assert.deepEqual(convertAcpUpdate(upd({ sessionUpdate: "usage_update", used: 846, size: 1000000, cost: { amount: 1 } }), "pia_"), [{ type: "context", used: 846, size: 1000000 }]);
	for (const u of [{ sessionUpdate: "available_commands_update" }, { sessionUpdate: "tool_call_update", toolCallId: "c1" }, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } }, { sessionUpdate: "agent_message_chunk", content: { type: "image" } }]) assert.deepEqual(convertAcpUpdate(upd(u), "pia_"), []);
	assert.deepEqual(convertAcpUpdate(undefined, "pia_"), []);
	assert.deepEqual(convertAcpUpdate({ sessionId: "s" }, "pia_"), []);
});

test("用量：输入不含缓存读取，思考 token 算进输出；缺字段当 0", () => {
	assert.deepEqual(acpUsageOf({ inputTokens: 231, outputTokens: 12, thoughtTokens: 11, cachedReadTokens: 640, totalTokens: 894 }), { input: 231, output: 23, cacheRead: 640, cacheWrite: 0 });
	assert.deepEqual(acpUsageOf({ inputTokens: 5, cachedWriteTokens: 7 }), { input: 5, output: 0, cacheRead: 0, cacheWrite: 7 });
	assert.deepEqual(acpUsageOf(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("挑思考强度：没指定用 default；想要的没有按相近的退；都没有返回 undefined", () => {
	const v = ["low", "high", "max", "default"];
	assert.equal(pickEffort(v, undefined), "default");
	assert.equal(pickEffort(["low"], undefined), undefined);
	assert.equal(pickEffort(v, "high"), "high");
	assert.equal(pickEffort(v, "medium"), "high", "没有 medium 就取 high");
	assert.equal(pickEffort(v, "xhigh"), "max");
	assert.equal(pickEffort(["low", "medium", "high"], "max"), "high");
	assert.equal(pickEffort(["low", "medium", "high"], "minimal"), "low");
	assert.equal(pickEffort([], "high"), undefined);
});

test("配置选项和权限选项", () => {
	const opts = [
		{ id: "model", currentValue: "a/b", options: [{ value: "a/b", name: "B" }, { value: "a/c", name: "C" }] },
		{ id: "effort", currentValue: "low", options: [{ value: "low" }, { value: "default" }] },
	];
	assert.deepEqual(configValues(opts, "model"), { current: "a/b", values: ["a/b", "a/c"] });
	assert.deepEqual(configValues(opts, "effort"), { current: "low", values: ["low", "default"] });
	assert.equal(configValues(opts, "nope"), undefined);
	assert.equal(configValues(undefined, "model"), undefined);
	assert.equal(pickAllowOption([{ optionId: "a", kind: "allow_always" }, { optionId: "o", kind: "allow_once" }, { optionId: "r", kind: "reject_once" }]), "o", "优先「允许一次」");
	assert.equal(pickAllowOption([{ optionId: "a", kind: "allow_always" }, { optionId: "r", kind: "reject_once" }]), "a");
	assert.equal(pickAllowOption([{ optionId: "r", kind: "reject_once" }]), undefined);
	assert.equal(pickAllowOption(undefined), undefined);
});

test("OpenCode 配置文件：权限全 deny 只放行我们的工具、整个换系统提示、关标题请求、MCP 超时写大；没有提示用默认", () => {
	const c = JSON.parse(opencodeConfig("  你是小微  "));
	assert.deepEqual(c.permission, { "*": "deny", "pia_*": "allow" });
	assert.equal(c.agent.build.prompt, "你是小微");
	assert.deepEqual(c.agent.title, { disable: true });
	assert.equal(c.experimental.mcp_timeout, 600_000);
	assert.equal(c.share, "disabled");
	assert.equal(c.autoupdate, false);
	assert.match(JSON.parse(opencodeConfig(undefined)).agent.build.prompt, /只使用提供给你的工具/);
});

test("OpenCode 环境：白名单（不带密钥）、固定开关、隔离的配置目录、配置文件路径；系统提示不进环境变量和命令行", () => {
	const env = buildOpencodeEnv({
		baseEnv: { PATH: "/usr/bin", HOME: "/h", XDG_CONFIG_HOME: "/用户自己的", XDG_DATA_HOME: "/data", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret", OPENCODE_API_KEY: "secret" },
		realHome: "/h",
		dataDir: "/d",
		configPath: "/d/run/opencode.json",
		command: "/opt/bin/opencode",
	});
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined);
	assert.equal(env.OPENCODE_API_KEY, undefined, "白名单：不带任何密钥");
	assert.equal(env.XDG_CONFIG_HOME, opencodeConfigHome("/d"), "配置目录被隔离，不读用户全局 AGENTS.md / 配置");
	assert.equal(env.XDG_DATA_HOME, "/data", "数据目录不动：登录凭据在这里");
	assert.equal(env.OPENCODE_CONFIG, "/d/run/opencode.json");
	assert.deepEqual([env.OPENCODE_DISABLE_CLAUDE_CODE, env.OPENCODE_DISABLE_PROJECT_CONFIG, env.OPENCODE_DISABLE_EXTERNAL_SKILLS, env.OPENCODE_DISABLE_AUTOUPDATE], ["1", "1", "1", "1"]);
	assert.ok(env.PATH?.split(":").includes("/opt/bin"), "命令所在目录补进 PATH");
	assert.equal(buildOpencodeEnv({ baseEnv: {}, realHome: "/h", dataDir: "/d" }).OPENCODE_CONFIG, undefined, "列模型 / 查版本不带配置文件");
	const prompt = "绝密系统提示-xyz";
	const full = opencodeProfile.env({ baseEnv: {}, command: "/x/opencode", dataDir: "/d", runDir: "/d/run" });
	assert.ok(![...Object.values(full), ...buildOpencodeArgs("/d/work")].some((v) => String(v).includes(prompt)));
	assert.deepEqual(buildOpencodeArgs("/d/work"), ["acp", "--cwd", "/d/work"]);
	assert.ok(opencodeProfile.runFiles({ systemPrompt: prompt })[0].content.includes(prompt), "系统提示只在配置文件里");
	assert.equal(opencodeProfile.runFiles({ systemPrompt: prompt })[0].mode, 0o600);
});

test("工具桥的 mcpServers：http 类型，令牌放 Authorization 头（数组形式）", () => {
	assert.deepEqual(opencodeMcpServers("http://127.0.0.1:1/x", "tok"), [{ type: "http", name: "pia", url: "http://127.0.0.1:1/x", headers: [{ name: "Authorization", value: "Bearer tok" }] }]);
});

test("登录凭据路径：尊重 XDG_DATA_HOME，默认 ~/.local/share；取不到家目录返回 null", () => {
	assert.equal(opencodeAuthPath({ XDG_DATA_HOME: "/x" }, "/h"), "/x/opencode/auth.json");
	assert.equal(opencodeAuthPath({}, "/h"), "/h/.local/share/opencode/auth.json");
	assert.equal(opencodeAuthPath({}, null), null);
});

const section = (ref: string, o: Record<string, unknown>) => `${ref}\n${JSON.stringify(o, null, 2)}\n`;
const base = { status: "active", cost: { input: 1, output: 5 }, limit: { context: 200000, output: 32000 }, capabilities: { toolcall: true, input: { text: true, image: false } }, variants: {} };

test("opencode models --verbose 解析：只留支持工具调用的；名字分清 Zen 免费 / 按量、Go 套餐和别的 provider；思考强度、图片、上下文取自 verbose", () => {
	const out = [
		"Fetching…\n",
		section("opencode/free-one", { ...base, id: "free-one", providerID: "opencode", name: "Free One", cost: { input: 0, output: 0 }, variants: { low: {}, high: {}, none: {} } }),
		section("opencode/paid", { ...base, id: "paid", providerID: "opencode", name: "Paid", capabilities: { toolcall: true, input: { image: true } } }),
		section("opencode-go/deepseek-v4.1-flash", { ...base, id: "deepseek-v4.1-flash", providerID: "opencode-go", name: "DeepSeek V4.1 Flash", variants: { low: {}, high: {}, max: {} } }),
		section("anthropic/claude-x", { ...base, id: "claude-x", providerID: "anthropic", name: "Claude X", limit: {} }),
		section("opencode/notools", { ...base, providerID: "opencode", name: "No Tools", capabilities: { toolcall: false } }),
		section("opencode/old", { ...base, providerID: "opencode", name: "Old", status: "deprecated" }),
		"opencode/broken\n{\n  nope\n}\n",
	].join("");
	const list = parseOpencodeModels(out);
	assert.deepEqual(list.map((m) => m.id), ["opencode/free-one", "opencode/paid", "opencode-go/deepseek-v4.1-flash", "anthropic/claude-x"]);
	assert.deepEqual(list.map((m) => m.name), ["Free One（OpenCode Zen 免费）", "Paid（OpenCode Zen 按量）", "DeepSeek V4.1 Flash（OpenCode Go）", "Claude X（anthropic）"]);
	assert.deepEqual(list[0].efforts, ["low", "high", "none"]);
	assert.equal(list[1].image, true);
	assert.deepEqual([list[2].contextWindow, list[2].maxTokens], [200000, 32000]);
	assert.deepEqual([list[3].contextWindow, list[3].maxTokens], [128_000, 16_000], "取不到时保守默认");
	assert.deepEqual(parseOpencodeModels(""), []);
});

test("思考强度映射：只有 variants 里有的档位可选，none 之类不认识的忽略；没有 variants 不给思考强度", () => {
	assert.deepEqual(opencodeThinkingMap(["low", "high", "max", "none"]), { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
	assert.deepEqual(opencodeThinkingMap(["minimal", "medium"]), { minimal: "minimal", low: null, medium: "medium", high: null, xhigh: null, max: null });
	assert.equal(opencodeThinkingMap([]), undefined);
});
