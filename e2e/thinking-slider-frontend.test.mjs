/**
 * 思考强度离散滑块：纯逻辑 + 静态 DOM 夹具（node:test）。
 * 运行：node --import tsx --test e2e/thinking-slider-frontend.test.mjs
 *
 * 覆盖用户要求的分支：七档 / 单模型子集 / 多模型并集（不取交集吞 xhigh·max）/ 默认 /
 * 跟随 / 降级（不静默假装保留）/ 提交与不重复提交（保存失败不留假值的组件侧保证）/
 * 主会话·群聊·子代理同一组件 / 键盘·触控边界 / 390 与主题·减少动态效果标记。
 *
 * 不启动服务、不连模型、不碰真实数据：DOM 部分是 React 服务端静态渲染（无浏览器、
 * 无 jsdom），验证结构与 aria；观感 / 真机 / 真持久化仍需在测试槽跑 e2e/ui 脚本。
 *
 * 另含两块「修完 A / C」的定向断言：
 * - A：主题实时切换时 `--mo-style` 的订阅回读（假 DOM + 假 MutationObserver，验证「不重挂组件」）；
 * - C：保存思考强度的「最后一次为准」代次守卫（迟到失败 / 切助理 / 新成功）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsx 从 e2e 目录解析 tsconfig，JSX 走经典转换，需要 React 在作用域里（产品构建走 react-jsx，不受影响）
globalThis.React = React;
import { THINKING_LEVEL_ORDER, thinkingLevelsFor, thinkingLevelsUnion } from "@pi-assistant/shared";
import {
	THINKING_PREVIEW_MS,
	THINKING_STAR_COUNT,
	fitThinkingLevel,
	orderedThinkingLevels,
	shouldCommitThinking,
	sliderIndexForKey,
	sliderIndexFromX,
	thinkingSliderView,
	thinkingStars,
} from "../apps/web/src/thinking-slider.ts";
import { ThinkingSlider } from "../apps/web/src/components/ThinkingSlider.tsx";
import { readMoStyle, watchMoStyle } from "../apps/web/src/themes/motion-signals.ts";
import { LatestWrite } from "../apps/web/src/latest-write.ts";

const ALL = [...THINKING_LEVEL_ORDER];
const html = (props) => renderToStaticMarkup(createElement(ThinkingSlider, { onPick: () => {}, ...props }));
const count = (s, needle) => s.split(needle).length - 1;

test("七档：顺序与 Pi SDK 一致，非法/重复输入被规范化且不发明档位", () => {
	assert.deepEqual(ALL, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(orderedThinkingLevels(["max", "off", "bogus", "high", "off"]), ["off", "high", "max"]);
	assert.deepEqual(orderedThinkingLevels(null), []);
});

test("七档：星点密度递增、off 完全静态；预览时长 320–700ms 且 off 不播", () => {
	assert.equal(THINKING_STAR_COUNT.off, 0);
	const counts = ALL.map((l) => THINKING_STAR_COUNT[l]);
	assert.deepEqual(counts, [...counts].sort((a, b) => a - b), "星点数应随档位非递减");
	assert.equal(THINKING_STAR_COUNT.max, 16);
	assert.equal(THINKING_PREVIEW_MS.off, 0);
	for (const l of ALL.slice(1)) {
		assert.ok(THINKING_PREVIEW_MS[l] >= 320 && THINKING_PREVIEW_MS[l] <= 700, `${l} 预览时长应在 320–700ms`);
	}
	assert.deepEqual(thinkingStars("off", "s"), []);
	assert.equal(thinkingStars("medium", "s").length, 5);
	assert.equal(thinkingStars("max", "s").length, 16);
});

test("星点布局是确定性的：同档同种子完全一致，种子不同则不同，坐标有界", () => {
	const a = thinkingStars("high", "seed-x");
	const b = thinkingStars("high", "seed-x");
	assert.deepEqual(a, b);
	assert.notDeepEqual(thinkingStars("high", "seed-x"), thinkingStars("high", "seed-y"));
	for (const s of a) {
		assert.ok(Number.isFinite(s.x) && Math.abs(s.x) <= 16, "x 应在手柄半径内");
		assert.ok(Number.isFinite(s.y) && Math.abs(s.y) <= 16, "y 应在手柄半径内");
		assert.ok(s.size > 0 && s.opacity > 0 && s.opacity <= 1);
	}
});

test("单模型子集：档位来自该模型支持集合，滑块下标与降级都正确", () => {
	const sub = ["off", "low", "medium", "high"];
	const v = thinkingSliderView({ levels: sub, current: "medium" });
	assert.equal(v.kind, "slider");
	assert.deepEqual(v.levels, sub);
	assert.equal(v.index, 2);
	assert.equal(v.level, "medium");
	assert.equal(v.following, false);
	assert.equal(v.unsupportedPick, null);

	assert.equal(fitThinkingLevel(sub, "xhigh"), "high", "超出上限取不超过目标的最高档");
	assert.equal(fitThinkingLevel(sub, "minimal"), "off", "低于下限取最低支持档");
	assert.equal(fitThinkingLevel(["low", "high"], "off"), "low", "最低档也不支持时取最低支持档");
	assert.equal(fitThinkingLevel([], "high"), null);
});

test("多模型并集：候选池不取交集，xhigh / max 不因部分模型不支持被吞", () => {
	const all = [
		{ provider: "p", id: "a", thinking: ["off", "low", "medium", "high"] },
		{ provider: "p", id: "b", thinking: ["off", "medium", "high", "xhigh", "max"] },
	];
	const refs = [
		{ provider: "p", id: "a" },
		{ provider: "p", id: "b" },
	];
	assert.deepEqual(thinkingLevelsFor(all, refs), ["off", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(thinkingLevelsUnion([["off", "high"], ["xhigh"], ["max"]]), ["off", "high", "xhigh", "max"]);
	// 并集档位直接喂给滑块：7 档里除 minimal 外都可见
	const v = thinkingSliderView({ levels: thinkingLevelsFor(all, refs), current: "max" });
	assert.equal(v.kind, "slider");
	assert.equal(v.level, "max");
	assert.equal(v.index, v.levels.indexOf("max"));
});

test("默认：没有跟随语义时，缺省档位落在最低支持档（与现行为一致）", () => {
	const v = thinkingSliderView({ levels: ALL, current: null });
	assert.equal(v.following, false);
	assert.equal(v.index, 0);
	assert.equal(v.level, "off");
});

test("跟随：current=null + followLabel 才是跟随，不是第 8 档；显示实际生效档位", () => {
	const v = thinkingSliderView({ levels: ALL, current: null, followLabel: "跟随主会话", effective: "medium" });
	assert.equal(v.following, true);
	assert.equal(v.index, 3);
	assert.equal(v.level, "medium");
	assert.equal(v.effective, "medium");
	// 实际生效档位读不到时按最低支持档显示，不猜更高
	assert.equal(thinkingSliderView({ levels: ALL, current: null, followLabel: "跟随", effective: null }).index, 0);
	// 跟随到子集里不存在的档位：显示降级后的档位（medium 在 [off, low, high] 里 → 取不超目标的最高档 low）
	assert.equal(thinkingSliderView({ levels: ["off", "low", "high"], current: null, followLabel: "跟随", effective: "medium" }).level, "low");
	assert.equal(thinkingSliderView({ levels: ["off", "low", "high"], current: null, followLabel: "跟随", effective: "xhigh" }).level, "high");
});

test("降级：显式档位不被支持时记录原值并给出实际档位（不静默假装保留）", () => {
	const v = thinkingSliderView({ levels: ["off", "low", "medium", "high"], current: "xhigh" });
	assert.equal(v.unsupportedPick, "xhigh");
	assert.equal(v.effective, "high");
	assert.equal(v.level, "high");
	assert.equal(v.index, 3);
});

test("0 档 / 1 档：不画滑块，给出准确状态", () => {
	const none = thinkingSliderView({ levels: [], current: null, followLabel: "跟随" });
	assert.equal(none.kind, "unsupported");
	const one = thinkingSliderView({ levels: ["medium"], current: "medium" });
	assert.equal(one.kind, "fixed");
	assert.equal(one.level, "medium");
});

test("提交：值未变不写；跟随态下选档算变化；点「跟随」在已跟随时不重复提交", () => {
	assert.equal(shouldCommitThinking("high", { level: "medium", following: false, unsupportedPick: null }), true);
	assert.equal(shouldCommitThinking("medium", { level: "medium", following: false, unsupportedPick: null }), false);
	assert.equal(shouldCommitThinking(null, { level: "medium", following: false, unsupportedPick: null }), true);
	assert.equal(shouldCommitThinking(null, { level: "medium", following: true, unsupportedPick: null }), false);
	assert.equal(shouldCommitThinking("medium", { level: "medium", following: true, unsupportedPick: null }), true, "从跟随切到显式，即使数值相同也是变化");
	assert.equal(shouldCommitThinking("high", { level: "high", following: false, unsupportedPick: "xhigh" }), true, "待规范化时选降级目标也算显式选择");
});

test("键盘：方向键逐档、Home/End/PageUp/PageDown 到两端，其余按键不归滑块", () => {
	assert.equal(sliderIndexForKey("ArrowRight", 2, 4), 3);
	assert.equal(sliderIndexForKey("ArrowUp", 3, 4), 3, "已在末尾不越界");
	assert.equal(sliderIndexForKey("ArrowLeft", 0, 4), 0, "已在开头不越界");
	assert.equal(sliderIndexForKey("ArrowDown", 2, 4), 1);
	assert.equal(sliderIndexForKey("Home", 2, 4), 0);
	assert.equal(sliderIndexForKey("End", 1, 4), 3);
	assert.equal(sliderIndexForKey("PageUp", 0, 4), 3);
	assert.equal(sliderIndexForKey("PageDown", 3, 4), 0);
	assert.equal(sliderIndexForKey("Enter", 2, 4), null);
	assert.equal(sliderIndexForKey("ArrowRight", 0, 0), null);
});

test("触控 / 指针：轨道外收到两端、单档返回 0、零宽不产生 NaN", () => {
	assert.equal(sliderIndexFromX(0, 0, 100, 5), 0);
	assert.equal(sliderIndexFromX(100, 0, 100, 5), 4);
	assert.equal(sliderIndexFromX(9999, 0, 100, 5), 4, "右侧越界收敛到末档");
	assert.equal(sliderIndexFromX(-9999, 0, 100, 5), 0, "左侧越界收敛到首档");
	assert.equal(sliderIndexFromX(50, 0, 100, 5), 2, "中点四舍五入到中间档");
	assert.equal(sliderIndexFromX(50, 0, 0, 5), 0, "零宽不产生 NaN");
	assert.equal(sliderIndexFromX(50, 0, 100, 1), 0);
});

test("主会话 / 群聊 / 子代理同一组件：相同输入产生相同视图与相同静态结构", () => {
	const props = { levels: ALL, current: "high" };
	assert.deepEqual(thinkingSliderView(props), thinkingSliderView({ ...props }));
	assert.equal(html({ testid: "model-thinking", ...props }), html({ testid: "model-thinking", ...props }));
});

// ---------------------------------------------------------------- 静态 DOM 夹具
test("DOM：七档全量渲染 role=slider + aria，7 个刻度按钮、7 个标签", () => {
	const m = html({ testid: "thinking", levels: ALL, current: "medium" });
	assert.ok(m.includes('role="slider"'));
	assert.ok(m.includes('aria-valuemin="0"'));
	assert.ok(m.includes('aria-valuemax="6"'));
	assert.ok(m.includes('aria-valuenow="3"'));
	assert.ok(m.includes('aria-valuetext="思考强度：中"'));
	for (const l of ALL) assert.ok(m.includes(`data-testid="thinking-${l}"`), `有 ${l} 刻度`);
	assert.equal(count(m, "pa-think-step"), ALL.length);
	assert.equal(count(m, "pa-think-tick"), ALL.length);
	for (const label of ["关闭", "极简", "低", "中", "高", "超高", "最大"]) assert.ok(m.includes(`>${label}</span>`), `标签 ${label} 可读`);
	assert.ok(m.includes("pa-think-track") && m.includes("pa-think-handle") && m.includes("pa-think-labels"));
});

test("DOM：off 无星点、max 16 点；初始静止不播预览动画（无 pa-think-pulse）", () => {
	const off = html({ testid: "thinking", levels: ALL, current: "off" });
	assert.equal(count(off, "pa-think-star"), 0);
	assert.ok(off.includes('aria-valuenow="0"'));
	assert.ok(!off.includes("pa-think-pulse"));
	const max = html({ testid: "thinking", levels: ALL, current: "max" });
	assert.equal(count(max, "pa-think-star"), THINKING_STAR_COUNT.max);
	assert.equal(THINKING_STAR_COUNT.max, 16);
});

test("DOM：跟随显示 reset 动作与实际生效档位，不是第 8 档", () => {
	const m = html({ testid: "subagent-thinking", levels: ALL, current: null, followLabel: "跟随助理默认", effective: "medium" });
	assert.ok(m.includes('data-testid="subagent-thinking-follow"'));
	assert.ok(m.includes('aria-pressed="true"'));
	assert.ok(m.includes("跟随助理默认"));
	assert.ok(m.includes("当前实际：中"));
	assert.ok(m.includes('aria-valuenow="3"'), "滑杆停在跟随生效的档位");
});

test("DOM：降级提示有「按降级后的档运行」，且不静默假装保留", () => {
	const m = html({ testid: "agent-subagent-thinking", levels: ["off", "low", "medium", "high"], current: "xhigh" });
	assert.ok(m.includes("xhigh") || m.includes("超高"));
	assert.ok(m.includes("→"));
	assert.ok(m.includes("按「高」运行"));
	assert.ok(m.includes('aria-valuenow="3"'));
});

test("DOM：单档 / 无档不画滑块，给出准确说明", () => {
	const one = html({ testid: "thinking", levels: ["medium"], current: "medium" });
	assert.ok(!one.includes('role="slider"'));
	assert.ok(one.includes("只有一档") && one.includes("中"));
	const none = html({ testid: "thinking", levels: [], current: null, followLabel: "跟随主会话" });
	assert.ok(!none.includes('role="slider"'));
	assert.ok(none.includes("不支持调整思考强度"));
	assert.ok(none.includes('data-testid="thinking-follow"'), "无档时仍可回到跟随");
});

test("DOM：服务端静态渲染不写死颜色（颜色只在主题 CSS，组件不加内联色值）", () => {
	const m = html({ testid: "thinking", levels: ALL, current: "high" });
	assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(m.replace(/data-ln="1"/g, "")), "组件 markup 不含硬编码色值");
});

// ---------------------------------------------------------------- A：主题实时切换的 --mo-style 订阅
// 这组断言打在订阅原语上（假 DOM + 假 MutationObserver），验证「切主题 / DIY 预览 / 取消还原都不重挂组件」
// 与「订阅范围有界、卸载即断开」；组件挂载层的观感（切主题后 computed transition / animation 真的变）
// 仍需测试槽跑浏览器 e2e，本文件不声称已跑通它。

class FakeMutationObserver {
	static instances = [];
	constructor(cb) {
		this.cb = cb;
		this.targets = [];
		this.disposed = false;
		FakeMutationObserver.instances.push(this);
	}
	observe(target, options) {
		this.targets.push({ target, options });
	}
	disconnect() {
		this.disposed = true;
	}
	/** 模拟一批 DOM 变化（真实 MutationObserver 也是批量回调） */
	fire() {
		if (!this.disposed) this.cb([], this);
	}
}

