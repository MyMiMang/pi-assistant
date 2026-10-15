/**
 * 本地模型服务（如 local-laya）的**安全**运行状态缓存。
 *
 * 只订阅既有的安全状态事件（`local-laya.changed`，payload 是该服务的 status，**不含 token / 凭据**），
 * 记住每个本地服务「最后一次注册的 provider / model」与安装、运行状态。这样：
 *  - 服务 stop（从 Pi classifier 目录里被摘掉）后，统一注册表里的服务卡**不会消失**，只标「暂不可用」；
 *  - 安装状态与运行状态分开（installed ≠ running）；
 *  - 重启后同 id 注册回来时能继续（沿用同一条缓存）。
 *
 * 不 import 任何本地服务实现（避免互相改文件），也不读凭据 / baseUrl。
 */
import { bus } from "./bus.ts";

export interface LocalModelHint {
	provider: string;
	modelId: string;
	protocol: string;
	/** 已安装（不代表能用） */
	installed: boolean;
	/** 运行中（auth 可用、已注册） */
	running: boolean;
	/** 原始运行状态：stopped / starting / running / stopping / crashed */
	state: string;
	/** 实测计算设备（来自 health.device），未运行 / 未知为 null */
	device: string | null;
	lastSeen: number;
}

const cache = new Map<string, LocalModelHint>();

interface LayaStatusLike {
	install?: { state?: string };
	runtime?: { state?: string };
	health?: { device?: string | null } | null;
	registered?: { provider?: string; modelId?: string; protocol?: string } | null;
}

/**
 * 把一个本地服务状态并入缓存（安全元数据）。停止后 `registered` 为 null，
 * 沿用上一次的 provider / model，保证卡片不消失；只认 provider / model 标识，绝不读 token。
 */
export function rememberLocalModelStatus(status: unknown, providerHint?: string, now = Date.now()): void {
	const s = status as LayaStatusLike | null;
	if (!s || typeof s !== "object") return;
	const reg = s.registered ?? undefined;
	// 停止后 registered 为 null：用事件名对应的 provider 沿用上一次的 provider / model，保证卡片不消失。
	const provider = reg?.provider ?? providerHint;
	if (!provider) return;
	const prev = cache.get(provider);
	const modelId = reg?.modelId ?? prev?.modelId;
	if (!modelId) return;
	const state = s.runtime?.state ?? "stopped";
	cache.set(provider, {
		provider,
		modelId,
		protocol: reg?.protocol ?? prev?.protocol ?? "typesafe-system-one",
		installed: s.install?.state === "installed" || !!prev?.installed,
		running: state === "running",
		state,
		device: s.health?.device ?? null,
		lastSeen: now,
	});
}

// 只认这一个已知事件名（来自本地服务自己的 status，安全元数据）；不改对方的文件。
bus.on((e) => {
	if (e.type === "local-laya.changed") rememberLocalModelStatus((e as { status?: unknown }).status, "local-laya");
});

/** 当前已知的本地模型服务（安全元数据；未安装且未运行的不会进来）。 */
export function localModelHints(): LocalModelHint[] {
	return [...cache.values()].filter((h) => h.installed || h.running);
}

export function localModelHint(provider: string): LocalModelHint | undefined {
	return cache.get(provider);
}

/** 测试用：清空缓存。 */
export function resetLocalModelHints(): void {
	cache.clear();
}
