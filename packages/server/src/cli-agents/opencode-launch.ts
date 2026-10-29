/**
 * 启动 OpenCode（`opencode acp`）要的参数、环境和配置文件（纯函数，不读文件、不起进程）。方案：docs/design/acp-cli-models.md。
 *
 * 配置全部是**进程级**的（换系统提示要重启进程再 `session/resume`），写在运行目录里的一个配置文件，用 `OPENCODE_CONFIG` 指过去：
 * 系统提示和工具桥令牌都不放环境变量或命令行（`ps` 看得到）。工具桥本身不写在配置里，经 ACP `session/new` 的 `mcpServers` 挂（令牌放 Authorization 头）。
 *
 *  - `permission`：全 deny，只 allow 我们的 MCP 工具（`pia_*`，服务名 `pia`）→ OpenCode 自带的读写文件 / 命令 / 联网等一个都用不了。
 *  - `agent.build.prompt`：整个替换默认系统提示（实测只会再追加约 250 字环境信息和模型名）。
 *  - `agent.title.disable`：关掉「给会话起标题」的隐藏额外模型请求（实测没有别的隐藏请求）。
 *  - `experimental.mcp_timeout`：默认 60 秒会掐断等审批的工具调用（实测），写大。
 *  - `share: disabled`、`autoupdate: false`：不分享、不自动升级。
 *
 * 隔离用户自己的全局设置：
 *  - OpenCode 的全局指令文件是 `<配置目录>/AGENTS.md`，配置目录是 `$XDG_CONFIG_HOME/opencode`；没有单独关它的开关（查过 1.18.35 的环境变量），
 *    所以把 `XDG_CONFIG_HOME` 指到 `<dataDir>/cli-models/opencode-config`（用户全局的配置、插件、MCP、AGENTS.md 都读不到）。
 *    登录凭据在 `$XDG_DATA_HOME/opencode/auth.json`，`XDG_DATA_HOME` 不动，所以登录不受影响。副作用：用户在全局配置里自定义的 provider 用不了，用 `opencode auth login` 登录的可以。
 *  - `OPENCODE_DISABLE_CLAUDE_CODE=1`：不读 `~/.claude/CLAUDE.md` 和 `.claude/skills`；`OPENCODE_DISABLE_PROJECT_CONFIG=1`：不读工作目录往上的 AGENTS.md / opencode.json；
 *    `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`：不读外部技能目录；`OPENCODE_DISABLE_AUTOUPDATE=1`。
 * 环境同样用白名单（复用 `buildCliEnv`）：不带任何模型密钥。
 */
import { join } from "node:path";
import type { AcpProfile } from "./acp-process.ts";
import { buildCliEnv, type ClaudeEnvInput } from "./launch.ts";

/** 工具桥在 OpenCode 里的 MCP 服务名；模型看到的工具名是 `pia_<工具名>`（ACP 的 tool_call 标题也是这个） */
export const OPENCODE_SERVER_NAME = "pia";
export const OPENCODE_TOOL_PREFIX = `${OPENCODE_SERVER_NAME}_`;
/** 配置文件名（在运行目录里） */
export const OPENCODE_CONFIG_FILE = "opencode.json";

/** 固定加的开关：挡掉用户的全局指令和项目级配置，不自动升级 */
export const OPENCODE_FIXED_ENV: Record<string, string> = {
	OPENCODE_DISABLE_CLAUDE_CODE: "1",
	OPENCODE_DISABLE_PROJECT_CONFIG: "1",
	OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
	OPENCODE_DISABLE_AUTOUPDATE: "1",
};

/** 隔离用的配置目录（`XDG_CONFIG_HOME`）：`<dataDir>/cli-models/opencode-config` */
export const opencodeConfigHome = (dataDir: string): string => join(dataDir, "cli-models", "opencode-config");

export interface OpencodeEnvInput extends ClaudeEnvInput {
	dataDir: string;
	/** 运行目录里的配置文件绝对路径（`opencode acp` 要；列模型 / 查版本不要） */
	configPath?: string;
}

/** OpenCode 的环境：白名单 + 固定开关 + 隔离的配置目录（+ 配置文件） */
export function buildOpencodeEnv(input: OpencodeEnvInput): NodeJS.ProcessEnv {
	const { dataDir, configPath, extra, ...rest } = input;
	return buildCliEnv({ ...rest, extra }, [], { ...OPENCODE_FIXED_ENV, XDG_CONFIG_HOME: opencodeConfigHome(dataDir), ...(configPath ? { OPENCODE_CONFIG: configPath } : {}) });
}

/** 登录凭据文件的位置（`$XDG_DATA_HOME/opencode/auth.json`，默认 `~/.local/share/opencode/auth.json`，各平台都一样）。**只用来判断文件在不在，绝不读内容。** */
export const opencodeAuthPath = (env: NodeJS.ProcessEnv, home: string | null): string | null => {
	const base = env.XDG_DATA_HOME?.trim() || (home ? join(home, ".local", "share") : "");
	return base ? join(base, "opencode", "auth.json") : null;
};

/** `opencode acp` 的参数：工作目录固定（会话续接要在同一个目录里） */
export const buildOpencodeArgs = (workDir: string): string[] => ["acp", "--cwd", workDir];

/** 配置文件内容（JSON 文本，写进运行目录，0600） */
export function opencodeConfig(systemPrompt: string | undefined): string {
	return JSON.stringify({
		permission: { "*": "deny", [`${OPENCODE_TOOL_PREFIX}*`]: "allow" },
		agent: { build: { prompt: systemPrompt?.trim() || "你是一个有帮助的助理，只使用提供给你的工具。" }, title: { disable: true } },
		experimental: { mcp_timeout: 600_000 },
		share: "disabled",
		autoupdate: false,
	});
}

/** ACP `session/new` / `session/resume` 的 `mcpServers`：工具桥，http 类型，随机令牌放 Authorization 头 */
export const opencodeMcpServers = (url: string, token: string): unknown[] => [{ type: "http", name: OPENCODE_SERVER_NAME, url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] }];

/** OpenCode 的 ACP 适配配置（通用 ACP 后端 `acp-process.ts` / `pi-adapter/cli-models/acp.ts` 拿它启动） */
export const opencodeProfile: AcpProfile = {
	label: "OpenCode",
	toolPrefix: OPENCODE_TOOL_PREFIX,
	args: buildOpencodeArgs,
	env: (i) => buildOpencodeEnv({ baseEnv: i.baseEnv, command: i.command, dataDir: i.dataDir, configPath: join(i.runDir, OPENCODE_CONFIG_FILE), extra: i.extra }),
	runFiles: (i) => [{ path: OPENCODE_CONFIG_FILE, content: opencodeConfig(i.systemPrompt), mode: 0o600 }],
	mcpServers: opencodeMcpServers,
};
