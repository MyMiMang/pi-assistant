import { mountSubagentRoutes } from "./subagent-routes.ts";
import { mountThemeRoutes } from "./themes/routes.ts";
import { mountAsrRoutes, saveAsrSource } from "./voice/index.ts";
import { readVoiceSource, readVoiceSourceVersion, voiceSourceKeyPresent } from "./voice/source.ts";
import { localAsrService, setAsrSelectionPort } from "./local-asr/index.ts";
import { setAsrStreamSelectionVersion, setAsrStreamSourceReader } from "./local-asr/stream-hub.ts";
import { mountLocalAsrRoutes } from "./local-asr/routes.ts";
import "./local-asr/download.ts";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import { Hono, type Context } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { isOwnerDevice, clientIp, deviceForToken, isLocalRequest, rateLimit, touchDevice } from "./auth.ts";
import { bus } from "./bus.ts";
import { config } from "./config.ts";
import { getFile } from "./files.ts";
import { identity } from "./identity.ts";
import { desktopStatus, startIdleWatcher, useTicket, viewerClose, viewerOpen, viewToken } from "./desktop.ts";
import "./desktop/image-download.ts";
import { syncMcpDownloads } from "./mcp-install.ts";
import { agentBusy } from "./runtime.ts";
import { entryDomain } from "./tunnel.ts";
import { runRoutine, verifyWebhook } from "./routines.ts";
import { signedPath, verifySigned } from "./channels/media.ts";
import { startHousekeeping } from "./housekeeping.ts";
import { wecomCallback } from "./channels/index.ts";
import { mountImageRoutes } from "./image-gen/routes.ts";
import { mountPetRoutes } from "./pet/routes.ts";
import { mountUsageRoutes } from "./usage/routes.ts";
import { localOnly, sendFile, type Env } from "./routes/common.ts";
import { mountSystemRoutes } from "./routes/system.ts";
import { mountRoomRoutes } from "./routes/rooms.ts";
import { mountChatProjectRoutes } from "./routes/chat-projects.ts";
import { mountAgentRoutes } from "./routes/agents.ts";
import { mountModelRoutes } from "./routes/models.ts";
import { mountWorkItemRoutes } from "./routes/work-items.ts";
import { mountDesktopRoutes, deskChanged } from "./routes/desktop.ts";
import { mountMemoryRoutes } from "./routes/memory.ts";
import { mountRoutineRoutes } from "./routes/routines.ts";
import { mountRemoteRoutes } from "./routes/remote.ts";
import { mountChannelRoutes } from "./routes/channels.ts";
import { mountHostControlRoutes } from "./routes/host-control.ts";
import { mountMcpRoutes } from "./routes/mcp.ts";
import { mountSkillRoutes } from "./routes/skills.ts";
import { mountToolBridgeRoutes } from "./routes/tool-bridge.ts";

const app = new Hono<Env>();
const PLAY_LINK_TTL = 4 * 3600_000;

// 响应压缩：只压 JSON。
//  - 作用范围限定在 /api 的 JSON（聊天 / 列表接口），不是全局盲压：文件下载（octet-stream / text 附件）、
//    图片、SSE 都不在过滤范围内；LLM 流式走 llm-proxy 的原生 res（不进 Hono fetch），不受影响。
//  - 静态资源压缩在构建期预生成 .gz 旁路（apps/web/vite.config.ts），由 serveStatic({ precompressed: true }) 直接发出，
//    不经过这里现压。
//  - Hono compress 自动跳过已有 Content-Encoding / 206 / HEAD / no-transform，并补 Vary: Accept-Encoding、去掉 Content-Length。
app.use("*", compress({ encoding: "gzip", contentTypeFilter: /^application\/(?:json|[^;]*\+json)\b/i }));

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
			// 新增的三个 `blob:` 是功能必需，不是放宽策略：
			//  - script-src：语音输入的采集 worklet 用 `URL.createObjectURL(new Blob([...]))` 注入（Chromium 按 script-src 判定 worklet 模块，
			//    worker-src 不管用）；仍不允许 inline 脚本、不允许远程脚本（HTML / 首屏主题都用同源外部文件）。
			//  - object-src / frame-src：文件预览用 `<object data="blob:" type="application/pdf">`；Chromium 内置 PDF 查看器再把
			//    这个 blob 套一层 frame，两条都不写会被 default-src 'self' 拦掉。
			"default-src 'self'; script-src 'self' blob:; object-src 'self' blob:; frame-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'none'",
		);
});

