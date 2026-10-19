/**
 * 「默认本地语音」准备状态的**纯归一化层**（不 import React / 不发请求）。
 *
 * 数据来源（已冻结，见 `docs/design/default-stream-contract.md` §1.1）：
 * `GET /api/audio/asr/source` 返回块 `defaultVoice: DefaultVoicePrepView`——
 * `{ defaultModelId, kind, label, prep:{ state, jobId, phase, phaseLabel, received, total, percent, attempt,
 *   startedAt, finishedAt, error, errorCode, retryable }, firstRunNeedsNetwork, approxBytes, offlineAfterReady,
 *   requiresUserAction:true, micPermissionRequested:false, notes }`。
 * 本地语音是**可选模块**（决策 0013）：默认不安装，用户在 设置 › 语音 点「安装」才下载；`cancelled` 只为兼容旧后端。
 *
 * 原则：
 *  - **精确按契约形状解析**（`prep.state` 必须是契约枚举之一）；结构不认识 → `ok:false` / `state:"unknown"`，
 *    UI 什么都不显示，**不猜、不默认「已就绪」**；
 *  - **不抢占用户选择**：这里只读展示，不写 `source`（「安装并使用」由服务端 CAS 管）；
 *  - 进度复用统一下载注册表（同一稳定 id `asr:<modelId>`），同一模型 = 同一 job；
 *  - **首次联网如实分层**：未知 (null) 时绝不声称可离线。
 */
import type { LiveDownloadLike } from "./local-asr-intent.ts";

/** 契约里的 prep.state 枚举 + 归一化兜底 `unknown`（认不出才用）。 */
export type VoicePrepareState = "not_applicable" | "not_prepared" | "preparing" | "ready" | "failed" | "cancelled" | "unknown";

const PREP_STATES = ["not_applicable", "not_prepared", "preparing", "ready", "failed", "cancelled"] as const;
const KINDS = ["user-chosen", "default", "unconfigured"] as const;

export interface VoicePrepareView {
	/** 结构是否被契约认识（false = 不显示任何状态，避免瞎说）。 */
	ok: boolean;
	state: VoicePrepareState;
	kind: "user-chosen" | "default" | "unconfigured" | null;
	/** 后端给的一句话（可直接显示；可能为空）。 */
	label: string;
	defaultModelId: string | null;
	/** 统一下载注册表 stable id（= `prep.jobId`，`asr:<modelId>`）：与「下载与组件」同一个 job。 */
	jobId: string | null;
	phase: string | null;
	phaseLabel: string | null;
	received: number | null;
	/** null = 总量未知 → 前端画不定进度条，不编百分比。 */
	total: number | null;
	percent: number | null;
	attempt: number | null;
	startedAt: string | null;
	finishedAt: string | null;
	error: string | null;
	errorCode: string | null;
	retryable: boolean;
	/** 首次是否需联网：true 明示；false 仅在服务端确实内置时；null = 未说明 → 不声称离线可用。 */
	firstRunNeedsNetwork: boolean | null;
	/** 估算体积（字节，权重 + 共享运行时；非实测，仅用于文案）。 */
	approxBytes: number | null;
	offlineAfterReady: boolean | null;
	notes: string[];
}

const asString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asBool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
const asNumOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asStrOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const asStrArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** 结构不认识时的安全缺省（`ok:false` → UI 不显示）。 */
export function emptyVoicePrepareView(): VoicePrepareView {
	return {
		ok: false,
		state: "unknown",
		kind: null,
		label: "",
		defaultModelId: null,
		jobId: null,
		phase: null,
		phaseLabel: null,
		received: null,
		total: null,
		percent: null,
		attempt: null,
		startedAt: null,
		finishedAt: null,
		error: null,
		errorCode: null,
		retryable: false,
		firstRunNeedsNetwork: null,
		approxBytes: null,
		offlineAfterReady: null,
		notes: [],
	};
}

/**
 * 归一化契约的 `defaultVoice` 块。接受 `DefaultVoicePrepView` 本体，或包着它的 `{ defaultVoice: {...} }`
 * （即整份 `AsrSourceView`）。**认不出 `prep.state` 就 `ok:false`**，绝不默认「已就绪」。
 */
