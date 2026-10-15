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
/** 默认主题：暗夜。首次安装 / 清空存储 / 无效 id 都落到它。 */
export const DEFAULT_THEME = "noir";

/**
 * 已移除的内置主题 id → 迁移目标。只用于解析**注册表里没有**的旧 id，
 * 所以用户自己通过 registerTheme() 注册成同名 id 的主题不会被误并。
 */
export const REMOVED_SKINS: Record<string, string> = { linear: "noir" };

const registry = new Map(THEMES.map((t) => [t.id, t]));
/** 预留：运行时注册额外主题（例如以后从插件/技能加载） */
export function registerTheme(def: ThemeDef) {
	if (!registry.has(def.id)) THEMES.push(def);
	registry.set(def.id, def);
}
export function getTheme(id: string | null | undefined): ThemeDef {
	const key = id ?? "";
	const direct = registry.get(key);
	if (direct) return direct;
	const migrated = REMOVED_SKINS[key];
	return (migrated && registry.get(migrated)) || registry.get(DEFAULT_THEME)!;
}

/** 把任意历史 / 非法 skin 值解析成当前有效的主题 id（例如已移除的 `linear` → `noir`）。 */
export function normalizeSkin(id: string | null | undefined): string {
	return getTheme(id).id;
}
