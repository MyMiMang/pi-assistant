/**
 * 本地 ASR **模型目录（catalog）**：把「一个模型」从单例 SenseVoice 扩成「按 modelId 选择的多模型」。
 *
 * 设计边界（用户要求）：
 *  - **数据驱动**：每个模型的权重 pin / 许可判定 / 来源 / 推荐档位都是数据；新增模型只改本文件。
 *  - **绝不编造 model hash / 版本**，也绝不为没有真实官方来源 / 未 pin 的模型放「空可下载按钮」。
 *  - **许可准确优先**：正式提供的模型必须许可清晰（MIT / Apache-2.0）；SenseVoice 整体许可 `unresolved`
 *    （商用 / 再分发未最终确认），但**本地按需下载安装（用户个人自用）放行**——`license.selfServe = true`，
 *    与 `decision` / `redistribution` 分开，不像以前那样一刀切关闭安装入口；不 bundle / 不镜像。
 *  - **性能是估算**：`recommend.ramMB` 是**模型进程内存估算**（非实测），`basis` 必须写明；
 *    整机内存建议见 `classifyAsrHardware()`（按系统总 RAM 8 / 16 / 32 保守分档，同样是估算）。
 *  - **老配置可读**：SenseVoice 保留原 provider（`local-sensevoice`）/ modelId / 权重 pin。
 *
 * 事实来源：`local-asr-model-catalog-2026-10-16.json`（HF LFS oid + 实测 tokens SHA256 + sherpa 1.13.8
 * sdist 工厂签名）。Qwen3-ASR 0.6B 真实有 sherpa 支持，但公开 tar 缺 SHA256 pin → **本批不上目录**。
 */
import { ONLINE_ZIPFORMER_LICENSE, ONLINE_ZIPFORMER_MODEL, ONLINE_ZIPFORMER_SOURCE, SENSEVOICE_LICENSE, SENSEVOICE_MODEL, SENSEVOICE_SOURCE, type AsrAdapterCapability, type AsrLicenseMeta, type AsrModelManifest, type AsrSourceMeta } from "./manifest.ts";

/** 性能档位（界面文案：轻量 / 均衡 / 高质量）。 */
export type AsrTier = "light" | "balanced" | "high";

export const ASR_TIER_LABELS: Record<AsrTier, string> = {
	light: "轻量",
	balanced: "均衡",
	high: "高质量",
};

/** 运行依赖体积 / 说明（与权重分开；未知为 null，不编造）。 */
export interface AsrRuntimeDeps {
	/** 共享引擎（sherpa-onnx + venv/cache）估算体积；未知为 null */
	bytes: number | null;
	/** 中文说明（必须标「估算，未实测」） */
	note: string;
}

/** 推荐结果。`estimated` 恒为 true（本机未实测），`basis` 必须写清估算依据。 */
export interface AsrRecommendation {
	tier: AsrTier;
	/** 模型进程建议内存（MB）；估算，不是整机门槛 */
	ramMB: number;
	cpuCores: number;
	/** 恒 true：不是本机实测值 */
	estimated: true;
	/** 估算依据（中文，必须写明「非实测」） */
	basis: string;
}

/** 单个可安装的本地 ASR 模型。 */
export interface AsrModelSpec {
	/** 稳定 modelId（`voiceSource.model` 用它；也是 per-model 权重目录名） */
	id: string;
	/** 注册表 provider id（`voiceSource.provider` 用它） */
	provider: string;
	/** 运行族：决定 serve 脚本与权重校验（见 runner.ts） */
	family: string;
	/** 运行族中文名（界面显示） */
	familyLabel: string;
	/** 界面友好名（中文） */
	name: string;
	/** 英文原名（署名 / 对得上权重页） */
	nameEn: string;
	/** 变体说明（如「int8」「small」） */
	variant: string;
	/** 性能档位（轻量 / 均衡 / 高质量） */
	tier: AsrTier;
	/** 中文一句话说明（多语 / 中文能力） */
	note: string;
	/** 一句大白话：适合什么场景（安装前的模型选择器里每项显示一行） */
	suits: string;
	/** 能力标签（标点 / 时间戳 / 中英混说…），语种以 manifest.languages 为准 */
	capabilities: string[];
	/** 多语种（界面用来区分「中文 / 多语」） */
	multilingual: boolean;
	/** 是否原生流式（默认本地语音的判据之一；与 manifest.streaming 一致） */
	streaming?: boolean;
	/** 是否是「默认本地语音」候选（全目录最多一个为 true；默认是哪个模型只由数据决定） */
	defaultVoice?: boolean;
	/** 原生流式适配器能力（`streaming=true` 时给前端用） */
	adapter?: AsrAdapterCapability;
	manifest: AsrModelManifest;
	license: AsrLicenseMeta;
	source: AsrSourceMeta;
	/** 支持的平台 key；空数组 = 按平台 profile 判定 */
	platforms: string[];
	runtimeDeps: AsrRuntimeDeps;
	recommend: AsrRecommendation;
}

