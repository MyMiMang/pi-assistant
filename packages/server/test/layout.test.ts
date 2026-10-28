/**
 * 布局纯逻辑单测：文件预览侧栏的停靠判定与宽度计算（设计见 docs/design/file-preview-side-panel.md）。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_MIN, PREVIEW, SIDE, clampPreview, resolveLayout, type LayoutPrefs } from "../../../apps/web/src/layout.ts";

const prefs = (p: Partial<LayoutPrefs> = {}): LayoutPrefs => ({ sideW: SIDE.def, paneW: 340, previewW: PREVIEW.def, sideCollapsed: false, info: false, ...p });

test("宽窗口：预览侧栏停靠，宽度 = 偏好宽度", () => {
	const L = resolveLayout(1920, prefs());
	assert.equal(L.previewDocked, true);
	assert.equal(L.previewW, PREVIEW.def);
});

test("偏好宽度太大时：让出 CHAT_MIN 给聊天区", () => {
	const L = resolveLayout(1440, prefs({ previewW: PREVIEW.max }));
	assert.equal(L.previewW, 1440 - SIDE.def - CHAT_MIN);
	assert.equal(1440 - SIDE.def - L.previewW, CHAT_MIN);
});

test("窄窗口 / 手机：不停靠（保持全屏弹窗），宽度为 0", () => {
	for (const w of [390, 768, 1024, 1100]) {
		const L = resolveLayout(w, prefs());
		assert.equal(L.previewDocked, false, `width ${w}`);
		assert.equal(L.previewW, 0);
	}
});

test("边界：左栏常驻时 width = 左栏 + CHAT_MIN + PREVIEW.min 刚好停靠，少 1px 不停靠", () => {
	const edge = SIDE.def + CHAT_MIN + PREVIEW.min;
	assert.equal(resolveLayout(edge, prefs()).previewDocked, true);
	assert.equal(resolveLayout(edge, prefs()).previewW, PREVIEW.min);
	assert.equal(resolveLayout(edge - 1, prefs()).previewDocked, false);
});

test("边界：左栏收起（不占宽）时更窄的窗口也能停靠", () => {
	const edge = CHAT_MIN + PREVIEW.min;
	assert.equal(resolveLayout(edge, prefs({ sideCollapsed: true })).previewDocked, true);
	assert.equal(resolveLayout(edge - 1, prefs({ sideCollapsed: true })).previewDocked, false);
	// 同样宽度、左栏常驻（宽度够做左栏）则放不下
	assert.equal(resolveLayout(1100, prefs()).previewDocked, false);
});

test("信息面板宽度不影响预览停靠（侧栏打开时信息面板让位）", () => {
	assert.equal(resolveLayout(1440, prefs({ paneW: 560 })).previewW, PREVIEW.def);
});

test("clampPreview 夹在 [min, max]", () => {
	assert.equal(clampPreview(10), PREVIEW.min);
	assert.equal(clampPreview(99999), PREVIEW.max);
	assert.equal(clampPreview(600.4), 600);
});
