import "./migrate"; // 必须最先执行：store/api 在模块加载时读取 localStorage
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import HostFloatBar from "./components/HostFloatBar";
import PairPage from "./components/PairPage";
import PetWindow from "./pet/PetWindow";
import "./styles.css";
import { applyTheme, useStore } from "./store";

const { theme, accent, skin } = useStore.getState();
applyTheme(theme, accent, skin);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	const s = useStore.getState();
	applyTheme(s.theme, s.accent, s.skin);
});
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost"))
	navigator.serviceWorker.register("/sw.js").catch(() => {});

createRoot(document.getElementById("root")!).render(<StrictMode>{location.pathname === "/pair" ? <PairPage /> : location.pathname === "/hostbar" ? <HostFloatBar /> : location.pathname === "/pet" ? <PetWindow /> : <App />}</StrictMode>);
