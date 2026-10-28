/**
 * 连接管理：
 *  - 本机或经隧道直接打开（PWA 由本地服务托管）：base = ""（同源）
 *  - 从入口域名打开（PWA 外壳）：base = 当前隧道地址，通过 Rendezvous 查询并用配对时保存的服务公钥校验签名
 */
import * as ed from "@noble/ed25519";
import { AsrStreamError, normalizeStreamEvents, type VoiceStreamLimits, type VoiceStreamOpen } from "./voice-stream.ts";

export interface Conn {
	serverId: string;
	base: string;
	token?: string;
	publicKey?: string;
}
const KEY = "pia.conn";
export function loadConn(): Conn | null {
	try {
		return JSON.parse(localStorage.getItem(KEY) ?? "null");
	} catch {
		return null;
	}
}
export function saveConn(c: Conn | null) {
	if (c) localStorage.setItem(KEY, JSON.stringify(c));
	else localStorage.removeItem(KEY);
	conn = c;
}
let conn: Conn | null = loadConn();
export const getConn = () => conn;
export const base = () => (conn && conn.base && conn.base !== location.origin ? conn.base : "");

export class ApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
	}
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (conn?.token) headers.set("authorization", `Bearer ${conn.token}`);
	let body = init.body;
	if (init.json !== undefined) {
		headers.set("content-type", "application/json");
		body = JSON.stringify(init.json);
	}
	const res = await fetch(base() + path, { ...init, headers, body });
	if (!res.ok) {
		let msg = res.statusText;
		let data: unknown;
		try {
			const j = await res.json();
			// 新接口用 {error: code, message: 中文}；旧接口用 {error: 中文}。优先显示可读的中文说明。
			msg = (j as { message?: string }).message ?? (j as { error?: string }).error ?? msg;
			data = j;
		} catch {
			/* ignore */
		}
		throw new ApiError(res.status, msg, data);
	}
	const ct = res.headers.get("content-type") ?? "";
	return (ct.includes("json") ? res.json() : res.text()) as Promise<T>;
}

export async function fetchBlob(path: string, signal?: AbortSignal): Promise<Blob> {
	const headers = new Headers();
	if (conn?.token) headers.set("authorization", `Bearer ${conn.token}`);
	const res = await fetch(base() + path, { headers, signal });
	if (!res.ok) throw new ApiError(res.status, res.statusText);
	return res.blob();
}

/**
 * 预览用：带字节上限地拉取文件。超过上限不读完 body，只回报 oversized（界面提示 + 下载）。
 * 认证方式与 fetchBlob 一致（带登录凭证），只走授权资源地址。
 */
export async function fetchBlobLimited(path: string, maxBytes: number, signal?: AbortSignal): Promise<{ blob: Blob; oversized: boolean }> {
	const headers = new Headers();
	if (conn?.token) headers.set("authorization", `Bearer ${conn.token}`);
	const res = await fetch(base() + path, { headers, signal });
	if (!res.ok) throw new ApiError(res.status, res.statusText);
	const len = Number(res.headers.get("content-length"));
	if (Number.isFinite(len) && len > maxBytes) {
		try {
			await res.body?.cancel();
		} catch {
			/* ignore */
		}
		return { blob: new Blob(), oversized: true };
	}
	// 没有 content-length（分块传输 / 代理改写）时也必须真按上限中断，绝不 read-all 大文件。
	if (!res.body) {
		const blob = await res.blob();
		return { blob, oversized: blob.size > maxBytes };
	}
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				try {
					await reader.cancel();
				} catch {
					/* ignore */
				}
				return { blob: new Blob(), oversized: true };
			}
			chunks.push(value);
		}
	} catch (e) {
		if (total > maxBytes) return { blob: new Blob(), oversized: true };
		throw e;
	}
	return { blob: new Blob(chunks as BlobPart[]), oversized: false };
}

/**
 * 视频 / 音频播放地址：<video src> 带不了 Authorization 头（也不能为了拖进度条把大文件整个拉成 blob），
 * 所以用登录凭证向服务端换一条短时有效、只针对这一个文件的签名链接（服务端 GET <path>/play-link）。
 */
export async function mediaUrl(path: string): Promise<string> {
	const { url } = await api<{ url: string }>(`${path}/play-link`);
	return base() + url;
}

/** HTML 文件的网页预览地址：iframe 带不了 Authorization 头，同样先换一条 10 分钟有效、只针对这个文件的签名链接。 */
export async function viewUrl(path: string): Promise<string> {
	const { url } = await api<{ url: string }>(`${path}/view-link`);
	return base() + url;
}

