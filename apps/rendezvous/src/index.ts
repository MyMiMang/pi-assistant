/**
 * 胡好好 Rendezvous（入口域名）—— Cloudflare Worker + KV
 *
 * 1. 托管 PWA 外壳静态文件（apps/web/dist），手机扫码打开的固定网址；
 * 2. 保存 serverId → 当前隧道地址 的“地址簿”记录。记录由各用户电脑上的服务用 Ed25519 私钥签名上报，
 *    首次上报时登记公钥（TOFU），之后只接受同一公钥的签名；手机端也用配对时保存的公钥再校验一次。
 *
 * 多用户：任意多台服务都可以注册到同一个 Rendezvous；每部手机只知道自己配对过的 serverId。
 * Rendezvous 只交换地址，永远不经手聊天内容、凭据或文件。
 */
export interface Env {
	SERVERS: KVNamespace;
	ASSETS: Fetcher;
}

interface ServerRecord {
	url: string;
	ts: number;
	sig: string;
	publicKey: string;
	createdAt: number;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SKEW = 10 * 60_000;
const TTL_SECONDS = 30 * 24 * 3600;

const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
	"Access-Control-Allow-Headers": "content-type",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });

export const registrationMessage = (serverId: string, url: string, ts: number) => `huhao-rendezvous-v1\n${serverId}\n${url}\n${ts}`;

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
	const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
	return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export async function verify(publicKey: string, sig: string, message: string): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey("raw", b64urlDecode(publicKey), { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify({ name: "Ed25519" }, key, b64urlDecode(sig), new TextEncoder().encode(message));
	} catch {
		return false;
	}
}

export function validUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash && url === u.origin;
	} catch {
		return false;
	}
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
	if (url.pathname === "/api/health") return json({ ok: true, service: "huhao-rendezvous", version: 1 });
	const m = url.pathname.match(/^\/api\/servers\/([^/]+)$/);
	if (!m) return json({ error: "unauthorized" }, 401); // 外壳模式下未配对的设备会看到“需要配对”
	const id = m[1].toLowerCase();
	if (!ID_RE.test(id)) return json({ error: "bad_id" }, 400);
	const key = `srv:${id}`;

	if (req.method === "GET") {
		const rec = await env.SERVERS.get<ServerRecord>(key, "json");
		if (!rec) return json({ error: "not_found" }, 404);
		return json({ url: rec.url, ts: rec.ts, sig: rec.sig });
	}

	if (req.method === "PUT") {
		const len = Number(req.headers.get("content-length") ?? 0);
		if (len > 2048) return json({ error: "too_large" }, 413);
		let body: { url?: string; ts?: number; sig?: string; publicKey?: string };
		try {
			body = await req.json();
		} catch {
			return json({ error: "bad_json" }, 400);
		}
		const { url: target, ts, sig, publicKey } = body;
		if (typeof target !== "string" || typeof ts !== "number" || typeof sig !== "string" || typeof publicKey !== "string") return json({ error: "bad_request" }, 400);
		if (!validUrl(target)) return json({ error: "bad_url" }, 400);
		if (Math.abs(Date.now() - ts) > MAX_SKEW) return json({ error: "stale" }, 400);
		const existing = await env.SERVERS.get<ServerRecord>(key, "json");
		if (existing && existing.publicKey !== publicKey) return json({ error: "key_mismatch" }, 403);
		if (existing && ts <= existing.ts) return json({ error: "replay" }, 409);
		if (!(await verify(publicKey, sig, registrationMessage(id, target, ts)))) return json({ error: "bad_signature" }, 403);
		const rec: ServerRecord = { url: target, ts, sig, publicKey, createdAt: existing?.createdAt ?? Date.now() };
		await env.SERVERS.put(key, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });
		return json({ ok: true });
	}
	return json({ error: "method_not_allowed" }, 405);
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname.startsWith("/api/")) return handleApi(req, env, url);
		if (url.pathname === "/ws") return new Response("not here", { status: 404 });
		// 其余请求：PWA 外壳静态文件（SPA 回退由 wrangler assets 配置处理）
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("X-Content-Type-Options", "nosniff");
		h.set("Referrer-Policy", "no-referrer");
		h.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; script-src 'self'; frame-ancestors 'none'; base-uri 'none'");
		return new Response(res.body, { status: res.status, headers: h });
	},
} satisfies ExportedHandler<Env>;