/** 假 DOM 环境：只提供订阅原语用得到的 documentElement / head / 计算样式 / MutationObserver。 */
function moEnv(initial) {
	FakeMutationObserver.instances = [];
	const state = { value: initial };
	const env = {
		documentElement: { nodeType: 1, tag: "html" },
		head: { nodeType: 1, tag: "head" },
		getStyle: () => ({ getPropertyValue: (k) => (k === "--mo-style" ? state.value : "") }),
		MutationObserver: FakeMutationObserver,
	};
	return { state, el: { nodeType: 1, className: "pa-think" }, env, observers: FakeMutationObserver.instances };
}

test("A 读取 --mo-style：去空白、空值 → null", () => {
	const a = moEnv(" smooth ");
	assert.equal(readMoStyle(a.el, a.env), "smooth");
	assert.equal(readMoStyle(a.el, { ...a.env, getStyle: () => ({ getPropertyValue: () => "steps" }) }), "steps");
	assert.equal(readMoStyle(a.el, { ...a.env, getStyle: () => ({ getPropertyValue: () => "   " }) }), null);
	assert.equal(readMoStyle(a.el, { ...a.env, getStyle: null, documentElement: null }), null, "没有计算样式时安全返回 null，不抛错");
});

test("A 主题实时切换：smooth → steps → 取消还原都会回读，不用重挂组件", () => {
	const { state, el, env, observers } = moEnv("smooth");
	const changes = [];
	const stop = watchMoStyle(el, (v) => changes.push(v), env);
	assert.deepEqual(changes, ["smooth"], "订阅开始时先读一次（打开弹层即正确）");
	assert.equal(observers.length, 1);
	const mo = observers[0];
	// 订阅范围有界：只盯 <html> 的关键属性 + <head> 的样式表文本，不全页观察、不轮询
	assert.deepEqual(mo.targets.map((t) => t.target), [env.documentElement, env.head]);
	assert.deepEqual(mo.targets[0].options.attributeFilter, ["data-skin", "data-mode", "class", "style"]);
	assert.equal(mo.targets[1].options.childList, true);
	assert.equal(mo.targets[1].options.characterData, true);
	assert.ok(!mo.targets[1].options.attributes, "样式表变化走 childList / characterData，不看属性");
	// 切主题 / DIY 预览改了同一个 custom id 的 <style> 文本（data-skin 不变）：也必须回读
	state.value = "steps";
	mo.fire();
	assert.deepEqual(changes, ["smooth", "steps"]);
	// 值没变不重复回调（不造成无谓重渲染）
	mo.fire();
	assert.deepEqual(changes, ["smooth", "steps"]);
	// 预览取消 → 变量回到原主题（未声明）
	state.value = "";
	mo.fire();
	assert.deepEqual(changes, ["smooth", "steps", null]);
	// 关闭弹层 / 卸载：断开订阅，之后不再回读
	stop();
	assert.equal(mo.disposed, true);
	state.value = "steps";
	mo.fire();
	assert.deepEqual(changes, ["smooth", "steps", null], "断开后不再回调");
});

