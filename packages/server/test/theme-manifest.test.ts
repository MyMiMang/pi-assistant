/**
 * 外观主题引擎 / 库存 / 预览事务回归（DIY typed manifest v1）。
 *
 * 纯 fixture：不碰真实 localStorage / 用户配置 / 凭据 / 网络 / 桌面；DOM 动作全部走假 effects。
 * 覆盖：schema fail-closed（未知 token、注入字符、图片元数据、必需 token）、manifest→CSS（作用域 + 无 url/import）、
 * 库存 CRUD（stable id / createdAt、内置保护、导入撞 id 换新、导出剥参考图）、预览事务（继续改 / 上一版 / 应用 / 取消恢复）。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	isThemeAsset,
	stripReferenceImages,
	validateThemeManifest,
	type ThemeManifestV1,
} from "../../../packages/shared/src/theme-manifest.ts";
import { CUSTOM_THEMES_KEY, deleteCustomTheme, exportCustomTheme, importCustomTheme, installCustomThemes, loadCustomThemes, newThemeId, saveCustomTheme, unregisterPreviewTheme } from "../../../apps/web/src/themes/custom-store.ts";
import { getTheme, registerTheme } from "../../../apps/web/src/themes/registry.ts";
import { completeTokens, customSkinId, manifestToCss, motionTokens, themeDefFromManifest } from "../../../apps/web/src/themes/manifest.ts";
import { cancelPreview, commitPreview, revisePreview, startPreview, undoPreview, type AppearanceSnapshot, type PreviewEffects } from "../../../apps/web/src/themes/preview.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const LIGHT = {
	"--bg": "#fffdf8",
	"--side": "#f6f1e6",
	"--panel": "#f6f1e6",
	"--card": "#ffffff",
	"--fg": "#2a251f",
	"--mut": "#5f564b",
	"--mut2": "#9a8f80",
	"--line": "#e4dccd",
	"--line-strong": "#cfc4b1",
	"--hover": "#ebe4d6",
	"--active": "#e6dccb",
	"--user-bg": "#ece4d4",
	"--user-fg": "#2a251f",
	"--acc": "#8fd3c1",
	"--acc-fg": "#123",
	"--acc-soft": "rgba(143,211,193,.12)",
	"--ok": "#5f8a5a",
	"--warn": "#c08a2c",
	"--z-light": "#ffffff",
	"--z-dark": "#2a251f",
};
const DARK = { ...LIGHT, "--bg": "#141218", "--fg": "#f3eee6", "--z-light": "#f3eee6", "--z-dark": "#141218", "--acc": "#c3b6f0" };

function sample(over: Partial<ThemeManifestV1> = {}): ThemeManifestV1 {
	return {
		manifestVersion: 1,
		id: "11111111-2222-3333-4444-555555555555",
		name: "我的奶油紫",
		modes: { light: { ...LIGHT }, dark: { ...DARK } },
		createdAt: "2026-10-22T00:00:00.000Z",
		updatedAt: "2026-10-22T00:00:00.000Z",
		...over,
	};
}

function fakeStorage(init: Record<string, string> = {}) {
	const map = new Map(Object.entries(init));
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		dump: () => Object.fromEntries(map),
	};
}

/* ---------------------------- schema ---------------------------- */

test("schema：合法 manifest 通过，派生 ThemeDef 可用", () => {
	const r = validateThemeManifest(sample());
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.manifest.name, "我的奶油紫");
	const def = themeDefFromManifest(r.manifest);
	assert.equal(def.id, customSkinId("11111111-2222-3333-4444-555555555555"));
	assert.equal(def.name, "我的奶油紫");
	assert.ok(def.accent.light.startsWith("#"));
});

test("schema fail-closed：缺必需颜色 token / 未知 token / 注入字符一律拒绝", () => {
	const missing = sample();
	delete (missing.modes.light as Record<string, string>)["--bg"];
	const r1 = validateThemeManifest(missing);
	assert.equal(r1.ok, false);
	if (!r1.ok) assert.ok(r1.errors.some((e) => e.path === "modes.light.--bg" && e.code === "required"));

	const unknown = sample();
	(unknown.modes.light as Record<string, string>)["--evil"] = "red";
	const r2 = validateThemeManifest(unknown);
	assert.equal(r2.ok, false);
	if (!r2.ok) assert.ok(r2.errors.some((e) => e.code === "unknown_token"));

	for (const bad of ["url(https://evil/x.png)", "red;background:url(x)", "red}body{display:none", "#fff\\;", "rgb(1,2,3);@import 'x'"]) {
		const m = sample();
		(m.modes.light as Record<string, string>)["--bg"] = bad;
		const r = validateThemeManifest(m);
		assert.equal(r.ok, false, `应拒绝注入值：${bad}`);
	}
});

