/**
 * 图片生成服务适配器（纯 HTTP，无第三方依赖；fetch 可注入以便单测）。
 *  openai    OpenAI 兼容 /images/generations + /images/edits（OpenAI gpt-image / DALL·E、大多数中转站、硅基流动等）
 *  dashscope 阿里云百炼：通义万相 / Qwen-Image（文生图是异步任务 + 轮询；改图走 multimodal-generation）
 *  ark       火山方舟：豆包 Seedream / SeedEdit（/api/v3/images/generations，参考图用 image 字段）
 *  gemini    Google Gemini 图片模型（generateContent + responseModalities）与 Imagen（:predict）
 *  xai       xAI Grok 图片（OpenAI 风格，只支持文生图）
 */

export type ImageKind = "openai" | "dashscope" | "ark" | "gemini" | "xai";
export type Fetch = typeof fetch;

export interface ImageEndpoint {
	kind: ImageKind;
	baseUrl: string;
	apiKey?: string;
}
export interface InputImage {
	name: string;
	mime: string;
	data: Buffer;
}
export interface GenRequest {
	model: string;
	prompt: string;
	n?: number;
	/** 1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 */
	aspect?: string;
	/** 明确的尺寸（如 1024x1024），优先于 aspect */
	size?: string;
	quality?: "low" | "medium" | "high" | "auto";
	images?: InputImage[];
	signal?: AbortSignal;
}
export interface GenImage {
	data: Buffer;
	mime: string;
}
export interface GenResult {
	images: GenImage[];
	revisedPrompt?: string;
	/** 模型附带的文字（Gemini 会边说边画） */
	text?: string;
}

export type ErrCode = "auth" | "policy" | "quota" | "timeout" | "model" | "bad_request" | "network" | "unsupported" | "server" | "empty";
const SUMMARY: Record<ErrCode, string> = {
	auth: "API Key 无效或没有权限",
	policy: "内容被服务商的安全策略拦截了，换个描述试试",
	quota: "请求太频繁或额度不足",
	timeout: "生成超时了",
	model: "服务商找不到这个模型",
	bad_request: "服务商拒绝了请求参数",
	network: "连不上图片服务",
	unsupported: "这个模型不支持这种用法",
	server: "图片服务出错了",
	empty: "服务商没有返回图片",
};
export class ImageGenError extends Error {
	constructor(
		readonly code: ErrCode,
		readonly detail: string,
		summary?: string,
	) {
		super(summary ?? SUMMARY[code]);
	}
}

// ---------------------------------------------------------------- 服务目录（预设，不含任何 Key）
export interface KindInfo {
	kind: ImageKind;
	label: string;
	baseUrl: string;
	models: string[];
	keyUrl?: string;
	note?: string;
}
export const KINDS: KindInfo[] = [
	{ kind: "openai", label: "OpenAI 兼容（/v1/images）", baseUrl: "https://api.openai.com/v1", models: ["gpt-image-1", "gpt-image-1-mini", "dall-e-3"], keyUrl: "https://platform.openai.com/api-keys", note: "OpenAI 官方、各种中转站、硅基流动等提供 /v1/images/generations 的服务" },
	{ kind: "dashscope", label: "阿里云百炼（通义万相 / Qwen-Image）", baseUrl: "https://dashscope.aliyuncs.com", models: ["qwen-image", "qwen-image-plus", "qwen-image-edit", "wan2.2-t2i-flash", "wanx2.1-t2i-turbo"], keyUrl: "https://bailian.console.aliyun.com/?apiKey=1", note: "国际站用 https://dashscope-intl.aliyuncs.com" },
	{ kind: "ark", label: "火山方舟（豆包 Seedream）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: ["doubao-seedream-4-0-250828", "doubao-seedream-3-0-t2i-250415", "doubao-seededit-3-0-i2i-250628"], keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", note: "模型名也可以填方舟里的推理接入点 ID（ep-…）" },
	{ kind: "gemini", label: "Google Gemini（Nano Banana / Imagen）", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: ["gemini-2.5-flash-image", "imagen-4.0-generate-001", "imagen-4.0-fast-generate-001"], keyUrl: "https://aistudio.google.com/apikey" },
	{ kind: "xai", label: "xAI（Grok 图片）", baseUrl: "https://api.x.ai/v1", models: ["grok-2-image-1212"], keyUrl: "https://console.x.ai", note: "只支持文生图，不支持指定尺寸" },
];
export const kindInfo = (k: ImageKind) => KINDS.find((x) => x.kind === k)!;

