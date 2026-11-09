/**
 * 所有「本机命令行模型渠道」的服务实例（claude / codex / antigravity；再加一家就在这里加一份适配）。
 * 启动（models.ts）、关闭（main.ts）、接口（routes/models.ts）都遍历 `cliServices`，不各写一份。
 */
import { existsSync, readFileSync } from "node:fs";
import { NativeInstaller, type NativeRelease } from "./cli-agents/native-install.ts";
import { authenticateNative, detectNative, type NativeDetection, type NativeId } from "./cli-agents/native-auth.ts";
import { isAbsolute } from "node:path";
import { registerNativeModels, registerNativeProvider, type NativeProviderId } from "./pi-adapter/cli-models/native.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCliChannelService, type CliChannelService } from "./cli-channel-service.ts";
import { detectAgy, detectClaude, detectCodex, detectOpencode, findAgyCommand, findClaudeCommand, findCodexCommand, findOpencodeCommand, listAgyModels, listOpencodeModels } from "./cli-agents/detect.ts";
import { registerAntigravityModels, registerAntigravityProvider } from "./pi-adapter/cli-models/antigravity.ts";
import { registerClaudeCodeModels, registerClaudeCodeProvider } from "./pi-adapter/cli-models/claude-code.ts";
import { registerCodexModels, registerCodexProvider } from "./pi-adapter/cli-models/codex.ts";
import { registerOpencodeModels, registerOpencodeProvider } from "./pi-adapter/cli-models/opencode.ts";
import { claudeCustomModels } from "./claude-custom-models.ts";
import { config } from "./config.ts";
import type { PiModels } from "./pi-adapter/index.ts";

const claudeCode = createCliChannelService({
	id: "claude-code",
	label: "Claude Code",
	envName: "CLAUDE_COMMAND",
	find: () => findClaudeCommand(),
	notFound: "没有找到 claude 命令",
	detect: (command) => detectClaude({ command }),
	register: (models, command) => registerClaudeCodeProvider(models, { dataDir: config.dataDir, bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command, customModels: claudeCustomModels }),
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

const nativeComponents = JSON.parse(readFileSync(join(import.meta.dirname, "../../../third-party.json"), "utf8")).components as Array<NativeRelease & { name: string }>;
const releaseFor = (name: string): NativeRelease => {
	const c = nativeComponents.find((c) => c.name === name);
	if (!c) throw new Error(`缺少 ${name} 安装清单`);
	return { ...c, packageName: c.name };
};
export const nativeInstaller = new NativeInstaller({ dataDir: config.dataDir, releases: { gemini: releaseFor("@google/gemini-cli"), codebuddy: releaseFor("@tencent-ai/codebuddy-code") } });
nativeInstaller.cleanupOnStartup();
nativeInstaller.registerDownloads();

function nativeService(id: NativeProviderId, name: string, envName: string) {
	const tool: NativeId = id === "gemini-cli" ? "gemini" : "codebuddy";
	let cache: { command: string; value: NativeDetection } | undefined;
	let controller: AbortController | undefined;
	let operation: "login" | "install" | "update" | undefined;
	let actionError: string | undefined;
	let latest: NativeRelease | undefined;
	const allowOverride = () => process.env.NODE_ENV !== "production" && (config.mock || process.env.NODE_ENV === "test" || process.env.PIA_DEV === "1");
	const args = () => allowOverride() && process.env[`PIA_${envName}`] !== undefined ? [] : nativeInstaller.installed(tool)?.args ?? [];
	const input = (command: string) => ({ id: tool, command, args: args(), dataDir: config.dataDir });
	const specs = () => (cache?.value.models ?? []).map((m) => ({ ...m, reasoning: false, contextWindow: 32_000, maxTokens: 8_000 }));
	const start = (kind: typeof operation) => {
		if (operation) return { started: false };
		if (kind === "update" && !latest) throw new Error("请先检查更新");
		operation = kind;
		actionError = undefined;
		controller = new AbortController();
		void (async () => {
			if (kind === "login") {
				const command = service.command();
				if (!command) throw new Error("请先安装工具");
				await authenticateNative({ ...input(command), signal: controller!.signal });
			} else await nativeInstaller.install(tool, kind === "update" ? latest : undefined);
			cache = undefined;
			const { models } = await import("./models.ts");
			await service.check(models, true);
		})().catch((e) => { actionError = controller?.signal.aborted ? undefined : e instanceof Error ? e.message : String(e); }).finally(() => { operation = undefined; controller = undefined; });
		return { started: true };
	};
	const service = createCliChannelService({
		id, label: name, envName, managed: true, allowCommandOverride: allowOverride,
		find: () => nativeInstaller.installed(tool)?.command ?? null,
		notFound: `尚未安装 ${name}`,
		invalidate: () => { cache = undefined; },
		detect: async (command): Promise<NativeDetection> => {
			if (cache?.command === command) return cache.value;
			const value = await detectNative(input(command)).catch((e) => ({ installed: isAbsolute(command) && existsSync(command), loggedIn: false, loginUnverified: true, error: e instanceof Error ? e.message : String(e), authMethods: [], models: [] }));
			cache = { command, value };
			return value;
		},
		requireLogin: true,
		extra: () => ({ version: nativeInstaller.installed(tool)?.version, verified: nativeInstaller.installed(tool)?.verified, latestVersion: latest?.version, updateAvailable: !!latest && latest.version !== nativeInstaller.installed(tool)?.version, untestedVersion: !!nativeInstaller.installed(tool) && nativeInstaller.installed(tool)?.version !== releaseFor(tool === "gemini" ? "@google/gemini-cli" : "@tencent-ai/codebuddy-code").version, operation, ...(actionError ? { error: actionError } : {}) }),
		actions: {
			login: () => start("login"), install: () => start("install"), update: () => start("update"),
			"check-update": async () => {
				if (operation) throw new Error("请等当前操作完成");
				latest = await nativeInstaller.checkUpdate(tool);
				return { ok: true };
			},
			cancel: () => { controller?.abort(); nativeInstaller.cancel(tool); return { ok: true }; },
		},
		register: (models, command) => registerNativeProvider(models, id, { dataDir: config.dataDir, bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command, commandArgs: args, nativeModels: specs }),
		refresh: (models, channel) => registerNativeModels(models, channel, id, specs()),
	});
	return service;
}

const gemini = nativeService("gemini-cli", "Gemini CLI", "GEMINI_COMMAND");
const codebuddy = nativeService("codebuddy-cli", "CodeBuddy", "CODEBUDDY_COMMAND");

export const cliServices: CliChannelService[] = [claudeCode, codex, antigravity, opencode, gemini, codebuddy];

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
