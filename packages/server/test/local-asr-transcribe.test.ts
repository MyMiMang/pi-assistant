/**
 * 本地 ASR 的转写协议（服务端侧 adapter）+ HTTP 路由契约。
 *
 * 边界：假识别器（固定已知 PCM → 固定 transcript），不发真实网络、不录音、不用用户音频、不碰钥匙串。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { transcribeWav, validateWav, WavRejectedError } from "../src/local-asr/transcribe.ts";
import { mountLocalAsrRoutes } from "../src/local-asr/routes.ts";
import { asrEndpoint, registerAsrEndpoint, resetAsrEndpoints } from "../src/local-asr/adapter-registry.ts";
import { ASR_MODEL_ID, ASR_PROVIDER_ID, SENSEVOICE_LICENSE, SENSEVOICE_MODEL } from "../src/local-asr/manifest.ts";
import { ASR_PROTOCOL, type AsrEndpoint } from "../src/local-asr/adapter.ts";
import { localModelHints, resetLocalModelHints } from "../src/local-models.ts";
import type { AsrStatus } from "../src/local-asr/manager.ts";

/** 生成一段 16k mono 16bit WAV（测试用固定波形，不是任何真实录音）。 */
function wav(seconds = 0.2): Uint8Array {
	const frames = Math.round(16000 * seconds);
	const buf = new Uint8Array(44 + frames * 2);
	const dv = new DataView(buf.buffer);
	const tag = (o: number, s: string) => {
		for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i);
	};
	tag(0, "RIFF");
	dv.setUint32(4, 36 + frames * 2, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, 1, true);
	dv.setUint32(24, 16000, true);
	dv.setUint32(28, 32000, true);
	dv.setUint16(32, 2, true);
	dv.setUint16(34, 16, true);
	tag(36, "data");
	dv.setUint32(40, frames * 2, true);
	return buf;
}

const endpoint: AsrEndpoint = {
	provider: ASR_PROVIDER_ID,
	modelId: ASR_MODEL_ID,
	protocol: ASR_PROTOCOL,
	baseUrl: "http://127.0.0.1:51999/v1/",
	token: "s".repeat(64),
	sampleRate: 16000,
	languages: ["zh", "en"],
};

/** 最小 manager stub：只提供 transcribe 用到的租约接口。 */
function stubManager(running = true) {
	const state = { begins: 0, ends: 0, aborts: 0 };
	const ctrls = new Set<AbortController>();
	const manager = {
		status: () => ({ runtime: { state: running ? "running" : "stopped" } }),
		beginInference: () => {
			if (!running) throw new Error("本地 ASR 未运行");
			state.begins += 1;
			const c = new AbortController();
			ctrls.add(c);
			return {
				signal: c.signal,
				end: () => {
					state.ends += 1;
					ctrls.delete(c);
				},
			};
		},
		/** 测试用：模拟 stop() 中止活跃推理 */
		abortAll: () => {
			state.aborts += 1;
			for (const c of ctrls) c.abort();
		},
	};
	return { manager, state };
}