/** 模型列表里哪些像图片生成模型 */
export const IMAGE_MODEL_RE = /(gpt-image|dall-?e|imagen|image-?gen|-image\b|image-preview|\bimage\b|seedream|seededit|wanx|wan2\.\d-(t2i|i2i)|qwen-image|flux|stable-diffusion|\bsdxl?\b|sd3|kolors|cogview|hunyuan-?image|recraft|ideogram|midjourney|playground-v|janus|hidream|nano-banana)/i;
export const isImageModel = (id: string) => IMAGE_MODEL_RE.test(id) && !/embedding|vision-preview|image-?to-?text|caption|ocr/i.test(id);

/** 这个模型能不能改图 / 参考图 */
export function supportsEdit(kind: ImageKind, model: string) {
	const m = model.toLowerCase();
	if (kind === "xai") return false;
	if (kind === "gemini") return !m.startsWith("imagen");
	if (kind === "dashscope") return /edit|i2i|wan2\.5|qwen-image-plus|qwen-image-2/.test(m);
	if (kind === "ark") return /seedream-4|seededit|ep-/.test(m);
	return !/dall-e-3/.test(m); // OpenAI 兼容：gpt-image / dall-e-2 / 中转站的其它模型都试试
}

/** 参考价（每张，以服务商为准）；未知返回 undefined */
export function costNote(model: string): string | undefined {
	const m = model.toLowerCase();
	const t: [RegExp, string][] = [
		[/gpt-image-1-mini/, "约 $0.005–0.05/张"],
		[/gpt-image/, "约 $0.01–0.17/张（看质量和尺寸）"],
		[/dall-e-3/, "约 $0.04–0.12/张"],
		[/dall-e-2/, "约 $0.02/张"],
		[/seedream-4/, "约 ¥0.2/张"],
		[/seedream-3|seededit/, "约 ¥0.26–0.3/张"],
		[/qwen-image/, "约 ¥0.2–0.25/张"],
		[/wan/, "约 ¥0.14–0.2/张"],
		[/gemini.*image/, "约 $0.04/张"],
		[/imagen-4.*fast/, "约 $0.02/张"],
		[/imagen/, "约 $0.04–0.06/张"],
		[/grok.*image/, "约 $0.07/张"],
	];
	return t.find(([r]) => r.test(m))?.[1];
}

