/**
 * 原生流式本地语音的**纯逻辑层**（不 import React、不碰 `navigator` / `AudioContext` / `fetch`）：
 * 线协议事件归一化、句段模型（committed / tentative，server-authoritative）、有界分片器、流式重采样、会话控制器。
 *
 * 与既有 `voice-input.ts` 的边界（重要）：
 *  - `voice-input.ts` 的 `VoiceInputController`（整段批量 + 停顿分段增量）**保持原样、不回归**；
 *  - 原生流式是**同一套采集 / 音量 / 租约**上的另一条发送路径：采集仍是 16 kHz PCM，
 *    音量仍是 `LevelMeter` 的真实 RMS，**不另造第二套音频引擎、不另立来源状态**；
 *  - 线协议的 HTTP 细节（路径 / 头 / chunked）在 `api.ts` 的 `openAsrStream` 实现；这里只定义
 *    **会话层接口**（`VoiceStreamOpen` / `VoiceStreamTransport`）与**纯归一化 / 模型**，便于单测。
 *
 * 契约（`docs/design/default-stream-contract.md`，已冻结）：
 *  - **只有** `options[].streaming === true && options[].protocol === "asr-stream-v1" && options[].streamProtocol === "asr-stream-v1"`
 *    才走流式；否则回落既有 batch，**不凭名字猜**（判定在 `api.ts` 的 `isStreamingSource`）。
 *  - 事件语义（server-authoritative per-segment，**前端不得再算一套最长公共前缀**）：
 *      `committed` = 该段当前**完整**稳定前缀（绝对量，只增不回退）；
 *      `tentative` = 该段**剩余部分的完整文本**（绝对量，整体替换，不是 suffix 拼接、不是整句）；
 *      展示文本恒为 `committed + tentative`；`final` = 该段**完整文本**（绝对量），之后该段不再有事件。
 *  - `segmentId` 段号（`endpoint` 后 +1，新段属于新 segmentId）；`seq` 为该批 append 的序号。
 *  - **有界**：append 串行（`maxInflight = 1`）、帧 ≤ `maxChunkBytes`、单会话 ≤ `maxSessionMs`（60 s）、
 *    慢后端只让分片器缓冲增长（受录音上限约束），**不无限排队**；`stop` 只 flush 尾片 + `finish`，不整段重识别；
 *    `cancel` / 页面隐藏 / 来源变更都停轨道 + abort，**失败保留已确认文本、不自动重发旧音频、不自动发送**。
 */

import {
	DEFAULT_MAX_DURATION_MS,
	LevelMeter,
	TARGET_SAMPLE_RATE,
	pcm16FromFloat32,
	concatFloat32,
	voiceErrorFrom,
	type VoiceCaptureHandle,
	type VoiceError,
	type VoiceProgress,
	type VoiceSegment,
	type VoiceStartOptions,
	type VoiceState,
} from "./voice-input.ts";

/** append 分片的目标时长：正常 200–400 ms（既不 100 ms 空转，也不攒成整段重发）。 */
export const STREAM_MIN_CHUNK_MS = 200;
export const STREAM_MAX_CHUNK_MS = 400;
/** 会话就绪等待上限：ready / 失败都必须快，不能堵住麦克风与租约。 */
export const STREAM_OPEN_TIMEOUT_MS = 8_000;
/** 积压判定：缓冲超过 1 s 视为后端跟不上（UI 说明用；不丢音频）。 */
export const STREAM_BACKLOG_MS = 1_000;
/** 契约默认上限（服务端创建会话时会回带真实值；这里只作缺省，不冒充）。 */
export const STREAM_DEFAULT_MAX_CHUNK_BYTES = 32_000;
export const STREAM_DEFAULT_SESSION_MS = 60_000;
export const STREAM_DEFAULT_IDLE_MS = 10_000;
/** 流式协议标识（能力判定用；与后端 `ASR_STREAM_PROTOCOL` 一致）。 */
export const ASR_STREAM_PROTOCOL = "asr-stream-v1";

// ------------------------------------------------------------------ 稳定错误码（与契约 §4 一致）

/** 服务端流式错误码（前端按 code 分支，不靠文案猜）。 */
export const ASR_STREAM_ERRORS = {
	notReady: "asr_not_ready",
	busy: "asr_stream_busy",
	seqGap: "asr_stream_seq_gap",
	seqReplay: "asr_stream_seq_replay",
	backpressure: "asr_stream_backpressure",
	expired: "asr_stream_expired",
	unknown: "asr_stream_unknown",
	sourceChanged: "asr_source_changed",
	forbidden: "asr_stream_forbidden",
	scopeMismatch: "asr_stream_scope_mismatch",
	badFormat: "asr_bad_format",
	frameTooLarge: "asr_frame_too_large",
	engineError: "asr_engine_error",
} as const;

