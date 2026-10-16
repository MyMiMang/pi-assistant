/**
 * 语音输入**分段增量**纯逻辑单测（不碰浏览器 / 真实麦克风 / 网络 / 真实数据）。
 *
 * 覆盖用户点名：
 *  - 合成 PCM 的**真实音量**（静音近零、有声非零、平滑限频）；
 *  - 停顿 VAD 分段 + 最长窗口（**有界段数**）；积压时合段不丢音频；停止 flush 尾段；
 *  - 分段重采样**连续**（相邻段拼起来 == 整段，无 gap / 无漂移）；
 *  - 控制器增量：单并发、段序正确、每段唯一 requestId、停止只等在途+尾段、取消丢未应用结果、失败有界重试且只重发失败段；
 *  - 草稿装配：按序追加、用户编辑（前 / 段内 / 删字）后仍接在语音块末尾、不重复；
 *  - 中文 / 英文拼接不插错空格。
 *
 * 假 provider 用可控延迟模拟慢模型；音频全是合成信号，不读用户录音。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AsrLeaseManager,
	computeLevel,
	concatFloat32,
	encodeWav16,
	LevelMeter,
	MAX_PENDING_SEGMENTS,
	mapPositionThroughEdit,
	needsSeparator,
	normalizeLevel,
	resampleTo16k,
	resampleTo16kRange,
	segmentToPcm16,
	smartJoin,
	SpeechSegmenter,
	VoiceDraftAssembler,
	VoiceInputController,
	VOICE_SILENCE_RMS,
	type SpeechSegmentRange,
	type VoiceCaptureHandle,
	type VoiceControllerDeps,
	type VoiceSegment,
} from "../../../apps/web/src/voice-input.ts";
import { ASR_MAX_DURATION_MS } from "../src/voice/contract.ts";
import { parseWav, validateAsrAudio } from "../src/voice/asr.ts";

const RATE = 16_000;

/** 合成有声信号（正弦，幅度 0.3，远高于静音阈值）。 */
function speech(ms: number, amp = 0.3, rate = RATE): Float32Array {
	const n = Math.round((rate * ms) / 1000);
	const a = new Float32Array(n);
	for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * 220 * i) / rate);
	return a;
}
/** 合成静音（近零，带极低噪声）。 */
function silence(ms: number, rate = RATE): Float32Array {
	const n = Math.round((rate * ms) / 1000);
	const a = new Float32Array(n);
	for (let i = 0; i < n; i++) a[i] = (i % 7) * 1e-5; // ~1e-5，远低于阈值
	return a;
}

// ---------------------------------------------------------------- 音量（真实 PCM）
test("computeLevel：静音近零、有声非零，peak 取绝对值最大", () => {
	assert.ok(computeLevel(silence(100)).rms < 1e-3);
	const s = speech(100);
	const lv = computeLevel(s);
	assert.ok(lv.rms > 0.1);
	assert.ok(lv.peak > 0.25 && lv.peak <= 0.31);
});

test("normalizeLevel：静音严格 0，有声落在 0..1", () => {
	assert.equal(normalizeLevel(0), 0);
	assert.equal(normalizeLevel(VOICE_SILENCE_RMS * 0.5), 0);
	const v = normalizeLevel(0.3);
	assert.ok(v > 0 && v <= 1);
});

test("LevelMeter：静音收敛到 0，限频返回 null 直到间隔到", () => {
	let now = 0;
	const m = new LevelMeter({ minIntervalMs: 80, now: () => now });
	// 第一帧有声：立即回报
	const first = m.push(speech(20), now);
	assert.ok(first !== null && first > 0);
	// 间隔未到：返回 null（不更新 UI）
	now += 10;
	assert.equal(m.push(speech(20), now), null);
	// 间隔到了：回报
	now += 100;
	assert.ok(m.push(speech(20), now) !== null);
	// 静音：平滑收敛到 0（真实，不假跳动）
	for (let i = 0; i < 60; i++) {
		now += 100;
		m.push(silence(20), now);
	}
	assert.equal(m.get(), 0);
});

