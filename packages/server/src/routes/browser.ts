import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Hono } from "hono";
import { WebSocketServer } from "ws";
import { sameBrowserIdentity, type BrowserIdentity, type BrowserInput } from "@pi-assistant/shared";
import { browserRuntimeMode, existingBrowserPages } from "../browser.ts";
import { browserFrames } from "../browser-frames.ts";
import { desktopPause } from "../desktop.ts";
import { getAgent } from "../agent-runtime/rows.ts";
import { getDevice } from "../auth.ts";
import { entryDomain } from "../tunnel.ts";
import type { Env } from "./common.ts";

interface Ticket { agentId: string; identity: BrowserIdentity; deviceId: string | null; origin: string; expires: number }
const tickets = new Map<string, Ticket>();
function originAllowed(origin: string | null | undefined, host: string, protocol: string) {
	return !!origin && origin !== "null" && (origin === `${protocol}://${host}` || (!!entryDomain() && origin === `https://${entryDomain()}`));
}
export function mountBrowserRoutes(app: Hono<Env>) {
	// API 默认对非 null origin 只做 CORS，本路由另作明确拒绝；不允许跨站借本机免登录读取/控制页面。
	app.use("/api/agents/:id/browser/*", async (c, next) => {
		const url = new URL(c.req.url), origin = c.req.header("origin");
		if (origin && !originAllowed(origin, c.req.header("host") ?? url.host, url.protocol.slice(0, -1))) return c.json({ error: "forbidden_origin" }, 403);
		if (!getAgent(c.req.param("id")!)) return c.json({ error: "助理不存在" }, 404);
		return next();
	});
	app.get("/api/agents/:id/browser/state", async (c) => {
		const id = c.req.param("id"), registry = existingBrowserPages(id);
		return c.json({ pages: await registry?.info() ?? [], current: registry?.selected()?.identity.pageId ?? null, mode: browserRuntimeMode(id), paused: desktopPause.isPaused(id) });
	});
	app.post("/api/agents/:id/browser/ticket", async (c) => {
		try {
			const agentId = c.req.param("id"), body = await c.req.json<{ pageId: string }>();
			const record = existingBrowserPages(agentId)?.get(body.pageId);
			if (!record) return c.json({ error: "还没有打开网页" }, 404);
			const now = Date.now();
			for (const [key, t] of tickets) if (t.expires < now) tickets.delete(key);
			if (tickets.size >= 256) return c.json({ error: "查看连接过多，请稍后重试" }, 429);
			const ticket = randomBytes(24).toString("base64url");
			const url = new URL(c.req.url);
			tickets.set(ticket, { agentId, identity: { ...record.identity }, deviceId: c.get("caller").deviceId, origin: c.req.header("origin") ?? url.origin, expires: now + 30_000 });
			return c.json({ ticket });
		} catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
	});
}
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
export function upgradeBrowserViewer(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
	const key = url.searchParams.get("ticket") ?? "", ticket = tickets.get(key);
	tickets.delete(key);
	if (!ticket || ticket.expires < Date.now() || req.headers.origin !== ticket.origin || !(originAllowed(req.headers.origin, req.headers.host ?? "", "http") || originAllowed(req.headers.origin, req.headers.host ?? "", "https"))) return socket.destroy();
	const registry = existingBrowserPages(ticket.agentId);
	let record;
	try { record = registry?.get(ticket.identity.pageId); } catch { return socket.destroy(); }
	if (!record || !registry || !sameBrowserIdentity(record.identity, ticket.identity)) return socket.destroy();
	const pageRecord = record;
	wss.handleUpgrade(req, socket, head, (ws) => {
		const stream = browserFrames(pageRecord);
		let viewer: string | undefined, alive = true, pending = false;
		const send = (data: unknown) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };
		const authorized = () => { if (ticket.deviceId && getDevice(ticket.deviceId)?.status !== "active") { ws.close(4401, "revoked"); throw new Error("设备授权已撤销"); } };
		const state = async () => send({ type: "state", pages: await registry.info(), current: registry.selected()?.identity.pageId ?? null, mode: browserRuntimeMode(ticket.agentId), paused: desktopPause.isPaused(ticket.agentId) });
		void stream.subscribe((frame) => { try { authorized(); send(frame); } catch { /* connection closed */ } }).then((id) => { viewer = id; if (!alive) stream.unsubscribe(id); else { send({ type: "ready" }); void state(); } }).catch((e) => { send({ type: "error", error: String(e) }); ws.close(); });
		const timer = setInterval(() => { try { authorized(); if (ws.readyState !== 1) return; if (ws.bufferedAmount > 4 * 1024 * 1024) ws.close(4408, "slow_viewer"); else ws.ping(); } catch { /* revoked */ } }, 15_000);
		let lastPong = Date.now(); ws.on("pong", () => { lastPong = Date.now(); });
		const heartbeat = setInterval(() => { if (Date.now() - lastPong > 45_000) ws.terminate(); }, 15_000);
		ws.on("close", () => { alive = false; clearInterval(timer); clearInterval(heartbeat); if (viewer) stream.unsubscribe(viewer); });
		ws.on("error", () => ws.close());
		ws.on("message", (raw) => {
			let m: BrowserInput & { type: string; requestId?: string; width?: number; height?: number };
			try { authorized(); m = JSON.parse(String(raw)); } catch { return; }
			if (m.type === "ack") {
				try { if (!viewer) throw new Error("连接尚未准备好"); stream.ack(viewer, m, m.seq, m.width!, m.height!); send({ type: "drawn", seq: m.seq, ...pageRecord.identity }); }
				catch (e) { send({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
				return;
			}
			if (pending) return send({ type: "result", requestId: m.requestId, error: "上一步仍在进行，请等待；不要重放操作" });
			pending = true;
			void (async () => {
				try {
					authorized();
					if (m.type !== "select" && !sameBrowserIdentity(m, pageRecord.identity)) throw new Error("网页已变化，请重新读取");
					if (["takeover", "recover", "give-back"].includes(m.type) && m.controlGeneration !== pageRecord.control.generation) throw new Error("这次控制请求已过期，当前控制权保持不变");
					if (m.type === "takeover" || m.type === "recover") await registry.takeover(pageRecord.page, m.type === "recover");
					else if (m.type === "give-back") await registry.giveBack(pageRecord.page, m.controlGeneration);
					else if (m.type === "select") registry.select(pageRecord.page);
					else if (m.type === "close-page") {
						const pauseVersion = desktopPause.version(ticket.agentId);
						await pageRecord.control.run("user", m.controlGeneration, () => { authorized(); if (pauseVersion !== desktopPause.version(ticket.agentId)) throw new Error("暂停前的操作已取消"); }, () => pageRecord.page.close());
					}
					else if (m.type === "input") {
						if (!viewer) throw new Error("查看连接已断开");
						const pauseVersion = desktopPause.version(ticket.agentId);
						const check = () => { authorized(); if (pauseVersion !== desktopPause.version(ticket.agentId)) throw new Error("暂停前的操作已取消"); stream.check(viewer!, m, m.seq); };
						await pageRecord.control.run("user", m.controlGeneration, check, async (checkAgain) => {
							await stream.validateLayout(); checkAgain();
							const frame = stream.check(viewer!, m, m.seq);
							await executeViewerInput(pageRecord.page, m, frame.width, frame.height);
						});
					} else throw new Error("不支持的网页操作");
					send({ type: "result", requestId: m.requestId });
				} catch (e) { send({ type: "result", requestId: m.requestId, error: e instanceof Error ? e.message : String(e) }); }
				finally { pending = false; await state(); }
			})();
		});
	});
}
async function executeViewerInput(page: import("playwright-core").Page, input: BrowserInput, width: number, height: number) {
	if (input.kind === "click") {
		if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x! < 0 || input.y! < 0 || input.x! >= width || input.y! >= height) throw new Error("点击坐标无效");
		await page.mouse.click(input.x!, input.y!);
	} else if (input.kind === "wheel") {
		if (!Number.isFinite(input.deltaY) || Math.abs(input.deltaY!) > 3000) throw new Error("滚动距离无效");
		await page.mouse.wheel(0, input.deltaY!);
	} else if (input.kind === "text") {
		if (typeof input.text !== "string" || input.text.length > 8000) throw new Error("输入内容过长");
		await page.keyboard.insertText(input.text);
	} else if (input.kind === "key") {
		if (typeof input.key !== "string" || !/^(?:(?:Control|Meta|Shift|Alt)\+)*(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Space)$/.test(input.key)) throw new Error("不支持这个按键");
		await page.keyboard.press(input.key);
	} else if (input.kind === "navigate") {
		if (input.url === "back") await page.goBack({ timeout: 30_000 });
		else if (input.url === "forward") await page.goForward({ timeout: 30_000 });
		else if (input.url === "reload") await page.reload({ timeout: 30_000 });
		else { const url = new URL(input.url ?? ""); if (!["http:", "https:"].includes(url.protocol)) throw new Error("请输入完整的 http 或 https 网页地址"); await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
	} else throw new Error("不支持的网页输入");
}