// ---------------------------------------------------------------- 尺寸
const ASPECTS: Record<string, [number, number]> = { "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16], "4:3": [4, 3], "3:4": [3, 4], "3:2": [3, 2], "2:3": [2, 3], "21:9": [21, 9] };
export const normAspect = (a?: string) => (a && ASPECTS[a.replace(/[：x×]/g, ":").trim()] ? a.replace(/[：x×]/g, ":").trim() : undefined);
const orient = (a?: string) => {
	const r = ASPECTS[normAspect(a) ?? "1:1"];
	return r[0] === r[1] ? "square" : r[0] > r[1] ? "landscape" : "portrait";
};
export function openaiSize(model: string, aspect?: string, size?: string) {
	if (size) return size.replace(/[*×]/, "x");
	if (!aspect) return undefined;
	const o = orient(aspect);
	if (/dall-e-3/i.test(model)) return { square: "1024x1024", landscape: "1792x1024", portrait: "1024x1792" }[o];
	if (/dall-e-2/i.test(model)) return "1024x1024";
	if (/gpt-image/i.test(model)) return { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" }[o];
	// 其它（中转站上的 flux / sd 等）：按比例算一个 64 对齐、约 1MP 的尺寸
	return wh(aspect, 1024, 64, "x");
}
function wh(aspect: string | undefined, base: number, step: number, sep: string) {
	const [a, b] = ASPECTS[normAspect(aspect) ?? "1:1"];
	const k = Math.sqrt((base * base) / (a * b));
	const r = (v: number) => Math.max(step, Math.round(v / step) * step);
	return `${r(a * k)}${sep}${r(b * k)}`;
}
export function dashscopeSize(model: string, aspect?: string, size?: string) {
	if (size) return size.replace(/[x×]/, "*");
	const a = normAspect(aspect) ?? "1:1";
	if (/qwen-image/i.test(model)) return ({ "1:1": "1328*1328", "16:9": "1664*928", "9:16": "928*1664", "4:3": "1472*1140", "3:4": "1140*1472" } as Record<string, string>)[a] ?? wh(a, 1328, 16, "*");
	return ({ "1:1": "1024*1024", "16:9": "1280*720", "9:16": "720*1280", "4:3": "1024*768", "3:4": "768*1024" } as Record<string, string>)[a] ?? wh(a, 1024, 16, "*");
}
export function arkSize(model: string, aspect?: string, size?: string) {
	if (size) return size.replace(/[*×]/, "x");
	if (/seededit/i.test(model)) return "adaptive";
	const a = normAspect(aspect) ?? "1:1";
	const big = /seedream-4/i.test(model);
	const t: Record<string, string> = big
		? { "1:1": "2048x2048", "16:9": "2560x1440", "9:16": "1440x2560", "4:3": "2304x1728", "3:4": "1728x2304", "3:2": "2496x1664", "2:3": "1664x2496", "21:9": "3024x1296" }
		: { "1:1": "1024x1024", "16:9": "1280x720", "9:16": "720x1280", "4:3": "1152x864", "3:4": "864x1152", "3:2": "1248x832", "2:3": "832x1248", "21:9": "1512x648" };
	return t[a];
}

// ---------------------------------------------------------------- HTTP 小工具
const trimBase = (u: string) => u.trim().replace(/\/+$/, "");
const dataUrl = (i: InputImage) => `data:${i.mime};base64,${i.data.toString("base64")}`;
const POLICY_RE = /content[_ ]?policy|moderation|safety|DataInspectionFailed|SensitiveContent|inappropriate|IMAGE_SAFETY|PROHIBITED|blocked by|违规|敏感|审核/i;

function classify(status: number, body: string): ImageGenError {
	let msg = body;
	let code = "";
	try {
		const j = JSON.parse(body);
		const e = j.error ?? j;
		msg = typeof e === "string" ? e : (e.message ?? j.message ?? body);
		code = String(e.code ?? e.type ?? j.code ?? e.status ?? "");
	} catch {
		/* 非 JSON */
	}
	const detail = `HTTP ${status}${code ? ` ${code}` : ""}：${String(msg).slice(0, 800)}`;
	if (POLICY_RE.test(`${code} ${msg}`)) return new ImageGenError("policy", detail);
	if (status === 401 || status === 403 || /InvalidApiKey|invalid.?api.?key|Unauthorized|AuthenticationError|API_KEY_INVALID|API key not valid/i.test(`${code} ${msg}`)) return new ImageGenError("auth", detail);
	if (status === 429 || /quota|rate.?limit|insufficient|Arrearage|余额|欠费/i.test(`${code} ${msg}`)) return new ImageGenError("quota", detail);
	if (status === 404 || /model.*(not.?found|not exist|does not exist|不存在)|ModelNotFound|InvalidEndpointOrModel/i.test(`${code} ${msg}`)) return new ImageGenError("model", detail);
	if (status === 408 || status === 504) return new ImageGenError("timeout", detail);
	if (status >= 400 && status < 500) return new ImageGenError("bad_request", detail);
	return new ImageGenError("server", detail);
}

export interface Ctx {
	fetch: Fetch;
	/** 单次请求超时（毫秒） */
	timeoutMs: number;
	/** 异步任务轮询：间隔与总时长 */
	pollMs: number;
	pollTimeoutMs: number;
	sleep: (ms: number) => Promise<void>;
}
export const defaultCtx = (): Ctx => ({ fetch, timeoutMs: 180_000, pollMs: 2_000, pollTimeoutMs: 300_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });

async function call(ctx: Ctx, url: string, init: RequestInit & { signal?: AbortSignal }, timeoutMs = ctx.timeoutMs): Promise<Response> {
	const t = AbortSignal.timeout(timeoutMs);
	const signal = init.signal ? AbortSignal.any([init.signal, t]) : t;
	let res: Response;
	try {
		res = await ctx.fetch(url, { ...init, signal });
	} catch (e) {
		if (init.signal?.aborted) throw new ImageGenError("timeout", "已取消", "已取消");
		if (t.aborted) throw new ImageGenError("timeout", `${Math.round(timeoutMs / 1000)} 秒没有响应：${url}`);
		throw new ImageGenError("network", `${(e as Error).message}${(e as { cause?: Error }).cause ? `（${(e as { cause?: Error }).cause?.message}）` : ""}：${url}`);
	}
	if (!res.ok) throw classify(res.status, await res.text().catch(() => ""));
	return res;
}
async function json(ctx: Ctx, url: string, init: RequestInit & { signal?: AbortSignal }, timeoutMs?: number) {
	const res = await call(ctx, url, init, timeoutMs);
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		throw new ImageGenError("server", `返回的不是 JSON：${text.slice(0, 300)}`);
	}
}
async function download(ctx: Ctx, url: string, signal?: AbortSignal): Promise<GenImage> {
	if (url.startsWith("data:")) {
		const m = url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
		if (!m) throw new ImageGenError("server", "无法解析返回的 data URL");
		return { mime: m[1], data: m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3])) };
	}
	const res = await call(ctx, url, { signal });
	const data = Buffer.from(await res.arrayBuffer());
	return { data, mime: sniff(data) ?? res.headers.get("content-type")?.split(";")[0] ?? "image/png" };
}
/** 按文件头识别图片格式 */
export function sniff(b: Buffer): string | undefined {
	if (b.length < 12) return undefined;
	if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
	if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "image/webp";
	if (b.subarray(0, 3).toString() === "GIF") return "image/gif";
	return undefined;
}
const b64img = (s: string): GenImage => {
	const data = Buffer.from(s, "base64");
	return { data, mime: sniff(data) ?? "image/png" };
};
const bearer = (ep: ImageEndpoint): Record<string, string> => (ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {});

