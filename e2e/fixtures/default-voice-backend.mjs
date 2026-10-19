/**
 * default-voice-flow 的可控语音后端（Playwright 路由层注入，不下载任何权重、不碰真实数据）：
 * 来源视图 / 本地语音模块状态 / 窄接口安装取消 / 目录补丁 / 原生流式会话脚本。`state` 由用例直接改。
 */
export const DEF = "streaming-zipformer-bilingual-zh-en-int8";
export const DEF_PROVIDER = "local-online-zipformer";
export const PARA = "paraformer-zh-2023-09-14-int8";
export const PARA_PROVIDER = "local-paraformer";
export const NAMES = { [DEF]: "本地流式听写（中英双语）", [PARA]: "Paraformer 中文（本地）" };
export const CLOUD = { location: "cloud", provider: "openai", model: "whisper-1" };

export function createVoiceBackend() {
	/* ------------------------------- 可控的语音后端状态（路由层注入，不下载任何权重） ------------------------------- */
	const state = {
		version: 1,
		source: null, // null | {location, provider, model}
		prep: { state: "preparing", percent: 40, phase: "weights", error: null },
		modelId: DEF, // 模块当前对应的模型（服务端 moduleModelId）
		installBodies: [],
		stream: { mode: "normal", creates: 0, appends: 0, ends: 0, cancels: 0, seqs: [], bytes: 0, aborted: 0 },
		calls: { cancelPrepare: 0, installPrepare: 0, downloadsCancel: 0, downloadsStart: 0, messages: 0, transcriptions: 0 },
	};
	const prepView = () => ({
		defaultModelId: DEF,
		modelId: state.modelId,
		modelName: NAMES[state.modelId] ?? state.modelId,
		kind: state.source ? (state.source.model === DEF ? "default" : "user-chosen") : "unconfigured",
		label: state.source?.model === DEF ? "正在使用默认本地流式听写" : "还没选语音识别来源；默认提供本地流式听写",
		prep: {
			state: state.prep.state,
			jobId: `asr:${state.modelId}`,
			phase: state.prep.phase,
			phaseLabel: state.prep.phase === "weights" ? "下载权重" : null,
			received: state.prep.state === "preparing" ? Math.round((198_270_793 * (state.prep.percent ?? 0)) / 100) : null,
			total: state.prep.state === "preparing" ? 198_270_793 : null,
			percent: state.prep.state === "preparing" ? state.prep.percent : null,
			attempt: 1,
			startedAt: "2026-10-17T00:00:00.000Z",
			finishedAt: state.prep.state === "ready" ? "2026-10-17T00:02:00.000Z" : null,
			error: state.prep.error,
			errorCode: state.prep.error ? "asr_prepare_failed" : null,
			retryable: state.prep.state === "failed",
		},
		firstRunNeedsNetwork: true,
		approxBytes: 293_270_793,
		offlineAfterReady: true,
		requiresUserAction: true,
		micPermissionRequested: false,
		notes: ["可选模块：默认不安装，不随安装包分发；在 设置 › 语音 点「安装」才会下载", "默认流式模型输出无标点；麦克风权限只在用户点麦克风时申请"],
	});
	const sourceView = () => ({
		source: state.source,
		version: state.version,
		options: [
			{
				location: "local",
				provider: DEF_PROVIDER,
				model: DEF,
				name: "本地流式听写（中英双语）",
				protocol: "asr-stream-v1",
				streaming: true,
				streamProtocol: "asr-stream-v1",
				availability: state.prep.state === "ready" && state.modelId === DEF ? "ready" : "not_installed",
				reason: state.prep.state === "ready" && state.modelId === DEF ? null : "本地语音识别未安装",
				selected: state.source?.model === DEF,
			},
			{
				location: "local",
				provider: PARA_PROVIDER,
				model: PARA,
				name: NAMES[PARA],
				protocol: "local-asr-http",
				streaming: false,
				streamProtocol: null,
				availability: state.prep.state === "ready" && state.modelId === PARA ? "ready" : "not_installed",
				reason: null,
				selected: state.source?.model === PARA,
			},
			{
				location: "cloud",
				provider: CLOUD.provider,
				model: CLOUD.model,
				name: "云端 whisper-1",
				protocol: "openai-audio-transcriptions",
				streaming: false,
				streamProtocol: null,
				availability: "ready",
				reason: null,
				selected: state.source?.location === "cloud",
			},
		],
		defaultVoice: prepView(),
	});

	return { state, prepView, sourceView };
}

