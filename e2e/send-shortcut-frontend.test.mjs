/**
 * 发送快捷键偏好 + 输入法（IME）防误发的纯逻辑测试（node:test，不启动服务、不碰 DOM / 真实数据）。
 * 运行：node --import tsx --test e2e/send-shortcut-frontend.test.mjs
 *
 * 覆盖用户列的十条里的逻辑部分：
 *   ① 组合中回车不发 ② keyCode 229 不发 ③ Safari compositionend → 确认回车不发、下一次真回车要发
 *   ④ 鼠标选字（没有回车事件）之后下一次真回车不被长期吞 ⑤ 两种偏好各自的发送 / 换行组合
 *   ⑥ 按住不放只发一次 ⑦ 切会话 / 卸载 reset 掉组合状态 ⑧ 弹窗 / @ 候选已处理的不抢
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CHAT_SETTINGS_KEY,
	DEFAULT_SEND_SHORTCUT,
	IME_CONFIRM_WINDOW_MS,
	SEND_SHORTCUT_KEY,
	SEND_SHORTCUT_OPTIONS,
	createCompositionGuard,
	decideComposerKey,
	getSendShortcut,
	loadSendShortcut,
	normalizeSendShortcut,
	saveSendShortcut,
	sendHint,
	sendKeyshortcuts,
	setSendShortcut,
	subscribeSendShortcut,
} from "../apps/web/src/composer.ts";

/** 回车（默认不带修饰键、不是组合、没被别人处理） */
const enter = (over = {}) => ({ key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 13, defaultPrevented: false, timeStamp: 1000, ...over });
const decide = (e, shortcut = "enter", guard = createCompositionGuard(() => 0)) => decideComposerKey(e, shortcut, guard);

test("偏好：缺省（含旧版本没这个设置）是 Enter 发送；显式的 Shift+Enter 原样保留", () => {
	assert.equal(DEFAULT_SEND_SHORTCUT, "enter");
	assert.equal(normalizeSendShortcut(null), "enter");
	assert.equal(normalizeSendShortcut(undefined), "enter");
	assert.equal(normalizeSendShortcut(""), "enter");
	assert.equal(normalizeSendShortcut("shift+enter"), "enter", "旧写法不是合法值，不猜");
	assert.equal(normalizeSendShortcut("shift-enter"), "shift-enter");
	assert.equal(normalizeSendShortcut("enter"), "enter");
});

test("偏好：读写用的是同一个 key，存过一次就读得回来（刷新保持）", () => {
	const fake = (() => {
		const m = new Map();
		return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), map: m };
	})();
	assert.equal(SEND_SHORTCUT_KEY, "pia.chat.sendShortcut");
	assert.equal(loadSendShortcut(fake), "enter", "没存过 → 默认");
	saveSendShortcut("shift-enter", fake);
	assert.equal(fake.map.get(SEND_SHORTCUT_KEY), "shift-enter");
	assert.equal(loadSendShortcut(fake), "shift-enter", "显式选过的不被默认值覆盖");
	saveSendShortcut("enter", fake);
	assert.equal(loadSendShortcut(fake), "enter");
});

test("偏好：读 / 写不因存储异常而崩（隐私模式）", () => {
	const boom = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
	assert.equal(loadSendShortcut(boom), "enter");
	assert.doesNotThrow(() => saveSendShortcut("shift-enter", boom));
});

test("偏好：内存状态可订阅 —— 三个输入栏读同一份，改一次全部同步", () => {
	const before = getSendShortcut();
	let hits = 0;
	const off = subscribeSendShortcut(() => hits++);
	setSendShortcut("shift-enter");
	assert.equal(getSendShortcut(), "shift-enter");
	assert.equal(hits, 1);
	setSendShortcut("shift-enter");
	assert.equal(hits, 1, "同一个值不重复通知");
	setSendShortcut(before);
	assert.equal(hits, 2);
	off();
	setSendShortcut("shift-enter");
	assert.equal(hits, 2, "退订后不再通知");
	setSendShortcut(before);
});

