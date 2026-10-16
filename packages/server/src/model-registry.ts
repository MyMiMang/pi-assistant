/**
 * 统一模型服务注册表（只读视图 / 元数据契约）。
 *
 * 目标：给界面和内部调用方一份**统一的“服务 + 模型 + 能力”元数据**，
 * 让同一个服务（一个 baseUrl + 一份凭据）可以同时提供 chat / 识图 / 生图 / 分类器多种模型，
 * 而不再由“自定义服务”“生图服务”“识图设置”“快速操作模型”各存一套。
 *
 * 设计约束（与 Pi SDK 对齐，不重复造轮子）：
 *  - **事实来源是 Pi 公开的多类型运行时**（`ModelRuntime` 的 chat / image / classifier 目录）。
 *    本模块只做“汇总 + 标注能力”，不自己存凭据、不做鉴权解析——鉴权一律由 Pi 在请求时按 provider 解析。
 *  - 自定义服务的持久化元数据（`pi-adapter/custom-providers.ts` 的 models.json + settings）
 *    和生图服务（`image-gen/`）作为补充来源合并进来，供迁移期过渡。
 *  - 能力判定只按**可靠来源**（Pi 目录 / 用户显式配置 / 服务端 /models 返回的元数据）；
 *    靠 models.dev / 模型名猜出来的能力标到 `inferred`，`confirmed=false`，界面要显示“未确认”，绝不假装事实。
 *
 * 纯函数 + 依赖注入：`buildRegistry(input)` 不读数据库 / 不碰凭据，测试用假数据即可（见 test/model-registry.test.ts）。
 */

import type { ClassifierModelInfo, ModelInfo } from "./pi-adapter/index.ts";
import type { CustomProviderMeta } from "./pi-adapter/custom-providers.ts";

/** 一个模型能做的事；`vision` 属于 chat 能力（不是独立服务）。`asr` = 语音转文字（语音输入），与 chat / vision 互不蕴含。 */
export type ModelCapability = "chat" | "vision" | "image" | "classifier" | "asr";
/** Pi 的操作类型（`type` 缺省即 chat）。`asr` 是 Pi Assistant 自有的第四种类型（Pi SDK 暂无 audio）：
 *  云走 OpenAI 兼容 `/v1/audio/transcriptions`，本地走 loopback sidecar，都不伪造成 chat / classifier。 */
export type ModelType = "chat" | "image" | "classifier" | "asr";
/** 模型 / 服务的来源：`local` = 本机跑的服务（如 local-laya，安装后经 Pi 运行时注册）。 */
export type RegistrySource = "pi-catalog" | "custom" | "imagegen" | "guess" | "local";

/** 本地服务的**安全**运行状态（来自其 status，绝不含 token / 凭据）。 */
export interface RegistryLocalStatus {
	/** 已安装（不代表能用） */
	installed: boolean;
	/** 运行中（auth 可用、已注册进 Pi 目录） */
	running: boolean;
	/** 原始运行状态：stopped / starting / running / stopping / crashed */
	state: string;
	/** 实测计算设备（来自 health），未运行 / 未知为 null */
	device: string | null;
}

export interface RegistryModel {
	provider: string;
	id: string;
	name: string;
	type: ModelType;
	/** 该模型具备的能力（至少一项）。 */
	capabilities: ModelCapability[];
	/** 协议 / api id：chat 如 openai-completions；classifier 如 typesafe-system-one；image 为生图服务 kind。 */
	protocol: string;
	/** 全部能力都有可靠来源时为 true；只要有一项是猜出来的就是 false。 */
	confirmed: boolean;
	/** 靠 models.dev / 模型名等猜出来的能力，界面标“未确认”。 */
	inferred: ModelCapability[];
	/** 分类器条目是自动识别的（对端元数据 / Pi 官方目录同 id），不是用户显式声明。 */
	discovered?: boolean;
	source: RegistrySource;
	/** 该 provider 是否已配置可用认证（只读状态，不暴露凭据）。本地服务仅在运行中为 true。 */
	configured: boolean;
	/** 本地服务（如 local-laya）：安装 / 运行状态分开，stop 后仍保留卡片（只标暂不可用）。 */
	local?: RegistryLocalStatus;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: string[];
	/** 生图模型：是否支持改图 / 参考图。 */
	edit?: boolean;
	/** 生图模型的参考价格说明（未知则不写，绝不填 0）。 */
	costNote?: string;
	/** 生图模型的适配器元数据（UI 展示用）：协议 kind / 端点 / 改图 / 参考价。 */
	imageAdapter?: { kind: string; baseUrl: string; edit: boolean; costNote?: string };
	/** 语音转文字（ASR）模型的适配器元数据；**不含凭据**（本地不需要用户 key）。 */
	asrAdapter?: RegistryAsrAdapter;
}

