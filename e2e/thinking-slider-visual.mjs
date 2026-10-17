/**
 * 思考强度滑块「视觉」验收：真实服务端 + 真实 React 构建 + Chromium，出真实产品截图。
 *
 * 对应用户 2026-10-17 给的最终参考图：粗饱满渐变胶囊轨道 + 右侧实心高对比圆钮（钮内无字）、
 * 顶部当前档中文突出、次行模型名、左上轻思考图标、右上跟随 / 重置。只验形态与主题 token 生效，
 * 不改语义：档位仍来自模型目录（7 档里支持的子集）、点 / 拖 / 键盘行为由 thinking-slider-ui.mjs 覆盖。
 *
 * 断言：弹层宽 320–360、轨道高 32–42、滑钮 40–48 且无内部文字、实心非透明、
 *       off / max 两端不越出轨道、390 宽不横向溢出、四内置主题 + DIY 主题真的走各自 token
 *       （pixel 阶梯圆角、glass 通透、DIY 的 --acc 生效）、reduce 下不播预览。
 * 截图：docs/screenshots/thinking-slider-*.png（真实产品界面，不是设计稿 HTML）。
 *
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 运行：node e2e/thinking-slider-visual.mjs
 * 临时 data / workspace / HOME / TMPDIR 都在本次 mkdtemp 里，finally 只删本次目录；不碰真实数据。
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, "docs/screenshots");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_DIR = mkdtempSync(join(tmpdir(), "pia-e2e-thinking-visual-"));
const DATA = join(RUN_DIR, "data");
const WORKSPACE = join(RUN_DIR, "workspace");
const FAKE_HOME = join(RUN_DIR, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(FAKE_HOME, { recursive: true });
mkdirSync(OUT, { recursive: true });

const MAIN = "anthropic.claude-sonnet-5";
const PORT = await new Promise((r) => {
	const s = createNetServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, cond, detail = "") => {
	results.push([cond ? "✅" : "❌", name, cond ? "" : detail]);
	console.log(`${cond ? "✅" : "❌"} ${name}${cond ? "" : ` ${detail}`}`);
};
const waitFor = async (fn, ms = 20_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("timeout");
};
const j = async (path, method = "GET", body) => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
	return data;
};

/* -------- DIY 主题（与 AI 引擎同 schema；种进 localStorage = 应用真实的持久化读入路径） -------- */
const DIY_ID = "e2e-visual-diy";
const DIY_ACC = "#8b5cf6";
const DIY_ACC2 = "#22d3ee";
const tokens = (bg, fg, acc, acc2) => ({
	"--bg": bg, "--side": bg, "--panel": bg, "--card": bg, "--fg": fg, "--mut": fg, "--mut2": fg, "--line": bg, "--line-strong": bg, "--hover": bg, "--active": bg,
	"--user-bg": bg, "--user-fg": fg, "--acc": acc, "--acc2": acc2, "--acc-fg": "#ffffff", "--acc-soft": "rgba(139,92,246,.16)", "--ok": "#5f8a5a", "--warn": "#c08a2c", "--z-light": "#ffffff", "--z-dark": "#1b1b22",
});
const DIY_MANIFEST = {
	manifestVersion: 1, id: DIY_ID, name: "E2E 视觉 DIY", author: "e2e", basedOn: "noir",
	modes: { light: tokens("#f4f2fb", "#1f1b2e", "#7c3aed", "#0ea5e9"), dark: tokens("#100e18", "#f2eefc", DIY_ACC, DIY_ACC2) },
	decor: { texture: "none", corner: "round", shadow: "soft", background: "flat" },
	motion: { style: "smooth", scale: 1.15, glow: "subtle" },
	createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

const server = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
	cwd: ROOT,
	env: { ...process.env, HOME: FAKE_HOME, TMPDIR: RUN_DIR, PIA_DATA_DIR: DATA, PIA_WORKSPACE: WORKSPACE, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT), PIA_HOST_CONTROL_DRY_RUN: "1" },
	stdio: ["ignore", "pipe", "pipe"],
	detached: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => !String(d).includes("ExperimentalWarning") && process.stdout.write(`[server!] ${d}`));