// ---------------------------------------------------------------- OpenAI 兼容（含 xAI、方舟）
async function openaiData(ctx: Ctx, data: { b64_json?: string; url?: string; revised_prompt?: string }[] | undefined, signal?: AbortSignal) {
	const out: GenImage[] = [];
	for (const d of data ?? []) {
		if (d.b64_json) out.push(b64img(d.b64_json));
		else if (d.url) out.push(await download(ctx, d.url, signal));
	}
	return out;
}

async function openaiGenerate(ctx: Ctx, ep: ImageEndpoint, r: GenRequest): Promise<GenResult> {
	const base = trimBase(ep.baseUrl);
	const n = Math.max(1, r.n ?? 1);
	const dalle3 = /dall-e-3/i.test(r.model);
	const xai = ep.kind === "xai";
	if (r.images?.length) {
		if (xai) throw new ImageGenError("unsupported", `${r.model} 只支持文生图`, "这个服务不支持改图 / 参考图");
		return openaiEdit(ctx, ep, r);
	}
	const body = (full: boolean): Record<string, unknown> => {
		const b: Record<string, unknown> = { model: r.model, prompt: r.prompt, n: dalle3 ? 1 : n };
		if (/dall-e|grok/i.test(r.model) || xai) b.response_format = "b64_json";
		if (full && !xai) {
			const s = openaiSize(r.model, r.aspect, r.size);
			if (s) b.size = s;
			if (r.quality && r.quality !== "auto") b.quality = /dall-e-3/i.test(r.model) ? (r.quality === "high" ? "hd" : "standard") : r.quality;
		}
		return b;
	};
	const once = async (): Promise<{ data?: { b64_json?: string; url?: string; revised_prompt?: string }[] }> => {
		const go = (full: boolean) => json(ctx, `${base}/images/generations`, { method: "POST", headers: { "content-type": "application/json", ...bearer(ep) }, body: JSON.stringify(body(full)), signal: r.signal });
		try {
			return await go(true);
		} catch (e) {
			// 中转站上的模型不一定认 size / quality：参数被拒时去掉再试一次
			if (e instanceof ImageGenError && e.code === "bad_request" && /size|quality|parameter|argument|unsupported|unknown/i.test(e.detail)) return go(false);
			throw e;
		}
	};
	const images: GenImage[] = [];
	let revised: string | undefined;
	for (let i = 0; i < (dalle3 ? n : 1); i++) {
		const j = await once();
		revised ??= j.data?.[0]?.revised_prompt;
		images.push(...(await openaiData(ctx, j.data, r.signal)));
	}
	if (!images.length) throw new ImageGenError("empty", "返回里没有 data[].b64_json / url");
	return { images, revisedPrompt: revised };
}