/**
 * 语音转文字（ASR）的适配器元数据（云 + 本地**同一形状**，避免两套 RegistryAsr 类型）：
 *  - 云：`protocol="openai-audio-transcriptions"`、`location="cloud"`、`requiresApiKey=true`、带展示用 `baseUrl`；
 *  - 本地：`protocol="local-asr-http"`、`location="local"`、`requiresApiKey=false`、带采样率 / 上限 / 语种 / 标点。
 * 进程内 token 绝不进注册表（本地端点只在 `local-asr/adapter-registry.ts`）。
 */
export interface RegistryAsrAdapter {
	protocol: string;
	/** 音频是否会离开本机。 */
	location: "cloud" | "local";
	/** 是否需要用户 API key（本地 provider 为 false）。 */
	requiresApiKey: boolean;
	sampleRate?: number;
	/** 单次音频上限（秒） */
	maxSeconds?: number;
	languages?: string[];
	/** 模型输出是否自带标点 / ITN */
	punctuation?: boolean;
	/** 展示用地址（绝不含 token）。 */
	baseUrl?: string;
}

export interface RegistryProvider {
	id: string;
	name: string;
	kind: "builtin" | "custom" | "imagegen" | "local";
	configured: boolean;
	baseUrl?: string;
	/** 该服务出现过的协议集合。 */
	protocols: string[];
	models: RegistryModel[];
}

export interface RegistryProviderHint {
	id: string;
	name: string;
	configured: boolean;
	source?: string;
}

export interface RegistryImageProvider {
	id: string;
	name: string;
	kind: string;
	baseUrl: string;
	models: string[];
	configured: boolean;
	/** 复用别的服务（自定义 / 内置）的同一份凭据时，这里指向那个 provider id；共享一份 key → 合并成一张服务卡。 */
	credentialProvider?: string;
}

/** 本地服务的安全元数据（由服务自己的 status 事件汇总；不 import 其实现、不含凭据）。 */
export interface RegistryLocalProvider {
	provider: string;
	/** 界面显示名（如「本地 SenseVoice」） */
	label?: string;
	modelId: string;
	protocol: string;
	/** 该本地服务提供的能力类型：classifier（如 local-laya）或 asr（如本地 SenseVoice）。缺省 classifier。 */
	type?: "classifier" | "asr";
	installed: boolean;
	running: boolean;
	state: string;
	device: string | null;
	/** asr 专用元数据（采样率 / 语种 / 标点） */
	asr?: { sampleRate: number; maxSeconds: number; languages: string[]; punctuation: boolean };
}

/** 显式声明（或本地 runtime 上报）的语音转文字服务；不靠模型名猜能力。 */
export interface RegistryAsrProvider {
	provider: string;
	modelId: string;
	name?: string;
	/** 协议：`openai-audio-transcriptions`（云）或 `local-asr-http`（本地 loopback）。 */
	protocol: string;
	/** 是否已配置可用（云看凭据，本地看 running）。 */
	configured: boolean;
	/** 音频是否会离开本机：cloud 会外发，local 只在本机。 */
	location: "cloud" | "local";
	language?: string;
	/** 本地服务（如本地 SenseVoice）：安装 / 运行状态。 */
	local?: RegistryLocalStatus;
	/** 参考价格说明；未知不填（绝不填 0）。 */
	costNote?: string;
}