/** 带稳定 code 的流式错误（跨层传递；`api.ts` 的 wire 实现抛它，控制器按 code 给中文）。 */
export class AsrStreamError extends Error {
	constructor(
		readonly code: string,
		readonly status = 0,
		message = code,
		readonly retryAfterMs?: number,
	) {
		super(message);
		this.name = "AsrStreamError";
	}
}

// ------------------------------------------------------------------ 线协议事件归一化

/**
 * 归一化后的流事件（**会话层内部形态**，与线协议字段解耦，但语义一一对应）：
 *  - `committed`：该段当前**完整**稳定前缀（绝对量）；UI 只把「比上次新增的部分」进草稿；
 *  - `tentative`：该段**剩余部分的完整文本**（绝对量，整体替换）；
 *  - `final`：该段**完整文本**（绝对量），冻结该段；
 *  - `endpoint`：段边界通知（服务端已 reset，可继续听下一句；自身不带文本）。
 */
export type VoiceStreamUpdate =
	| { kind: "committed"; segmentId: string; text: string; seq?: number }
	| { kind: "tentative"; segmentId: string; text: string; seq?: number }
	| { kind: "final"; segmentId: string; text: string; seq?: number }
	| { kind: "endpoint"; segmentId: string; seq?: number };

const asText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const asSegmentId = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const asSeq = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * 把线协议事件（JSON）归一成内部形态。**未知类型 / 缺 segmentId 一律丢弃**（不猜、不伪造）。
 * 契约已冻结：committed 是稳定前缀绝对量，tentative 是剩余部分绝对量 —— 这里只做**形状**归一，不做任何 LCP。
 */
export function normalizeStreamEvent(raw: unknown): VoiceStreamUpdate | null {
	if (!raw || typeof raw !== "object") return null;
	const e = raw as Record<string, unknown>;
	const segmentId = asSegmentId(e.segmentId);
	if (!segmentId) return null;
	const seq = asSeq(e.seq);
	switch (e.type) {
		case "committed":
			return { kind: "committed", segmentId, text: asText(e.text), seq };
		case "tentative":
			return { kind: "tentative", segmentId, text: asText(e.text), seq };
		case "final":
			return { kind: "final", segmentId, text: asText(e.text), seq };
		case "endpoint":
			return { kind: "endpoint", segmentId, seq };
		default:
			return null;
	}
}

/** 归一化一批事件（append / end 响应里的 `events` / `finals`）。 */
export function normalizeStreamEvents(raw: unknown): VoiceStreamUpdate[] {
	if (!Array.isArray(raw)) return [];
	const out: VoiceStreamUpdate[] = [];
	for (const item of raw) {
		const u = normalizeStreamEvent(item);
		if (u) out.push(u);
	}
	return out;
}

/**
 * 两个字符串的最长公共前缀长度（按 UTF-16 code unit）。
 *
 * **不作为 wire 算法**：契约明确 committed / tentative 由服务端给出（server-authoritative），
 * 前端不再自算一套（历史实现曾用它，已从模型里移除）。保留为纯 helper，仅用于单测 / 诊断。
 */
