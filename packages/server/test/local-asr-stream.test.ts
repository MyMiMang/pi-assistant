/**
 * 原生流式会话中枢（`LocalAsrStreamHub`）：start / append / end / cancel 的有界会话语义。
 *
 * 用**假 fetch**（可驱动的 sidecar 事件）+ 假时钟 + 假租约，绝不真正下载权重 / 起真实 sidecar / 碰麦克风。
 * 覆盖契约 `progress-snapshots/default-stream-contract.md` §2–§4：seq 单调 / 乱序拒绝、单流 busy、
 * 帧上限、来源变更明确取消不 fallback、idle 超时释放租约、引擎错误结构化。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ASR_STREAM_MAX_CHUNK_BYTES } from "../src/local-asr/manifest.ts";
import { ASR_STREAM_ERRORS, AsrStreamError, LocalAsrStreamHub, type AsrStreamTarget } from "../src/local-asr/stream.ts";

function capability() {
	return {
		protocol: "asr-stream-v1" as const,
		streaming: true as const,
		sampleRate: 16_000,
		channels: 1,
		format: "s16le" as const,
		partialIntervalHintMs: [200, 400] as [number, number],
		maxChunkBytes: ASR_STREAM_MAX_CHUNK_BYTES,
		maxSessionMs: 60_000,
		idleTimeoutMs: 10_000,
		punctuation: false,
		languages: ["zh", "en"],
		requiresApiKey: false as const,
	};
}

interface FakeSidecar {
	fetch: typeof fetch;
	calls: string[];
	appendEvents: unknown[];
	finalText: string;
	failStatus: number | null;
}

function fakeSidecar(): FakeSidecar {
	const state: FakeSidecar = {
		calls: [],
		appendEvents: [{ type: "tentative", text: "ni hao", segmentId: "0" }],
		finalText: "你好",
		failStatus: null,
		fetch: (async (url: string | URL) => {
			const u = String(url);
			state.calls.push(u);
			if (state.failStatus) return new Response("boom", { status: state.failStatus });
			if (u.includes("/v1/stream/start")) return Response.json({ sessionId: "sidecar-1", sampleRate: 16_000 });
			if (u.includes("/v1/stream/append")) return Response.json({ events: state.appendEvents });
			if (u.includes("/v1/stream/end")) return Response.json({ events: [{ type: "final", text: state.finalText, segmentId: "0" }], finals: [state.finalText] });
			if (u.includes("/v1/stream/cancel")) return Response.json({ ok: true });
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch,
	};
	return state;
}

function makeHub(sidecar: FakeSidecar, opts: { version?: () => number; clock?: { t: number }; timers?: { fn: () => void; ms: number }[]; released?: { n: number } } = {}) {
	const clock = opts.clock ?? { t: 1_000 };
	const timers = opts.timers ?? [];
	const released = opts.released ?? { n: 0 };
	const target: AsrStreamTarget = {
		modelId: "streaming-zipformer-bilingual-zh-en-int8",
		provider: "local-online-zipformer",
		capability: capability(),
		baseUrl: "http://127.0.0.1:9/v1/",
		token: "tok",
		sampleRate: 16_000,
		lease: { release: () => released.n++ },
	};
	const hub = new LocalAsrStreamHub({
		resolveTarget: async () => ({ ok: true, target: { ...target, lease: { release: () => released.n++ } } }),
		selectionVersion: opts.version ?? (() => 1),
		now: () => clock.t,
		setTimer: (fn, ms) => {
			const entry = { fn, ms };
			timers.push(entry);
			return { cancel: () => timers.splice(timers.indexOf(entry), 1) };
		},
		fetchImpl: sidecar.fetch,
	});
	return { hub, clock, timers, released };
}

test("create → append（事件规范化 + seq）→ end（final + 释放租约）", async () => {
	const sidecar = fakeSidecar();
	const { hub, released } = makeHub(sidecar);
	const created = await hub.create({ principal: "local" });
	assert.equal(created.sessionId, "asr-stream-1");
	assert.equal(created.protocol, "asr-stream-v1");
	// 真实 URL 形状：manager 注册的 baseUrl 已以 `/v1/` 结尾，路径必须相对拼（不能拼出 /v1/v1/… 导致真 sidecar 404）。
	const startUrl = sidecar.calls[0];
	assert.equal(startUrl, "http://127.0.0.1:9/v1/stream/start", `start URL 不对：${startUrl}`);
	assert.equal(created.nextSeq, 0);
	assert.equal(hub.activeCount(), 1);

	const r = await hub.append(created.sessionId, 0, new Uint8Array(320), { principal: "local" });
	assert.equal(r.seq, 0);
	assert.equal(r.nextSeq, 1);
	assert.equal(r.accepted, 320);
	assert.equal(r.events.length, 1);
	assert.deepEqual(r.events[0], { type: "tentative", text: "ni hao", segmentId: "0", seq: 0 });

	const ended = await hub.end(created.sessionId, { principal: "local" });
	assert.equal(ended.state, "ended");
	for (const u of sidecar.calls) assert.equal(u.includes("/v1/v1/"), false, `路径重复 /v1：${u}`);
	assert.equal(ended.finals[0].text, "你好");
	assert.equal(released.n, 1);
	assert.equal(hub.activeCount(), 0);
});

test("seq 乱序（gap）/ 重复（replay）明确拒绝，不重复喂音频", async () => {
	const sidecar = fakeSidecar();
	const { hub } = makeHub(sidecar);
	const s = await hub.create({ principal: "local" });
	await hub.append(s.sessionId, 0, new Uint8Array(10), { principal: "local" });
	await assert.rejects(() => hub.append(s.sessionId, 2, new Uint8Array(10), { principal: "local" }), (e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.seqGap);
	await assert.rejects(() => hub.append(s.sessionId, 0, new Uint8Array(10), { principal: "local" }), (e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.seqReplay);
	// 只有一次 append 真正到了 sidecar
	assert.equal(sidecar.calls.filter((u) => u.includes("/append")).length, 1);
});

test("单帧超上限 → frame_too_large；同一模型二次 create → busy（并释放多余租约）", async () => {
	const sidecar = fakeSidecar();
	const { hub, released } = makeHub(sidecar);
	const s = await hub.create({ principal: "local" });
	await assert.rejects(() => hub.append(s.sessionId, 0, new Uint8Array(ASR_STREAM_MAX_CHUNK_BYTES + 2), { principal: "local" }), (e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.frameTooLarge);
	const before = released.n;
	await assert.rejects(() => hub.create({ principal: "local" }), (e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.busy);
	assert.equal(released.n, before + 1);
});

test("来源被改选 → append 明确 asr_source_changed 并取消会话，绝不 fallback", async () => {
	const sidecar = fakeSidecar();
	let version = 1;
	const { hub, released } = makeHub(sidecar, { version: () => version });
	const s = await hub.create({ principal: "local" });
	version = 2;
	await assert.rejects(() => hub.append(s.sessionId, 0, new Uint8Array(10), { principal: "local" }), (e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.sourceChanged);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(hub.activeCount(), 0);
	assert.equal(released.n, 1);
});

test("idle 超时自动取消并释放租约；引擎错误结构化", async () => {
	const sidecar = fakeSidecar();
	const timers: { fn: () => void; ms: number }[] = [];
	const { hub, released } = makeHub(sidecar, { timers });
	const s = await hub.create({ principal: "local" });
	assert.equal(timers.length, 1);
	timers[0].fn();
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(hub.activeCount(), 0);
	assert.equal(released.n, 1);

	// 引擎 500 → engineError（新会话）
	sidecar.failStatus = 500;
	await assert.rejects(() => hub.create({ principal: "local" }), (e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.engineError);
});

test("未就绪的目标解析错误直接透传（不建会话、不泄漏租约）", async () => {
	const hub = new LocalAsrStreamHub({
		resolveTarget: async () => ({ ok: false, error: new AsrStreamError(ASR_STREAM_ERRORS.notReady, 409, "本地流式模型尚未准备完成") }),
		selectionVersion: () => 0,
		now: () => 0,
		setTimer: () => ({ cancel: () => {} }),
	});
	await assert.rejects(() => hub.create({ principal: "local" }), (e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.notReady && e.status === 409);
});

test("授权主体绑定：别的设备拿 sessionId 不能 append / cancel（403 forbidden）", async () => {
	const sidecar = fakeSidecar();
	const { hub, released } = makeHub(sidecar);
	const s = await hub.create({ principal: "device-A" });
	await assert.rejects(
		() => hub.append(s.sessionId, 0, new Uint8Array(10), { principal: "device-B" }),
		(e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.forbidden && e.status === 403,
	);
	await assert.rejects(() => hub.cancel(s.sessionId, { principal: "device-B" }), (e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.forbidden);
	assert.equal(hub.activeCount(), 1, "别人的 cancel 不能结束会话");
	await hub.cancel(s.sessionId, { principal: "device-A" });
	assert.equal(released.n, 1);
});

test("committed/tentative 语义：server-authoritative per-segment（committed=段稳定前缀，tentative=该段剩余整体，非 delta）", async () => {
	const sidecar = fakeSidecar();
	sidecar.appendEvents = [
		{ type: "committed", text: "你好", segmentId: "0" },
		{ type: "tentative", text: "世界", segmentId: "0" },
	];
	const { hub } = makeHub(sidecar);
	const s = await hub.create({ principal: "local" });
	const r = await hub.append(s.sessionId, 0, new Uint8Array(10), { principal: "local" });
	const committed = r.events.find((e) => e.type === "committed");
	const tentative = r.events.find((e) => e.type === "tentative");
	const committedText = committed && "text" in committed ? committed.text : "";
	const tentativeText = tentative && "text" in tentative ? tentative.text : "";
	assert.equal(committedText, "你好");
	assert.equal(tentativeText, "世界");
	assert.equal(committed?.segmentId, tentative?.segmentId, "同一 segmentId 下 committed 是前缀、tentative 是剩余整体");
});

test("归属 scope：创建时绑定 agent/conversation，后续请求头不一致 → 409 scope_mismatch；缺头沿用会话归属", async () => {
	const sidecar = fakeSidecar();
	const { hub, released } = makeHub(sidecar);
	const s = await hub.create({ principal: "local", agentId: "a1", conversationId: "c1" });
	await assert.rejects(
		() => hub.append(s.sessionId, 0, new Uint8Array(10), { principal: "local", agentId: "a2" }),
		(e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.scopeMismatch && e.status === 409,
	);
	await assert.rejects(
		() => hub.end(s.sessionId, { principal: "local", agentId: "a1", conversationId: "c2" }),
		(e: unknown) => e instanceof AsrStreamError && e.code === ASR_STREAM_ERRORS.scopeMismatch,
	);
	// 缺头（旧客户端 / 语音从别处触发）不误拒：沿用会话创建时的归属。
	const ok = await hub.append(s.sessionId, 0, new Uint8Array(10), { principal: "local" });
	assert.equal(ok.nextSeq, 1);
	const ended = await hub.end(s.sessionId, { principal: "local", agentId: "a1", conversationId: "c1" });
	assert.equal(ended.state, "ended");
	assert.equal(released.n, 1, "end 必须释放租约");
});
