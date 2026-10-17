/**
 * 原生流式语音**纯逻辑单测**（不碰浏览器 / 真实麦克风 / 网络 / 真实数据 / 真实下载）。
 *
 * 对齐已冻结契约（`default-local-voice/progress-snapshots/default-stream-contract.md` §2.3）：
 *  - `committed` = 该段**完整**稳定前缀（绝对量，只增不回退）；`tentative` = 该段**剩余部分完整文本**（绝对量整体替换）；
 *    展示 = `committed + tentative`；**前端不做最长公共前缀**（server-authoritative）；
 *  - 按 `segmentId` + `seq` 维护，重复 final 忽略、晚到 partial 不回滚、只 emit 新增稳定字符、重复口语保留；
 *  - 分片 200–400 ms 不丢样点、按 `maxChunkBytes` 切帧；48 k 采集**真重采样** 16 k（跨片连续、不漂移）；
 *  - 控制器（假 transport）：会话先就绪再开采集、串行 append、seq 单调、慢后端有界积压、
 *    stop 只 flush 尾片 + finish（final 只提交一次）、取消 / 隐藏 abort、打开 / 采集失败释放轨道、
 *    失败保留已确认文本、60 s 上限触发停止、重试不重发旧音频。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoiceError, VoiceProgress, VoiceSegment } from "../../../apps/web/src/voice-input.ts";
import {
	AsrStreamError,
	NativeVoiceController,
	normalizeStreamEvent,
	normalizeStreamEvents,
	pacify,
	splitInt16,
	StreamPacer,
	StreamResampler,
	STREAM_MAX_CHUNK_MS,
	STREAM_MIN_CHUNK_MS,
	streamFailureInfo,
	streamOpenError,
	VoiceStreamModel,
	type VoiceStreamOpenOptions,
	type VoiceStreamTransport,
} from "../../../apps/web/src/voice-stream.ts";

// ------------------------------------------------------------------ 合成音频 / 假件

const RATE = 16_000;
const CHUNK = (RATE * STREAM_MIN_CHUNK_MS) / 1000; // 3200

/** 合成「有声」PCM（正弦波，幅度 0.4）。 */
function tone(ms: number, freq = 220, rate = RATE): Float32Array {
	const n = Math.round((rate * ms) / 1000);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin((2 * Math.PI * freq * i) / rate);
	return out;
}
const samples = (chunks: ArrayLike<number>[]) => chunks.reduce((n, c) => n + c.length, 0);
/** 假 transport 已追加的总样点数。 */
const appended = (t: FakeTransport) => t.appends.reduce((n, a) => n + a.len, 0);

class FakeTransport implements VoiceStreamTransport {
	appends: Array<{ seq: number; len: number }> = [];
	gate: (() => void) | null = null;
	finishCalled = 0;
	abortCalled = 0;
	readonly limits;
	private inflight = 0;
	maxInflight = 0;

	constructor(maxChunkBytes = 32_000) {
		this.limits = { maxChunkBytes, maxSessionMs: 60_000, idleTimeoutMs: 10_000, partialIntervalHintMs: [200, 400] as [number, number], sampleRate: RATE };
	}

	append(pcm: Int16Array, seq: number): Promise<void> {
		this.inflight++;
		this.maxInflight = Math.max(this.maxInflight, this.inflight);
		this.appends.push({ seq, len: pcm.length });
		return new Promise<void>((resolve) => {
			this.gate = () => {
				this.inflight--;
				resolve();
			};
		});
	}
	finish(): Promise<void> {
		this.finishCalled++;
		return Promise.resolve();
	}
	abort(): void {
		this.abortCalled++;
	}
	release(): void {
		const g = this.gate;
		this.gate = null;
		g?.();
	}
}

interface Harness {
	controller: NativeVoiceController;
	transport: FakeTransport;
	lastOpen: () => VoiceStreamOpenOptions | null;
	feed: (pcm: Float32Array) => void;
	tracksStopped: () => number;
	openCalls: () => number;
	captureStarted: () => number;
	fireTimer: () => void;
	setOpenFail: (e: unknown) => void;
	setCaptureFail: (e: unknown) => void;
	segments: VoiceSegment[];
	tentatives: string[];
	errors: VoiceError[];
	states: string[];
	progress: VoiceProgress[];
	noSpeech: () => number;
}

