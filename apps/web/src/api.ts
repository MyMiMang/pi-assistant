/**
 * 连接管理：
 *  - 本机或经隧道直接打开（PWA 由本地服务托管）：base = ""（同源）
 *  - 从入口域名打开（PWA 外壳）：base = 当前隧道地址，通过 Rendezvous 查询并用配对时保存的服务公钥校验签名
 */
import * as ed from "@noble/ed25519";

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
}
/** `GET/PUT /api/audio/asr/source` 同一 DTO：当前选择 + 归一化候选列表。 */
export interface VoiceSourceView {
	source: VoiceSource | null;
	options: VoiceSourceOption[];
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
