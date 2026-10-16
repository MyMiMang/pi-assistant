/**
 * 原生流式语音**纯逻辑单测**（不碰浏览器 / 真实麦克风 / 网络 / 真实数据）。
 *
 * 覆盖用户点名：
 *  - 稳定前缀（最长公共前缀，中文按字 / 英文按字符，只增不减）；
 *  - 句段模型：partial **覆盖** tentative、committed 只增补、final 只提交一次、重复 final 忽略、
 *    **重复口语「你好你好」原样保留（不 substring 去重）**、晚到 partial 忽略、final 与已确认不自洽不重复追加；
 *  - 分片器：200–400 ms 边界、**不丢样点（flush 尾片）**；
 *  - 控制器（假 transport）：串行 append（无并发叠发）、seq 单调、慢后端只积压缓冲（有界）、
 *    停止只 flush 尾片 + finish（不整段重传）、取消 / 隐藏 abort、打开失败 / 采集失败释放轨道、
 *    会话失败保留已确认文本且清除 tentative、60 s 上限触发停止、重试不重发旧音频；
 *  - 合成 PCM，不读用户录音。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VoiceCaptureHandle } from "../../../apps/web/src/voice-input.ts";
import {
	NativeVoiceController,
	pacify,
	StablePrefixTracker,
	StreamPacer,
	STREAM_MAX_CHUNK_MS,
	STREAM_MIN_CHUNK_MS,
	streamOpenError,
	VoiceStreamModel,
	longestCommonPrefix,
	type VoiceStreamOpenOptions,
	type VoiceStreamTransport,
} from "../../../apps/web/src/voice-stream.ts";

// ------------------------------------------------------------------ 合成音频 / 假件

const RATE = 16_000;
const CHUNK = RATE * (STREAM_MIN_CHUNK_MS / 1000); // 3200

/** 合成「有声」PCM（正弦波，幅度 0.4）。 */
function tone(ms: number, freq = 220): Float32Array {
	const n = Math.round((RATE * ms) / 1000);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin((2 * Math.PI * freq * i) / RATE);
	return out;
}
const samples = (chunks: ArrayLike<number>[]) => chunks.reduce((n, c) => n + c.length, 0);

class FakeTransport implements VoiceStreamTransport {
	appends: Array<{ seq: number; len: number }> = [];
	gate: (() => void) | null = null;
	finishCalled = 0;
	abortCalled = 0;
	private inflight = 0;
	maxInflight = 0;

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
}