function makeHarness(opts: { captureRate?: number; openDelay?: boolean } = {}): Harness {
	const captureRate = opts.captureRate ?? RATE;
	const transport = new FakeTransport();
	const segments: VoiceSegment[] = [];
	const tentatives: string[] = [];
	const errors: VoiceError[] = [];
	const states: string[] = [];
	const progress: VoiceProgress[] = [];
	let noSpeechCount = 0;
	let lastOpen: VoiceStreamOpenOptions | null = null;
	let onData: ((c: Float32Array) => void) | null = null;
	let stopped = 0;
	let opens = 0;
	let captures = 0;
	let failOpen: unknown;
	let failCapture: unknown;
	const timers: Array<() => void> = [];
	const controller = new NativeVoiceController(
		{
			getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }) as unknown as MediaStream,
			startCapture: async (_stream, cb): Promise<{ sampleRate: number; stop: () => void }> => {
				captures++;
				if (failCapture) throw failCapture;
				onData = cb;
				return { sampleRate: captureRate, stop: () => stopped++ };
			},
			openStream: async (o): Promise<VoiceStreamTransport> => {
				opens++;
				if (failOpen) throw failOpen;
				lastOpen = o;
				return transport;
			},
			setTimer: (fn) => {
				timers.push(fn);
				return fn;
			},
			clearTimer: (t) => {
				const i = timers.indexOf(t as () => void);
				if (i >= 0) timers.splice(i, 1);
			},
		},
		{
			onState: (s) => states.push(s),
			onSegment: (s) => segments.push(s),
			onTentative: (t) => tentatives.push(t),
			onError: (e) => errors.push(e),
			onProgress: (p) => progress.push(p),
			onNoSpeech: () => noSpeechCount++,
		},
	);
	return {
		controller,
		transport,
		lastOpen: () => lastOpen,
		feed: (pcm) => onData?.(pcm),
		tracksStopped: () => stopped,
		openCalls: () => opens,
		captureStarted: () => captures,
		fireTimer: () => timers[0]?.(),
		setOpenFail: (e) => {
			failOpen = e;
		},
		setCaptureFail: (e) => {
			failCapture = e;
		},
		segments,
		tentatives,
		errors,
		states,
		progress,
		noSpeech: () => noSpeechCount,
	};
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** 反复放行在途 append，直到没有任何 append 在途。 */
async function drainSends(h: Harness, max = 400): Promise<void> {
	for (let i = 0; i < max; i++) {
		await flush();
		if (!h.transport.gate) break;
		h.transport.release();
	}
	await flush();
}

/** 跑一个会 await append 的控制器方法（stop），期间不断放行慢后端。 */
async function runWithGate(h: Harness, p: Promise<unknown>, max = 400): Promise<void> {
	let done = false;
	const wrapped = p.finally(() => {
		done = true;
	});
	for (let i = 0; i < max && !done; i++) {
		await flush();
		if (h.transport.gate) h.transport.release();
	}
	await wrapped;
}

const startOpts = { provider: "local-online-zipformer", model: "streaming-zipformer-bilingual-zh-en-int8", anchor: 3 };

// ------------------------------------------------------------------ 线协议归一化

