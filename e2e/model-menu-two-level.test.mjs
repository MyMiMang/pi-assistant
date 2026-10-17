/**
 * 模型弹层两层状态（纯函数，node:test；不启动浏览器 / 不构建 / 不连模型）。
 *
 * 合同：默认打开紧凑层（强度 + 模型名 + Fast + 滑块），点模型名进完整目录；
 * 返回只退一层、不改模型 / 思考 / Fast（这里只断言层级状态，值由调用方负责不动）；
 * 选完模型回紧凑层；Esc 在目录里退一层、在紧凑层才关闭；非聊天入口保持直接打开目录。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickerPanelNext } from "../apps/web/src/modelMenu.ts";

const initial = { open: false, layer: "list", focusModel: false };
const compactOpen = { open: true, layer: "compact", focusModel: false };

test("初次打开：聊天入口先紧凑层，不直接铺模型目录", () => {
	const n = pickerPanelNext(initial, "open", true);
	assert.deepEqual(n, { open: true, layer: "compact", focusModel: false });
});

test("点模型名 → 完整目录；返回 → 回紧凑层并把焦点放回模型名", () => {
	const list = pickerPanelNext(compactOpen, "openList", true);
	assert.deepEqual(list, { open: true, layer: "list", focusModel: false });
	const back = pickerPanelNext(list, "back", true);
	assert.deepEqual(back, { open: true, layer: "compact", focusModel: true });
});

test("选完模型：回到紧凑层（展示新模型），不关闭", () => {
	const list = pickerPanelNext(compactOpen, "openList", true);
	assert.deepEqual(pickerPanelNext(list, "pick", true), { open: true, layer: "compact", focusModel: true });
});

test("Esc：目录里只退一层，紧凑层再按才关闭；关闭后状态复位", () => {
	const list = pickerPanelNext(compactOpen, "openList", true);
	const back = pickerPanelNext(list, "escape", true);
	assert.deepEqual(back, { open: true, layer: "compact", focusModel: true });
	assert.deepEqual(pickerPanelNext(back, "escape", true), { open: false, layer: "compact", focusModel: false });
});

test("管理型入口（不做 compact）保持原来的直接目录 / 选中即关", () => {
	assert.deepEqual(pickerPanelNext(initial, "open", false), { open: true, layer: "list", focusModel: false });
	const list = { open: true, layer: "list", focusModel: false };
	assert.deepEqual(pickerPanelNext(list, "pick", false), { open: false, layer: "list", focusModel: false });
	assert.deepEqual(pickerPanelNext(list, "back", false), { open: true, layer: "list", focusModel: false });
});