const SHERPA_PLATFORMS = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"];

/** 共享运行环境体积（sherpa-onnx wheels + uv venv/cache）估算；未在本机实测。 */
const RUNTIME_DEPS: AsrRuntimeDeps = {
	bytes: null,
	note: "另需下载共享运行环境（sherpa-onnx 引擎 + venv/cache，估算约 0.2GB）；未在本机实测",
};

function rec(tier: AsrTier, ramMB: number, note: string, cpuCores = 4): AsrRecommendation {
	return { tier, ramMB, cpuCores, estimated: true, basis: `${note}；为模型进程内存估算，非本机实测` };
}

// ------------------------------------------------------------------ 新模型（许可明确）

const PARAFAFORMER_LICENSE: AsrLicenseMeta = {
	decision: "cleared",
	selfServe: true,
	termsVersion: "Apache-2.0",
	licenseName: "Apache License 2.0",
	redistribution: true,
	attribution: "Paraformer by FunASR / ModelScope (Apache-2.0)",
	// Apache-2.0：正常展示署名与许可证链接即可，不强制每次都勾同意（一键装）
	requiresExplicitAgreement: false,
	links: {
		modelCard: "https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14",
		modelLicense: "https://huggingface.co/funasr/paraformer-zh",
		engineLicense: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE",
	},
	restrictions: ["署名并保留版权与许可声明（Apache-2.0 §4）", "转换制品可再分发；不得用作者名义背书"],
	reason: "上游 FunASR Paraformer 权重为 Apache-2.0，转换仓同为 Apache-2.0",
};

const WHISPER_LICENSE: AsrLicenseMeta = {
	decision: "cleared",
	selfServe: true,
	termsVersion: "MIT",
	licenseName: "MIT License (OpenAI Whisper)",
	redistribution: true,
	attribution: "Whisper by OpenAI (MIT)",
	// MIT：正常展示署名与许可证链接即可，不强制每次都勾同意（一键装）
	requiresExplicitAgreement: false,
	links: {
		modelCard: "https://github.com/openai/whisper",
		modelLicense: "https://github.com/openai/whisper/blob/main/LICENSE",
		engineLicense: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE",
	},
	restrictions: ["署名并保留版权与许可声明（MIT）", "转换制品可再分发；不得用作者名义背书"],
	reason: "上游 OpenAI Whisper 官方权重为 MIT，转换仓可再分发",
};

