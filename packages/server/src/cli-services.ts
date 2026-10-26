/**
 * 所有「本机命令行模型渠道」的服务实例（claude / codex；以后加 agy 就在这里加一份适配）。
 * 启动（models.ts）、关闭（main.ts）、接口（routes/models.ts）都遍历 `cliServices`，不各写一份。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCliChannelService, type CliChannelService } from "./cli-channel-service.ts";
import { detectClaude, detectCodex, findClaudeCommand, findCodexCommand } from "./cli-agents/detect.ts";
import { registerClaudeCodeProvider } from "./pi-adapter/cli-models/claude-code.ts";
import { registerCodexModels, registerCodexProvider } from "./pi-adapter/cli-models/codex.ts";
import { config } from "./config.ts";

const claudeCode = createCliChannelService({
	id: "claude-code",
	label: "Claude Code",
	envName: "CLAUDE_COMMAND",
	find: () => findClaudeCommand(),
	notFound: "没有找到 claude 命令",
	detect: (command) => detectClaude({ command }),
	register: (models, command) => registerClaudeCodeProvider(models, { dataDir: config.dataDir, bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command }),
	requireLogin: false,
});

/** Codex 的家目录（只用来判断有没有全局 AGENTS.md） */
const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), ".codex");

const codex = createCliChannelService({
	id: "codex",
	label: "Codex",
	envName: "CODEX_COMMAND",
	find: () => findCodexCommand(),
	notFound: "没有找到 codex 命令",
	detect: (command) => detectCodex({ command }),
	register: (models, command) => registerCodexProvider(models, { dataDir: config.dataDir, command }),
	refresh: async (models, channel) => void (await registerCodexModels(models, channel, true)),
	requireLogin: true, // 先要能问到模型列表才有模型可选
	// 只检查文件在不在，不读内容：`~/.codex/AGENTS.md` 挡不住，会一并发给 Codex
	extra: () => ({ globalAgentsMd: existsSync(join(codexHome(), "AGENTS.md")) }),
});

export const cliServices: CliChannelService[] = [claudeCode, codex];
