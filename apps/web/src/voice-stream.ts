/**
 * 原生流式本地语音的**纯逻辑层**（不 import React、不碰 `navigator` / `AudioContext`）：
 * 稳定前缀、句段模型（committed / tentative）、有界分片器、流会话控制器。
 *
 * 与既有 `voice-input.ts` 的边界（重要）：
 *  - `voice-input.ts` 的 `VoiceInputController`（整段批量 + 停顿分段增量）**保持原样、不回归**；
 *  - 原生流式是**同一套采集 / 音量 / 租约**上的另一条发送路径：采集仍是 `startCapture` 的 16 kHz PCM，
 *    音量仍是 `LevelMeter` 的真实 RMS，**不另造第二套音频引擎、不另立来源状态**；
 *  - 这里只定义**会话层接口**（`VoiceStreamOpen` / `VoiceStreamTransport`）。**具体 HTTP 线协议（路径 / 字段名 /
 *    chunk 编码 / seq-ack 语义）由主会话与 backend owner 的契约决定**；接线时只实现一个 `openStream`，不改本文件的模型。
 *
 * 关键约束（对齐设计 `docs/design/default-local-voice.md` §3.3/§3.4 与用户要求）：
 *  - **服务端保持流状态**：浏览器只按 200–400 ms 追加 PCM（有界 seq），**不把每 100 ms 的完整 WAV 重发**；
 *  - **committed / tentative 分离**：稳定前缀（跨两次 partial 的最长公共前缀，只增不减）进草稿，未确认尾部只在
 *    录音状态行**就地预览**；同一句的 revision **覆盖** tentative，绝不把 partial 当 final 重复追加；
 *  - **不 substring 去重**：重复口语「你好你好」照原样保留；
 *  - **有界并发**：append 串行、缓冲有界（录音 60 s 上限兜底），慢后端只积压缓冲、不无限排队；
 *  - **不丢尾**：停止时 flush 尾片，只 flush 尾、不整段重识别；`finish` 等 final，但可被 `cancel` abort；
 *  - **失败保已确认文本**：网络 / 会话失败时已进草稿的 committed 文本保留，tentative 标为未确认；**不自动重发旧音频
 *    （重放会重复计费）、不自动发送**，重试 = 用户重新录一段。
 */

import {
	DEFAULT_MAX_DURATION_MS,
	LevelMeter,
	TARGET_SAMPLE_RATE,
	concatFloat32,
	pcm16FromFloat32,
	voiceErrorFrom,
	type VoiceCaptureHandle,
	type VoiceError,
	type VoiceProgress,
	type VoiceSegment,
	type VoiceStartOptions,
	type VoiceState,
} from "./voice-input";

/** 追加分片的目标时长：正常 200–400 ms（既不 100 ms 空转，也不攒成整段重发）。 */
export const STREAM_MIN_CHUNK_MS = 200;
export const STREAM_MAX_CHUNK_MS = 400;
/** 会话就绪等待上限：ready / 失败都必须快，不能堵住麦克风与租约。 */
export const STREAM_OPEN_TIMEOUT_MS = 8_000;
/** 积压判定：缓冲超过 1 s 视为后端跟不上（UI 说明用；不丢音频）。 */
export const STREAM_BACKLOG_MS = 1_000;

// ------------------------------------------------------------------ 稳定前缀

