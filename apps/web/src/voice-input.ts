/**
 * 语音输入（输入栏语音→文字草稿）的**纯逻辑**：状态机、WAV 组包、真实重采样、音量、分段增量、
 * 草稿锚点插入、能力/错误映射。
 *
 * 这里不 import React、不直接碰 `navigator` / `AudioContext`（全部依赖注入），
 * 因此可以在 Node 里用假 getUserMedia / 假 provider 单测（见 packages/server/test/voice-input.test.ts、
 * voice-incremental.test.ts）。真实浏览器管线在 `hooks/useVoiceInput.ts`，UI 在 `components/VoiceInput.tsx`。
 *
 * 关键约束（docs/design/voice-input.md）：
 *  - **不假 16000**：AudioContext 的 sampleRate 是请求值，实际不等于 16000 时必须真重采样；
 *  - **不假波形**：录音时展示的音量来自真实 PCM RMS / peak（平滑 + 限频），静音近零；
 *  - **分段增量不是原生流式**：SenseVoice / Paraformer / Whisper 的 sherpa OfflineRecognizer 都**不是**流式，
 *    这里按「停顿 VAD + 最长窗口」把录音切成**有界**的若干段，逐段走既有批量转写接口；
 *    **不换用户所选模型、不改云端计费行为**（云端保持整段一次请求，见下）；
 *  - **不丢尾部**：停止时 flush 尾段；处理跟不上时把语音并进当前段（不合段），不静默丢音频；
 *  - **取消 = 不发起 / 丢弃未应用结果**；切对话 / 页面隐藏 → 停轨道 + 取消，**不发送**；
 *  - **结果只插草稿**，插在开始录制时的锚点并保持段序，**保留用户后续编辑**；**不自动发送**；
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
	if (message.includes("asr_busy")) return { code: "asr_busy", message: "语音识别正忙，请稍后重试" };
	if (message.includes("asr_timeout")) return { code: "asr_timeout", message: "语音转写超时，请重试" };
	if (message.includes("asr_too_large")) return { code: "asr_too_large", message: "录音太长了，请短一点" };
	if (name === "ApiError" || /网络|fetch|Failed to fetch|NetworkError/i.test(message)) return { code: "network", message: "网络异常，请重试" };
	return { code: "unknown", message: message || "语音输入失败，请重试" };
}

// ------------------------------------------------------------------ 音量（真实 PCM，不假循环波形）
export interface LevelSample {
	rms: number;
	peak: number;
}

/** 一段原始 PCM 的真实 RMS / 峰值（未做任何伪装）。 */
export function computeLevel(chunk: Float32Array): LevelSample {
	if (chunk.length === 0) return { rms: 0, peak: 0 };
	let sum = 0;
	let peak = 0;
	for (let i = 0; i < chunk.length; i++) {
		const s = chunk[i];
		sum += s * s;
		const a = Math.abs(s);
		if (a > peak) peak = a;
	}
	return { rms: Math.sqrt(sum / chunk.length), peak };
}

/** 低于这个 RMS 视为静音（近零）；与环境噪声一起决定分段。 */
export const VOICE_SILENCE_RMS = 0.012;

/** 把 RMS 归一化到 0..1（对数刻度，静音严格 0，不产生「假跳动」）。 */
export function normalizeLevel(rms: number, floor = VOICE_SILENCE_RMS): number {
	if (!(rms > floor)) return 0;
	const db = 20 * Math.log10(rms);
	const floorDb = 20 * Math.log10(floor);
	const span = -floorDb + 6; // 到约 +6 dB 满刻度
	return Math.max(0, Math.min(1, (db - floorDb) / span));
}

/**
 * 音量计：指数平滑（attack / release）+ 限频（默认 80ms 才回报一次）。
 * 只回传**真实采集**的音量；静音时平滑收敛到 0。
 */
export class LevelMeter {
	private level = 0;
	private last = Number.NEGATIVE_INFINITY;
	constructor(private opts: { minIntervalMs?: number; attack?: number; release?: number; now?: () => number } = {}) {}