// ---------------------------------------------------------------- 分段重采样连续（无 gap / 无漂移）
test("resampleTo16kRange：相邻段拼起来 == 整段重采样（无 gap / 无重复 / 不漂移）", () => {
	const raw = new Float32Array(48_000);
	for (let i = 0; i < raw.length; i++) raw[i] = Math.sin((2 * Math.PI * 180 * i) / 48_000);
	const full = resampleTo16k(raw, 48_000);
	for (const mid of [1, 5_000, 20_000, 33_333, 47_999]) {
		const a = resampleTo16kRange(raw, 48_000, 0, mid);
		const b = resampleTo16kRange(raw, 48_000, mid, raw.length);
		const joined = new Float32Array(a.length + b.length);
		joined.set(a, 0);
		joined.set(b, a.length);
		assert.equal(joined.length, full.length, `mid=${mid} 长度应一致`);
		for (let i = 0; i < full.length; i++) assert.ok(Math.abs(joined[i] - full[i]) < 1e-5, `mid=${mid} 第 ${i} 个采样应连续`);
	}
});

test("segmentToPcm16：相邻段 PCM 拼接 == 整段 PCM（分段不制造 gap）", () => {
	const raw = new Float32Array(16_000 * 2);
	for (let i = 0; i < raw.length; i++) raw[i] = Math.sin((2 * Math.PI * 200 * i) / RATE) * 0.4;
	const full = segmentToPcm16(raw, RATE, 0, raw.length);
	const a = segmentToPcm16(raw, RATE, 0, 10_000);
	const b = segmentToPcm16(raw, RATE, 10_000, raw.length);
	const joined = new Int16Array(a.length + b.length);
	joined.set(a, 0);
	joined.set(b, a.length);
	assert.equal(joined.length, full.length);
	assert.deepEqual([...joined], [...full]);
});

// ---------------------------------------------------------------- 停顿 VAD 分段
test("SpeechSegmenter：有声 + 停顿 → 合一段；纯静音 → 不合段", () => {
	const seg = new SpeechSegmenter(RATE);
	const out = [...seg.push(speech(1000)), ...seg.push(silence(800))];
	assert.equal(out.length, 1);
	assert.equal(out[0].startIn, 0);
	assert.ok(out[0].endIn > RATE && out[0].endIn <= RATE * 1.2, "段应覆盖语音 + 少量尾静音");
	assert.equal(seg.flush(), null, "段已合上，收尾无尾段");

	const quiet = new SpeechSegmenter(RATE);
	assert.deepEqual(quiet.push(silence(3000)), []);
	assert.equal(quiet.flush(), null, "纯静音没有内容可丢");
});

test("SpeechSegmenter：连续长语音按最长窗口切成有界多段", () => {
	const seg = new SpeechSegmenter(RATE, { maxSegmentMs: 3000 });
	const out = seg.push(speech(9500));
	assert.equal(out.length, 3, "9.5s / 3s 上限 → 至少 3 段");
	for (const r of out) assert.ok((r.endIn - r.startIn) / RATE <= 3.05);
	// 每段都落在原始采样坐标上、首尾相接（不重叠、不留缝）
	for (let i = 1; i < out.length; i++) assert.equal(out[i].startIn, out[i - 1].endIn);
});

test("SpeechSegmenter：积压时不合段（把语音并进当前段），解除后一次合上——不丢音频", () => {
	const seg = new SpeechSegmenter(RATE);
	seg.setBackpressure(true);
	assert.deepEqual(seg.push(speech(1000)), []);
	assert.deepEqual(seg.push(silence(800)), []);
	seg.setBackpressure(false);
	const out = seg.push(silence(20)); // 一帧即可触发（静音已累计够）
	assert.equal(out.length, 1);
	assert.equal(out[0].startIn, 0);
	assert.ok(out[0].endIn >= RATE, "合并段应覆盖被并进来的语音");
});

