/**
 * 语音输入（输入栏语音→文字草稿）的**纯逻辑**：状态机、WAV 组包、真实重采样、草稿锚点插入、能力/错误映射。
 *
 * 这里不 import React、不直接碰 `navigator` / `AudioContext`（全部依赖注入），
 * 因此可以在 Node 里用假 getUserMedia / 假 provider 单测（见 packages/server/test/voice-input.test.ts）。
 * 真实浏览器管线在 `hooks/useVoiceInput.ts`，UI 在 `components/VoiceInput.tsx`。
 *
 * 关键约束（docs/design/voice-input.md）：
 *  - **不假 16000**：AudioContext 的 sampleRate 是请求值，实际不等于 16000 时必须真重采样；
 *  - **取消 = 不发起转写请求**（不重复付费）；切对话 / 页面隐藏 → 停轨道 + 取消，**不发送**；
 *  - **结果只插草稿**，插在开始录制时的光标锚点，**保留用户后续编辑**；**不自动发送**；
 *  - IME 组合期间不插入（推迟），不打断候选。
 */

export type VoiceState = "idle" | "preparing" | "recording" | "transcribing" | "error" | "finish";

export interface VoiceError {
	/** 稳定错误码：mic_denied / no_mic / insecure_context / no_mediadevices / asr_not_configured / asr_timeout / network / unknown */
	code: string;
	message: string;
}

export const DEFAULT_MAX_DURATION_MS = 60_000;
export const TARGET_SAMPLE_RATE = 16_000;

// ------------------------------------------------------------------ 能力探测
export interface VoiceEnv {
	mediaDevices?: { getUserMedia?: unknown } | null;
	isSecureContext?: boolean;
}

/** 麦克风是否可用：非安全上下文（如局域网 http://192.168.x.x）时 `navigator.mediaDevices` 不存在。 */
export function voiceCapability(env: VoiceEnv): { available: boolean; reason?: "insecure_context" | "no_mediadevices" } {
	if (env.isSecureContext === false) return { available: false, reason: "insecure_context" };
	if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== "function") return { available: false, reason: "no_mediadevices" };
	return { available: true };
}

export function voiceErrorFrom(err: unknown): VoiceError {
	const name = err && typeof err === "object" && "name" in err ? String((err as { name?: unknown }).name) : "";
	const message = err instanceof Error ? err.message : String(err ?? "");
	if (name === "NotAllowedError" || name === "SecurityError") return { code: "mic_denied", message: "麦克风权限被拒绝，请在系统 / 浏览器设置里允许后重试" };
	if (name === "NotFoundError" || name === "OverconstrainedError") return { code: "no_mic", message: "没有找到可用的麦克风" };
	if (name === "NotReadableError") return { code: "mic_busy", message: "麦克风被其他程序占用" };
	if (name === "AbortError") return { code: "aborted", message: "已取消" };
	if (message.includes("asr_not_configured")) return { code: "asr_not_configured", message: "请先在设置里选择语音识别模型" };
	if (message.includes("asr_timeout")) return { code: "asr_timeout", message: "语音转写超时，请重试" };
	if (message.includes("asr_too_large")) return { code: "asr_too_large", message: "录音太长了，请短一点" };
	if (name === "ApiError" || /网络|fetch|Failed to fetch|NetworkError/i.test(message)) return { code: "network", message: "网络异常，请重试" };
	return { code: "unknown", message: message || "语音输入失败，请重试" };
}

// ------------------------------------------------------------------ 音频
/** 线性插值重采样（真实计算，不假装 16000）。 */
export function resampleTo16k(input: Float32Array, inputRate: number, targetRate = TARGET_SAMPLE_RATE): Float32Array {
	if (inputRate === targetRate || input.length === 0) return input;
	const ratio = inputRate / targetRate;
	const outLen = Math.max(1, Math.round(input.length / ratio));
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const pos = i * ratio;
		const i0 = Math.min(Math.floor(pos), input.length - 1);
		const i1 = Math.min(i0 + 1, input.length - 1);
		const t = pos - i0;
		out[i] = input[i0] * (1 - t) + input[i1] * t;
	}
	return out;
}

export function pcm16FromFloat32(f: Float32Array): Int16Array {
	const out = new Int16Array(f.length);
	for (let i = 0; i < f.length; i++) {
		const s = Math.max(-1, Math.min(1, f[i]));
		out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
	}
	return out;
}

