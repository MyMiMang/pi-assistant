/** 原生 ACP 工具共用的薄注册入口。命令路径与实际模型目录由宿主提供，不查用户 PATH。 */
import type { AcpProfile } from "../../cli-agents/acp-process.ts";
import { geminiProfile } from "../../cli-agents/profiles/gemini.ts";
import { codebuddyProfile } from "../../cli-agents/profiles/codebuddy.ts";
import type { PiModels } from "../index.ts";
import { createAcpChannel, type AcpChannelConfig, type AcpDeps } from "./acp.ts";
import { registerCliProvider, type CliModelSpec } from "./provider.ts";

export interface NativeAcpSpec {
	/** 例如 gemini-cli；与旧的四个渠道分开注册。 */
	provider: string;
	name: string;
	profile: AcpProfile;
	/** 安装版本及指令 / 隔离策略的指纹。 */
	sessionPolicy: string;
}

export type NativeAcpDeps = AcpDeps & { command: () => string | null; commandArgs?: () => string[]; nativeModels?: () => CliModelSpec[] };
export type NativeAcpChannel = ReturnType<typeof createAcpChannel>;
export type NativeProviderId = "gemini-cli" | "codebuddy-cli";

const specs: Record<NativeProviderId, NativeAcpSpec> = {
	"gemini-cli": { provider: "gemini-cli", name: "Gemini CLI", profile: geminiProfile, sessionPolicy: "native-first-input-v1:gemini-private-home-v1" },
	"codebuddy-cli": { provider: "codebuddy-cli", name: "CodeBuddy", profile: codebuddyProfile, sessionPolicy: "native-first-input-v1:codebuddy-private-home-v1" },
};

/** default 表示让工具自行选择模型，并非虚构该工具支持的模型目录。能力待实际协商后再开放。 */
const defaultModel = (spec: NativeAcpSpec): CliModelSpec => ({
	id: "default", name: `${spec.name}（工具默认模型）`, reasoning: false, image: false,
	// Pi 需要数值预算；这是本地适配预算，不代表工具实测上下文能力。
	contextWindow: 32_000, maxTokens: 8_000,
});

export const registerNativeModels = (models: PiModels, channel: NativeAcpChannel, id: NativeProviderId, list: CliModelSpec[] = []): Promise<void> => registerNativeAcpModels(models, channel, specs[id], list.length ? list : [defaultModel(specs[id])]);

/** 宿主仅提供 PIA_*_COMMAND 指定的命令；不安装、不检测、不启动工具。 */
export const registerNativeProvider = (models: PiModels, id: NativeProviderId, deps: NativeAcpDeps): Promise<NativeAcpChannel> => registerNativeAcpProvider(models, specs[id], { ...deps, models: deps.nativeModels?.().length ? deps.nativeModels() : [defaultModel(specs[id])] });

export function createNativeAcpChannel(spec: NativeAcpSpec, deps: NativeAcpDeps): NativeAcpChannel {
	const cfg: AcpChannelConfig = {
		mode: "native",
		profile: deps.commandArgs ? { ...spec.profile, args: (dir) => [...deps.commandArgs!(), ...spec.profile.args(dir)] } : spec.profile,
		name: spec.provider,
		sessionPolicy: spec.sessionPolicy,
		findCommand: () => null,
		notFound: `${spec.name} 的 Pi 专用命令不存在，请检查该工具的安装状态`,
		errorStyle: { label: spec.name, loginCommand: "", notLoggedIn: /$^/ },
		resumeFailed: /$^/,
	};
	return createAcpChannel(cfg, deps);
}

/** 仅注册工具实际报告的模型与能力；不会根据产品名虚构模型或思考档位。 */
export async function registerNativeAcpModels(models: PiModels, channel: NativeAcpChannel, spec: NativeAcpSpec, list: CliModelSpec[]): Promise<void> {
	if (!list.length) throw new Error(`${spec.name} 没有返回可用模型`);
	await registerCliProvider(models, {
		id: spec.provider,
		name: `${spec.name}（原生）`,
		api: `${spec.provider}-acp-native`,
		baseUrl: `${spec.provider}://local`,
		streamSimple: channel.streamSimple as never,
		models: list,
	});
}

export async function registerNativeAcpProvider(models: PiModels, spec: NativeAcpSpec, deps: NativeAcpDeps & { models: CliModelSpec[] }): Promise<NativeAcpChannel> {
	const channel = createNativeAcpChannel(spec, deps);
	try {
		await registerNativeAcpModels(models, channel, spec, deps.models);
		return channel;
	} catch (error) {
		channel.disposeAll();
		throw error;
	}
}