export function normalizeVoicePrepareView(raw: unknown): VoicePrepareView {
	if (!raw || typeof raw !== "object") return emptyVoicePrepareView();
	const top = raw as Record<string, unknown>;
	const dv = (top.defaultVoice && typeof top.defaultVoice === "object" ? top.defaultVoice : top) as Record<string, unknown>;
	const prepRaw = dv.prep;
	if (!prepRaw || typeof prepRaw !== "object") return emptyVoicePrepareView();
	const prep = prepRaw as Record<string, unknown>;
	const state = asString(prep.state, "");
	if (!(PREP_STATES as readonly string[]).includes(state)) return emptyVoicePrepareView();
	const kindRaw = asString(dv.kind, "");
	const defaultModelId = asStrOrNull(dv.defaultModelId);
	const jobId = (asStrOrNull(prep.jobId) ?? (defaultModelId ? `asr:${defaultModelId}` : null));
	return {
		ok: true,
		state: state as VoicePrepareState,
		kind: (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as VoicePrepareView["kind"]) : null,
		label: asString(dv.label, ""),
		defaultModelId,
		jobId,
		phase: asStrOrNull(prep.phase),
		phaseLabel: asStrOrNull(prep.phaseLabel),
		received: asNumOrNull(prep.received),
		total: asNumOrNull(prep.total),
		percent: asNumOrNull(prep.percent),
		attempt: asNumOrNull(prep.attempt),
		startedAt: asStrOrNull(prep.startedAt),
		finishedAt: asStrOrNull(prep.finishedAt),
		error: asStrOrNull(prep.error),
		errorCode: asStrOrNull(prep.errorCode),
		retryable: asBool(prep.retryable, false),
		firstRunNeedsNetwork: typeof dv.firstRunNeedsNetwork === "boolean" ? dv.firstRunNeedsNetwork : null,
		approxBytes: asNumOrNull(dv.approxBytes),
		offlineAfterReady: typeof dv.offlineAfterReady === "boolean" ? dv.offlineAfterReady : null,
		notes: asStrArray(dv.notes),
	};
}

/** 合并统一下载注册表的实时进度（语音页 / 下载面板看到同一份，同一个 `asr:<modelId>` job）。 */
export function mergePrepareDownload(v: VoicePrepareView, live: LiveDownloadLike | undefined): VoicePrepareView {
	if (!v.ok || !live) return v;
	if (live.state === "downloading") {
		const total = live.total ?? v.total;
		const received = live.received ?? v.received;
		return { ...v, state: "preparing", received, total, percent: live.percent ?? (total && received != null && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : v.percent), error: null };
	}
	if (live.state === "error") return { ...v, state: "failed", error: live.error ?? v.error };
	if (live.state === "ready") return { ...v, state: "ready" };
	return v;
}

/** 就地一句状态（短；详细解释放 Help）。 */
export function voicePrepareLabel(v: VoicePrepareView): string {
	if (!v.ok) return "";
	switch (v.state) {
		case "preparing": {
			const parts = [v.phaseLabel, v.percent != null ? `${v.percent}%` : ""].filter(Boolean).join(" ");
			return parts ? `正在安装本地语音（${parts}）` : "正在安装本地语音…";
		}
		case "ready":
			return "本地语音已安装";
		case "failed":
			return "本地语音安装失败";
		case "cancelled":
		case "not_prepared":
			return "本地语音未安装";
		default:
			return "";
	}
}

export function voicePrepareTone(v: VoicePrepareView): "green" | "amber" | "red" | "zinc" {
	switch (v.state) {
		case "ready":
			return "green";
		case "preparing":
			return "amber";
		case "failed":
			return "red";
		default:
			return "zinc";
	}
}

/** 进行中可取消（preparing）；未安装 / 失败可安装（失败即重试）。都要求有统一下载 job id（同一个 job）。 */
export function canCancelPrepare(v: VoicePrepareView): boolean {
	return v.ok && v.state === "preparing" && !!v.jobId;
}
export function canInstallPrepare(v: VoicePrepareView): boolean {
	return v.ok && (v.state === "not_prepared" || v.state === "failed" || v.state === "cancelled") && !!v.jobId;
}

/** 进度条：total 未知时返回 null（画不定进度条，不编百分比）。 */
export function preparePercent(v: VoicePrepareView): number | null {
	if (v.percent != null) return v.percent;
	if (v.received != null && v.total != null && v.total > 0) return Math.min(100, Math.round((v.received / v.total) * 100));
	return null;
}

/** 安装体积 / 联网提示（**绝不在未知时说可离线**）。 */
export function firstUseNote(v: VoicePrepareView): string {
	if (!v.ok) return "";
	if (v.firstRunNeedsNetwork === true) {
		const size = v.approxBytes ? `约 ${Math.round(v.approxBytes / 1e6)} MB` : "不到 300 MB";
		return `默认不安装；安装需联网下载${size}（估算），装好后可离线使用。`;
	}
	if (v.firstRunNeedsNetwork === false) return "已随应用内置，可离线使用。";
	return "";
}
