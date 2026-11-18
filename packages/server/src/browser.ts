/**
 * 助理的浏览器（给 ext-browser 提供 BrowserContext）：
 *  - 助理电脑在运行：连接容器里有界面的 Chromium（CDP，经 127.0.0.1 端口映射），「电脑」实时画面里可见，
 *    用户可以随时接管（扫码 / 验证码 / 登录）；
 *  - 否则：本机无头 Chrome / Edge / Chromium，每个助理独立的持久化用户目录（数据目录/agents/<id>/browser-profile），
 *    与用户自己的浏览器完全隔离。工作区画面和接管始终复用同一个 Page，不重开实例。
 * Playwright 只用公开 API（playwright-core：connectOverCDP / launchPersistentContext）。
 */
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BrowserPages } from "./browser-pages.ts";
import { desktopPause } from "./desktop.ts";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { config } from "./config.ts";
import { computerFor, desktopStatus, ensureDesktopBrowser, SHARED } from "./desktop.ts";
import { envStrings, nativeLaunchEnvForChild } from "./native-launch-env.ts";

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
	runtimeId: string;
	mode: "sandbox" | "host";
	/** sandbox：连的是哪台电脑（换了电脑要重连） */
	computer?: string;
	ctx: BrowserContext;
	browser?: Browser;
}
const sessions = new Map<string, Session>();
const starting = new Map<string, Promise<Session>>();

export const profileDir = (agentId: string) => join(config.agentsDir, agentId.replace(/[^a-zA-Z0-9_-]/g, ""), "browser-profile");

async function open(agentId: string): Promise<Session> {
	const desk = await desktopStatus(agentId).catch(() => null);
	if (desk?.state === "running" && desk.cdpPort) {
		const base = await ensureDesktopBrowser(agentId);
		// 容器里 Chromium 报的 ws 地址是容器内端口，换成宿主映射端口
		const v = (await (await fetch(`${base}/json/version`)).json()) as { webSocketDebuggerUrl: string };
		const ws = v.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, base.replace(/^http/, "ws"));
		const browser = await chromium.connectOverCDP(ws, { timeout: 20_000 });
		const ctx = browser.contexts()[0] ?? (await browser.newContext());
		const s: Session = { runtimeId: randomUUID(), mode: "sandbox", ctx, browser, computer: computerFor(agentId) };
		browser.on("disconnected", () => { if (sessions.get(agentId) === s) { sessions.delete(agentId); registries.get(agentId)?.invalidate(); } });
		return s;
	}
	const exe = findChrome();
	if (!exe) throw new Error("没有可用的浏览器：请启动「助理电脑」，或在这台电脑上安装 Chrome / Edge");
	const dir = profileDir(agentId);
	mkdirSync(dir, { recursive: true });
	const ctx = await chromium.launchPersistentContext(dir, {
		executablePath: exe,
		headless: true,
		viewport: { width: 1280, height: 860 },
		locale: "zh-CN",
		timezoneId: "Asia/Shanghai",
		acceptDownloads: true,
		// 本机 Chrome 是原生进程：给它 OS 账户家目录（隔离启动时服务的合成 HOME 不能传下去，见 native-launch-env.ts）。
		env: envStrings(nativeLaunchEnvForChild(undefined, { syntheticRoots: [config.dataDir] }).env),
		args: ["--no-first-run", "--no-default-browser-check", ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
	});
	const s: Session = { runtimeId: randomUUID(), mode: "host", ctx };
	ctx.on("close", () => { if (sessions.get(agentId) === s) { sessions.delete(agentId); registries.get(agentId)?.invalidate(); } });
	return s;
}

export async function browserFor(agentId: string): Promise<Session> {
	const cur = sessions.get(agentId);
	if (cur) {
		// 页运行期间固定环境。电脑变更不能静默销毁 DOM / Cookie / 在途动作。
		if (cur.mode === "sandbox" && cur.computer !== computerFor(agentId)) throw new Error("助理电脑已变化，原网页仍留在原环境。请明确结束原浏览器后再打开新环境。");
		return cur;
	}
	const p = starting.get(agentId) ?? open(agentId).finally(() => starting.delete(agentId));
	starting.set(agentId, p);
	const s = await p;
	sessions.set(agentId, s);
	return s;
}
export const browserMode = (agentId: string) => sessions.get(agentId)?.mode ?? "host";
/** 共用浏览器：这个助理连的是共用电脑上的 Chromium（和其他助理共用登录状态，只操作自己的标签页） */
export const browserShared = (agentId: string) => sessions.get(agentId)?.mode === "sandbox" && sessions.get(agentId)?.computer === SHARED;
/**
 * 单独的浏览器环境（browser_context isolated）：同一个浏览器里新开一个独立上下文，不带共用的 cookie / 登录状态，
 * 关掉就清空。助理电脑里在主屏幕上可见；本机模式下是一个独立的无头浏览器。
 */
export async function isolatedContext(agentId: string): Promise<BrowserContext> {
	const s = await browserFor(agentId);
	if (s.mode === "sandbox" && s.browser) return s.browser.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: null });
	const exe = findChrome();
	if (!exe) throw new Error("没有可用的浏览器");
	const b = await chromium.launch({ executablePath: exe, headless: true, env: envStrings(nativeLaunchEnvForChild(undefined, { syntheticRoots: [config.dataDir] }).env), args: ["--no-first-run", "--no-default-browser-check", ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])] });
	const ctx = await b.newContext({ locale: "zh-CN", timezoneId: "Asia/Shanghai", viewport: { width: 1280, height: 860 }, acceptDownloads: true });
	ctx.on("close", () => void b.close().catch(() => {}));
	return ctx;
}

const registries = new Map<string, BrowserPages>();
/** 查看读取不调用 browserFor，不会为了查看启动浏览器或 VM。 */
export const existingBrowserPages = (agentId: string) => registries.get(agentId);
export const browserRuntimeMode = (agentId: string) => sessions.get(agentId)?.mode ?? null;
export function browserPagesFor(agentId: string) {
	let pages = registries.get(agentId);
	if (!pages) {
		pages = new BrowserPages(agentId, { context: () => browserFor(agentId), isolated: () => isolatedContext(agentId), paused: () => desktopPause.isPaused(agentId), pauseVersion: () => desktopPause.version(agentId) });
		registries.set(agentId, pages);
	}
	return pages;
}

export async function closeBrowser(agentId: string) {
	const s = sessions.get(agentId);
	sessions.delete(agentId);
	await registries.get(agentId)?.dispose();
	registries.delete(agentId);
	if (!s) return;
	// 助理电脑里的浏览器只断开连接、不关闭（登录态和窗口留给用户）
	if (s.mode === "sandbox") await s.browser?.close().catch(() => {});
	else await s.ctx.close().catch(() => {});
}
export async function closeAllBrowsers() {
	await Promise.all([...sessions.keys()].map(closeBrowser));
}
