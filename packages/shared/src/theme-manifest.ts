/**
 * Pi Assistant 自有「外观主题」Typed ThemeManifest v1（前后端共用）。
 *
 * 用途：让用户 / AI 生成一套外观主题。**不是** Pi SDK 的 TUI theme；不改 SDK / node_modules。
 * 这份 schema 放在 shared，是因为网页端（解析 / 应用 / 预览）与后端 `theme_draft` 工具
 * （校验 AI 产出）必须用同一套白名单与 fail-closed 规则，避免两边漂移。
 *
 * 安全边界（v1 冻结，不扩 scope）：
 * - 只接受**白名单 CSS 变量**；出现未知 `--x` 一律报错（不静默丢弃、不注入）。
 * - 颜色只允许 hex / rgb()/rgba()/hsl()/hsla() / transparent；尺寸只允许 px/rem 且限范围；
 *   字体只允许字体名列表字符集。任何值里出现 `url(`、`\`、`;`、`{}`、`<>`、`@`、换行都拒绝。
 * - 装饰只允许 enum（纹理 / 边角 / 阴影 / 背景），由内置 CSS 映射，不接受自由字符串。
 * - 不允许任意 JS、远程 CSS、`@import`、`url()` 追踪、读取本地文件、HTML 注入。
 * - 坏值 fail-closed：拒绝整份 manifest，**不 reset 当前主题**，返回可读错误列表。
 * - 对比度低只给 warning，不强制禁止（保留创作自由）。
 *
 * 图片素材：只存**附件 id + 元数据**（mime / 尺寸 / 字节数 / sha256），**绝不写 base64 / 本地绝对路径**。
 * `usage: "reference"` 仅作视觉参考，默认导出**不包含**；`"background" | "decor"` 才是用户显式选定的
 * 主题素材（首版导出仍不打包 zip，见 docs/design/appearance-themes.md）。
 */

export const THEME_MANIFEST_VERSION = 1 as const;

/** 必需的颜色 token（缺一个就 fail-closed；保证换主题后界面不会出现未定义变量导致白屏 / 透明）。 */
export const REQUIRED_COLOR_TOKENS = [
	"--bg",
	"--side",
	"--panel",
	"--card",
	"--fg",
	"--mut",
	"--mut2",
	"--line",
	"--line-strong",
	"--hover",
	"--active",
	"--user-bg",
	"--user-fg",
	"--acc",
	"--acc-fg",
	"--acc-soft",
	"--ok",
	"--warn",
	"--z-light",
	"--z-dark",
] as const;

/** 可选颜色 token（缺省由引擎补内置中性值）。 */
export const OPTIONAL_COLOR_TOKENS = ["--acc2", "--live"] as const;

/** 可选尺寸 token（px / rem，限范围）。 */
export const OPTIONAL_SIZE_TOKENS = ["--r", "--r-sm", "--r-bubble", "--r-tail", "--r-comp", "--r-btn", "--r-chip", "--r-logo", "--r-av"] as const;

/** 可选字体 token（字体名列表，严格字符集，不接受 url / 函数）。 */
export const OPTIONAL_FONT_TOKENS = ["--font", "--display", "--mono"] as const;

export const REQUIRED_COLOR_TOKEN_SET = new Set<string>(REQUIRED_COLOR_TOKENS);
export const KNOWN_TOKEN_SET = new Set<string>([...REQUIRED_COLOR_TOKENS, ...OPTIONAL_COLOR_TOKENS, ...OPTIONAL_SIZE_TOKENS, ...OPTIONAL_FONT_TOKENS]);

/** 装饰：全部 enum → 内置 CSS，不接受自由字符串。 */
export const DECOR_TEXTURES = ["none", "dots", "grid"] as const;
export const DECOR_CORNERS = ["round", "step2", "step4"] as const;
export const DECOR_SHADOWS = ["soft", "elevated", "none"] as const;
export const DECOR_BACKGROUNDS = ["flat", "glow"] as const;
export type DecorTexture = (typeof DECOR_TEXTURES)[number];
export type DecorCorner = (typeof DECOR_CORNERS)[number];
export type DecorShadow = (typeof DECOR_SHADOWS)[number];
export type DecorBackground = (typeof DECOR_BACKGROUNDS)[number];