test("schema：id 不能是路径、name 限长、版本必须为 1", () => {
	for (const badId of ["../etc/passwd", "a/b", "a.b", "", "x".repeat(65)]) {
		const r = validateThemeManifest(sample({ id: badId }));
		assert.equal(r.ok, false, `应拒绝 id：${badId}`);
	}
	assert.equal(validateThemeManifest(sample({ name: "x".repeat(25) })).ok, false);
	assert.equal(validateThemeManifest({ ...sample(), manifestVersion: 2 }).ok, false);
});

test("schema：图片只接受附件引用 + 元数据，非图片 MIME / 路径 id / 超限一律拒绝", () => {
	const okRef = { attachmentId: "att_abc123", mime: "image/png", width: 800, height: 600, bytes: 102400, usage: "reference" as const, alt: "参考图" };
	const r = validateThemeManifest(sample({ images: [okRef] }));
	assert.equal(r.ok, true);
	if (r.ok) assert.equal(r.manifest.images?.[0].attachmentId, "att_abc123");

	assert.equal(validateThemeManifest(sample({ images: [{ ...okRef, mime: "text/html" }] })).ok, false);
	assert.equal(validateThemeManifest(sample({ images: [{ ...okRef, attachmentId: "../../secret" }] })).ok, false);
	assert.equal(validateThemeManifest(sample({ images: [{ ...okRef, bytes: 999 * 1024 * 1024 }] })).ok, false);
	assert.equal(validateThemeManifest(sample({ images: [okRef, okRef] })).ok, false, "重复附件应拒绝");
	// base64 / dataURL 不是合法字段：不会被保留（引擎只取白名单字段，不落 base64）
	const withBase64 = validateThemeManifest(sample({ images: [{ attachmentId: "a1", mime: "image/png", base64: "AAAA" } as never] }));
	assert.equal(withBase64.ok, true);
	if (withBase64.ok) assert.equal("base64" in (withBase64.manifest.images?.[0] ?? {}), false, "base64 字段应被丢弃");
});

test("导出：默认剥掉「仅作参考」的图片，只留用户显式选定的素材", () => {
	const ref = { attachmentId: "ref1", mime: "image/png", usage: "reference" as const };
	const asset = { attachmentId: "bg1", mime: "image/png", usage: "background" as const };
	const m = sample({ images: [ref, asset] });
	assert.equal(isThemeAsset(ref), false);
	assert.equal(isThemeAsset(asset), true);
	const stripped = stripReferenceImages(m);
	assert.deepEqual(stripped.images?.map((i) => i.attachmentId), ["bg1"]);
	// 全参考图 → 导出不含任何图片
	const onlyRef = stripReferenceImages(sample({ images: [ref] }));
	assert.equal(onlyRef.images, undefined);
});

/* ---------------------------- engine ---------------------------- */