/** 把整套假后端挂到页面上（`agentId` 用于拦截自动发送）。 */
export async function routeVoiceBackend(page, { state, prepView, sourceView }, agentId) {
	await page.route("**/api/audio/asr/source", async (route) => {
		if (route.request().method() === "PUT") {
			const body = route.request().postDataJSON() ?? {};
			state.source = body.source ?? null;
			state.version += 1;
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sourceView()) });
		}
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sourceView()) });
	});
	await page.route("**/api/local-models/asr/default-voice/cancel", async (route) => {
		state.calls.cancelPrepare += 1;
		state.prep = { state: "not_prepared", percent: null, phase: null, error: null };
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, reason: "已取消", defaultVoice: prepView() }) });
	});
	await page.route("**/api/local-models/asr/default-voice/install", async (route) => {
		state.calls.installPrepare += 1;
		const body = route.request().postDataJSON() ?? null;
		state.installBodies.push(body);
		if (body?.modelId) state.modelId = body.modelId; // 省略 = 服务端重试模块当前模型
		state.prep = { state: "preparing", percent: 10, phase: "weights", error: null };
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, reason: "已重新开始", defaultVoice: prepView() }) });
	});
	await page.route("**/api/downloads/*/cancel", async (route) => {
		state.calls.downloadsCancel += 1;
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route("**/api/downloads/*/start", async (route) => {
		state.calls.downloadsStart += 1;
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	// 目录用真实服务端（离线 Mock，没装任何模型）；模拟「装好了」时把对应模型标成已装 / 已选，运行环境已就位。
	await page.route("**/api/local-models/asr/catalog", async (route) => {
		const res = await route.fetch();
		const body = await res.json();
		if (state.prep.state === "ready") {
			body.runtime.present = true;
			for (const m of body.models)
				if (m.id === state.modelId) Object.assign(m, { installed: true, selected: state.source?.model === m.id, install: { ...m.install, state: "installed" } });
		}
		return route.fulfill({ response: res, json: body });
	});
	await page.route("**/api/downloads", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }));
	await page.route(`**/api/agents/${agentId}/messages`, async (route) => {
		state.calls.messages += 1;
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route("**/api/audio/transcriptions", async (route) => {
		state.calls.transcriptions += 1;
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "云端结果", provider: "openai", model: "whisper-1", durationMs: 1 }) });
	});

	/* 流式会话：按 `state.stream.mode` 脚本化事件（真实 wire 形状：committed / tentative / final / endpoint） */
	const sessions = new Map();
	let sid = 0;
	await page.route("**/api/audio/asr/stream**", async (route) => {
		const req = route.request();
		const u = new URL(req.url());
		const parts = u.pathname.split("/").filter(Boolean); // api audio asr stream [id] [op]
		const op = parts[5];
		const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (req.method() === "POST" && !op) {
			state.stream.creates += 1;
			const body = req.postDataJSON() ?? {};
			if (state.stream.mode === "slowopen") await new Promise((r) => setTimeout(r, 1200));
			const id = `asr-stream-${++sid}`;
			sessions.set(id, { seq: 0, appends: 0, created: body });
			return json(200, {
				sessionId: id,
				modelId: DEF,
				provider: DEF_PROVIDER,
				sourceVersion: state.version,
				leaseId: `lease-${id}`,
				protocol: "asr-stream-v1",
				sampleRate: 16000,
				channels: 1,
				format: "s16le",
				maxChunkBytes: 32000,
				partialIntervalHintMs: [200, 400],
				maxSessionMs: 60000,
				idleTimeoutMs: 10000,
				nextSeq: 0,
				state: "ready",
			});
		}
		const s = sessions.get(parts[4]);
		if (!s) return json(404, { error: "asr_stream_unknown", message: "未知会话" });
		if (op === "append") {
			const seq = Number(req.headers()["x-asr-seq"]);
			const bytes = (req.postDataBuffer() ?? Buffer.alloc(0)).length;
			state.stream.appends += 1;
			state.stream.seqs.push(seq);
			state.stream.bytes += bytes;
			if (state.stream.mode === "replay" && state.stream.appends === 1) return json(409, { error: "asr_stream_seq_replay", message: "重复帧" });
			if (state.stream.mode === "sourcechange" && state.stream.appends === 1) return json(409, { error: "asr_source_changed", message: "语音识别来源已被改选，请重新开始录音" });
			s.appends += 1;
			s.seq = seq + 1;
			const events =
				s.appends === 1
					? [{ type: "tentative", text: state.stream.mode === "replay" ? "重复帧不" : "你好世界", segmentId: "0", seq }]
					: [
							{ type: "committed", text: state.stream.mode === "replay" ? "重复帧" : "你好", segmentId: "0", seq },
							{ type: "tentative", text: state.stream.mode === "replay" ? "" : "世界", segmentId: "0", seq },
						];
			return json(200, { seq, accepted: bytes, nextSeq: seq + 1, state: "listening", events, buffered: 0 });
		}
		if (op === "end") {
			state.stream.ends += 1;
			const text = state.stream.mode === "replay" ? "重复帧不重发" : "你好你好";
			return json(200, {
				sessionId: parts[4],
				state: "ended",
				modelId: DEF,
				sourceVersion: state.version,
				finals: [{ type: "final", text, segmentId: "0", seq: s.seq }],
			});
		}
		if (op === "cancel") {
			state.stream.cancels += 1;
			return json(200, { sessionId: parts[4], state: "cancelled" });
		}
		return json(200, { sessionId: parts[4], state: "listening", nextSeq: s.seq });
	});
}
