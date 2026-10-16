/**
 * 语音输入（ASR）路由：`POST /api/audio/transcriptions`。
 *
 * 走**正常 safe API 路径**（`/api/*` 全局中间件：本机或已配对设备），**不**把普通麦克风录音做成每秒审批。
 * 契约见 docs/design/voice-input.md §4.2：multipart 上传（音频只在内存）、上限校验、abort + 超时、
 * 幂等只在 completed 返回、错误脱敏。**不**接受远程 URL / 本地路径 / 任意 ffmpeg 输入。
 */
import type { Context, Hono, Next } from "hono";
import { ASR_ERRORS, ASR_MAX_BYTES, ASR_MAX_DURATION_MS, type AsrEndpoint, type AsrRequest, type AsrSource, type AsrSourceOption } from "./contract.ts";
import { createAsrService, validateAsrAudio, type AsrOutcome, type AsrService } from "./asr.ts";
import { parseAsrSourceBody } from "./source.ts";

// biome-ignore lint/suspicious/noExplicitAny: 与 http.ts 一致的挂载风格
type AnyHono = Hono<any>;

/** 显式语音来源的读写访问（生产由 voice/index.ts 注入；不注入则不挂来源路由、也不做来源校验）。 */
export interface VoiceSourceAccess {
	/** 当前显式来源；`null` = 未配置。只读，不启动 / 不下载 / 不连云。 */
	read: () => AsrSource | null;
	/** 归一化候选（含 availability / reason），只读元数据。 */
	options: () => AsrSourceOption[];
	/** 校验并写入；未知 / 未配置的 provider-model 抛带 code / status 的错误（不落库）。 */
	write: (next: AsrSource | null) => void;
}

export interface VoiceRouteDeps {
	/** 解析 provider/model → 端点；由注册表 + 公开凭据接口提供（不在此模块解析 key）。 */
	resolve: (provider: string, model: string) => Promise<AsrOutcome<AsrEndpoint>>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	now?: () => number;
	/** 录音租约：录音期间持有，避免本地 ASR 被 idle 卸载（不传则不挂租约路由）。 */
	acquireLease?: (provider: string, model: string) => Promise<{ ok: true; leaseId: string } | { ok: false; code: string; status: number; message: string }>;
	releaseLease?: (leaseId: string) => void;
	/** 显式来源（用户已确认的产品行为）；传了就必须按它授权转写 / 租约，缺失或过期一律 fail-closed。 */
	source?: VoiceSourceAccess;
}

/** 来源访问的稳定错误形状（voice/index.ts 的 AsrSourceError 兼容）。 */
const asError = (e: unknown): { code: string; status: number; message: string } => {
	const x = e as { code?: unknown; status?: unknown; message?: unknown };
	return {
		code: typeof x?.code === "string" ? x.code : ASR_ERRORS.invalidSource,
		status: typeof x?.status === "number" ? x.status : 400,
		message: typeof x?.message === "string" ? x.message : String(e),
	};
};

/** multipart 解析前的粗上限：正文（含表单头）不得超过音频上限 + 64 KB。 */
const BODY_OVERHEAD = 64 * 1024;

