import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type Next } from "hono";
import QRCode from "qrcode";
import { WebSocketServer, type WebSocket } from "ws";
import {
	approveDevice, type Caller, claimPairCode, clientIp, createPairCode, deviceForToken, isLocalRequest, listDevices, pairStatus, rateLimit, rejectDevice, revokeDevice, touchDevice,
} from "./auth.ts";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { db, getSetting, now, setSetting } from "./db.ts";
import { fileInfo, getFile, insideWorkspace, listFiles, listWorkspace, mimeOf, saveUpload } from "./files.ts";
import { identity } from "./identity.ts";
import { answerLogin, cancelLogin, loginLog, startLogin } from "./login-flows.ts";
import { insertMessage, listMessages } from "./messages.ts";
import { credentialBackend, customProviders, defaultModel, models } from "./models.ts";
import { supportedApis, type CustomProviderInput } from "./pi-adapter/custom-providers.ts";
import { checkPiCompat } from "./pi-adapter/index.ts";
import { pushLog, subscribe, vapidPublicKey } from "./push.ts";
import { requests } from "./requests.ts";
import { getAgent, getTask, listAgents, runtime, tasks } from "./runtime.ts";
import { dockerAvailable, sandboxMode } from "./sandbox.ts";
import { cfStatus, deployRendezvous, removeRendezvous } from "./cloudflare.ts";
import { entryDomain, startTunnel, stopTunnel, tunnelStatus } from "./tunnel.ts";

type Env = { Bindings: { incoming: IncomingMessage }; Variables: { caller: Caller } };
const app = new Hono<Env>();

const remoteOf = (c: Context<Env>) => c.env.incoming.socket.remoteAddress;

// ---------------------------------------------------------------- 安全头 / CORS / 鉴权 / 限流
app.use("*", async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Frame-Options", "DENY");
	if (!c.req.path.startsWith("/api/"))
		c.header(
			"Content-Security-Policy",
			"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
		);
});

app.use("/api/*", async (c, next) => {
	const origin = c.req.header("origin");
	const allowed = origin && ((!!entryDomain() && origin === `https://${entryDomain()}`) || origin === new URL(c.req.url).origin);
	if (allowed) {
		c.header("Access-Control-Allow-Origin", origin!);
		c.header("Vary", "Origin");
		c.header("Access-Control-Allow-Headers", "authorization, content-type");
		c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
	}
	if (c.req.method === "OPTIONS") return c.body(null, 204);
	const local = isLocalRequest(remoteOf(c), c.req.raw.headers);
	const ip = clientIp(remoteOf(c), c.req.raw.headers);
	const auth = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
	const deviceId = local ? null : deviceForToken(auth);
	if (!local && !rateLimit(`ip:${ip}:${deviceId ? "auth" : "anon"}`, deviceId ? 600 : 30)) return c.json({ error: "rate_limited" }, 429);
	c.set("caller", { local, deviceId, ip });
	const pub = ["/api/pair/claim", "/api/pair/status/", "/api/system/public"].some((p) => c.req.path.startsWith(p));
	if (!local && !deviceId && !pub) return c.json({ error: "unauthorized" }, 401);
	if (deviceId) touchDevice(deviceId, ip);
	return next();
});

const localOnly = async (c: Context<Env>, next: Next) => (c.get("caller").local ? next() : c.json({ error: "local_only" }, 403));
const by = (c: Context<Env>) => c.get("caller").deviceId ?? "local";

// ---------------------------------------------------------------- 系统
app.get("/api/system/public", (c) => c.json({ serverId: identity().serverId, publicKey: identity().publicKey, name: "胡好好" }));
app.get("/api/system", async (c) =>
	c.json({
		serverId: identity().serverId,
		publicKey: identity().publicKey,
		pi: checkPiCompat(),
		mock: config.mock,
		local: c.get("caller").local,
		deviceId: c.get("caller").deviceId,
		onboarded: getSetting("onboarded", false) && !!defaultModel(),
		defaultModel: defaultModel(),
		credentialBackend,
		sandbox: { mode: await sandboxMode(), preference: getSetting("sandbox", config.sandbox), dockerAvailable: await dockerAvailable() },
		entryDomain: entryDomain(),
		tunnel: tunnelStatus(),
		workspaceRoot: config.workspaceRoot,
		push: { publicKey: vapidPublicKey(), recent: pushLog.slice(-5) },
		seq: bus.seq,
	}),
);

