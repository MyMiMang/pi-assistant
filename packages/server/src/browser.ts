/**
 * 助理的浏览器（给 ext-browser 提供 BrowserContext）：
 *  - 助理电脑在运行：连接容器里有界面的 Chromium（CDP，经 127.0.0.1 端口映射），「电脑」实时画面里可见，
 *    用户可以随时接管（扫码 / 验证码 / 登录）；
 *  - 否则：本机无头 Chrome / Edge / Chromium，每个助理独立的持久化用户目录（数据目录/agents/<id>/browser-profile），
 *    与用户自己的浏览器完全隔离。接管时临时换成有界面的窗口（在这台电脑上操作），手机上收到截图。
 * Playwright 只用公开 API（playwright-core：connectOverCDP / launchPersistentContext）。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { config } from "./config.ts";
import { desktopStatus, ensureDesktopBrowser } from "./desktop.ts";

/** 本机可用的 Chromium 系浏览器（PIA_CHROME 优先） */
export function findChrome(): string | null {
	const env = process.env.PIA_CHROME;
	if (env && existsSync(env)) return env;
	const pf = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
	const cands =
		process.platform === "darwin"
			? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]
			: process.platform === "win32"
				? pf.flatMap((d) => [join(d, "Google/Chrome/Application/chrome.exe"), join(d, "Microsoft/Edge/Application/msedge.exe")])
				: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
	return cands.find((c) => existsSync(c)) ?? null;
}

interface Session {
	mode: "sandbox" | "host";
	ctx: BrowserContext;
	browser?: Browser;
	headed?: boolean;
}
const sessions = new Map<string, Session>();
const starting = new Map<string, Promise<Session>>();

export const profileDir = (agentId: string) => join(config.agentsDir, agentId.replace(/[^a-zA-Z0-9_-]/g, ""), "browser-profile");

async function open(agentId: string, opts: { headed?: boolean } = {}): Promise<Session> {
	const desk = await desktopStatus(agentId).catch(() => null);
	if (desk?.state === "running" && desk.cdpPort) {
		const base = await ensureDesktopBrowser(agentId);
		// 容器里 Chromium 报的 ws 地址是容器内端口，换成宿主映射端口
		const v = (await (await fetch(`${base}/json/version`)).json()) as { webSocketDebuggerUrl: string };
		const ws = v.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, base.replace(/^http/, "ws"));
		const browser = await chromium.connectOverCDP(ws, { timeout: 20_000 });
		const ctx = browser.contexts()[0] ?? (await browser.newContext());
		const s: Session = { mode: "sandbox", ctx, browser };
		browser.on("disconnected", () => sessions.get(agentId) === s && sessions.delete(agentId));
		return s;
	}
	const exe = findChrome();
	if (!exe) throw new Error("没有可用的浏览器：请启动「助理电脑」，或在这台电脑上安装 Chrome / Edge");
	const dir = profileDir(agentId);
	mkdirSync(dir, { recursive: true });
	const ctx = await chromium.launchPersistentContext(dir, {
		executablePath: exe,
		headless: !opts.headed,
		viewport: opts.headed ? null : { width: 1280, height: 860 },
		locale: "zh-CN",
		timezoneId: "Asia/Shanghai",
		acceptDownloads: true,
		args: ["--no-first-run", "--no-default-browser-check", ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
	});
	const s: Session = { mode: "host", ctx, headed: !!opts.headed };
	ctx.on("close", () => sessions.get(agentId) === s && sessions.delete(agentId));
	return s;
}

export async function browserFor(agentId: string): Promise<Session> {
	const cur = sessions.get(agentId);
	if (cur) {
		// 助理电脑后来启动了 → 改用它的浏览器（用户能看见）
		const desk = cur.mode === "host" ? await desktopStatus(agentId).catch(() => null) : null;
		if (!(desk?.state === "running" && desk.cdpPort)) return cur;
		await closeBrowser(agentId);
	}
	const p = starting.get(agentId) ?? open(agentId).finally(() => starting.delete(agentId));
	starting.set(agentId, p);
	const s = await p;
	sessions.set(agentId, s);
	return s;
}
export const browserMode = (agentId: string) => sessions.get(agentId)?.mode ?? "host";

/** 本机模式接管：换成有界面的窗口（同一个用户目录），把当前网址带过去；结束后再换回无头 */
export async function setHeaded(agentId: string, headed: boolean, url?: string) {
	const cur = sessions.get(agentId);
	if (!cur || cur.mode !== "host" || !!cur.headed === headed) return;
	await closeBrowser(agentId);
	const s = await open(agentId, { headed });
	sessions.set(agentId, s);
	if (url && url !== "about:blank") await (s.ctx.pages()[0] ?? (await s.ctx.newPage())).goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
}

export async function closeBrowser(agentId: string) {
	const s = sessions.get(agentId);
	sessions.delete(agentId);
	if (!s) return;
	// 助理电脑里的浏览器只断开连接、不关闭（登录态和窗口留给用户）
	if (s.mode === "sandbox") await s.browser?.close().catch(() => {});
	else await s.ctx.close().catch(() => {});
}
export async function closeAllBrowsers() {
	await Promise.all([...sessions.keys()].map(closeBrowser));
}
