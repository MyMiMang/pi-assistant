/**
 * 一键把 Rendezvous（Worker + KV + PWA 外壳）部署到“用户自己的” Cloudflare 账号。
 * 只用 Cloudflare 公开 REST API（不依赖 wrangler）。Token 只加密保存在本机，只发给 api.cloudflare.com。
 *
 * 需要的 Token 权限：模板「Edit Cloudflare Workers」（Workers Scripts / KV Storage Edit、Workers Routes Edit、
 * Account Settings Read、Zone Read 等）。Custom Domain 会由 Cloudflare 自动创建 DNS 记录与证书。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";
import { openJson, sealJson } from "./secrets.ts";
import { register, tunnelStatus } from "./tunnel.ts";

const API = "https://api.cloudflare.com/client/v4";
export const SCRIPT_NAME = "pi-assistant-rendezvous";
const KV_TITLE = "pi-assistant-rendezvous-servers";

export interface CfConfig {
	zone: string;
	subdomain: string;
	hostname: string;
	accountId: string;
	zoneId: string;
	kvId: string;
	deployedAt: number;
}
export type DeployStep = { step: string; state: "running" | "ok" | "error"; detail?: string };

export async function cf<T = any>(token: string, path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(API + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
	let j: { success?: boolean; result?: T; errors?: { code: number; message: string }[] };
	try {
		j = await res.json();
	} catch {
		throw new Error(`Cloudflare 返回 HTTP ${res.status}`);
	}
	if (!res.ok || j.success === false) {
		const msg = (j.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
		throw Object.assign(new Error(msg), { status: res.status, codes: (j.errors ?? []).map((e) => e.code) });
	}
	return j.result as T;
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

export function cfStatus() {
	const c = getSetting<CfConfig | null>("cloudflare", null);
	return { configured: !!c, hasToken: !!getSetting<string | null>("cloudflareToken", null), config: c, workerBuilt: existsSync(config.rendezvousWorker), webBuilt: existsSync(join(config.webDist, "index.html")) };
}

export function cfToken(): string | null {
	const s = getSetting<string | null>("cloudflareToken", null);
	return s ? openJson<string>(s) : null;
}

let running: Promise<CfConfig> | null = null;
export function deployRendezvous(input: { zone: string; subdomain: string; token?: string }): Promise<CfConfig> {
	if (running) return running;
	running = doDeploy(input).finally(() => (running = null));
	return running;
}

async function doDeploy(input: { zone: string; subdomain: string; token?: string }): Promise<CfConfig> {
	const emit = (s: DeployStep) => bus.emit({ type: "cloudflare.progress", ...s });
	const step = async <T>(name: string, fn: () => Promise<T>, detail?: (r: T) => string): Promise<T> => {
		emit({ step: name, state: "running" });
		try {
			const r = await fn();
			emit({ step: name, state: "ok", detail: detail?.(r) });
			return r;
		} catch (e) {
			emit({ step: name, state: "error", detail: e instanceof Error ? e.message : String(e) });
			throw e;
		}
	};
	const zone = input.zone.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	const sub = input.subdomain.trim().toLowerCase();
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone)) throw new Error("域名格式不正确");
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sub)) throw new Error("子域名只能包含字母、数字和连字符");
	const token = input.token?.trim() || cfToken();
	if (!token) throw new Error("请填写 Cloudflare API Token");
	if (!existsSync(config.rendezvousWorker)) throw new Error("缺少 Rendezvous Worker 构建产物（npm run build）");
	if (!existsSync(join(config.webDist, "index.html"))) throw new Error("缺少 Web UI 构建产物（npm run build）");
	const hostname = `${sub}.${zone}`;

	await step("验证 Token", () => cf(token, "/user/tokens/verify"), (r: { status: string }) => r.status);
	const z = await step(
		"查找域名",
		async () => {
			const list = await cf<{ id: string; name: string; status: string; account: { id: string } }[]>(token, `/zones?name=${encodeURIComponent(zone)}`);
			if (!list.length) throw new Error(`这个 Token 看不到域名 ${zone}：请确认域名已托管在 Cloudflare，且 Token 的“区域资源”包含它`);
			return list[0];
		},
		(r) => `${r.name}（${r.status}）`,
	);
	const accountId = z.account.id;
	const kvId = await step(
		"准备 KV 存储",
		async () => {
			const list = await cf<{ id: string; title: string }[]>(token, `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
			const hit = list.find((n) => n.title === KV_TITLE);
			if (hit) return hit.id;
			return (await cf<{ id: string }>(token, `/accounts/${accountId}/storage/kv/namespaces`, { method: "POST", body: JSON.stringify({ title: KV_TITLE }) })).id;
		},
		(id) => id.slice(0, 8),
	);
	const assetsJwt = await step(
		"上传 PWA 外壳",
		async () => {
			const files = walk(config.webDist);
			const manifest: Record<string, { hash: string; size: number }> = {};
			const byHash = new Map<string, { b64: string; type: string }>();
			for (const f of files) {
				const buf = readFileSync(f);
				const b64 = buf.toString("base64");
				const ext = extname(f).slice(1);
				const hash = createHash("sha256").update(b64 + ext).digest("hex").slice(0, 32);
				manifest[`/${relative(config.webDist, f).split(sep).join("/")}`] = { hash, size: buf.length };
				byHash.set(hash, { b64, type: mime(ext) });
			}
			const session = await cf<{ jwt: string; buckets?: string[][] }>(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}/assets-upload-session`, { method: "POST", body: JSON.stringify({ manifest }) });
			let completion = session.jwt;
			for (const bucket of session.buckets ?? []) {
				const form = new FormData();
				for (const h of bucket) {
					const f = byHash.get(h)!;
					form.append(h, new File([f.b64], h, { type: f.type }));
				}
				const res = await fetch(`${API}/accounts/${accountId}/workers/assets/upload?base64=true`, { method: "POST", headers: { authorization: `Bearer ${session.jwt}` }, body: form, signal: AbortSignal.timeout(120_000) });
				const j = (await res.json()) as { success: boolean; result?: { jwt?: string }; errors?: { message: string }[] };
				if (!j.success) throw new Error(`上传静态文件失败：${j.errors?.map((e) => e.message).join("; ")}`);
				if (j.result?.jwt) completion = j.result.jwt;
			}
			return { jwt: completion, count: files.length, uploaded: (session.buckets ?? []).flat().length };
		},
		(r) => `${r.count} 个文件，新上传 ${r.uploaded} 个`,
	);
	await step("部署 Worker", async () => {
		const metadata = {
			main_module: "worker.js",
			compatibility_date: "2026-09-01",
			bindings: [
				{ type: "kv_namespace", name: "SERVERS", namespace_id: kvId },
				{ type: "assets", name: "ASSETS" },
			],
			assets: { jwt: assetsJwt.jwt, config: { not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/ws"] } },
			observability: { enabled: true },
		};
		const form = new FormData();
		form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
		form.append("worker.js", new File([readFileSync(config.rendezvousWorker)], "worker.js", { type: "application/javascript+module" }));
		return cf(token, `/accounts/${accountId}/workers/scripts/${SCRIPT_NAME}`, { method: "PUT", body: form });
	});
	await step(
		"绑定自定义域名",
		() => cf(token, `/accounts/${accountId}/workers/domains`, { method: "PUT", body: JSON.stringify({ environment: "production", hostname, service: SCRIPT_NAME, zone_id: z.id }) }),
		() => hostname,
	);
	await step(
		"等待 HTTPS 生效",
		async () => {
			const until = Date.now() + 180_000;
			let last = "";
			while (Date.now() < until) {
				try {
					const r = await fetch(`https://${hostname}/api/health`, { signal: AbortSignal.timeout(8000) });
					if (r.ok && ((await r.json()) as { service?: string }).service === SCRIPT_NAME) return "ok";
					last = `HTTP ${r.status}`;
				} catch (e) {
					last = e instanceof Error ? e.message : String(e);
				}
				await new Promise((r) => setTimeout(r, 4000));
			}
			throw new Error(`域名还没生效（${last}）。证书签发有时需要几分钟，可稍后点“重新检查”`);
		},
		() => `https://${hostname}`,
	);
	const cfg: CfConfig = { zone, subdomain: sub, hostname, accountId, zoneId: z.id, kvId, deployedAt: Date.now() };
	setSetting("cloudflare", cfg);
	if (input.token?.trim()) setSetting("cloudflareToken", sealJson(input.token.trim()));
	setSetting("entryDomain", hostname);
	const t = tunnelStatus();
	if (t.url) await register(t.url);
	bus.emit({ type: "settings.changed" });
	return cfg;
}

/** 删除远程入口：解绑域名、删除 Worker（KV 保留，几乎不占空间），清除本地 Token。 */
export async function removeRendezvous() {
	const c = getSetting<CfConfig | null>("cloudflare", null);
	const token = cfToken();
	if (c && token) {
		const domains = await cf<{ id: string; hostname: string }[]>(token, `/accounts/${c.accountId}/workers/domains?hostname=${c.hostname}`).catch(() => []);
		for (const d of domains) await cf(token, `/accounts/${c.accountId}/workers/domains/${d.id}`, { method: "DELETE" }).catch(() => {});
		await cf(token, `/accounts/${c.accountId}/workers/scripts/${SCRIPT_NAME}`, { method: "DELETE" }).catch(() => {});
	}
	setSetting("cloudflare", null);
	setSetting("cloudflareToken", null);
	setSetting("entryDomain", null);
	bus.emit({ type: "settings.changed" });
}

function mime(ext: string) {
	return (
		{ html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", webmanifest: "application/manifest+json", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", woff2: "font/woff2", txt: "text/plain" } as Record<string, string>
	)[ext] ?? "application/octet-stream";
}
