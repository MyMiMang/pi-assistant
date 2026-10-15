/**
 * 识图：当前模型不支持图片时，把图片交给一个支持识图的模型看，换成文字描述。
 *  - 设置项 visionModel：{provider,id} = 用户指定；null / 未设 = 自动（从已配置的服务里挑支持识图的模型）
 *  - 是否支持识图：Pi 模型元数据 input 含 image（自定义服务按 models.dev 参数库自动补，见 custom-providers withLimits）
 */
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { getSetting } from "./db.ts";
import { defaultModel, models } from "./models.ts";

export type ModelRef = { provider: string; id: string };
const IMG_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
export const imageMime = (path: string) => IMG_MIME[extname(path).toLowerCase()];

/** 这个模型能不能直接看图（以 Pi 模型元数据为准：不含 image 的模型 Pi 发请求时会把图片去掉；自定义服务的识图标记按 models.dev 自动补上） */
export function supportsVision(ref: ModelRef | null | undefined): boolean {
	if (!ref) return false;
	return !!models.listModels(ref.provider).find((x) => x.id === ref.id)?.input.includes("image");
}

/** 自动挑选的优先级：默认模型 > 名字里带 vl/vision/4o/gemini 等的 > 其它；越便宜的（flash/mini/lite）越靠前 */
const cheap = (id: string) => (/flash|mini|lite|haiku|turbo|small/i.test(id) ? 0 : 1);
export function pickVisionModel(): { model: ModelRef | null; source: "user" | "auto" | "none" } {
	const set = getSetting<ModelRef | null>("visionModel", null);
	if (set && models.getModel(set.provider, set.id)) return { model: set, source: "user" };
	const d = defaultModel();
	if (d && supportsVision(d)) return { model: d, source: "auto" };
	const configured = new Set(models.listProviders().filter((p) => p.configured).map((p) => p.id));
	const cands = models
		.listModels()
		.filter((m) => configured.has(m.provider) && supportsVision(m))
		.sort((a, b) => (a.provider === d?.provider ? 0 : 1) - (b.provider === d?.provider ? 0 : 1) || cheap(a.id) - cheap(b.id));
	return cands[0] ? { model: { provider: cands[0].provider, id: cands[0].id }, source: "auto" } : { model: null, source: "none" };
}

const NO_VISION = "没有可用的识图模型：当前模型不支持看图，已配置的服务里也没有支持识图的模型。请告诉用户：在 设置 › 模型 › 识图模型 里选一个支持图片的模型（例如 qwen-vl、gpt-4o-mini、gemini-flash），否则你无法确认图片内容。";

export type DescribeImpl = (ref: ModelRef, prompt: string, images: { data: string; mimeType: string }[], signal?: AbortSignal) => Promise<{ text: string; error?: string; usage?: { input: number; output: number } }>;
let impl: DescribeImpl = async (ref, prompt, images, signal) => {
	const r = await models.complete(ref.provider, ref.id, { messages: [{ role: "user", text: prompt, images }], maxTokens: 1500, signal });
	return { text: r.text, error: r.error, usage: r.usage };
};
/** 测试用：替换识图调用 */
export const setDescribeImpl = (f: DescribeImpl) => void (impl = f);

/** 让识图模型看一张或几张图片，返回文字描述（失败时返回说明，ok=false） */
export async function describeImages(imgs: { data: string; mimeType: string; label?: string }[], question?: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string; model?: ModelRef; usage?: { input: number; output: number } }> {
	const { model } = pickVisionModel();
	if (!model) return { ok: false, text: NO_VISION };
	const labels = imgs.map((x, i) => `图${i + 1}${x.label ? `：${x.label}` : ""}`).join("\n");
	const prompt = [
		"请用简体中文客观描述下面的图片（按顺序逐张描述）：画面主体、文字内容、风格/类型（照片、截图、海报、图表…）。",
		question ? `重点回答：${question}。如果图片和这个问题/主题无关，明确说“不相关”。` : "",
		`图片列表：\n${labels}`,
	]
		.filter(Boolean)
		.join("\n");
	try {
		const r = await impl(model, prompt, imgs.map(({ data, mimeType }) => ({ data, mimeType })), signal);
		if (r.error || !r.text.trim()) return { ok: false, text: `识图模型 ${model.provider}/${model.id} 调用失败：${r.error ?? "没有返回内容"}`, model };
		return { ok: true, text: r.text.trim(), model, usage: r.usage };
	} catch (e) {
		return { ok: false, text: `识图模型调用失败：${e instanceof Error ? e.message : String(e)}`, model };
	}
}

/** 读文件 → 图片块（太大的不读） */
export function loadImage(path: string): { data: string; mimeType: string } {
	const mime = imageMime(path);
	if (!mime) throw new Error(`不是图片文件：${path}`);
	if (statSync(path).size > 20 * 1024 * 1024) throw new Error(`图片太大（超过 20MB）：${path}`);
	return { data: readFileSync(path).toString("base64"), mimeType: mime };
}