export interface RegistryInput {
	/** Pi 已注册的 provider（用于补名称 / 配置状态，包含没有任何模型的条目）。 */
	providers: RegistryProviderHint[];
	/** Pi 的 chat 模型目录（`listModels()`）。 */
	chatModels: ModelInfo[];
	/** Pi 的 classifier 模型目录（`listClassifierModels()`）。 */
	classifierModels: ClassifierModelInfo[];
	/** 自定义服务持久化元数据（`customProviders.list()`）。 */
	custom: (CustomProviderMeta & { configured: boolean })[];
	/** 生图服务（迁移期临时来源，合并后由统一 registry 取代）。 */
	image: {
		providers: RegistryImageProvider[];
		/** 该生图服务 / 模型是否支持改图；认不出返回 false。 */
		supportsEdit?: (kind: string, model: string) => boolean;
		/** 参考价格说明；未知返回 undefined（不填 0）。 */
		costNote?: (model: string) => string | undefined;
	};
	/** 本地服务（如 local-laya）的安全状态：已安装但停止时仍保留卡片（source=local，标暂不可用）。 */
	local?: RegistryLocalProvider[];
	/** 显式声明的语音转文字服务（云 provider 由用户声明；本地 ASR 由 runtime 上报）。 */
	asr?: RegistryAsrProvider[];
}

/** chat 模型的能力：input 含 image 即识图（识图属于 chat 能力，不是独立服务）。 */
export function chatCapabilities(input: string[] | undefined): ModelCapability[] {
	return input?.includes("image") ? ["chat", "vision"] : ["chat"];
}

const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * 汇总成统一注册表。合并顺序（后者覆盖前者）：内置 Pi 目录 → 自定义服务 → 生图服务。
 * 同一个 `provider + id + type` 只保留一条（后写入的覆盖），`provider + id` 的不同 type 分别保留。
 */
