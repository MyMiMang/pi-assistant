/**
 * 「默认本地语音」准备状态的**纯归一化层**（不 import React / 不发请求）。
 *
 * 背景（主决策）：全新未配置用户**自动准备**中英双语 online zipformer + 现有 sherpa 运行时——
 * 首次需联网（模型 + runtime 估算 < 300 MB，**非实测**），准备后离线可用；**不随 app 捆绑**（权重再分发许可未充分确认），
 * 因此**不把首次联网叫「首断网开箱」**，界面必须如实写「首次需联网」。
 *
 * 数据来自后端 `GET voicepref` 的新状态（default：preparing / ready / fail / cancel）。**字段名与路径等主线与 backend
 * owner 的契约**；本文件只做**宽容归一化**（认多个候选键、缺字段给安全缺省、结构不认识 → `ok:false`），
 * 让 UI 在契约到位前可以先把状态显示与进度 / 取消 / 失败重试写好，接线时只换数据来源。
 *
 * 原则：
 *  - **不伪造**：读不到 / 结构不认识 → `state:"unknown"`、`ok:false`，UI 什么都不显示，不猜「已就绪」；
 *  - **不抢占用户选择**：这里只读展示，不发起写 `source`（自动默认是服务端 CAS + opt-out 管的，前端不另 PUT）；
 *  - 进度复用统一下载注册表（`asr:<modelId>`），同一模型 = 同一 job。
 */
import type { VoiceSource } from "./api";
import type { LiveDownloadLike } from "./local-asr-intent";

export type VoicePrepareState = "unknown" | "not_ready" | "preparing" | "ready" | "failed" | "cancelled";

export interface VoicePrepareView {
	/** 结构是否被认识（false = 不显示任何状态，避免瞎说）。 */
	ok: boolean;
	state: VoicePrepareState;
	/** 默认模型 id（`local-models/asr` 的稳定 id）。 */
	defaultModelId: string | null;
	/** 默认模型显示名（后端给；缺省用 id）。 */
	defaultModelName: string;
	/** 统一下载注册表 stable id（`asr:<modelId>`），用于合并实时进度。 */
	downloadId: string | null;
	received: number;
	/** null = 总量未知 → 不确定进度条。 */
	total: number | null;
	percent: number | null;
	error: string | null;
	/** 用户显式 opt-out（不再自动准备）；**不代用户改**。 */
	optedOut: boolean;
	/** 实际生效的来源（`null` = 未配置 = 默认语义仍适用）。 */
	source: VoiceSource | null;
	/** 首次是否需联网：`true` 明示；`false` 仅在服务端确实内置时；`null` = 未说明 → 不声称离线可用。 */
	firstUseOnline: boolean | null;
	/** 估算体积（字节）；非实测，仅用于文案。 */
	estimatedBytes: number | null;
	/** 一句话状态 / 说明（后端可给；用于就地简洁显示）。 */
	note: string;
}

const pick = (o: Record<string, unknown>, keys: string[], fallback: unknown): unknown => {
	for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
	return fallback;
};
const asString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asBool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
const asNum = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const asNumOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const STATES: VoicePrepareState[] = ["not_ready", "preparing", "ready", "failed", "cancelled"];

function normalizeSource(raw: unknown): VoiceSource | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const location = asString(o.location, "");
	const provider = asString(o.provider, "");
	const model = asString(o.model, "");
	if ((location !== "cloud" && location !== "local") || !provider || !model) return null;
	return { location, provider, model };
}

/** 失败 / 取消 / 就绪几个后端可能用的别名，收敛成稳定枚举；认不出 → unknown。 */
function normalizeState(raw: unknown): VoicePrepareState {
	const s = asString(raw, "").toLowerCase();
	if (!s) return "unknown";
	if ((STATES as string[]).includes(s)) return s as VoicePrepareState;
	if (["pending", "downloading", "installing", "warming", "preparing", "in_progress"].includes(s)) return "preparing";
	if (["available", "done", "installed", "ready", "ok"].includes(s)) return "ready";
	if (["error", "fail", "failed"].includes(s)) return "failed";
	if (["cancel", "cancelled", "canceled", "aborted"].includes(s)) return "cancelled";
	if (["idle", "missing", "not_installed", "not_ready"].includes(s)) return "not_ready";
	return "unknown";
}

/** 结构不认识时的安全缺省（`ok:false` → UI 不显示）。 */
export function emptyVoicePrepareView(): VoicePrepareView {
	return { ok: false, state: "unknown", defaultModelId: null, defaultModelName: "", downloadId: null, received: 0, total: null, percent: null, error: null, optedOut: false, source: null, firstUseOnline: null, estimatedBytes: null, note: "" };
}

