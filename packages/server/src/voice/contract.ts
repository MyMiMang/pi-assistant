/**
 * 语音输入（ASR）的服务端契约：DTO、协议、上限与本地 runtime 约定。
 *
 * 这里只放**类型与常量**，不 import 任何实现，供路由 / 适配器 / 本地 runtime / 前端类型共用。
 * 事实依据见 docs/design/voice-input.md：Pi SDK 公开模型类型只有 chat/image/classifier，
 * 没有 audio/ASR，所以 ASR 是 Pi Assistant 自有的第四种 `type:"asr"`，经**薄 adapter** 调
 * OpenAI 兼容的 `/v1/audio/transcriptions`；**不修改 Pi SDK / node_modules / secret.ts**。
 */

/** 目前只认这一种 ASR 协议：OpenAI 兼容的 multipart `/v1/audio/transcriptions`。 */
export const ASR_PROTOCOLS = ["openai-audio-transcriptions"] as const;
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
} as const;
export type AsrErrorCode = (typeof ASR_ERRORS)[keyof typeof ASR_ERRORS];

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