test("提示文案：设置项 / 按钮 title / 输入栏提示一处定义，跟着偏好变", () => {
	assert.equal(sendHint("enter"), "Enter 发送，Shift+Enter 换行");
	assert.equal(sendHint("shift-enter"), "Shift+Enter 发送，Enter 换行");
	assert.equal(sendKeyshortcuts("enter"), "Enter");
	assert.equal(sendKeyshortcuts("shift-enter"), "Shift+Enter");
	assert.deepEqual(
		SEND_SHORTCUT_OPTIONS.map((o) => [o.value, o.label]),
		[
			["enter", sendHint("enter")],
			["shift-enter", sendHint("shift-enter")],
		],
	);
	assert.equal(CHAT_SETTINGS_KEY, "chat", "设置页 key 冻结成 chat");
});

test("① 组合中的回车不发（React isComposing / guard.composing）", () => {
	assert.equal(decide(enter({ isComposing: true })), "native");
	const g = createCompositionGuard();
	g.compositionStart();
	assert.equal(g.composing(), true);
	assert.equal(decide(enter(), "enter", g), "native");
});

test("② keyCode 229（WebKit 在 compositionend 之后只剩 229）不发", () => {
	assert.equal(decide(enter({ keyCode: 229 })), "native");
});

test("③ WebKit 次序：compositionend → 确认回车不发，紧接着的下一次真回车要发", () => {
	const g = createCompositionGuard(() => 5000);
	g.compositionStart();
	g.compositionEnd(1000); // keydown 之前先结束（Safari / WKWebView）
	// 这次回车就是「确认选字」：不发送（也不 preventDefault，交给浏览器）
	assert.equal(decide(enter({ timeStamp: 1000 }), "enter", g), "native");
	// 只吞这一次：确认之后马上再按一次回车（keyup 已过）必须正常发送
	assert.equal(decide(enter({ timeStamp: 1002 }), "enter", g), "send");
});

test("③b compositionend 与确认回车同刻 / 微小时序差都算确认", () => {
	const g = createCompositionGuard();
	g.compositionEnd(1000);
	assert.equal(decide(enter({ timeStamp: 1000 - 2 }), "enter", g), "native", "compositionend 晚于 keydown timeStamp 也算同一次");
	const g2 = createCompositionGuard();
	g2.compositionEnd(1000);
	assert.equal(decide(enter({ timeStamp: 1000 + IME_CONFIRM_WINDOW_MS }), "enter", g2), "native");
});

test("③c Chrome / Firefox 次序：组合中的回车（keyCode 229）已经 ack，compositionend 不再粘下一次回车", () => {
	const g = createCompositionGuard();
	g.compositionStart();
	assert.equal(decide(enter({ isComposing: true, keyCode: 229 }), "enter", g), "native");
	g.compositionEnd(1000); // 就在这次回车之后触发
	// 用户确认完选字，马上再按一次回车发送 —— 不能被吞
	assert.equal(decide(enter({ timeStamp: 1001 }), "enter", g), "send");
});

test("③d 组合中的非回车键（方向键 / 229）不会解除 WebKit 兜底", () => {
	const g = createCompositionGuard();
	g.compositionStart();
	assert.equal(decide(enter({ key: "ArrowDown", isComposing: true, keyCode: 229 }), "enter", g), "native");
	assert.equal(decide(enter({ key: "Backspace", isComposing: true, keyCode: 229 }), "enter", g), "native");
	g.compositionEnd(1000);
	assert.equal(decide(enter({ timeStamp: 1001 }), "enter", g), "native", "方向键不算确认，WebKit 的 compositionend → 回车仍然要挡");
});

test("④ 鼠标选字（没有回车事件）：只有窗口内那一次被挡，之后立刻恢复，不长期吞", () => {
	const g = createCompositionGuard(() => 0);
	g.compositionStart();
	g.compositionEnd(1000); // 用鼠标点候选：没有 keydown，只结束组合
	assert.equal(decide(enter({ timeStamp: 1000 + IME_CONFIRM_WINDOW_MS - 1 }), "enter", g), "native", "窗口内的一次仍是确认键");
	assert.equal(decide(enter({ timeStamp: 1000 + IME_CONFIRM_WINDOW_MS + 5 }), "enter", g), "send", "窗口外直接发送");
	const g2 = createCompositionGuard(() => 0);
	g2.compositionEnd(1000);
	assert.equal(decide(enter({ timeStamp: 5000 }), "enter", g2), "send", "组合结束很久之后不再吞任何回车");
});

