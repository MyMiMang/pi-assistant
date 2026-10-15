/**
 * 手机浏览器：把「可视 viewport 高度」写进 --pa-vvh，让 App shell 正好占满看得见的那块区域。
 *
 * 为什么需要它（真机问题）：iOS Safari 的 100% / 100vh 取的是「地址栏收起后」的高度，比可见区域高，
 * 页面本身因此可以上下拖动 —— 顶栏和底部输入栏就跟着整页移动；键盘弹出时 iOS 是覆盖式的，
 * 不会缩小布局视口，100dvh 也不变，输入栏会被键盘挡住。visualViewport 是唯一能拿到真实可视高度、
 * 且能感知键盘的接口（Chromium 上另有 index.html 的 interactive-widget=resizes-content 兜底）。
 *
 * 边界（诚实说明）：
 * - 双指缩放（scale != 1）时不介入，直接撤掉 --pa-vvh，把页面完全交还给浏览器，保住 pinch zoom 与文字缩放。
 * - Playwright 的移动模拟只能验证「视口尺寸变化后 shell 跟随、整页不滚动」，无法复现真机 iOS 键盘，
 *   所以 e2e/mobile-viewport-ui.mjs 里的键盘用例是「缩小视口」的近似，不是真机结论。
 */
const STICK_SLACK = 120; // 与 Chat / RoomChat / Subagents 判断「是否还贴着底部」用的是同一个阈值
let lastHeight = 0;

/**
 * 视口变化后：原本贴着底部的聊天区（主会话 / 群聊 / 子代理共用 .pa-scroll）重新贴住最后一条消息。
 * extraSlack：视口变矮时滚动容器同步变矮、内容位置不变，离底部的距离会平白多出同样多，
 * 所以把这块算进松弛量，否则缩小后再判断就已经「不在底部」了。
 */
function stickChatScrolls(extraSlack: number) {
	for (const el of document.querySelectorAll<HTMLElement>(".pa-scroll")) {
		if (!el.getClientRects().length) continue; // 隐藏的子代理标签页不动
		if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK + extraSlack) el.scrollTop = el.scrollHeight;
	}
}

function apply() {
	const vv = window.visualViewport;
	if (!vv) return;
	const root = document.documentElement;
	const zoomed = Math.abs(vv.scale - 1) > 0.02;
	const height = Math.round(vv.height);
	const shrunk = lastHeight ? Math.max(0, lastHeight - height) : 0;
	lastHeight = height;
	// 缩放中：不写高度，页面交还给浏览器（不破坏双指缩放 / 文字缩放）
	if (zoomed) root.style.removeProperty("--pa-vvh");
	else root.style.setProperty("--pa-vvh", `${height}px`);
	// 键盘遮挡（可视高度明显小于布局视口）：收起底部安全区留白，输入栏贴着键盘
	const kb = !zoomed && vv.height < window.innerHeight - 100;
	root.classList.toggle("pa-kb-open", kb);
	// 缩放中不碰滚动位置，否则双指缩放会被当成键盘收起、聊天区自己跳到底部
	if (!zoomed) stickChatScrolls(shrunk);
}

/** 装一次即可（main.tsx 在渲染前调用；桌宠 / 悬浮条窗口也安全，它们的 #root 高度另有更高优先级规则）。 */
export function installViewportHeight() {
	const vv = window.visualViewport;
	if (!vv) return; // 老浏览器：退回 CSS 的 100dvh / 100vh
	let raf = 0;
	const schedule = () => {
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(apply);
	};
	apply();
	vv.addEventListener("resize", schedule);
	window.addEventListener("resize", schedule);
	window.addEventListener("orientationchange", schedule);
}