test("转写协议：只打本机 loopback 的固定路径，带 Bearer token 与 audio/wav；结果 cost 未知为 null", async () => {
	const { manager, state } = stubManager();
	const seen: { url: string; auth: string | null; ct: string | null; bytes: number }[] = [];
	const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		seen.push({
			url: String(url),
			auth: headers.get("authorization"),
			ct: headers.get("content-type"),
			bytes: init?.body instanceof Uint8Array ? init.body.byteLength : -1,
		});
		return new Response(JSON.stringify({ text: "你好世界", language: "zh", segments: [{ start: 0, end: 0.2, text: "你好世界" }], audioSeconds: 0.2 }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;

	const audio = wav(0.2);
	const res = await transcribeWav(manager as never, endpoint, audio, { fetchImpl: fakeFetch });
	assert.equal(res.text, "你好世界");
	assert.equal(res.language, "zh");
	assert.equal(res.segments.length, 1);
	assert.equal(res.usage.cost, null, "成本未知必须为 null，不能填 0");
	assert.equal(res.usage.audioSeconds, 0.2);

	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, "http://127.0.0.1:51999/v1/audio/transcriptions");
	assert.equal(seen[0].auth, `Bearer ${"s".repeat(64)}`);
	assert.equal(seen[0].ct, "audio/wav");
	assert.equal(seen[0].bytes, audio.byteLength);
	// 租约必须释放（否则 idle 永远不会释放进程）
	assert.equal(state.begins, 1);
	assert.equal(state.ends, 1);
});

test("转写前先校验 WAV：不合格不占租约（不重置 idle），错误可读", async () => {
	const { manager, state } = stubManager();
	let called = 0;
	const fakeFetch = (async () => {
		called += 1;
		return new Response("{}");
	}) as unknown as typeof fetch;
	await assert.rejects(() => transcribeWav(manager as never, endpoint, new Uint8Array(10), { fetchImpl: fakeFetch }), (e) => e instanceof WavRejectedError);
	assert.equal(state.begins, 0, "非法音频不应占用租约");
	assert.equal(called, 0);
	assert.throws(() => validateWav(wav(1).subarray(0, 60)), WavRejectedError);
});

test("超时 / 中止：明确报错，且租约一定被释放", async () => {
	const { manager, state } = stubManager();
	const hangingFetch = ((_url: unknown, init?: RequestInit) =>
		new Promise((_res, rej) => {
			init?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
		})) as unknown as typeof fetch;
	await assert.rejects(() => transcribeWav(manager as never, endpoint, wav(0.1), { fetchImpl: hangingFetch, timeoutMs: 20 }), /超时|取消/);
	assert.equal(state.ends, 1);

	// 租约被中止（进程停止）→ 报「已中止」
	const { manager: m2, state: s2 } = stubManager();
	const hanging2 = ((_url: unknown, init?: RequestInit) =>
		new Promise((_res, rej) => {
			init?.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
		})) as unknown as typeof fetch;
	const p = transcribeWav(m2 as never, endpoint, wav(0.1), { fetchImpl: hanging2, timeoutMs: 5000 });
	await new Promise((r) => setTimeout(r, 5));
	m2.abortAll();
	await assert.rejects(() => p, /已中止/);
	assert.equal(s2.ends, 1);
});

// ------------------------------------------------------------------ 路由

function fakeStatus(over: Partial<AsrStatus> = {}): AsrStatus {
	const base: AsrStatus = {
		platform: { key: "darwin-arm64", os: "darwin", arch: "arm64", support: "supported", accelerator: "cpu", wheelTag: "macosx_11_0_arm64", reason: "cpu" },
		license: { licenseName: SENSEVOICE_LICENSE.licenseName, termsVersion: "1.1", decision: "unresolved", selfServe: true, redistribution: false, attribution: SENSEVOICE_LICENSE.attribution, agreementRequired: false, links: SENSEVOICE_LICENSE.links, restrictions: [...SENSEVOICE_LICENSE.restrictions], reason: SENSEVOICE_LICENSE.reason, acceptValue: "1.1" },
		install: { state: "installed", phase: "done", received: 0, total: null, error: null, installedAt: 1, source: "import" },
		runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1", restarts: 0, lastError: null },
		health: null,
		configured: true,
		registered: null,
		idle: { seconds: 90, lastActiveAt: null, active: 0, leases: 0, unloads: 0, paused: false },
		source: { project: "SenseVoiceSmall", repoUrl: "r", weightsRepo: "w", weightsRevision: "a".repeat(40), engineLicense: "Apache-2.0", repoCodeLicense: "MIT", weightsLicense: "FunASR Model Open Source License Agreement v1.1", engineVersion: "1.13.8", note: "n" },
		model: { id: ASR_MODEL_ID, bytes: 1, sampleRate: 16000, channels: 1, languages: ["zh"], punctuation: true, threadCap: 8 },
		notes: ["未实测"],
	};
	return { ...base, ...over };
}

function routesApp(manager: Record<string, unknown>) {
	const app = new Hono();
	mountLocalAsrRoutes(app as never, async (_c, next) => next(), (() => manager) as never);
	return app;
}

test("路由契约：status 写入本地模型 hints（type=asr，不含 token）；source 暴露条款与固定摘要", async () => {
	resetLocalModelHints();
	const app = routesApp({ status: () => fakeStatus(), install: async () => {}, cancel: () => ({ ok: false }), start: async () => {}, stop: async () => {}, pause: async () => {}, resume: async () => {}, setIdleSeconds: (n: number) => n, update: async () => {}, uninstall: async () => {} });

	const st = await app.request("/api/local-models/asr/sensevoice/status");
	assert.equal(st.status, 200);
	const body = (await st.json()) as Record<string, unknown>;
	assert.ok(!JSON.stringify(body).includes("token"));
	const hints = localModelHints();
	const asrHint = hints.find((h) => h.provider === ASR_PROVIDER_ID);
	assert.ok(asrHint, "status 后应出现在本地模型 hints 里");
	assert.equal(asrHint?.type, "asr");
	assert.equal(asrHint?.modelId, ASR_MODEL_ID);
	assert.equal(asrHint?.asr?.sampleRate, 16000);

	const src = (await (await app.request("/api/local-models/asr/sensevoice/source")).json()) as { license: { acceptValue: string; restrictions: string[] }; model: { files: { path: string; sha256: string }[] } };
	assert.equal(src.license.acceptValue, "1.1");
	assert.ok(src.license.restrictions.length >= 4, "限制摘要必须随 source 下发（默认可见）");
	const onnx = src.model.files.find((f) => f.path === "model.int8.onnx");
	assert.equal(onnx?.sha256, SENSEVOICE_MODEL.files[0].sha256);

	const plat = (await (await app.request("/api/local-models/asr/sensevoice/platform")).json()) as { platform: { accelerator: string }; accelerators: { id: string }[] };
	assert.equal(plat.platform.accelerator, "cpu");
	assert.deepEqual(plat.accelerators.map((a) => a.id), ["cpu"], "只暴露 CPU 路径");
});

test("路由：install 把 source/acceptLicense/importDir 透传；许可被拒时返回 400 + 原因", async () => {
	const calls: unknown[] = [];
	const okApp = routesApp({ status: () => fakeStatus({ install: { state: "installing", phase: "weights", received: 1, total: 2, error: null, installedAt: null, source: "download" } }), precheck: () => ({ ok: true }), install: async (o: unknown) => void calls.push(o), cancel: () => ({ ok: true }), setIdleSeconds: () => 90 });
	const res = await okApp.request("/api/local-models/asr/sensevoice/install", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source: "download", acceptLicense: "1.1", importDir: "/tmp/x", baseUrl: "http://evil.example.com" }),
	});
	assert.equal(res.status, 200);
	assert.deepEqual(calls[0], { source: "download", acceptLicense: "1.1", importDir: "/tmp/x" }, "只透传已知字段，忽略外部 baseUrl（无 SSRF 入口）");

	const badApp = routesApp({ status: () => fakeStatus(), precheck: () => ({ ok: false, error: "权重许可适用范围未最终确认" }), install: async () => { throw new Error("权重许可适用范围未最终确认"); }, setIdleSeconds: () => 90 });
	const bad = await badApp.request("/api/local-models/asr/sensevoice/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "download", acceptLicense: "1.1" }) });
	assert.equal(bad.status, 400);
	assert.match(String(((await bad.json()) as { error: string }).error), /未最终确认/);
});