export async function download(path: string, name: string) {
	const blob = await fetchBlob(path);
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function uploadRoom(roomId: string, file: File) {
	const fd = new FormData();
	fd.append("file", file);
	return api(`/api/rooms/${roomId}/upload`, { method: "POST", body: fd });
}

export async function upload(agentId: string, file: File) {
	const fd = new FormData();
	fd.append("file", file);
	return api(`/api/agents/${agentId}/upload`, { method: "POST", body: fd });
}

/** 语音输入：上传 16 kHz PCM16 WAV 到自有 Pi Server 转写（音频只在内存，不落附件/消息）。 */
export interface TranscribeInput {
	audio: Uint8Array;
	provider: string;
	model: string;
	requestId: string;
	language?: string;
	agentId?: string;
	conversationId?: string;
	signal?: AbortSignal;
}
export async function transcribeAudio(input: TranscribeInput): Promise<{ text: string; provider: string; model: string; durationMs: number }> {
	const fd = new FormData();
	fd.append("file", new Blob([input.audio as unknown as BlobPart], { type: "audio/wav" }), "audio.wav");
	fd.append("provider", input.provider);
	fd.append("model", input.model);
	fd.append("requestId", input.requestId);
	if (input.language) fd.append("language", input.language);
	if (input.agentId) fd.append("agentId", input.agentId);
	if (input.conversationId) fd.append("conversationId", input.conversationId);
	return api(`/api/audio/transcriptions`, { method: "POST", body: fd, signal: input.signal });
}

/** 语音识别来源（用户显式选择）：null = 未配置。后端 fail-closed，不回落到第一个云。 */
export interface VoiceSource {
	location: "cloud" | "local";
	provider: string;
	model: string;
}
/** 来源可用性：**只有 ready 表示现在就能用**，其余一律带中文 reason（由后端归一化）。 */
export type VoiceSourceAvailability = "ready" | "not_configured" | "not_installed" | "not_running" | "deleted";
export interface VoiceSourceOption {
	location: "cloud" | "local";
	provider: string;
	model: string;
	name: string;
	protocol: string;
	availability: VoiceSourceAvailability;
	reason: string | null;
	selected: boolean;
	/**
	 * 服务端模型能力：是否原生流式（sherpa `OnlineRecognizer`）。
	 * **只在为 true 时前端才走流式路径**，不凭 provider / model 名字里带 online 猜；缺字段（旧后端 / 未接线）= 不启用。
	 */
	streaming?: boolean;
	/** 流式协议（`streaming=true` 时为 `asr-stream-v1`；其余为 null）。 */
	streamProtocol?: string | null;
}

/** 流式协议标识（与后端 `ASR_STREAM_PROTOCOL` 一致）。 */
export const ASR_STREAM_PROTOCOL = "asr-stream-v1";

/**
 * 该来源是否声明了原生流式能力。**三项都要**：`streaming === true` 且 `protocol` / `streamProtocol` 都等于
 * `asr-stream-v1`。只比较 `protocol === streamProtocol` 不够（两个 undefined 也“相等”）——旧后端会误判成流式。
 */
export function isStreamingSource(o: VoiceSourceOption | null | undefined): boolean {
	return o?.streaming === true && o.protocol === ASR_STREAM_PROTOCOL && o.streamProtocol === ASR_STREAM_PROTOCOL;
}
/** `GET/PUT /api/audio/asr/source` 同一 DTO：当前选择 + 归一化候选列表。 */
export interface VoiceSourceView {
	source: VoiceSource | null;
	options: VoiceSourceOption[];
	/** 每次写入递增的 CAS 版本（跨客户端）。 */
	version?: number;
	/** 本地语音（可选模块）的安装状态（契约 §1.1；旧后端缺省 undefined → `voice-pref` 归一化后不显示）。 */
	defaultVoice?: unknown;
}

/** 读取当前语音来源与候选（不启动 / 不下载 / 不连云 / 不读 Key）。接口不可用时抛出（调用方按「暂不可用」处理）。 */
export async function getVoiceSource(): Promise<VoiceSourceView> {
	return api<VoiceSourceView>("/api/audio/asr/source");
}

// 「语音配置」保存成功后通知语音输入按钮刷新选中（前端事件，不做轮询）。
type VoiceSourceListener = () => void;
const voiceSourceListeners = new Set<VoiceSourceListener>();
export function onVoiceSourceChanged(cb: VoiceSourceListener): () => void {
	voiceSourceListeners.add(cb);
	return () => voiceSourceListeners.delete(cb);
}
export function emitVoiceSourceChanged() {
	for (const cb of [...voiceSourceListeners]) cb();
}

/** 写入语音来源（`null` = 改回未配置）；成功返回后端确认视图，失败抛出让 UI 回滚。 */
export async function setVoiceSource(source: VoiceSource | null): Promise<VoiceSourceView> {
	const r = await api<VoiceSourceView>("/api/audio/asr/source", { method: "PUT", json: { source } });
	emitVoiceSourceChanged();
	return r;
}

/** 每个助理的子代理任务参数：settings = 生效值（override 优先，否则 defaults）；overrides 缺字段 = 继承。 */
export interface SubagentSettings {
	maxConcurrent: number;
	maxMinutes: number;
}
export interface SubagentSettingsResponse {
	settings: SubagentSettings;
	overrides: Partial<SubagentSettings>;
	defaults: SubagentSettings;
}
export async function getAgentSubagentSettings(agentId: string): Promise<SubagentSettingsResponse> {
	return api<SubagentSettingsResponse>(`/api/agents/${encodeURIComponent(agentId)}/subagents/settings`);
}
/** patch 里字段传 null = 改回继承默认；不传 = 不动。 */
export async function setAgentSubagentSettings(agentId: string, patch: { maxConcurrent?: number | null; maxMinutes?: number | null }): Promise<SubagentSettingsResponse> {
	return api<SubagentSettingsResponse>(`/api/agents/${encodeURIComponent(agentId)}/subagents/settings`, { method: "PUT", json: patch });
}

/** 录音租约（只对本地 ASR 有意义）：录音期间持有，避免本地模型被 idle 卸载。失败不阻塞录音。 */
export async function acquireAsrLease(provider: string, model: string): Promise<string | null> {
	try {
		const r = await api<{ leaseId: string }>("/api/audio/asr/lease", { method: "POST", json: { provider, model } });
		return r.leaseId ?? null;
	} catch {
		return null;
	}
}
export async function releaseAsrLease(leaseId: string): Promise<void> {
	try {
		await api(`/api/audio/asr/lease/${encodeURIComponent(leaseId)}`, { method: "DELETE" });
	} catch {
		/* 释放失败不影响用户 */
	}
}

// ---------------------------------------------------------------- 默认本地语音（可选模块，复用统一下载组件）

/**
 * 统一「下载与组件」的起 / 停（默认本地语音的准备复用同一个 job：`asr:<modelId>`）。
 * **不另造下载链路**；这两个端点是 localOnly（本机设置页用）。
 */
export async function startDownloadJob(id: string): Promise<void> {
	await api(`/api/downloads/${encodeURIComponent(id)}/start`, { method: "POST" });
}
export async function cancelDownloadJob(id: string): Promise<void> {
	await api(`/api/downloads/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

/**
 * 默认本地语音（可选模块）的**窄**安装 / 取消（固定默认模型，不接受任意 modelId / downloadId）。
 * 安装与失败重试共用 install。
 *
 * 为何不用 `/api/downloads/:id/*`：那两个是 `localOnly`，手机（已配对）会失败；窄接口走正常 safe API，
 * 服务端只动目录里唯一的默认模型 + 同一下载 job，能力边界比通用下载接口更小。
 */
/** 本地语音模块窄接口：`modelId` 只认目录里的模型；省略 = 模块当前对应的模型（失败重试 / 默认）。 */
export async function cancelDefaultVoicePrepare(modelId?: string): Promise<void> {
	await api("/api/local-models/asr/default-voice/cancel", { method: "POST", json: modelId ? { modelId } : undefined });
}
export async function installDefaultVoice(modelId?: string): Promise<void> {
	await api("/api/local-models/asr/default-voice/install", { method: "POST", json: modelId ? { modelId } : undefined });
}

// ---------------------------------------------------------------- 原生流式本地语音（start / append / end / cancel）

/** `POST /api/audio/asr/stream` 响应（契约 §2.1，字段名与后端一致）。 */
export interface AsrStreamSession {
	sessionId: string;
	modelId: string;
	provider: string;
	sourceVersion: number;
	leaseId: string;
	protocol: string;
	sampleRate: number;
	channels: number;
	format: string;
	maxChunkBytes: number;
	partialIntervalHintMs: [number, number];
	maxSessionMs: number;
	idleTimeoutMs: number;
	nextSeq: number;
	state: string;
}
export interface AsrStreamAppendResponse {
	seq: number;
	accepted: number;
	nextSeq: number;
	state: string;
	events: unknown[];
	buffered: number;
}
export interface AsrStreamEndResponse {
	sessionId: string;
	state: string;
	modelId: string;
	sourceVersion: number;
	finals: unknown[];
}

const STREAM_CREATE_DEADLINE_MS = 8_000;
const STREAM_APPEND_DEADLINE_MS = 15_000;
const STREAM_END_DEADLINE_MS = 15_000;
const STREAM_CANCEL_DEADLINE_MS = 2_000;
const STREAM_BACKPRESSURE_RETRIES = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** 单请求 deadline（防 append / end / cancel 无限挂）；`done()` 必须清掉定时器。 */
function streamDeadline(ms: number): { signal: AbortSignal; done: () => void } {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(Object.assign(new Error("asr_stream_timeout"), { name: "TimeoutError" })), ms);
	return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/** 把 `api()` 抛出的 `ApiError` / abort 归一成带稳定 code 的 `AsrStreamError`（前端按 code 分支，不靠文案）。 */
function asrStreamErrorFrom(e: unknown): AsrStreamError {
	if (e instanceof AsrStreamError) return e;
	if (e instanceof ApiError) {
		const data = (e.data ?? {}) as { error?: unknown; retryAfterMs?: unknown };
		const code = typeof data.error === "string" ? data.error : "";
		return new AsrStreamError(code || "asr_engine_error", e.status, e.message || code, typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined);
	}
	const name = e && typeof e === "object" && "name" in e ? String((e as { name?: unknown }).name ?? "") : "";
	if (name === "TimeoutError" || name === "AbortError") return new AsrStreamError("asr_stream_timeout", 0, "本地流式识别请求超时");
	return new AsrStreamError("asr_stream_unavailable", 0, e instanceof Error ? e.message : String(e));
}

/**
 * 打开原生流式会话（契约 §2）：`POST /stream` 建会话 → `append` 串行帧 → `end` / `cancel`。
 *
 * 走**现 safe API 鉴权**（`api()` 自动带 `authorization` / 同源 Cookie，移动端经隧道一致，不另存 Bearer、不直连 sidecar）；
 * 每次 append / end / cancel 都带 `x-asr-agent` / `x-asr-conversation`（后端绑定 caller + scope，缺一可能 409）。
 * 不使用浏览器原生流式上传（Safari 不支持）——这是普通有界 HTTP 会话。
 */
export const openAsrStream: VoiceStreamOpen = async (opts) => {
	const scope: Record<string, string> = {};
	if (opts.agentId) scope["x-asr-agent"] = opts.agentId;
	if (opts.conversationId) scope["x-asr-conversation"] = opts.conversationId;

	const create = streamDeadline(STREAM_CREATE_DEADLINE_MS);
	let session: AsrStreamSession;
	try {
		session = await api<AsrStreamSession>("/api/audio/asr/stream", {
			method: "POST",
			json: { modelId: opts.model, sampleRate: 16_000, channels: 1, format: "s16le", ...(opts.agentId ? { agentId: opts.agentId } : {}), ...(opts.conversationId ? { conversationId: opts.conversationId } : {}) },
			signal: create.signal,
		});
	} catch (e) {
		throw asrStreamErrorFrom(e);
	} finally {
		create.done();
	}
	if (!session || typeof session.sessionId !== "string" || !session.sessionId) throw new AsrStreamError("asr_engine_error", 0, "本地流式会话未返回 sessionId");

	const sessionId = session.sessionId;
	const path = (suffix: string) => `/api/audio/asr/stream/${encodeURIComponent(sessionId)}${suffix}`;
	const hint = session.partialIntervalHintMs;
	const limits: VoiceStreamLimits = {
		maxChunkBytes: typeof session.maxChunkBytes === "number" ? session.maxChunkBytes : 32_000,
		maxSessionMs: typeof session.maxSessionMs === "number" ? session.maxSessionMs : 60_000,
		idleTimeoutMs: typeof session.idleTimeoutMs === "number" ? session.idleTimeoutMs : 10_000,
		partialIntervalHintMs: Array.isArray(hint) && hint.length === 2 ? [Number(hint[0]) || 200, Number(hint[1]) || 400] : [200, 400],
		sampleRate: typeof session.sampleRate === "number" ? session.sampleRate : 16_000,
	};
	let dead = false;
	const emit = (raw: unknown) => {
		for (const u of normalizeStreamEvents(raw)) opts.onUpdate(u);
	};

	const append = async (pcm: Int16Array, seq: number): Promise<void> => {
		if (dead) throw new AsrStreamError("asr_stream_unknown", 0, "流式会话已结束");
		const body = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) as unknown as BodyInit;
		for (let attempt = 0; ; attempt++) {
			const deadline = streamDeadline(STREAM_APPEND_DEADLINE_MS);
			try {
				const r = await api<AsrStreamAppendResponse>(path("/append"), {
					method: "POST",
					body,
					headers: { "content-type": "application/octet-stream", "x-asr-seq": String(seq), ...scope },
					signal: deadline.signal,
				});
				emit(r?.events);
				return;
			} catch (e) {
				const err = asrStreamErrorFrom(e);
				// 重复帧（响应丢失后的重发）：服务端已收到该 seq，**不重复喂音频** → 当 ack。
				if (err.code === "asr_stream_seq_replay") return;
				// 服务端积压：按 retryAfterMs 退避重发（有界，绝不无限排队）。
				if (err.code === "asr_stream_backpressure" && attempt < STREAM_BACKPRESSURE_RETRIES) {
					await sleep(Math.min(err.retryAfterMs ?? 250, 5_000));
					continue;
				}
				if (err.code === "asr_source_changed" || err.code === "asr_stream_expired" || err.code === "asr_stream_unknown" || err.code === "asr_stream_forbidden") dead = true;
				throw err;
			} finally {
				deadline.done();
			}
		}
	};

	const finish = async (): Promise<void> => {
		if (dead) return;
		dead = true;
		const deadline = streamDeadline(STREAM_END_DEADLINE_MS);
		try {
			const r = await api<AsrStreamEndResponse>(path("/end"), { method: "POST", json: { reason: "stop" }, headers: scope, signal: deadline.signal });
			emit(r?.finals);
		} catch (e) {
			throw asrStreamErrorFrom(e);
		} finally {
			deadline.done();
		}
	};

	const abort = (reason?: string): void => {
		dead = true;
		// best-effort：独立短 signal（主请求的 signal 可能已 abort，但服务端仍需 close，否则留租约到 idle 超时）。
		const deadline = streamDeadline(STREAM_CANCEL_DEADLINE_MS);
		void api(path("/cancel"), { method: "POST", json: { reason: reason === "late" ? "client_late" : "client_cancel" }, headers: scope, signal: deadline.signal })
			.catch(() => {})
			.finally(() => deadline.done());
	};

	return { append, finish, abort, limits };
};

/** 从入口域名的 Rendezvous 查询服务当前地址，并校验签名。 */
export async function refreshFromRendezvous(): Promise<boolean> {
	if (!conn?.publicKey || !conn.serverId) return false;
	try {
		const r = await fetch(`/api/servers/${conn.serverId}`);
		if (!r.ok) return false;
		const rec = (await r.json()) as { url: string; ts: number; sig: string };
		const msg = new TextEncoder().encode(`pia-rendezvous-v1\n${conn.serverId}\n${rec.url}\n${rec.ts}`);
		const ok = await ed.verifyAsync(b64urlDecode(rec.sig), msg, b64urlDecode(conn.publicKey));
		if (!ok || !/^https:\/\//.test(rec.url)) return false;
		saveConn({ ...conn, base: rec.url });
		return true;
	} catch {
		return false;
	}
}
function b64urlDecode(s: string) {
	const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
	return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- WebSocket（自动重连）
type Handler = (e: any) => void;
export function connectWs(onEvent: Handler, onState: (s: "connecting" | "open" | "closed" | "unauthorized") => void) {
	let ws: WebSocket | null = null;
	let retry = 500;
	let stopped = false;
	const open = () => {
		if (stopped) return;
		onState("connecting");
		const b = base() || location.origin;
		ws = new WebSocket(`${b.replace(/^http/, "ws")}/ws`);
		ws.onopen = () => {
			retry = 500;
			if (conn?.token) ws!.send(JSON.stringify({ type: "auth", token: conn.token }));
		};
		ws.onmessage = (m) => {
			const e = JSON.parse(m.data);
			if (e.type === "hello") onState("open");
			onEvent(e);
		};
		ws.onclose = (ev) => {
			if (ev.code === 4401) {
				onState("unauthorized");
				return;
			}
			onState("closed");
			setTimeout(open, retry);
			retry = Math.min(retry * 2, 15_000);
		};
	};
	open();
	const ping = setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ type: "ping" })), 20_000);
	return () => {
		stopped = true;
		clearInterval(ping);
		ws?.close();
	};
}
