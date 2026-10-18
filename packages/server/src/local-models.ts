/**
 * 本地模型服务（如 local-laya / local-sensevoice）的**安全**运行状态缓存。
 *
 * 只订阅既有的安全状态事件（`local-laya.changed` / `local-asr.changed`，payload 是该服务的 status，
 * **不含 token / 凭据**），记住每个本地服务「最后一次注册的 provider / model」与安装、运行状态。这样：
 *  - 服务 stop（从 Pi classifier 目录里被摘掉）后，统一注册表里的服务卡**不会消失**，只标「暂不可用」；
 *  - 安装状态与运行状态分开（installed ≠ running）；
 *  - 重启后同 id 注册回来时能继续（沿用同一条缓存）。
 *
 * 不 import 任何本地服务实现（避免互相改文件），也不读凭据 / token。
 * `baseUrl` 只是**回环地址**（界面展示 / 解析用）；本地 ASR 的运行中端点（含进程内 token）只在
 * `local-asr/adapter-registry.ts`（server 内部），绝不进这里。
 */
import { bus } from "./bus.ts";

export interface LocalModelHint {
	provider: string;
	/** 界面显示名（如「本地 SenseVoice」） */
	label: string;
	modelId: string;
	/** 统一注册表里的模型类型：本地服务目前有 classifier（Laya）与 asr（SenseVoice）。 */
	type: "classifier" | "asr";
	protocol: string;
	/** 本地服务的回环地址（如 http://127.0.0.1:port）；不上报则为空。**绝不含 token。** */
	baseUrl?: string;
	/** 已安装（不代表能用） */
	installed: boolean;
	/** 运行中（auth 可用、已注册） */
	running: boolean;
	/** 原始运行状态：stopped / starting / running / stopping / crashed / paused */
	state: string;
	/** 实测计算设备（来自 health.device），未运行 / 未知为 null */
	device: string | null;
	/** asr 专用元数据（采样率 / 上限 / 语种 / 标点）；classifier 为 undefined */
	asr?: { sampleRate: number; maxSeconds: number; languages: string[]; punctuation: boolean };
	lastSeen: number;
}

/** 本地服务的界面显示名（只认已知 id；未登记的回退成 id）。 */
const LOCAL_PROVIDER_LABELS: Record<string, string> = {
	"local-laya": "本地 Laya",
	"local-sensevoice": "本地 SenseVoice（语音识别）",
};

const cache = new Map<string, LocalModelHint>();

interface LocalStatusLike {
	install?: { state?: string };
	runtime?: { state?: string; port?: number | null };
	health?: { device?: string | null } | null;
	registered?: { provider?: string; modelId?: string; protocol?: string; baseUrl?: string } | null;
	model?: { sampleRate?: number; maxSeconds?: number; languages?: unknown; punctuation?: boolean } | null;
	idle?: { seconds?: number } | null;
}

/**
 * 把一个本地服务状态并入缓存（安全元数据）。停止后 `registered` 为 null，
 * 沿用上一次的 provider / model，保证卡片不消失；只认 provider / model 标识，绝不读 token。
 */
export function rememberLocalModelStatus(status: unknown, providerHint?: string, fallbackModelId?: string, now = Date.now(), type: LocalModelHint["type"] = "classifier", label?: string): void {
	const s = status as LocalStatusLike | null;
	if (!s || typeof s !== "object") return;
	const reg = s.registered ?? undefined;
	// 停止后 registered 为 null：用事件名对应的 provider 沿用上一次的 provider / model，保证卡片不消失。
	const provider = reg?.provider ?? providerHint;
	if (!provider) return;
	// 已安装但从未启动时 registered 为 null 且无历史：用已知的默认模型 id 补齐，条目仍然出现。
	// 停止事件不带 modelId 时，按 provider 沿用上一次的 model，保证卡片不消失。
	const prevModelOfProvider = reg?.modelId ? undefined : [...cache.values()].find((h) => h.provider === provider)?.modelId;
	const modelId = reg?.modelId ?? prevModelOfProvider ?? fallbackModelId;
	if (!modelId) return;
	const key = `${provider}::${modelId}`;
	const prev = cache.get(key);
	const state = s.runtime?.state ?? "stopped";
	const baseUrl = reg?.baseUrl ?? prev?.baseUrl ?? (s.runtime?.port ? `http://127.0.0.1:${s.runtime.port}` : undefined);
	const asr = type === "asr" && s.model ? { sampleRate: Number(s.model.sampleRate ?? 16000), maxSeconds: Number(s.model.maxSeconds ?? 120), languages: Array.isArray(s.model.languages) ? (s.model.languages as string[]) : [], punctuation: !!s.model.punctuation } : undefined;
	cache.set(key, {
		provider,
		label: label ?? prev?.label ?? LOCAL_PROVIDER_LABELS[provider] ?? modelId,
		modelId,
		type: prev?.type ?? type,
		protocol: reg?.protocol ?? prev?.protocol ?? (type === "asr" ? "local-asr-http" : "typesafe-system-one"),
		...(baseUrl ? { baseUrl } : {}),
		installed: s.install?.state === "installed" || !!prev?.installed,
		running: state === "running",
		state,
		device: s.health?.device ?? null,
		...(asr ? { asr } : {}),
		lastSeen: now,
	});
}

// 只认这两个已知事件名（来自本地服务自己的 status，安全元数据）；不改对方的文件。
// local-asr 事件允许带顶层 provider / modelId（停止后 status.registered 为 null 时仍能定位）；缺省回退到已知 id。
bus.on((e) => {
	if (e.type === "local-asr.changed")
		rememberLocalModelStatus(
			(e as { status?: unknown }).status,
			(e as { provider?: string }).provider ?? "local-sensevoice",
			(e as { modelId?: string }).modelId ?? "sensevoice-small-int8",
			Date.now(),
			"asr",
			(e as { label?: string }).label,
		);
});

/** 当前已知的本地模型服务（安全元数据；未安装且未运行的不会进来）。 */
export function localModelHints(): LocalModelHint[] {
	return [...cache.values()].filter((h) => h.installed || h.running);
}

export function localModelHint(provider: string): LocalModelHint | undefined {
	return [...cache.values()].find((h) => h.provider === provider);
}

/** 测试用：清空缓存。 */
export function resetLocalModelHints(): void {
	cache.clear();
}