test("SpeechSegmenter：停止时 flush 尾部（短但有语音不丢）", () => {
	const seg = new SpeechSegmenter(RATE);
	seg.push(speech(400));
	const tail = seg.flush();
	assert.ok(tail);
	assert.equal(tail!.hasSpeech, true);
	assert.equal(tail!.startIn, 0);
});

// ---------------------------------------------------------------- 草稿装配
test("VoiceDraftAssembler：按序追加到锚点，段序不乱", () => {
	const a = new VoiceDraftAssembler(1, "前中后");
	assert.deepEqual(a.append("前中后", "甲"), { text: "前甲中后", cursor: 2 });
	assert.deepEqual(a.append("前甲中后", "乙"), { text: "前甲乙中后", cursor: 3 });
});

test("VoiceDraftAssembler：用户在语音块之前编辑 → 段仍接在语音块末尾", () => {
	const a = new VoiceDraftAssembler(1, "前中后");
	a.append("前中后", "甲");
	a.append("前甲中后", "乙"); // 语音块 = "甲乙"，cursor 3
	const r = a.append("序前甲乙中后", "丙"); // 用户在前面插了 "序"
	assert.equal(r.text, "序前甲乙丙中后");
});

test("VoiceDraftAssembler：用户在语音块内编辑 → 不覆盖编辑，段接在块末尾", () => {
	const a = new VoiceDraftAssembler(1, "前中后");
	a.append("前中后", "甲");
	a.append("前甲中后", "乙");
	const r = a.append("前甲丙乙中后", "丁"); // 用户在语音块内插入 "丙"
	assert.equal(r.text, "前甲丙乙丁中后");
});

test("VoiceDraftAssembler：用户删掉语音块 → 段插到原位置，不重复", () => {
	const a = new VoiceDraftAssembler(1, "前中后");
	a.append("前中后", "甲");
	a.append("前甲中后", "乙");
	const r = a.append("前中后", "丙"); // 用户删掉 "甲乙"
	assert.equal(r.text, "前丙中后");
});

test("mapPositionThroughEdit：前缀 / 段内 / 后缀三种编辑位置映射正确", () => {
	assert.equal(mapPositionThroughEdit("abc", "Xabc", 2), 3); // 前面插入 → 平移
	assert.equal(mapPositionThroughEdit("abc", "abcX", 2), 2); // 后面追加 → 不动
	assert.equal(mapPositionThroughEdit("abXYef", "abQef", 4), 3); // 语音块被替换 → 落到替换区末尾
	assert.equal(mapPositionThroughEdit("abXYef", "abQef", 2), 2); // 替换区之前 → 不动
	assert.equal(mapPositionThroughEdit("abc", "abc", 2), 2);
});

test("needsSeparator / smartJoin：英文补空格，中文直接接", () => {
	assert.equal(needsSeparator("o", "w"), true);
	assert.equal(needsSeparator("你", "世"), false);
	assert.equal(smartJoin(["你好", "世界"]), "你好世界");
	assert.equal(smartJoin(["hello", "world"]), "hello world");
	assert.equal(smartJoin(["你", "", "好"]), "你好");
});