test("engine：manifestToCss 作用域化，含双模式变量，无 url / @import / 全局 body 规则", () => {
	const css = manifestToCss(sample({ decor: { texture: "dots", corner: "step2", background: "glow" } }));
	assert.match(css, /\[data-skin="custom-11111111-2222-3333-4444-555555555555"\]\{/);
	assert.match(css, /\[data-skin="custom-[^"]+"\]\[data-mode="dark"\]\{/);
	assert.ok(!/url\s*\(/.test(css), "不得出现 url()");
	assert.ok(!/@import/.test(css), "不得出现 @import");
	assert.ok(!/(^|\})\s*(body|html|\*)\s*\{/.test(css), "不得写全局 / body 规则");
	assert.match(css, /--bg:#fffdf8/);
});

test("engine：可选 token 补默认，必需 token 取 manifest 值", () => {
	const toks = completeTokens(sample(), "dark");
	assert.equal(toks["--bg"], "#141218");
	assert.equal(toks["--r"], "16px"); // 未提供 → 内置默认
	assert.ok(toks["--shadow"] && toks["--glow"]);
	assert.equal(completeTokens(sample({ modes: { light: { ...LIGHT, "--r": "6px" }, dark: { ...DARK } } }), "light")["--r"], "6px");
});

/* ---------------------------- store ---------------------------- */

test("store：保存 / 读取 / 删除；编辑保留 createdAt 只改 updatedAt；内置不可覆盖", () => {
	const st = fakeStorage();
	const first = saveCustomTheme(sample(), st);
	assert.equal(first.ok, true);
	assert.equal(loadCustomThemes(st).length, 1);

	// 编辑：同一 id 再存，createdAt 不变、updatedAt 变
	const edited = saveCustomTheme({ ...sample({ name: "改名了" }), updatedAt: "2030-01-01T00:00:00.000Z" }, st);
	assert.equal(edited.ok, true);
	if (edited.ok) {
		assert.equal(edited.manifest.createdAt, "2026-10-22T00:00:00.000Z", "createdAt 应保持稳定");
		assert.notEqual(edited.manifest.updatedAt, "2026-10-22T00:00:00.000Z", "updatedAt 应刷新");
		assert.equal(edited.manifest.name, "改名了");
	}
	assert.equal(loadCustomThemes(st).length, 1, "同 id 编辑不应新增");

	// 内置 id 保护
	const builtin = saveCustomTheme(sample({ id: "noir" }), st);
	assert.equal(builtin.ok, false);

	// 删除
	assert.equal(deleteCustomTheme("noir", st), false, "内置不可删");
	assert.equal(deleteCustomTheme("11111111-2222-3333-4444-555555555555", st), true);
	assert.equal(loadCustomThemes(st).length, 0);
});

test("store：取消预览时已保存的 DIY 主题保留注册（编辑后取消不回退默认），未保存的临时预览才移除", () => {
	const st = fakeStorage();
	const m = sample({ id: "saved-preview-1" });
	assert.equal(saveCustomTheme(m, st).ok, true);
	installCustomThemes(st);
	const skin = customSkinId(m.id);
	assert.equal(getTheme(skin).id, skin, "已保存主题应先注册");
	// 编辑已有主题再取消：注册必须保留，否则 applyTheme 会回退默认主题
	unregisterPreviewTheme(skin, st);
	assert.equal(getTheme(skin).id, skin, "已保存主题取消预览后仍应在注册表");
	// 未保存的临时预览：取消后移除，回退默认
	registerTheme(themeDefFromManifest(sample({ id: "never-saved-1" })));
	const temp = customSkinId("never-saved-1");
	assert.equal(getTheme(temp).id, temp);
	unregisterPreviewTheme(temp, st);
	assert.equal(getTheme(temp).id, "noir", "未保存预览应回退默认主题");
});

test("store：坏数据（手改 localStorage）不炸、被丢弃", () => {
	const st = fakeStorage({ [CUSTOM_THEMES_KEY]: "{ not json" });
	assert.deepEqual(loadCustomThemes(st), []);
	const st2 = fakeStorage({ [CUSTOM_THEMES_KEY]: JSON.stringify([{ id: "x" }, sample()]) });
	assert.equal(loadCustomThemes(st2).length, 1, "只保留合法条目");
});

test("store：导入撞 id 分配新 id（不覆盖已有）；导出默认剥参考图", () => {
	const st = fakeStorage();
	saveCustomTheme(sample(), st);
	const res = importCustomTheme(JSON.stringify(sample({ name: "导入的同 id" })), st);
	assert.equal(res.ok, true);
	if (res.ok) {
		assert.equal(res.renamed, true);
		assert.notEqual(res.manifest.id, "11111111-2222-3333-4444-555555555555");
	}
	assert.equal(loadCustomThemes(st).length, 2);

	const bad = importCustomTheme("{ 不是 json", st);
	assert.equal(bad.ok, false);

	const ref = { attachmentId: "ref1", mime: "image/png", usage: "reference" as const };
	const asset = { attachmentId: "bg1", mime: "image/png", usage: "background" as const };
	const exported = exportCustomTheme(sample({ images: [ref, asset] }));
	const parsed = JSON.parse(exported) as ThemeManifestV1;
	assert.deepEqual(parsed.images?.map((i) => i.attachmentId), ["bg1"], "导出不应带仅作参考的图");
	assert.ok(!exported.includes("data:image"), "导出不含 base64");
	assert.equal(newThemeId().length > 0, true);
});

/* ---------------------------- preview transaction ---------------------------- */

function fakeEffects() {
	const calls: string[] = [];
	const css: (string | null)[] = [];
	const applied: AppearanceSnapshot[] = [];
	const saved: ThemeManifestV1[] = [];
	const effects: PreviewEffects = {
		applyAppearance: (s) => {
			calls.push(`apply:${s.skin}:${s.accent}`);
			applied.push(s);
		},
		registerTheme: (d) => calls.push(`register:${d.id}`),
		unregisterTheme: (s) => calls.push(`unregister:${s}`),
		setPreviewCss: (c) => {
			calls.push(`css:${c ? "set" : "clear"}`);
			css.push(c);
		},
		saveTheme: (m) => {
			calls.push(`save:${m.id}`);
			saved.push(m);
		},
	};
	return { effects, calls, css, applied, saved };
}

const SNAP: AppearanceSnapshot = { theme: "system", skin: "noir", accent: "#8b7bff" };

test("preview：开始预览只改 DOM，不动已保存 skin；应用并保存落库后正式切换", () => {
	const { effects, calls, saved, applied } = fakeEffects();
	const s0 = startPreview(sample(), SNAP, effects);
	assert.equal(s0.saved, false);
	assert.ok(calls.includes(`apply:${customSkinId(sample().id)}:`), "预览应清掉 accent 应用草稿 skin");
	assert.equal(saved.length, 0, "预览阶段不应落库");

	const s1 = commitPreview(s0, effects);
	assert.equal(saved.length, 1, "应用并保存应落库一次");
	assert.equal(s1.saved, true);
	assert.equal(applied.at(-1)?.skin, customSkinId(sample().id));
	assert.equal(applied.at(-1)?.accent, SNAP.accent, "保存后应恢复用户 accent");
	assert.equal(calls.at(-1), "apply:custom-11111111-2222-3333-4444-555555555555:#8b7bff");
});

test("preview：取消完整恢复外观（skin/theme/accent）并移除未保存的注册", () => {
	const { effects, calls, applied } = fakeEffects();
	const s0 = startPreview(sample(), SNAP, effects);
	cancelPreview(s0, effects);
	const last = applied.at(-1);
	assert.deepEqual(last, SNAP, "取消应恢复到进入预览前的快照");
	assert.ok(calls.some((c) => c.startsWith("unregister:custom-")), "未保存草稿应移除注册");
	assert.equal(calls.at(-1), "apply:noir:#8b7bff");
});

test("preview：继续提意见 / 上一版 走历史栈；撤销回上一版", () => {
	const { effects, applied } = fakeEffects();
	const v1 = sample({ name: "v1" });
	const v2 = sample({ name: "v2" });
	const s0 = startPreview(v1, SNAP, effects);
	const s1 = revisePreview(s0, v2, effects);
	assert.equal(s1.current.name, "v2");
	assert.equal(s1.history.length, 1);
	assert.equal(s1.history[0].name, "v1");
	const s2 = undoPreview(s1, effects);
	assert.equal(s2.current.name, "v1", "上一版应回到 v1");
	assert.equal(s2.history.length, 0);
	assert.equal(applied.at(-1)?.skin, customSkinId(v1.id));
	// 已在第一版时撤销是 no-op
	assert.equal(undoPreview(s2, effects), s2);
});

/* ---------------------------- 动效（v1 增量） ---------------------------- */

test("schema：motion 合法值通过；越界时长 / 非法缓动 / 越界倍率 / 未知字段 fail-closed", () => {
	const ok = validateThemeManifest(sample({ motion: { duration: ".24s", durationSlow: "400ms", easeOut: "standard", easeExpand: "cubic-bezier(.22,1,.36,1)", scale: 1.2, glow: "subtle", style: "steps" } }));
	assert.equal(ok.ok, true, JSON.stringify(ok));
	if (ok.ok) assert.equal(ok.manifest.motion?.duration, ".24s");

	const bad = [
		{ motion: { duration: "10ms" }, why: "时长过短" },
		{ motion: { duration: "5s" }, why: "时长过长" },
		{ motion: { duration: "fast" }, why: "不是时长" },
		{ motion: { easeOut: "steps(4)" }, why: "steps 不允许" },
		{ motion: { easeOut: "cubic-bezier(2,0,.5,1)" }, why: "x 超 1" },
		{ motion: { easeOut: "url(evil)" }, why: "注入" },
		{ motion: { scale: 3 }, why: "倍率超范围" },
		{ motion: { glow: "max" }, why: "光晕枚举非法" },
		{ motion: { style: "spring" }, why: "风格枚举非法" },
		{ motion: { duration: ".2s", evil: "x" }, why: "未知字段" },
	];
	for (const { motion, why } of bad) {
		const r = validateThemeManifest(sample({ motion: motion as never }));
		assert.equal(r.ok, false, `应拒绝：${why}`);
	}
});

test("engine：motionTokens 枚举 → 内置 CSS；manifestToCss 输出 --pa-* / --mo-* 并自带 reduced-motion 覆盖", () => {
	const m = sample({ motion: { duration: ".3s", easeOut: "emphasized", scale: 1.5, glow: "strong", style: "steps" } });
	const toks = motionTokens(m);
	assert.equal(toks["--pa-dur"], ".3s");
	assert.equal(toks["--pa-dur-fast"], ".12s", "未给 → 内置默认");
	assert.equal(toks["--pa-ease-out"], "cubic-bezier(.22,1,.36,1)", "枚举名映射到内置 bezier");
	assert.equal(toks["--mo-scale"], "1.5");
	assert.equal(toks["--mo-glow"], "1.6");
	assert.equal(toks["--mo-style"], "steps");
	assert.equal(toks["--mo-ease"], toks["--pa-ease-out"], "--mo-ease 与通用缓出一致");
	const css = manifestToCss(m);
	assert.match(css, /--pa-dur:\.3s/);
	assert.match(css, /--mo-scale:1\.5/);
	assert.match(css, /--mo-style:steps/);
	assert.match(css, /prefers-reduced-motion:\s*reduce/);
	assert.match(css, /--pa-dur:0s/);
	assert.match(css, /--mo-scale:0/);
	assert.ok(!/url\s*\(/.test(css) && !/@import/.test(css));
});

test("engine：自定义 --acc / --r / --font 真正落到 [data-skin=custom-*] 输出（不是靠样式继承）", () => {
	const m = sample({
		modes: {
			light: { ...LIGHT, "--acc": "#123456", "--r": "7px" },
			dark: { ...DARK, "--acc": "#654321", "--r": "7px" },
		},
	});
	m.modes.light["--font"] = '"Songti SC",serif';
	const css = manifestToCss(m);
	assert.match(css, /--acc:#123456/);
	assert.match(css, /--r:7px/);
	assert.match(css, /--font:"Songti SC",serif/);
});

test("兼容：旧 v1 主题（无 motion）仍合法且补默认；带 motion 保存 / 读取往返不丢（刷新恢复）", () => {
	const legacy = sample();
	const r = validateThemeManifest(legacy);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.manifest.motion, undefined, "旧主题不应被硬塞 motion");
	assert.equal(motionTokens(r.manifest)["--pa-dur"], ".18s", "旧主题在引擎层补默认，不丢 / 不覆盖");

	const withMotion = sample({ motion: { duration: ".42s", easeSpring: "spring-soft", glow: "none" } });
	const st = fakeStorage();
	assert.equal(saveCustomTheme(withMotion, st).ok, true);
	const loaded = loadCustomThemes(st);
	assert.equal(loaded.length, 1);
	assert.deepEqual(loaded[0].motion, { duration: ".42s", easeSpring: "spring-soft", glow: "none" }, "动效设置应持久化并原样恢复");
});

/* ---------------------------- 无虚入口 ---------------------------- */

test("入口：没有 /主题设计 slash 命令，只有设置→外观的主入口", () => {
	const settings = readFileSync(join(ROOT, "apps/web/src/components/Settings.tsx"), "utf8");
	assert.ok(!settings.includes("/主题设计"), "Settings 不应残留 /主题设计 入口");
	// 全前端源码里不得出现 /主题设计 命令注册（引号形式）；文档可以把它写成「已取消」。
	const srcDir = join(ROOT, "apps/web/src");
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
	for (const f of walk(srcDir)) {
		if (!/\.(ts|tsx)$/.test(f)) continue;
		assert.ok(!readFileSync(f, "utf8").includes('\"/主题设计\"'), `${f} 不应注册 /主题设计 命令`);
	}
	const doc = readFileSync(join(ROOT, "docs/design/appearance-themes.md"), "utf8");
	assert.ok(/取消/.test(doc) && doc.includes("/主题设计"), "文档应写明 /主题设计 已取消，而不是写成入口");
});
