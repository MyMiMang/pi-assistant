import type { Hono } from "hono";
import { bus } from "../bus.ts";
import { db } from "../db.ts";
import { desktopPairStore } from "../desktop-pair.ts";
import { identity, signText } from "../identity.ts";
import type { Env } from "./common.ts";
import { desktopPeerOrigin } from "../desktop-peer-tls.ts";

const prefix = "/api/desktop-pair";
const edgePrefix = "/api/desktop-edge-pair";
const desktopText = new WeakSet<Request>();
export const restrictDesktopText = (request: Request) => desktopText.add(request);
export const isRestrictedDesktopText = (request: Request) => desktopText.has(request) || !!desktopPeerOrigin(request);
export function desktopTextRequest(request: Request) {
	const { pathname, search } = new URL(request.url);
	if (request.method === "GET" && !search && /^(?:\/api\/system\/public|\/api\/agents(?:\/[a-zA-Z0-9_-]+\/conversations)?)$/.test(pathname)) return true;
	return /^\/api\/agents\/[a-zA-Z0-9_-]+\/messages$/.test(pathname) && (request.method === "GET" || (request.method === "POST" && !search));
}
const isRemoteOp = (method: string, path: string, base: string) => method === "POST" && ["claim", "collect", "confirm"].some(op => path === `${base}/${op}`);
export const isDesktopPairPublic = (method: string, path: string) => isRemoteOp(method, path, prefix);
export const isDesktopEdgePairPublic = (method: string, path: string) => isRemoteOp(method, path, edgePrefix) || (method === "GET" && path === `${edgePrefix}/identity`);

export function mountDesktopPairRoutes(app: Hono<Env>, store = desktopPairStore(db), serviceIdentity: () => { serverId: string; publicKey: string } = identity, ingress: () => string | null | undefined = () => null, verifiedOrigin = desktopPeerOrigin, edge = false) {
	const base = edge ? edgePrefix : prefix;
	if (edge) app.get(`${base}/identity`, c => {
		c.header("Cache-Control", "no-store");
		const origin = ingress(), nonce = c.req.query("nonce") ?? "";
		if (c.get("caller").local || !origin || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return c.json({ error: "desktop_identity_unavailable" }, 403);
		const { serverId, publicKey } = serviceIdentity();
		return c.json({ origin, serverId, publicKey, signature: signText(JSON.stringify(["pia-desktop-edge-v1", origin, serverId, publicKey, nonce])) });
	});
	app.post(`${base}/:operation`, async c => {
		c.header("Cache-Control", "no-store");
		const op = c.req.param("operation");
		const caller = c.get("caller");
		const remote = isRemoteOp(c.req.method, c.req.path, base);
		if (remote ? caller.local : !caller.local) return c.json({ error: "forbidden" }, 403);
		const b = await c.req.json<Record<string, unknown>>().catch(() => null);
		if (!b || typeof b !== "object" || Array.isArray(b)) return c.json({ error: "invalid_request" }, 400);
		const text = (key: string, max: number) => typeof b[key] === "string" && b[key].length <= max ? b[key] : "";
		if (!remote) {
			if (op === "pending") return c.json({ requests: store.pending() });
			if (op === "approve") return c.json({ ok: store.approve(text("id", 32)) });
			if (op === "cancel") return c.json({ ok: store.cancel(text("id", 32)) });
			if (op !== "invite") return c.json({ error: "not_found" }, 404);
		}
		let url: URL;
		try { url = new URL(ingress() ?? ""); }
		catch { return c.json({ error: "desktop_https_entry_required" }, 409); }
		if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || (remote && (edge ? b.origin !== url.origin : verifiedOrigin(c.req.raw) !== url.origin))) return c.json({ error: "desktop_https_entry_required" }, 409);
		const { serverId, publicKey } = serviceIdentity();
		const target = { origin: url.origin, serverId, publicKey };
		if (op === "invite") return c.json(store.invite(target));
		if (b.serverId !== serverId || b.publicKey !== publicKey) return c.json({ error: "desktop_identity_changed" }, 409);
		const result = op === "claim" ? store.claim(target, text("code", 16), text("commitment", 64), text("name", 60) || "桌面 Pi", text("platform", 40))
			: op === "collect" ? store.collect(target, text("id", 32), b.proof)
				: store.confirm(target, text("id", 32), text("receipt", 46)) && { ok: true };
		if (!result) return c.json({ error: "desktop_pair_unavailable" }, 403);
		if (op === "confirm") bus.emit({ type: "devices.changed" });
		return c.json(result);
	});
}