test("路由：卸载需 confirm；transcribe 未运行返回 409，非法 WAV 返回 400 且不占租约", async () => {
	let confirmed: unknown;
	const app = routesApp({
		status: () => fakeStatus(),
		uninstall: async (c: unknown) => void (confirmed = c),
		setIdleSeconds: () => 90,
	});
	const noConfirm = await app.request("/api/local-models/asr/sensevoice", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
	assert.equal(noConfirm.status, 400);
	assert.match(String(((await noConfirm.json()) as { error: string }).error), /确认/);
	await app.request("/api/local-models/asr/sensevoice", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
	assert.equal(confirmed, true);

	// 未运行 → 409
	const stopped = routesApp({ status: () => fakeStatus(), setIdleSeconds: () => 90 });
	const r409 = await stopped.request("/api/local-models/asr/sensevoice/transcribe", { method: "POST", body: wav(0.1) as unknown as BodyInit });
	assert.equal(r409.status, 409);

	// 运行中但音频非法 → 400（且 beginInference 未被调用）
	resetAsrEndpoints();
	registerAsrEndpoint(endpoint);
	assert.ok(asrEndpoint(ASR_PROVIDER_ID));
	const { manager, state } = stubManager();
	const running = routesApp({ status: () => fakeStatus({ runtime: { state: "running", pid: 1, port: 51999, host: "127.0.0.1", restarts: 0, lastError: null } }), beginInference: manager.beginInference, setIdleSeconds: () => 90 });
	const r400 = await running.request("/api/local-models/asr/sensevoice/transcribe", { method: "POST", body: new Uint8Array(20) });
	assert.equal(r400.status, 400);
	assert.equal(state.begins, 0);
});

test("路由：transcribe 用注册表里的端点转写（假识别器返回固定 transcript）", async () => {
	resetAsrEndpoints();
	registerAsrEndpoint(endpoint);
	const { manager, state } = stubManager();
	const app = routesApp({ status: () => fakeStatus({ runtime: { state: "running", pid: 1, port: 51999, host: "127.0.0.1", restarts: 0, lastError: null } }), beginInference: manager.beginInference, setIdleSeconds: () => 90 });

	const realFetch = globalThis.fetch;
	let hit = "";
	globalThis.fetch = (async (url: string | URL | Request) => {
		hit = String(url);
		return new Response(JSON.stringify({ text: "测试转写", language: "zh", segments: [], audioSeconds: 0.2 }), { status: 200 });
	}) as unknown as typeof fetch;
	try {
		const res = await app.request("/api/local-models/asr/sensevoice/transcribe", { method: "POST", body: wav(0.2) as unknown as BodyInit });
		assert.equal(res.status, 200);
		const body = (await res.json()) as { ok: boolean; result: { text: string; usage: { cost: number | null } } };
		assert.equal(body.ok, true);
		assert.equal(body.result.text, "测试转写");
		assert.equal(body.result.usage.cost, null);
		assert.equal(hit, "http://127.0.0.1:51999/v1/audio/transcriptions", "只打注册表里的 loopback 端点");
	} finally {
		globalThis.fetch = realFetch;
		resetAsrEndpoints();
	}
	assert.equal(state.ends, 1);
});