test("④b 时间比较不跨时钟：两边都有 timeStamp 才用事件钟，否则退回本地钟", () => {
	// 事件钟相差 5ms → 确认键；本地钟故意离事件钟很远，证明没用它
	const g = createCompositionGuard(() => 999_999);
	g.compositionEnd(1000);
	assert.equal(decide(enter({ timeStamp: 1005 }), "enter", g), "native");
	// 事件钟相差 5 秒（本地钟 0 差）→ 按事件钟判：过期，要发送
	const g2 = createCompositionGuard(() => 999_999);
	g2.compositionEnd(1000);
	assert.equal(decide(enter({ timeStamp: 6000 }), "enter", g2), "send");
	// compositionend 没给 timeStamp → 两边都退回本地钟
	let now = 1000;
	const g3 = createCompositionGuard(() => now);
	g3.compositionEnd(undefined);
	now = 1100;
	assert.equal(decide(enter({ timeStamp: 0 }), "enter", g3), "native");
	let now2 = 1000;
	const g4 = createCompositionGuard(() => now2);
	g4.compositionEnd(undefined);
	now2 = 1500;
	assert.equal(decide(enter({ timeStamp: 0 }), "enter", g4), "send");
	// keydown 没给 timeStamp（事件钟缺一半）→ 也用本地钟
	const g5 = createCompositionGuard(() => 1000);
	g5.compositionEnd(5);
	assert.equal(decide(enter({ timeStamp: 0 }), "enter", g5), "native");
});

test("⑤ Enter 发送偏好：单独 Enter 发送，Shift+Enter 留给换行", () => {
	assert.equal(decide(enter()), "send");
	assert.equal(decide(enter({ shiftKey: true })), "native");
});

test("⑤b Shift+Enter 发送偏好：Shift+Enter 发送，单独 Enter 换行（旧行为回归）", () => {
	assert.equal(decide(enter({ shiftKey: true }), "shift-enter"), "send");
	assert.equal(decide(enter(), "shift-enter"), "native");
});

test("⑤c 输入法确认时，两种偏好都不得发送（Shift+Enter 也一样）", () => {
	const g = createCompositionGuard();
	g.compositionEnd(1000);
	assert.equal(decide(enter({ shiftKey: true, timeStamp: 1000 }), "shift-enter", g), "native");
	const g2 = createCompositionGuard();
	g2.compositionStart();
	assert.equal(decide(enter({ shiftKey: true, isComposing: true }), "shift-enter", g2), "native");
});

test("⑥ 按住不放（repeat）只发一次", () => {
	assert.equal(decide(enter({ repeat: true })), "block");
	assert.equal(decide(enter({ repeat: true }), "shift-enter"), "native", "Shift+Enter 换行时按住不放是原生换行");
	assert.equal(decide(enter({ shiftKey: true, repeat: true }), "shift-enter"), "block");
});

test("⑦ reset（切会话 / 卸载）后组合状态清干净，下一次回车恢复发送", () => {
	const g = createCompositionGuard();
	g.compositionStart();
	g.reset();
	assert.equal(g.composing(), false);
	assert.equal(decide(enter(), "enter", g), "send");
	const g2 = createCompositionGuard();
	g2.compositionEnd(1000);
	g2.reset();
	assert.equal(decide(enter({ timeStamp: 1001 }), "enter", g2), "send", "上一个会话的组合不粘到新会话");
});

test("⑧ 弹窗 / 菜单 / @ 候选已经处理过的回车不抢", () => {
	assert.equal(decide(enter({ defaultPrevented: true })), "native");
});

test("修饰键组合 / 非回车键一律原生（Mac 的 Cmd+… 尤其不能抢）", () => {
	assert.equal(decide(enter({ metaKey: true })), "native");
	assert.equal(decide(enter({ ctrlKey: true })), "native");
	assert.equal(decide(enter({ altKey: true })), "native");
	assert.equal(decide(enter({ key: "a" })), "native");
	assert.equal(decide(enter({ key: "Escape" })), "native");
	assert.equal(decide(enter({ key: "Tab" })), "native");
});

test("guard 是纯状态机：compositionStart/End 之外不改判发送", () => {
	const g = createCompositionGuard();
	g.compositionStart();
	g.compositionEnd(1000);
	assert.equal(g.composing(), false);
	assert.equal(decide(enter({ timeStamp: 2000 }), "enter", g), "send");
	g.compositionStart();
	assert.equal(g.composing(), true);
	assert.equal(decide(enter({ timeStamp: 2001 }), "enter", g), "native");
});