test("normalizeStreamEvent：契约事件归一（committed 是完整前缀，tentative 是剩余部分）", () => {
	assert.deepEqual(normalizeStreamEvent({ type: "committed", text: "你好", segmentId: "0", seq: 2 }), { kind: "committed", segmentId: "0", text: "你好", seq: 2 });
	assert.deepEqual(normalizeStreamEvent({ type: "tentative", text: "世界", segmentId: 1, seq: 3 }), { kind: "tentative", segmentId: "1", text: "世界", seq: 3 });
	assert.deepEqual(normalizeStreamEvent({ type: "final", text: "你好世界", segmentId: "1", seq: 4 }), { kind: "final", segmentId: "1", text: "你好世界", seq: 4 });
	assert.deepEqual(normalizeStreamEvent({ type: "endpoint", segmentId: "1", seq: 4 }), { kind: "endpoint", segmentId: "1", seq: 4 });
	// 未知类型 / 缺 segmentId / 非对象：一律丢弃（不猜）
	assert.equal(normalizeStreamEvent({ type: "mystery", text: "x", segmentId: "0" }), null);
	assert.equal(normalizeStreamEvent({ type: "committed", text: "x" }), null);
	assert.equal(normalizeStreamEvent(null), null);
	assert.equal(normalizeStreamEvent("nope"), null);
	assert.deepEqual(normalizeStreamEvents([{ type: "committed", text: "a", segmentId: "0" }, { type: "bogus" }, null]), [{ kind: "committed", segmentId: "0", text: "a", seq: undefined }]);
	assert.deepEqual(normalizeStreamEvents(undefined), []);
});

// ------------------------------------------------------------------ 句段模型（server-authoritative）

test("句段模型：committed 是绝对前缀快照，只提交新增字符（不重复追加）", () => {
	const m = new VoiceStreamModel();
	let r = m.apply({ kind: "committed", segmentId: "0", text: "你好" });
	assert.deepEqual(r.commits, [{ index: 0, segmentId: "0", text: "你好" }]);
	assert.equal(r.tentative, "");
	// 前缀不变：不产出增补
	assert.deepEqual(m.apply({ kind: "committed", segmentId: "0", text: "你好" }).commits, []);
	// 前缀增长：只产出新增
	r = m.apply({ kind: "committed", segmentId: "0", text: "你好世界" });
	assert.deepEqual(r.commits, [{ index: 0, segmentId: "0", text: "世界" }]);
	assert.equal(m.committedText(), "你好世界");
	// 前缀“回退”（服务端纠正 / 乱序）：不回退、不重复追加
	r = m.apply({ kind: "committed", segmentId: "0", text: "你好" });
	assert.deepEqual(r.commits, []);
	assert.equal(m.committedText(), "你好世界");
});

test("句段模型：tentative 整体替换，展示=committed+tentative，不做 substring 去重", () => {
	const m = new VoiceStreamModel();
	m.apply({ kind: "committed", segmentId: "0", text: "你好" });
	const r1 = m.apply({ kind: "tentative", segmentId: "0", text: "你好你好" });
	assert.equal(r1.tentative, "你好你好");
	// 同一段整段覆盖（不是拼接）
	const r2 = m.apply({ kind: "tentative", segmentId: "0", text: "你好你好世界" });
	assert.equal(r2.tentative, "你好你好世界");
	// 展示 = committed + tentative（绝对量直接拼接）
	assert.equal(m.committedText() + r2.tentative, "你好你好你好世界");
	assert.equal(m.committedText(), "你好");
});

test("句段模型：final 只提交剩余部分、重复 final 忽略、晚到 partial 不回滚", () => {
	const m = new VoiceStreamModel();
	m.apply({ kind: "committed", segmentId: "0", text: "今天" });
	m.apply({ kind: "tentative", segmentId: "0", text: "天气" });
	let r = m.apply({ kind: "final", segmentId: "0", text: "今天天气不错" });
	assert.deepEqual(r.commits, [{ index: 0, segmentId: "0", text: "天气不错" }]);
	assert.equal(r.tentative, "");
	assert.equal(m.committedText(), "今天天气不错");
	// 重复 final：忽略（不重复追加）
	assert.deepEqual(m.apply({ kind: "final", segmentId: "0", text: "今天天气不错" }).commits, []);
	assert.equal(m.committedText(), "今天天气不错");
	// 晚到 partial：忽略
	assert.deepEqual(m.apply({ kind: "committed", segmentId: "0", text: "今天天气不错啊" }).commits, []);
	assert.deepEqual(m.apply({ kind: "tentative", segmentId: "0", text: "旧" }).commits, []);
	assert.equal(m.committedText(), "今天天气不错");
	// 下一段：独立 committed，按段序拼接
	r = m.apply({ kind: "committed", segmentId: "1", text: "第二句" });
	assert.deepEqual(r.commits, [{ index: 1, segmentId: "1", text: "第二句" }]);
	assert.equal(m.committedText(), "今天天气不错第二句");
});