app.use("/api/*", async (c, next) => {
	const origin = c.req.header("origin");
	const allowed = origin && ((!!entryDomain() && origin === `https://${entryDomain()}`) || origin === new URL(c.req.url).origin);
	if (allowed) {
		c.header("Access-Control-Allow-Origin", origin!);
		c.header("Vary", "Origin");
		c.header("Access-Control-Allow-Headers", "authorization, content-type, x-asr-seq, x-asr-agent, x-asr-conversation");
		c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
	}
	if (c.req.method === "OPTIONS") return c.body(null, 204);
	const local = isLocalRequest(remoteOf(c), c.req.raw.headers);
	const ip = clientIp(remoteOf(c), c.req.raw.headers);
	const auth = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
	const deviceId = local ? null : deviceForToken(auth);
	if (!local && !rateLimit(`ip:${ip}:${deviceId ? "auth" : "anon"}`, deviceId ? 600 : 30)) return c.json({ error: "rate_limited" }, 429);
	c.set("caller", { local, deviceId, ip, owner: isOwnerDevice(deviceId) });
	const pub = ["/api/pair/claim", "/api/pair/status/", "/api/system/public", "/hooks/"].some((p) => c.req.path.startsWith(p));
	if (!local && !deviceId && !pub) return c.json({ error: "unauthorized" }, 401);
	if (deviceId) touchDevice(deviceId, ip);
	return next();
});


mountSystemRoutes(app);
mountModelRoutes(app);
// 图片生成模型（image-gen/routes.ts）
mountImageRoutes(app, localOnly);
mountPetRoutes(app, localOnly);
mountUsageRoutes(app);
mountSubagentRoutes(app);
mountThemeRoutes(app);
// 本地 ASR 的来源读写直接接 voice 的 voiceSource（PUT /api/audio/asr/source 仍是唯一来源真相）。
// `present` 区分「从未设置（unset）」与「显式清空（null）」，供默认本地语音的自动准备判定。
setAsrSelectionPort({ read: readVoiceSource, version: readVoiceSourceVersion, write: (s, opts) => saveAsrSource(s, opts), present: voiceSourceKeyPresent });
// 流式会话绑定来源版本：期间来源被改选 → 明确取消，不 fallback 到别的模型。
setAsrStreamSelectionVersion(readVoiceSourceVersion);
// 省略 modelId 时优先用当前来源里的本地流式模型。
setAsrStreamSourceReader(readVoiceSource);
mountLocalAsrRoutes(app, localOnly, undefined, { service: localAsrService });
mountAsrRoutes(app);
mountAgentRoutes(app);
mountRoomRoutes(app);
mountChatProjectRoutes(app);
mountWorkItemRoutes(app);
mountMemoryRoutes(app);
mountSkillRoutes(app);
mountMcpRoutes(app);
// Claude Code 工具桥（本机 MCP，只收 127.0.0.1 + 随机令牌，不走设备登录）
mountToolBridgeRoutes(app);
syncMcpDownloads();

mountRoutineRoutes(app);
/** Webhook 触发（公开地址，凭 URL 里的密钥；请求体作为外部数据附在指令后） */
app.post("/hooks/:rid/:secret", async (c) => {
	const ip = c.get("caller").ip;
	if (!rateLimit(`hook:${c.req.param("rid")}`, 2, 5) || !rateLimit(`hookip:${ip}`, 10, 10)) return c.json({ error: "rate_limited" }, 429);
	const r = verifyWebhook(c.req.param("rid"), c.req.param("secret"));
	if (!r) return c.json({ error: "not_found" }, 404);
	if (r.status !== "active") return c.json({ error: "paused" }, 409);
	const body = (await c.req.text()).slice(0, 16_000);
	const run = runRoutine(r.id, "webhook", body || undefined);
	return c.json({ ok: true, runId: run.id, status: run.status }, 202);
});
// 渠道里发不了的文件：签名的公开下载链接（只在配置了固定地址时生成，7 天有效）
app.get("/hooks/dl/:id/:exp/:sig", (c) => {
	const id = c.req.param("id");
	if (!verifySigned(id, c.req.param("exp"), c.req.param("sig"))) return c.json({ error: "link_expired" }, 403);
	const f = getFile(id);
	if (!f || !existsSync(f.stored_path)) return c.json({ error: "not_found" }, 404);
	return sendFile(c, f.stored_path, f.name, f.mime);
});
/**
 * 视频 / 音频播放链接：<video src> 带不了 Authorization 头，所以登录后换一条只针对这一个文件的签名链接
 * （复用上面 /hooks/dl 的签名和路由，只是有效期缩到 4 小时；?inline=1 让它在页面里播放而不是下载）。
 */
app.get("/api/files/:id/play-link", (c) => {
	const f = getFile(c.req.param("id"));
	if (!f || !existsSync(f.stored_path)) return c.json({ error: "not_found" }, 404);
	return c.json({ url: `${signedPath(f.id, PLAY_LINK_TTL)}?inline=1` });
});
mountChannelRoutes(app);
/** 企业微信回调（公网经隧道访问；用 Token + EncodingAESKey 验签解密，不走设备登录） */
const wecomHook = async (c: Context<Env>) => {
	const r = wecomCallback(c.req.param("id") ?? "", c.req.method, c.req.query(), c.req.method === "POST" ? await c.req.text() : "");
	return c.text(r.body, r.status as 200);
};
app.get("/hooks/channels/wecom/:id", wecomHook);
app.post("/hooks/channels/wecom/:id", wecomHook);