function makeHarness(): Harness {
	const transport = new FakeTransport();
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
			startCapture: async (_stream, cb): Promise<VoiceCaptureHandle> => {
				captures++;
				if (failCapture) throw failCapture;
				onData = cb;
				return { sampleRate: RATE, stop: () => stopped++ };
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
		{},
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
	};
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** 反复放行在途 append，直到没有任何 append 在途。 */
async function drainSends(h: Harness, max = 200): Promise<void> {
	for (let i = 0; i < max; i++) {
		await flush();
		if (!h.transport.gate) break;
		h.transport.release();
	}
	await flush();
}

/** 跑一个会 await append 的控制器方法（stop），期间不断放行慢后端。 */
async function runWithGate(h: Harness, p: Promise<unknown>, max = 200): Promise<void> {
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

const startOpts = { provider: "local-online-zipformer", model: "streaming-zipformer", anchor: 3 };

// ------------------------------------------------------------------ 稳定前缀

test("longestCommonPrefix：英文按字符、中文按字", () => {
	assert.equal(longestCommonPrefix("hello", "help"), 3);
	assert.equal(longestCommonPrefix("你好世界", "你好呀"), 2);
	assert.equal(longestCommonPrefix("", "abc"), 0);
	assert.equal(longestCommonPrefix("abc", "abc"), 3);
});

test("StablePrefixTracker：稳定前缀只增不减", () => {
	const t = new StablePrefixTracker();
	assert.deepEqual(t.apply("你好世"), { committed: "", tentative: "你好世" });
	assert.deepEqual(t.apply("你好世界"), { committed: "你好世", tentative: "界" });
	// 模型纠正（回退）：已确认的「你好世」不回退
	assert.equal(t.apply("你好世").committed, "你好世");
	// 再长回：不重复确认
	assert.deepEqual(t.apply("你好世界啊"), { committed: "你好世", tentative: "界啊" });
});

// ------------------------------------------------------------------ 句段模型

test("句段模型：partial 覆盖 tentative，final 只提交一次，重复 final 忽略", () => {
	const m = new VoiceStreamModel();
	let r = m.apply({ kind: "partial", index: 0, text: "今天" });
	assert.deepEqual(r.commits, []);
	assert.equal(r.tentative, "今天");
	r = m.apply({ kind: "partial", index: 0, text: "今天天气" });
	assert.equal(r.tentative, "今天天气");
	r = m.apply({ kind: "final", index: 0, text: "今天天气不错" });
	assert.deepEqual(r.commits, [{ index: 0, text: "今天天气不错" }]);
	assert.equal(r.tentative, "");
	r = m.apply({ kind: "final", index: 0, text: "今天天气不错" });
	assert.deepEqual(r.commits, []);
	assert.equal(m.committedText(), "今天天气不错");
});

test("句段模型：committed（服务端稳定前缀）只增补，不回退", () => {
	const m = new VoiceStreamModel();
	const r1 = m.apply({ kind: "partial", index: 0, text: "你好世界", committed: "你好" });
	assert.deepEqual(r1.commits, [{ index: 0, text: "你好" }]);
	assert.equal(r1.tentative, "世界");
	const r2 = m.apply({ kind: "partial", index: 0, text: "你好世", committed: "你" });
	assert.deepEqual(r2.commits, []);
	const r3 = m.apply({ kind: "final", index: 0, text: "你好世界" });
	assert.deepEqual(r3.commits, [{ index: 0, text: "世界" }]);
});

test("句段模型：重复口语「你好你好」原样保留（不做 substring 去重）", () => {
	const m = new VoiceStreamModel();
	m.apply({ kind: "partial", index: 0, text: "你好你好", committed: "你好你好" });
	const r = m.apply({ kind: "final", index: 0, text: "你好你好" });
	assert.deepEqual(r.commits, []);
	assert.equal(m.committedText(), "你好你好");
});

test("句段模型：晚到 / 过期 partial 忽略；下一句 index 自增", () => {
	const m = new VoiceStreamModel();
	m.apply({ kind: "partial", index: 0, text: "第一句" });
	m.apply({ kind: "final", index: 0, text: "第一句。" });
	assert.deepEqual(m.apply({ kind: "partial", index: 0, text: "第一句。旧" }).commits, []);
	const r = m.apply({ kind: "final", text: "第二句。" });
	assert.deepEqual(r.commits, [{ index: 1, text: "第二句。" }]);
	assert.equal(m.committedText(), "第一句。第二句。");
});

test("句段模型：final 与已确认前缀不自洽时不重复追加", () => {
	const m = new VoiceStreamModel();
	m.apply({ kind: "partial", index: 0, text: "北京", committed: "北京" });
	const r = m.apply({ kind: "final", index: 0, text: "南京" });
	assert.equal(r.mismatch, true);
	assert.deepEqual(r.commits, []);
	assert.equal(m.committedText(), "北京");
});

// ------------------------------------------------------------------ 分片器

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
	const parts = [tone(137), tone(53), tone(401)];
	for (const c of parts) p.push(c);
	const out = p.drain(CHUNK);
	const tail = p.flush();
	if (tail) out.push(tail);
	assert.equal(samples(out), parts.reduce((n, c) => n + c.length, 0));
});

// ------------------------------------------------------------------ 控制器（假 transport）

test("控制器：会话先就绪再开采集，注册回调，进入 recording", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	assert.equal(h.controller.getState(), "recording");
	assert.equal(h.openCalls(), 1);
	assert.equal(h.captureStarted(), 1);
	assert.equal(h.lastOpen()!.sampleRate, RATE);
	assert.equal(h.lastOpen()!.provider, startOpts.provider);
});

test("控制器：串行 append、seq 单调、慢后端只积压缓冲（不并发叠发）", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	h.feed(tone(400)); // 6400 样点 = 2 片
	await flush();
	assert.equal(h.transport.appends.length, 1, "第一片发出后必须等 ack");
	assert.equal(h.transport.maxInflight, 1, "不允许并发 append");
	assert.equal(h.transport.appends[0].len, CHUNK);
	// 后端慢：继续喂音频只积压缓冲
	h.feed(tone(1500));
	await flush();
	assert.equal(h.transport.appends.length, 1);
	assert.ok(h.controller.progress().pending > 0, "缓冲里有未发送的完整片");
	await drainSends(h);
	const seqs = h.transport.appends.map((a) => a.seq);
	assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
	assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "seq 单调递增");
	assert.equal(samples(h.transport.appends.map((a) => new Array(a.len))), 28800, "只发完整片（余数留缓冲），无样点丢失");
	h.controller.cancel();
});

test("控制器：停止只 flush 尾片 + finish（不整段重发、尾音不丢）", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	h.feed(tone(250)); // 4000 样点：整片 3200 + 尾 800
	await flush();
	await runWithGate(h, h.controller.stop());
	assert.equal(h.controller.getState(), "idle");
	assert.equal(h.transport.finishCalled, 1);
	assert.equal(h.transport.appends.at(-1)!.len, 4000 - CHUNK, "尾片单独 flush，不重发整段");
	assert.equal(samples(h.transport.appends.map((a) => new Array(a.len))), 4000, "尾音不丢");
});

