/**
 * `opencode` 模型渠道：通用 ACP 后端（`acp.ts`）的一份 OpenCode 配置 + 模型注册。方案 docs/design/acp-cli-models.md。
 * 启动方式（参数 / 白名单环境 / 配置文件）在 `cli-agents/opencode-launch.ts`，模型列表来自 `opencode models --verbose`（`cli-agents/opencode-models.ts`）。
 * Pi 里的模型 id = OpenCode 的 `<provider>/<model>`（如 `opencode-go/deepseek-v4.1-flash`），名字带来源：Zen 免费 / Zen 按量 / Go 套餐 / 用户自己登录的 provider。
 */
import { findOpencodeCommand } from "../../cli-agents/detect.ts";
import { opencodeProfile } from "../../cli-agents/opencode-launch.ts";
import { opencodeThinkingMap, type OpencodeModel } from "../../cli-agents/opencode-models.ts";
import type { PiModels } from "../index.ts";
import { createAcpChannel, type AcpChannelConfig, type AcpDeps } from "./acp.ts";
import { registerCliProvider } from "./provider.ts";

/** 不能叫 `opencode`：Pi 自带一个同名渠道（OpenCode Zen 的 API 密钥渠道），重名会把它顶掉，模型服务页也会把它一起藏起来 */
export const OPENCODE_PROVIDER = "opencode-cli";
/** Pi 的 `api` 字段：自定义流式实现的名字 */
export const OPENCODE_API = "opencode-acp";

export const opencodeChannelConfig: AcpChannelConfig = {
	profile: opencodeProfile,
	name: "opencode",
	findCommand: () => findOpencodeCommand(),
	notFound: "没有找到 opencode 命令。请先按 OpenCode 官方说明安装（opencode.ai），免费模型不用登录；想用 Go 套餐或自己的模型服务，在终端运行 opencode auth login。",
	errorStyle: { label: "OpenCode", loginCommand: "opencode auth login", notLoggedIn: /not logged in|log ?in|unauthorized|authenticat|credentials|api key|401/i },
	resumeFailed: /session[^\n]*(not found|does not exist|unknown|invalid)|(not found|no such|unknown)[^\n]*session/i,
};

export type OpencodeDeps = AcpDeps;
export const createOpencodeChannel = (deps: OpencodeDeps) => createAcpChannel(opencodeChannelConfig, deps);
export type OpencodeChannel = ReturnType<typeof createOpencodeChannel>;

/** 用 `opencode models --verbose` 的结果（重新）注册 `opencode` 渠道；重新检测时再调一次就刷新列表。 */
export async function registerOpencodeModels(models: PiModels, channel: OpencodeChannel, list: OpencodeModel[]): Promise<void> {
	if (!list.length) throw new Error("OpenCode 没有返回任何可用的模型");
	await registerCliProvider(models, {
		id: OPENCODE_PROVIDER,
		name: "OpenCode（本机）",
		api: OPENCODE_API,
		baseUrl: "opencode://local",
		streamSimple: channel.streamSimple as never,
		models: list.map((m) => {
			const map = opencodeThinkingMap(m.efforts);
			return { id: m.id, name: m.name, reasoning: !!map && Object.values(map).some(Boolean), thinkingLevelMap: map, image: m.image, contextWindow: m.contextWindow, maxTokens: m.maxTokens };
		}),
	});
}

/** 创建渠道并注册模型（模型列表由调用方先问 `opencode models --verbose` 得到）。 */
export async function registerOpencodeProvider(models: PiModels, deps: OpencodeDeps & { models: OpencodeModel[] }): Promise<OpencodeChannel> {
	const channel = createOpencodeChannel(deps);
	try {
		await registerOpencodeModels(models, channel, deps.models);
	} catch (e) {
		channel.disposeAll();
		throw e;
	}
	return channel;
}
