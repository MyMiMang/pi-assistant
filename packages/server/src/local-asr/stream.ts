/**
 * 本地 ASR **原生流式会话中枢**（host server 侧）。
 *
 * 职责（契约见 `progress-snapshots/default-stream-contract.md`）：
 *  - `start / append / end / cancel` **有界会话**；append 为帧批（建议 200–400ms 一帧），返回本批事件；
 *  - 每会话持有一个**录制租约**（会话期间 worker 不被 idle 卸载），结束 / 取消 / 超时 / 来源变更**必须释放**；
 *  - **单流 busy**：同一模型同一时刻只允许一个活跃会话；append **串行**（上一帧未返回不接受下一帧）；
 *  - `seq` 会话内单调，从 0 开始；乱序（gap）/ 重复（replay）明确拒绝，**不重复喂音频**；
 *  - 会话绑定创建时的 `sourceVersion`；期间来源被改选 → 取消会话并返回 `asr_source_changed`，**绝不 fallback 到别的模型**；
 *  - `maxChunkBytes` / `maxSessionMs` / `idleTimeoutMs` 全部有界；**无无限队列、无无限会话**。
 *
 * 不 import 任何 voice / http 实现：目标解析（模型 / 端点 / 租约）经注入的 `resolveTarget` 提供，便于单测。
 * 测试用**假 fetch**（可驱动的 sidecar 事件），绝不真正下载权重 / 起真实 sidecar / 碰真实麦克风。
 */

import type { AsrAdapterCapability } from "./manifest.ts";
import { ASR_STREAM_IDLE_TIMEOUT_MS, ASR_STREAM_MAX_CHUNK_BYTES, ASR_STREAM_MAX_SESSION_MS } from "./manifest.ts";

/** 流式事件（服务端给出 committed / tentative / final；见契约 §2.3）。 */
export type AsrStreamEvent =
	| { type: "committed"; text: string; segmentId: string; seq: number }
	| { type: "tentative"; text: string; segmentId: string; seq: number }
	| { type: "final"; text: string; segmentId: string; seq: number }
	| { type: "endpoint"; segmentId: string; seq: number }
	| { type: "error"; code: string; message: string; retryable: boolean; seq: number };

/** 稳定错误码（与契约 §4 一致）。 */
export const ASR_STREAM_ERRORS = {
	notReady: "asr_not_ready",
	busy: "asr_stream_busy",
	seqGap: "asr_stream_seq_gap",
	seqReplay: "asr_stream_seq_replay",
	backpressure: "asr_stream_backpressure",
	expired: "asr_stream_expired",
	unknown: "asr_stream_unknown",
	sourceChanged: "asr_source_changed",
	forbidden: "asr_stream_forbidden",
	scopeMismatch: "asr_stream_scope_mismatch",
	badFormat: "asr_bad_format",
	frameTooLarge: "asr_frame_too_large",
	engineError: "asr_engine_error",
} as const;

export class AsrStreamError extends Error {
	constructor(
		public code: string,
		public status: number,
		message: string,
		public retryAfterMs?: number,
	) {
		super(message);
	}
}

/** 解析出的流式目标（含租约与 loopback 端点）。 */
export interface AsrStreamTarget {
	modelId: string;
	provider: string;
	capability: AsrAdapterCapability;
	baseUrl: string;
	token: string;
	sampleRate: number;
	/** 会话录制租约（阻止 idle 卸载）；`end` / `cancel` 必须 release。 */
	lease: { release(): void };
}

export interface AsrStreamDeps {
	/** 解析目标（异步：必要时按需启动 worker）；未就绪 / 未知 / 平台不支持返回结构化错误（不抛）。 */
	resolveTarget(modelId?: string): Promise<{ ok: true; target: AsrStreamTarget } | { ok: false; error: AsrStreamError }>;
	/** 当前来源持久化版本（会话创建时捕获，append 时校验）。 */
	selectionVersion(): number;
	now(): number;
	fetchImpl?: typeof fetch;
	setTimer(fn: () => void, ms: number): { cancel(): void };
	onChange?(): void;
}