/** 图片素材用途：reference 只作参考（默认导出不含）；background / decor 是用户显式选定的主题素材。 */
export const THEME_IMAGE_USAGES = ["reference", "background", "decor"] as const;
export type ThemeImageUsage = (typeof THEME_IMAGE_USAGES)[number];

export const MANIFEST_LIMITS = {
	nameMax: 24,
	authorMax: 32,
	altMax: 80,
	imagesMax: 6,
	imageBytesMax: 8 * 1024 * 1024,
	imagePixelsMax: 4096 * 4096,
	idMax: 64,
	basedOnMax: 64,
} as const;

export interface ThemeImageRef {
	/** 本地上传附件的稳定 id（不是路径、不是 base64）。 */
	attachmentId: string;
	/** 用途；缺省按 reference 处理（仅作参考，不导出）。 */
	usage?: ThemeImageUsage;
	/** 实际校验过的 MIME（image/png 等）。 */
	mime: string;
	width?: number;
	height?: number;
	bytes?: number;
	/** 可选内容指纹，用于去重 / 完整性核对。 */
	sha256?: string;
	/** 无障碍文本（用户可改）。 */
	alt?: string;
}

export interface ThemeDecor {
	texture?: DecorTexture;
	corner?: DecorCorner;
	shadow?: DecorShadow;
	background?: DecorBackground;
}

export type ThemeTokenMap = Record<string, string>;

export interface ThemeManifestV1 {
	manifestVersion: 1;
	/** 仅作 key，绝不作文件路径。 */
	id: string;
	name: string;
	author?: string;
	/** 可选：基于哪个内置主题（v1 仅作来源标注与 UI 展示，不做 token 继承）。 */
	basedOn?: string;
	modes: { light: ThemeTokenMap; dark: ThemeTokenMap };
	decor?: ThemeDecor;
	images?: ThemeImageRef[];
	createdAt: string;
	updatedAt: string;
}

export interface ThemeError {
	/** 出错字段路径，例如 `modes.light.--bg`。 */
	path: string;
	code: "required" | "type" | "value" | "unknown_token" | "too_long" | "too_many" | "format" | "unsupported";
	message: string;
	expected?: string;
	actual?: string;
}

export type ThemeManifestValidation =
	| { ok: true; manifest: ThemeManifestV1; warnings: string[] }
	| { ok: false; errors: ThemeError[]; warnings: string[] };

/* ------------------------------------------------------------------ *
 * 值校验（严格、fail-closed）
 * ------------------------------------------------------------------ */