test("句段模型：seq 回退的事件忽略（晚到不回滚）", () => {
	const m = new VoiceStreamModel();
	m.apply({ kind: "committed", segmentId: "0", text: "第一", seq: 5 });
	const r = m.apply({ kind: "committed", segmentId: "0", text: "第一次", seq: 3 });
	assert.deepEqual(r.commits, []);
	assert.equal(m.committedText(), "第一");
});

test("句段模型：final 与已确认前缀冲突时不重复追加（已确认部分不重写）", () => {
	const m = new VoiceStreamModel();
	m.apply({ kind: "committed", segmentId: "0", text: "北京" });
	const r = m.apply({ kind: "final", segmentId: "0", text: "南京" });
	assert.equal(r.mismatch, true);
	assert.deepEqual(r.commits, []);
	assert.equal(m.committedText(), "北京");
});

test("句段模型：committed 与已确认前缀冲突（协议外）时报 mismatch、不回退", () => {
	const m = new VoiceStreamModel();
	m.apply({ kind: "committed", segmentId: "0", text: "你好世" });
	const r = m.apply({ kind: "committed", segmentId: "0", text: "你好啊" });
	assert.equal(r.mismatch, true);
	assert.deepEqual(r.commits, []);
	assert.equal(m.committedText(), "你好世");
});

test("句段模型：endpoint 不产文本；只有整句时的 LCP helper 不参与 wire", () => {
	const m = new VoiceStreamModel();
	m.apply({ kind: "final", segmentId: "0", text: "第一句" });
	const r = m.apply({ kind: "endpoint", segmentId: "1", seq: 3 });
	assert.deepEqual(r.commits, []);
	assert.equal(m.committedText(), "第一句");
	assert.equal(m.snapshot()[0].finalized, true);
});

// ------------------------------------------------------------------ 分片器 / 切帧

test("StreamPacer：按 200 ms 切片、样点不丢、flush 取尾片", () => {
	const p = new StreamPacer();
	p.push(tone(520)); // 8320 样点
	const drained = p.drain(CHUNK);
	assert.deepEqual(drained.map((c) => c.length), [CHUNK, CHUNK]);
	assert.equal(p.bufferedSamples, 8320 - 2 * CHUNK);
	const tail = p.flush();
	assert.equal(tail?.length, 8320 - 2 * CHUNK);
	assert.equal(p.bufferedSamples, 0);
	assert.equal(samples(drained) + (tail?.length ?? 0), 8320);
	assert.equal(p.flush(), null);
});

test("StreamPacer：跨分片边界不丢样点", () => {
	const p = new StreamPacer();
	for (let i = 0; i < 10; i++) p.push(tone(17)); // 每片 272 样点，10 片共 2720
	const out = p.drain(CHUNK); // 不足 3200：无完整片
	assert.equal(out.length, 0);
	const tail = p.flush();
	assert.equal(tail?.length, 2720);
});

test("splitInt16：按 maxChunkBytes 切帧、样点不丢、每帧不超上限", () => {
	const pcm = new Int16Array(10_000);
	const frames = splitInt16(pcm, 4096);
	assert.deepEqual(frames.map((f) => f.length), [4096, 4096, 1808]);
	assert.equal(samples(frames), 10_000);
	assert.deepEqual(splitInt16(new Int16Array(10), 4096).map((f) => f.length), [10]);
});

// ------------------------------------------------------------------ 流式重采样（48 k → 16 k）

