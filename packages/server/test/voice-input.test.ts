/**
 * 语音输入前端**纯逻辑**单测（不碰浏览器 / 麦克风 / 网络 / 真实数据）。
 *
 * 覆盖：麦克风能力探测、取消 0 次请求、开始 1 次 getUserMedia、权限拒绝、页面隐藏停轨道、
 * 真实 16 kHz WAV（用服务端 parseWav 回读）、非 16k 输入真重采样、锚点插入保留用户编辑、
 * 切对话不插入、IME 组合中推迟、取消不动草稿 / 引用。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyVoiceCancel,
	concatFloat32,
	DEFAULT_MAX_DURATION_MS,
	encodeWav16,
	insertAtAnchor,
	pcm16FromFloat32,
	resampleTo16k,
	shouldInsert,
	VoiceInputController,
	voiceCapability,
	voiceErrorFrom,
	type VoiceCaptureHandle,
	type VoiceControllerDeps,
	type VoiceResult,
} from "../../../apps/web/src/voice-input.ts";
import { parseWav } from "../src/voice/asr.ts";

// ---------------------------------------------------------------- 假依赖（不碰真实麦克风 / 网络）
function fakeStream() {
	const track = { stopped: false, stop() { this.stopped = true; } };
	return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

function deps(over: Partial<VoiceControllerDeps> & { sampleRate?: number } = {}) {
	const { stream, track } = fakeStream();
	const calls = { getUserMedia: 0, transcribe: 0, captureStop: 0, requests: [] as string[] };
	const d: VoiceControllerDeps = {
		getUserMedia: async () => {
			calls.getUserMedia++;
			return stream;
		},
		startCapture: async (_s, onData): Promise<VoiceCaptureHandle> => {
			onData(new Float32Array([0, 0.5, -0.5, 1, -1]));
			return { sampleRate: over.sampleRate ?? 16_000, stop: () => { calls.captureStop++; } };
		},
		transcribe: async () => {
			calls.transcribe++;
			return { text: "你好世界" };
		},
		...over,
	};
	return { d, calls, track };
}

// ---------------------------------------------------------------- 能力探测 / 错误映射
test("voiceCapability：安全上下文 + mediaDevices 才可用", () => {
	assert.deepEqual(voiceCapability({ mediaDevices: { getUserMedia: () => {} }, isSecureContext: true }), { available: true });
	assert.equal(voiceCapability({ mediaDevices: { getUserMedia: () => {} }, isSecureContext: false }).reason, "insecure_context");
	assert.equal(voiceCapability({ mediaDevices: null, isSecureContext: true }).reason, "no_mediadevices");
	assert.equal(voiceCapability({ isSecureContext: true }).reason, "no_mediadevices");
});

test("voiceErrorFrom：权限拒绝 / 无麦 / 未配置 ASR 有可解释文案", () => {
	const e = (name: string) => Object.assign(new Error("x"), { name });
	assert.equal(voiceErrorFrom(e("NotAllowedError")).code, "mic_denied");
	assert.equal(voiceErrorFrom(e("NotFoundError")).code, "no_mic");
	assert.equal(voiceErrorFrom(new Error("asr_not_configured")).code, "asr_not_configured");
	assert.equal(voiceErrorFrom(new Error("asr_timeout")).code, "asr_timeout");
});

// ---------------------------------------------------------------- 音频：真 16k WAV + 真重采样
test("encodeWav16：写出合法 RIFF/WAVE，采样率 16000 / 单声道 / 16bit（parseWav 回读一致）", () => {
	const pcm = pcm16FromFloat32(new Float32Array([0, 0.5, -0.5, 1, -1]));
	const wav = encodeWav16(pcm, 16_000);
	const info = parseWav(wav);
	assert.ok(info, "应能被 parseWav 解析");
	assert.equal(info!.sampleRate, 16_000);
	assert.equal(info!.channels, 1);
	assert.equal(info!.bitsPerSample, 16);
	assert.equal(info!.dataBytes, pcm.length * 2);
	assert.equal(info!.durationMs, 0);
});

test("resampleTo16k：48k→16k 长度真按比例，常数信号保持（不假 16000）", () => {
	const input = new Float32Array(48_000).fill(0.25);
	const out = resampleTo16k(input, 48_000);
	assert.equal(out.length, 16_000);
	assert.ok(Math.abs(out[123] - 0.25) < 1e-6);
	// 已经是 16k 时原样返回（不重复处理）
	const same = resampleTo16k(input, 16_000);
	assert.equal(same, input);
});

test("concatFloat32：拼接去零长分片", () => {
	const out = concatFloat32([new Float32Array([1, 2]), new Float32Array(0), new Float32Array([3])]);
	assert.deepEqual([...out], [1, 2, 3]);
});

// ---------------------------------------------------------------- 草稿合并
test("insertAtAnchor：插到开始录制时的锚点，保留用户之后的编辑", () => {
	const r = insertAtAnchor({ text: "abcdef", anchor: 3 }, "XY");
	assert.equal(r.draft.text, "abcXYdef");
	assert.equal(r.cursor, 5);
	assert.equal(r.deferred, false);
});

test("insertAtAnchor：锚点超出（用户删过字）时收敛到末尾，不越界", () => {
	const r = insertAtAnchor({ text: "ab", anchor: 99 }, "Z");
	assert.equal(r.draft.text, "abZ");
});

test("insertAtAnchor：IME 组合中推迟插入，不改草稿、不打断候选", () => {
	const d = { text: "你好", anchor: 1 };
	const r = insertAtAnchor(d, "世界", { composing: true });
	assert.equal(r.deferred, true);
	assert.equal(r.draft, d);
});

test("applyVoiceCancel：取消只丢语音，草稿与引用原样不动", () => {
	const d = { text: "草稿", anchor: 2, replyTo: "m1" };
	assert.deepEqual(applyVoiceCancel(d), d);
});

test("shouldInsert：录制期间切了对话 / 助理就不插入", () => {
	assert.equal(shouldInsert({ conversationId: "c1", agentId: "a1" }, { conversationId: "c1", agentId: "a1" }), true);
	assert.equal(shouldInsert({ conversationId: "c1" }, { conversationId: "c2" }), false);
	assert.equal(shouldInsert({ agentId: "a1" }, { agentId: "a2" }), false);
});

// ---------------------------------------------------------------- 控制器状态机
test("开始一次只请求一次麦克风，停止后转写一次并把结果插到锚点", async () => {
	const { d, calls } = deps();
	const states: string[] = [];
	const results: VoiceResult[] = [];
	const c = new VoiceInputController(d, { onState: (s) => states.push(s), onResult: (r) => results.push(r) });
	await c.start({ provider: "p", model: "m", anchor: 3, conversationId: "c1", agentId: "a1" });
	assert.equal(calls.getUserMedia, 1);
	assert.equal(c.getState(), "recording");
	await c.stop();
	assert.equal(calls.transcribe, 1);
	assert.equal(results.length, 1);
	assert.equal(results[0].text, "你好世界");
	assert.equal(results[0].anchor, 3);
	assert.equal(results[0].conversationId, "c1");
	assert.deepEqual(states, ["preparing", "recording", "transcribing", "finish", "idle"]);
});

test("取消：0 次转写请求，且停掉麦克风轨道（不偷录）", async () => {
	const { d, calls, track } = deps();
	const c = new VoiceInputController(d, {});
	await c.start({ provider: "p", model: "m", anchor: 0 });
	assert.equal(c.getState(), "recording");
	c.cancel();
	assert.equal(calls.transcribe, 0);
	assert.equal(calls.captureStop, 1);
	assert.equal(track.stopped, true);
	assert.equal(c.getState(), "idle");
});

test("权限被拒：进入 error 且给出 mic_denied，不产生转写请求", async () => {
	const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
	const { d, calls } = deps({ getUserMedia: async () => { calls.getUserMedia++; throw err; } });
	const errors: string[] = [];
	const c = new VoiceInputController(d, { onError: (e) => errors.push(e.code) });
	await c.start({ provider: "p", model: "m", anchor: 0 });
	assert.equal(c.getState(), "error");
	assert.deepEqual(errors, ["mic_denied"]);
	assert.equal(calls.transcribe, 0);
});

test("页面隐藏 / 切后台：停轨道 + 取消，不发送", async () => {
	const { d, calls, track } = deps();
	const c = new VoiceInputController(d, {});
	await c.start({ provider: "p", model: "m", anchor: 0 });
	c.onHidden();
	assert.equal(calls.transcribe, 0);
	assert.equal(track.stopped, true);
	assert.equal(c.getState(), "idle");
});

test("采集到非 16000 采样率时真重采样，上传的是 16k WAV", async () => {
	let seen: Uint8Array | null = null;
	const { d } = deps({ sampleRate: 48_000, transcribe: async ({ audio }) => { seen = audio; return { text: "ok" }; } });
	const c = new VoiceInputController(d, {});
	await c.start({ provider: "p", model: "m", anchor: 0 });
	await c.stop();
	assert.ok(seen);
	const info = parseWav(seen!);
	assert.ok(info);
	assert.equal(info!.sampleRate, 16_000);
});

test("最长时长：默认 60 秒，到点自动停止转写", async () => {
	assert.equal(DEFAULT_MAX_DURATION_MS, 60_000);
	const { d, calls } = deps();
	let fire: (() => void) | null = null;
	const c = new VoiceInputController(
		{ ...d, setTimer: (fn, ms) => { assert.equal(ms, 60_000); fire = fn; return 1; }, clearTimer: () => {} },
		{},
	);
	await c.start({ provider: "p", model: "m", anchor: 0 });
	assert.ok(fire);
	fire!();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.transcribe, 1);
});
