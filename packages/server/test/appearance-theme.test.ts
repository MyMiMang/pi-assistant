/**
 * 外观主题回归：默认主题改为「暗夜」、移除内置「极简（linear）」、旧存储值迁移、首屏预置脚本与注册表一致。
 *
 * 纯 fixture：只读源码与静态文件 + 跑纯函数迁移逻辑，不起服务、不读真实 localStorage / 配置 / 凭据。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { migrateAppearance } from "../../../apps/web/src/appearance-migration.ts";
import { DEFAULT_THEME, getTheme, normalizeSkin, REMOVED_SKINS, THEMES } from "../../../apps/web/src/themes/registry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const THEME_DIR = join(ROOT, "apps/web/src/themes");
const read = (p: string) => readFileSync(p, "utf8");

/** 内存版 localStorage 子集，给纯迁移函数用。 */
function fakeStorage(init: Record<string, string> = {}) {
	const map = new Map(Object.entries(init));
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		dump: () => Object.fromEntries(map),
	};
}

test("默认主题是暗夜，且内置极简（linear）已移除", () => {
	assert.equal(DEFAULT_THEME, "noir");
	assert.equal(THEMES.length, 4);
	assert.deepEqual(
		THEMES.map((t) => t.id),
		["noir", "glass", "warm", "pixel"],
	);
	assert.equal(existsSync(join(THEME_DIR, "linear.css")), false, "linear.css 应已删除");
	assert.equal(read(join(THEME_DIR, "index.css")).includes("linear.css"), false, "index.css 不应再 @import linear");
	assert.equal(/data-skin=linear\b/.test(read(join(THEME_DIR, "app.css"))), false, "app.css 不应残留 linear 专属规则");
});

test("注册表：显式选择的其他主题不受影响，未知/已移除 id 落到暗夜", () => {
	// 用户显式选过的主题原样保留（“不动其他 selected”）
	for (const id of ["glass", "warm", "pixel", "noir"]) assert.equal(getTheme(id).id, id);
	// 已移除的旧默认 id → 暗夜
	assert.equal(getTheme("linear").id, "noir");
	assert.equal(normalizeSkin("linear"), "noir");
	// 空 / 无效值 → 暗夜（避免解析不出 token 白屏）
	assert.equal(getTheme(null).id, "noir");
	assert.equal(getTheme("").id, "noir");
	assert.equal(getTheme("不存在").id, "noir");
	assert.deepEqual(REMOVED_SKINS, { linear: "noir" });
});