export interface AsrStreamCreateInput {
	modelId?: string;
	clientId?: string;
	/** 授权主体（本地 = "local"，远程 = 设备 id） */
	principal: string;
	agentId?: string;
	conversationId?: string;
}

/** 后续操作的调用者上下文（主体 + 可选的归属校验）。 */
export interface AsrStreamCaller {
	principal: string;
	agentId?: string;
	conversationId?: string;
}

/** 会话视图（`GET /stream/:id`；不含 token）。 */
export interface AsrStreamView {
	sessionId: string;
	modelId: string;
	provider: string;
	sourceVersion: number;
	state: "ready" | "listening" | "ended" | "cancelled";
	nextSeq: number;
	buffered: number;
	ageMs: number;
	leaseId: string;
}

interface Session {
	id: string;
	leaseId: string;
	/** sidecar 内部的会话 id（本地对外 id 是 sessionId） */
	sidecarSession: string;
	modelId: string;
	provider: string;
	sourceVersion: number;
	/** 授权主体（本地 = "local"，远程 = 设备 id）：别的会话拿 sessionId 不能 append / end / cancel */
	principal: string;
	/** 归属上下文（只记录 / 校验，不参与鉴权主体） */
	agentId: string | null;
	conversationId: string | null;
	capability: AsrAdapterCapability;
	baseUrl: string;
	token: string;
	sampleRate: number;
	lease: { release(): void };
	seq: number;
	lastSeq: number;
	busy: boolean;
	ended: boolean;
	createdAt: number;
	lastActivityAt: number;
	timer: { cancel(): void } | null;
}

let seqCounter = 0;

/** 注入式时钟 / fetch 的流式会话中枢（纯状态机 + 可测）。 */
export class LocalAsrStreamHub {
	private deps: AsrStreamDeps;
	private sessions = new Map<string, Session>();

	constructor(deps: AsrStreamDeps) {
		this.deps = deps;
	}

	/** 当前活跃会话数（测试 / 状态用）。 */
	activeCount(): number {
		return this.sessions.size;
	}

	/** 创建会话：解析目标（含租约）→ 起 sidecar 流 → 记录 sourceVersion / seq=0。 */
	async create(input: AsrStreamCreateInput): Promise<{
		sessionId: string;
		modelId: string;
		provider: string;
		sourceVersion: number;
		leaseId: string;
		protocol: "asr-stream-v1";
		sampleRate: number;
		channels: 1;
		format: "s16le";
		maxChunkBytes: number;
		partialIntervalHintMs: [number, number];
		maxSessionMs: number;
		idleTimeoutMs: number;
		nextSeq: number;
		state: "ready";
	}> {
		const resolved = await this.deps.resolveTarget(input.modelId);
		if (!resolved.ok) throw resolved.error;
		const target = resolved.target;
		// 单流 busy：同一模型已有活跃会话 → 拒绝。
		for (const s of this.sessions.values()) {
			if (s.modelId === target.modelId && !s.ended) {
				target.lease.release();
				throw new AsrStreamError(ASR_STREAM_ERRORS.busy, 409, "该模型已有进行中的流式会话，请先结束或取消");
			}
		}
		const cap = target.capability;
		let sidecarSession: string;
		try {
			const started = await this.callSidecar(target, "/v1/stream/start", { method: "POST" });
			if (typeof started.sessionId !== "string" || !started.sessionId) throw new AsrStreamError(ASR_STREAM_ERRORS.engineError, 503, "本地流式识别引擎未返回会话 id");
			sidecarSession = started.sessionId;
		} catch (e) {
			target.lease.release();
			throw e;
		}
		const id = `asr-stream-${++seqCounter}`;
		const session: Session = {
			id,
			leaseId: `asr-lease-${id}`,
			modelId: target.modelId,
			provider: target.provider,
			sourceVersion: this.deps.selectionVersion(),
			sidecarSession,
			principal: input.principal,
			agentId: input.agentId ?? null,
			conversationId: input.conversationId ?? null,
			capability: cap,
			baseUrl: target.baseUrl,
			token: target.token,
			sampleRate: target.sampleRate,
			lease: target.lease,
			seq: 0,
			lastSeq: -1,
			busy: false,
			ended: false,
			createdAt: this.deps.now(),
			lastActivityAt: this.deps.now(),
			timer: null,
		};
		this.sessions.set(id, session);
		this.scheduleIdle(session);
		this.deps.onChange?.();
		return {
			sessionId: id,
			modelId: target.modelId,
			provider: target.provider,
			sourceVersion: session.sourceVersion,
			leaseId: session.leaseId,
			protocol: "asr-stream-v1",
			sampleRate: target.sampleRate,
			channels: 1,
			format: "s16le",
			maxChunkBytes: cap.maxChunkBytes,
			partialIntervalHintMs: cap.partialIntervalHintMs,
			maxSessionMs: cap.maxSessionMs,
			idleTimeoutMs: cap.idleTimeoutMs,
			nextSeq: 0,
			state: "ready",
		};
	}

