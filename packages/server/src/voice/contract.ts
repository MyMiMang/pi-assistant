/**
 * 语音输入（ASR）的服务端契约：DTO、协议、上限与本地 runtime 约定。
 *
 * 这里只放**类型与常量**，不 import 任何实现，供路由 / 适配器 / 本地 runtime / 前端类型共用。
 * 事实依据见 docs/design/voice-input.md：Pi SDK 公开模型类型只有 chat/image/classifier，
 * 没有 audio/ASR，所以 ASR 是 Pi Assistant 自有的第四种 `type:"asr"`，经**薄 adapter** 调
 * OpenAI 兼容的 `/v1/audio/transcriptions`；**不修改 Pi SDK / node_modules / secret.ts**。
 */
import type { DefaultVoicePrepView } from "../local-asr/default-voice-prep.ts";

/** 认这两种 ASR 协议：云 = OpenAI 兼容 multipart `/v1/audio/transcriptions`；本地 = loopback sidecar raw WAV。 */
export const ASR_PROTOCOLS = ["openai-audio-transcriptions", "local-asr-http"] as const;
export type AsrProtocol = (typeof ASR_PROTOCOLS)[number];

/** 本地上报 ASR 状态的 bus 事件名（本地 runtime 用 `bus.emit({ type: LOCAL_ASR_EVENT, status })`）。 */
export const LOCAL_ASR_EVENT = "local-asr.changed";

/** 单次录音的硬上限（用户已确认：默认 60 秒；超时自动停止并转写，不静默丢弃）。 */
export const ASR_MAX_DURATION_MS = 60_000;
/** 上传字节上限：16 kHz / 单声道 / 16 bit PCM 60 秒 ≈ 1.92 MB，留足余量给容器头。 */
export const ASR_MAX_BYTES = 5 * 1024 * 1024;
/** 上游请求超时（含网络 + 推理）。 */
export const ASR_TIMEOUT_MS = 60_000;
/** 幂等缓存 TTL：只对 **completed** 结果生效，避免重复调用上游（可能重复计费）。 */
export const ASR_DEDUP_TTL_MS = 5 * 60_000;

/** 稳定错误码（前端按码给可解释文案，不把上游原文透给用户）。 */
export const ASR_ERRORS = {
	notConfigured: "asr_not_configured",
	invalidAudio: "asr_invalid_audio",
	tooLarge: "asr_too_large",
	timeout: "asr_timeout",
	upstream: "asr_upstream_error",
	aborted: "asr_aborted",
	busy: "asr_busy",
	/** PUT 来源时 provider / model 不在已声明（或已配置）的 ASR 列表里 */
	notDeclared: "asr_not_declared",
	/** 请求带的 provider / model 与当前显式来源不一致（旧 UI 过期状态） */
	sourceChanged: "voice_source_changed",
	/** PUT 来源的 JSON 形状不合法（未知字段 / 类型不对），不落库 */
	invalidSource: "asr_invalid_source",
	/** PUT 来源携带的 expectedVersion 与当前持久化版本不一致（另一个页面 / 客户端已改选） */
	sourceConflict: "asr_source_conflict",
} as const;
export type AsrErrorCode = (typeof ASR_ERRORS)[keyof typeof ASR_ERRORS];

/** 用户显式选择的语音识别来源（**单一全局用户偏好**）：`null` = 未配置，绝不自动挑第一个云端。 */
export interface AsrSource {
	location: "cloud" | "local";
	provider: string;
	model: string;
}

/**
 * 来源可用性的归一化状态：**只有 `ready` 表示现在就能用**，其余一律带 `reason`（可直接显示的中文）。
 * 未安装的本地模型也允许被显式选择（先把「用本地」的意图存下来），但可用性必须如实标 `not_installed`。
 */
export type AsrSourceAvailability = "ready" | "not_configured" | "not_installed" | "not_running" | "deleted";

/** 语音配置页的一个候选项（`GET /api/audio/asr/source` 的 `options`）。只含元数据，不含 Key / token。 */
export interface AsrSourceOption {
	location: "cloud" | "local";
	provider: string;
	model: string;
	/** 界面显示名（「中文功能名（模型名）」口径） */
	name: string;
	protocol: string;
	/** 是否原生流式（本地流式模型为 true；前端据此决定走 start/append/end 还是 batch） */
	streaming?: boolean;
	/** 流式协议（`streaming=true` 时为 `asr-stream-v1`；否则 null）。与 adapter capability 一致。 */
	streamProtocol?: string | null;
	availability: AsrSourceAvailability;
	/** `availability !== "ready"` 时的中文原因；ready 时为 null */
	reason: string | null;
	/** 是否等于当前已保存的 `source` */
	selected: boolean;
}

/** 语音来源的完整视图：当前选择 + 归一化的候选列表 + 持久化版本（跨客户端 CAS）。 */
export interface AsrSourceView {
	source: AsrSource | null;
	options: AsrSourceOption[];
	/** 每次写入递增；客户端 PUT 时可回传期望版本做 CAS，防 ABA / 跨客户端覆盖 */
	version: number;
	/** 默认本地语音的自动准备状态（可选；旧客户端忽略即可）。契约见 progress-snapshots/default-stream-contract.md §1.1。 */
	defaultVoice?: DefaultVoicePrepView;
}

/** 客户端提交的转写请求（路由层解析 multipart 后得到；音频只在内存里）。 */
export interface AsrRequest {
	provider: string;
	model: string;
	/** 音频字节（PCM16 WAV，或 provider 明确支持的格式）。 */
	audio: Uint8Array;
	/** 上传文件名（只用于 multipart 字段，不落盘）。 */
	filename: string;
	/** 幂等键；相同 key 的 **已完成** 结果直接复用，不重复调上游。 */
	requestId: string;
	language?: string;
	/** 归属上下文（只用于审计 / 归属，不参与鉴权）。 */
	agentId?: string;
	conversationId?: string;
}

/** 已确认的 WAV 音频元数据。 */
export interface WavInfo {
	sampleRate: number;
	channels: number;
	bitsPerSample: number;
	dataBytes: number;
	durationMs: number;
}

/** 真实用量：只填上游**真实返回**的数值，未知一律不填（绝不填 0）。 */
export interface AsrUsage {
	audioSeconds?: number;
	inputTokens?: number;
	outputTokens?: number;
}

/** 转写成功结果。 */
export interface AsrResult {
	text: string;
	provider: string;
	model: string;
	durationMs: number;
	usage?: AsrUsage;
}

/** 上游解析出的调用信息（由注册表 + 公开凭据接口提供；本模块不自己解析 key）。 */
export interface AsrEndpoint {
	protocol: AsrProtocol | string;
	baseUrl: string;
	apiKey?: string;
	/** 音频是否离开本机（本地 provider 为 local）。 */
	location: "cloud" | "local";
}