test("每个主题元数据完整、id 唯一（含浅/深强调色与地址栏颜色）", () => {
	const ids = THEMES.map((t) => t.id);
	assert.equal(new Set(ids).size, ids.length, "主题 id 必须唯一");
	for (const t of THEMES) {
		assert.ok(t.name && t.tagline, `${t.id} 缺名称/简介`);
		for (const m of ["light", "dark"] as const) {
			assert.match(t.accent[m], /^#[0-9a-f]{6}$/i, `${t.id} ${m} 强调色`);
			assert.match(t.chrome[m], /^#[0-9a-f]{6}$/i, `${t.id} ${m} 地址栏颜色`);
		}
		assert.ok(t.accents.length > 0, `${t.id} 缺可选强调色`);
	}
});

test("外观值迁移：极简 → 暗夜，其他主题与空值不动，旧默认强调色被清掉", () => {
	const removedAccent = migrateAppearance(fakeStorage({ "pia.accent": "#6366f1", "pia.skin": "linear" }));
	assert.deepEqual(removedAccent, { accentRemoved: true, skinMigrated: "noir" });

	for (const id of ["glass", "warm", "pixel", "noir"]) {
		const s = fakeStorage({ "pia.skin": id, "pia.accent": "#0a84ff" });
		assert.deepEqual(migrateAppearance(s), { accentRemoved: false, skinMigrated: null });
		assert.equal(s.getItem("pia.skin"), id, `${id} 不应被迁移改动`);
		assert.equal(s.getItem("pia.accent"), "#0a84ff", `${id} 自选强调色不应被清`);
	}

	// 首次安装 / 无存储：什么都不写，交给注册表默认值
	const empty = fakeStorage();
	assert.deepEqual(migrateAppearance(empty), { accentRemoved: false, skinMigrated: null });
	assert.deepEqual(empty.dump(), {});
});

test("首屏预置脚本 theme-boot.js 与注册表保持一致（防止两边漂移）", () => {
	const boot = read(join(ROOT, "apps/web/public/theme-boot.js"));
	const m = boot.match(/var DATA = (\{[\s\S]*?\});/);
	assert.ok(m, "theme-boot.js 里应有单行 DATA 常量");
	const data = JSON.parse(m![1]) as {
		default: string;
		legacy: Record<string, string>;
		themes: Record<string, { mode?: string; light: string; dark: string }>;
	};
	assert.equal(data.default, DEFAULT_THEME);
	assert.deepEqual(data.legacy, REMOVED_SKINS);
	assert.deepEqual(Object.keys(data.themes).sort(), THEMES.map((t) => t.id).sort());
	for (const t of THEMES) {
		const b = data.themes[t.id];
		assert.equal(b.light, t.chrome.light, `${t.id} 浅色地址栏`);
		assert.equal(b.dark, t.chrome.dark, `${t.id} 深色地址栏`);
		assert.equal(b.mode, t.defaultMode, `${t.id} 默认明暗`);
	}
});

test("首屏预置脚本真正跑起来的结果：默认暗夜、旧值迁移、其他选择保留（直接执行 theme-boot.js）", () => {
	const boot = read(join(ROOT, "apps/web/public/theme-boot.js"));
	const run = (store: Record<string, string>, prefersDark: boolean) => {
		const map = new Map(Object.entries(store));
		const dataset: Record<string, string> = {};
		const classes = new Set<string>();
		const meta = { content: "" };
		const window = {
			localStorage: { getItem: (k: string) => map.get(k) ?? null },
			matchMedia: () => ({ matches: prefersDark }),
		};
		const document = {
			documentElement: { dataset, classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } },
			querySelector: (sel: string) => (sel === 'meta[name="theme-color"]' ? { setAttribute: (_n: string, v: string) => void (meta.content = v) } : null),
		};
		new Function("window", "document", boot)(window, document);
		return { skin: dataset.skin, mode: dataset.mode, dark: classes.has("dark"), chrome: meta.content };
	};

	// 首次安装：无存储 → 暗夜 + 深色（无白闪），地址栏跟暗夜深色
	assert.deepEqual(run({}, true), { skin: "noir", mode: "dark", dark: true, chrome: "#09090b" });
	// 无存储但系统是浅色：暗夜默认深色优先（defaultMode）
	assert.deepEqual(run({}, false), { skin: "noir", mode: "dark", dark: true, chrome: "#09090b" });
	// 旧值 linear → 首屏就是暗夜（不再先闪一下无 token 的极简）
	assert.deepEqual(run({ "pia.skin": "linear" }, false), { skin: "noir", mode: "dark", dark: true, chrome: "#09090b" });
	// 无效 skin → 暗夜
	assert.deepEqual(run({ "pia.skin": "不存在" }, false), { skin: "noir", mode: "dark", dark: true, chrome: "#09090b" });
	// 显式选过暖色 + 浅色：保留
	assert.deepEqual(run({ "pia.skin": "warm", "pia.theme": "light" }, true), { skin: "warm", mode: "light", dark: false, chrome: "#f7f3ea" });
	// 跟随系统：深色
	assert.deepEqual(run({ "pia.skin": "glass", "pia.theme": "system" }, true), { skin: "glass", mode: "dark", dark: true, chrome: "#0b0d1a" });
});

test("首屏不闪白：index.html 默认 theme-color 跟随默认主题深色、并阻塞加载 theme-boot.js；SW 预缓存它", () => {
	const html = read(join(ROOT, "apps/web/index.html"));
	const noir = getTheme(DEFAULT_THEME);
	assert.ok(html.includes(`<meta name="theme-color" content="${noir.chrome.dark}" />`), "theme-color 默认应为暗夜深色");
	assert.ok(/<script src="\/theme-boot\.js"><\/script>/.test(html), "index.html 应在打包前同步加载 theme-boot.js");
	assert.ok(read(join(ROOT, "apps/web/public/sw.js")).includes('"/theme-boot.js"'), "SW 应预缓存 theme-boot.js");
});

test("像素风：浅深双版 token 齐全、装饰纯 CSS（无远程资源 / url / 像素字体下载），正文仍是系统字体", () => {
	const css = read(join(THEME_DIR, "pixel.css"));
	assert.ok(read(join(THEME_DIR, "index.css")).includes("pixel.css"), "index.css 应 @import pixel.css");
	const block = (mode: string) => {
		const m = css.match(new RegExp(`\\[data-skin=pixel\\]\\[data-mode=${mode}\\]\\{([^}]*)\\}`));
		assert.ok(m, `pixel.css 缺 ${mode} 模式块`);
		return m![1];
	};
	const light = block("light");
	const dark = block("dark");
	for (const tok of ["--bg", "--fg", "--card", "--line", "--acc", "--acc-soft"]) {
		assert.ok(light.includes(`${tok}:`), `浅色缺 ${tok}`);
		assert.ok(dark.includes(`${tok}:`), `深色缺 ${tok}`);
	}
	assert.match(light, /--bg:#fbf7ef/i, "浅色应是奶油底");
	assert.ok(!/url\s*\(/.test(css), "像素风不得引入 url() / 远程资源");
	assert.ok(!/@import/.test(css), "像素风不得 @import");
	assert.match(css, /\[data-skin=pixel\]\{[^}]*--font:-apple-system/, "正文应保留系统字体（不做全像素字体）");
	assert.equal(getTheme("pixel").name, "像素风");
});
