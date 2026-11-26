/**
 * 所有「本机命令行模型渠道」的服务实例（claude / codex / antigravity；再加一家就在这里加一份适配）。
 * 启动（models.ts）、关闭（main.ts）、接口（routes/models.ts）都遍历 `cliServices`，不各写一份。
 */
import { NATIVE_ACP_AGENTS } from "@pi-assistant/shared";
import { nativeService } from "./native-cli-service.ts";
import { managedCliEnv } from "./cli-agents/managed-env.ts";
import { managedActions } from "./cli-agents/managed-actions.ts";
import { nativeInstaller, managedArgs } from "./cli-agents/managed-install.ts";
export { nativeInstaller } from "./cli-agents/managed-install.ts";
import { createCliChannelService, type CliChannelService } from "./cli-channel-service.ts";
import { detectAgy, detectClaude, detectCodex, detectOpencode, listAgyModels, listOpencodeModels } from "./cli-agents/detect.ts";
import { agyAccountGate } from "./cli-agents/agy-account-gate.ts";
import { accountScope } from "./cli-agents/agy-account-journal.ts";
import { registerAntigravityModels, registerAntigravityProvider } from "./pi-adapter/cli-models/antigravity.ts";
import { registerClaudeCodeModels, registerClaudeCodeProvider } from "./pi-adapter/cli-models/claude-code.ts";
import { registerCodexModels, registerCodexProvider } from "./pi-adapter/cli-models/codex.ts";
import { registerOpencodeModels, registerOpencodeProvider } from "./pi-adapter/cli-models/opencode.ts";
import { claudeCustomModels } from "./claude-custom-models.ts";
import { config } from "./config.ts";
import type { PiModels } from "./pi-adapter/index.ts";

const refreshManaged = async (service: CliChannelService) => {
 const { models } = await import("./models.ts");
 await service.check(models, true);
};
const claudeManaged = managedActions("claude-code", "CLAUDE_COMMAND", () => claudeCode.command(), () => refreshManaged(claudeCode));
const claudeCode = createCliChannelService({
 ...claudeManaged,
	id: "claude-code",
	label: "Claude Code",
	envName: "CLAUDE_COMMAND",
	managed: true,
	allowCommandOverride: () => process.env.NODE_ENV !== "production" && (config.mock || process.env.NODE_ENV === "test" || process.env.PIA_DEV === "1"),
	find: () => nativeInstaller.installed("claude-code")?.command ?? null,
	notFound: "还没在 Pi 里安装 Claude Code：到 设置 › 模型服务 › 编程工具 里点「安装」，装好后点「登录」。",
	detect: (command) => detectClaude({ command, commandArgs: managedArgs("claude-code", "CLAUDE_COMMAND"), baseEnv: managedCliEnv(config.dataDir, "claude-code") }),
	register: (models, command) => registerClaudeCodeProvider(models, { dataDir: config.dataDir, bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command, commandArgs: () => managedArgs("claude-code", "CLAUDE_COMMAND"), customModels: claudeCustomModels }),
	refresh: async (models, channel) => void (await registerClaudeCodeModels(models, channel)),
	requireLogin: false,
});

const codexManaged = managedActions("codex", "CODEX_COMMAND", () => codex.command(), () => refreshManaged(codex));
const codex = createCliChannelService({
 ...codexManaged,
	id: "codex",
	label: "Codex",
	envName: "CODEX_COMMAND",
	managed: true,
	allowCommandOverride: () => process.env.NODE_ENV !== "production" && (config.mock || process.env.NODE_ENV === "test" || process.env.PIA_DEV === "1"),
	find: () => nativeInstaller.installed("codex")?.command ?? null,
	notFound: "还没在 Pi 里安装 Codex：到 设置 › 模型服务 › 编程工具 里点「安装」，装好后点「登录」。",
	detect: (command) => detectCodex({ command, commandArgs: managedArgs("codex", "CODEX_COMMAND"), baseEnv: managedCliEnv(config.dataDir, "codex") }),
	register: (models, command) => registerCodexProvider(models, { dataDir: config.dataDir, command, commandArgs: () => managedArgs("codex", "CODEX_COMMAND") }),
	refresh: async (models, channel) => void (await registerCodexModels(models, channel, true)),
	requireLogin: true, // 先要能问到模型列表才有模型可选
});

