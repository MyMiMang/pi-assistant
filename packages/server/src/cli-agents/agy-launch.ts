/**
 * 启动 Antigravity CLI（`agy`）要的参数、环境和运行目录文件（纯函数，不读文件、不起进程）。方案：docs/design/cli-models.md §5b。
 *
 * agy 没有「按次指定 MCP / 系统提示」的命令行参数，只能靠**运行目录里的项目级文件**（不碰用户全局配置 `~/.gemini`）：
 *   <运行目录>/.agents/agents/pia.md               自定义代理：只剩我们的系统提示，自带工具全关
 *   <运行目录>/.agents/plugins/pia/plugin.json     插件清单
 *   <运行目录>/.agents/plugins/pia/mcp_config.json 工具桥的 MCP 配置（带令牌，0600）
 * 环境同样用白名单（复用 `buildCliEnv`）：不带任何模型密钥；登录凭据在用户家目录下，由 agy 自己读，我们不碰。
 */
import { posix } from "node:path";
import { buildCliEnv, type ClaudeEnvInput } from "./launch.ts";
import type { CallKeyFn } from "./tool-bridge.ts";

/** 自定义代理名（`--agent pia`）、插件名、MCP 服务名 */
export const AGY_AGENT = "pia";
/** agy 里模型看到的工具名是 `mcp_<插件名>_<服务名>_<工具名>`；MCP 请求里的 `params.name` 是原始名（实测） */
const AGY_TOOL_PREFIX = "mcp_pia_pia_";
/** 去掉前缀还原成 Pi 里的工具名；不是桥的工具（agy 残留的 list_resources 等）`mine` 为 false。 */
export const fromAgyToolName = (name: string): { name: string; mine: boolean } => (name.startsWith(AGY_TOOL_PREFIX) ? { name: name.slice(AGY_TOOL_PREFIX.length), mine: true } : { name, mine: false });

/** agy 的环境：白名单 + 没有固定开关 */
export const buildAgyEnv = (input: ClaudeEnvInput = {}): NodeJS.ProcessEnv => buildCliEnv(input, [], {});

/** `tools/call` 的配对键 = `progressToken` 末段的 `step_index`（格式 `<uuid>:<step_index>`，和 stdout 里 tool 步骤的 `step_index` 一致，实测） */
export const agyCallKey: CallKeyFn = (meta) => {
	const token = meta.progressToken;
	const tail = typeof token === "string" ? token.split(":").pop() : undefined;
	return tail && /^\d+$/.test(tail) ? tail : undefined;
};

export interface AgyArgsInput {
	/** agy 里的完整模型 id，如 `claude-sonnet-5-5-high`（思考强度是 id 的末段） */
	model: string;
	/** 续用的会话 id（`--conversation`） */
	conversationId?: string;
}

/**
 * 长驻进程的参数：`-p ""` 必须放在最后；之后每行 stdin 写一条用户消息、读 NDJSON。
 * 一条消息一轮，stdin 关闭后进程退出。
 */
export function buildAgyArgs(input: AgyArgsInput): string[] {
	const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--model", input.model, "--agent", AGY_AGENT];
	if (input.conversationId) args.push("--conversation", input.conversationId);
	args.push("-p", "");
	return args;
}

/** 代理文件 `pia.md`：整段系统提示在会话开始时定死（续用会话改了也不生效，所以系统提示变了要新开会话） */
export function agyAgentFile(systemPrompt: string | undefined): string {
	return [
		"---",
		`name: ${AGY_AGENT}`,
		"description: Pi Assistant 的纯大脑代理",
		"mainAgent: true",
		"excludeDefaultComponents: true",
		"tools: []",
		"inheritMcp: false",
		"---",
		systemPrompt?.trim() || "你是一个有帮助的助理，只使用提供给你的工具。",
		"",
	].join("\n");
}

export const agyPluginJson = (): string => JSON.stringify({ name: AGY_AGENT, description: "Pi Assistant 的工具桥", version: "1" });

/** 工具桥的 MCP 配置：streamable HTTP + Bearer 令牌；`timeoutSeconds` 要写大（默认 180 秒会掐断审批中的工具），键名必须是这个（实测） */
export const agyMcpConfig = (url: string, token: string): string =>
	JSON.stringify({ mcpServers: { [AGY_AGENT]: { url, headers: { Authorization: `Bearer ${token}` }, timeoutSeconds: 3600 } } });

export interface AgyRunFile {
	/** 相对运行目录的路径（正斜杠） */
	path: string;
	content: string;
	/** 文件权限；含令牌 / 提示的都是 0600 */
	mode: number;
}

/** 一次运行要写进运行目录的全部文件 */
export function agyRunFiles(input: { systemPrompt: string | undefined; bridgeUrl: string; token: string }): AgyRunFile[] {
	return [
		{ path: `.agents/agents/${AGY_AGENT}.md`, content: agyAgentFile(input.systemPrompt), mode: 0o600 },
		{ path: `.agents/plugins/${AGY_AGENT}/plugin.json`, content: agyPluginJson(), mode: 0o600 },
		{ path: `.agents/plugins/${AGY_AGENT}/mcp_config.json`, content: agyMcpConfig(input.bridgeUrl, input.token), mode: 0o600 },
	];
}

/** 写文件前要先建的目录（相对运行目录） */
export const agyRunDirs = (files: readonly AgyRunFile[]): string[] => [...new Set(files.map((f) => posix.dirname(f.path)))];
