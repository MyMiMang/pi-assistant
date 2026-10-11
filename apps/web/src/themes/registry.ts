/**
 * 主题注册表。每个主题 = 一份 CSS（themes/<id>.css，用 [data-skin=<id>] 限定，定义设计 token 与组件微调）+ 这里的一条元数据。
 * 新增主题：放一个 CSS 文件、在 themes/index.css 里 @import、在 THEMES 里加一条即可，组件代码不用改。
 * 设计 token（CSS 变量）约定见 docs/DESIGN.md §5.18：--bg --side --panel --card --fg --mut --mut2 --line --line-strong --hover
 * --active --user-bg --user-fg --acc --acc-fg --acc-soft --ok --warn --shadow --comp-shadow --btn-shadow --font --display --mono
 * --r --r-sm --r-bubble --r-tail --r-comp --r-btn --r-chip --r-send --r-av --r-logo，以及 Tailwind 灰阶锚点 --z-light / --z-dark。
 */
export type Mode = "light" | "dark";
export interface ThemePreview {
	bg: string;
	side: string;
	card: string;
	fg: string;
	mut: string;
	line: string;
	acc: string;
	user: string;
}
export interface ThemeDef {
	id: string;
	name: string;
	tagline: string;
	/** 默认强调色（浅色/深色），也是“主题默认”选项 */
	accent: Record<Mode, string>;
	/** 设置页可选强调色 */
	accents: string[];
	/** 浏览器地址栏颜色 */
	chrome: Record<Mode, string>;
	/** 没有用户选择时的默认明暗（例：暗夜默认深色） */
	defaultMode?: Mode;
}

export const THEMES: ThemeDef[] = [
	{
		id: "linear",
		name: "极简专业",
		tagline: "黑白灰 + 单一强调色，信息密度高，克制专业",
		accent: { light: "#3d5afe", dark: "#5b7cff" },
		accents: ["#3d5afe", "#0a0a0a", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"],
		chrome: { light: "#ffffff", dark: "#0a0a0a" },
	},
	{
		id: "glass",
		name: "毛玻璃",
		tagline: "半透明磨砂层叠、柔和光晕、圆润大圆角",
		accent: { light: "#0a84ff", dark: "#409cff" },
		accents: ["#0a84ff", "#5e5ce6", "#30d158", "#ff9f0a", "#ff375f", "#bf5af2"],
		chrome: { light: "#eef1f8", dark: "#0b0d1a" },
	},
	{
		id: "warm",
		name: "暖色人文",
		tagline: "米色纸感、衬线标题、赤陶强调色，像一本好读的杂志",
		accent: { light: "#b5532c", dark: "#e0895b" },
		accents: ["#b5532c", "#4f6b5a", "#3f4a68", "#c08a2c", "#8a4f7d", "#2a251f"],
		chrome: { light: "#f7f3ea", dark: "#1c1915" },
	},
	{
		id: "noir",
		name: "暗夜",
		tagline: "深黑底、霓虹紫青渐变、流光与辉光动效",
		accent: { light: "#6a57ff", dark: "#8b7bff" },
		accents: ["#8b7bff", "#4fe3c1", "#ff7ab6", "#5b9dff", "#ffb547", "#f4f4f5"],
		chrome: { light: "#f4f4f6", dark: "#09090b" },
		defaultMode: "dark",
	},
];
export const DEFAULT_THEME = "linear";

const registry = new Map(THEMES.map((t) => [t.id, t]));
/** 预留：运行时注册额外主题（例如以后从插件/技能加载） */
export function registerTheme(def: ThemeDef) {
	if (!registry.has(def.id)) THEMES.push(def);
	registry.set(def.id, def);
}
export function getTheme(id: string | null | undefined): ThemeDef {
	return registry.get(id ?? "") ?? registry.get(DEFAULT_THEME)!;
}
