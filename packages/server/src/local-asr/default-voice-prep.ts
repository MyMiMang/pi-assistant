/**
 * 「默认本地语音」**自动准备**的持久标记与资格判定（纯逻辑 + 两个 settings 标记）。
 *
 * 主决策（P2）：新鲜用户（来源**从未设置**）首次启动时**自动后台准备**默认本地流式模型，
 * 完成后自动 selected & ready；**首次需联网并透明显示**，准备后可离线；**不随包分发许可未充分确认的权重**。
 *
 * 不覆盖任何已有选择（用户要求）：
 *  - `settings.voiceSource` **key 不存在** = unset（新鲜用户，可自动准备）；
 *  - key 存在且值为 `null` = 用户**显式清空**（写 optout，**不**自动准备、不 restart）；
 *  - 已是云 / 本地任何值 = 一律不动；
 *  - `voiceDefaultInit` = 自动 job **全局只启动一次**（不反复重试、不「每次启动就下」）；
 *  - `voiceDefaultOptOut` = 用户取消 / 清空过 → 记 intent，**不 restart**。
 *
 * 设计见 `docs/design/default-local-voice.md`；契约见 `progress-snapshots/default-stream-contract.md` §1.2。
 */
import { getSetting, setSetting } from "../db.ts";

/** 自动准备标记：全局只启动一次（含安装开始时捕获的来源版本，供 CAS）。 */
export const VOICE_DEFAULT_INIT_KEY = "voiceDefaultInit";
/** 自动准备退出标记：用户取消 / 清空来源 / 改选其它 → 不再自动重启。 */
export const VOICE_DEFAULT_OPTOUT_KEY = "voiceDefaultOptOut";

export interface DefaultVoiceInitMarker {
	at: string;
	modelId: string;
	sourceVersionAtStart: number;
}

export interface DefaultVoiceOptOutMarker {
	at: string;
	reason: "cancelled" | "user_cleared" | "user_chose_other";
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function readDefaultInit(): DefaultVoiceInitMarker | null {
	const v = getSetting<unknown>(VOICE_DEFAULT_INIT_KEY, null);
	if (!isObject(v) || typeof v.modelId !== "string" || typeof v.at !== "string") return null;
	return { at: v.at, modelId: v.modelId, sourceVersionAtStart: typeof v.sourceVersionAtStart === "number" ? v.sourceVersionAtStart : 0 };
}

export function readDefaultOptOut(): DefaultVoiceOptOutMarker | null {
	const v = getSetting<unknown>(VOICE_DEFAULT_OPTOUT_KEY, null);
	if (!isObject(v) || typeof v.at !== "string") return null;
	const reason = v.reason === "cancelled" || v.reason === "user_cleared" || v.reason === "user_chose_other" ? v.reason : "user_chose_other";
	return { at: v.at, reason };
}

export function writeDefaultInit(m: DefaultVoiceInitMarker): void {
	setSetting(VOICE_DEFAULT_INIT_KEY, m);
}

export function writeDefaultOptOut(reason: DefaultVoiceOptOutMarker["reason"], at = new Date().toISOString()): void {
	setSetting(VOICE_DEFAULT_OPTOUT_KEY, { at, reason } satisfies DefaultVoiceOptOutMarker);
}

/** 用户**显式采用**默认（点「使用默认本地」）时清掉 optout，允许以后正常使用默认（但不重新自动准备）。 */
export function clearDefaultOptOut(): void {
	setSetting(VOICE_DEFAULT_OPTOUT_KEY, null);
}

/** 清空两个自动准备标记（测试 / 重置用）。 */
export function clearDefaultVoiceMarkers(): void {
	setSetting(VOICE_DEFAULT_INIT_KEY, null);
	setSetting(VOICE_DEFAULT_OPTOUT_KEY, null);
}

export interface DefaultVoiceEligibilityInput {
	/** `settings.voiceSource` key 是否存在（区分 unset 与显式 null） */
	sourceKeyPresent: boolean;
	/** 当前来源（`null` = 未配置 / 已清空） */
	source: { location: string; provider: string; model: string } | null;
	init: DefaultVoiceInitMarker | null;
	optout: DefaultVoiceOptOutMarker | null;
	/** catalog 解析出的唯一默认模型 id（null = 目录没标记，fail closed） */
	defaultModelId: string | null;
}

export interface DefaultVoiceEligibility {
	eligible: boolean;
	reason: string;
}

/** 自动准备资格（纯函数）：全部满足才启动；否则给出中文原因（用于状态 / 排障，不暴露内部）。 */
export function defaultVoiceEligible(input: DefaultVoiceEligibilityInput): DefaultVoiceEligibility {
	if (!input.defaultModelId) return { eligible: false, reason: "目录里没有标记为「默认本地语音」的模型（fail closed，不猜）" };
	if (input.source !== null) return { eligible: false, reason: "已有显式语音来源，默认绝不覆盖" };
	if (input.sourceKeyPresent) return { eligible: false, reason: "用户已显式清空来源（unset 才自动准备）" };
	if (input.optout) return { eligible: false, reason: "用户已取消 / 清空过自动准备，不再自动重启" };
	if (input.init) return { eligible: false, reason: "自动准备只启动一次（已启动过）" };
	return { eligible: true, reason: "新鲜用户（来源从未设置）→ 自动后台准备默认本地流式模型" };
}

/** 自动准备状态视图（契约 §1.1 的 `defaultVoice` 块；给前端直接显示）。 */
export interface DefaultVoicePrepView {
	defaultModelId: string | null;
	kind: "user-chosen" | "default" | "unconfigured";
	label: string;
	prep: {
		state: "not_applicable" | "not_prepared" | "preparing" | "ready" | "failed" | "cancelled";
		jobId: string | null;
		phase: string | null;
		phaseLabel: string | null;
		received: number | null;
		total: number | null;
		percent: number | null;
		attempt: number | null;
		startedAt: string | null;
		finishedAt: string | null;
		error: string | null;
		errorCode: string | null;
		retryable: boolean;
	};
	firstRunNeedsNetwork: boolean;
	approxBytes: number | null;
	offlineAfterReady: boolean;
	requiresUserAction: false;
	micPermissionRequested: false;
	notes: string[];
}