async function openaiEdit(ctx: Ctx, ep: ImageEndpoint, r: GenRequest): Promise<GenResult> {
	const base = trimBase(ep.baseUrl);
	const fd = new FormData();
	fd.set("model", r.model);
	fd.set("prompt", r.prompt);
	fd.set("n", String(Math.max(1, r.n ?? 1)));
	const s = openaiSize(r.model, r.aspect, r.size);
	if (s && !/dall-e/i.test(r.model)) fd.set("size", s);
	if (r.quality && r.quality !== "auto" && /gpt-image/i.test(r.model)) fd.set("quality", r.quality);
	const field = r.images!.length > 1 || /gpt-image/i.test(r.model) ? "image[]" : "image";
	for (const im of r.images!) fd.append(field, new Blob([new Uint8Array(im.data)], { type: im.mime }), im.name);
	if (/dall-e/i.test(r.model)) fd.set("response_format", "b64_json");
	const j = await json(ctx, `${base}/images/edits`, { method: "POST", headers: bearer(ep), body: fd, signal: r.signal });
	const images = await openaiData(ctx, j.data, r.signal);
	if (!images.length) throw new ImageGenError("empty", "返回里没有 data[].b64_json / url");
	return { images };
}

async function arkGenerate(ctx: Ctx, ep: ImageEndpoint, r: GenRequest): Promise<GenResult> {
	const base = trimBase(ep.baseUrl);
	const n = Math.max(1, r.n ?? 1);
	if (r.images?.length && !supportsEdit("ark", r.model)) throw new ImageGenError("unsupported", `${r.model} 不支持参考图`, "这个模型不支持改图 / 参考图，换 Seedream 4 或 SeedEdit");
	const images: GenImage[] = [];
	for (let i = 0; i < n; i++) {
		const b: Record<string, unknown> = { model: r.model, prompt: r.prompt, response_format: "b64_json", watermark: false };
		const size = arkSize(r.model, r.aspect, r.size);
		if (size) b.size = size;
		if (r.images?.length) b.image = r.images.length === 1 ? dataUrl(r.images[0]) : r.images.map(dataUrl);
		if (/seedream-4/i.test(r.model)) b.sequential_image_generation = "disabled";
		const j = await json(ctx, `${base}/images/generations`, { method: "POST", headers: { "content-type": "application/json", ...bearer(ep) }, body: JSON.stringify(b), signal: r.signal });
		const got = await openaiData(ctx, j.data, r.signal);
		if (!got.length && j.error) throw classify(400, JSON.stringify(j));
		images.push(...got);
	}
	if (!images.length) throw new ImageGenError("empty", "返回里没有 data[].b64_json / url");
	return { images };
}

// ---------------------------------------------------------------- 阿里云百炼 DashScope
const dsBase = (u: string) => trimBase(u).replace(/\/(compatible-mode\/v1|api\/v1)$/, "");
function dsError(j: { code?: string; message?: string; output?: { code?: string; message?: string } }) {
	const code = j.output?.code ?? j.code ?? "";
	const msg = j.output?.message ?? j.message ?? "";
	return classify(/DataInspection|Sensitive/i.test(code) ? 400 : /InvalidApiKey/i.test(code) ? 401 : /Throttl|Quota|Arrearage/i.test(code) ? 429 : 500, JSON.stringify({ code, message: msg }));
}