test("控制器：取消 abort 且不 finish；隐藏同样取消并释放轨道", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	h.feed(tone(300));
	await flush();
	h.controller.cancel();
	assert.equal(h.transport.abortCalled, 1);
	assert.equal(h.transport.finishCalled, 0);
	assert.equal(h.controller.getState(), "idle");
	assert.ok(h.tracksStopped() > 0, "轨道已释放");

	const h2 = makeHarness();
	await h2.controller.start(startOpts);
	h2.controller.onHidden();
	assert.equal(h2.transport.abortCalled, 1);
	assert.equal(h2.controller.getState(), "idle");
});

test("控制器：会话打开失败 → 释放麦克风、可解释错误、不进录音态", async () => {
	const h = makeHarness();
	h.setOpenFail(Object.assign(new Error("asr_stream_timeout"), { name: "TimeoutError" }));
	await h.controller.start(startOpts);
	assert.equal(h.controller.getState(), "error");
	assert.equal(h.captureStarted(), 0);
	assert.ok(h.tracksStopped() > 0);
});

test("控制器：采集启动失败 → abort 会话、释放轨道", async () => {
	const h = makeHarness();
	h.setCaptureFail(Object.assign(new Error("no mic"), { name: "NotFoundError" }));
	await h.controller.start(startOpts);
	assert.equal(h.controller.getState(), "error");
	assert.equal(h.transport.abortCalled, 1);
	assert.ok(h.tracksStopped() > 0);
});

test("控制器：会话失败保留已确认文本、清 tentative、不自动重发", async () => {
	const segs: string[] = [];
	const tentatives: string[] = [];
	const errors: string[] = [];
	const transport = new FakeTransport();
	let open: VoiceStreamOpenOptions | null = null;
	const controller = new NativeVoiceController(
		{
			getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) as unknown as MediaStream,
			startCapture: async () => {
				setTimeout(() => open?.onUpdate({ kind: "partial", index: 0, text: "已确认", committed: "已确认" }), 0);
				return { sampleRate: RATE, stop: () => {} };
			},
			openStream: async (o) => {
				open = o;
				return transport;
			},
		},
		{ onSegment: (s) => segs.push(s.text), onTentative: (t) => tentatives.push(t), onError: (e) => errors.push(e.code) },
	);
	await controller.start(startOpts);
	await flush();
	assert.deepEqual(segs, ["已确认"]);
	open!.onError(new Error("socket closed"));
	assert.equal(controller.getState(), "error");
	assert.equal(errors.at(-1), "asr_stream_failed");
	assert.equal(tentatives.at(-1), "");
	await controller.retryFailed();
	assert.equal(transport.appends.length, 0, "重试不重发旧音频");
});

test("控制器：60 s 上限触发停止（注入定时器）", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	assert.equal(h.controller.getState(), "recording");
	h.fireTimer();
	await flush();
	assert.equal(h.controller.getState(), "idle");
	assert.equal(h.transport.finishCalled, 1);
});

test("控制器：progress 标记 stream、failed 恒 0", async () => {
	const h = makeHarness();
	await h.controller.start(startOpts);
	h.feed(tone(500));
	await flush();
	const p = h.controller.progress();
	assert.equal(p.failed, 0);
	assert.equal(p.stream, true);
	h.controller.cancel();
});

// ------------------------------------------------------------------ 错误映射 / 工具

test("streamOpenError：超时 / 取消 / 未配置分别给稳定码", () => {
	assert.equal(streamOpenError(Object.assign(new Error("x"), { name: "TimeoutError" })).code, "asr_stream_timeout");
	assert.equal(streamOpenError(Object.assign(new Error("x"), { name: "AbortError" })).code, "asr_stream_aborted");
	assert.equal(streamOpenError(new Error("asr_not_configured")).code, "asr_not_configured");
	assert.equal(streamOpenError(new Error("boom")).code, "asr_stream_unavailable");
});

test("pacify：按 200 ms 切片，覆盖全部样点且不超 400 ms", () => {
	const out = pacify([tone(500)], RATE, STREAM_MIN_CHUNK_MS);
	assert.equal(samples(out), 8000);
	assert.ok(out.every((c) => c.length <= RATE * (STREAM_MAX_CHUNK_MS / 1000)));
});

test("句段模型：只有整句 partial 时由最长公共前缀算 committed", () => {
	const m = new VoiceStreamModel();
	assert.deepEqual(m.apply({ kind: "partial", index: 0, text: "一" }).commits, []);
	const r = m.apply({ kind: "partial", index: 0, text: "一二" });
	assert.deepEqual(r.commits, [{ index: 0, text: "一" }]);
	assert.equal(r.tentative, "二");
});