export function buildRegistry(input: RegistryInput): RegistryProvider[] {
	const providers = new Map<string, RegistryProvider>();
	const ensure = (id: string, init: Omit<RegistryProvider, "models" | "protocols">): RegistryProvider => {
		const cur = providers.get(id);
		if (cur) return cur;
		const p: RegistryProvider = { ...init, protocols: [], models: [] };
		providers.set(id, p);
		return p;
	};
	const put = (p: RegistryProvider, m: RegistryModel) => {
		const i = p.models.findIndex((x) => x.id === m.id && x.type === m.type);
		if (i >= 0) p.models[i] = m;
		else p.models.push(m);
		const protos = dedupe([...p.protocols, m.protocol].filter(Boolean));
		p.protocols = protos;
	};

	const hint = new Map(input.providers.map((p) => [p.id, p]));

	// 1) Pi 内置 / 已注册 provider 的 chat 与 classifier 目录
	for (const m of input.chatModels) {
		const h = hint.get(m.provider);
		const p = ensure(m.provider, { id: m.provider, name: h?.name ?? m.provider, kind: "builtin", configured: !!h?.configured, baseUrl: undefined });
		p.configured = p.configured || !!h?.configured;
		const capabilities = chatCapabilities(m.input);
		put(p, {
			provider: m.provider,
			id: m.id,
			name: m.name || m.id,
			type: "chat",
			capabilities,
			protocol: m.api ?? "",
			confirmed: true,
			inferred: [],
			source: "pi-catalog",
			configured: !!h?.configured,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			reasoning: m.reasoning,
			thinkingLevelMap: m.thinkingLevelMap,
			input: m.input,
		});
	}
	for (const m of input.classifierModels) {
		const h = hint.get(m.provider);
		const p = ensure(m.provider, { id: m.provider, name: h?.name ?? m.provider, kind: "builtin", configured: !!h?.configured, baseUrl: undefined });
		put(p, {
			provider: m.provider,
			id: m.id,
			name: m.name || m.id,
			type: "classifier",
			capabilities: ["classifier"],
			protocol: m.api,
			confirmed: true,
			inferred: [],
			source: "pi-catalog",
			configured: !!m.configured,
			contextWindow: m.contextWindow,
			input: m.input,
		});
	}

	// 2) 自定义服务（chat 模型 + 声明的 classifier）
	for (const c of input.custom) {
		const p = ensure(c.id, { id: c.id, name: c.name || c.id, kind: "custom", configured: !!c.configured, baseUrl: c.baseUrl });
		// 自定义服务的 chat 模型也会出现在 Pi 的 chat 目录里（builtin 循环先建了这条）——
		// 这里必须把它重新标回 custom，否则界面会把中转站当成官方服务（显示登录而不是编辑渠道）。
		p.kind = "custom";
		p.configured = p.configured || !!c.configured;
		p.baseUrl ??= c.baseUrl;
		// 真正注册进 Pi 的 classifier（显式声明 + 自动识别）；用户只标了能力但没注册的要标「未确认」。
		const registeredClassifiers = new Set([...(c.classifiers ?? []), ...(c.discoveredClassifiers ?? [])].map((x) => x.modelId));
		for (const m of c.models) {
			// 显式声明能力优先；否则按 input 元数据推导。inputAuto 表示是从 models.dev 猜的 → 未确认。
			const inferred: ModelCapability[] = m.inputAuto && m.input?.includes("image") ? ["vision"] : [];
			const capabilities = m.capabilities?.length ? dedupe(m.capabilities) : chatCapabilities(m.input);
			// 标了 classifier 但没真正注册进 Pi（协议无法确定 / 被用户改回 chat）→ 标未确认，不假装可调用。
			if (capabilities.includes("classifier") && !registeredClassifiers.has(m.id)) inferred.push("classifier");
			put(p, {
				provider: c.id,
				id: m.id,
				name: m.name || m.id,
				type: "chat",
				capabilities,
				protocol: c.api,
				confirmed: inferred.length === 0,
				inferred,
				source: "custom",
				configured: !!c.configured,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning,
				thinkingLevelMap: m.thinkingLevelMap,
				input: m.input,
			});
		}
		for (const cl of c.classifiers ?? []) {
			put(p, {
				provider: c.id,
				id: cl.modelId,
				name: cl.name || cl.modelId,
				type: "classifier",
				capabilities: ["classifier"],
				protocol: cl.protocol,
				confirmed: true,
				inferred: [],
				source: "custom",
				configured: !!c.configured,
				contextWindow: cl.contextWindow,
			});
		}
		// 自动识别的 classifier（对端元数据 / Pi 官方同 id）：显式声明先写，自动后写不会覆盖同名条目。
		for (const cl of c.discoveredClassifiers ?? []) {
			put(p, {
				provider: c.id,
				id: cl.modelId,
				name: cl.name || cl.modelId,
				type: "classifier",
				capabilities: ["classifier"],
				protocol: cl.protocol,
				confirmed: true,
				inferred: [],
				discovered: true,
				source: "custom",
				configured: !!c.configured,
				contextWindow: cl.contextWindow,
			});
		}
	}

	// 3) 生图服务（迁移期临时来源）。复用别的服务的同一份凭据（credentialProvider）时并入那个服务，
	//    一张卡同时有 chat / image 能力（一次 key 多 capabilities），不另建一张卡。
	for (const ip of input.image.providers) {
		const shared = ip.credentialProvider && providers.has(ip.credentialProvider) ? providers.get(ip.credentialProvider) : undefined;
		const p = shared ?? ensure(ip.id, { id: ip.id, name: ip.name || ip.id, kind: "imagegen", configured: !!ip.configured, baseUrl: ip.baseUrl });
		p.configured = p.configured || !!ip.configured;
		if (shared) p.baseUrl ??= ip.baseUrl;
		for (const model of ip.models) {
			const edit = input.image.supportsEdit?.(ip.kind, model) ?? false;
			const cost = input.image.costNote?.(model);
			put(p, {
				provider: p.id,
				id: model,
				name: model,
				type: "image",
				capabilities: ["image"],
				protocol: ip.kind,
				confirmed: true,
				inferred: [],
				source: "imagegen",
				configured: !!ip.configured,
				edit,
				costNote: cost,
				imageAdapter: { kind: ip.kind, baseUrl: ip.baseUrl, edit, ...(cost ? { costNote: cost } : {}) },
			});
		}
	}

	// 4) 本地服务（如 local-laya=classifier / local-sensevoice=asr）：可靠地标 source=local；
	//    已安装但停止时仍保留卡片（只标暂不可用）。即使目录里没有（stop 后被摘掉），也按安全状态补一条。
	for (const l of input.local ?? []) {
		const p = ensure(l.provider, { id: l.provider, name: l.label ?? l.provider, kind: "local", configured: l.running });
		p.kind = "local";
		p.configured = p.configured || l.running;
		const status: RegistryLocalStatus = { installed: l.installed, running: l.running, state: l.state, device: l.device };
		const localType = l.type ?? "classifier";
		const existing = p.models.find((x) => x.id === l.modelId && x.type === localType);
		const a = l.asr;
		put(p, {
			provider: l.provider,
			id: l.modelId,
			name: existing?.name || l.modelId,
			type: localType,
			capabilities: [localType],
			protocol: l.protocol,
			confirmed: true,
			inferred: [],
			source: "local",
			configured: l.running,
			local: status,
			...(localType === "asr"
				? { asrAdapter: { protocol: l.protocol, location: "local" as const, requiresApiKey: false, sampleRate: a?.sampleRate ?? 16000, maxSeconds: a?.maxSeconds ?? 120, languages: a?.languages ?? [], punctuation: !!a?.punctuation } }
				: {}),
		});
	}

	// 5) 语音转文字（ASR）：只收录**显式声明**的（云 provider 由用户声明协议 + 模型；本地由 runtime 上报）。
	//    不靠模型名 / chat 能力猜；未确认的不进这里，界面不给入口。
	for (const a of input.asr ?? []) {
		const existing = providers.get(a.provider);
		const p = existing ?? ensure(a.provider, { id: a.provider, name: a.provider, kind: a.location === "local" ? "local" : "custom", configured: a.configured });
		if (a.location === "local") p.kind = "local";
		p.configured = p.configured || a.configured;
		put(p, {
			provider: a.provider,
			id: a.modelId,
			name: a.name || a.modelId,
			type: "asr",
			capabilities: ["asr"],
			protocol: a.protocol,
			confirmed: true,
			inferred: [],
			source: a.location === "local" ? "local" : "custom",
			configured: a.configured,
			...(a.costNote ? { costNote: a.costNote } : {}),
			...(a.local ? { local: a.local } : {}),
			asrAdapter: { protocol: a.protocol, location: a.location, requiresApiKey: a.location === "cloud", ...(existing?.baseUrl ? { baseUrl: existing.baseUrl } : {}), ...(a.language ? { languages: [a.language] } : {}) },
		});
	}

	// provider 内排序：按 type 再按 id，稳定可断言
	for (const p of providers.values()) p.models.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
	return [...providers.values()].sort((a, b) => a.name.localeCompare(b.name, "zh") || a.id.localeCompare(b.id));
}

/** 在注册表里查一个模型（可按 type 精确匹配；不传 type 时 chat 优先）。 */
export function findRegistryModel(list: RegistryProvider[], provider: string, id: string, type?: ModelType): RegistryModel | undefined {
	const p = list.find((x) => x.id === provider);
	if (!p) return undefined;
	const hits = p.models.filter((m) => m.id === id && (!type || m.type === type));
	if (!hits.length) return undefined;
	return type ? hits[0] : (hits.find((m) => m.type === "chat") ?? hits[0]);
}

/** 按能力筛选模型（例如列出所有支持识图的模型）。 */
export function modelsWithCapability(list: RegistryProvider[], cap: ModelCapability): RegistryModel[] {
	return list.flatMap((p) => p.models.filter((m) => m.capabilities.includes(cap)));
}
