/**
 * 语音输入（ASR）路由：`POST /api/audio/transcriptions`。
 *
 * 走**正常 safe API 路径**（`/api/*` 全局中间件：本机或已配对设备），**不**把普通麦克风录音做成每秒审批。
 * 契约见 docs/design/voice-input.md §4.2：multipart 上传（音频只在内存）、上限校验、abort + 超时、
 * 幂等只在 completed 返回、错误脱敏。**不**接受远程 URL / 本地路径 / 任意 ffmpeg 输入。
 */
import type { Context, Hono, Next } from "hono";
import { ASR_ERRORS, ASR_MAX_BYTES, ASR_MAX_DURATION_MS, type AsrEndpoint, type AsrRequest } from "./contract.ts";
import { createAsrService, validateAsrAudio, type AsrOutcome, type AsrService } from "./asr.ts";

// biome-ignore lint/suspicious/noExplicitAny: 与 http.ts 一致的挂载风格
type AnyHono = Hono<any>;

export interface VoiceRouteDeps {
	/** 解析 provider/model → 端点；由注册表 + 公开凭据接口提供（不在此模块解析 key）。 */
	resolve: (provider: string, model: string) => Promise<AsrOutcome<AsrEndpoint>>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	now?: () => number;
}

/** multipart 解析前的粗上限：正文（含表单头）不得超过音频上限 + 64 KB。 */
const BODY_OVERHEAD = 64 * 1024;

export function mountVoiceRoutes(app: AnyHono, deps: VoiceRouteDeps, service?: AsrService) {
	const svc = service ?? createAsrService({ resolve: deps.resolve, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, now: deps.now });

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
		if (!provider || !model) return c.json({ error: ASR_ERRORS.notConfigured, message: "请先在设置里选择语音识别模型" }, 400);

		const req: AsrRequest = {
			provider,
			model,
			audio,
			filename: "audio.wav",
			requestId: String(form.get("requestId") ?? "").trim() || `${provider}:${model}:${Date.now()}`,
			language: String(form.get("language") ?? "").trim() || undefined,
			agentId: String(form.get("agentId") ?? "").trim() || undefined,
			conversationId: String(form.get("conversationId") ?? "").trim() || undefined,
		};
		const out = await svc.transcribe(req, c.req.raw.signal);
		if (!out.ok) return c.json({ error: out.code, message: out.message }, out.status as 400);
		return c.json(out.value);
	});

	// 契约常量给前端用（上限、协议），避免前端硬编码漂移。
	app.get("/api/audio/asr/config", (c) => c.json({ maxDurationMs: ASR_MAX_DURATION_MS, maxBytes: ASR_MAX_BYTES, protocol: "openai-audio-transcriptions" }));
}

/** 供 http.ts 以中间件风格挂载时复用（当前直接挂路由，不需要额外中间件）。 */
export type { Next, Context };
