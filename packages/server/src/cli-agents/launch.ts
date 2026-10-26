/**
 * 启动 `claude` 的参数和环境（纯函数，不读文件、不起进程）。方案：docs/design/cli-models.md §4.2。
 *
 * - 环境用**白名单**：只带登录用户家目录、PATH、语言、临时目录、代理这类必要变量，再加几个固定开关。
 *   继承来的 `ANTHROPIC_*`、各家模型密钥一个都不带（带了会报 `401 Invalid bearer token`，也不该把密钥交给子进程）。
 *   家目录 / 临时目录的「OS 账户语义」处理复用 `native-launch-env.ts`。
 * - 不加 `--setting-sources`：用户决定加载他自己的 Claude 设置（登录有可能写在 settings.json 的 env 里）。
 * - 内置工具全关（`--tools ""`），只允许我们的工具桥（MCP 服务名 `pia`，工具名 `mcp__pia__<名字>`）。
 */
import { isAbsolute } from "node:path";
import { nativeLaunchEnv, osAccountHome } from "../native-launch-env.ts";

/** 工具桥在 claude 里的 MCP 服务名；claude 看到的工具名是 `mcp__pia__<工具名>`。 */
export const BRIDGE_SERVER_NAME = "pia";
const BRIDGE_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;
export const toClaudeToolName = (name: string): string => `${BRIDGE_PREFIX}${name}`;
/** 去掉桥的前缀还原成 Pi 里的工具名；不是桥的工具（如 claude 自带的）原样返回。 */
export const fromClaudeToolName = (name: string): string => (name.startsWith(BRIDGE_PREFIX) ? name.slice(BRIDGE_PREFIX.length) : name);

/** 允许传给命令行工具（claude / codex）的环境变量名（按大写比较，Windows 不分大小写；`proxy` 这类小写写法也命中）。 */
const KEEP_ENV = new Set([
	"HOME", "USER", "LOGNAME", "PATH", "SHELL", "TERM", "TZ",
	"LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
	"TMPDIR", "TEMP", "TMP",
	"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
	// Windows
	"SYSTEMROOT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "COMSPEC", "PATHEXT",
	// 网络环境（代理 / 证书）：不是模型密钥，不带的话用代理上网的用户会连不上
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

/** Claude 额外允许的变量：用户自己指定的配置目录（只是位置，不是密钥） */
const CLAUDE_KEEP_ENV = ["CLAUDE_CONFIG_DIR"];

/** 固定加的开关：挡掉用户的 CLAUDE.md；工具调用等审批时不被默认 60 秒超时掐断（实测 1、3）。 */
export const CLAUDE_FIXED_ENV: Record<string, string> = {
	CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
	MCP_TOOL_TIMEOUT: "3600000",
	CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
};

export interface ClaudeEnvInput {
	/** 服务进程环境（默认 `process.env`）；只读 */
	baseEnv?: NodeJS.ProcessEnv;
	/** OS 账户家目录（默认取 `os.userInfo().homedir`）；`null` = 不改写 HOME */
	realHome?: string | null;
	syntheticRoots?: Array<string | undefined>;
	platform?: NodeJS.Platform;
	/** 额外变量（测试用假 claude 选场景等）；不经过白名单，调用方自己负责不放密钥 */
	extra?: Record<string, string>;
}

/**
 * 白名单环境（claude / codex 共用）：只留 `KEEP_ENV` 和 `keepExtra` 里的变量，再加 `fixed` 开关和 `input.extra`。
 * 家目录 / 临时目录的「OS 账户语义」处理在 `nativeLaunchEnv`。
 */
export function buildCliEnv(input: ClaudeEnvInput, keepExtra: readonly string[], fixed: Record<string, string>): NodeJS.ProcessEnv {
	const keep = new Set([...KEEP_ENV, ...keepExtra]);
	const base: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(input.baseEnv ?? process.env)) if (typeof v === "string" && keep.has(k.toUpperCase())) base[k] = v;
	return nativeLaunchEnv({
		baseEnv: base,
		realHome: input.realHome === undefined ? osAccountHome() : input.realHome,
		syntheticRoots: input.syntheticRoots,
		platform: input.platform,
		extra: { ...fixed, ...input.extra },
	}).env;
}

/** 给 `claude` 进程（含 `claude auth status`）用的环境：白名单 + 固定开关。 */
export const buildClaudeEnv = (input: ClaudeEnvInput = {}): NodeJS.ProcessEnv => buildCliEnv(input, CLAUDE_KEEP_ENV, CLAUDE_FIXED_ENV);

export interface ClaudeArgsInput {
	/** 工具桥 MCP 配置文件的绝对路径（私有临时文件；配置里有令牌，不能放命令行，`ps` 看得到） */
	mcpConfigPath: string;
	/** 系统提示文件的绝对路径（私有临时文件；提示可能很长，Windows 命令行有上限，也不该让 `ps` 看到） */
	systemPromptFile?: string;
	/** `replace` 整个替换官方系统提示（默认）；`append` 追加在官方提示后（替换行不通时的兜底，方案 §4.2） */
	systemPromptMode?: "replace" | "append";
	/** `opus` / `sonnet` / `haiku` 或完整模型名 */
	model?: string;
	/** `--effort` 的值（思考强度） */
	effort?: string;
	/** 续用的 claude 会话 id */
	resumeSessionId?: string;
	/** 单次请求（如整理上下文的总结）不在 claude 里留会话记录 */
	noSessionPersistence?: boolean;
}

/** 工具桥的 MCP 配置（JSON 文本，写进私有临时文件）：streamable HTTP，令牌放在 Authorization 头里。 */
export function bridgeMcpConfig(url: string, token: string): string {
	return JSON.stringify({ mcpServers: { [BRIDGE_SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } });
}

/** 拼 `claude` 的参数数组（每轮用户消息起一个进程）。 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
	if (!isAbsolute(input.mcpConfigPath)) throw new Error("mcpConfigPath 必须是绝对路径");
	if (input.systemPromptFile !== undefined && !isAbsolute(input.systemPromptFile)) throw new Error("systemPromptFile 必须是绝对路径");
	const args = [
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--tools", "",
		"--strict-mcp-config",
		"--mcp-config", input.mcpConfigPath,
		"--allowedTools", `${BRIDGE_PREFIX}*`,
		// 默认会把第一次的系统提示「定格」，续用会话时传新的也不生效；群规则 / 权限档位每轮都可能变
		"--system-prompt-snapshot", "off",
	];
	if (input.systemPromptFile !== undefined) args.push(input.systemPromptMode === "append" ? "--append-system-prompt-file" : "--system-prompt-file", input.systemPromptFile);
	if (input.model) args.push("--model", input.model);
	if (input.effort) args.push("--effort", input.effort);
	if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
	if (input.noSessionPersistence) args.push("--no-session-persistence");
	return args;
}
