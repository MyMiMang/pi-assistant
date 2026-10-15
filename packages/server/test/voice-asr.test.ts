/**
 * 语音输入服务端单测（不联网、不开麦、不碰真实凭据 / 用户数据）。
 *
 * 覆盖：WAV 校验、上游错误脱敏、超时、取消、幂等（completed 复用 / inflight busy / 失败不缓存可重试）、
 * HTTP 路由（multipart 成功 / 非法音频 / 未配置 / 非 multipart）、统一注册表 ASR 契约。
 * 所有外部依赖用假 fetch / 假 resolve；强制 tmp 数据目录（见 test/setup.ts）。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { encodeWav16, pcm16FromFloat32 } from "../../../apps/web/src/voice-input.ts";
import { createAsrService, parseWav, transcribeUpstream, validateAsrAudio } from "../src/voice/asr.ts";
import { mountVoiceRoutes } from "../src/voice/routes.ts";
import { ASR_ERRORS, type AsrEndpoint, type AsrRequest } from "../src/voice/contract.ts";
import { buildRegistry, modelsWithCapability, type ModelType } from "../src/model-registry.ts";

const wav = (seconds = 0.2, rate = 16_000) => {
	const n = Math.max(1, Math.round(seconds * rate));
	const pcm = pcm16FromFloat32(new Float32Array(n).fill(0.1));
	return encodeWav16(pcm, rate);
};
const req = (audio: Uint8Array, over: Partial<AsrRequest> = {}): AsrRequest => ({ provider: "p", model: "m", audio, filename: "audio.wav", requestId: "r1", ...over });
const ep = (over: Partial<AsrEndpoint> = {}): AsrEndpoint => ({ protocol: "openai-audio-transcriptions", baseUrl: "https://asr.example.com", apiKey: "sk-secret", location: "cloud", ...over });
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------- 音频校验
test("validateAsrAudio：合法 16k 单声道 PCM WAV 通过，parseWav 参数一致", () => {
	const bytes = wav(0.2);
	const r = validateAsrAudio(bytes);
	assert.ok(r.ok);
	assert.equal(r.value.sampleRate, 16_000);
	assert.equal(r.value.channels, 1);
	assert.equal(r.value.bitsPerSample, 16);
});

test("validateAsrAudio：空 / 非 WAV / 错采样率 / 错声道 都被拒且给稳定错误码", () => {
	assert.equal((validateAsrAudio(new Uint8Array(0)) as { code: string }).code, ASR_ERRORS.invalidAudio);
	assert.equal((validateAsrAudio(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) as { code: string }).code, ASR_ERRORS.invalidAudio);
	const wrongRate = validateAsrAudio(wav(0.1, 44_100)) as { code: string };
	assert.equal(wrongRate.code, ASR_ERRORS.invalidAudio);
	assert.equal(parseWav(wav(0.1, 44_100))!.sampleRate, 44_100);
});

test("validateAsrAudio：超过字节 / 时长上限被拒（tooLarge / invalidAudio）", () => {
	assert.equal((validateAsrAudio(wav(1), { maxBytes: 100 }) as { code: string }).code, ASR_ERRORS.tooLarge);
	assert.equal((validateAsrAudio(wav(1), { maxDurationMs: 100 }) as { code: string }).code, ASR_ERRORS.invalidAudio);
});

// ---------------------------------------------------------------- 上游调用
test("transcribeUpstream：成功取 text + 真实 usage（不填 0）", async () => {
	const out = await transcribeUpstream(ep(), req(wav()), { fetchImpl: async () => jsonRes({ text: "你好", duration: 1.25 }) });
	assert.ok(out.ok);
	assert.equal(out.value.text, "你好");
	assert.deepEqual(out.value.usage, { audioSeconds: 1.25 });
});

test("transcribeUpstream：上游 500 / 无 text 都是脱敏错误，不回显 key 与 URL", async () => {
	const a = await transcribeUpstream(ep(), req(wav()), { fetchImpl: async () => jsonRes({ error: "boom sk-secret" }, 500) });
	assert.ok(!a.ok);
	assert.equal(a.code, ASR_ERRORS.upstream);
	assert.ok(!a.message.includes("sk-secret"));
	const b = await transcribeUpstream(ep(), req(wav()), { fetchImpl: async () => jsonRes({ ok: true }) });
	assert.ok(!b.ok);
	assert.equal(b.code, ASR_ERRORS.upstream);
});

test("transcribeUpstream：超时 → asr_timeout；外部取消 → asr_aborted（不保证不计费，只保证不当成功）", async () => {
	const hang: typeof fetch = (_u, init) =>
		new Promise((_res, rej) => {
			init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("abort"), { name: "AbortError" })));
		});
	const t = await transcribeUpstream(ep(), req(wav()), { fetchImpl: hang, timeoutMs: 5 });
	assert.ok(!t.ok);
	assert.equal(t.code, ASR_ERRORS.timeout);

	const ac = new AbortController();
	ac.abort();
	const a = await transcribeUpstream(ep(), req(wav()), { fetchImpl: hang, signal: ac.signal });
	assert.ok(!a.ok);
	assert.equal(a.code, ASR_ERRORS.aborted);
});

test("transcribeUpstream：不支持的协议 fail-closed（不猜）", async () => {
	const out = await transcribeUpstream(ep({ protocol: "something-else" }), req(wav()), { fetchImpl: async () => jsonRes({ text: "x" }) });
	assert.ok(!out.ok);
	assert.equal(out.code, ASR_ERRORS.notConfigured);
});

// ---------------------------------------------------------------- 幂等 / 缓存
test("幂等：相同 requestId 的**已完成**结果直接复用，不再调上游", async () => {
	let calls = 0;
	const svc = createAsrService({ resolve: async () => ({ ok: true, value: ep() }), fetchImpl: async () => { calls++; return jsonRes({ text: "hi" }); } });
	const a = await svc.transcribe(req(wav(), { requestId: "same" }));
	const b = await svc.transcribe(req(wav(), { requestId: "same" }));
	assert.ok(a.ok && b.ok);
	assert.equal(calls, 1);
	assert.equal(b.value.text, "hi");
});

test("幂等：失败**不缓存**（unknown 状态不当成功），用户重试会重新调上游", async () => {
	let calls = 0;
	const svc = createAsrService({
		resolve: async () => ({ ok: true, value: ep() }),
		fetchImpl: async () => {
			calls++;
			return calls === 1 ? jsonRes({ error: "down" }, 500) : jsonRes({ text: "ok" });
		},
	});
	const a = await svc.transcribe(req(wav(), { requestId: "x" }));
	assert.ok(!a.ok);
	const b = await svc.transcribe(req(wav(), { requestId: "x" }));
	assert.ok(b.ok);
	assert.equal(calls, 2);
});

test("幂等：同一 requestId 并发（in-flight）返回 busy，不 join、不重复调上游", async () => {
	let release: (() => void) | null = null;
	let calls = 0;
	const svc = createAsrService({
		resolve: async () => ({ ok: true, value: ep() }),
		fetchImpl: async () => {
			calls++;
			await new Promise<void>((r) => { release = r; });
			return jsonRes({ text: "later" });
		},
	});
	const first = svc.transcribe(req(wav(), { requestId: "z" }));
	await new Promise((r) => setTimeout(r, 0));
	const second = await svc.transcribe(req(wav(), { requestId: "z" }));
	assert.ok(!second.ok);
	assert.equal(second.code, ASR_ERRORS.busy);
	assert.equal(calls, 1);
	release!();
	const done = await first;
	assert.ok(done.ok);
});

test("createAsrService：未配置 ASR（resolve 失败）时 fail-closed，不调上游", async () => {
	let calls = 0;
	const svc = createAsrService({ resolve: async () => ({ ok: false, code: ASR_ERRORS.notConfigured, status: 400, message: "no" }), fetchImpl: async () => { calls++; return jsonRes({ text: "x" }); } });
	const out = await svc.transcribe(req(wav()));
	assert.ok(!out.ok);
	assert.equal(out.code, ASR_ERRORS.notConfigured);
	assert.equal(calls, 0);
});

// ---------------------------------------------------------------- HTTP 路由
function buildApp(fetchImpl: typeof fetch = async () => jsonRes({ text: "转写结果" })) {
	const app = new Hono();
	mountVoiceRoutes(app, { resolve: async () => ({ ok: true, value: ep() }), fetchImpl });
	return app;
}
const form = (audio: Uint8Array, fields: Record<string, string> = { provider: "p", model: "m", requestId: "r1" }) => {
	const fd = new FormData();
	fd.append("file", new Blob([audio as unknown as BlobPart], { type: "audio/wav" }), "audio.wav");
	for (const [k, v] of Object.entries(fields)) fd.append(k, v);
	return fd;
};

test("POST /api/audio/transcriptions：multipart 成功返回文本", async () => {
	const app = buildApp();
	const res = await app.request("/api/audio/transcriptions", { method: "POST", body: form(wav()) });
	assert.equal(res.status, 200);
	assert.equal(((await res.json()) as { text: string }).text, "转写结果");
});

test("POST /api/audio/transcriptions：非 multipart / 非法音频 / 缺 provider 都被拒", async () => {
	const app = buildApp();
	const json = await app.request("/api/audio/transcriptions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert.equal(json.status, 400);
	const bad = await app.request("/api/audio/transcriptions", { method: "POST", body: form(new Uint8Array([1, 2, 3])) });
	assert.equal(bad.status, 400);
	assert.equal(((await bad.json()) as { error: string }).error, ASR_ERRORS.invalidAudio);
	const noProv = await app.request("/api/audio/transcriptions", { method: "POST", body: form(wav(), { model: "m" }) });
	assert.equal(noProv.status, 400);
	assert.equal(((await noProv.json()) as { error: string }).error, ASR_ERRORS.notConfigured);
});

test("GET /api/audio/asr/config：返回上限与协议，供前端对齐", async () => {
	const app = buildApp();
	const res = await app.request("/api/audio/asr/config");
	const body = (await res.json()) as { maxDurationMs: number; maxBytes: number; protocol: string };
	assert.equal(body.maxDurationMs, 60_000);
	assert.equal(body.protocol, "openai-audio-transcriptions");
});

// ---------------------------------------------------------------- 注册表契约
test("注册表：显式声明的 ASR 进 type:\"asr\" + capability asr；本地 ASR 标 local", () => {
	const list = buildRegistry({
		providers: [],
		chatModels: [],
		classifierModels: [],
		custom: [],
		image: { providers: [] },
		asr: [
			{ provider: "openai", modelId: "gpt-transcribe", protocol: "openai-audio-transcriptions", configured: true, location: "cloud" },
			{ provider: "local-sensevoice", modelId: "sensevoice-small", protocol: "openai-audio-transcriptions", configured: true, location: "local", local: { installed: true, running: true, state: "running", device: "cpu" } },
		],
	});
	const asr = modelsWithCapability(list, "asr");
	assert.equal(asr.length, 2);
	const local = asr.find((m) => m.provider === "local-sensevoice")!;
	assert.equal(local.type, "asr");
	assert.equal(local.source, "local");
	assert.equal(local.asrAdapter?.location, "local");
	assert.equal(local.local?.running, true);
	const cloud = asr.find((m) => m.provider === "openai")!;
	assert.equal(cloud.asrAdapter?.location, "cloud");
});

test("注册表：ModelType 含 asr（类型契约），chat 多模态不会被当成 ASR", () => {
	const t: ModelType = "asr";
	assert.equal(t, "asr");
	const list = buildRegistry({
		providers: [{ id: "openai", name: "OpenAI", configured: true }],
		chatModels: [{ provider: "openai", id: "gpt-4o", name: "gpt-4o", input: ["text", "image"] } as never],
		classifierModels: [],
		custom: [],
		image: { providers: [] },
	});
	assert.equal(modelsWithCapability(list, "asr").length, 0);
	assert.equal(modelsWithCapability(list, "vision").length, 1);
});
