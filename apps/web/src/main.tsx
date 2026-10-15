import "./migrate"; // 必须最先执行：store/api 在模块加载时读取 localStorage
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import HostFloatBar from "./components/HostFloatBar";
import PairPage from "./components/PairPage";
import PetWindow from "./pet/PetWindow";
import "./styles.css";
import "./themes/macos-titlebar.css";
import { installExternalLinkHandling } from "./externalLinks";
import { installMacWindowChrome } from "./macosWindow";
import { applyTheme, useStore } from "./store";

// macOS 桌面窗口：透明覆盖式标题栏的顶部留白 + 拖动区（其他环境是空操作）
installMacWindowChrome();

// 桌面程序里外链交给系统默认浏览器（聊天/群聊/子代理/工具结果共用；普通浏览器是空操作）。
// 桌宠窗口不装：它的 capability 没放行 opener，且 on_new_window 会把新窗口请求转成「在主窗口打开本机路径」。
if (location.pathname !== "/pet") installExternalLinkHandling();

const { theme, accent, skin } = useStore.getState();
applyTheme(theme, accent, skin);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	const s = useStore.getState();
	applyTheme(s.theme, s.accent, s.skin);
});
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost"))
	navigator.serviceWorker.register("/sw.js").catch(() => {});

createRoot(document.getElementById("root")!).render(<StrictMode>{location.pathname === "/pair" ? <PairPage /> : location.pathname === "/hostbar" ? <HostFloatBar /> : location.pathname === "/pet" ? <PetWindow /> : <App />}</StrictMode>);