async function dashscopeGenerate(ctx: Ctx, ep: ImageEndpoint, r: GenRequest): Promise<GenResult> {
	const base = dsBase(ep.baseUrl);
	const n = Math.min(4, Math.max(1, r.n ?? 1));
	const headers = { "content-type": "application/json", ...bearer(ep) };
	// 改图 / 参考图（qwen-image-edit、wan2.5-i2i 等）：同步的 multimodal-generation 接口
	if (r.images?.length || /edit/i.test(r.model)) {
		if (!r.images?.length) throw new ImageGenError("unsupported", `${r.model} 需要输入图片`, "这个模型是改图模型，需要先给一张图片");
		const body = {
			model: r.model,
			input: { messages: [{ role: "user", content: [...r.images.map((i) => ({ image: dataUrl(i) })), { text: r.prompt }] }] },
			parameters: { n, watermark: false, ...(r.size || r.aspect ? { size: dashscopeSize(r.model, r.aspect, r.size) } : {}) },
		};
		const j = await json(ctx, `${base}/api/v1/services/aigc/multimodal-generation/generation`, { method: "POST", headers, body: JSON.stringify(body), signal: r.signal });
		if (j.code && !j.output) throw dsError(j);
		const urls: string[] = (j.output?.choices ?? []).flatMap((c: { message?: { content?: { image?: string }[] } }) => (c.message?.content ?? []).map((x) => x.image).filter(Boolean));
		if (!urls.length) throw new ImageGenError("empty", JSON.stringify(j).slice(0, 500));
		return { images: await Promise.all(urls.map((u) => download(ctx, u, r.signal))) };
	}
	// 文生图：异步任务 + 轮询
	const body = { model: r.model, input: { prompt: r.prompt }, parameters: { size: dashscopeSize(r.model, r.aspect, r.size), n, watermark: false } };
	const sub = await json(ctx, `${base}/api/v1/services/aigc/text2image/image-synthesis`, { method: "POST", headers: { ...headers, "X-DashScope-Async": "enable" }, body: JSON.stringify(body), signal: r.signal });
	const taskId = sub.output?.task_id;
	if (!taskId) throw dsError(sub);
	const start = Date.now();
	for (;;) {
		if (r.signal?.aborted) throw new ImageGenError("timeout", "已取消", "已取消");
		const t = await json(ctx, `${base}/api/v1/tasks/${taskId}`, { headers: bearer(ep), signal: r.signal });
		const st = t.output?.task_status;
		if (st === "SUCCEEDED") {
			const results: { url?: string; code?: string; message?: string }[] = t.output.results ?? [];
			const ok = results.filter((x) => x.url);
			if (!ok.length) throw results[0]?.code ? dsError({ code: results[0].code, message: results[0].message }) : new ImageGenError("empty", JSON.stringify(t).slice(0, 500));
			return { images: await Promise.all(ok.map((x) => download(ctx, x.url!, r.signal))), revisedPrompt: t.output.results?.[0]?.actual_prompt };
		}
		if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") throw dsError(t);
		if (Date.now() - start > ctx.pollTimeoutMs) throw new ImageGenError("timeout", `任务 ${taskId} 超过 ${Math.round(ctx.pollTimeoutMs / 1000)} 秒还没完成（状态 ${st}）`);
		await ctx.sleep(ctx.pollMs);
	}
}

