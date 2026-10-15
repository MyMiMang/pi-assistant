/**
 * 外观 AI 创作的**前端纯逻辑**夹具（node:test，不启服务、不碰 DOM / 真实数据）。
 * 运行：node --import tsx --test e2e/theme-ai-frontend.test.mjs
 *
 * 覆盖组件用到的纯逻辑：请求轮次管理（取消 / 迟到响应丢弃）、保存同一 id 更新 vs 另存新 id、
 * 参考图默认不导出。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DraftTurns } from "../apps/web/src/themes/design-session.ts";
import { newThemeId, saveCustomTheme, exportCustomTheme, loadCustomThemes } from "../apps/web/src/themes/custom-store.ts";
import { customSkinId } from "../apps/web/src/themes/manifest.ts";
import { stripReferenceImages } from "@pi-assistant/shared";

function fakeStorage() {
	const map = new Map();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
	};
}

const tokens = (bg, fg, acc) => ({
	"--bg": bg,
	"--side": bg,
	"--panel": bg,
	"--card": bg,
	"--fg": fg,
	"--mut": fg,
	"--mut2": fg,
	"--line": bg,
	"--line-strong": bg,
	"--hover": bg,
	"--active": bg,
	"--user-bg": bg,
	"--user-fg": fg,
	"--acc": acc,
	"--acc-fg": bg,
	"--acc-soft": "rgba(0,0,0,.1)",
	"--ok": "#0a0",
	"--warn": "#a00",
	"--z-light": "#ffffff",
	"--z-dark": "#000000",
});
const manifest = (over = {}) => ({
	manifestVersion: 1,
	id: "11111111-2222-3333-4444-555555555555",
	name: "奶油紫",
	modes: { light: tokens("#f7f3ea", "#2a251f", "#8fd3c1"), dark: tokens("#141218", "#f3eee6", "#c3b6f0") },
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	...over,
});

test("DraftTurns：发新一轮会取消上一轮，晚到的旧轮次不再是最新（不应用）", () => {
	const turns = new DraftTurns();
	const a = turns.begin();
	assert.equal(turns.isCurrent(a.turnId), true);
	assert.equal(a.signal.aborted, false);
	const b = turns.begin();
	assert.equal(a.signal.aborted, true, "发新一轮必须真 abort 上一轮模型请求");
	assert.equal(turns.isCurrent(a.turnId), false, "旧轮次的响应应被丢弃");
	assert.equal(turns.isCurrent(b.turnId), true);
	// 旧轮次结束不能把最新轮次的状态清掉
	assert.equal(turns.finish(a.turnId), false);
	assert.equal(turns.isCurrent(b.turnId), true);
	assert.equal(turns.finish(b.turnId), true);
	assert.equal(turns.isCurrent(b.turnId), false);
});

test("DraftTurns：关闭面板 cancel() 真 abort，之后到达的响应一律丢弃", () => {
	const turns = new DraftTurns();
	const a = turns.begin();
	turns.cancel();
	assert.equal(a.signal.aborted, true);
	assert.equal(turns.isCurrent(a.turnId), false);
	// 再 cancel 幂等
	turns.cancel();
});

test("保存同一 id = 更新同一套主题（AI 继续修改），另存为新主题才换 id", () => {
	const storage = fakeStorage();
	const first = saveCustomTheme(manifest(), storage);
	assert.equal(first.ok, true);
	const sameId = saveCustomTheme(manifest({ name: "奶油紫 v2", updatedAt: "2026-02-02T00:00:00.000Z" }), storage);
	assert.equal(sameId.ok, true);
	assert.equal(sameId.manifest.id, "11111111-2222-3333-4444-555555555555");
	assert.equal(sameId.manifest.createdAt, "2026-01-01T00:00:00.000Z", "编辑保存保留 createdAt");
	assert.equal(loadCustomThemes(storage).length, 1, "同一 id 只应有一条");

	const newId = newThemeId();
	assert.notEqual(newId, "11111111-2222-3333-4444-555555555555");
	assert.match(newId, /^[A-Za-z0-9_-]+$/, "新 id 必须是安全 id（不含路径字符）");
	const asNew = saveCustomTheme(manifest({ id: newId, name: "副本" }), storage);
	assert.equal(asNew.ok, true);
	assert.equal(loadCustomThemes(storage).length, 2, "另存为新主题应新增一条");
	assert.notEqual(customSkinId(newId), customSkinId("11111111-2222-3333-4444-555555555555"));
});

test("参考图默认不导出：只有显式标为 background / decor 的素材才保留", () => {
	const withRef = manifest({
		images: [
			{ attachmentId: "att_ref", mime: "image/png", usage: "reference" },
			{ attachmentId: "att_bg", mime: "image/png", usage: "background" },
		],
	});
	const stripped = stripReferenceImages(withRef);
	assert.equal(stripped.images?.length, 1);
	assert.equal(stripped.images?.[0].attachmentId, "att_bg");
	const json = exportCustomTheme(withRef);
	assert.equal(json.includes("att_ref"), false, "导出的 JSON 不应带参考图");
	assert.equal(json.includes("att_bg"), true);
	// 没有任何素材图时，导出完全不含 images
	assert.equal(exportCustomTheme(manifest()).includes("images"), false);
});