const FORBIDDEN_IN_VALUE = /[\\;{}<>@\n\r]|url\s*\(|\/\*/i;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_HSL = /^(?:rgba?|hsla?)\(\s*[0-9.]+%?(?:\s*[,/]\s*[0-9.]+%?){2,3}\s*\)$/i;
const LENGTH = /^([0-9]+(?:\.[0-9]+)?)(px|rem|em)$/;
const FONT_LIST = /^[A-Za-z0-9\u4e00-\u9fff\s,'"-]+$/;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const MIME_IMAGE = /^image\/[a-z0-9.+-]+$/i;

function isColor(v: string): boolean {
	if (v === "transparent") return true;
	return HEX.test(v) || RGB_HSL.test(v);
}

function isLength(v: string): boolean {
	const m = LENGTH.exec(v);
	if (!m) return false;
	const n = Number(m[1]);
	const unit = m[2];
	if (unit === "px") return n >= 0 && n <= 64;
	return n >= 0 && n <= 4; // rem / em
}

function isFontList(v: string): boolean {
	return v.length > 0 && v.length <= 200 && FONT_LIST.test(v) && !FORBIDDEN_IN_VALUE.test(v);
}

function err(path: string, code: ThemeError["code"], message: string, expected?: string, actual?: string): ThemeError {
	return { path, code, message, expected, actual };
}

function validateTokenMap(map: unknown, path: string, errors: ThemeError[], warnings: string[]) {
	if (map == null || typeof map !== "object" || Array.isArray(map)) {
		errors.push(err(path, "type", "必须是一个对象", "object", Array.isArray(map) ? "array" : typeof map));
		return {} as ThemeTokenMap;
	}
	const out: ThemeTokenMap = {};
	for (const [k, raw] of Object.entries(map as Record<string, unknown>)) {
		const key = k.trim();
		const tokenPath = `${path}.${key}`;
		if (!key.startsWith("--")) {
			errors.push(err(tokenPath, "format", "token 必须以 -- 开头", "--xxx", key));
			continue;
		}
		if (!KNOWN_TOKEN_SET.has(key)) {
			errors.push(err(tokenPath, "unknown_token", "不在白名单内，已拒绝（不注入未知变量）", REQUIRED_COLOR_TOKENS.join(" / ") + " / 可选 token", key));
			continue;
		}
		if (typeof raw !== "string") {
			errors.push(err(tokenPath, "type", "token 值必须是字符串", "string", typeof raw));
			continue;
		}
		const v = raw.trim();
		if (v.length === 0 || v.length > 200) {
			errors.push(err(tokenPath, "value", "token 值长度非法", "1..200 字符", String(v.length)));
			continue;
		}
		if (FORBIDDEN_IN_VALUE.test(v)) {
			errors.push(err(tokenPath, "value", "值里含被禁止的字符 / 函数（url、@、;、{}、<>、\\ 等）", "安全的颜色 / 尺寸 / 字体值", v.slice(0, 40)));
			continue;
		}
		if (REQUIRED_COLOR_TOKEN_SET.has(key) || key === "--acc2" || key === "--live") {
			if (!isColor(v)) {
				errors.push(err(tokenPath, "value", "不是允许的颜色写法", "#rgb/#rrggbb(/#aa) 或 rgb()/rgba()/hsl()/hsla()/transparent", v));
				continue;
			}
		} else if ((OPTIONAL_SIZE_TOKENS as readonly string[]).includes(key)) {
			if (!isLength(v)) {
				errors.push(err(tokenPath, "value", "不是允许的尺寸", "0..64px 或 0..4rem/em", v));
				continue;
			}
		} else if ((OPTIONAL_FONT_TOKENS as readonly string[]).includes(key)) {
			if (!isFontList(v)) {
				errors.push(err(tokenPath, "value", "字体值非法（只允许字体名列表）", "字体名 / 逗号分隔的字体族", v));
				continue;
			}
		}
		out[key] = v;
	}
	return out;
}

function validateDecor(decor: unknown, errors: ThemeError[]): ThemeDecor | undefined {
	if (decor == null) return undefined;
	if (typeof decor !== "object" || Array.isArray(decor)) {
		errors.push(err("decor", "type", "必须是对象", "object", Array.isArray(decor) ? "array" : typeof decor));
		return undefined;
	}
	const d = decor as Record<string, unknown>;
	const out: ThemeDecor = {};
	const check = <T extends string>(key: keyof ThemeDecor, allowed: readonly T[]) => {
		const v = d[key];
		if (v == null) return;
		if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
			errors.push(err(`decor.${key}`, "value", "不是允许的枚举值", allowed.join(" / "), String(v)));
			return;
		}
		(out as Record<string, string>)[key] = v;
	};
	check("texture", DECOR_TEXTURES);
	check("corner", DECOR_CORNERS);
	check("shadow", DECOR_SHADOWS);
	check("background", DECOR_BACKGROUNDS);
	return Object.keys(out).length ? out : undefined;
}

function validateImages(images: unknown, errors: ThemeError[]): ThemeImageRef[] | undefined {
	if (images == null) return undefined;
	if (!Array.isArray(images)) {
		errors.push(err("images", "type", "必须是数组", "array", typeof images));
		return undefined;
	}
	if (images.length > MANIFEST_LIMITS.imagesMax) {
		errors.push(err("images", "too_many", "参考 / 素材图数量超限", `≤ ${MANIFEST_LIMITS.imagesMax}`, String(images.length)));
		return undefined;
	}
	const out: ThemeImageRef[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < images.length; i++) {
		const raw = images[i] as Record<string, unknown> | null;
		const p = `images[${i}]`;
		if (raw == null || typeof raw !== "object") {
			errors.push(err(p, "type", "必须是对象", "object", typeof raw));
			continue;
		}
		const attachmentId = typeof raw.attachmentId === "string" ? raw.attachmentId.trim() : "";
		if (!attachmentId || attachmentId.length > 128 || !SAFE_ID.test(attachmentId)) {
			errors.push(err(`${p}.attachmentId`, "value", "附件 id 非法（只允许稳定 id，不允许路径）", "稳定附件 id", attachmentId.slice(0, 40)));
			continue;
		}
		if (seen.has(attachmentId)) {
			errors.push(err(`${p}.attachmentId`, "value", "重复的附件引用", "每个附件只出现一次", attachmentId));
			continue;
		}
		const mime = typeof raw.mime === "string" ? raw.mime.trim() : "";
		if (!MIME_IMAGE.test(mime)) {
			errors.push(err(`${p}.mime`, "value", "必须是图片 MIME", "image/png 等", mime));
			continue;
		}
		const usage = raw.usage == null ? "reference" : raw.usage;
		if (typeof usage !== "string" || !(THEME_IMAGE_USAGES as readonly string[]).includes(usage)) {
			errors.push(err(`${p}.usage`, "value", "用途非法", THEME_IMAGE_USAGES.join(" / "), String(usage)));
			continue;
		}
		const ref: ThemeImageRef = { attachmentId, mime, usage: usage as ThemeImageUsage };
		for (const numKey of ["width", "height", "bytes"] as const) {
			const v = raw[numKey];
			if (v == null) continue;
			if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MANIFEST_LIMITS.imagePixelsMax * 8) {
				errors.push(err(`${p}.${numKey}`, "value", "数值非法", "非负有限数", String(v)));
				continue;
			}
			ref[numKey] = Math.round(v);
		}
		if (ref.width && ref.height && ref.width * ref.height > MANIFEST_LIMITS.imagePixelsMax) {
			errors.push(err(p, "value", "像素总量超限", `≤ ${MANIFEST_LIMITS.imagePixelsMax} 像素`, `${ref.width}x${ref.height}`));
			continue;
		}
		if (ref.bytes != null && ref.bytes > MANIFEST_LIMITS.imageBytesMax) {
			errors.push(err(`${p}.bytes`, "value", "图片字节数超限", `≤ ${MANIFEST_LIMITS.imageBytesMax}`, String(ref.bytes)));
			continue;
		}
		if (raw.sha256 != null) {
			if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(raw.sha256)) {
				errors.push(err(`${p}.sha256`, "value", "sha256 非法", "64 位十六进制", String(raw.sha256).slice(0, 20)));
				continue;
			}
			ref.sha256 = raw.sha256.toLowerCase();
		}
		if (raw.alt != null) {
			if (typeof raw.alt !== "string" || raw.alt.length > MANIFEST_LIMITS.altMax) {
				errors.push(err(`${p}.alt`, "value", "alt 文本非法 / 过长", `≤ ${MANIFEST_LIMITS.altMax} 字符`, typeof raw.alt === "string" ? String(raw.alt.length) : typeof raw.alt));
				continue;
			}
			ref.alt = raw.alt.trim();
		}
		seen.add(attachmentId);
		out.push(ref);
	}
	return out.length ? out : undefined;
}

