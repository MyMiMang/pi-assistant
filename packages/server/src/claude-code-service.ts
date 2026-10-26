/**
 * Claude Code（本机）模型渠道的启动、检测和重新检测（方案 docs/design/cli-models.md §4.5）。
 * 找得到 `claude` 才注册；Mock 模式和单测默认不注册（不因为开发机装了 claude 就改变模型列表），
 * 想在 e2e / 单测里启用就设 `PIA_CLAUDE_COMMAND=<假 claude 的路径>`；设成空字符串表示明确关闭。
 */
import { existsSync } from "node:fs";
import { config, env } from "./config.ts";
import { detectClaude, findClaudeCommand, type ClaudeStatus } from "./cli-agents/detect.ts";
import { registerClaudeCodeProvider } from "./pi-adapter/cli-models/claude-code.ts";
import type { PiModels } from "./pi-adapter/index.ts";

type Channel = Awaited<ReturnType<typeof registerClaudeCodeProvider>>;
let channel: Channel | undefined;
/** 渠道注册在哪个模型目录上（initModels 可能被调用多次，每次换一个新目录，要重新注册） */
let registeredOn: PiModels | undefined;

/** 要用的 claude 路径：环境变量显式指定优先（空 = 关闭）；Mock 模式默认不找；否则在本机找。 */
export function claudeCommand(): string | null {
	const forced = env("CLAUDE_COMMAND");
	if (forced !== undefined) return forced.trim() && existsSync(forced.trim()) ? forced.trim() : null; // 路径还不存在 = 还没装
	return config.mock ? null : findClaudeCommand();
}

export const claudeCodeRegistered = (): boolean => !!channel;

/** 找得到 claude 且还没注册就注册；返回注册后是否可用。 */
export async function ensureClaudeCode(models: PiModels): Promise<boolean> {
	if (channel && registeredOn === models) return true;
	if (!claudeCommand()) return false;
	channel?.disposeAll();
	channel = await registerClaudeCodeProvider(models, {
		dataDir: config.dataDir,
		bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`,
		command: claudeCommand,
	});
	registeredOn = models;
	return true;
}

export interface ClaudeCodeInfo extends ClaudeStatus {
	/** 模型渠道是否已注册（已注册后单聊 / 群聊 / 帮手的模型选择里才有） */
	registered: boolean;
}

/** 检测并（装好了就）注册，不用重启服务。 */
export async function checkClaudeCode(models: PiModels): Promise<ClaudeCodeInfo> {
	const command = claudeCommand();
	const status = command ? await detectClaude({ command }) : { installed: false, loggedIn: false, error: "没有找到 claude 命令" };
	if (status.installed) await ensureClaudeCode(models).catch((e) => console.error("[claude-code] 注册模型渠道失败", e));
	return { ...status, registered: claudeCodeRegistered() };
}

/** 服务关闭：结束还在跑的 claude 进程。 */
export function disposeClaudeCode(): void {
	channel?.disposeAll();
}