const ascii = (dv: DataView, at: number, s: string) => {
	for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i));
};

/** 组 PCM16 单声道 WAV（44 字节标准头 + 数据）；采样率写**实际值**。 */
export function encodeWav16(pcm: Int16Array, sampleRate = TARGET_SAMPLE_RATE): Uint8Array {
	const dataBytes = pcm.length * 2;
	const buf = new ArrayBuffer(44 + dataBytes);
	const dv = new DataView(buf);
	ascii(dv, 0, "RIFF");
	dv.setUint32(4, 36 + dataBytes, true);
	ascii(dv, 8, "WAVE");
	ascii(dv, 12, "fmt ");
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true); // PCM
	dv.setUint16(22, 1, true); // mono
	dv.setUint32(24, sampleRate, true);
	dv.setUint32(28, sampleRate * 2, true); // byte rate
	dv.setUint16(32, 2, true); // block align
	dv.setUint16(34, 16, true); // bits
	ascii(dv, 36, "data");
	dv.setUint32(40, dataBytes, true);
	for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);
	return new Uint8Array(buf);
}

/** 把若干 Float32 分片拼成一段（去零长分片）。 */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
	const len = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Float32Array(len);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.length;
	}
	return out;
}

// ------------------------------------------------------------------ 草稿合并
export interface ComposerDraft {
	text: string;
	/** 开始录制时的光标位置（锚点）。 */
	anchor: number;
	/** 引用回复（msg 引用子任务引入）；语音取消 / 插入都不动它。 */
	replyTo?: string | null;
}

/**
 * 把转写结果插到**开始录制时的锚点**，保留用户之后的编辑。
 * IME 组合中（composing）不插入，返回 deferred=true，等 compositionend 再调用。
 */
export function insertAtAnchor(draft: ComposerDraft, insert: string, opts: { composing?: boolean } = {}): { draft: ComposerDraft; cursor: number; deferred: boolean } {
	if (opts.composing) return { draft, cursor: draft.anchor, deferred: true };
	const at = Math.max(0, Math.min(draft.anchor, draft.text.length));
	const next = draft.text.slice(0, at) + insert + draft.text.slice(at);
	return { draft: { ...draft, text: next }, cursor: at + insert.length, deferred: false };
}

/** 取消语音：草稿（含引用）**原样不动**。 */
export function applyVoiceCancel(draft: ComposerDraft): ComposerDraft {
	return draft;
}

/** 录制期间用户切换了对话 / 助理：结果**不插入**（避免插到别的会话草稿里）。 */
export function shouldInsert(started: { agentId?: string; conversationId?: string }, current: { agentId?: string; conversationId?: string }): boolean {
	if (started.conversationId && current.conversationId && started.conversationId !== current.conversationId) return false;
	if (started.agentId && current.agentId && started.agentId !== current.agentId) return false;
	return true;
}

// ------------------------------------------------------------------ 控制器
export interface VoiceStartOptions {
	provider: string;
	model: string;
	language?: string;
	agentId?: string;
	conversationId?: string;
	/** 开始录制时的光标锚点。 */
	anchor: number;
}

export interface VoiceResult {
	text: string;
	requestId: string;
	anchor: number;
	agentId?: string;
	conversationId?: string;
}

export interface VoiceCaptureHandle {
	/** 实际采样率（来自 AudioContext.sampleRate）；非 16000 会真重采样。 */
	sampleRate: number;
	stop: () => void;
}

export interface VoiceControllerDeps {
	getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	/** 开始采集 PCM；回调收到 Float32 分片（原始采样率）。 */
	startCapture: (stream: MediaStream, onData: (chunk: Float32Array) => void) => Promise<VoiceCaptureHandle>;
	transcribe: (input: { audio: Uint8Array; requestId: string; provider: string; model: string; language?: string; signal: AbortSignal }) => Promise<{ text: string }>;
	maxDurationMs?: number;
	createRequestId?: () => string;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (t: unknown) => void;
}

export interface VoiceEvents {
	onState?: (s: VoiceState) => void;
	onResult?: (r: VoiceResult) => void;
	onError?: (e: VoiceError) => void;
	/** 转写请求已发出（用于测试「取消 0 次 / 停止 1 次」）。 */
	onRequest?: (requestId: string) => void;
}