test("StreamResampler：48 k → 16 k 跨片连续，输出长度 = ceil(N/3)，与整段一次重采样同长", () => {
	const r = new StreamResampler(48_000, 16_000);
	const parts: Float32Array[] = [];
	let total = 0;
	for (let i = 0; i < 10; i++) {
		const c = r.push(tone(17, 300, 48_000)); // 每片 816 样点
		total += c.length;
		parts.push(c);
	}
	const tail = r.flush();
	total += tail.length;
	const input = 816 * 10;
	assert.equal(total, Math.ceil(input / 3));
	// 跨片输出严格相接：第 i 片末与第 i+1 片首不为“恒等重复”（纯正弦下等价于连续重采样）
	const merged = new Float32Array(total);
	let at = 0;
	for (const p of [...parts, tail]) {
		merged.set(p, at);
		at += p.length;
	}
	// 与一次性重采样对比（前 100 个样点误差极小）
	const once = new StreamResampler(48_000, 16_000);
	const oneShot = once.push(new Float32Array(816 * 10).map((_, i) => Math.sin((2 * Math.PI * 300 * i) / 48_000) * 0.4));
	for (let i = 0; i < 100; i++) assert.ok(Math.abs(merged[i] - oneShot[i]) < 1e-6, `第 ${i} 个样点应一致`);
});

test("StreamResampler：16 k 输入时也不制造 gap（流式会挂起最后 1 个样点，flush 补齐）", () => {
	const r = new StreamResampler(16_000, 16_000);
	const chunk = tone(200); // 3200 样点
	const first = r.push(chunk);
	assert.equal(first.length + r.flush().length, chunk.length);
	assert.equal(r.flush().length, 0);
});

// ------------------------------------------------------------------ 控制器（假 transport）

test("控制器：会话先就绪再开采集，注册回调，进入 recording", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	assert.equal(h.controller.getState(), "recording");
	assert.equal(h.openCalls(), 1);
	assert.equal(h.captureStarted(), 1);
	assert.equal(h.lastOpen()?.model, startOpts.model);
	assert.ok(h.states.includes("preparing"));
	assert.ok(h.states.includes("recording"));
});

test("控制器：串行 append、seq 单调、慢后端只积压缓冲（不并发叠发）", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	h.feed(tone(1000)); // 1 s → 5 片
	await drainSends(h);
	assert.ok(h.transport.maxInflight <= 1, "append 必须串行");
	assert.deepEqual(
		h.transport.appends.map((a) => a.seq),
		h.transport.appends.map((_, i) => i),
	);
	assert.equal(appended(h.transport), 16_000);
});

test("控制器：48 k 采集真重采样成 16 k 再追加（不把 48 k 当 16 k 发）", async () => {
	const h = makeHarness({ captureRate: 48_000 });
	await h.controller.start(startOpts);
	h.feed(tone(4000, 220, 48_000)); // 4 s @48k = 192000 输入样点
	await drainSends(h);
	// 期望 ≈ 16 k * 4 s = 64000 样点（不是 192000）
	const got = appended(h.transport);
	assert.ok(Math.abs(got - 64_000) <= 2, `重采样后样点数应≈64000，实际 ${got}`);
});

test("控制器：停止只 flush 尾片 + finish（不整段重发、尾音不丢）", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	h.feed(tone(500)); // 2 整片 + 余 1600
	await drainSends(h);
	const before = appended(h.transport);
	await runWithGate(h, h.controller.stop());
	assert.equal(h.transport.finishCalled, 1);
	const after = appended(h.transport);
	assert.equal(after, 8000);
	assert.ok(after >= before);
	assert.equal(h.controller.getState(), "idle");
});

test("控制器：final 事件只提交一次（与已提交前缀不重复）", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	// 通过归一化回调直接喂事件（模拟 api.ts 解析后的更新）
	const open = h.lastOpen()!;
	open.onUpdate({ kind: "committed", segmentId: "0", text: "你好" });
	open.onUpdate({ kind: "tentative", segmentId: "0", text: "世界" });
	open.onUpdate({ kind: "final", segmentId: "0", text: "你好世界" });
	h.feed(tone(300));
	await runWithGate(h, h.controller.stop());
	assert.deepEqual(
		h.segments.map((s) => s.text),
		["你好", "世界"],
	);
});