// ---------------------------------------------------------------- 控制器（增量）
function fakeStream() {
	const track = {
		stopped: false,
		stop() {
			this.stopped = true;
		},
	};
	return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

interface IncCalls {
	getUserMedia: number;
	transcribe: number;
	requestIds: string[];
	providerModels: { provider: string; model: string }[];
	concurrent: number;
	maxConcurrent: number;
	captureStop: number;
}

function incDeps(over: Partial<VoiceControllerDeps> & { sampleRate?: number; transcribeImpl?: (i: { requestId: string; signal: AbortSignal }) => Promise<{ text: string }> } = {}) {
	const { stream, track } = fakeStream();
	const calls: IncCalls = { getUserMedia: 0, transcribe: 0, requestIds: [], providerModels: [], concurrent: 0, maxConcurrent: 0, captureStop: 0 };
	let emit: ((c: Float32Array) => void) | null = null;
	const d: VoiceControllerDeps = {
		getUserMedia: async () => {
			calls.getUserMedia++;
			return stream;
		},
		startCapture: async (_s, onData): Promise<VoiceCaptureHandle> => {
			emit = onData;
			return { sampleRate: over.sampleRate ?? RATE, stop: () => { calls.captureStop++; } };
		},
		transcribe: async (i) => {
			calls.transcribe++;
			calls.requestIds.push(i.requestId);
			calls.providerModels.push({ provider: i.provider, model: i.model });
			calls.concurrent++;
			calls.maxConcurrent = Math.max(calls.maxConcurrent, calls.concurrent);
			try {
				if (over.transcribeImpl) return await over.transcribeImpl(i);
				return { text: `段${calls.transcribe}` };
			} finally {
				calls.concurrent--;
			}
		},
		...over,
	};
	return { d, calls, track, feed: (c: Float32Array) => emit?.(c) };
}

const tick = (ms = 8) => new Promise((r) => setTimeout(r, ms));

test("增量控制器：有声+停顿 → 每段一次请求、段序正确、每段唯一 requestId", async () => {
	const { d, calls, feed } = incDeps();
	const segs: VoiceSegment[] = [];
	const c = new VoiceInputController(d, { onSegment: (s) => segs.push(s) });
	await c.start({ provider: "p", model: "m", anchor: 5, incremental: true, conversationId: "c1" });
	feed(speech(1000));
	feed(silence(800));
	await tick();
	feed(speech(1000));
	feed(silence(800));
	await tick();
	assert.equal(calls.transcribe, 2);
	assert.deepEqual(segs.map((s) => s.index), [0, 1]);
	assert.equal(new Set(calls.requestIds).size, 2, "每段 requestId 唯一");
	assert.equal(calls.maxConcurrent, 1, "同一时刻最多 1 个在途");
	await c.stop();
	assert.deepEqual(segs.map((s) => s.index), [0, 1]);
});

test("增量控制器：停止只等「在途 + 尾段」，不整段重传；尾段不丢", async () => {
	const { d, calls, feed } = incDeps();
	const segs: VoiceSegment[] = [];
	const c = new VoiceInputController(d, { onSegment: (s) => segs.push(s) });
	await c.start({ provider: "p", model: "m", anchor: 0, incremental: true });
	feed(speech(1200)); // 没有停顿 → 只有尾段
	await c.stop();
	assert.equal(calls.transcribe, 1, "只转写尾段一次，不整段重传");
	assert.equal(segs.length, 1);
	assert.equal(c.getState(), "idle");
});

test("增量控制器：慢模型积压时不合新段（有界队列），不丢音频", async () => {
	let release: (() => void) | null = null;
	const first = new Promise<void>((r) => {
		release = r;
	});
	const { d, calls, feed } = incDeps({
		transcribeImpl: async ({ signal }) => {
			await first;
			if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
			return { text: "ok" };
		},
	});
	const progress: number[] = [];
	const c = new VoiceInputController(d, { onProgress: (p) => progress.push(p.pending) });
	await c.start({ provider: "p", model: "m", anchor: 0, incremental: true });
	feed(speech(1000));
	feed(silence(800)); // 段 1 → 在途（被 first 挂住）
	await tick();
	feed(speech(1000));
	feed(silence(800)); // 段 2 → 等待队列
	await tick();
	feed(speech(1000));
	feed(silence(800)); // 积压 → 应合进段 2，不再新增
	await tick();
	assert.ok(c.progress().pending + c.progress().inflight <= MAX_PENDING_SEGMENTS, `队列应 <= ${MAX_PENDING_SEGMENTS}`);
	assert.equal(c.progress().backlog, true, "积压时应显式标记 backlog");
	release!();
	await tick(20);
	await c.stop();
	assert.equal(calls.maxConcurrent, 1);
	assert.ok(calls.transcribe >= 2);
});

test("增量控制器：取消丢弃未应用结果，不发新请求（草稿由调用方保留）", async () => {
	let release: (() => void) | null = null;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const { d, calls, feed } = incDeps({
		transcribeImpl: async () => {
			await gate;
			return { text: "不应出现" };
		},
	});
	const segs: VoiceSegment[] = [];
	const c = new VoiceInputController(d, { onSegment: (s) => segs.push(s) });
	await c.start({ provider: "p", model: "m", anchor: 0, incremental: true });
	feed(speech(1000));
	feed(silence(800)); // 段 1 在途
	await tick();
	const before = calls.transcribe;
	feed(speech(1000));
	feed(silence(800)); // 段 2 进等待
	c.cancel();
	release!();
	await tick(20);
	assert.equal(segs.length, 0, "取消后不应用任何结果");
	assert.equal(calls.transcribe, before, "取消后不再发新请求");
	assert.equal(c.getState(), "idle");
});

test("增量控制器：单段失败有界重试；最终失败保留可重试，且只重发失败段", async () => {
	let attempt = 0;
	const { d, calls, feed } = incDeps({
		maxSegmentRetries: 2,
		sleep: async () => {},
		transcribeImpl: async () => {
			attempt++;
			if (attempt <= 2) throw new Error("asr_upstream_error 服务返回 502");
			return { text: "第二次成功" };
		},
	});
	const segs: VoiceSegment[] = [];
	const errors: string[] = [];
	const c = new VoiceInputController(d, { onSegment: (s) => segs.push(s), onError: (e) => errors.push(e.code) });
	await c.start({ provider: "p", model: "m", anchor: 0, incremental: true });
	feed(speech(1000));
	feed(silence(800));
	await tick(20);
	assert.equal(segs.length, 1, "重试后成功");
	assert.equal(calls.transcribe, 3, "首次 + 2 次重试");
	assert.equal(errors.length, 0);
	await c.stop(); // 清定时器 / 收尾

	// 一直失败：有界重试后进入失败列表，错误可见；retryFailed 只重发失败段
	let failAttempt = 0;
	const { d: d2, calls: calls2, feed: feed2 } = incDeps({
		maxSegmentRetries: 1,
		sleep: async () => {},
		transcribeImpl: async () => {
			failAttempt++;
			throw new Error("asr_upstream_error 服务返回 502");
		},
	});
	const segs2: VoiceSegment[] = [];
	const errors2: string[] = [];
	const c2 = new VoiceInputController(d2, { onSegment: (s) => segs2.push(s), onError: (e) => errors2.push(e.code) });
	await c2.start({ provider: "p", model: "m", anchor: 0, incremental: true });
	feed2(speech(1000));
	feed2(silence(800));
	await tick(20);
	await c2.stop();
	assert.equal(segs2.length, 0);
	assert.deepEqual(errors2, ["asr_segment_failed"]);
	assert.equal(c2.progress().failed, 1);
	// 重试：仍然失败 → 仍在失败列表；请求次数增加但不无限
	const beforeRetry = calls2.transcribe;
	await c2.retryFailed();
	assert.ok(calls2.transcribe > beforeRetry);
	assert.equal(c2.progress().failed, 1);
});

test("增量控制器：批量模式（云端）仍是一次整段请求，不受分段影响", async () => {
	const { d, calls, feed } = incDeps();
	const results: string[] = [];
	const c = new VoiceInputController(d, { onResult: (r) => results.push(r.text) });
	await c.start({ provider: "p", model: "m", anchor: 0 }); // 不传 incremental
	feed(speech(1000));
	feed(silence(800));
	feed(speech(1000));
	await c.stop();
	assert.equal(calls.transcribe, 1, "云端保持整段一次请求");
	assert.equal(results.length, 1);
});

test("增量控制器：页面隐藏 → 停轨道 + 取消，不发送", async () => {
	const { d, calls, track, feed } = incDeps();
	const c = new VoiceInputController(d, {});
	await c.start({ provider: "p", model: "m", anchor: 0, incremental: true });
	feed(speech(1000)); // 没停顿，尚未成段
	c.onHidden();
	await tick();
	assert.equal(calls.transcribe, 0);
	assert.equal(track.stopped, true);
	assert.equal(c.getState(), "idle");
});

test("控制器：打开采集期间被取消（隐藏 / 切会话 / 换来源）→ 不被复活成 recording，停掉刚拿到的采集", async () => {
	// 回归：startCapture 是 await 的，取消可能发生在它 in-flight 时；若之后不重新校验状态，
	// 会 set("recording") 复活一个已取消、轨道已停、定时器已清的会话。
	let releaseCapture: (() => void) | null = null;
	const gate = new Promise<void>((r) => {
		releaseCapture = r;
	});
	let captureStop = 0;
	const { stream, track } = fakeStream();
	const d: VoiceControllerDeps = {
		getUserMedia: async () => stream,
		startCapture: async (_s, _onData): Promise<VoiceCaptureHandle> => {
			await gate;
			return { sampleRate: RATE, stop: () => { captureStop++; } };
		},
		transcribe: async () => ({ text: "x" }),
	};
	const c = new VoiceInputController(d, {});
	const started = c.start({ provider: "p", model: "m", anchor: 0, incremental: true });
	await tick();
	assert.equal(c.getState(), "preparing", "应卡在打开采集阶段");
	c.cancel(); // 采集还没就绪时取消
	releaseCapture!();
	await started;
	await tick();
	assert.equal(c.getState(), "idle", "取消后不得被 startCapture 回调复活成 recording");
	assert.equal(track.stopped, true, "轨道应已停");
	assert.equal(captureStop, 1, "刚拿到的采集要被停掉");
});

test("批量（云端）控制器：整段转写中途取消 → 保持 idle、不误报 error", async () => {
	// 回归：cancel() 会 abort 并置空 this.abort；旧代码在 await 之后读 this.abort.signal 会抛 TypeError，
	// 被 catch 当成失败 → 取消后反而进入 error 并弹错误。
	const { d, feed } = incDeps({
		transcribeImpl: async ({ signal }) =>
			new Promise<{ text: string }>((_res, rej) => {
				const fail = () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
				if (signal.aborted) return fail();
				signal.addEventListener("abort", fail, { once: true });
			}),
	});
	const errors: string[] = [];
	const c = new VoiceInputController(d, { onError: (e) => errors.push(e.code) });
	await c.start({ provider: "p", model: "m", anchor: 0 });
	feed(speech(500));
	const stopping = c.stop();
	await tick();
	c.cancel();
	await stopping;
	await tick();
	assert.equal(c.getState(), "idle");
	assert.deepEqual(errors, [], "取消不该产生错误提示");
});

// ---------------------------------------------------------------- F1 保序：失败段之后的成功段不提前进草稿
test("增量控制器：前段失败时后段不提前进草稿；重试成功后按语音原序补上（F1）", async () => {
	let n = 0;
	const { d, calls, feed } = incDeps({
		maxSegmentRetries: 0,
		sleep: async () => {},
		transcribeImpl: async () => {
			n++;
			if (n === 1) throw new Error("asr_upstream_error 服务返回 502"); // 段 0 失败
			return { text: `文字${n}` }; // 段 1 成功（call2）、重试段 0 成功（call3）
		},
	});
	const segs: VoiceSegment[] = [];
	const c = new VoiceInputController(d, { onSegment: (s) => segs.push(s) });
	await c.start({ provider: "p", model: "m", anchor: 0, incremental: true });
	feed(speech(1000));
	feed(silence(800)); // 段 0 → 失败
	await tick(20);
	feed(speech(1000));
	feed(silence(800)); // 段 1 → 成功，但必须保序暂缓（不得变成「段1」先进草稿）
	await tick(20);
	assert.equal(segs.length, 0, "段 0 失败时，段 1 不得提前进草稿");
	assert.equal(c.progress().failed, 1);
	assert.equal(c.progress().held, 1, "段 1 应作为 held 等待按序补上");
	await c.stop(); // 用户停止：失败段与 held 保留
	assert.equal(segs.length, 0);
	assert.equal(c.progress().held, 1);
	await c.retryFailed(); // 重试段 0 → 成功后 段 0、段 1 按原序补上（不是「段1段0」）
	assert.deepEqual(segs.map((s) => s.index), [0, 1]);
	assert.deepEqual(segs.map((s) => s.text), ["文字3", "文字2"]);
	assert.equal(c.progress().held, 0);
	assert.equal(c.progress().failed, 0);
	assert.equal(calls.maxConcurrent, 1);
});

test("增量控制器：多个空洞按 index 升序重试，held 一次按序补齐（F1）", async () => {
	let n = 0;
	const fail = new Set([1, 3]); // call1=段0失败、call3=段2失败
	const { d, feed } = incDeps({
		maxSegmentRetries: 0,
		sleep: async () => {},
		transcribeImpl: async () => {
			n++;
			if (fail.has(n)) throw new Error("asr_upstream_error x");
			return { text: `t${n}` };
		},
	});
	const segs: VoiceSegment[] = [];
	const c = new VoiceInputController(d, { onSegment: (s) => segs.push(s) });
	await c.start({ provider: "p", model: "m", anchor: 0, incremental: true });
	feed(speech(1000));
	feed(silence(800)); // 段 0 失败（call1）
	await tick(20);
	feed(speech(1000));
	feed(silence(800)); // 段 1 成功（call2）→ held
	await tick(20);
	feed(speech(1000));
	feed(silence(800)); // 段 2 失败（call3）
	await tick(20);
	assert.equal(segs.length, 0, "有空洞时后续段一律不进草稿");
	assert.equal(c.progress().failed, 2);
	assert.equal(c.progress().held, 1);
	await c.stop();
	await c.retryFailed(); // 重试 [0,2]：0 成功（call4）→ 补 0、1；2 成功（call5）
	assert.deepEqual(segs.map((s) => s.index), [0, 1, 2]);
	assert.deepEqual(segs.map((s) => s.text), ["t4", "t2", "t5"]);
	assert.equal(c.progress().failed, 0);
	assert.equal(c.progress().held, 0);
});

test("增量控制器：重试失败段仍用同一 provider / model（不另切云 / 模型）（F7）", async () => {
	let n = 0;
	const { d, calls, feed } = incDeps({
		maxSegmentRetries: 0,
		sleep: async () => {},
		transcribeImpl: async () => {
			n++;
			if (n === 1) throw new Error("asr_upstream_error x");
			return { text: "ok" };
		},
	});
	const c = new VoiceInputController(d, {});
	await c.start({ provider: "local-sensevoice", model: "sensevoice-small-int8", anchor: 0, incremental: true });
	feed(speech(1000));
	feed(silence(800));
	await tick(20);
	await c.stop();
	await c.retryFailed();
	assert.ok(calls.providerModels.length >= 2);
	for (const pm of calls.providerModels) {
		assert.deepEqual(pm, { provider: "local-sensevoice", model: "sensevoice-small-int8" }, "重试必须复用原来源，不切云 / 不换模型");
	}
});

// ---------------------------------------------------------------- F6 积压硬上限 + 精准证明单段 WAV <= 服务端上限
test("SpeechSegmenter：积压时也有硬上限，单段 WAV 时长 <= 服务端上限，且尾部不丢（F6）", () => {
	const hardMs = 55_000;
	const seg = new SpeechSegmenter(RATE, { hardMaxSegmentMs: hardMs });
	seg.setBackpressure(true); // 全程积压：不合段，只能靠硬上限切
	const chunks: Float32Array[] = [];
	const ranges: SpeechSegmentRange[] = [];
	for (let t = 0; t < 60_000; t += 1000) {
		const c = speech(1000); // 全程有声，保证每段都有语音
		chunks.push(c);
		for (const r of seg.push(c)) ranges.push(r);
	}
	const tail = seg.flush();
	if (tail) ranges.push(tail);

	// 1) 段首尾相接、覆盖整段录音（不丢尾部）
	assert.ok(ranges.length >= 2, `硬上限应至少切出 2 段，实际 ${ranges.length}`);
	assert.equal(ranges[0].startIn, 0);
	for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i].startIn, ranges[i - 1].endIn, "段之间不得有 gap / 重叠");
	const total = RATE * 60;
	assert.equal(ranges[ranges.length - 1].endIn, total, "尾段必须覆盖到录音结束");
	assert.equal(ranges.reduce((n, r) => n + (r.endIn - r.startIn), 0), total, "覆盖总采样 == 录音总采样（尾部不丢）");

	// 2) 每段编码成 WAV 后，用服务端真实校验函数证明时长 <= ASR_MAX_DURATION_MS
	const raw = concatFloat32(chunks);
	for (const r of ranges) {
		const pcm = segmentToPcm16(raw, RATE, r.startIn, r.endIn);
		const wav = encodeWav16(pcm);
		const info = parseWav(wav);
		assert.ok(info, "段应能解析成合法 WAV");
		assert.ok(info.durationMs <= ASR_MAX_DURATION_MS, `段 WAV 时长 ${info.durationMs}ms 必须 <= 服务端 ${ASR_MAX_DURATION_MS}ms`);
		assert.ok((r.endIn - r.startIn) / RATE <= hardMs / 1000 + 0.05, "单段采样受硬上限约束");
		const v = validateAsrAudio(wav);
		assert.ok(v.ok, `服务端校验必须通过：${v.ok ? "" : v.message}`);
	}
});

