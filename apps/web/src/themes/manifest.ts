/**
 * 主题引擎：把一份已校验的 ThemeManifestV1 变成可用的 CSS 规则与 ThemeDef。
 *
 * 设计取舍（v1 冻结）：manifest 必须提供完整必需颜色 token（fail-closed），可选 token / 装饰由这里补
 * 内置中性默认。**不做 token 继承**（`basedOn` 仅作来源标注），避免「内置主题 token 在 CSS 里、引擎读不到」
 * 造成静默缺变量白屏。装饰只走 enum → 内置纯 CSS（渐变），不引入 url() / SVG / 远程资源。
 */
import { OPTIONAL_FONT_TOKENS, OPTIONAL_SIZE_TOKENS, REQUIRED_COLOR_TOKENS, type ThemeDecor, type ThemeManifestV1 } from "@pi-assistant/shared";
import type { Mode, ThemeDef } from "./registry.ts";

/** 自定义主题在 DOM / 注册表里的 skin id 前缀（与 manifest.id 一一对应，避免撞内置 id）。 */
export const CUSTOM_SKIN_PREFIX = "custom-";
export function customSkinId(manifestId: string): string {
	return `${CUSTOM_SKIN_PREFIX}${manifestId}`;
}
export function manifestIdFromSkin(skin: string): string | null {
	return skin.startsWith(CUSTOM_SKIN_PREFIX) ? skin.slice(CUSTOM_SKIN_PREFIX.length) : null;
}

const DEFAULT_SIZE: Record<string, string> = {
	"--r": "16px",
	"--r-sm": "11px",
	"--r-bubble": "16px",
	"--r-tail": "5px",
	"--r-comp": "20px",
	"--r-btn": "11px",
	"--r-chip": "11px",
	"--r-logo": "9px",
	"--r-av": "12px",
};
const DEFAULT_FONT: Record<string, string> = {
	"--font": '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif',
	"--display": '"SF Pro Display",-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif',
	"--mono": '"SF Mono","JetBrains Mono",ui-monospace,Menlo,monospace',
};
const SHADOW: Record<Mode, Record<string, string>> = {
	light: {
		soft: "0 1px 2px rgba(0,0,0,.05),0 10px 30px rgba(20,20,40,.06)",
		elevated: "0 20px 50px rgba(20,20,60,.12)",
		none: "none",
	},
	dark: {
		soft: "0 1px 0 rgba(255,255,255,.04) inset,0 12px 32px rgba(0,0,0,.5)",
		elevated: "0 0 0 1px rgba(255,255,255,.08),0 20px 60px rgba(0,0,0,.7)",
		none: "none",
	},
};

/** 合并可选 token 默认值，产出一份「每个必需 / 可选 token 都有值」的完整 token 表。 */
export function completeTokens(manifest: ThemeManifestV1, mode: Mode): Record<string, string> {
	const src = manifest.modes[mode] ?? {};
	const out: Record<string, string> = {};
	for (const t of REQUIRED_COLOR_TOKENS) if (src[t]) out[t] = src[t];
	for (const t of OPTIONAL_SIZE_TOKENS) out[t] = src[t] ?? DEFAULT_SIZE[t];
	for (const t of OPTIONAL_FONT_TOKENS) out[t] = src[t] ?? DEFAULT_FONT[t];
	out["--acc2"] = src["--acc2"] ?? src["--acc"] ?? "#8b7bff";
	out["--live"] = src["--live"] ?? src["--ok"] ?? "#4fe3c1";
	out["--label-ls"] = ".16em";
	out["--side-w"] = "256px";
	out["--pane-w"] = "312px";
	const decor: ThemeDecor = manifest.decor ?? {};
	const shadow = SHADOW[mode][decor.shadow ?? "soft"] ?? SHADOW[mode].soft;
	out["--shadow"] = shadow;
	out["--comp-shadow"] = shadow === "none" ? "none" : mode === "dark" ? "0 20px 60px rgba(0,0,0,.55)" : "0 16px 44px rgba(20,20,60,.10)";
	out["--btn-shadow"] = `0 6px 18px color-mix(in srgb, ${out["--acc"]} 35%, transparent)`;
	out["--glow"] = `color-mix(in srgb, ${out["--acc"]} 45%, transparent)`;
	out["--desk"] = decor.background === "glow" ? `radial-gradient(circle at 30% 20%, color-mix(in srgb, ${out["--acc"]} 32%, ${out["--bg"]}), ${out["--bg"]} 72%)` : out["--bg"];
	return out;
}

