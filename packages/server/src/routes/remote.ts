/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import QRCode from "qrcode";
import { approveDevice, setOwner, claimPairCode, createPairCode, listDevices, pairStatus, rateLimit, rejectDevice, revokeDevice } from "../auth.ts";
import { config } from "../config.ts";
import { getSetting, setSetting } from "../db.ts";
import { identity } from "../identity.ts";
import { subscribe, vapidPublicKey } from "../push.ts";
import { cfStatus, deployRendezvous, removeRendezvous } from "../cloudflare.ts";
import { entryDomain, restartTunnel, retryTunnel, tunnelStatus } from "../tunnel.ts";
import { checkNamedPerms, namedConfig, removeNamedTunnel, setupNamedTunnel } from "../named-tunnel.ts";
import { sealJson } from "../secrets.ts";
import { isAdmin, localOnly, type Env } from "./common.ts";

// ---------------------------------------------------------------- 固定地址（命名隧道）与隧道控制（仅本机可操作）
const namedJson = () => {
	const n = namedConfig();
	return { config: n && { zone: n.zone, subdomain: n.subdomain, hostname: n.hostname, tunnelId: n.tunnelId, tunnelName: n.tunnelName, createdAt: n.createdAt }, mode: getSetting("tunnelMode", "auto"), zone: getSetting<string | null>("namedZone", null) ?? cfStatus().config?.zone ?? null, subdomain: getSetting("namedSubdomain", "pi"), hasToken: cfStatus().hasToken };
};

const cleanZone = (z: string) => String(z ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

export function mountRemoteRoutes(app: Hono<Env>) {
	// ---------------------------------------------------------------- 远程稳定入口：部署到用户自己的 Cloudflare（仅本机可操作）
	app.get("/api/remote/cloudflare", localOnly, (c) => c.json(cfStatus()));
	app.post("/api/remote/cloudflare/deploy", localOnly, async (c) => {
		const b = await c.req.json<{ zone: string; subdomain: string; token?: string }>();
		try {
			return c.json({ ok: true, config: await deployRendezvous(b) });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.delete("/api/remote/cloudflare", localOnly, async (c) => {
		await removeRendezvous();
		return c.json({ ok: true });
	});
	app.get("/api/remote/named", localOnly, (c) => c.json(namedJson()));
	app.post("/api/remote/named/check", localOnly, async (c) => {
		const b = await c.req.json<{ zone: string; token?: string }>();
		try {
			return c.json(await checkNamedPerms(cleanZone(b.zone), b.token?.trim() || undefined, { probeEdit: true }));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.post("/api/remote/named", localOnly, async (c) => {
		const b = await c.req.json<{ zone: string; subdomain: string; token?: string }>();
		const zone = cleanZone(b.zone);
		if (b.token?.trim()) setSetting("cloudflareToken", sealJson(b.token.trim()));
		setSetting("namedZone", zone);
		setSetting("namedSubdomain", String(b.subdomain ?? "").trim().toLowerCase());
		try {
			const cfg = await setupNamedTunnel({ zone, subdomain: b.subdomain });
			restartTunnel();
			return c.json({ ok: true, hostname: cfg.hostname });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e), missing: (e as { missing?: string[] }).missing }, 400);
		}
	});
	app.delete("/api/remote/named", localOnly, async (c) => {
		await removeNamedTunnel();
		restartTunnel();
		return c.json({ ok: true });
	});
	app.post("/api/remote/tunnel/retry", localOnly, (c) => (retryTunnel(), c.json(tunnelStatus())));
	app.post("/api/remote/tunnel/mode", localOnly, async (c) => {
		const { mode } = await c.req.json<{ mode: "auto" | "quick" }>();
		setSetting("tunnelMode", mode === "quick" ? "quick" : "auto");
		return c.json(namedJson());
	});
	// ---------------------------------------------------------------- 配对与设备
	app.post("/api/pair/start", localOnly, async (c) => {
		const b = await c.req.json<{ preApproved?: boolean }>().catch(() => ({}) as { preApproved?: boolean });
		const { code, shortCode, expiresAt, preApproved } = createPairCode({ preApproved: b.preApproved === true });
		const id = identity();
		const t = tunnelStatus();
		const reqOrigin = new URL(c.req.url).origin;
		const direct = t.url ?? reqOrigin;
		const params = new URLSearchParams({ sid: id.serverId, u: direct, pk: id.publicKey, c: code }).toString();
		// 入口域名可用（已成功注册 Rendezvous）时，二维码指向固定入口；否则直连隧道/本机地址
		const viaEntry = !!(t.url && entryDomain() && t.rendezvous.state === "ok");
		const url = viaEntry ? `https://${entryDomain()}/pair#${params}` : `${direct}/pair#${params}`;
		return c.json({ url, directUrl: `${direct}/pair#${params}`, shortCode, viaEntry, expiresAt, preApproved, qr: await QRCode.toDataURL(url, { margin: 1, width: 320 }), remote: !!t.url });
	});
	app.post("/api/pair/claim", async (c) => {
		const ip = c.get("caller").ip;
		if (!rateLimit(`pair:${ip}`, 0.5, 5)) return c.json({ error: "rate_limited" }, 429);
		const b = await c.req.json<{ code: string; name: string; platform?: string }>();
		const r = claimPairCode(String(b.code ?? ""), String(b.name ?? ""), String(b.platform ?? ""));
		return r.ok ? c.json({ deviceId: r.deviceId, serverId: identity().serverId, publicKey: identity().publicKey, preApproved: !!r.preApproved }) : c.json({ error: r.error }, r.error === "too_many_attempts" ? 429 : 400);
	});
	app.get("/api/pair/status/:id", (c) => {
		const ip = c.get("caller").ip;
		if (!rateLimit(`pairpoll:${ip}`, 60)) return c.json({ error: "rate_limited" }, 429);
		return c.json(pairStatus(c.req.param("id")));
	});
	app.get("/api/devices", (c) => c.json(listDevices()));
	app.post("/api/devices/:id/approve", localOnly, (c) => c.json({ ok: approveDevice(c.req.param("id")!) }));
	app.post("/api/devices/:id/reject", localOnly, (c) => (rejectDevice(c.req.param("id")!), c.json({ ok: true })));
	// 吊销：本机 / 主人可以吊销任何设备；其他设备只能退出自己
	app.delete("/api/devices/:id", (c) => {
		const id = c.req.param("id");
		if (!isAdmin(c) && c.get("caller").deviceId !== id) return c.json({ error: "local_only" }, 403);
		revokeDevice(id);
		return c.json({ ok: true });
	});
	app.post("/api/devices/:id/owner", localOnly, async (c) => {
		const { owner } = await c.req.json<{ owner: boolean }>();
		try {
			return c.json({ ok: setOwner(c.req.param("id")!, owner === true) });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	// ---------------------------------------------------------------- 推送
	app.get("/api/push/key", (c) => c.json({ publicKey: vapidPublicKey() }));
	app.post("/api/push/subscribe", async (c) => {
		const sub = await c.req.json<{ endpoint: string }>();
		if (!sub?.endpoint?.startsWith("https://")) return c.json({ error: "invalid" }, 400);
		subscribe(sub, c.get("caller").deviceId);
		return c.json({ ok: true });
	});
}
