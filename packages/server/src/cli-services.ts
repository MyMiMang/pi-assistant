/**
 * 所有「本机命令行模型渠道」的服务实例（claude / codex / antigravity；再加一家就在这里加一份适配）。
 * 启动（models.ts）、关闭（main.ts）、接口（routes/models.ts）都遍历 `cliServices`，不各写一份。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCliChannelService, type CliChannelService } from "./cli-channel-service.ts";
import { detectAgy, detectClaude, detectCodex, detectOpencode, findAgyCommand, findClaudeCommand, findCodexCommand, findOpencodeCommand, listAgyModels, listOpencodeModels } from "./cli-agents/detect.ts";
import { registerAntigravityModels, registerAntigravityProvider } from "./pi-adapter/cli-models/antigravity.ts";
import { registerClaudeCodeModels, registerClaudeCodeProvider } from "./pi-adapter/cli-models/claude-code.ts";
import { registerCodexModels, registerCodexProvider } from "./pi-adapter/cli-models/codex.ts";
import { registerOpencodeModels, registerOpencodeProvider } from "./pi-adapter/cli-models/opencode.ts";
import { config } from "./config.ts";
import type { PiModels } from "./pi-adapter/index.ts";

const claudeCode = createCliChannelService({
	id: "claude-code",
	label: "Claude Code",
	envName: "CLAUDE_COMMAND",
	find: () => findClaudeCommand(),
	notFound: "没有找到 claude 命令",
	detect: (command) => detectClaude({ command }),
	register: (models, command) => registerClaudeCodeProvider(models, { dataDir: config.dataDir, bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command }),
	refresh: async (models, channel) => void (await registerClaudeCodeModels(models, channel)),
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

/** 要用的 opencode 命令（注册 / 刷新时问 `opencode models --verbose`） */
const opencodeCommand = (command: () => string | null): string => {
	const cmd = command();
	if (!cmd) throw new Error("没有找到 opencode 命令");
	return cmd;
};

const opencode = createCliChannelService({
	id: "opencode-cli",
	label: "OpenCode",
	envName: "OPENCODE_COMMAND",
	find: () => findOpencodeCommand(),
	notFound: "没有找到 opencode 命令",
	detect: (command) => detectOpencode({ command, dataDir: config.dataDir }),
	register: async (models, command) => registerOpencodeProvider(models, { dataDir: config.dataDir, bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command, models: await listOpencodeModels(opencodeCommand(command), { dataDir: config.dataDir }) }),
	refresh: async (models, channel) => void (await registerOpencodeModels(models, channel, await listOpencodeModels(opencodeCommand(opencode.command), { dataDir: config.dataDir }))),
	requireLogin: false, // 自带免费模型，没登录也能用；有没有模型可选看 `opencode models` 能不能列出来
});

export const cliServices: CliChannelService[] = [claudeCode, codex, antigravity, opencode];

/** 启动时在后台并行注册各家渠道（各自问模型列表 / 起进程 / 联网，可能要几十秒，不能挡住服务开始监听）；单家失败只记日志。返回的 Promise 在全部完成（含失败）后落定。 */
export const startCliChannels = (models: PiModels): Promise<void> => Promise.all(cliServices.map((svc) => svc.ensure(models).catch((e) => console.error(`[models] 注册 ${svc.id} 渠道失败`, e)))).then(() => undefined);

/** 某家本机渠道正在后台注册时，等它注册完（最多 `timeoutMs`）；不是本机渠道或没在注册就立刻返回。只等这一家。 */
export async function cliProviderReady(providerId: string | null | undefined, timeoutMs = 60_000): Promise<void> {
	const p = cliServices.find((s) => s.id === providerId)?.registering();
	if (!p) return;
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([p.catch(() => {}), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
	clearTimeout(timer);
}