/** 要用的 agy 命令（注册 / 刷新时问 `agy models`） */
const agyCommand = (command: () => string | null): string => {
	const cmd = command();
	if (!cmd) throw new Error("还没在 Pi 里安装 Antigravity：到 设置 › 模型服务 › 编程工具 里点「安装」，装好后点「登录」。");
	return cmd;
};

const agyManaged = managedActions("antigravity", "AGY_COMMAND", () => antigravity.command(), () => refreshManaged(antigravity));
async function probeManagedAgy<T>(probe: () => Promise<T>): Promise<T> {
	if (!accountScope()) throw new Error("Antigravity 当前账号尚未核对");
	const release = agyAccountGate.start();
	if (!release) throw new Error("Antigravity 账号正在切换或尚未核对");
	try { return await probe(); } finally { release(); }
}
const agyOptions = () => ({ dataDir: config.dataDir, commandArgs: managedArgs("antigravity", "AGY_COMMAND") });
let lastAgyLogin: { revision: number; loggedIn: boolean } | undefined;
const antigravity = createCliChannelService({
 ...agyManaged,
	id: "antigravity",
	label: "Antigravity",
	envName: "AGY_COMMAND",
	managed: true,
	allowCommandOverride: () => process.env.NODE_ENV !== "production" && (config.mock || process.env.NODE_ENV === "test" || process.env.PIA_DEV === "1"),
	find: () => nativeInstaller.installed("antigravity")?.command ?? null,
	notFound: "还没在 Pi 里安装 Antigravity：到 设置 › 模型服务 › 编程工具 里点「安装」，装好后点「登录」。",
	busyStatus: (command) => {
		const revision = agyManaged.busyRevision();
		if (revision === undefined) return undefined;
		return { installed: !!command(), loggedIn: false, statusPending: true,
			previousLoggedIn: lastAgyLogin && lastAgyLogin.revision === revision - 1 ? lastAgyLogin.loggedIn : undefined };
	},
	detect: (command) => probeManagedAgy(async () => {
		const revision = agyAccountGate.readRevision();
		const status = await detectAgy({ command, ...agyOptions() });
		if (revision !== null) lastAgyLogin = !status.error || (status.installed && /authentication required|not (?:logged|signed) in|login required/i.test(status.error))
			? { revision, loggedIn: status.loggedIn } : undefined;
		return status;
	}),
	register: async (models, command) => registerAntigravityProvider(models, { dataDir: config.dataDir, bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command, commandArgs: () => agyOptions().commandArgs, families: await probeManagedAgy(() => listAgyModels(agyCommand(command), agyOptions())) }),
	refresh: async (models, channel) => void (await registerAntigravityModels(models, channel, await probeManagedAgy(() => listAgyModels(agyCommand(antigravity.command), agyOptions())))),
	requireLogin: true, // `agy models` 成功才有模型可选
});

/** 要用的 opencode 命令（注册 / 刷新时问 `opencode models --verbose`） */
const opencodeCommand = (command: () => string | null): string => {
	const cmd = command();
	if (!cmd) throw new Error("还没在 Pi 里安装 OpenCode：到 设置 › 模型服务 › 编程工具 里点「安装」，装好后点「登录」。");
	return cmd;
};