test("A 没有 MutationObserver（老环境 / 非浏览器）时只读一次且不抛错", () => {
	const { el, env } = moEnv("steps");
	const changes = [];
	const stop = watchMoStyle(el, (v) => changes.push(v), { ...env, MutationObserver: null });
	assert.deepEqual(changes, ["steps"], "降级为「挂载时读一次」，与修前行为一致，不抛错");
	assert.equal(typeof stop, "function");
	stop();
});

// ---------------------------------------------------------------- C：保存失败回滚的代次守卫
// 组件里的接线（乐观置值 → PUT → 失败时按守卫回滚到服务端确认值并回读）由上面的 A/C 覆盖 + 测试槽的
// 浏览器 e2e 复核；这里把「谁有权改界面」的判定单独钉死，防止再出现「旧失败抹掉新选择」。

test("C 乐观写入：迟到的失败(A) 不抹掉用户后一次选择(B)", () => {
	const w = new LatestWrite("medium"); // 进入页面时读到的服务端值
	const a = w.begin(); // 用户选 A（界面乐观置 A）
	const b = w.begin(); // 用户很快又选 B（界面乐观置 B）
	assert.equal(w.fail(a).rollback, false, "A 已不是最新一次：不回滚，不覆盖 B");
	assert.deepEqual(w.fail(b), { rollback: true, value: "medium" }, "B 是最新一次：仍按服务端真值回滚");
});