app.get("/api/settings", (c) => c.json({ entryDomain: entryDomain(), remoteEnabled: getSetting("remoteEnabled", false), sandbox: getSetting("sandbox", config.sandbox), onboarded: getSetting("onboarded", false) }));
app.put("/api/settings", async (c) => {
	const b = await c.req.json<{ entryDomain?: string | null; remoteEnabled?: boolean; sandbox?: string; onboarded?: boolean }>();
	if (b.entryDomain === "" || b.entryDomain === null) setSetting("entryDomain", null);
	else if (b.entryDomain !== undefined) {
		const d = b.entryDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
		if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return c.json({ error: "入口域名格式不正确" }, 400);
		setSetting("entryDomain", d);
	}
	if (b.sandbox && ["auto", "workspace", "docker"].includes(b.sandbox)) setSetting("sandbox", b.sandbox);
	if (b.onboarded !== undefined) setSetting("onboarded", !!b.onboarded);
	if (b.remoteEnabled !== undefined) {
		if (!c.get("caller").local && !b.remoteEnabled) return c.json({ error: "只能在电脑上关闭远程访问" }, 403);
		setSetting("remoteEnabled", !!b.remoteEnabled);
		if (b.remoteEnabled) startTunnel();
		else stopTunnel();
	}
	bus.emit({ type: "settings.changed" });
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- 模型（完全由 Pi 的 provider 目录驱动）
app.get("/api/models/providers", (c) => {
	const custom = new Map(customProviders.list().map((m) => [m.id, m]));
	return c.json(models.listProviders().map((p) => ({ ...p, custom: custom.has(p.id), configured: p.configured || !!custom.get(p.id)?.configured })));
});
// 自定义模型服务（中转站 / 第三方 / 本地），写入 Pi 的 models.json
app.get("/api/models/custom", (c) => c.json({ providers: customProviders.list(), apis: supportedApis() }));
const customErr = (c: Context<Env>, e: unknown) => c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
app.post("/api/models/custom", async (c) => {
	try {
		return c.json(await customProviders.save(null, await c.req.json<CustomProviderInput>()));
	} catch (e) {
		return customErr(c, e);
	}
});
app.put("/api/models/custom/:id", async (c) => {
	try {
		return c.json(await customProviders.save(c.req.param("id"), await c.req.json<CustomProviderInput>()));
	} catch (e) {
		return customErr(c, e);
	}
});
app.delete("/api/models/custom/:id", async (c) => {
	const id = c.req.param("id");
	const ok = await customProviders.remove(id);
	const d = defaultModel();
	if (!d || d.provider === id) setSetting("defaultModel", null);
	bus.emit({ type: "settings.changed" });
	return c.json({ ok });
});
app.post("/api/models/custom/fetch-models", async (c) => {
	try {
		return c.json({ models: await customProviders.fetchModels(await c.req.json()) });
	} catch (e) {
		return customErr(c, e);
	}
});
app.get("/api/models", (c) => c.json(models.listModels(c.req.query("provider") || undefined)));
app.post("/api/models/refresh", async (c) => (await models.refresh(), c.json({ ok: true })));
app.post("/api/models/login", async (c) => {
	const b = await c.req.json<{ provider: string; type: "api_key" | "oauth" }>();
	return c.json({ flowId: startLogin(b.provider, b.type) });
});
app.get("/api/models/login/:id", (c) => c.json(loginLog(c.req.param("id"))));
app.post("/api/models/login/:id", async (c) => {
	const b = await c.req.json<{ promptId: string; value: string }>();
	return c.json({ ok: answerLogin(c.req.param("id"), b.promptId, b.value) });
});
app.delete("/api/models/login/:id", (c) => c.json({ ok: cancelLogin(c.req.param("id")) }));
app.post("/api/models/logout", async (c) => {
	const b = await c.req.json<{ provider: string }>();
	await models.logout(b.provider);
	return c.json({ ok: true });
});
app.post("/api/models/test", async (c) => {
	const b = await c.req.json<{ provider: string; model: string }>();
	return c.json(await models.test(b.provider, b.model));
});
app.put("/api/models/default", async (c) => {
	const b = await c.req.json<{ provider: string; model: string }>();
	if (!models.getModel(b.provider, b.model)) return c.json({ error: "模型不存在" }, 400);
	setSetting("defaultModel", { provider: b.provider, id: b.model });
	bus.emit({ type: "settings.changed" });
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- 助理与聊天
const agentJson = (a: NonNullable<ReturnType<typeof getAgent>>) => {
	const last = db.prepare("SELECT content, role, created_at FROM messages WHERE agent_id = ? AND task_id IS NULL AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 1").get(a.id);
	return { ...a, session_file: undefined, model: runtime(a.id).modelFor(a), workspace: join(config.workspaceRoot, a.id), last };
};
app.get("/api/agents", (c) => c.json(listAgents().map(agentJson)));
app.post("/api/agents", async (c) => {
	const b = await c.req.json<{ name: string; avatar?: string; color?: string; persona?: string }>();
	const id = `a${Date.now().toString(36)}`;
	db.prepare("INSERT INTO agents(id, name, avatar, color, persona, sort, created_at) VALUES(?,?,?,?,?,?,?)").run(
		id, b.name.slice(0, 40) || "新助理", (b.avatar || b.name.slice(0, 1) || "新").slice(0, 2), b.color || "#0ea5e9", b.persona ?? "", listAgents().length, now(),
	);
	insertMessage({ agentId: id, role: "assistant", content: `你好，我是${b.name}。有什么可以帮你？` });
	bus.emit({ type: "agents.changed" });
	return c.json(agentJson(getAgent(id)!));
});
app.patch("/api/agents/:id", async (c) => {
	const a = getAgent(c.req.param("id"));
	if (!a) return c.json({ error: "not_found" }, 404);
	const b = await c.req.json<{ name?: string; avatar?: string; color?: string; persona?: string; model?: { provider: string; id: string } | null }>();
	db.prepare("UPDATE agents SET name = ?, avatar = ?, color = ?, persona = ?, model_provider = ?, model_id = ? WHERE id = ?").run(
		b.name ?? a.name, b.avatar ?? a.avatar, b.color ?? a.color, b.persona ?? a.persona,
		b.model === undefined ? a.model_provider : (b.model?.provider ?? null), b.model === undefined ? a.model_id : (b.model?.id ?? null), a.id,
	);
	bus.emit({ type: "agents.changed" });
	return c.json(agentJson(getAgent(a.id)!));
});
app.get("/api/agents/:id/messages", (c) => {
	const before = c.req.query("before");
	return c.json(listMessages(c.req.param("id"), { before: before ? Number(before) : undefined, limit: Number(c.req.query("limit") ?? 200) }));
});
app.post("/api/agents/:id/messages", async (c) => {
	const id = c.req.param("id");
	if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
	const b = await c.req.json<{ text: string; attachments?: string[] }>();
	const files = (b.attachments ?? []).map(getFile).filter((f) => f && f.agent_id === id) as NonNullable<ReturnType<typeof getFile>>[];
	const text = (b.text ?? "").slice(0, 100_000);
	if (!text.trim() && !files.length) return c.json({ error: "empty" }, 400);
	const msg = insertMessage({ agentId: id, role: "user", content: text, meta: { attachments: files.map(fileInfo), from: by(c) } });
	const prompt = [text, ...files.map((f) => `[附件: ${f.workspace_path}]`)].join("\n").trim();
	void runtime(id).send(prompt);
	return c.json(msg);
});
app.post("/api/agents/:id/abort", async (c) => (await runtime(c.req.param("id")).abort(), c.json({ ok: true })));
app.post("/api/agents/:id/read", (c) => {
	db.prepare("UPDATE agents SET unread = 0 WHERE id = ?").run(c.req.param("id"));
	bus.emit({ type: "agent.read", agentId: c.req.param("id") });
	return c.json({ ok: true });
});
app.post("/api/agents/:id/upload", async (c) => {
	const id = c.req.param("id");
	if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
	const body = await c.req.parseBody();
	const f = body.file;
	if (!(f instanceof File)) return c.json({ error: "no_file" }, 400);
	if (f.size > 100 * 1024 * 1024) return c.json({ error: "文件超过 100MB" }, 413);
	const row = saveUpload(id, f.name, Buffer.from(await f.arrayBuffer()));
	return c.json(fileInfo(row));
});
app.get("/api/agents/:id/files", (c) => c.json(listFiles(c.req.param("id"))));
app.get("/api/agents/:id/workspace", (c) => {
	try {
		return c.json(listWorkspace(c.req.param("id"), c.req.query("path") ?? ""));
	} catch (e) {
		return c.json({ error: String(e) }, 400);
	}
});
app.get("/api/agents/:id/workspace/file", (c) => {
	const abs = insideWorkspace(c.req.param("id"), c.req.query("path") ?? "");
	if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return c.json({ error: "not_found" }, 404);
	return sendFile(c, abs, abs.split(/[\\/]/).pop()!, mimeOf(abs));
});
app.get("/api/agents/:id/tasks", (c) => c.json(tasks.list(c.req.param("id"))));
app.get("/api/tasks/:id/messages", (c) => {
	const t = getTask(c.req.param("id"));
	return t ? c.json(listMessages(t.agent_id, { taskId: t.id })) : c.json({ error: "not_found" }, 404);
});
app.post("/api/tasks/:id/cancel", async (c) => c.json({ ok: await tasks.cancel(c.req.param("id")) }));
app.get("/api/usage", (c) => c.json(db.prepare("SELECT * FROM usage ORDER BY day DESC LIMIT 200").all()));

function sendFile(c: Context<Env>, path: string, name: string, mime: string) {
	const inline = c.req.query("inline") === "1" && /^(image\/(png|jpeg|gif|webp)|text\/plain)$/.test(mime);
	c.header("Content-Type", inline ? mime : mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime);
	c.header("Content-Length", String(statSync(path).size));
	c.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
	c.header("Cache-Control", "private, max-age=3600");
	return c.body(Readable.toWeb(createReadStream(path)) as ReadableStream);
}
app.get("/api/files/:id", (c) => {
	const f = getFile(c.req.param("id"));
	if (!f || !existsSync(f.stored_path)) return c.json({ error: "not_found" }, 404);
	return sendFile(c, f.stored_path, f.name, f.mime);
});

// ---------------------------------------------------------------- 审批 / 提问
app.post("/api/requests/:id", async (c) => {
	const b = await c.req.json<{ approved?: boolean; answer?: string; note?: string }>();
	return c.json(requests.resolve(c.req.param("id"), b, by(c)));
});

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

// ---------------------------------------------------------------- 配对与设备
app.post("/api/pair/start", localOnly, async (c) => {
	const { code, expiresAt } = createPairCode();
	const id = identity();
	const t = tunnelStatus();
	const reqOrigin = new URL(c.req.url).origin;
	const direct = t.url ?? reqOrigin;
	const params = new URLSearchParams({ sid: id.serverId, u: direct, pk: id.publicKey, c: code }).toString();
	// 入口域名可用（已成功注册 Rendezvous）时，二维码指向固定入口；否则直连隧道/本机地址
	const viaEntry = !!(t.url && entryDomain() && t.rendezvous.state === "ok");
	const url = viaEntry ? `https://${entryDomain()}/pair#${params}` : `${direct}/pair#${params}`;
	return c.json({ url, directUrl: `${direct}/pair#${params}`, viaEntry, expiresAt, qr: await QRCode.toDataURL(url, { margin: 1, width: 320 }), remote: !!t.url });
});
app.post("/api/pair/claim", async (c) => {
	const ip = c.get("caller").ip;
	if (!rateLimit(`pair:${ip}`, 0.5, 5)) return c.json({ error: "rate_limited" }, 429);
	const b = await c.req.json<{ code: string; name: string; platform?: string }>();
	const r = claimPairCode(String(b.code ?? ""), String(b.name ?? ""), String(b.platform ?? ""));
	return r.ok ? c.json({ deviceId: r.deviceId, serverId: identity().serverId }) : c.json({ error: r.error }, 400);
});
app.get("/api/pair/status/:id", (c) => {
	const ip = c.get("caller").ip;
	if (!rateLimit(`pairpoll:${ip}`, 60)) return c.json({ error: "rate_limited" }, 429);
	return c.json(pairStatus(c.req.param("id")));
});
app.get("/api/devices", (c) => c.json(listDevices()));
app.post("/api/devices/:id/approve", localOnly, (c) => c.json({ ok: approveDevice(c.req.param("id")!) }));
app.post("/api/devices/:id/reject", localOnly, (c) => (rejectDevice(c.req.param("id")!), c.json({ ok: true })));
app.delete("/api/devices/:id", (c) => (revokeDevice(c.req.param("id")), c.json({ ok: true })));

// ---------------------------------------------------------------- 推送
app.get("/api/push/key", (c) => c.json({ publicKey: vapidPublicKey() }));
app.post("/api/push/subscribe", async (c) => {
	const sub = await c.req.json<{ endpoint: string }>();
	if (!sub?.endpoint?.startsWith("https://")) return c.json({ error: "invalid" }, 400);
	subscribe(sub, c.get("caller").deviceId);
	return c.json({ ok: true });
});

// ---------------------------------------------------------------- PWA 静态文件
if (existsSync(config.webDist)) {
	app.use("/*", serveStatic({ root: config.webDist }));
	const index = readFileSync(join(config.webDist, "index.html"), "utf8");
	app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not_found" }, 404) : c.html(index)));
} else {
	app.get("/", (c) => c.text("Web UI 尚未构建：npm run build -w apps/web"));
}

// ---------------------------------------------------------------- 启动 HTTP + WebSocket
export function startHttp() {
	const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	const clients = new Map<WebSocket, { deviceId: string | null; authed: boolean }>();
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://x");
		if (url.pathname !== "/ws") return socket.destroy();
		const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(",") : v] as [string, string]])));
		const local = isLocalRequest(req.socket.remoteAddress, headers);
		const ip = clientIp(req.socket.remoteAddress, headers);
		if (!local && !rateLimit(`ws:${ip}`, 30)) return socket.destroy();
		wss.handleUpgrade(req, socket, head, (ws) => {
			const st = { deviceId: null as string | null, authed: local };
			clients.set(ws, st);
			const timer = setTimeout(() => !st.authed && ws.close(4401, "unauthorized"), 5000);
			const hello = () => ws.send(JSON.stringify({ type: "hello", seq: bus.seq, serverId: identity().serverId, local }));
			if (local) hello();
			ws.on("message", (raw) => {
				let m: { type?: string; token?: string };
				try {
					m = JSON.parse(String(raw));
				} catch {
					return;
				}
				if (m.type === "auth" && !st.authed) {
					const d = deviceForToken(m.token);
					if (!d) return ws.close(4401, "unauthorized");
					st.authed = true;
					st.deviceId = d;
					clearTimeout(timer);
					hello();
				} else if (m.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
			});
			ws.on("close", () => clients.delete(ws));
		});
	});
	bus.on((e) => {
		const data = JSON.stringify(e);
		for (const [ws, st] of clients) {
			if (!st.authed) continue;
			if (e.type === "device.revoked" && st.deviceId === e.deviceId) {
				ws.close(4401, "revoked");
				continue;
			}
			ws.send(data);
		}
	});
	setInterval(() => {
		for (const ws of clients.keys()) ws.ping();
	}, 25_000).unref();
	return server;
}
