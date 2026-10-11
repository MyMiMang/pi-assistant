import "./migrate"; // 必须最先执行：store/api 在模块加载时读取 localStorage
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import PairPage from "./components/PairPage";
import "./styles.css";
import { applyTheme, useStore } from "./store";

const { theme, accent } = useStore.getState();
applyTheme(theme, accent);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme(useStore.getState().theme, useStore.getState().accent));
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost"))
	navigator.serviceWorker.register("/sw.js").catch(() => {});

createRoot(document.getElementById("root")!).render(<StrictMode>{location.pathname === "/pair" ? <PairPage /> : <App />}</StrictMode>);