function whisperSpec(m: {
	id: string;
	repo: string;
	revision: string;
	encoder: { path: string; size: number; sha256: string };
	decoder: { path: string; size: number; sha256: string };
	tokens: { path: string; size: number; sha256: string };
	name: string;
	nameEn: string;
	variant: string;
	tier: AsrTier;
	note: string;
	suits: string;
	ramMB: number;
	capabilities?: string[];
}): AsrModelSpec {
	const files = [m.encoder, m.decoder, m.tokens];
	const bytes = files.reduce((n, f) => n + f.size, 0);
	const manifest: AsrModelManifest = {
		id: m.id,
		repo: m.repo,
		revision: m.revision,
		files,
		bytes,
		sampleRate: 16_000,
		channels: 1,
		// Whisper 输出为模型原生文本（含标点 / 大小写）；研究 JSON 的 punctuation 字段不可靠，这里按真实原生输出保留。
		punctuation: true,
		languages: ["zh", "en", "yue", "ja", "ko", "多语"],
		runner: "whisper",
		fileRoles: { encoder: m.encoder.path, decoder: m.decoder.path, tokens: m.tokens.path },
	};
	return {
		id: m.id,
		provider: "local-whisper",
		family: "whisper",
		familyLabel: "Whisper（sherpa-onnx 转换）",
		name: m.name,
		nameEn: m.nameEn,
		variant: m.variant,
		tier: m.tier,
		note: m.note,
		suits: m.suits,
		capabilities: m.capabilities ?? ["多语", "原生输出（含标点 / 大小写）"],
		multilingual: true,
		manifest,
		license: WHISPER_LICENSE,
		source: {
			project: `${m.nameEn} · sherpa-onnx 转换`,
			repoUrl: "https://github.com/openai/whisper",
			weightsRepo: m.repo,
			weightsRevision: m.revision,
			engineLicense: "Apache-2.0",
			repoCodeLicense: "MIT",
			weightsLicense: "MIT (OpenAI Whisper)",
			engineVersion: "1.13.8",
			note: "权重由 OpenAI Whisper 官方权重转换；许可 MIT",
		},
		platforms: SHERPA_PLATFORMS,
		runtimeDeps: RUNTIME_DEPS,
		recommend: rec(m.tier, m.ramMB, "按模型体积与官方定位保守估算"),
	};
}

const PARAFAFORMER_SPEC: AsrModelSpec = (() => {
	const files = [
		{ path: "model.int8.onnx", size: 243_371_218, sha256: "f36a0433bcf096bd6d6f11b80a3ac8bed110bdca632fe0d731df8d1a84475945" },
		{ path: "tokens.txt", size: 75_756, sha256: "59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6" },
	];
	const manifest: AsrModelManifest = {
		id: "paraformer-zh-2023-09-14-int8",
		repo: "csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14",
		revision: "def027084691107096b5ebba69785756d63de6c5",
		files,
		bytes: files.reduce((n, f) => n + f.size, 0), // 243_446_974
		sampleRate: 16_000,
		channels: 1,
		punctuation: false,
		languages: ["zh", "en"],
		runner: "paraformer",
		fileRoles: { model: "model.int8.onnx", tokens: "tokens.txt" },
	};
	return {
		id: manifest.id,
		provider: "local-paraformer",
		family: "paraformer",
		familyLabel: "Paraformer（FunASR 转换）",
		name: "Paraformer 中文（本地）",
		nameEn: "Paraformer zh (sherpa-onnx)",
		variant: "int8 · 2023-09-14",
		tier: "light",
		note: "中文主力，支持中英混说；输出无标点（另配标点模型才有）",
		suits: "中文为主、整段说完再出字，比流式更准",
		capabilities: ["中文", "中英混说", "无标点"],
		multilingual: false,
		manifest,
		license: PARAFAFORMER_LICENSE,
		source: {
			project: "Paraformer zh · sherpa-onnx 转换",
			repoUrl: "https://github.com/modelscope/FunASR",
			weightsRepo: manifest.repo,
			weightsRevision: manifest.revision,
			engineLicense: "Apache-2.0",
			repoCodeLicense: "MIT",
			weightsLicense: "Apache-2.0",
			engineVersion: "1.13.8",
			note: "权重由 FunASR Paraformer 官方权重转换；许可 Apache-2.0",
		},
		platforms: SHERPA_PLATFORMS,
		runtimeDeps: RUNTIME_DEPS,
		recommend: rec("light", 900, "按 int8 模型体积与运行时基线保守估算", 4),
	};
})();

