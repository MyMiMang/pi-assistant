/**
 * macOS 桌面窗口的透明覆盖式标题栏支持。
 *
 * 背景：apps/tray/src-tauri/src/main.rs 建主窗口时（仅 macOS）用
 * `TitleBarStyle::Overlay` + `hidden_title(true)`，系统红黄绿按钮保留、窗口标题隐藏，
 * 页面内容一直顶到窗口边。于是页面要自己负责：
 *   1) 顶部留出安全高度（CSS，见 ./themes/macos-titlebar.css），让开交通灯那一条；
 *   2) 在顶部放一个透明拖动区（`data-tauri-drag-region`），窗口才能拖动、双击缩放。
 *
 * 只在 macOS 桌面窗口生效：主窗口的 <html> 上由 Rust 注入 `.macos-tauri`，
 * 普通浏览器、Windows / Linux 桌面窗口、手机都没有这个 class，因此不会多出空白。
 */

/** 顶部拖动区的元素 id（CSS 在 ./themes/macos-titlebar.css） */
const DRAG_ID = "pa-mac-drag";

/** 是否 macOS 桌面窗口（Rust 建主窗口时注入的标记；普通浏览器里是 false） */
export const isMacTauri = () => document.documentElement.classList.contains("macos-tauri");

function ensureDragStrip() {
	if (document.getElementById(DRAG_ID)) return;
	const el = document.createElement("div");
	el.id = DRAG_ID;
	el.setAttribute("aria-hidden", "true");
	// 顶格透明、盖住顶部安全高度那一条；里面没有任何可点元素，所以不会挡住按钮
	el.setAttribute("data-tauri-drag-region", "");
	document.body.appendChild(el);
}

/**
 * macOS 原生全屏时系统会收起交通灯和标题栏，顶部就不该再留白。
 * 优先用 Tauri 官方窗口 API（plugin:window|is_fullscreen，权限在 apps/tray/.../capabilities/remote-ui.json）；
 * 拿不到时退回「窗口内容高度 ≈ 屏幕高度」判断：macOS 普通窗口（菜单栏下方）通常够不到整个屏幕高度。
 */
async function isNativeFullscreen(): Promise<boolean | null> {
	const invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__?.invoke;
	if (!invoke) return null;
	try {
		return Boolean(await invoke("plugin:window|is_fullscreen"));
	} catch {
		return null;
	}
}

async function syncFullscreen() {
	const native = await isNativeFullscreen();
	const full = native ?? window.innerHeight >= window.screen.height - 2;
	document.documentElement.classList.toggle("macos-fullscreen", full);
}

/** 装 macOS 桌面窗口的顶部拖动区与全屏留白切换；非 macOS 桌面窗口直接跳过，重复调用无副作用 */
export function installMacWindowChrome() {
	if (!isMacTauri()) return;
	ensureDragStrip();
	void syncFullscreen();
	window.addEventListener("resize", () => void syncFullscreen());
	window.addEventListener("focus", () => void syncFullscreen());
}
