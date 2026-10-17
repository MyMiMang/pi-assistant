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
import { createEscLayers } from "../apps/web/src/esc-layer.ts";

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

// ---------------------------------------------------------------- Esc 归属（叠加层顺序）
// 只钉「谁有权处理这一下 Esc」的判定（纯逻辑）；真实浏览器里的捕获顺序 / 焦点仍需测试槽用 Chrome 复核，
// 本文件不声称跑过 DOM。
test("Esc 归属：后打开的层（悬停说明气泡）先处理，菜单不会被顺手关掉", () => {
	const layers = createEscLayers();
	const menu = { consume: () => consumed.push("menu") };
	const tip = { consume: () => consumed.push("tip") };
	const consumed = [];
	const offMenu = layers.push(menu);
	assert.equal(layers.isTop(menu), true, "只有菜单时由菜单处理");
	// 气泡在菜单里悬停打开 → 压在栈顶
	const offTip = layers.push(tip);
	assert.equal(layers.isTop(menu), false, "气泡打开后菜单不再是顶层（这一下 Esc 不归它）");
	assert.equal(layers.isTop(tip), true, "气泡先关");
	// 气泡自己关掉（正常路径：它的处理函数只关气泡），下一层才轮到菜单
	offTip();
	assert.equal(layers.isTop(menu), true, "气泡关掉后菜单回到顶层");
	assert.equal(layers.size(), 1);
	offMenu();
	assert.equal(layers.size(), 0, "关掉菜单后不残留层");
});