	/** 追加一帧 PCM（裸字节）；返回本批事件。串行：上一帧未返回 → busy。 */
	async append(sessionId: string, seq: number, bytes: Uint8Array, caller: AsrStreamCaller): Promise<{ seq: number; accepted: number; nextSeq: number; state: "listening" | "endpoint" | "ended"; events: AsrStreamEvent[]; buffered: number }> {
		const s = this.require(sessionId);
		this.assertOwner(s, caller);
		this.assertNotStale(s);
		if (s.ended) throw new AsrStreamError(ASR_STREAM_ERRORS.expired, 409, "会话已结束，请重新开始录音");
		if (this.deps.now() - s.createdAt > s.capability.maxSessionMs) {
			await this.cancel(sessionId);
			throw new AsrStreamError(ASR_STREAM_ERRORS.expired, 409, "单次流式会话已超时（60 秒），请重新开始录音");
		}
		if (s.busy) throw new AsrStreamError(ASR_STREAM_ERRORS.busy, 409, "上一帧仍在处理，请串行发送（不要并发 append）");
		if (!Number.isInteger(seq) || seq < 0) throw new AsrStreamError(ASR_STREAM_ERRORS.badFormat, 400, "seq 必须是非负整数");
		if (seq < s.seq) throw new AsrStreamError(ASR_STREAM_ERRORS.seqReplay, 409, `重复帧（seq ${seq} < nextSeq ${s.seq}），已忽略`);
		if (seq > s.seq) throw new AsrStreamError(ASR_STREAM_ERRORS.seqGap, 409, `帧乱序（seq ${seq} > nextSeq ${s.seq}），请按 nextSeq 重发`);
		if (bytes.byteLength === 0) throw new AsrStreamError(ASR_STREAM_ERRORS.badFormat, 400, "空帧");
		if (bytes.byteLength > s.capability.maxChunkBytes) throw new AsrStreamError(ASR_STREAM_ERRORS.frameTooLarge, 413, `单帧超过 ${s.capability.maxChunkBytes} 字节上限`);

		s.busy = true;
		try {
			const raw = await this.fetchSidecar(s, "/v1/stream/append", { method: "POST", body: bytes as unknown as BodyInit, query: { session: s.sidecarSession } });
			const events = this.normalizeEvents(raw, seq);
			s.seq = seq + 1;
			s.lastSeq = seq;
			s.lastActivityAt = this.deps.now();
			this.scheduleIdle(s);
			const endpoint = events.some((e) => e.type === "endpoint");
			return { seq, accepted: bytes.byteLength, nextSeq: s.seq, state: endpoint ? "endpoint" : "listening", events, buffered: 0 };
		} finally {
			s.busy = false;
		}
	}