	/** 喂入原始分片；未到回报间隔返回 null（UI 不更新），否则返回当前归一化音量。 */
	push(chunk: Float32Array, now = (this.opts.now ?? Date.now)()): number | null {
		const target = normalizeLevel(computeLevel(chunk).rms);
		const k = target > this.level ? (this.opts.attack ?? 0.55) : (this.opts.release ?? 0.2);
		this.level += (target - this.level) * k;
		if (target === 0 && this.level < 1e-3) this.level = 0; // 静音真的归零（不残留假跳动）
		if (now - this.last < (this.opts.minIntervalMs ?? 80)) return null;
		this.last = now;
		return this.level;
	}

	get(): number {
		return this.level;
	}

	reset(): void {
		this.level = 0;
		this.last = Number.NEGATIVE_INFINITY;
	}
}

// ------------------------------------------------------------------ 音频
/**
 * 线性插值重采样（真实计算，不假装 16000）。
 * `inputRate === targetRate` 时原样返回（不重复处理）。
 */
export function resampleTo16k(input: Float32Array, inputRate: number, targetRate = TARGET_SAMPLE_RATE): Float32Array {
	if (inputRate === targetRate || input.length === 0) return input;
	return resampleTo16kRange(input, inputRate, 0, input.length, targetRate);
}

/**
 * 把原始采样的一段 `[startIn, endIn)` 重采样到 16k。
 * **关键**：输出采样点按**全局**位置计算（`j * inputRate / targetRate`），所以相邻段的输出区间首尾相接，
 * 拼起来等于整段一次重采样——**不制造 gap、不重复、不随段数漂移**。
 */
export function resampleTo16kRange(input: Float32Array, inputRate: number, startIn: number, endIn: number, targetRate = TARGET_SAMPLE_RATE): Float32Array {
	const a = Math.max(0, Math.min(startIn, input.length));
	const b = Math.max(a, Math.min(endIn, input.length));
	if (a === b) return new Float32Array(0);
	if (inputRate === targetRate) return input.slice(a, b);
	const ratio = inputRate / targetRate;
	const outStart = Math.ceil(a / ratio);
	const outEnd = Math.ceil(b / ratio);
	const outLen = Math.max(0, outEnd - outStart);
	const out = new Float32Array(outLen);
	for (let k = 0; k < outLen; k++) {
		const pos = (outStart + k) * ratio;
		const i0 = Math.min(Math.max(0, Math.floor(pos)), input.length - 1);
		const i1 = Math.min(i0 + 1, input.length - 1);
		const t = Math.min(1, Math.max(0, pos - i0));
		out[k] = input[i0] * (1 - t) + input[i1] * t;
	}
	return out;
}