test("C 最新一次失败：回滚到服务端确认过的值，不用未确认的乐观值", () => {
	const w = new LatestWrite();
	assert.deepEqual(w.fail(w.begin()), { rollback: true, value: null }, "还没读到服务端值时不假装有值");
	const first = w.begin();
	assert.equal(w.confirm(first, "medium"), true);
	const id = w.begin(); // 乐观改成 high
	assert.deepEqual(w.fail(id), { rollback: true, value: "medium" });
});

test("C 乱序成功：旧请求的迟到成功不改确认值、也不盖新失败的回滚", () => {
	const w = new LatestWrite("medium");
	const a = w.begin();
	const b = w.begin();
	assert.deepEqual(w.fail(b), { rollback: true, value: "medium" });
	assert.equal(w.confirm(a, "high"), false, "A 的迟到成功被代次挡住");
	assert.deepEqual(w.fail(b), { rollback: true, value: "medium" }, "确认值没被旧成功改成 high");
});

test("C 新成功：确认值跟上最新一次，之后失败回滚到它（保服务端真值）", () => {
	const w = new LatestWrite("medium");
	const a = w.begin();
	w.confirm(a, "high");
	const b = w.begin();
	w.confirm(b, "off");
	assert.equal(w.isCurrent(b), true);
	assert.deepEqual(w.fail(w.begin()), { rollback: true, value: "off" });
});

test("C 卸载 / 切到别的助理：invalidate 后在飞响应不落地", () => {
	const w = new LatestWrite("medium");
	const id = w.begin();
	w.invalidate();
	assert.equal(w.isCurrent(id), false);
	assert.equal(w.fail(id).rollback, false, "卸载后迟到的失败不改界面");
	assert.equal(w.confirm(id, "max"), false, "卸载后迟到的成功不写确认值");
	assert.equal(w.isCurrent(w.begin()), true, "重新挂载 / 新一次写入照常工作");
});
