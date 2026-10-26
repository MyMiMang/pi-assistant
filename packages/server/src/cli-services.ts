/**
 * 所有「本机命令行模型渠道」的服务实例（claude / codex / antigravity；再加一家就在这里加一份适配）。
 * 启动（models.ts）、关闭（main.ts）、接口（routes/models.ts）都遍历 `cliServices`，不各写一份。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCliChannelService, type CliChannelService } from "./cli-channel-service.ts";
import { detectAgy, detectClaude, detectCodex, findAgyCommand, findClaudeCommand, findCodexCommand, listAgyModels } from "./cli-agents/detect.ts";
import { registerAntigravityModels, registerAntigravityProvider } from "./pi-adapter/cli-models/antigravity.ts";
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

/** 要用的 agy 命令（注册 / 刷新时问 `agy models`） */
const agyCommand = (command: () => string | null): string => {
	const cmd = command();
	if (!cmd) throw new Error("没有找到 agy 命令");
	return cmd;
};

const antigravity = createCliChannelService({
	id: "antigravity",
	label: "Antigravity",
	envName: "AGY_COMMAND",
	find: () => findAgyCommand(),
	notFound: "没有找到 agy 命令",
	detect: (command) => detectAgy({ command }),
	register: async (models, command) => registerAntigravityProvider(models, { dataDir: config.dataDir, bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command, families: await listAgyModels(agyCommand(command)) }),
	refresh: async (models, channel) => void (await registerAntigravityModels(models, channel, await listAgyModels(agyCommand(antigravity.command)))),
	requireLogin: true, // `agy models` 成功才有模型可选
});

export const cliServices: CliChannelService[] = [claudeCode, codex, antigravity];
