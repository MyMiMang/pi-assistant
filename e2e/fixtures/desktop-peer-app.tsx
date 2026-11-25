import "../../apps/web/src/migrate";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "../../apps/web/src/App";
import type { DesktopPeerPort } from "../../apps/web/src/desktop-peer-port";
import "../../apps/web/src/styles.css";

// Handled by Playwright in this fresh browser context; no fixture goes into the production bundle.
const fixture = "/__desktop_peer_fixture/";
async function get<T>(operation: string, params = {}, signal?: AbortSignal): Promise<T> {
	const response = await fetch(`${fixture}${operation}?${new URLSearchParams(params)}`, { signal });
	if (!response.ok) throw new Error(`Fixture ${operation}: ${response.status}`);
	return response.json();
}

const desktopPeers: DesktopPeerPort = {
	list: (signal) => get("list", {}, signal),
	chats: (peer, signal) => get("chats", { peer }, signal),
	// Deliberately ignore cancellation here: emulate a boundary that delivers a stale
	// result even after switching tabs; App itself must ignore that result.
	async read(target) {
		const messages = await get<Awaited<ReturnType<DesktopPeerPort["read"]>>>("read", target);
		// Acknowledge after handing the result to App and giving React a chance to render.
		requestAnimationFrame(() => requestAnimationFrame(() => void get("read-delivered", target)));
		return messages;
	},
	status: (peer, signal) => get("status", { peer }, signal),
	async send(target, text, id) {
		const res = await fetch(`${fixture}send`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target, text, id }),
		});
		if (!res.ok) throw new Error(`Fixture send: ${res.status}`);
	},
};

createRoot(document.getElementById("root")!).render(<StrictMode><App desktopPeers={desktopPeers} /></StrictMode>);