	/** 正常结束：喂尾部 silence + finish input → final；释放租约。幂等。 */
	async end(sessionId: string, caller: AsrStreamCaller, _reason?: "stop" | "finish"): Promise<{ sessionId: string; state: "ended"; modelId: string; sourceVersion: number; finals: AsrStreamEvent[] }> {
		const s = this.require(sessionId);
		this.assertOwner(s, caller);
		if (s.ended) return { sessionId, state: "ended", modelId: s.modelId, sourceVersion: s.sourceVersion, finals: [] };
		let events: AsrStreamEvent[] = [];
		try {
			const raw = await this.fetchSidecar(s, "/v1/stream/end", { method: "POST", body: JSON.stringify({ sessionId: s.sidecarSession }) as unknown as BodyInit });
			events = this.normalizeEvents(raw, s.seq, Array.isArray(raw?.events) ? raw.events : undefined);
		} catch {
			/* sidecar 结束失败：仍然释放租约，不泄漏 */
		}
		s.ended = true;
		this.release(s);
		const finals = events.filter((e) => e.type === "final");
		return { sessionId, state: "ended", modelId: s.modelId, sourceVersion: s.sourceVersion, finals };
	}

	/** 取消：立即释放，不产 final。幂等。 */
	async cancel(sessionId: string, caller: AsrStreamCaller): Promise<{ sessionId: string; state: "cancelled" }> {
		const s = this.sessions.get(sessionId);
		if (!s) return { sessionId, state: "cancelled" };
		this.assertOwner(s, caller);
		try {
			await this.fetchSidecar(s, "/v1/stream/cancel", { method: "POST", body: JSON.stringify({ sessionId: s.sidecarSession }) as unknown as BodyInit });
		} catch {
			/* 取消失败不影响释放 */
		}
		s.ended = true;
		this.release(s);
		return { sessionId, state: "cancelled" };
	}

	get(sessionId: string, caller: AsrStreamCaller): AsrStreamView {
		const s = this.require(sessionId);
		this.assertOwner(s, caller);
		return {
			sessionId: s.id,
			modelId: s.modelId,
			provider: s.provider,
			sourceVersion: s.sourceVersion,
			state: s.ended ? "ended" : s.lastSeq >= 0 ? "listening" : "ready",
			nextSeq: s.seq,
			buffered: 0,
			ageMs: this.deps.now() - s.createdAt,
			leaseId: s.leaseId,
		};
	}

	/** 关闭全部会话（服务停止 / 测试清理）。 */
	async cancelAll(): Promise<void> {
		for (const id of [...this.sessions.keys()]) await this.cancel(id, { principal: this.sessions.get(id)?.principal ?? "local" });
	}

	// ---------------------------------------------------------------- internals

	private require(sessionId: string): Session {
		const s = this.sessions.get(sessionId);
		if (!s) throw new AsrStreamError(ASR_STREAM_ERRORS.unknown, 404, "未知或已回收的流式会话");
		return s;
	}

	/** 会话期间来源被改选 → 取消并明确报错，绝不 fallback 到别的模型。 */
	private assertNotStale(s: Session): void {
		if (this.deps.selectionVersion() !== s.sourceVersion) {
			void this.cancel(s.id, { principal: s.principal });
			throw new AsrStreamError(ASR_STREAM_ERRORS.sourceChanged, 409, "语音识别来源已被改选，请重新开始录音");
		}
	}

	/** 授权主体校验：别的会话拿 sessionId 不能 append / end / cancel（不只靠随机 id 防猜）。 */
	private assertOwner(s: Session, caller: AsrStreamCaller): void {
		if (s.principal !== caller.principal) {
			throw new AsrStreamError(ASR_STREAM_ERRORS.forbidden, 403, "该流式会话属于其它客户端，拒绝操作");
		}
		if (caller.agentId !== undefined && s.agentId !== null && caller.agentId !== s.agentId) {
			throw new AsrStreamError(ASR_STREAM_ERRORS.scopeMismatch, 409, "会话的 agent 归属不一致");
		}
		if (caller.conversationId !== undefined && s.conversationId !== null && caller.conversationId !== s.conversationId) {
			throw new AsrStreamError(ASR_STREAM_ERRORS.scopeMismatch, 409, "会话的会话归属不一致");
		}
	}