/** 把一段原始采样重采样成 16k PCM16（分段转写用；连续、不制造 gap）。 */
export function segmentToPcm16(input: Float32Array, inputRate: number, startIn: number, endIn: number, targetRate = TARGET_SAMPLE_RATE): Int16Array {
	return pcm16FromFloat32(resampleTo16kRange(input, inputRate, startIn, endIn, targetRate));
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

// ------------------------------------------------------------------ 分段（停顿 VAD + 最长窗口）
export interface SpeechSegmentRange {
	/** 原始采样里的起点（含） */
	startIn: number;
	/** 原始采样里的终点（不含） */
	endIn: number;
	hasSpeech: boolean;
}

export interface SegmenterOptions {
	/** 一帧长度（默认 20ms），用于 RMS 判定 */
	frameMs?: number;
	/** 连续静音多久算一段结束（默认 700ms） */
	silenceMs?: number;
	/** 单段最长（默认 12s），避免模型一次吃太长 */
	maxSegmentMs?: number;
	/** 硬上限（默认 55s）：积压「不合段」时也不允许超过它，保证单段始终 ≤ 服务端 60s 时长上限；切段不丢音频 */
	hardMaxSegmentMs?: number;
	/** 一段至少多久才单独成段（默认 300ms），更短的并进下一段 */
	minSegmentMs?: number;
	/** 静音阈值（默认 VOICE_SILENCE_RMS） */
	threshold?: number;
}

/**
 * 停顿分段器：只做**边界判断**（在原始采样坐标上），不做重采样。
 * 静音够久且段内有语音 → 合一段；段长到上限 → 强制合一段。
 * `setBackpressure(true)` 时**不合段**（把后续语音并进当前段），避免慢模型积压时丢音频；
 * 总时长由录音上限（60s）兜底，内存有界。
 */
export class SpeechSegmenter {
	private pos = 0;
	private segStart: number | null = null;
	private speechSeen = false;
	private silenceSamples = 0;
	private sumSq = 0;
	private frameCount = 0;
	private backpressure = false;

	constructor(
		private inputRate: number,
		private opts: SegmenterOptions = {},
	) {}

	setBackpressure(v: boolean): void {
		this.backpressure = v;
	}

	isBackpressured(): boolean {
		return this.backpressure;
	}

	private frameSize(): number {
		return Math.max(1, Math.round((this.inputRate * (this.opts.frameMs ?? 20)) / 1000));
	}
	private threshold(): number {
		return this.opts.threshold ?? VOICE_SILENCE_RMS;
	}
	private samplesOf(ms: number): number {
		return Math.round((this.inputRate * ms) / 1000);
	}

	/** 喂入原始分片；返回本批合上的段（可能为空）。 */
	push(chunk: Float32Array): SpeechSegmentRange[] {
		const out: SpeechSegmentRange[] = [];
		const fs = this.frameSize();
		for (let i = 0; i < chunk.length; i++) {
			const s = chunk[i];
			this.sumSq += s * s;
			this.frameCount++;
			this.pos++;
			if (this.frameCount >= fs) {
				this.frameEnd(Math.sqrt(this.sumSq / this.frameCount), out);
				this.sumSq = 0;
				this.frameCount = 0;
			}
		}
		return out;
	}

	private frameEnd(rms: number, out: SpeechSegmentRange[]): void {
		const fs = this.frameSize();
		const speaking = rms >= this.threshold();
		if (speaking) {
			if (this.segStart === null) this.segStart = this.pos - fs;
			this.speechSeen = true;
			this.silenceSamples = 0;
		} else if (this.segStart !== null) {
			this.silenceSamples += fs;
		}
		if (this.segStart === null) return;
		const length = this.pos - this.segStart;
		// 硬上限：**即使积压也必须切段**。否则积压期间当前段可一路长到录音 60s 上限，
		// 与 server `ASR_MAX_DURATION_MS`（60s，`> 60s` 才拒）擦边，一旦数据分片让 pos 略微越界，
		// 整段请求会被 400 拒绝、尾段丢字。切段只是把余下语音放进下一段，**不丢音频**。
		if (length >= this.samplesOf(this.opts.hardMaxSegmentMs ?? 55_000)) {
			if (this.speechSeen) out.push({ startIn: this.segStart, endIn: this.pos, hasSpeech: true });
			this.segStart = null;
			this.speechSeen = false;
			this.silenceSamples = 0;
			return;
		}
		// 积压：把语音并进当前段（不合段），不丢音频
		if (this.backpressure) return;
		if (this.speechSeen && this.silenceSamples >= this.samplesOf(this.opts.silenceMs ?? 700) && length >= this.samplesOf(this.opts.minSegmentMs ?? 300)) {
			const endIn = Math.min(this.pos, Math.max(this.segStart + this.samplesOf(this.opts.minSegmentMs ?? 300), this.pos - this.silenceSamples + this.samplesOf(120)));
			out.push({ startIn: this.segStart, endIn, hasSpeech: true });
			this.segStart = null;
			this.speechSeen = false;
			this.silenceSamples = 0;
			return;
		}
		if (length >= this.samplesOf(this.opts.maxSegmentMs ?? 12_000)) {
			if (this.speechSeen) out.push({ startIn: this.segStart, endIn: this.pos, hasSpeech: true });
			this.segStart = null;
			this.speechSeen = false;
			this.silenceSamples = 0;
		}
	}

	/**
	 * 停止时收尾：返回最后一段（含尾部静音）。
	 * 纯静音且过短 → null（没有内容可丢）；段内有语音 → 即使短也要转，**不丢尾部**。
	 */
	flush(): SpeechSegmentRange | null {
		if (this.segStart === null) return null;
		const length = this.pos - this.segStart;
		const hasSpeech = this.speechSeen;
		const range: SpeechSegmentRange = { startIn: this.segStart, endIn: this.pos, hasSpeech };
		this.segStart = null;
		this.speechSeen = false;
		this.silenceSamples = 0;
		if (!hasSpeech && length < this.samplesOf(this.opts.minSegmentMs ?? 300)) return null;
		return range;
	}
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

/** 英文 / 数字之间需要空格，CJK 之间不插空格（避免「你好 世界」）。 */
export function needsSeparator(prevChar: string | undefined, nextChar: string | undefined): boolean {
	if (!prevChar || !nextChar) return false;
	const latin = (c: string) => /[A-Za-z0-9]/.test(c);
	return latin(prevChar) && latin(nextChar);
}

/** 把多段文本拼成一段（英文补空格，中文直接接；空段丢弃）。 */
export function smartJoin(parts: string[]): string {
	let out = "";
	for (const raw of parts) {
		const t = raw.trim();
		if (!t) continue;
		if (!out) {
			out = t;
			continue;
		}
		out += needsSeparator(out[out.length - 1], t[0]) ? ` ${t}` : t;
	}
	return out;
}

/**
 * 用户编辑后把光标位置映射到新文本（用于「段序不错乱」）。
 * 取公共前缀 `p` 与公共后缀 `s`：位置在替换区之前不动、之后整体平移、落在替换区内则落到替换区末尾。
 */
export function mapPositionThroughEdit(prev: string, next: string, pos: number): number {
	if (prev === next) return pos;
	const maxP = Math.min(prev.length, next.length);
	let p = 0;
	while (p < maxP && prev[p] === next[p]) p++;
	const maxS = Math.min(prev.length - p, next.length - p);
	let s = 0;
	while (s < maxS && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
	const prevSuffixStart = prev.length - s;
	if (pos <= p) return pos;
	if (pos >= prevSuffixStart) return pos + (next.length - prev.length);
	return next.length - s;
}

/**
 * 增量草稿装配器：把**按序到达**的已确认段追加到录制锚点之后，
 * 同时保留用户在别处的编辑；光标随编辑平移，下一段永远接在语音块末尾（不重复、不乱序）。
 */
export class VoiceDraftAssembler {
	private pos: number;
	private last: string | null;

	constructor(anchor: number, initialText = "") {
		this.pos = anchor;
		this.last = initialText;
	}

	get cursor(): number {
		return this.pos;
	}

	/** 用最新草稿文本同步光标（用户编辑不影响已插入语音的顺序）。 */
	sync(value: string): void {
		if (this.last === null) {
			this.last = value;
			return;
		}
		if (this.last === value) return;
		this.pos = mapPositionThroughEdit(this.last, value, this.pos);
		this.last = value;
	}

	/** 追加一段已确认文本；返回新文本与光标。 */
	append(value: string, segment: string): { text: string; cursor: number } {
		this.sync(value);
		const at = Math.max(0, Math.min(this.pos, value.length));
		const sep = needsSeparator(value[at - 1], segment[0]) ? " " : "";
		const insert = sep + segment;
		const text = value.slice(0, at) + insert + value.slice(at);
		this.pos = at + insert.length;
		this.last = text;
		return { text, cursor: this.pos };
	}
}

// ------------------------------------------------------------------ 录音租约（本地 ASR）
export interface AsrLeaseDeps {
	acquire: (provider: string, model: string) => Promise<string | null>;
	release: (leaseId: string) => void | Promise<void>;
}

/**
 * 本地 ASR 录音租约：录音 / 重试期间持有，避免本地模型被 idle（默认 90s）卸载。
 *
 *  - `begin` 并发调用（极快重复点击 / 重试与录音重叠）只保留**最新**一次，旧 id 立即释放，
 *    否则旧 leaseId 丢失、服务端租约计数不归零，本地模型永远无法 idle 卸载；
 *  - `acquire` 是异步的，回调只读写**本次创建**的 entry，不用「当前对象」引用，避免串号；
 *  - `end` 幂等；已释放后 acquire 才 resolve 的 id 也会被回收。
 */
export class AsrLeaseManager {
	private cur: { id: string | null; cancelled: boolean } = { id: null, cancelled: false };

	constructor(private deps: AsrLeaseDeps) {}

	begin(provider: string, model: string): void {
		const prev = this.cur;
		prev.cancelled = true;
		if (prev.id) {
			void this.deps.release(prev.id);
			prev.id = null;
		}
		const entry = { id: null as string | null, cancelled: false };
		this.cur = entry;
		void this.deps.acquire(provider, model).then((id) => {
			if (entry.cancelled || this.cur !== entry) {
				if (id) void this.deps.release(id);
				return;
			}
			entry.id = id;
		});
	}

	end(): void {
		const cur = this.cur;
		cur.cancelled = true;
		if (cur.id) {
			void this.deps.release(cur.id);
			cur.id = null;
		}
	}

	/** 当前持有的租约 id（测试用）。 */
	get id(): string | null {
		return this.cur.id;
	}
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
	/**
	 * 分段增量（本地 ASR 用；云端保持整段一次请求，避免每个分段都算一次最小计费）。
	 * 缺省 false = 旧的整段批量行为。
	 */
	incremental?: boolean;
}

export interface VoiceResult {
	text: string;
	requestId: string;
	anchor: number;
	agentId?: string;
	conversationId?: string;
}

/** 一段已确认的增量转写结果（按 index 有序）。 */
export interface VoiceSegment {
	text: string;
	index: number;
	requestId: string;
	anchor: number;
	agentId?: string;
	conversationId?: string;
}

export interface VoiceProgress {
	/** 等待转写的段数 */
	pending: number;
	/** 正在转写的段（0 / 1） */
	inflight: number;
	/** 已失败的段数 */
	failed: number;
	/** 是否因为转写跟不上而合段（继续录音、不丢音频） */
	backlog: boolean;
	/** 前面有失败段时，已成功但因**保序**暂缓显示、等重试成功后按原序补上的段数 */
	held: number;
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
	/** 重试等待（默认 setTimeout）；测试可注入。 */
	sleep?: (ms: number) => Promise<void>;
	/** 每段最多重试次数（默认 3）。 */
	maxSegmentRetries?: number;
}

export interface VoiceEvents {
	onState?: (s: VoiceState) => void;
	/** 整段批量结果（非增量模式）。 */
	onResult?: (r: VoiceResult) => void;
	/** 增量模式下每段确认后回调（按 index 有序）。 */
	onSegment?: (s: VoiceSegment) => void;
	onError?: (e: VoiceError) => void;
	/** 转写请求已发出（用于测试「取消 0 次 / 停止 1 次」）。 */
	onRequest?: (requestId: string) => void;
	/** 真实音量（0..1，已平滑限频）。 */
	onLevel?: (level: number) => void;
	/** 分段进度（等待 / 在途 / 失败 / 是否积压）。 */
	onProgress?: (p: VoiceProgress) => void;
	/** 增量模式下一句话都没识别到（不是错误，UI 给一句提示）。 */
	onNoSpeech?: () => void;
}

/** 有界的等待队列上限：到上限就合段（不合新段），避免慢模型无限积压。 */
export const MAX_PENDING_SEGMENTS = 2;
/** 段重试退避（毫秒）；只在「本段」上有界重试，绝不整段重传。 */
export const SEGMENT_RETRY_DELAYS = [400, 1200, 2400];
/** 会被重试的错误码（本地模型冷启动 / 忙 / 网络抖动；配置类错误不重试）。 */
const RETRYABLE_CODES = new Set(["asr_busy", "asr_timeout", "asr_upstream_error", "network", "unknown", "asr_not_configured"]);
/** 太短的分段不单独发请求（<80ms 的 16k PCM 基本是静音残留）。 */
const MIN_SEGMENT_PCM_SAMPLES = Math.round((TARGET_SAMPLE_RATE * 80) / 1000);

interface SegmentTask {
	index: number;
	requestId: string;
	pcm: Int16Array;
}

/**
 * 录音 → 转写控制器。状态机：idle → preparing → recording → transcribing → finish/error。
 * 取消 / 切对话 / 页面隐藏：停轨道 + abort，**不发转写请求 / 丢弃未应用结果**。
 *
 * 增量模式（`incremental:true`，本地 ASR）：边说边分段转写，最多 1 个在途、等待队列有界；
 * 停止时 flush 尾段并只等「在途 + 尾段」，**不整段重传**。
 */
export class VoiceInputController {
	private state: VoiceState = "idle";
	private stream: MediaStream | null = null;
	private capture: VoiceCaptureHandle | null = null;
	private chunks: Float32Array[] = [];
	private opts: VoiceStartOptions | null = null;
	private timer: unknown;
	private abort: AbortController | null = null;

	// 增量状态
	private sampleRate: number | null = null;
	private segmenter: SpeechSegmenter | null = null;
	private meter = new LevelMeter();
	private raw: Float32Array[] = [];
	private rawCache: Float32Array | null = null;
	private pendingSeg: Float32Array[] = [];
	private waiting: SegmentTask[] = [];
	private inflight: SegmentTask | null = null;
	private failedTasks: SegmentTask[] = [];
	private segIndex = 0;
	/** 下一个应进入草稿的段 index（按语音原序发射）。 */
	private nextEmitIndex = 0;
	/** 已成功但因前面有失败段而暂缓发射的段（index → 结果）。 */
	private held = new Map<number, VoiceSegment>();
	private runAbort: AbortController | null = null;
	private gen = 0;
	private drainWaiters: (() => void)[] = [];

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

	/** 增量进度（供 UI 显示「还有几段」）。 */
	progress(): VoiceProgress {
		return {
			pending: this.waiting.length,
			inflight: this.inflight ? 1 : 0,
			failed: this.failedTasks.length,
			backlog: this.segmenter?.isBackpressured() ?? false,
			held: this.held.size,
		};
	}

	async start(opts: VoiceStartOptions): Promise<void> {
		if (this.isActive() || this.state === "transcribing") return;
		this.resetRun();
		this.gen++;
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
			this.capture = await this.deps.startCapture(stream, (c) => this.onData(c));
		} catch (e) {
			this.releaseStream();
			this.set("error");
			this.events.onError?.(voiceErrorFrom(e));
			return;
		}
		// 打开采集期间可能已被取消（页面隐藏 / 切会话 / 换来源 / 卸载）：不能再进录音态，
		// 否则会「复活」一个已取消、轨道已停的会话并卡在 recording（且 60s 定时器已被取消清掉）。
		if (this.state !== "preparing") {
			this.capture.stop();
			this.capture = null;
			this.releaseStream();
			return;
		}
		// 采集已就绪：初始化分段器，把之前同步收到的分片补喂一遍
		this.sampleRate = this.capture.sampleRate;
		if (this.opts.incremental) {
			this.segmenter = new SpeechSegmenter(this.sampleRate);
			const buffered = this.pendingSeg;
			this.pendingSeg = [];
			for (const c of buffered) this.feedSegmenter(c);
		}
		this.set("recording");
		const max = this.deps.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
		const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.timer = setTimer(() => void this.stop(), max);
	}

	private onData(chunk: Float32Array): void {
		if (!chunk.length) return;
		// 批量模式：沿用旧的整段拼接；增量模式改用 raw（分段按原始坐标切）
		if (!this.opts?.incremental) this.chunks.push(chunk);
		// 真实音量（两种模式都显示）
		const lvl = this.meter.push(chunk);
		if (lvl !== null) this.events.onLevel?.(lvl);
		if (!this.opts?.incremental) return;
		if (!this.segmenter) {
			this.pendingSeg.push(chunk);
			return;
		}
		this.feedSegmenter(chunk);
	}

	private feedSegmenter(chunk: Float32Array): void {
		this.raw.push(chunk);
		this.rawCache = null;
		for (const range of this.segmenter!.push(chunk)) this.enqueueRange(range);
	}

	private rawBuffer(): Float32Array {
		if (!this.rawCache) this.rawCache = concatFloat32(this.raw);
		return this.rawCache;
	}

	private enqueueRange(range: SpeechSegmentRange): void {
		if (!this.sampleRate) return;
		const pcm = segmentToPcm16(this.rawBuffer(), this.sampleRate, range.startIn, range.endIn);
		if (pcm.length < MIN_SEGMENT_PCM_SAMPLES) return; // 静音残留：不发请求
		this.waiting.push({ index: this.segIndex++, requestId: this.newRequestId(), pcm });
		this.syncBackpressure();
		void this.pump();
	}

	private syncBackpressure(): void {
		const backlog = this.waiting.length + (this.inflight ? 1 : 0);
		this.segmenter?.setBackpressure(backlog >= MAX_PENDING_SEGMENTS);
		this.events.onProgress?.(this.progress());
	}

	private newRequestId(): string {
		return (this.deps.createRequestId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`))();
	}

	private get sleep(): (ms: number) => Promise<void> {
		return this.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	/**
	 * 按 index 保序发射：只有「下一个应发的段」才立刻进草稿；若前面有失败段，
	 * 后续成功段先放进 held，等失败段重试成功后**按语音原序**一次补上（不乱序、不丢文本）。
	 */
	private emitOrdered(seg: VoiceSegment): void {
		if (seg.index !== this.nextEmitIndex) {
			this.held.set(seg.index, seg);
			return;
		}
		this.events.onSegment?.(seg);
		this.nextEmitIndex = seg.index + 1;
		for (let next = this.held.get(this.nextEmitIndex); next; next = this.held.get(this.nextEmitIndex)) {
			this.held.delete(this.nextEmitIndex);
			this.events.onSegment?.(next);
			this.nextEmitIndex++;
		}
	}

	/** 单并发地转写等待队列；每段唯一 requestId，重试只针对本段。 */
	private async pump(): Promise<void> {
		if (this.inflight || this.waiting.length === 0 || !this.opts) return;
		const gen = this.gen;
		const task = this.waiting.shift()!;
		const opts = this.opts;
		this.inflight = task;
		this.syncBackpressure();
		const audio = encodeWav16(task.pcm, TARGET_SAMPLE_RATE);
		const maxRetries = this.deps.maxSegmentRetries ?? SEGMENT_RETRY_DELAYS.length;
		this.events.onRequest?.(task.requestId);
		let attempt = 0;
		for (;;) {
			this.runAbort = new AbortController();
			try {
				const out = await this.deps.transcribe({ audio, requestId: task.requestId, provider: opts.provider, model: opts.model, language: opts.language, signal: this.runAbort.signal });
				if (gen !== this.gen) return;
				this.inflight = null;
				this.runAbort = null;
				this.emitOrdered({ text: out.text, index: task.index, requestId: task.requestId, anchor: opts.anchor, agentId: opts.agentId, conversationId: opts.conversationId });
				break;
			} catch (e) {
				if (gen !== this.gen || this.runAbort?.signal.aborted) {
					this.inflight = null;
					this.runAbort = null;
					return;
				}
				const err = voiceErrorFrom(e);
				this.runAbort = null;
				if (attempt < maxRetries && RETRYABLE_CODES.has(err.code)) {
					await this.sleep(SEGMENT_RETRY_DELAYS[Math.min(attempt, SEGMENT_RETRY_DELAYS.length - 1)]);
					if (gen !== this.gen) {
						this.inflight = null;
						return;
					}
					attempt++;
					continue;
				}
				this.inflight = null;
				this.failedTasks.push(task);
				// 后续成功段不会提前进草稿（保序）；提示里说明「后面 N 段已识别、重试后按顺序补上」。
				const heldNote = this.held.size ? `，后面 ${this.held.size} 段已识别、重试后按顺序补上` : "，已保留可重试";
				this.events.onError?.({ code: "asr_segment_failed", message: `有一段没转写成功（${err.message}）${heldNote}` });
				break;
			}
		}
		this.syncBackpressure();
		if (!this.inflight && this.waiting.length === 0) this.resolveDrain();
		void this.pump();
	}

	/** 停止并转写（用户点停止 / 到达最长时长）。 */
	async stop(): Promise<void> {
		if (this.state !== "recording" || !this.opts) return;
		const gen = this.gen;
		const clearTimer = this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
		clearTimer(this.timer);
		const opts = this.opts;
		this.capture?.stop();
		this.capture = null;
		this.releaseStream();

		if (opts.incremental) {
			// flush 尾段（不丢尾部）；只等在途 + 尾段，不整段重传
			const tail = this.segmenter?.flush() ?? null;
			if (tail) this.enqueueRange(tail);
			this.set("transcribing");
			await this.drain(gen);
			if (gen !== this.gen) return;
			if (this.segIndex === 0 && this.failedTasks.length === 0) this.events.onNoSpeech?.();
			this.set("finish");
			this.set("idle");
			// 保留 failedTasks 供「重试本段」；其余缓冲清空
			this.clearBuffers(true);
			return;
		}

		const sampleRate = this.sampleRate ?? TARGET_SAMPLE_RATE;
		const chunks = this.chunks;
		this.chunks = [];
		this.set("transcribing");
		const pcm = pcm16FromFloat32(resampleTo16k(concatFloat32(chunks), sampleRate));
		const audio = encodeWav16(pcm, TARGET_SAMPLE_RATE);
		const requestId = this.newRequestId();
		// 用局部 abort 引用：取消会同时 abort 并置空 this.abort；若在 await 之后继续读 this.abort 会拿到 null
		// （取消在途的云端整段请求时抛 TypeError 被 catch 当成失败，把状态写成 error）。取消后旧返回一律不写。
		const abort = new AbortController();
		this.abort = abort;
		this.events.onRequest?.(requestId);
		try {
			const out = await this.deps.transcribe({ audio, requestId, provider: opts.provider, model: opts.model, language: opts.language, signal: abort.signal });
			if (abort.signal.aborted) return;
			this.opts = null;
			this.set("finish");
			this.events.onResult?.({ text: out.text, requestId, anchor: opts.anchor, agentId: opts.agentId, conversationId: opts.conversationId });
			this.set("idle");
		} catch (e) {
			if (abort.signal.aborted) return;
			this.opts = null;
			this.set("error");
			this.events.onError?.(voiceErrorFrom(e));
		} finally {
			if (this.abort === abort) this.abort = null;
		}
	}

	/** 等「在途 + 等待队列」清空（增量停止用）。 */
	private drain(gen: number): Promise<void> {
		if (gen !== this.gen) return Promise.resolve();
		if (!this.inflight && this.waiting.length === 0) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.drainWaiters.push(resolve);
		});
	}

	private resolveDrain(): void {
		const waiters = this.drainWaiters;
		this.drainWaiters = [];
		for (const w of waiters) w();
	}

	/** 有界重试：只重发**失败的那几段**（已完成的绝不重传，避免重复计费）。 */
	async retryFailed(): Promise<void> {
		if (!this.failedTasks.length) return;
		// 按 index 升序重试：先补前面的空洞，成功一个就顺带把 held 里连续的后续段按原序补上。
		const retry = [...this.failedTasks].sort((a, b) => a.index - b.index);
		this.waiting.unshift(...retry);
		this.failedTasks = [];
		this.set("transcribing");
		this.syncBackpressure();
		void this.pump();
		await this.drain(this.gen);
		if (this.state === "transcribing") {
			this.set("finish");
			this.set("idle");
		}
		// 重试后仍失败的段保留在失败列表（可再次重试），只清音频缓冲
		this.clearBuffers(true);
	}

	/** 取消：丢弃录音与未应用结果，**不发起 / 不等待转写请求**；草稿与引用不动。 */
	cancel(): void {
		if (this.state === "idle" || this.state === "finish") return;
		this.gen++;
		const clearTimer = this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
		clearTimer(this.timer);
		this.capture?.stop();
		this.capture = null;
		this.releaseStream();
		this.abort?.abort();
		this.abort = null;
		this.runAbort?.abort();
		this.runAbort = null;
		this.opts = null;
		this.resetRun();
		this.resolveDrain();
		this.set("idle");
	}

	/** 页面隐藏 / 切后台 / 切对话：停轨道 + 取消（不发送）。 */
	onHidden(): void {
		if (this.isActive()) this.cancel();
	}

	private resetRun(): void {
		this.clearBuffers(false);
	}

	/** 清空本次录音的缓冲；`keepFailed` 时保留失败段（供「重试本段」）。 */
	private clearBuffers(keepFailed: boolean): void {
		this.chunks = [];
		this.sampleRate = null;
		this.segmenter = null;
		this.raw = [];
		this.rawCache = null;
		this.pendingSeg = [];
		this.waiting = [];
		this.inflight = null;
		if (!keepFailed) {
			this.failedTasks = [];
			// 保序状态随失败段一起清掉；保留失败段时必须保留 held / nextEmitIndex，重试才能按原序补上。
			this.held.clear();
			this.nextEmitIndex = 0;
		}
		this.segIndex = 0;
		this.meter.reset();
		this.events.onProgress?.({ pending: 0, inflight: 0, failed: this.failedTasks.length, backlog: false, held: this.held.size });
	}

	private releaseStream(): void {
		if (this.stream) for (const t of this.stream.getTracks()) t.stop();
		this.stream = null;
	}
}