export function mountVoiceRoutes(app: AnyHono, deps: VoiceRouteDeps, service?: AsrService) {
	const svc = service ?? createAsrService({ resolve: deps.resolve, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, now: deps.now });

	/**
	 * 按**显式来源**授权一次转写 / 租约请求（用户要求：不能 source=local 时让过期客户端把云端当默认上传）。
	 * 返回 `null` 表示通过并给出要用的 provider/model；否则返回已经填好的错误响应。
	 */
	const authorize = (requested: { provider: string; model: string }): { error: Response } | { provider: string; model: string } => {
		if (!deps.source) {
			if (!requested.provider || !requested.model) return { error: Response.json({ error: ASR_ERRORS.notConfigured, message: "请先在设置里选择语音识别模型" }, { status: 400 }) };
			return requested;
		}
		const src = deps.source.read();
		if (!src) return { error: Response.json({ error: ASR_ERRORS.notConfigured, message: "请先在设置 › 语音配置里选择语音识别来源" }, { status: 409 }) };
		if (!requested.provider && !requested.model) return { provider: src.provider, model: src.model };
		if (requested.provider !== src.provider || requested.model !== src.model) {
			const where = src.location === "local" ? "本地" : "云端";
			return { error: Response.json({ error: ASR_ERRORS.sourceChanged, message: `语音识别来源已改为${where}（${src.provider}/${src.model}），请刷新后重试` }, { status: 409 }) };
		}
		return requested;
	};

	app.post("/api/audio/transcriptions", async (c) => {
		const ct = c.req.header("content-type") ?? "";
		if (!ct.toLowerCase().includes("multipart/form-data")) return c.json({ error: ASR_ERRORS.invalidAudio, message: "请用 multipart/form-data 上传音频" }, 400);
		const declared = Number(c.req.header("content-length") ?? "0");
		if (Number.isFinite(declared) && declared > ASR_MAX_BYTES + BODY_OVERHEAD) return c.json({ error: ASR_ERRORS.tooLarge, message: `音频超过 ${Math.round(ASR_MAX_BYTES / 1024 / 1024)} MB 上限` }, 413);

		let form: FormData;
		try {
			form = await c.req.formData();
		} catch {
			return c.json({ error: ASR_ERRORS.invalidAudio, message: "无法解析上传的表单" }, 400);
		}
		const file = form.get("file");
		if (!(file instanceof Blob)) return c.json({ error: ASR_ERRORS.invalidAudio, message: "缺少音频文件" }, 400);
		const audio = new Uint8Array(await file.arrayBuffer());
		const bytes = validateAsrAudio(audio);
		if (!bytes.ok) return c.json({ error: bytes.code, message: bytes.message }, bytes.status as 400);

		const provider = String(form.get("provider") ?? "").trim();
		const model = String(form.get("model") ?? "").trim();
		const auth = authorize({ provider, model });
		if ("error" in auth) return auth.error;

		const req: AsrRequest = {
			provider: auth.provider,
			model: auth.model,
			audio,
			filename: "audio.wav",
			requestId: String(form.get("requestId") ?? "").trim() || `${auth.provider}:${auth.model}:${Date.now()}`,
			language: String(form.get("language") ?? "").trim() || undefined,
			agentId: String(form.get("agentId") ?? "").trim() || undefined,
			conversationId: String(form.get("conversationId") ?? "").trim() || undefined,
		};
		const out = await svc.transcribe(req, c.req.raw.signal);
		if (!out.ok) return c.json({ error: out.code, message: out.message }, out.status as 400);
		return c.json(out.value);
	});

	// 录音租约：用户按麦→上传结束期间持有，本地 ASR 的 idle 卸载会让路（不 kill 正在录音的模型）。
	// 前端在开始录音时 acquire，停止/取消/失败后 release；未配置本地 ASR 时返回明确错误，不静默。
	app.post("/api/audio/asr/lease", async (c) => {
		if (!deps.acquireLease) return c.json({ error: ASR_ERRORS.notConfigured, message: "当前没有可用的本地语音识别" }, 400);
		const body = await c.req.json<{ provider?: string; model?: string }>().catch(() => ({}) as { provider?: string; model?: string });
		const auth = authorize({ provider: String(body.provider ?? "").trim(), model: String(body.model ?? "").trim() });
		if ("error" in auth) return auth.error;
		const out = await deps.acquireLease(auth.provider, auth.model);
		if (!out.ok) return c.json({ error: out.code, message: out.message }, out.status as 400);
		return c.json({ leaseId: out.leaseId });
	});
	app.delete("/api/audio/asr/lease/:id", (c) => {
		deps.releaseLease?.(c.req.param("id"));
		return c.json({ ok: true });
	});

	// 显式来源（用户要求：云 / 本地显式切换，不自动挑源；未配置就是 null）。只挂在注入 source 的生产装配上。
	if (deps.source) {
		const view = (c: Context) => c.json({ source: deps.source!.read(), options: deps.source!.options() });
		app.get("/api/audio/asr/source", (c) => view(c));
		app.put("/api/audio/asr/source", async (c) => {
			const body = await c.req.json<unknown>().catch(() => undefined);
			const parsed = parseAsrSourceBody(body);
			if (!parsed.ok) return c.json({ error: ASR_ERRORS.invalidSource, message: parsed.reason }, 400);
			try {
				deps.source!.write(parsed.source);
			} catch (e) {
				const err = asError(e);
				return c.json({ error: err.code, message: err.message }, err.status as 400);
			}
			return view(c);
		});
	}

	// 契约常量给前端用（上限、协议），避免前端硬编码漂移。
	app.get("/api/audio/asr/config", (c) => c.json({ maxDurationMs: ASR_MAX_DURATION_MS, maxBytes: ASR_MAX_BYTES, protocol: "openai-audio-transcriptions" }));
}

/** 供 http.ts 以中间件风格挂载时复用（当前直接挂路由，不需要额外中间件）。 */
export type { Next, Context };