	private release(s: Session): void {
		if (s.timer) {
			try {
				s.timer.cancel();
			} catch {
				/* 已取消 */
			}
			s.timer = null;
		}
		try {
			s.lease.release();
		} catch {
			/* 已释放 */
		}
		this.sessions.delete(s.id);
		this.deps.onChange?.();
	}

	private scheduleIdle(s: Session): void {
		if (s.timer) s.timer.cancel();
		s.timer = this.deps.setTimer(() => {
			if (this.sessions.get(s.id) !== s) return;
			void this.cancel(s.id).catch(() => {});
		}, Math.min(s.capability.idleTimeoutMs, ASR_STREAM_IDLE_TIMEOUT_MS));
	}

	private async callSidecar(target: AsrStreamTarget, path: string, _opts: { method: string }): Promise<{ sessionId?: unknown }> {
		const res = await this.doFetch(`${target.baseUrl.replace(/\/+$/, "")}${path}`, { method: "POST", headers: this.authHeaders(target.token, "application/json"), body: "{}" });
		return (res ?? {}) as { sessionId?: unknown };
	}

	private async fetchSidecar(s: Session, path: string, opts: { method: string; body?: BodyInit; query?: Record<string, string> }): Promise<Record<string, unknown>> {
		const q = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
		const res = await this.doFetch(`${s.baseUrl.replace(/\/+$/, "")}${path}${q}`, {
			method: opts.method,
			headers: this.authHeaders(s.token, opts.body instanceof Uint8Array ? "application/octet-stream" : "application/json"),
			body: opts.body,
		});
		return res as Record<string, unknown>;
	}

	private authHeaders(token: string, contentType: string): Record<string, string> {
		return { authorization: `Bearer ${token}`, "content-type": contentType };
	}

	private async doFetch(url: string, init: RequestInit): Promise<unknown> {
		const fetchImpl = this.deps.fetchImpl ?? fetch;
		let res: Response;
		try {
			res = await fetchImpl(url, init);
		} catch (e) {
			throw new AsrStreamError(ASR_STREAM_ERRORS.engineError, 503, `本地流式识别引擎调用失败：${e instanceof Error ? e.message : String(e)}`);
		}
		if (!res.ok) throw new AsrStreamError(ASR_STREAM_ERRORS.engineError, 503, `本地流式识别引擎返回 ${res.status}`);
		try {
			return (await res.json()) as unknown;
		} catch {
			throw new AsrStreamError(ASR_STREAM_ERRORS.engineError, 503, "本地流式识别引擎返回了非 JSON");
		}
	}

	/** 把 sidecar 事件规范成带 seq 的契约事件（未知字段忽略、类型不合法丢弃）。 */
	private normalizeEvents(raw: unknown, seq: number, explicit?: unknown[]): AsrStreamEvent[] {
		const list = Array.isArray(explicit) ? explicit : Array.isArray((raw as { events?: unknown[] })?.events) ? (raw as { events: unknown[] }).events : [];
		const out: AsrStreamEvent[] = [];
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const e = item as { type?: unknown; text?: unknown; segmentId?: unknown };
			const segmentId = String(e.segmentId ?? "0");
			if (e.type === "committed" || e.type === "tentative" || e.type === "final") {
				out.push({ type: e.type, text: String(e.text ?? ""), segmentId, seq });
			} else if (e.type === "endpoint") {
				out.push({ type: "endpoint", segmentId, seq });
			}
		}
		return out;
	}
}

export const ASR_STREAM_LIMITS = { maxChunkBytes: ASR_STREAM_MAX_CHUNK_BYTES, maxSessionMs: ASR_STREAM_MAX_SESSION_MS, idleTimeoutMs: ASR_STREAM_IDLE_TIMEOUT_MS };