// ---------------------------------------------------------------- F4 / F7 录音租约管理器
test("AsrLeaseManager：并发 begin 只保留最新租约，迟到 / 被覆盖的旧租约立即释放（F4）", async () => {
	const acquired: string[] = [];
	const released: string[] = [];
	let resolveFirst: ((id: string) => void) | null = null;
	const m = new AsrLeaseManager({
		acquire: (_p, _model) => {
			acquired.push(`${_p}/${_model}`);
			if (acquired.length === 1) return new Promise<string>((r) => { resolveFirst = r; });
			return Promise.resolve(`lease-${acquired.length}`);
		},
		release: (id) => { released.push(id); },
	});
	m.begin("local-sensevoice", "sensevoice-small-int8");
	m.begin("local-sensevoice", "sensevoice-small-int8"); // 第二次 begin：第一个 entry 作废
	resolveFirst!("lease-1"); // 第一个 acquire 迟到 resolve → 必须被回收，不能泄漏
	await tick();
	assert.deepEqual(released, ["lease-1"], "被覆盖 / 迟到的租约必须释放，否则服务端计数不归零");
	assert.equal(m.id, "lease-2");
	m.end();
	assert.deepEqual(released, ["lease-1", "lease-2"]);
	assert.equal(m.id, null);
});