/** 两个字符串的最长公共前缀长度（按 UTF-16 code unit；中文按字、英文按字符，不插空格）。 */
export function longestCommonPrefix(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

/**
 * 稳定前缀跟踪器（每句一个）：把相邻两次 partial 的公共前缀算作「已确认」，且**只增不减**。
 * 学 whisper_streaming（MIT）的「最长公共前缀」思路自研，不复制代码。
 */
export class StablePrefixTracker {
	private cursor = 0;
	private lastFull = "";

	apply(full: string): { committed: string; tentative: string } {
		const lcp = longestCommonPrefix(this.lastFull, full);
		this.cursor = Math.max(this.cursor, Math.min(lcp, full.length));
		this.lastFull = full;
		return { committed: full.slice(0, this.cursor), tentative: full.slice(this.cursor) };
	}

	reset(): void {
		this.cursor = 0;
		this.lastFull = "";
	}
}

// ------------------------------------------------------------------ 句段模型

/**
 * 归一化后的流事件（**会话层内部形态**，与线协议字段无关）。
 *  - `partial`：该句当前全文；`committed` 由服务端给（已算好稳定前缀）时用它，缺省由客户端最长公共前缀算；
 *  - `final`：该句最终文本（endpoint 触发），冻结该句、下一句从 `index+1` 开始。
 */
export interface VoiceStreamUpdate {
	kind: "partial" | "final";
	/** 句序号；缺省 = 下一句。 */
	index?: number;
	/** partial = 该句当前全文；final = 该句最终全文。 */
	text: string;
	/** 服务端已经算好的稳定前缀（可选）。给了就信它（仍做「只增不减」保护）。 */
	committed?: string;
}

export interface StreamCommit {
	index: number;
	text: string;
}

export interface StreamApplyResult {
	/** 本次新确认、需按语音原序进草稿的增补（一次事件最多 1 条）。 */
	commits: StreamCommit[];
	/** 当前句的未确认预览（可能为空）。 */
	tentative: string;
	/** 当前句序号。 */
	index: number;
	/** final 与已确认文本不自洽（服务端纠正了已确认前缀）——已确认部分不重写、不重复追加。 */
	mismatch: boolean;
}

export interface VoiceStreamSegmentView {
	index: number;
	committed: string;
	tentative: string;
	finalized: boolean;
}

interface SegmentState {
	committed: string;
	tentative: string;
	finalized: boolean;
	tracker: StablePrefixTracker;
}

/**
 * 句段模型：按 `index` 维护 committed（冻结、进草稿）与 tentative（就地预览）。
 *
 *  - 同一句的 partial **覆盖** tentative；committed 只增不减，增补部分以 `commits` 返回（由 UI 追加，不覆盖用户编辑）；
 *  - final 冻结该句（发一次增补），同 index 的重复 final 忽略（**不重复追加**）；
 *  - 晚到 / 过期的 partial（index 已冻结）忽略；
 *  - **不做任何 substring 去重**：「你好你好」原样保留。
 */
export class VoiceStreamModel {
	private segments = new Map<number, SegmentState>();
	private lastFinalized = -1;
	private nextIndex = 0;

	private seg(index: number): SegmentState {
		let s = this.segments.get(index);
		if (!s) {
			s = { committed: "", tentative: "", finalized: false, tracker: new StablePrefixTracker() };
			this.segments.set(index, s);
		}
		return s;
	}

	apply(u: VoiceStreamUpdate): StreamApplyResult {
		const index = u.index ?? this.nextIndex;
		if (index <= this.lastFinalized) return { commits: [], tentative: this.preview(), index, mismatch: false };
		const st = this.seg(index);
		const commits: StreamCommit[] = [];
		let mismatch = false;

		if (u.kind === "partial") {
			// 稳定前缀：服务端给了就用它，否则用相邻 partial 的最长公共前缀。
			const raw = u.committed ?? st.tracker.apply(u.text).committed;
			const committed = raw.startsWith(st.committed) ? raw : st.committed; // 只增不减
			const delta = committed.slice(st.committed.length);
			st.committed = committed;
			st.tentative = u.text.startsWith(committed) ? u.text.slice(committed.length) : u.text;
			st.finalized = false;
			if (delta) commits.push({ index, text: delta });
		} else {
			const base = st.committed;
			if (u.text.startsWith(base)) {
				const delta = u.text.slice(base.length);
				st.committed = u.text;
				if (delta) commits.push({ index, text: delta });
			} else {
				// final 与已确认前缀不自洽：已确认部分已经进过草稿，不重写、不重复追加；
				// 已确认文本为空时以 final 为准（此前没有任何内容进草稿）。
				mismatch = base.length > 0;
				if (!base.length) {
					st.committed = u.text;
					if (u.text) commits.push({ index, text: u.text });
				}
			}
			st.tentative = "";
			st.finalized = true;
			this.lastFinalized = Math.max(this.lastFinalized, index);
			this.nextIndex = Math.max(this.nextIndex, index + 1);
		}

		return { commits, tentative: this.preview(), index, mismatch };
	}

	/** 当前句（最大未冻结句）的未确认预览。 */
	preview(): string {
		let best = -1;
		let text = "";
		for (const [i, s] of this.segments) {
			if (s.finalized) continue;
			if (i >= best) {
				best = i;
				text = s.tentative;
			}
		}
		return text;
	}

	/** 已确认的整句文本（按序拼接；不含 tentative）。 */
	committedText(): string {
		return [...this.segments.entries()]
			.filter(([i]) => i <= this.lastFinalized)
			.sort((a, b) => a[0] - b[0])
			.map(([, s]) => s.committed)
			.join("");
	}

	snapshot(): VoiceStreamSegmentView[] {
		return [...this.segments.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([index, s]) => ({ index, committed: s.committed, tentative: s.tentative, finalized: s.finalized }));
	}

	reset(): void {
		this.segments.clear();
		this.lastFinalized = -1;
		this.nextIndex = 0;
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

// ------------------------------------------------------------------ 会话层接口（线协议由契约接线）

/** 服务端流事件（会话层只认归一化事件；线协议的 JSON / 二进制编码在 `openStream` 里解）。 */
export type VoiceStreamSink = {
	onUpdate: (u: VoiceStreamUpdate) => void;
	onError: (e: unknown) => void;
};

export interface VoiceStreamOpenOptions extends VoiceStreamSink {
	provider: string;
	model: string;
	language?: string;
	agentId?: string;
	conversationId?: string;
	/** 采集侧真实采样率（PCM 已在控制层重采样成 16 k 再追加）。 */
	sampleRate: number;
}

/**
 * 流会话：由契约接线提供（HTTP 有界 seq append + ack、chunked 事件解析）。
 *  - `append` **串行调用**，resolve = 后端已确认（ack）该片；reject = 失败（会话终止）；
 *  - `finish` flush 服务端尾并等 final 事件；可被 `abort` 打断；
 *  - `abort` 断开连接、丢弃未 ack（不等待）。
 */
export interface VoiceStreamTransport {
	append(pcm: Int16Array, seq: number): Promise<void>;
	finish(): Promise<void>;
	abort(reason?: string): void;
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

/**
 * 原生流式控制器。状态机与 `VoiceInputController` 一致：
 * `idle → preparing → recording → transcribing → finish/idle`（`error` 表示失败）。
 *
 * 生命周期（用户要求）：会话先就绪（短超时）再开采集；起步前后任何失败 / 取消 / 切来源 / 切会话 / 页面隐藏 / 卸载
 * 都释放轨道 + abort 会话（租约由 hook 统一释放）。停止只 flush 尾片并等 final，**不整段重识别**；失败保已确认文本。
 */
export class NativeVoiceController {
	private state: VoiceState = "idle";
	private stream: MediaStream | null = null;
	private capture: VoiceCaptureHandle | null = null;
	private transport: VoiceStreamTransport | null = null;
	private pacer: StreamPacer | null = null;
	private model = new VoiceStreamModel();
	private meter = new LevelMeter();
	private opts: VoiceStartOptions | null = null;
	private timer: unknown;
	private gen = 0;
	private seq = 0;
	private sampleRate = TARGET_SAMPLE_RATE;
	private sessionId = "";
	private streamBusy = false;
	private streamWaiters: (() => void)[] = [];
	private gotSpeech = false;

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

	progress(): VoiceProgress {
		const min = Math.max(1, Math.round((this.sampleRate * STREAM_MIN_CHUNK_MS) / 1000));
		const buffered = this.pacer?.bufferedSamples ?? 0;
		return {
			pending: Math.floor(buffered / min),
			inflight: this.streamBusy ? 1 : 0,
			failed: 0,
			backlog: buffered > Math.round((this.sampleRate * STREAM_BACKLOG_MS) / 1000),
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

		// 采集回调可能在 `startCapture` 内同步触发 → pacer 必须先建好，避免丢首批音频。
		this.pacer = new StreamPacer();
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
		this.sampleRate = this.capture.sampleRate;
		this.set("recording");
		this.timer = this.setTimer(() => void this.stop(), this.deps.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
		// 采集已就绪：把就绪前缓冲的首批音频送出去。
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
					t.abort("late");
					throw Object.assign(new Error("asr_stream_aborted"), { name: "AbortError" });
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
		const lvl = this.meter.push(chunk);
		if (lvl !== null) this.events.onLevel?.(lvl);
		this.pacer?.push(chunk);
		void this.pumpStream();
	}

	/** 串行追加：最多一个 append 在途；慢后端只会让缓冲增长（有界于录音上限），不无限排队。 */
	private async pumpStream(): Promise<void> {
		if (this.streamBusy || !this.transport) return;
		const gen = this.gen;
		this.streamBusy = true;
		try {
			for (;;) {
				if (gen !== this.gen) break;
				const buffered = this.pacer?.bufferedSamples ?? 0;
				const wantMs = buffered > Math.round((this.sampleRate * STREAM_MAX_CHUNK_MS) / 1000) ? STREAM_MAX_CHUNK_MS : STREAM_MIN_CHUNK_MS;
				const list = this.pacer?.drain((this.sampleRate * wantMs) / 1000) ?? [];
				if (!list.length) break;
				for (const pcm of list) {
					if (gen !== this.gen) break;
					await this.transport.append(pcm, this.seq++);
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
		const res = this.model.apply(u);
		if (res.commits.length) {
			this.gotSpeech = true;
			for (const c of res.commits) {
				this.events.onSegment?.({
					text: c.text,
					index: c.index,
					requestId: `${this.sessionId}:${c.index}`,
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
		this.releaseStream();
		this.set("transcribing");
		try {
			await this.waitStreamIdle();
			if (gen !== this.gen) return;
			const tail = this.pacer?.flush() ?? null;
			if (tail && this.transport) await this.transport.append(tail, this.seq++);
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
		const detail = e instanceof Error && e.message ? `（${e.message}）` : "";
		this.abortTransport();
		this.releaseStream();
		this.capture = null;
		this.opts = null;
		this.events.onTentative?.("");
		this.set("error");
		this.events.onError?.({ code: "asr_stream_failed", message: `本地流式识别中断${detail}，已保留识别到的文字；未确认的尾句请重新录音` });
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
		this.model.reset();
		this.meter.reset();
		this.seq = 0;
		this.gotSpeech = false;
		this.sampleRate = TARGET_SAMPLE_RATE;
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

/** 会话打开失败：区分超时 / 后端不可用，都给可解释中文；**不假装已开始录音**。 */
export function streamOpenError(e: unknown): VoiceError {
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