/**
 * 录音 → 转写控制器。状态机：idle → preparing → recording → transcribing → finish/error。
 * 取消 / 切对话 / 页面隐藏：停轨道 + abort，**不发转写请求**。
 */
export class VoiceInputController {
	private state: VoiceState = "idle";
	private stream: MediaStream | null = null;
	private capture: VoiceCaptureHandle | null = null;
	private chunks: Float32Array[] = [];
	private opts: VoiceStartOptions | null = null;
	private timer: unknown;
	private abort: AbortController | null = null;

	constructor(
		private deps: VoiceControllerDeps,
		private events: VoiceEvents = {},
	) {}

	getState(): VoiceState {
		return this.state;
	}

	private set(s: VoiceState) {
		this.state = s;
		this.events.onState?.(s);
	}

	/** 是否正在录音 / 准备中（UI 据此显示停止 / 取消）。 */
	isActive(): boolean {
		return this.state === "preparing" || this.state === "recording";
	}

	async start(opts: VoiceStartOptions): Promise<void> {
		if (this.isActive() || this.state === "transcribing") return;
		this.opts = opts;
		this.chunks = [];
		this.set("preparing");
		let stream: MediaStream;
		try {
			stream = await this.deps.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		} catch (e) {
			this.set("error");
			this.events.onError?.(voiceErrorFrom(e));
			return;
		}
		// 拿权限期间被取消 / 页面已隐藏：立刻释放，不进录音态
		if (this.state !== "preparing") {
			for (const t of stream.getTracks()) t.stop();
			return;
		}
		this.stream = stream;
		try {
			this.capture = await this.deps.startCapture(stream, (c) => this.chunks.push(c));
		} catch (e) {
			this.releaseStream();
			this.set("error");
			this.events.onError?.(voiceErrorFrom(e));
			return;
		}
		this.set("recording");
		const max = this.deps.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
		const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.timer = setTimer(() => void this.stop(), max);
	}

	/** 停止并转写（用户点停止 / 到达最长时长）。 */
	async stop(): Promise<void> {
		if (this.state !== "recording" || !this.opts) return;
		const clearTimer = this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
		clearTimer(this.timer);
		const sampleRate = this.capture?.sampleRate ?? TARGET_SAMPLE_RATE;
		this.capture?.stop();
		this.capture = null;
		this.releaseStream();
		const chunks = this.chunks;
		this.chunks = [];
		const opts = this.opts;
		this.set("transcribing");
		const pcm = pcm16FromFloat32(resampleTo16k(concatFloat32(chunks), sampleRate));
		const audio = encodeWav16(pcm, TARGET_SAMPLE_RATE);
		const requestId = (this.deps.createRequestId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`))();
		this.abort = new AbortController();
		this.events.onRequest?.(requestId);
		try {
			const out = await this.deps.transcribe({ audio, requestId, provider: opts.provider, model: opts.model, language: opts.language, signal: this.abort.signal });
			if (this.abort.signal.aborted) return; // 已取消：丢弃结果
			this.opts = null;
			this.set("finish");
			this.events.onResult?.({ text: out.text, requestId, anchor: opts.anchor, agentId: opts.agentId, conversationId: opts.conversationId });
			this.set("idle");
		} catch (e) {
			if (this.abort?.signal.aborted) return;
			this.opts = null;
			this.set("error");
			this.events.onError?.(voiceErrorFrom(e));
		} finally {
			this.abort = null;
		}
	}

	/** 取消：丢弃录音，**不发起 / 不等待转写请求**；草稿与引用不动。 */
	cancel(): void {
		if (this.state === "idle" || this.state === "finish") return;
		const clearTimer = this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
		clearTimer(this.timer);
		this.capture?.stop();
		this.capture = null;
		this.releaseStream();
		this.chunks = [];
		this.abort?.abort();
		this.abort = null;
		this.opts = null;
		this.set("idle");
	}

	/** 页面隐藏 / 切后台 / 切对话：停轨道 + 取消（不发送）。 */
	onHidden(): void {
		if (this.isActive()) this.cancel();
	}

	private releaseStream(): void {
		if (this.stream) for (const t of this.stream.getTracks()) t.stop();
		this.stream = null;
	}
}
