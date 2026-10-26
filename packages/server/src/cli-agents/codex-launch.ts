/**
 * 启动 `codex app-server` 的参数和环境（纯函数，不读文件、不起进程）。方案：docs/design/cli-models.md §5.1 第 2 条、§5.2。
 *
 * - 环境用白名单（和 claude 共用 `buildCliEnv`）：只多放行 `CODEX_HOME`（用户自己指定的位置，不是密钥）；不带 `OPENAI_*` 等任何密钥，
 *   登录始终留在 Codex 自己的凭证里，我们不读。
 * - 关掉 Codex 自带的 shell / 改文件 / 网页搜索 / 子代理 / 插件 / 用户配置里的 MCP，只剩我们声明的动态工具（纯大脑）。
 *   用户配置里的 MCP 要逐个按名字 `enabled=false`（`-c mcp_servers={}` 清不掉），名字由 `config/read` 取，只能对「确实存在」的名字写
 *   （对不存在的写会让 app-server 起不来）。
 */
import { buildCliEnv, type ClaudeEnvInput } from "./launch.ts";

const CODEX_KEEP_ENV = ["CODEX_HOME"];

/** 给 `codex` 进程（含 `codex login status`）用的环境：白名单。 */
export const buildCodexEnv = (input: ClaudeEnvInput = {}): NodeJS.ProcessEnv => buildCliEnv(input, CODEX_KEEP_ENV, {});

/** `--disable` 掉的功能（实测只剩我们的工具和 request_user_input）。 */
export const CODEX_DISABLED_FEATURES = [
	"shell_tool", "unified_exec", "multi_agent", "multi_agent_v2",
	"apps", "plugins", "browser_use", "browser_use_external", "computer_use",
	"image_generation", "view_image", "skill_search", "tool_suggest", "goals",
	"sleep_tool", "in_app_browser", "hooks", "memories",
	"default_mode_request_user_input", "collaboration_modes", "tool_search", "personality",
] as const;

/** 固定的 `-c`：不要网页搜索 / 内置技能 / 环境上下文 / 工作目录里的 AGENTS.md。 */
export const CODEX_FIXED_CONFIG = ['web_search="disabled"', "skills.bundled.enabled=false", "include_environment_context=false", "project_doc_max_bytes=0"] as const;

/** TOML 里的键：普通名字原样写，带点 / 空格等特殊字符的加引号（`mcp_servers."a.b".enabled`）。 */
export const tomlKey = (name: string): string => (/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name));

/** 拼 `codex app-server` 的参数数组。`mcpNames`：用户配置里的 MCP 名字，逐个关掉。 */
export function buildCodexArgs(mcpNames: readonly string[] = []): string[] {
	const args = ["app-server"];
	for (const f of CODEX_DISABLED_FEATURES) args.push("--disable", f);
	for (const c of CODEX_FIXED_CONFIG) args.push("-c", c);
	for (const n of mcpNames) args.push("-c", `mcp_servers.${tomlKey(n)}.enabled=false`);
	return args;
}
