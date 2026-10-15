/**
 * 识图能力判定与（显式）识图调用。
 *
 * 事实来源是 Pi 公开模型元数据：`input` 含 `image` 才算能看图（自定义服务按 models.dev 参数库自动补，见 custom-providers withLimits）。
 *
 * 现在的请求路径（聊天附件、look_at_image、read 图片）**只跟随当前对话/会话模型**：
 *  - 当前模型支持图片 → 图片直接作为内容发给它；
 *  - 当前模型不支持图片 → 明确说明并引导用户换一个支持图片的模型，**绝不静默改用别的模型**（避免额外云费用）。
 *
 * `describeImages` / `pickVisionModel` 只保留给显式调用与 legacy `/api/models/vision` 只读兼容，
 * 不再被任何默认请求路径使用；`visionModel` 设置保留不删（旧 UI 仍可读写）。
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

/** legacy 自动挑选（仅 `/api/models/vision` 只读兼容）：默认模型 > 名字里带 vl/vision/4o/gemini 等的 > 其它；越便宜的（flash/mini/lite）越靠前。不用于请求路径。 */
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

/** 当前对话模型不能看图时的统一提示：明确、可执行、不静默换模型、不产生别的模型费用。 */
export function visionUnsupportedMessage(ref?: ModelRef | null): string {
	const who = ref ? `当前对话用的模型（${ref.provider}/${ref.id}）` : "当前对话用的模型";
	return `${who}不支持图片输入，我看不到图片内容。请让用户在 设置 › 模型 里把当前对话/助理换成支持看图的模型（例如 qwen-vl、gpt-4o-mini、gemini-flash），再把图片发一次；我不会自动改用别的模型看图（那会产生额外费用）。`;
}

/** legacy 显式识图（不用于默认请求路径）：没有可用识图模型时的说明。 */
const NO_VISION = "没有可用的识图模型：当前模型不支持看图，已配置的服务里也没有支持识图的模型。请告诉用户：在 设置 › 模型 里选一个支持图片的模型（例如 qwen-vl、gpt-4o-mini、gemini-flash），否则无法确认图片内容。";

export type DescribeImpl = (ref: ModelRef, prompt: string, images: { data: string; mimeType: string }[], signal?: AbortSignal) => Promise<{ text: string; error?: string; usage?: { input: number; output: number } }>;
let impl: DescribeImpl = async (ref, prompt, images, signal) => {
	const r = await models.complete(ref.provider, ref.id, { messages: [{ role: "user", text: prompt, images }], maxTokens: 1500, signal });
	return { text: r.text, error: r.error, usage: r.usage };
};
/** 测试用：替换识图调用 */
export const setDescribeImpl = (f: DescribeImpl) => void (impl = f);

/**
 * 让**显式指定的**识图模型看图片，返回文字描述（失败时返回说明，ok=false）。
 * legacy / 显式调用用；默认请求路径不再走这里（见文件头说明）。
 */
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