export function longestCommonPrefix(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

// ------------------------------------------------------------------ 句段模型

export interface StreamCommit {
	/** 段在会话内的显示序（首次出现顺序，0 起）。 */
	index: number;
	/** 服务端段号（不透明字符串，用于 requestId / 去重）。 */
	segmentId: string;
	/** 本次新确认、需按语音原序进草稿的增补（正文字符，不含已进草稿的前缀）。 */
	text: string;
}

export interface StreamApplyResult {
	/** 本次新确认、需按语音原序进草稿的增补（一次事件最多 1 条）。 */
	commits: StreamCommit[];
	/** 当前段未确认预览（tentative 绝对量；final 后为空）。 */
	tentative: string;
	/** 本次事件所属段号（未知为 null）。 */
	segmentId: string | null;
	/** 服务端 committed / final 与已确认前缀不自洽（协议外）：已确认部分不重写、不重复追加。 */
	mismatch: boolean;
}

export interface VoiceStreamSegmentView {
	segmentId: string;
	index: number;
	committed: string;
	tentative: string;
	finalized: boolean;
}

interface SegmentState {
	id: string;
	index: number;
	committed: string;
	tentative: string;
	finalized: boolean;
	/** 最近一次应用的事件 seq（晚到 / 乱序事件据此忽略，不回滚）。 */
	lastSeq: number;
}

/**
 * 句段模型：按 `segmentId` 维护 committed（已确认、进草稿）与 tentative（就地预览）。
 *
 *  - `committed` **整体覆盖**（绝对量）；只把比上次**新增的前缀**作为 `commits` 返回（只增、不回退）；
 *  - `tentative` **整体替换**（绝对量），不做 substring / 口语去重（「你好你好」原样保留）；
 *  - `final` 冻结该段，只提交「未进过草稿的剩余部分」；同段重复 final / final 后晚到 partial 一律忽略；
 *  - 服务端 committed 不自洽（前缀回退 / 与 final 冲突且已有确认文本）→ `mismatch`，**不重写已进草稿的文本**。
 */
export class VoiceStreamModel {
	private segments = new Map<string, SegmentState>();
	private order: string[] = [];
	private activeId: string | null = null;

	private seg(id: string): SegmentState {
		let s = this.segments.get(id);
		if (!s) {
			s = { id, index: this.order.length, committed: "", tentative: "", finalized: false, lastSeq: -1 };
			this.segments.set(id, s);
			this.order.push(id);
		}
		return s;
	}

	apply(u: VoiceStreamUpdate): StreamApplyResult {
		if (u.kind === "endpoint") {
			// 段边界：不带文本；通常紧跟在 final 之后，这里只当通知。
			return { commits: [], tentative: this.preview(), segmentId: u.segmentId, mismatch: false };
		}
		const st = this.seg(u.segmentId);
		this.activeId = u.segmentId;
		if (u.seq !== undefined) {
			// 晚到 / 乱序：同段旧 seq 一律忽略（不回滚已确认文本）。
			if (u.seq < st.lastSeq) return { commits: [], tentative: this.preview(), segmentId: u.segmentId, mismatch: false };
			st.lastSeq = u.seq;
		}
		// 该段已冻结：重复 final / 晚到 partial 一律忽略。
		if (st.finalized) return { commits: [], tentative: this.preview(), segmentId: u.segmentId, mismatch: false };

		const commits: StreamCommit[] = [];
		let mismatch = false;
		if (u.kind === "committed") {
			if (u.text === st.committed || st.committed.startsWith(u.text)) {
				// 相同 / 服务端给出更短前缀（不可回退）：不产出增补。
			} else if (u.text.startsWith(st.committed)) {
				const delta = u.text.slice(st.committed.length);
				st.committed = u.text;
				commits.push({ index: st.index, segmentId: st.id, text: delta });
			} else {
				// 与已确认前缀冲突（协议外）：不回退、不重复追加。
				mismatch = st.committed.length > 0;
			}
		} else if (u.kind === "tentative") {
			st.tentative = u.text;
		} else {
			// final = 该段完整文本（绝对量）：只提交未进过草稿的剩余部分。
			if (u.text.startsWith(st.committed)) {
				const delta = u.text.slice(st.committed.length);
				st.committed = u.text;
				if (delta) commits.push({ index: st.index, segmentId: st.id, text: delta });
			} else if (st.committed.length === 0) {
				st.committed = u.text;
				if (u.text) commits.push({ index: st.index, segmentId: st.id, text: u.text });
			} else {
				mismatch = true;
			}
			st.tentative = "";
			st.finalized = true;
		}
		return { commits, tentative: this.preview(), segmentId: u.segmentId, mismatch };
	}

	/** 当前段（最后活动且未冻结）的未确认预览；无则为空。 */
	preview(): string {
		if (this.activeId) {
			const s = this.segments.get(this.activeId);
			if (s && !s.finalized) return s.tentative;
		}
		for (let i = this.order.length - 1; i >= 0; i--) {
			const s = this.segments.get(this.order[i]);
			if (s && !s.finalized) return s.tentative;
		}
		return "";
	}

	/** 已确认文本（按段序拼接 committed；含已冻结段）。 */
	committedText(): string {
		return this.order.map((id) => this.segments.get(id)?.committed ?? "").join("");
	}

	snapshot(): VoiceStreamSegmentView[] {
		return this.order.map((id) => {
			const s = this.segments.get(id)!;
			return { segmentId: s.id, index: s.index, committed: s.committed, tentative: s.tentative, finalized: s.finalized };
		});
	}

	reset(): void {
		this.segments.clear();
		this.order = [];
		this.activeId = null;
	}
}

// ------------------------------------------------------------------ 流式重采样（真实计算，不假装 16 k）

/**
 * 流式线性插值重采样：按**全局输出位置** `j * inputRate / targetRate` 计算，
 * 相邻两片的首尾输出**严格相接**（不制造 gap、不重复、不随片数漂移）。
 * 需要「下一片首样点」才能插值的输出样点会挂起到下一片；`flush` 用最后样点补齐尾部。
 */
export class StreamResampler {
	private readonly ratio: number;
	/** 下一片首样点在**全局**输入里的编号。 */
	private base = 0;
	/** 全局编号 `base - 1` 的样点（跨片插值用）。 */
	private lastInput: number | null = null;
	/** 下一个待输出样点的**全局**编号。 */
	private nextOut = 0;

	constructor(
		readonly inputRate: number,
		readonly targetRate = TARGET_SAMPLE_RATE,
	) {
		this.ratio = inputRate / targetRate;
	}

	push(chunk: Float32Array): Float32Array {
		const n = chunk.length;
		if (n === 0) return new Float32Array(0);
		const out: number[] = [];
		let j = this.nextOut;
		for (;;) {
			const pos = j * this.ratio;
			const i0 = Math.floor(pos);
			if (i0 + 1 > this.base + n - 1) break; // 需要超出本片的样点
			const at = (i: number) => (i >= this.base ? chunk[i - this.base] : (this.lastInput ?? chunk[0]));
			const t = pos - i0;
			out.push(at(i0) * (1 - t) + at(i0 + 1) * t);
			j++;
		}
		this.nextOut = j;
		this.lastInput = chunk[n - 1];
		this.base += n;
		return Float32Array.from(out);
	}

	/** 尾部：用最后样点补齐（保持最后值），与「整段一次重采样」的输出长度一致（`ceil(N/ratio)`）。 */
	flush(): Float32Array {
		if (this.lastInput === null) return new Float32Array(0);
		const out: number[] = [];
		while (this.nextOut * this.ratio < this.base) {
			out.push(this.lastInput);
			this.nextOut++;
		}
		return Float32Array.from(out);
	}

	reset(): void {
		this.base = 0;
		this.lastInput = null;
		this.nextOut = 0;
	}
}

// ------------------------------------------------------------------ 有界分片器

/**
 * 把采集到的 16 kHz Float32 分片攒成 200–400 ms 的 PCM16 分片；**不丢样点**。
 * 缓冲只受录音上限（60 s）约束；`drain` 取走完整分片并保留余数，`flush` 取走全部余数（不丢尾）。
 */
export class StreamPacer {
	private buf: Float32Array[] = [];
	private samples = 0;

	get bufferedSamples(): number {
		return this.samples;
	}

	push(chunk: Float32Array): void {
		if (!chunk.length) return;
		this.buf.push(chunk);
		this.samples += chunk.length;
	}

	/** 取出所有长度 >= `minSamples` 的完整分片（每次恰好 `minSamples` 个样点），保留不足的余数。 */
	drain(minSamples: number): Int16Array[] {
		const take = Math.max(1, Math.floor(minSamples));
		const out: Int16Array[] = [];
		while (this.samples >= take) out.push(pcm16FromFloat32(this.take(take)));
		return out;
	}

	/** 停止：取走全部剩余（含不足一片的余数），**不丢尾**。 */
	flush(): Int16Array | null {
		if (this.samples === 0) return null;
		return pcm16FromFloat32(this.take(this.samples));
	}

	private take(n: number): Float32Array {
		const out = new Float32Array(n);
		let at = 0;
		while (at < n && this.buf.length) {
			const head = this.buf[0];
			const need = n - at;
			if (head.length <= need) {
				out.set(head, at);
				at += head.length;
				this.buf.shift();
			} else {
				out.set(head.subarray(0, need), at);
				this.buf[0] = head.slice(need);
				at += need;
			}
		}
		this.samples -= n;
		return out;
	}

	reset(): void {
		this.buf = [];
		this.samples = 0;
	}
}

/** 把一段 PCM16 按最大样点数切帧（服务端 `maxChunkBytes` 硬上限；不丢样点）。 */
export function splitInt16(pcm: Int16Array, maxSamples: number): Int16Array[] {
	const take = Math.max(1, Math.floor(maxSamples));
	if (pcm.length <= take) return [pcm];
	const out: Int16Array[] = [];
	for (let at = 0; at < pcm.length; at += take) out.push(pcm.slice(at, Math.min(at + take, pcm.length)));
	return out;
}

// ------------------------------------------------------------------ 会话层接口（线协议由 api.ts 接线）

/** 服务端创建会话时声明的上限（控制器据此切片 / 定时；缺省用契约默认值，不编造）。 */
export interface VoiceStreamLimits {
	maxChunkBytes: number;
	maxSessionMs: number;
	idleTimeoutMs: number;
	partialIntervalHintMs: [number, number];
	sampleRate: number;
}

export interface VoiceStreamOpenOptions {
	provider: string;
	model: string;
	language?: string;
	agentId?: string;
	conversationId?: string;
	/** 采集侧真实采样率（控制器已重采样成 16 k 再追加）。 */
	sampleRate: number;
	/** 归一化事件回调（api.ts 的 wire 实现解析 JSON 后调用）。 */
	onUpdate: (u: VoiceStreamUpdate) => void;
	/** 会话级错误（致命；控制器会停轨道并保存已确认文本）。 */
	onError: (e: unknown) => void;
}

/**
 * 流会话：由 `api.ts` 的 `openAsrStream` 实现（有界 seq append + ack、JSON 事件解析）。
 *  - `append` **串行调用**，resolve = 后端已 ack 该片；reject = 失败（会话终止）；
 *  - `finish` flush 服务端尾并等 final 事件；可被 `abort` 打断；
 *  - `abort` 断开连接、丢弃未 ack（不等待；best-effort 通知服务端 cancel）。
 */
export interface VoiceStreamTransport {
	append(pcm: Int16Array, seq: number): Promise<void>;
	finish(): Promise<void>;
	abort(reason?: string): void;
	/** 服务端声明的上限（缺省由实现给契约默认值）。 */
	readonly limits?: VoiceStreamLimits;
}

export type VoiceStreamOpen = (opts: VoiceStreamOpenOptions) => Promise<VoiceStreamTransport>;

// ------------------------------------------------------------------ 流会话控制器

export interface NativeVoiceDeps {
	getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	/** 复用既有采集（16 kHz AudioWorklet / ScriptProcessor）；**不另建音频引擎**。 */
	startCapture: (stream: MediaStream, onData: (chunk: Float32Array) => void) => Promise<VoiceCaptureHandle>;
	openStream: VoiceStreamOpen;
	maxDurationMs?: number;
	createSessionId?: () => string;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (t: unknown) => void;
}

export interface NativeVoiceEvents {
	onState?: (s: VoiceState) => void;
	/** committed 增补（按语音原序）；UI 追加进草稿，**不自动发送**。 */
	onSegment?: (s: VoiceSegment) => void;
	/** 未确认尾部预览（就地状态行用；final 后为空）。 */
	onTentative?: (text: string) => void;
	onError?: (e: VoiceError) => void;
	onLevel?: (level: number) => void;
	onProgress?: (p: VoiceProgress) => void;
	onNoSpeech?: () => void;
}

const defaultSessionId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** 会话失败 → 可解释中文（按后端 code 分支，不靠文案猜）。 */
export function streamFailureInfo(e: unknown): VoiceError {
	const code = e instanceof AsrStreamError ? e.code : e && typeof e === "object" && "code" in e ? String((e as { code?: unknown }).code ?? "") : "";
	const detail = !code && e instanceof Error && e.message ? `（${e.message}）` : "";
	switch (code) {
		case ASR_STREAM_ERRORS.sourceChanged:
			return { code, message: "识别来源已变，请重新开始录音（已保留识别到的文字）" };
		case ASR_STREAM_ERRORS.expired:
			return { code, message: "本次录音已达时/上限，请重新开始（已保留识别到的文字）" };
		case ASR_STREAM_ERRORS.busy:
			return { code, message: "已有进行中的流式识别会话，请稍后再试" };
		case ASR_STREAM_ERRORS.notReady:
			return { code, message: "本地流式模型尚未准备好，请稍后再试；到设置 › 语音配置 可看准备进度" };
		case ASR_STREAM_ERRORS.forbidden:
			return { code, message: "当前设备不能操作这个识别会话，请重新开始录音" };
		case ASR_STREAM_ERRORS.scopeMismatch:
			return { code, message: "识别会话归属不一致，请重新开始录音" };
		case ASR_STREAM_ERRORS.backpressure:
			return { code, message: "识别引擎处理不过来，请稍后重试" };
		case ASR_STREAM_ERRORS.engineError:
			return { code, message: "本地流式识别引擎异常，请稍后重试" };
		default:
			return { code: code || "asr_stream_failed", message: `本地流式识别中断${detail}，已保留识别到的文字；未确认的尾句请重新录音` };
	}
}

/**
 * 原生流式控制器。状态机与 `VoiceInputController` 一致：
 * `idle → preparing → recording → transcribing → finish/idle`（`error` 表示失败）。
 *
 * 生命周期（用户要求）：会话先就绪（短超时）再开采集；起步前后任何失败 / 取消 / 切来源 / 切会话 / 页面隐藏 / 卸载
 * 都释放轨道 + abort 会话（租约由 hook 统一释放）。停止只 flush 尾片并等 final，**不整段重识别**；失败保已确认文本。
 * 采集实际采样率非 16 k 时**真重采样**（`StreamResampler`），绝不把 48 k 当 16 k 发。
 */
export class NativeVoiceController {
	private state: VoiceState = "idle";
	private stream: MediaStream | null = null;
	private capture: VoiceCaptureHandle | null = null;
	private transport: VoiceStreamTransport | null = null;
	private pacer: StreamPacer | null = null;
	private resampler: StreamResampler | null = null;
	private model = new VoiceStreamModel();
	private meter = new LevelMeter();
	private opts: VoiceStartOptions | null = null;
	private timer: unknown;
	private gen = 0;
	private seq = 0;
	private captureRate = TARGET_SAMPLE_RATE;
	private sessionId = "";
	private maxChunkBytes = STREAM_DEFAULT_MAX_CHUNK_BYTES;
	private sessionMaxMs = STREAM_DEFAULT_SESSION_MS;
	private streamBusy = false;
	private streamWaiters: (() => void)[] = [];
	private gotSpeech = false;
	/** 采集回调可能在 `startCapture` 内同步触发：就绪前先缓冲，避免丢首批音频 / 用错采样率。 */
	private ready = false;
	private preReady: Float32Array[] = [];

	constructor(
		private deps: NativeVoiceDeps,
		private events: NativeVoiceEvents = {},
	) {}

	getState(): VoiceState {
		return this.state;
	}

	isActive(): boolean {
		return this.state === "preparing" || this.state === "recording";
	}

	/** 单帧最大样点数（受服务端 `maxChunkBytes` 与 400 ms 双约束）。 */
	private get maxFrameSamples(): number {
		const byBytes = Math.floor(this.maxChunkBytes / 2);
		return Math.max(1, Math.min(Math.round((TARGET_SAMPLE_RATE * STREAM_MAX_CHUNK_MS) / 1000), byBytes));
	}

	private get minFrameSamples(): number {
		return Math.max(1, Math.min(Math.round((TARGET_SAMPLE_RATE * STREAM_MIN_CHUNK_MS) / 1000), this.maxFrameSamples));
	}

	progress(): VoiceProgress {
		const min = this.minFrameSamples;
		const buffered = this.pacer?.bufferedSamples ?? 0;
		return {
			pending: Math.floor(buffered / min),
			inflight: this.streamBusy ? 1 : 0,
			failed: 0,
			backlog: buffered > Math.round((TARGET_SAMPLE_RATE * STREAM_BACKLOG_MS) / 1000),
			held: 0,
			stream: true,
		};
	}

	private set(s: VoiceState): void {
		this.state = s;
		this.events.onState?.(s);
	}

	private get clearTimer(): (t: unknown) => void {
		return this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
	}

	private get setTimer(): (fn: () => void, ms: number) => unknown {
		return this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	}

	async start(opts: VoiceStartOptions): Promise<void> {
		if (this.isActive() || this.state === "transcribing") return;
		this.resetRun();
		this.gen++;
		const gen = this.gen;
		this.opts = opts;
		this.sessionId = (this.deps.createSessionId ?? defaultSessionId)();
		this.set("preparing");

		let stream: MediaStream;
		try {
			stream = await this.deps.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		} catch (e) {
			this.set("error");
			this.events.onError?.(voiceErrorFrom(e));
			return;
		}
		// 拿权限期间被取消 / 页面隐藏 / 切来源：立刻释放，不进录音态。
		if (gen !== this.gen || this.state !== "preparing") {
			for (const t of stream.getTracks()) t.stop();
			return;
		}
		this.stream = stream;

		// 会话先就绪（短超时）再开采集：ready 失败要早失败、不占麦克风。
		let transport: VoiceStreamTransport;
		try {
			transport = await this.openWithTimeout(gen);
		} catch (e) {
			this.releaseStream();
			if (gen !== this.gen) return;
			this.set("error");
			this.events.onError?.(streamOpenError(e));
			return;
		}
		if (gen !== this.gen || this.state !== "preparing") {
			transport.abort("cancelled");
			this.releaseStream();
			return;
		}
		this.transport = transport;
		this.maxChunkBytes = Math.max(1, transport.limits?.maxChunkBytes ?? STREAM_DEFAULT_MAX_CHUNK_BYTES);
		this.sessionMaxMs = Math.max(1, transport.limits?.maxSessionMs ?? STREAM_DEFAULT_SESSION_MS);

		// 采集回调可能在 `startCapture` 内同步触发 → pacer / 就绪前缓冲必须先建好，避免丢首批音频。
		this.pacer = new StreamPacer();
		this.ready = false;
		this.preReady = [];
		try {
			this.capture = await this.deps.startCapture(stream, (c) => this.onData(c));
		} catch (e) {
			this.abortTransport();
			this.releaseStream();
			if (gen !== this.gen) return;
			this.set("error");
			this.events.onError?.(voiceErrorFrom(e));
			return;
		}
		if (gen !== this.gen || this.state !== "preparing") {
			this.capture.stop();
			this.capture = null;
			this.abortTransport();
			this.releaseStream();
			return;
		}
		this.captureRate = this.capture.sampleRate;
		// 采集实际采样率非 16 k 时真重采样；16 k 时不做多余处理。
		this.resampler = this.captureRate === TARGET_SAMPLE_RATE ? null : new StreamResampler(this.captureRate, TARGET_SAMPLE_RATE);
		this.ready = true;
		this.set("recording");
		this.timer = this.setTimer(() => void this.stop(), this.deps.maxDurationMs ?? Math.min(DEFAULT_MAX_DURATION_MS, this.sessionMaxMs));
		// 采集已就绪：把就绪前缓冲的首批音频送出去。
		const pending = this.preReady;
		this.preReady = [];
		for (const c of pending) this.onData(c);
		void this.pumpStream();
	}

	private async openWithTimeout(gen: number): Promise<VoiceStreamTransport> {
		const opts = this.opts!;
		let timer: unknown;
		const timedOut = new Promise<never>((_, reject) => {
			timer = this.setTimer(() => reject(Object.assign(new Error("asr_stream_timeout"), { name: "TimeoutError" })), STREAM_OPEN_TIMEOUT_MS);
		});
		let aborted = false;
		const guarded = this.deps
			.openStream({
				provider: opts.provider,
				model: opts.model,
				language: opts.language,
				agentId: opts.agentId,
				conversationId: opts.conversationId,
				sampleRate: TARGET_SAMPLE_RATE,
				onUpdate: (u) => this.handleUpdate(u),
				onError: (e) => this.streamFail(e),
			})
			.then((t) => {
				if (aborted || gen !== this.gen) {
					// 竞速失败 / 取消后的“迟到就绪”：让 wire 层 best-effort cancel 服务端会话（避免留租约）。
					t.abort("late");
					throw new AsrStreamError("asr_stream_aborted", 0, "已取消");
				}
				return t;
			});
		void guarded.catch(() => {
			/* 竞速失败 / 取消：不外抛未处理拒绝 */
		});
		let ok = false;
		try {
			const t = await Promise.race([guarded, timedOut]);
			ok = true;
			return t;
		} finally {
			this.clearTimer(timer);
			if (!ok) aborted = true;
		}
	}

	private onData(chunk: Float32Array): void {
		if (!chunk.length) return;
		if (!this.ready) {
			// 就绪前（startCapture 尚未返回采样率）：先缓冲，就绪后按真实采样率重采样再送。
			this.preReady.push(chunk);
			return;
		}
		const lvl = this.meter.push(chunk);
		if (lvl !== null) this.events.onLevel?.(lvl);
		const pcm = this.resampler ? this.resampler.push(chunk) : chunk;
		if (pcm.length) this.pacer?.push(pcm);
		void this.pumpStream();
	}

	/** 串行追加：最多一个 append 在途；慢后端只会让缓冲增长（有界于录音上限），不无限排队。 */
	private async pumpStream(): Promise<void> {
		if (this.streamBusy || !this.transport || !this.ready) return;
		const gen = this.gen;
		this.streamBusy = true;
		try {
			for (;;) {
				if (gen !== this.gen) break;
				const list = this.pacer?.drain(this.minFrameSamples) ?? [];
				if (!list.length) break;
				for (const pcm of list) {
					if (gen !== this.gen) break;
					for (const piece of splitInt16(pcm, this.maxFrameSamples)) {
						await this.transport.append(piece, this.seq++);
					}
					this.events.onProgress?.(this.progress());
				}
			}
		} catch (e) {
			this.streamFail(e);
		} finally {
			this.streamBusy = false;
			this.resolveStreamWaiters();
		}
	}

	private waitStreamIdle(): Promise<void> {
		if (!this.streamBusy) return Promise.resolve();
		return new Promise<void>((resolve) => this.streamWaiters.push(resolve));
	}

	private resolveStreamWaiters(): void {
		const waiters = this.streamWaiters;
		this.streamWaiters = [];
		for (const w of waiters) w();
	}

	private handleUpdate(u: VoiceStreamUpdate): void {
		if (this.state === "idle" || this.state === "finish") return;
		const res = this.model.apply(u);
		if (res.commits.length) {
			this.gotSpeech = true;
			for (const c of res.commits) {
				this.events.onSegment?.({
					text: c.text,
					index: c.index,
					requestId: `${this.sessionId}:${c.segmentId}`,
					anchor: this.opts?.anchor ?? 0,
					agentId: this.opts?.agentId,
					conversationId: this.opts?.conversationId,
				});
			}
		}
		this.events.onTentative?.(this.model.preview());
	}

	/** 停止并 flush：只发尾片 + `finish`，**不整段重识别**。 */
	async stop(): Promise<void> {
		if (this.state !== "recording" || !this.opts) return;
		const gen = this.gen;
		this.clearTimer(this.timer);
		this.capture?.stop();
		this.capture = null;
		this.ready = false;
		this.releaseStream();
		this.set("transcribing");
		try {
			await this.waitStreamIdle();
			if (gen !== this.gen) return;
			// 先冲重采样器尾，再冲分片器尾（保证 16 k 尾样点不丢）。
			const resTail = this.resampler?.flush() ?? null;
			if (resTail && resTail.length) this.pacer?.push(resTail);
			const rest = this.pacer?.flush() ?? null;
			if (rest && rest.length && this.transport) {
				for (const piece of splitInt16(rest, this.maxFrameSamples)) {
					await this.transport.append(piece, this.seq++);
				}
			}
			if (gen !== this.gen) return;
			await this.transport?.finish();
			if (gen !== this.gen) return;
			if (!this.gotSpeech && this.model.preview() === "") this.events.onNoSpeech?.();
			this.opts = null;
			this.events.onTentative?.("");
			this.set("finish");
			this.set("idle");
		} catch (e) {
			if (gen !== this.gen) return;
			this.streamFail(e);
			return;
		} finally {
			this.transport = null;
			this.clearBuffers();
		}
	}

	/** 取消：断开会话、丢弃未应用结果，**不等待 finish**；已进草稿的 committed 文本保留。 */
	cancel(): void {
		if (this.state === "idle" || this.state === "finish") return;
		this.gen++;
		this.clearTimer(this.timer);
		this.capture?.stop();
		this.capture = null;
		this.releaseStream();
		this.abortTransport();
		this.opts = null;
		this.resolveStreamWaiters();
		this.clearBuffers();
		this.events.onTentative?.("");
		this.set("idle");
	}

	/** 页面隐藏 / 切后台 / 切会话：停轨道 + 取消（不发送）。 */
	onHidden(): void {
		if (this.isActive()) this.cancel();
	}

	/** 原生流式不保留失败音频（重放会重复计费）：重试 = 用户重新录一段，这里不做任何事。 */
	async retryFailed(): Promise<void> {
		return;
	}

	private streamFail(e: unknown): void {
		if (this.state === "idle" || this.state === "finish") return;
		const info = streamFailureInfo(e);
		this.abortTransport();
		this.releaseStream();
		this.capture = null;
		this.ready = false;
		this.opts = null;
		this.events.onTentative?.("");
		this.set("error");
		this.events.onError?.(info);
	}

	private abortTransport(): void {
		try {
			this.transport?.abort("cancelled");
		} catch {
			/* abort 不应抛；有也忽略 */
		}
		this.transport = null;
	}

	private clearBuffers(): void {
		this.pacer?.reset();
		this.pacer = null;
		this.resampler = null;
		this.preReady = [];
		this.ready = false;
		this.model.reset();
		this.meter.reset();
		this.seq = 0;
		this.gotSpeech = false;
		this.captureRate = TARGET_SAMPLE_RATE;
		this.maxChunkBytes = STREAM_DEFAULT_MAX_CHUNK_BYTES;
		this.sessionMaxMs = STREAM_DEFAULT_SESSION_MS;
		this.events.onProgress?.({ pending: 0, inflight: 0, failed: 0, backlog: false, held: 0, stream: true });
	}

	private resetRun(): void {
		this.streamWaiters = [];
		this.streamBusy = false;
		this.clearBuffers();
	}

	private releaseStream(): void {
		if (this.stream) for (const t of this.stream.getTracks()) t.stop();
		this.stream = null;
	}
}

/** 会话打开失败：区分超时 / 取消 / 未就绪 / 未配置，都给可解释中文；**不假装已开始录音**。 */
export function streamOpenError(e: unknown): VoiceError {
	if (e instanceof AsrStreamError) {
		if (e.code === "asr_stream_aborted") return { code: "asr_stream_aborted", message: "已取消" };
		if (e.code === ASR_STREAM_ERRORS.notReady) return { code: e.code, message: "本地流式模型还没准备好，请先等首次准备完成或在设置里重试" };
		if (e.code === ASR_STREAM_ERRORS.busy) return { code: e.code, message: "已有进行中的流式识别会话，请稍后再试" };
		return { code: e.code, message: e.message || "本地流式识别暂不可用，请稍后重试或换一个语音模型" };
	}
	const name = e && typeof e === "object" && "name" in e ? String((e as { name?: unknown }).name) : "";
	const message = e instanceof Error ? e.message : String(e ?? "");
	if (name === "AbortError" || message.includes("asr_stream_aborted")) return { code: "asr_stream_aborted", message: "已取消" };
	if (name === "TimeoutError" || message.includes("asr_stream_timeout")) return { code: "asr_stream_timeout", message: "本地流式识别启动超时，请重试" };
	if (message.includes("asr_not_configured")) return { code: "asr_not_configured", message: "请先在设置里选择语音识别模型" };
	return { code: "asr_stream_unavailable", message: message || "本地流式识别暂不可用，请稍后重试或换一个语音模型" };
}

/** 工具：把若干 16 kHz Float32 分片按 200–400 ms 切成 PCM16（测试 / 假 provider 复用，不产生第二套音频引擎）。 */
export function pacify(chunks: Float32Array[], sampleRate = TARGET_SAMPLE_RATE, chunkMs = STREAM_MIN_CHUNK_MS): Int16Array[] {
	const merged = concatFloat32(chunks);
	const per = Math.max(1, Math.round((sampleRate * chunkMs) / 1000));
	const out: Int16Array[] = [];
	for (let at = 0; at < merged.length; at += per) out.push(pcm16FromFloat32(merged.subarray(at, Math.min(at + per, merged.length))));
	return out;
}