/* ------------------------------------------------------------------ *
 * 主校验入口
 * ------------------------------------------------------------------ */

/** 解析并校验一份 manifest（未知输入）。fail-closed：任一错误即返回 ok:false，不产出部分结果。 */
export function validateThemeManifest(input: unknown): ThemeManifestValidation {
	const errors: ThemeError[] = [];
	const warnings: string[] = [];
	if (input == null || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, errors: [err("", "type", "manifest 必须是对象", "object", Array.isArray(input) ? "array" : typeof input)], warnings };
	}
	const raw = input as Record<string, unknown>;

	if (raw.manifestVersion !== THEME_MANIFEST_VERSION) {
		errors.push(err("manifestVersion", "unsupported", "manifest 版本不支持", String(THEME_MANIFEST_VERSION), String(raw.manifestVersion)));
	}
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id || id.length > MANIFEST_LIMITS.idMax || !SAFE_ID.test(id)) {
		errors.push(err("id", "value", "id 非法（只允许字母数字-_，且不能是路径）", "uuid 或安全 id", id.slice(0, 40)));
	}
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (!name) errors.push(err("name", "required", "主题名必填", "1..24 字符", ""));
	else if (name.length > MANIFEST_LIMITS.nameMax) errors.push(err("name", "too_long", "主题名过长", `≤ ${MANIFEST_LIMITS.nameMax} 字符`, String(name.length)));
	if (name && /[\n\r<>]/.test(name)) errors.push(err("name", "value", "主题名含非法字符", "普通文本", name.slice(0, 20)));

	let author: string | undefined;
	if (raw.author != null) {
		if (typeof raw.author !== "string" || raw.author.length > MANIFEST_LIMITS.authorMax) {
			errors.push(err("author", "too_long", "作者名非法 / 过长", `≤ ${MANIFEST_LIMITS.authorMax} 字符`, typeof raw.author === "string" ? String(raw.author.length) : typeof raw.author));
		} else author = raw.author.trim();
	}
	let basedOn: string | undefined;
	if (raw.basedOn != null) {
		if (typeof raw.basedOn !== "string" || !raw.basedOn.trim() || raw.basedOn.length > MANIFEST_LIMITS.basedOnMax || !SAFE_ID.test(raw.basedOn.trim())) {
			errors.push(err("basedOn", "value", "basedOn 非法", "内置主题 id", String(raw.basedOn).slice(0, 40)));
		} else basedOn = raw.basedOn.trim();
	}

	const modesRaw = raw.modes as Record<string, unknown> | undefined;
	let light: ThemeTokenMap = {};
	let dark: ThemeTokenMap = {};
	if (modesRaw == null || typeof modesRaw !== "object" || Array.isArray(modesRaw)) {
		errors.push(err("modes", "required", "必须提供 light / dark 两套 token", "{light, dark}", String(modesRaw)));
	} else {
		light = validateTokenMap(modesRaw.light, "modes.light", errors, warnings);
		dark = validateTokenMap(modesRaw.dark, "modes.dark", errors, warnings);
		for (const mode of ["light", "dark"] as const) {
			for (const t of REQUIRED_COLOR_TOKENS) {
				const map = mode === "light" ? light : dark;
				if (!(t in map)) errors.push(err(`modes.${mode}.${t}`, "required", `必需颜色 token 缺失`, t, "undefined"));
			}
		}
	}

	const decor = validateDecor(raw.decor, errors);
	const images = validateImages(raw.images, errors);

	const now = new Date().toISOString();
	const createdAt = typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : now;
	const updatedAt = typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : createdAt;

	if (errors.length) return { ok: false, errors, warnings };

	const manifest: ThemeManifestV1 = {
		manifestVersion: THEME_MANIFEST_VERSION,
		id,
		name,
		modes: { light, dark },
		createdAt,
		updatedAt,
	};
	if (author) manifest.author = author;
	if (basedOn) manifest.basedOn = basedOn;
	if (decor) manifest.decor = decor;
	if (images) manifest.images = images;

	warnings.push(...manifestContrastWarnings(manifest));
	return { ok: true, manifest, warnings };
}