const killServerTree = (sig = "SIGTERM") => {
	if (server.exitCode !== null || server.pid === undefined) return;
	try { process.kill(-server.pid, sig); } catch { try { server.kill(sig); } catch {} }
};
process.on("exit", () => killServerTree("SIGKILL"));

let browser;
try {
	await waitFor(async () => (await fetch(`${BASE}/api/system`)).ok);
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = await j("/api/agents", "POST", { name: "滑块视觉" });
	const prov = await j("/api/models/custom", "POST", {
		name: "视觉中转", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true,
		models: [{ id: MAIN, reasoning: true }],
	});
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: prov.id, id: MAIN } });
	await j("/api/models/default", "PUT", { provider: prov.id, model: MAIN, thinking: "medium" });
	const catalog = await j("/api/models");
	const full = catalog.find((m) => m.provider === prov.id && m.id === MAIN);
	if (full?.thinking?.length !== 7) throw new Error(`目录里 ${MAIN} 应支持七档：${JSON.stringify(full?.thinking)}`);

	browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, locale: "zh-CN", colorScheme: "dark" });
	await ctx.addInitScript((manifest) => {
		if (!localStorage.getItem("pia.customThemes")) localStorage.setItem("pia.customThemes", JSON.stringify([manifest]));
	}, DIY_MANIFEST);
	const page = await ctx.newPage();
	page.setDefaultTimeout(20_000);
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

	const popover = () => page.getByTestId("agent-subagent-thinking-menu");
	/** 真实入口：信息面板 › 设置 tab › 子代理默认的「思考强度」按钮 */
	const openThinking = async () => {
		await page.goto(`${BASE}/?agent=${agent.id}`);
		await page.waitForSelector("button[aria-label='信息面板']");
		await page.waitForTimeout(400);
		if (!(await page.locator(".pa-pane-wrap").isVisible().catch(() => false))) await page.getByRole("button", { name: "信息面板" }).click();
		await page.locator(".pa-pane-wrap").waitFor({ state: "visible" });
		const bar = page.getByTestId("info-tabs");
		const tab = bar.getByRole("tab", { name: "设置", exact: true });
		if (await tab.count()) await tab.click();
		else {
			await page.getByTestId("info-tabs-more").click();
			await page.getByTestId("info-tabs-menu").getByRole("menuitem", { name: "设置", exact: true }).click();
		}
		await page.getByTestId("agent-subagent-thinking").click();
		await popover().waitFor();
		await waitFor(async () => (await popover().locator(".pa-think-step").count()) > 0);
		return popover();
	};
	const closeThinking = async () => {
		if (await popover().count()) await page.keyboard.press("Escape");
		await popover().waitFor({ state: "detached" }).catch(() => {});
	};
	const geometry = () =>
		popover().evaluate((el) => {
			const q = (s) => el.querySelector(s);
			const box = (s) => {
				const r = q(s)?.getBoundingClientRect();
				return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
			};
			const handle = q(".pa-think-handle");
			const hs = handle ? getComputedStyle(handle) : null;
			const pop = el.getBoundingClientRect();
			return {
				pop: { w: pop.width, h: pop.height },
				rail: box(".pa-think-rail"),
				inner: box(".pa-think-track-inner"),
				handle: box(".pa-think-handle"),
				handleText: handle ? handle.textContent.trim() : "<none>",
				handleBg: hs ? hs.backgroundColor : "",
				handleRadius: hs ? hs.borderRadius : "",
				handleShadow: hs ? hs.boxShadow : "",
				cur: q(".pa-think-cur")?.textContent ?? "",
				curColor: q(".pa-think-cur") ? getComputedStyle(q(".pa-think-cur")).color : "",
				model: q(".pa-think-model")?.textContent ?? "",
				hasLabelsRow: !!q(".pa-think-labels"),
				starCount: el.querySelectorAll(".pa-think-star").length,
				acc: getComputedStyle(el).getPropertyValue("--acc").trim(),
				skin: document.documentElement.dataset.skin,
				overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			};
		});
	const shapeCheck = async (tag, opts = {}) => {
		const g = await geometry();
		if (!opts.sheet) check(`${tag}：弹层宽 320–360（${Math.round(g.pop.w)}）`, g.pop.w >= 320 && g.pop.w <= 360, JSON.stringify(g.pop));
		check(`${tag}：轨道高 32–42（${Math.round(g.rail.h)}）`, g.rail.h >= 32 && g.rail.h <= 42, JSON.stringify(g.rail));
		check(`${tag}：轨道命中区 ≥44（${Math.round(g.inner.h)}）`, g.inner.h >= 44, JSON.stringify(g.inner));
		check(`${tag}：滑钮 40–48（${Math.round(g.handle.w)}×${Math.round(g.handle.h)}）`, g.handle.w >= 40 && g.handle.w <= 48 && g.handle.h >= 40 && g.handle.h <= 48, JSON.stringify(g.handle));
		check(`${tag}：滑钮内无档位文字`, g.handleText === "", g.handleText);
		check(`${tag}：滑钮实心（非透明）`, !!g.handleBg && g.handleBg !== "rgba(0, 0, 0, 0)" && g.handleBg !== "transparent", g.handleBg);
		check(`${tag}：没有一排 7 个小标签`, !g.hasLabelsRow);
		check(`${tag}：顶部当前档 = 中文名`, g.cur.length > 0, g.cur);
		return g;
	};
	const switchSkin = async (skin) => {
		await page.goto(`${BASE}/?agent=${agent.id}&settings=appearance`);
		await page.getByTestId("settings-dialog").waitFor();
		await page.locator(`[data-theme-id="${skin}"]`).click();
		await page.keyboard.press("Escape");
		await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
		await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.skin)) === skin);
	};
	const shot = async (name) => {
		const path = join(OUT, name);
		await popover().screenshot({ path });
		console.log(`  📷 ${path.replace(ROOT, "")}`);
		return path;
	};

	/* ------------------------------- 桌面 · 四内置主题 + DIY ------------------------------- */
	for (const skin of ["noir", "glass", "warm", "pixel"]) {
		await switchSkin(skin);
		await openThinking();
		const g = await shapeCheck(skin);
		if (skin === "pixel") {
			check("pixel：滑钮走阶梯（border-radius 0 + clip-path）", g.handleRadius === "0px", g.handleRadius);
			const clip = await popover().locator(".pa-think-handle").evaluate((el) => getComputedStyle(el).clipPath);
			check("pixel：滑钮是阶梯切角", clip.includes("polygon"), clip);
		}
		if (skin === "glass") {
			const bf = await popover().evaluate((el) => getComputedStyle(el).backdropFilter);
			check("glass：弹层通透（backdrop blur）", bf.includes("blur"), bf);
		}
		await shot(`thinking-slider-popover-${skin}.png`);
		if (skin === "noir") {
			// 上下文截图：真实页面里弹层贴在哪里、和输入栏 / 信息面板的关系（CSS 像素，不放大）
			await page.screenshot({ path: join(OUT, "thinking-slider-in-context.png"), scale: "css" });
			console.log("  📷 docs/screenshots/thinking-slider-in-context.png");
		}
		await closeThinking();
	}

	await switchSkin(`custom-${DIY_ID}`);
	await openThinking();
	const diy = await shapeCheck("DIY");
	check(`DIY：主题 --acc 生效（${diy.acc}）`, diy.acc.toLowerCase() === DIY_ACC, diy.acc);
	check("DIY：当前档文字用主题 accent 上色", diy.curColor === "rgb(139, 92, 246)", diy.curColor);
	await shot("thinking-slider-popover-diy.png");

	/* ---------------------------------- 拖动到两端（不越界） ---------------------------------- */
	{
		const inner = await popover().locator(".pa-think-track-inner").boundingBox();
		const y = inner.y + inner.height / 2;
		await page.mouse.move(inner.x + inner.width * 0.5, y);
		await page.mouse.down();
		await page.mouse.move(inner.x + inner.width, y, { steps: 4 });
		await page.waitForTimeout(120);
		const g = await geometry();
		check("max：滑钮完整落在轨道内（不越出右侧）", g.handle.x + g.handle.w <= g.inner.x + g.inner.w + 1, JSON.stringify({ h: g.handle, i: g.inner }));
		check("max：拖动中有一次性星点预览", (await popover().locator(".pa-think-pulse").count()) === 1);
		await shot("thinking-slider-drag-max.png");
		await page.mouse.move(inner.x, y, { steps: 4 });
		await page.waitForTimeout(120);
		const g0 = await geometry();
		check("off：滑钮完整落在轨道内（不越出左侧）", g0.handle.x >= g0.inner.x - 1, JSON.stringify({ h: g0.handle, i: g0.inner }));
		check("off：静止没有星点（无假进度）", g0.starCount === 0, String(g0.starCount));
		await page.keyboard.press("Escape");
		await page.mouse.up();
		await popover().waitFor({ state: "detached" });
	}

	/* -------------------------------------- 390 窄屏 -------------------------------------- */
	await page.setViewportSize({ width: 390, height: 780 });
	await switchSkin("noir");
	await openThinking();
	const narrow = await shapeCheck("390", { sheet: true });
	// ≤640 时 .pa-pop 会变成左右各 8px 的底部弹窗（既有行为），所以这里只要求铺满可用宽度且不溢出
	check(`390：底部弹窗铺满可用宽度（${Math.round(narrow.pop.w)}）`, narrow.pop.w >= 320 && narrow.pop.w <= 390 - 8, JSON.stringify(narrow.pop));
	check("390：不横向溢出", narrow.overflow <= 2, String(narrow.overflow));
	await popover().screenshot({ path: join(OUT, "thinking-slider-popover-390.png") });
	console.log("  📷 docs/screenshots/thinking-slider-popover-390.png");
	await closeThinking();

	/* ------------------------- 输入栏模型菜单里的同一组件（窄容器） ------------------------- */
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.getByTestId("model-picker").waitFor();
	await page.getByTestId("model-picker").click();
	await page.getByTestId("model-menu").waitFor();
	await page.locator('[data-testid="model-menu"] [data-testid="thinking-body"]').waitFor();
	await page.locator('[data-testid="model-menu"]').screenshot({ path: join(OUT, "thinking-slider-composer-menu.png") });
	console.log("  📷 docs/screenshots/thinking-slider-composer-menu.png");
	const menuShape = await page.locator('[data-testid="model-menu"] .pa-think-handle').evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { w: r.width, h: r.height, text: el.textContent.trim(), bg: getComputedStyle(el).backgroundColor };
	});
	check("模型菜单：同一滑块（实心圆钮、无内部文字）", menuShape.text === "" && menuShape.w >= 40 && menuShape.bg !== "rgba(0, 0, 0, 0)", JSON.stringify(menuShape));
	await page.keyboard.press("Escape");

	/* ---------------------------------- reduce 静态同样清楚 ---------------------------------- */
	await page.emulateMedia({ reducedMotion: "reduce" });
	await openThinking();
	const reduced = await shapeCheck("reduce");
	const inner = await popover().locator(".pa-think-track-inner").boundingBox();
	await page.mouse.move(inner.x + inner.width * 0.5, inner.y + inner.height / 2);
	await page.mouse.down();
	await page.mouse.move(inner.x + inner.width * 0.8, inner.y + inner.height / 2, { steps: 3 });
	await page.waitForTimeout(150);
	check("reduce：不播预览动效（无 pa-think-pulse）", (await popover().locator(".pa-think-pulse").count()) === 0);
	await popover().screenshot({ path: join(OUT, "thinking-slider-reduced.png") });
	console.log("  📷 docs/screenshots/thinking-slider-reduced.png");
	check("reduce：滑钮仍实心可辨", reduced.handleBg !== "rgba(0, 0, 0, 0)");
	await page.keyboard.press("Escape");
	await page.mouse.up();
	await page.emulateMedia({ reducedMotion: "no-preference" });

	check("全程无页面 JS 异常", pageErrors.length === 0, pageErrors.join(" | "));
	const passed = results.filter(([s]) => s === "✅").length;
	console.log(`\n[thinking-slider-visual] ${passed}/${results.length} 通过`);
} finally {
	await browser?.close().catch(() => {});
	if (server.exitCode === null) {
		const done = new Promise((r) => server.once("exit", r));
		killServerTree("SIGTERM");
		await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
		if (server.exitCode === null) killServerTree("SIGKILL");
	}
	if (RUN_DIR.startsWith(join(tmpdir(), "pia-e2e-thinking-visual-"))) rmSync(RUN_DIR, { recursive: true, force: true });
}
const failed = results.filter(([s]) => s === "❌");
if (failed.length) console.log(failed.map(([, n, e]) => `- ${n}: ${e}`).join("\n"));
process.exitCode = failed.length ? 1 : 0;
