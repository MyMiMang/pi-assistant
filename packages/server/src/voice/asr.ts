/**
 * 语音输入（ASR）薄适配器：校验上传音频 → 调 OpenAI 兼容 `/v1/audio/transcriptions`。
 *
 * 安全 / 隐私约束（写死，见 docs/design/voice-input.md §4.2）：
 *  - **只处理上传上来的字节**：不从远程 URL fetch 音频、不读任意本地路径、不跑 ffmpeg 处理用户可控路径、不接受 SSRF 型 scheme。
 *  - 音频只在**内存 buffer** 里；不落盘、不进消息 / 日志 / 记忆。
 *  - 错误**脱敏**：不回显 apiKey / 上游 URL / 原始 body。
 *  - 幂等：`requestId` 只对 **已完成** 的结果直接复用，绝不自动重复调用上游（可能重复计费）；in-flight 返回 busy。
 *  - 取消：abort 上游；**明确 abort 不保证 provider 不计费**，不计为成功。
 *  - 用量：只记上游**真实返回**的数值，未知不填 0。
 */

import {
	ASR_ERRORS,
	ASR_MAX_BYTES,
	ASR_MAX_DURATION_MS,
	ASR_DEDUP_TTL_MS,
	ASR_PROTOCOLS,
	ASR_TIMEOUT_MS,
	type AsrEndpoint,
	type AsrErrorCode,
	type AsrRequest,
	type AsrResult,
	type AsrUsage,
	type WavInfo,
} from "./contract.ts";

export type AsrFail = { ok: false; code: AsrErrorCode; status: number; message: string };
export type AsrOk<T> = { ok: true; value: T };
export type AsrOutcome<T> = AsrOk<T> | AsrFail;

export const isAsrProtocol = (v: unknown): v is (typeof ASR_PROTOCOLS)[number] =>
	typeof v === "string" && (ASR_PROTOCOLS as readonly string[]).includes(v);

const fail = (code: AsrErrorCode, status: number, message: string): AsrFail => ({ ok: false, code, status, message });

/** 小写 ASCII 读 4 字节（RIFF chunk id）。 */
const fourcc = (b: Uint8Array, at: number): string =>
	String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/**
 * 解析 WAV（RIFF/WAVE）头，返回实际音频参数；不是合法 WAV 返回 null。
 * 只按 chunk 结构走，允许 `fmt ` 前有别的 chunk（如 LIST），并做边界检查（不读越界）。
 */
export function parseWav(bytes: Uint8Array): WavInfo | null {
	if (bytes.byteLength < 12) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (fourcc(bytes, 0) !== "RIFF" || fourcc(bytes, 8) !== "WAVE") return null;
	let at = 12;
	let fmt: { sampleRate: number; channels: number; bitsPerSample: number; format: number } | null = null;
	let dataBytes = -1;
	while (at + 8 <= bytes.byteLength) {
		const id = fourcc(bytes, at);
		const size = dv.getUint32(at + 4, true);
		const body = at + 8;
		if (body + size > bytes.byteLength) return null; // 截断
		if (id === "fmt ") {
			if (size < 16) return null;
			fmt = {
				format: dv.getUint16(body, true),
				channels: dv.getUint16(body + 2, true),
				sampleRate: dv.getUint32(body + 4, true),
				bitsPerSample: dv.getUint16(body + 14, true),
			};
		} else if (id === "data") {
			dataBytes = size;
		}
		at = body + size + (size % 2); // chunk 按偶数字节对齐
	}
	if (!fmt || dataBytes < 0 || fmt.channels <= 0 || fmt.sampleRate <= 0 || fmt.bitsPerSample <= 0) return null;
	const durationMs = Math.round((dataBytes / (fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8))) * 1000);
	return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, dataBytes, durationMs };
}

