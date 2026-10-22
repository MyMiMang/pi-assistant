/**
 * Windows / Linux 桌面上的窗口外观，跟 App 主题保持一致（macOS 由 ./macosWindow.ts 负责，这里不动它）：
 *  1) 滚动条：Mac 是覆盖式、静止自动隐藏，看不出来；Windows / Linux 的 WebView 用经典滚动条（浅色、带上下箭头），
 *     在深色主题里很扎眼。给 <html> 加 .pa-classic-sb，所有滚动区域统一成聊天区那种细滚动条（themes/app.css）。
 *  2) 标题栏：Windows 原生标题栏跟系统明暗走，系统是浅色而 App 是深色时窗口顶上一条白。
 *     App 明暗变化时（<html data-mode>）通知桌面窗口跟着切换（Tauri plugin:window|set_theme，capability 见 remote-ui.json）。
 */
import { tauriInvoke } from "./externalLinks";

const isMac = () => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

export function installDesktopChrome() {
	const el = document.documentElement;
	if (!isMac() && matchMedia("(hover: hover) and (pointer: fine)").matches) el.classList.add("pa-classic-sb");
	const invoke = tauriInvoke();
	if (!invoke) return;
	let last = "";
	const sync = () => {
		const mode = el.dataset.mode === "dark" ? "dark" : "light";
		if (mode === last) return;
		last = mode;
		invoke("plugin:window|set_theme", { label: "main", value: mode }).catch(() => {});
	};
	sync();
	new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ["data-mode"] });
}