// ---------------------------------------------------------------- Google Gemini / Imagen
async function geminiGenerate(ctx: Ctx, ep: ImageEndpoint, r: GenRequest): Promise<GenResult> {
	const base = trimBase(ep.baseUrl);
	const model = r.model.replace(/^models\//, "");
	const headers = { "content-type": "application/json", ...(ep.apiKey ? { "x-goog-api-key": ep.apiKey } : {}) };
	const n = Math.max(1, r.n ?? 1);
	const aspect = normAspect(r.aspect);
	if (/^imagen/i.test(model)) {
		if (r.images?.length) throw new ImageGenError("unsupported", `${model} 只支持文生图`, "Imagen 不支持改图 / 参考图，换 Gemini 图片模型");
		const j = await json(ctx, `${base}/models/${model}:predict`, { method: "POST", headers, body: JSON.stringify({ instances: [{ prompt: r.prompt }], parameters: { sampleCount: Math.min(4, n), ...(aspect ? { aspectRatio: aspect } : {}) } }), signal: r.signal });
		const preds: { bytesBase64Encoded?: string; mimeType?: string; raiFilteredReason?: string }[] = j.predictions ?? [];
		const images = preds.filter((p) => p.bytesBase64Encoded).map((p) => b64img(p.bytesBase64Encoded!));
		if (!images.length) throw preds.some((p) => p.raiFilteredReason) || !preds.length ? new ImageGenError("policy", JSON.stringify(j).slice(0, 500)) : new ImageGenError("empty", JSON.stringify(j).slice(0, 500));
		return { images };
	}
	const images: GenImage[] = [];
	let text = "";
	for (let i = 0; i < n; i++) {
		const parts = [...(r.images ?? []).map((im) => ({ inline_data: { mime_type: im.mime, data: im.data.toString("base64") } })), { text: r.prompt }];
		const body = { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}) } };
		const j = await json(ctx, `${base}/models/${model}:generateContent`, { method: "POST", headers, body: JSON.stringify(body), signal: r.signal });
		if (j.promptFeedback?.blockReason) throw new ImageGenError("policy", `blockReason: ${j.promptFeedback.blockReason}`);
		const cand = j.candidates?.[0];
		const ps: { text?: string; inlineData?: { mimeType: string; data: string }; inline_data?: { mime_type: string; data: string } }[] = cand?.content?.parts ?? [];
		for (const p of ps) {
			const d = p.inlineData ?? (p.inline_data && { mimeType: p.inline_data.mime_type, data: p.inline_data.data });
			if (d?.data) images.push({ data: Buffer.from(d.data, "base64"), mime: d.mimeType || "image/png" });
			else if (p.text) text += p.text;
		}
		if (!images.length && /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/i.test(cand?.finishReason ?? "")) throw new ImageGenError("policy", `finishReason: ${cand.finishReason}`);
	}
	if (!images.length) throw new ImageGenError("empty", text ? `模型只回了文字：${text.slice(0, 500)}` : "返回里没有图片");
	return { images, text: text || undefined };
}

// ---------------------------------------------------------------- 入口
export async function generate(ep: ImageEndpoint, r: GenRequest, ctx: Ctx = defaultCtx()): Promise<GenResult> {
	if (!r.prompt?.trim()) throw new ImageGenError("bad_request", "prompt 为空", "请描述要画什么");
	switch (ep.kind) {
		case "openai":
		case "xai":
			return openaiGenerate(ctx, ep, r);
		case "ark":
			return arkGenerate(ctx, ep, r);
		case "dashscope":
			return dashscopeGenerate(ctx, ep, r);
		case "gemini":
			return geminiGenerate(ctx, ep, r);
	}
	throw new ImageGenError("unsupported", `未知的服务类型 ${ep.kind}`);
}

/** 拉取模型列表：返回全部 id 与其中的图片模型。服务不提供列表时抛错（界面退回预设）。 */
export async function listModels(ep: ImageEndpoint, ctx: Ctx = defaultCtx()): Promise<{ all: string[]; image: string[] }> {
	const base = trimBase(ep.baseUrl);
	let ids: string[] = [];
	if (ep.kind === "gemini") {
		const j = await json(ctx, `${base}/models?pageSize=1000`, { headers: ep.apiKey ? { "x-goog-api-key": ep.apiKey } : {} }, 20_000);
		ids = (j.models ?? []).map((m: { name: string }) => m.name.replace(/^models\//, ""));
	} else {
		const url = ep.kind === "dashscope" ? `${dsBase(ep.baseUrl)}/compatible-mode/v1/models` : `${base}/models`;
		const j = await json(ctx, url, { headers: bearer(ep) }, 20_000);
		ids = (Array.isArray(j) ? j : (j.data ?? j.models ?? [])).map((m: { id?: string; name?: string }) => m.id ?? m.name).filter(Boolean);
	}
	ids = [...new Set(ids)].sort();
	return { all: ids, image: ids.filter(isImageModel) };
}