/** 目录里的模型清单（**只有经过研究确认来源 / pin / 许可的模型才能进来**）。 */
export const ASR_CATALOG: AsrModelSpec[] = [
	{
		id: ONLINE_ZIPFORMER_MODEL.id,
		provider: "local-online-zipformer",
		family: "online-zipformer",
		familyLabel: "Streaming Zipformer（sherpa-onnx 原生流式）",
		name: "本地流式听写（中英双语）",
		nameEn: "Streaming zipformer bilingual zh-en (sherpa-onnx)",
		variant: "int8 · 2023-02-20",
		tier: "light",
		note: "原生流式（边说边出字），中英双语；输出无标点",
		suits: "日常听写，边说边出字，中英混说都行",
		capabilities: ["中文", "英文", "原生流式", "无标点"],
		multilingual: true,
		streaming: true,
		defaultVoice: true,
		adapter: ONLINE_ZIPFORMER_MODEL.adapter,
		manifest: ONLINE_ZIPFORMER_MODEL,
		license: ONLINE_ZIPFORMER_LICENSE,
		source: ONLINE_ZIPFORMER_SOURCE,
		platforms: SHERPA_PLATFORMS,
		runtimeDeps: RUNTIME_DEPS,
		recommend: rec("light", 900, "按 int8 流式 zipformer 体积与运行时基线保守估算"),
	},
	PARAFAFORMER_SPEC,
	whisperSpec({
		id: "whisper-base-int8",
		repo: "csukuangfj/sherpa-onnx-whisper-base",
		revision: "bb53ee204431c90d314c1cc08d28d23e5b7927cc",
		encoder: { path: "base-encoder.int8.onnx", size: 29_120_534, sha256: "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11" },
		decoder: { path: "base-decoder.int8.onnx", size: 130_672_026, sha256: "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d" },
		tokens: { path: "base-tokens.txt", size: 816_730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126" },
		name: "Whisper Base（本地）",
		nameEn: "Whisper base (sherpa-onnx)",
		variant: "int8",
		tier: "light",
		note: "多语；中文准确率低于同体积 Paraformer，适合短指令 / 英文主导",
		suits: "英文为主的短指令，体积小",
		ramMB: 900,
	}),
	whisperSpec({
		id: "whisper-small-int8",
		repo: "csukuangfj/sherpa-onnx-whisper-small",
		revision: "8f3c18b358db4d1f2fc1eae49d75cd20989e4309",
		encoder: { path: "small-encoder.int8.onnx", size: 112_442_483, sha256: "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9" },
		decoder: { path: "small-decoder.int8.onnx", size: 262_226_114, sha256: "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee" },
		tokens: { path: "small-tokens.txt", size: 816_730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126" },
		name: "Whisper Small（本地）",
		nameEn: "Whisper small (sherpa-onnx)",
		variant: "int8",
		tier: "balanced",
		note: "多语均衡档（多语默认推荐）；输出为模型原生文本（含标点），不做云端纠错",
		suits: "多种语言、带标点，速度和准确度均衡",
		ramMB: 1500,
		capabilities: ["多语", "原生输出（含标点 / 大小写）"],
	}),
	whisperSpec({
		id: "whisper-turbo-int8",
		repo: "csukuangfj/sherpa-onnx-whisper-turbo",
		revision: "2ca6ff69fc878651b770880507669577ac41c2ff",
		encoder: { path: "turbo-encoder.int8.onnx", size: 674_716_297, sha256: "b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b" },
		decoder: { path: "turbo-decoder.int8.onnx", size: 361_080_764, sha256: "20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547" },
		tokens: { path: "turbo-tokens.txt", size: 816_730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126" },
		name: "Whisper Turbo（本地）",
		nameEn: "Whisper large-v3-turbo (sherpa-onnx)",
		variant: "int8",
		tier: "high",
		note: "高质量档里的速度优先版（4 层解码器蒸馏，精度对 large-v3 有取舍）",
		suits: "多种语言、要高质量又不想太慢，内存要够",
		ramMB: 2000,
	}),
	whisperSpec({
		id: "whisper-large-v3-int8",
		repo: "csukuangfj/sherpa-onnx-whisper-large-v3",
		revision: "2a6507094dd6020d939d78e3f1834a1d06267fca",
		encoder: { path: "large-v3-encoder.int8.onnx", size: 766_671_985, sha256: "d531cf17248acc43e8c09b472a0877055e770877857a5332fc1304b36534ec85" },
		decoder: { path: "large-v3-decoder.int8.onnx", size: 1_008_265_203, sha256: "ebc6bfd88e162a46cb3edee8a7e727e1dcbc65cabecb19e2573695e4d495e1af" },
		tokens: { path: "large-v3-tokens.txt", size: 816_730, sha256: "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126" },
		name: "Whisper Large v3（本地）",
		nameEn: "Whisper large-v3 (sherpa-onnx)",
		variant: "int8",
		tier: "high",
		note: "最高精度档；1.77GB 磁盘，16GB 机器可用但不宽裕",
		suits: "最准的多语言识别，下载大、吃内存",
		ramMB: 2800,
	}),
	{
		id: SENSEVOICE_MODEL.id,
		provider: "local-sensevoice",
		family: "sensevoice",
		familyLabel: "SenseVoice（FunASR 转换）",
		name: "SenseVoice Small（本地）",
		nameEn: "SenseVoiceSmall (sherpa-onnx)",
		variant: "int8 ONNX",
		tier: "balanced",
		note: "中英粤日韩；本地个人自用可从官方源一键下载安装，不随 App 分发",
		suits: "中英粤日韩、带标点，个人自用",
		capabilities: ["标点", "中英粤日韩"],
		multilingual: true,
		manifest: SENSEVOICE_MODEL,
		license: SENSEVOICE_LICENSE,
		source: SENSEVOICE_SOURCE,
		platforms: SHERPA_PLATFORMS,
		runtimeDeps: RUNTIME_DEPS,
		recommend: rec("balanced", 1100, "按 int8 模型体积与运行时基线保守估算"),
	},
];

import { defaultVoiceView, resolveDefaultVoiceId, type DefaultVoiceCandidate, type DefaultVoiceView } from "./default-voice.ts";

/** 默认本地语音的候选视图（给 UI / 路由用；数据驱动）。 */
export function defaultVoiceCandidates(): DefaultVoiceCandidate[] {
	return ASR_CATALOG.map((m) => ({ id: m.id, streaming: m.streaming ?? m.manifest.streaming ?? false, defaultVoice: m.defaultVoice === true, selfServe: m.license.selfServe }));
}

/** 从目录解析默认本地语音（fail closed，不猜）。 */
export function resolveCatalogDefaultVoice() {
	return resolveDefaultVoiceId(defaultVoiceCandidates());
}

/** 给界面的「谁在用」视图（不含「能不能用」——那是 install 状态的事）。 */
export function catalogDefaultVoiceView(current: { location: "cloud" | "local"; provider: string; model: string } | null): DefaultVoiceView {
	return defaultVoiceView({ current, resolved: resolveCatalogDefaultVoice() });
}

/** 按 modelId 取目录项；未知返回 null（调用方 fail-closed）。 */
export function asrModelSpec(id: string | null | undefined): AsrModelSpec | null {
	if (!id) return null;
	return ASR_CATALOG.find((m) => m.id === id) ?? null;
}

/** 按 provider（+可选 model）取目录项。老配置（如 provider=local-sensevoice）用它兼容。 */
export function asrModelSpecByProvider(provider: string, model?: string | null): AsrModelSpec | null {
	return ASR_CATALOG.find((m) => m.provider === provider && (!model || m.id === model)) ?? null;
}

/** 目录里的 modelId 集合（来源选择 / 租约解析用，避免各处硬编码）。 */
export function asrModelIds(): string[] {
	return ASR_CATALOG.map((m) => m.id);
}

/**
 * 整机硬件档位（**保守估算**，按系统总 RAM 8 / 16 / 32 分档；不是跑分、不跑 benchmark）。
 * 只读 Node `os` 的合法 metadata（由调用方传入，便于单测）。
 */
export function classifyAsrHardware(memoryBytes: number, cpuCores: number): { tier: AsrTier | "unknown"; note: string } {
	if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) return { tier: "unknown", note: "拿不到内存信息，按最保守估计（估算，未实测）" };
	const gb = memoryBytes / (1024 ** 3);
	if (gb < 12) return { tier: "light", note: `系统内存约 ${gb.toFixed(1)}GB，按 8GB 档保守估计（估算，未实测；未跑 benchmark）` };
	if (gb < 24) return { tier: "balanced", note: `系统内存约 ${gb.toFixed(1)}GB，按 16GB 档保守估计（估算，未实测；未跑 benchmark）` };
	return { tier: "high", note: `系统内存约 ${gb.toFixed(1)}GB，按 32GB 档估计（估算，未实测；未跑 benchmark；应用与 VM 另有占用）` };
}

/** 按硬件档位给推荐 modelId（null = 不给推荐）。 */
export function recommendAsrModelId(tier: AsrTier | "unknown"): string | null {
	if (tier === "light") return "paraformer-zh-2023-09-14-int8";
	if (tier === "balanced") return "whisper-small-int8";
	if (tier === "high") return "whisper-large-v3-int8";
	return "paraformer-zh-2023-09-14-int8";
}