mountHostControlRoutes(app);
mountDesktopRoutes(app);
startIdleWatcher({ busy: agentBusy, changed: deskChanged });
startHousekeeping();
mountRemoteRoutes(app);
// ---------------------------------------------------------------- PWA 静态文件
if (existsSync(config.webDist)) {
	/** 与构建期预压缩一致的文本类型；只有这些会有 .gz 旁路 / 需要按 Accept-Encoding 区分。 */
	const STATIC_COMPRESSIBLE = /\.(?:js|mjs|cjs|css|html|svg|json|webmanifest|txt|map)$/i;
	/** 静态资源缓存：内容哈希的 /assets/* 永久缓存；index.html / sw.js 每次校验（更新要及时）；其余静态 1 天。 */
	const staticCache = (path: string): string => {
		if (path === "/" || path === "/index.html" || path === "/sw.js") return "no-cache";
		if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
		return "public, max-age=86400";
	};
	app.use(
		"/*",
		serveStatic({
			root: config.webDist,
			// 构建期已生成 .gz 旁路：Accept-Encoding 含 gzip 时直接发压缩件，不每次现压 1.3MB 的 JS。
			precompressed: true,
			onFound: (_file, c) => {
				c.header("Cache-Control", staticCache(c.req.path));
				// 同一 URL 会按 Accept-Encoding 返回压缩 / 原始两种表示：对可压缩文本始终声明 Vary，避免缓存串味。
				if (STATIC_COMPRESSIBLE.test(c.req.path) && !c.res.headers.get("Vary")) c.header("Vary", "Accept-Encoding");
			},
		}),
	);
	const index = readFileSync(join(config.webDist, "index.html"), "utf8");
	app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not_found" }, 404) : (c.header("Cache-Control", "no-cache"), c.html(index))));
} else {
	app.get("/", (c) => c.text("Web UI 尚未构建：npm run build -w apps/web"));
}

// ---------------------------------------------------------------- 助理电脑实时画面：WebSocket 反向代理到容器的 noVNC（websockify）
const deskWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, handleProtocols: (p) => (p.has("binary") ? "binary" : false) });
async function proxyDesktop(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer, url: URL) {
	const t = useTicket(url.searchParams.get("ticket")); // 一次性票据：只能由已认证的设备/本机通过 API 申请
	if (!t) return socket.destroy();
	const { agentId } = t;
	const st = await desktopStatus(agentId);
	if (st.state !== "running" || !st.port) return socket.destroy();
	// 看哪块屏幕：票据里指定的（同一台电脑上的其他屏幕），默认这个助理自己用的屏幕；noVNC 按 token 转到那块屏幕
	const token = await viewToken(agentId, t.screen);
	deskWss.handleUpgrade(req, socket, head, (client) => {
		viewerOpen(agentId); // 有人在看画面：不会空闲关机
		client.once("close", () => viewerClose(agentId));
		const upstream = new WebSocket(`ws://127.0.0.1:${st.port}/websockify?token=${encodeURIComponent(token)}`, ["binary"]);
		const pending: (Buffer | ArrayBuffer | Buffer[])[] = [];
		upstream.on("open", () => pending.splice(0).forEach((d) => upstream.send(d)));
		upstream.on("message", (d, isBinary) => client.readyState === 1 && client.send(d, { binary: isBinary }));
		client.on("message", (d, isBinary) => (upstream.readyState === 1 ? upstream.send(d, { binary: isBinary }) : pending.push(d)));
		const close = () => (client.close(), upstream.close());
		upstream.on("close", close);
		upstream.on("error", close);
		client.on("close", close);
	});
}

// ---------------------------------------------------------------- 启动 HTTP + WebSocket
export function startHttp() {
	const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
	// 本地语音识别是可选模块（决策 0013）：启动时不自动下载，用户在 设置 › 语音 显式安装。
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
	const clients = new Map<WebSocket, { deviceId: string | null; authed: boolean }>();
	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://x");
		if (url.pathname === "/desktop/ws") return void proxyDesktop(req, socket, head, url);
		if (url.pathname !== "/ws") return socket.destroy();
		const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(",") : v] as [string, string]])));
		const local = isLocalRequest(req.socket.remoteAddress, headers);
		const ip = clientIp(req.socket.remoteAddress, headers);
		if (!local && !rateLimit(`ws:${ip}`, 30)) return socket.destroy();
		wss.handleUpgrade(req, socket, head, (ws) => {
			const st = { deviceId: null as string | null, authed: local };
			clients.set(ws, st);
			const timer = setTimeout(() => !st.authed && ws.close(4401, "unauthorized"), 5000);
			const hello = () => ws.send(JSON.stringify({ type: "hello", seq: bus.seq, serverId: identity().serverId, local: local || isOwnerDevice(st.deviceId) }));
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