/* ------------------------------------------------------------------ *
 * 对比度 warning（提示但不禁止）
 * ------------------------------------------------------------------ */

function parseHex(c: string): [number, number, number] | null {
	const h = c.trim();
	if (!HEX.test(h)) return null;
	let s = h.slice(1);
	if (s.length === 3 || s.length === 4) s = s.split("").map((x) => x + x).join("");
	const r = parseInt(s.slice(0, 2), 16);
	const g = parseInt(s.slice(2, 4), 16);
	const b = parseInt(s.slice(4, 6), 16);
	return [r, g, b];
}
function relLum([r, g, b]: [number, number, number]): number {
	const f = (v: number) => {
		const x = v / 255;
		return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** 对比度（1..21）；任一不是纯 hex 时返回 null（不误报）。 */
export function contrastRatio(a: string, b: string): number | null {
	const ca = parseHex(a);
	const cb = parseHex(b);
	if (!ca || !cb) return null;
	const [l1, l2] = [relLum(ca), relLum(cb)].sort((x, y) => y - x);
	return (l1 + 0.05) / (l2 + 0.05);
}

/** 正文 / 次要文字与底色的对比度低于阈值时给 warning（保留创作自由，不禁止）。 */
export function manifestContrastWarnings(manifest: ThemeManifestV1, minRatio = 3): string[] {
	const out: string[] = [];
	for (const mode of ["light", "dark"] as const) {
		const t = manifest.modes[mode] ?? {};
		const bg = t["--bg"];
		const pairs: [string, string, string][] = [
			["--fg", t["--fg"], "正文"],
			["--mut", t["--mut"], "次要文字"],
			["--mut2", t["--mut2"], "弱化文字"],
		];
		for (const [tok, val, label] of pairs) {
			if (!bg || !val) continue;
			const ratio = contrastRatio(bg, val);
			if (ratio != null && ratio < minRatio) out.push(`${mode} 模式的 ${label}（${tok}）与背景（--bg）对比度偏低（${ratio.toFixed(2)}:1），可能不易读`);
		}
	}
	return out;
}

/* ------------------------------------------------------------------ *
 * 图片素材：导出过滤
 * ------------------------------------------------------------------ */

/** 参考图（usage 缺省 / reference）不参与导出；只有用户显式选为 background / decor 的才算主题素材。 */
export function isThemeAsset(ref: ThemeImageRef): boolean {
	return ref.usage === "background" || ref.usage === "decor";
}

/** 导出用：剥掉「仅作参考」的图片，只保留用户显式选定的主题素材（默认不含任何图片）。 */
export function stripReferenceImages(manifest: ThemeManifestV1): ThemeManifestV1 {
	if (!manifest.images?.length) return manifest;
	const images = manifest.images.filter(isThemeAsset);
	const next: ThemeManifestV1 = { ...manifest };
	if (images.length) next.images = images;
	else delete next.images;
	return next;
}

/* ------------------------------------------------------------------ *
 * AI 草稿对话 DTO（后端 `theme_draft` 工具与前端面板共用的 contract）
 *
 * 说明：图片**只以附件 id + 元数据**出现；历史每轮也只带引用，不带 base64。
 * 「仅作参考」的图片只参与**用户显式发起的那一轮** AI 请求。
 * 若当前 agent 模型不支持视觉，后端必须如实返回 `visionUnsupported`，由 UI 提示用户
 * 换支持视觉的模型或仅用文字，**不得偷偷改走别的视觉服务 / 收费模型**。
 * ------------------------------------------------------------------ */

export interface ThemeDraftRequest {
	turnId: string;
	/** 用户这轮的文字要求。 */
	prompt: string;
	/** 用户这轮显式附带的参考图（只带引用）。 */
	images?: ThemeImageRef[];
	/** 「继续修改」时带上上一版合法 manifest。 */
	previousManifest?: ThemeManifestV1;
	/** 走哪个助理 / agent 的模型（后端按当前 agent 模型，不猜模型能力）。 */
	agentId?: string;
	/**
	 * 面板里显式选定的模型（可选）。
	 * 缺省 = 旧客户端语义：按 agentId 的当前助理模型（未设则默认模型）；
	 * 传了就必须是**已配置、真实存在**的聊天模型，服务端会校验；
	 * 无效 / 已删除 / 缺凭据一律明确报错，**不 fallback 到另一个收费模型**。
	 * 只作用于这一次草稿请求，**不改**助理主模型 / 模型池 / 全局默认。
	 */
	model?: ThemeModelRef;
}

/**
 * 主题设计这一轮实际使用的模型（provider + canonical id + 展示用短名）。
 */
export interface ThemeModelRef {
	/** 模型服务 id（canonical，和模型 id 一起唯一定位；同一 id 在不同渠道是两条）。 */
	provider: string;
	id: string;
	/** 展示用：服务短名（服务端 providerNames；前端只用它显示，不做选择依据）。 */
	providerName?: string;
	/** 展示用：模型友好名。 */
	name?: string;
}

export type ThemeDraftResult =
	| {
			ok: true;
			turnId: string;
			/** 这一轮**实际使用**的模型（服务端解析结果，供前端核对 label 与真实 payload 一致）。 */
			model: ThemeModelRef;
			/** AI 产出的合法 manifest（已通过 validateThemeManifest）。 */
			manifest: ThemeManifestV1;
			/** 解释性文字（对话里给用户看）。 */
			text: string;
			warnings: string[];
	  }
	| {
			ok: false;
			turnId: string;
			/** 结构化错误（manifest 校验失败 / 模型不支持视觉 / 其它）。 */
			errors: ThemeError[];
			/** 解析到的目标模型（失败时若已解析则带上，供 UI 显示真实来源；没解析到则为空）。 */
			model?: ThemeModelRef;
			/** 当前 agent 模型不支持视觉时为 true（UI 提示换模型或仅文字）。 */
			visionUnsupported?: boolean;
			text?: string;
			warnings: string[];
	  };