test("控制器：取消 abort 且不 finish；隐藏同样取消并释放轨道", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	h.feed(tone(300));
	await drainSends(h);
	h.controller.cancel();
	assert.equal(h.transport.abortCalled, 1);
	assert.equal(h.transport.finishCalled, 0);
	assert.equal(h.controller.getState(), "idle");
	assert.ok(h.tracksStopped() > 0);

	const h2 = makeHarness();
	await h2.controller.start(startOpts);
	h2.controller.onHidden();
	assert.equal(h2.transport.abortCalled, 1);
	assert.equal(h2.controller.getState(), "idle");
});

test("控制器：会话打开失败 → 释放麦克风、可解释错误、不进录音态", async () => {
	const h = makeHarness();
	h.setOpenFail(new AsrStreamError("asr_not_ready", 409, "未准备"));
	await h.controller.start(startOpts);
	assert.equal(h.controller.getState(), "error");
	assert.equal(h.captureStarted(), 0);
	assert.ok(h.tracksStopped() > 0);
	assert.equal(h.errors[0]?.code, "asr_not_ready");
});

test("控制器：采集启动失败 → abort 会话、释放轨道", async () => {
	const h = makeHarness();
	h.setCaptureFail(new Error("no mic"));
	await h.controller.start(startOpts);
	assert.equal(h.transport.abortCalled, 1);
	assert.equal(h.controller.getState(), "error");
	assert.ok(h.tracksStopped() > 0);
});

test("控制器：会话失败保留已确认文本、清 tentative、不自动重发", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	const open = h.lastOpen()!;
	open.onUpdate({ kind: "committed", segmentId: "0", text: "已确认" });
	open.onUpdate({ kind: "tentative", segmentId: "0", text: "未确认" });
	open.onError(new Error("socket broke"));
	const appendsBefore = h.transport.appends.length;
	assert.equal(h.controller.getState(), "error");
	assert.deepEqual(
		h.segments.map((s) => s.text),
		["已确认"],
	);
	assert.equal(h.tentatives.at(-1), "");
	assert.equal(h.transport.appends.length, appendsBefore, "失败后不自动重发旧音频");
});

test("控制器：60 s 上限触发停止（注入定时器）", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	h.feed(tone(300));
	await drainSends(h);
	h.fireTimer();
	for (let i = 0; i < 200 && !h.transport.finishCalled && !h.transport.abortCalled; i++) {
		await flush();
		h.transport.release();
	}
	assert.ok(h.transport.finishCalled >= 1 || h.transport.abortCalled >= 1);
});

test("控制器：progress 标记 stream、failed 恒 0", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	h.feed(tone(500));
	await drainSends(h);
	const last = h.progress.at(-1);
	assert.equal(last?.stream, true);
	assert.equal(last?.failed, 0);
	assert.equal(h.controller.progress().stream, true);
});

test("streamOpenError / streamFailureInfo：按 code 给稳定中文，不假装开始", () => {
	assert.equal(streamOpenError(Object.assign(new Error("asr_stream_timeout"), { name: "TimeoutError" })).code, "asr_stream_timeout");
	assert.equal(streamOpenError(Object.assign(new Error("x"), { name: "AbortError" })).code, "asr_stream_aborted");
	assert.equal(streamOpenError(new Error("asr_not_configured")).code, "asr_not_configured");
	assert.equal(streamFailureInfo({ code: "asr_source_changed" }).message.includes("来源已变"), true);
	assert.equal(streamFailureInfo({ code: "asr_stream_expired" }).code, "asr_stream_expired");
	assert.equal(streamFailureInfo(new Error("boom")).code, "asr_stream_failed");
});

test("pacify：按 200 ms 切片，覆盖全部样点且不超 400 ms", () => {
	const chunks = [tone(123), tone(456)];
	const frames = pacify(chunks);
	assert.equal(samples(frames), 123 * 16 + 456 * 16);
	for (const f of frames) assert.ok(f.length <= (RATE * STREAM_MAX_CHUNK_MS) / 1000);
});