/** 装饰纹理：纯 CSS 渐变（无 url / SVG / 远程资源），只作用于 app 背景层。 */
function textureLayer(decor: ThemeDecor | undefined): string {
	if (decor?.texture === "dots") return "radial-gradient(currentColor 1px, transparent 1.4px)";
	if (decor?.texture === "grid") return "linear-gradient(currentColor 1px, transparent 1px),linear-gradient(90deg,currentColor 1px,transparent 1px)";
	return "";
}

function clipPathFor(corner: DecorCorner): string {
	// 8bit 阶梯边角（step2 = 4px 台阶，step4 = 8px 台阶），只用在装饰元素上，避免裁掉文字。
	if (corner === "step2") return "polygon(4px 0,calc(100% - 4px) 0,100% 4px,100% calc(100% - 4px),calc(100% - 4px) 100%,4px 100%,0 calc(100% - 4px),0 4px)";
	if (corner === "step4") return "polygon(8px 0,calc(100% - 8px) 0,100% 8px,100% calc(100% - 8px),calc(100% - 8px) 100%,8px 100%,0 calc(100% - 8px),0 8px)";
	return "";
}
type DecorCorner = NonNullable<ThemeDecor["corner"]>;

function decls(tokens: Record<string, string>): string {
	return Object.entries(tokens)
		.map(([k, v]) => `${k}:${v}`)
		.join(";");
}

/**
 * 生成自定义主题的 CSS 规则。skin id 用 `custom-<manifest.id>`；调用方负责注入到 `<style>`。
 * 只产出 `[data-skin="…"]` 作用域的变量与少量装饰规则，不写全局 / body 规则。
 */
export function manifestToCss(manifest: ThemeManifestV1): string {
	const skin = customSkinId(manifest.id);
	const sel = `[data-skin="${skin}"]`;
	const decor = manifest.decor;
	const base = decls(completeTokens(manifest, "light"));
	const light = decls(completeTokens(manifest, "light"));
	const dark = decls(completeTokens(manifest, "dark"));
	const rules: string[] = [`${sel}{${base}}`, `${sel}[data-mode="light"]{${light}}`, `${sel}[data-mode="dark"]{${dark}}`];
	const tex = textureLayer(decor);
	if (tex) {
		const size = decor?.texture === "dots" ? "12px 12px" : "16px 16px";
		rules.push(`${sel} .pa-app{background-image:${tex};background-size:${size};background-color:var(--bg)}`);
	}
	const clip = decor?.corner ? clipPathFor(decor.corner) : "";
	if (clip) rules.push(`${sel} .pa-send,${sel} .pa-badge,${sel} .pa-av,${sel} .pa-logo{clip-path:${clip}}`);
	return rules.join("\n");
}

/** 从 manifest 派生注册表元数据（供 getTheme / ThemePreview / applyTheme 使用）。 */
export function themeDefFromManifest(manifest: ThemeManifestV1): ThemeDef {
	const l = manifest.modes.light;
	const d = manifest.modes.dark;
	const accents = Array.from(new Set([l["--acc"], d["--acc"], l["--acc2"], d["--acc2"], l["--ok"], d["--ok"]].filter((x): x is string => !!x && /^#[0-9a-f]{6}$/i.test(x))));
	const tagline = manifest.author ? `由 ${manifest.author} 创作` : manifest.basedOn ? `基于 ${manifest.basedOn}` : "自定义主题";
	return {
		id: customSkinId(manifest.id),
		name: manifest.name,
		tagline,
		accent: { light: l["--acc"] ?? "#6a57ff", dark: d["--acc"] ?? "#8b7bff" },
		accents,
		chrome: { light: l["--bg"] ?? "#f4f4f6", dark: d["--bg"] ?? "#09090b" },
	};
}