const opencodeManaged = managedActions("opencode", "OPENCODE_COMMAND", () => opencode.command(), () => refreshManaged(opencode));
const opencode = createCliChannelService({
 ...opencodeManaged,
	id: "opencode-cli",
	label: "OpenCode",
	envName: "OPENCODE_COMMAND",
	managed: true,
	allowCommandOverride: () => process.env.NODE_ENV !== "production" && (config.mock || process.env.NODE_ENV === "test" || process.env.PIA_DEV === "1"),
	find: () => nativeInstaller.installed("opencode")?.command ?? null,
	notFound: "还没在 Pi 里安装 OpenCode：到 设置 › 模型服务 › 编程工具 里点「安装」，装好后点「登录」。",
	detect: (command) => detectOpencode({ command, commandArgs: managedArgs("opencode", "OPENCODE_COMMAND"), dataDir: config.dataDir }),
	register: async (models, command) => registerOpencodeProvider(models, { dataDir: config.dataDir, commandArgs: () => managedArgs("opencode", "OPENCODE_COMMAND"), bridgeBaseUrl: () => `http://127.0.0.1:${config.port}`, command, models: await listOpencodeModels(opencodeCommand(command), { commandArgs: managedArgs("opencode", "OPENCODE_COMMAND"), dataDir: config.dataDir }) }),
	refresh: async (models, channel) => void (await registerOpencodeModels(models, channel, await listOpencodeModels(opencodeCommand(opencode.command), { commandArgs: managedArgs("opencode", "OPENCODE_COMMAND"), dataDir: config.dataDir }))),
	requireLogin: false, // 自带免费模型，没登录也能用；有没有模型可选看 `opencode models` 能不能列出来
});


nativeInstaller.cleanupOnStartup();
nativeInstaller.registerDownloads();

export const antigravityRtRuntime = () => ({
	command: () => antigravity.command(),
	commandArgs: () => managedArgs("antigravity", "AGY_COMMAND"),
	refresh: () => refreshManaged(antigravity),
});

export const cliServices: CliChannelService[] = [claudeCode, codex, antigravity, opencode, ...NATIVE_ACP_AGENTS.map(a => nativeService(a.id))];

/** 启动时在后台并行注册各家渠道（各自问模型列表 / 起进程 / 联网，可能要几十秒，不能挡住服务开始监听）；单家失败只记日志。返回的 Promise 在全部完成（含失败）后落定。 */
export const startCliChannels = (models: PiModels): Promise<void> => Promise.all(cliServices.map((svc) => svc.ensure(models).catch((e) => console.error(`[models] 注册 ${svc.id} 渠道失败`, e)))).then(() => undefined);

/** 本机渠道的唯一识别入口，包含配置表生成的原生 ACP。 */
export const cliServiceFor = (provider: string | null | undefined) => cliServices.find(s => s.id === provider);

export function cliModelError(provider: string | null | undefined): string | null {
	const svc = cliServiceFor(provider);
	if (!svc) return null;
	const reason = (svc.error() || (svc.registering() ? "模型列表仍在加载，请稍后再试" : "所选模型尚未注册或已不在模型列表中")).replace(/\s+/g, " ").slice(0, 300);
	return `${svc.label} 暂时没连上（${reason}），这一轮没有改用其他模型。稍后再发一次，或到 设置 › 模型服务 里点「重新检测」。`;
}

/** 只为缺失的本机渠道模型触发注册；等待上限与启动等待共用。 */
export async function resolveCliModel(models: PiModels, pick: { provider: string; id: string }, timeoutMs = 60_000): Promise<void> {
	const svc = cliServiceFor(pick.provider);
	if (!svc || models.getModel(pick.provider, pick.id)) return;
	const p = svc.registering() ?? svc.ensure(models);
	await waitRegistration(p, timeoutMs);
	if (!models.getModel(pick.provider, pick.id)) throw new Error(cliModelError(pick.provider)!);
}

async function waitRegistration(p: Promise<boolean>, timeoutMs: number) {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([p.catch(() => {}), new Promise<void>(r => { timer = setTimeout(r, timeoutMs); timer.unref(); })]);
	} finally { clearTimeout(timer); }
}

/** 某家本机渠道正在后台注册时，等它注册完（最多 `timeoutMs`）；不是本机渠道或没在注册就立刻返回。只等这一家。 */
export async function cliProviderReady(providerId: string | null | undefined, timeoutMs = 60_000): Promise<void> {
	const p = cliServices.find((s) => s.id === providerId)?.registering();
	if (!p) return;
	await waitRegistration(p, timeoutMs);
}