/** 校验上传音频：必须是 16 kHz / 单声道 / 16 bit PCM WAV，且在时长与字节上限内。 */
export function validateAsrAudio(
	bytes: Uint8Array,
	opts: { maxBytes?: number; maxDurationMs?: number } = {},
): AsrOutcome<WavInfo> {
	const maxBytes = opts.maxBytes ?? ASR_MAX_BYTES;
	const maxDurationMs = opts.maxDurationMs ?? ASR_MAX_DURATION_MS;
	if (bytes.byteLength === 0) return fail(ASR_ERRORS.invalidAudio, 400, "没有收到音频数据");
	if (bytes.byteLength > maxBytes) return fail(ASR_ERRORS.tooLarge, 413, `音频超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
	const info = parseWav(bytes);
	if (!info) return fail(ASR_ERRORS.invalidAudio, 400, "音频不是合法的 WAV（PCM）文件");
	if (info.sampleRate !== 16_000) return fail(ASR_ERRORS.invalidAudio, 400, "音频采样率必须是 16000 Hz");
	if (info.channels !== 1) return fail(ASR_ERRORS.invalidAudio, 400, "音频必须是单声道");
	if (info.bitsPerSample !== 16) return fail(ASR_ERRORS.invalidAudio, 400, "音频位深必须是 16 bit");
	if (info.durationMs > maxDurationMs) return fail(ASR_ERRORS.invalidAudio, 400, `音频超过 ${Math.round(maxDurationMs / 1000)} 秒上限`);
	return { ok: true, value: info };
}

/** 从上游返回里取文本；认不出就当失败（绝不返回空串冒充成功）。 */
function pickText(j: unknown): string | null {
	if (!j || typeof j !== "object") return null;
	const t = (j as { text?: unknown }).text;
	return typeof t === "string" && t.trim() ? t : null;
}

/** 只提取上游真实给出的用量数字；没有就不填（绝不填 0）。 */
function pickUsage(j: unknown): AsrUsage | undefined {
	if (!j || typeof j !== "object") return undefined;
	const o = j as Record<string, unknown>;
	const usage: AsrUsage = {};
	if (typeof o.duration === "number" && Number.isFinite(o.duration)) usage.audioSeconds = o.duration;
	// 本地 sidecar 返回的是 audioSeconds（真实值），同样只记真实数字。
	if (typeof o.audioSeconds === "number" && Number.isFinite(o.audioSeconds)) usage.audioSeconds = o.audioSeconds;
	const u = o.usage;
	if (u && typeof u === "object") {
		const uu = u as Record<string, unknown>;
		if (typeof uu.input_tokens === "number" && Number.isFinite(uu.input_tokens)) usage.inputTokens = uu.input_tokens;
		if (typeof uu.output_tokens === "number" && Number.isFinite(uu.output_tokens)) usage.outputTokens = uu.output_tokens;
	}
	return Object.keys(usage).length ? usage : undefined;
}

export interface UpstreamDeps {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	/** 外部取消（用户取消 / 客户端断开）。 */
	signal?: AbortSignal;
}

/** OpenAI 兼容的 multipart 表单（云 ASR）。 */
function openAiForm(req: AsrRequest): FormData {
	const fd = new FormData();
	fd.append("file", new Blob([req.audio as unknown as BlobPart], { type: "audio/wav" }), req.filename || "audio.wav");
	fd.append("model", req.model);
	if (req.language) fd.append("language", req.language);
	fd.append("response_format", "json");
	return fd;
}

/**
 * 调上游转写。**只**用传入的音频字节，不解析任何 URL / 本地路径。
 * 云 = OpenAI 兼容 multipart；本地 = loopback raw WAV（Bearer 进程内 token）。失败一律返回脱敏错误码。
 */
export async function transcribeUpstream(ep: AsrEndpoint, req: AsrRequest, deps: UpstreamDeps = {}): Promise<AsrOutcome<{ text: string; usage?: AsrUsage; durationMs: number }>> {
	if (!isAsrProtocol(ep.protocol)) return fail(ASR_ERRORS.notConfigured, 400, `不支持的 ASR 协议：${String(ep.protocol).slice(0, 40)}`);
	if (!/^https?:\/\//.test(ep.baseUrl)) return fail(ASR_ERRORS.notConfigured, 400, "ASR 服务地址无效");
	const fetchImpl = deps.fetchImpl ?? fetch;
	const timeoutMs = deps.timeoutMs ?? ASR_TIMEOUT_MS;
	const ctrl = new AbortController();
	const onAbort = () => ctrl.abort();
	deps.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
	const started = Date.now();
	try {
		const base = ep.baseUrl.replace(/\/+$/, "");
		const auth = ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : undefined;
		// 本地 sidecar（local-asr-http）：raw WAV body 到 `{baseUrl}audio/transcriptions`（baseUrl 已含 /v1/）。
		const local = ep.protocol === "local-asr-http";
		const url = local ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
		const res = local
			? await fetchImpl(url, { method: "POST", headers: { ...(auth ?? {}), "content-type": "audio/wav" }, body: req.audio as unknown as BodyInit, signal: ctrl.signal })
			: await fetchImpl(url, { method: "POST", headers: auth, body: openAiForm(req), signal: ctrl.signal });
		if (!res.ok) return fail(ASR_ERRORS.upstream, 502, `语音服务返回 ${res.status}`);
		let j: unknown;
		try {
			j = await res.json();
		} catch {
			return fail(ASR_ERRORS.upstream, 502, "语音服务返回了无法解析的内容");
		}
		const text = pickText(j);
		if (text === null) return fail(ASR_ERRORS.upstream, 502, "语音服务没有返回转写文本");
		return { ok: true, value: { text, usage: pickUsage(j), durationMs: Date.now() - started } };
	} catch (e) {
		// 取消优先：用户取消 / 客户端断开
		if (deps.signal?.aborted) return fail(ASR_ERRORS.aborted, 499, "已取消");
		if (ctrl.signal.aborted) return fail(ASR_ERRORS.timeout, 504, "语音转写超时");
		return fail(ASR_ERRORS.upstream, 502, e instanceof Error && e.name === "AbortError" ? "语音转写被中断" : "无法连接语音服务");
	} finally {
		clearTimeout(timer);
		deps.signal?.removeEventListener("abort", onAbort);
	}
}

interface DedupEntry {
	status: "inflight" | "completed";
	at: number;
	result?: AsrResult;
}

export interface AsrServiceDeps {
	/** 解析 provider/model → 端点（由注册表 + 公开凭据接口提供）。 */
	resolve: (provider: string, model: string) => Promise<AsrOutcome<AsrEndpoint>>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	dedupTtlMs?: number;
	maxBytes?: number;
	maxDurationMs?: number;
	now?: () => number;
}

export interface AsrService {
	transcribe: (req: AsrRequest, signal?: AbortSignal) => Promise<AsrOutcome<AsrResult>>;
	/** 测试 / 清理用：当前幂等缓存条数。 */
	size: () => number;
}

/**
 * 转写服务：校验 → 幂等 → 调上游。幂等只复用**已完成**结果；in-flight 返回 busy，不 join、不重复调用。
 */
export function createAsrService(deps: AsrServiceDeps): AsrService {
	const cache = new Map<string, DedupEntry>();
	const now = deps.now ?? (() => Date.now());
	const ttl = deps.dedupTtlMs ?? ASR_DEDUP_TTL_MS;

	const prune = () => {
		const t = now();
		for (const [k, v] of cache) if (v.status === "completed" && t - v.at > ttl) cache.delete(k);
	};

	return {
		size: () => cache.size,
		async transcribe(req, signal) {
			prune();
			if (!req.requestId) return fail(ASR_ERRORS.invalidAudio, 400, "缺少 requestId");
			const hit = cache.get(req.requestId);
			if (hit?.status === "completed" && hit.result) return { ok: true, value: hit.result };
			if (hit?.status === "inflight") return fail(ASR_ERRORS.busy, 409, "同一个请求正在处理中");

			const check = validateAsrAudio(req.audio, { maxBytes: deps.maxBytes, maxDurationMs: deps.maxDurationMs });
			if (!check.ok) return check;

			const ep = await deps.resolve(req.provider, req.model);
			if (!ep.ok) return ep;

			cache.set(req.requestId, { status: "inflight", at: now() });
			const up = await transcribeUpstream(ep.value, req, { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, signal });
			if (!up.ok) {
				// 失败不缓存：允许用户手动重试（不自动重试）。
				cache.delete(req.requestId);
				return up;
			}
			const result: AsrResult = { text: up.value.text, provider: req.provider, model: req.model, durationMs: up.value.durationMs, ...(up.value.usage ? { usage: up.value.usage } : {}) };
			cache.set(req.requestId, { status: "completed", at: now(), result });
			return { ok: true, value: result };
		},
	};
}