/**
 * 宽容归一化 `GET voicepref`。字段名认多个候选；**认不出状态就 `ok:false`**，绝不默认「已就绪」。
 * 接受两种形态：顶层直接给状态，或 `{ default: {...} }`（契约未定，两者都兼容）。
 */
export function normalizeVoicePrepareView(raw: unknown): VoicePrepareView {
	if (!raw || typeof raw !== "object") return emptyVoicePrepareView();
	const top = raw as Record<string, unknown>;
	const inner = (top.default && typeof top.default === "object" ? (top.default as Record<string, unknown>) : top) as Record<string, unknown>;
	const rawState = pick(inner, ["state", "status", "prepareState", "prepare_state", "defaultState", "default_state"], null);
	const state = normalizeState(rawState);
	if (state === "unknown") return emptyVoicePrepareView();
	const defaultModelId = (pick(inner, ["defaultModelId", "default_model_id", "modelId", "model_id", "id"], null) as string | null) ?? null;
	const received = asNum(pick(inner, ["received", "receivedBytes", "received_bytes"], 0));
	const total = asNumOrNull(pick(inner, ["total", "totalBytes", "total_bytes"], null));
	const percentRaw = asNumOrNull(pick(inner, ["percent", "progress"], null));
	const percent = percentRaw ?? (total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null);
	const firstUseRaw = pick(inner, ["firstUseOnline", "first_use_online", "requiresNetwork", "requires_network", "needsNetwork", "needs_network"], null);
	return {
		ok: true,
		state,
		defaultModelId,
		defaultModelName: asString(pick(inner, ["defaultModelName", "default_model_name", "modelName", "model_name", "name"], defaultModelId ?? ""), defaultModelId ?? ""),
		downloadId: (pick(inner, ["downloadId", "download_id", "jobId", "job_id"], null) as string | null) ?? (defaultModelId ? `asr:${defaultModelId}` : null),
		received,
		total,
		percent,
		error: (pick(inner, ["error", "errorMessage", "error_message", "reason"], null) as string | null) ?? null,
		optedOut: asBool(pick(inner, ["optedOut", "opted_out", "optOut", "opt_out", "disabled"], false)),
		source: normalizeSource(pick(inner, ["source", "currentSource", "current_source"], null)),
		firstUseOnline: typeof firstUseRaw === "boolean" ? firstUseRaw : null,
		estimatedBytes: asNumOrNull(pick(inner, ["estimatedBytes", "estimated_bytes", "estimateBytes", "estimate_bytes", "sizeBytes", "size_bytes"], null)),
		note: asString(pick(inner, ["note", "message", "detail"], "")),
	};
}

/** 合并统一下载注册表的实时进度（下载面板 / 语音页看到同一份）。 */
export function mergePrepareDownload(v: VoicePrepareView, live: LiveDownloadLike | undefined): VoicePrepareView {
	if (!live) return v;
	if (live.state === "downloading") return { ...v, state: "preparing", received: live.received, total: live.total, percent: live.percent ?? v.percent, error: null };
	if (live.state === "error") return { ...v, state: "failed", error: live.error ?? v.error };
	return v;
}

/** 就地一句状态（短；详细解释放 Help）。 */
export function voicePrepareLabel(v: VoicePrepareView): string {
	if (!v.ok) return "";
	const name = v.defaultModelName || v.defaultModelId || "默认本地模型";
	switch (v.state) {
		case "preparing":
			return v.percent != null ? `正在准备${name}… ${v.percent}%` : `正在准备${name}…`;
		case "ready":
			return `${name}已就绪`;
		case "failed":
			return `${name}准备失败`;
		case "cancelled":
			return `${name}准备已取消`;
		case "not_ready":
			return `${name}待准备`;
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

/** 进行中可取消（preparing）；失败 / 取消可重试。 */
export function canCancelPrepare(v: VoicePrepareView): boolean {
	return v.ok && v.state === "preparing";
}
export function canRetryPrepare(v: VoicePrepareView): boolean {
	return v.ok && (v.state === "failed" || v.state === "cancelled");
}

/** 首次联网提示（**绝不在未知时说可离线**）。 */
export function firstUseNote(v: VoicePrepareView): string {
	if (v.firstUseOnline === true) {
		const size = v.estimatedBytes ? `约 ${Math.round(v.estimatedBytes / 1e6)} MB` : "估算 < 300 MB";
		return `首次使用需联网自动准备（${size}，估算非实测），准备好后即可离线使用。`;
	}
	if (v.firstUseOnline === false) return "已随应用内置，可离线使用。";
	return "";
}