test("AsrLeaseManager：end 后重试 begin 重新获取租约；end 后迟到的 acquire 也被回收（F7）", async () => {
	const released: string[] = [];
	let n = 0;
	const m = new AsrLeaseManager({ acquire: async () => `lease-${++n}`, release: (id) => { released.push(id); } });
	m.begin("p", "m");
	await tick();
	assert.equal(m.id, "lease-1");
	m.end(); // 停止 / 取消：释放租约
	await tick();
	assert.deepEqual(released, ["lease-1"]);
	// 停止后超过 idle TTL（默认 90s）再点重试：重新 begin 拿新租约，模型不会被 idle 卸载
	m.begin("p", "m");
	await tick();
	assert.equal(m.id, "lease-2", "重试应重新拿到租约");
	m.end();
	assert.deepEqual(released, ["lease-1", "lease-2"]);

	// acquire 还没 resolve 就 end → 迟到的 id 也要释放
	const released2: string[] = [];
	let resolveLate: ((id: string) => void) | null = null;
	const m2 = new AsrLeaseManager({ acquire: () => new Promise<string>((r) => { resolveLate = r; }), release: (id) => { released2.push(id); } });
	m2.begin("p", "m");
	m2.end();
	resolveLate!("lease-late");
	await tick();
	assert.deepEqual(released2, ["lease-late"]);
	assert.equal(m2.id, null);
});
