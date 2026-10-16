/**
 * UI 一致性与动效（本轮 scope）定向验证 —— **纯前端夹具**。
 *
 * 静态托管 apps/web/dist + page.route 拦所有 /api（不启动 packages/server、不碰真实数据 / 钥匙串 / 用户 DB）。
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 运行：node e2e/ui-consistency-motion.mjs
 *
 * 覆盖：
 *  A) Steps（运行中长步骤）：默认展开、展开显示完整内容（不再被固定 max-height 截断）、
 *     折叠后头部仍显示状态、用户可再次展开；折叠 → 新流式步骤不把它重新弹开。
 *  B) Steps（已完成）：默认收起、头部显示「N 个步骤 · 全部成功」、点击可展开。
 *  C) 弹窗 / 下拉 / 折叠的进入动画：正常动效下有 keyframes，prefers-reduced-motion 下为 none。
 *  D) 应用内 Select（设置 › 助理电脑）：↑↓ + Enter 选择并回到触发器、Esc 关闭且不改值、点外部关闭。
 *  E) prefers-reduced-motion：spinner 停转但保留强调色半环、shimmer 不留透明字。
 *  F) 390 与桌面 × 多主题：聊天区不横向溢出。
 *
 * 说明：本夹具不改产品逻辑，只跑现有 UI；A 段「新流不弹开」需要 Playwright 的 routeWebSocket（1.48+），
 *       拿不到时打 ⚠️ 跳过（不计失败），核心 A–B / C–F 仍照跑。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/ui-consistency-motion";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".map": "application/json" };
const web = createServer(async (req, res) => {
	const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
	const file = path === "/" || path === "" ? join(dist, "index.html") : join(dist, path);
	try {
		const data = await readFile(file);
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
		res.end(data);
	} catch {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(await readFile(join(dist, "index.html")));
	}
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${web.address().port}`;

const now = Date.now();
const AGENT = (id, name, status = "idle") => ({ id, name, avatar: name[0], color: "#3b82f6", persona: "", description: "", status, unread: 0, model: { provider: "mock", id: "mock" }, model_provider: "mock", model_id: "mock", workspace: `/tmp/ws/${id}`, scope: "user" });
const system = () => ({
	serverId: "srv", publicKey: "pk", pi: { version: "0.0.0", testedWith: "0.0.0", compatible: true, message: "ok" },
	mock: true, local: true, owner: true, server: false, deviceId: "dev", onboarded: true, modelSetupDone: true,
	defaultModel: { provider: "mock", id: "mock" }, credentialBackend: "file",
	sandbox: { mode: "workspace", preference: "workspace", dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "off" }, binary: null, named: {} },
	workspaceRoot: "/tmp/ws", push: { publicKey: "pk" }, seq: 1,
});
const hostInfo = { settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } };
const DESKTOP_OK = () => ({
	settings: { enabled: false, backend: "auto", idleMinutes: 10, mirror: "", fileMirror: "", separate: [], resources: {} },
	backend: { id: "auto", label: "自带运行时", ok: true },
	builtin: { id: "lima", label: "Lima", ready: true },
	dockerAvailable: false,
	image: { ref: "ghcr.io/mymimang/pi-assistant-desktop:1", version: "1", digest: null, downloadBytes: 1.5e9, diskBytes: 5e9, custom: false },
	installed: false,
	install: { phase: "idle", progress: 0, layersDone: 0, layersTotal: 0 },
	vm: null,
	resources: { supported: false, choice: {}, suggested: { cpus: 2, memoryGiB: 2, diskGiB: 20 }, bounds: { cpus: { min: 1, max: 4 }, memoryGiB: { min: 1, max: 8 }, diskGiB: { min: 10, max: 100 } }, applied: null, note: "当前环境不支持调整" },
});
const SANDBOX = { approvals: "none" };

const mkMsg = (over) => ({ id: "x", agent_id: "a1", role: "assistant", content: "", meta: {}, status: "done", created_at: now, updated_at: now, conversation_id: "c1", ...over });
const TOOLS = ["bash", "read", "edit", "grep"];
const toolMsg = (id, i, status, t0) => mkMsg({ id, role: "tool", content: "", meta: { toolName: TOOLS[i % TOOLS.length], args: { command: `第 ${i + 1} 步的命令 / 参数内容稍微长一点，用来撑高列表`, path: `/tmp/f${i}.txt` } }, status, created_at: t0, updated_at: t0 + 600 });
// a1：运行中，20 步（最后一步仍 running）——足够高，旧 420px 固定上限必然截断
const A1_MSGS = [mkMsg({ id: "u1", role: "user", content: "把这件事做完", created_at: now - 30_000, updated_at: now - 30_000 }), ...Array.from({ length: 20 }, (_, i) => toolMsg(`t${i + 1}`, i, i === 19 ? "running" : "done", now - 28_000 + i * 1_000))];
// a2：已完成，4 步
const A2_MSGS = [mkMsg({ id: "u2", role: "user", content: "整理一下", created_at: now - 20_000, updated_at: now - 20_000 }), ...Array.from({ length: 4 }, (_, i) => toolMsg(`s${i + 1}`, i, "done", now - 18_000 + i * 1_000))];

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};
const skip = (name) => console.log(`  ⚠️ 跳过：${name}`);

async function installRoutes(context) {
	await context.route("**/api/**", async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT("a1", "运行中的助理", "running"), AGENT("a2", "已完成的助理", "idle")]);
		if (p === "/api/rooms") return json([]);
		if (p === "/api/channels") return json({ items: [], publicUrl: null });
		if (p === "/api/wechat") return json({ enabled: false, acknowledgedAt: null, agentIds: [] });
		if (p === "/api/downloads") return json({ items: [] });
		if (p.startsWith("/api/proactive/inbox")) return json({ items: [], count: 0, defaultLevel: "normal" });
		if (p === "/api/devices") return json([]);
		if (p === "/api/models/providers") return json(req.method() === "GET" ? [] : {});
		if (p === "/api/models/custom") return json({ providers: [], apis: [], classifierProtocols: [] });
		if (p === "/api/models") return json([]);
		if (p === "/api/model-strengths") return json({ labels: [], models: [] });
		if (p === "/api/image-models/providers") return json({ providers: [], models: [], default: null });
		if (p === "/api/image-models") return json({ kinds: [], providers: [], models: [], default: null, reusable: [] });
		if (p === "/api/usage/summary") return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
		if (p === "/api/memory/providers") return json({ global: "basic", providers: [] });
		if (p === "/api/skill-suggest") return json({ enabled: false });
		if (p === "/api/settings") return json({});
		if (p === "/api/host-control") return json(hostInfo);
		if (p === "/api/sandbox-computer") return json(SANDBOX);
		if (p === "/api/desktop" && req.method() === "PUT") return json({ ...DESKTOP_OK(), settings: { ...DESKTOP_OK().settings, ...JSON.parse(req.postData() ?? "{}") } });
		if (p === "/api/desktop") return json(DESKTOP_OK());
		if (p === "/api/fast-computer/settings") return json({ settings: { enabled: false, kind: "systemone", provider: "", id: "", baseUrl: "", model: "", threshold: 0.5, timeoutMs: 3000 }, classifierModels: [] });
		if (p === "/api/fast-computer/benchmark") return json({ availability: { available: false, reason: "未启用" }, runs: [] });
		if (/^\/api\/agents\/a\d\/computer$/.test(p)) return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		if (p === "/api/agents/a1/messages" && req.method() === "GET") return json(A1_MSGS);
		if (p === "/api/agents/a2/messages" && req.method() === "GET") return json(A2_MSGS);
		if (/^\/api\/agents\/a\d\/conversations$/.test(p) && req.method() === "GET") return json({ current: "c1", items: [{ id: "c1", agent_id: p.includes("a1") ? "a1" : "a2", title: "当前", created_at: now, updated_at: now, message_count: 0, last: null }] });
		if (/^\/api\/agents\/a\d\/tasks$/.test(p)) return json([]);
		if (p === "/api/agents/a1/subagent-model" || p === "/api/agents/a2/subagent-model") return json({ pool: [] });
		if (p.endsWith("/subagent-thinking")) return json({ mode: "follow" });
		if (p.endsWith("/subagents/settings")) return json({ settings: { maxConcurrent: 10, maxMinutes: 60 }, overrides: {}, defaults: { maxConcurrent: 10, maxMinutes: 60 } });
		if (p.startsWith("/api/subagents")) return json([]);
		if (p.endsWith("/read")) return json({});
		return json({});
	});
}

/** 注入一个带类名的标记元素，用来核对 CSS 层（动画是否真的挂在类上），不依赖任何后端。 */
async function cssAnimationOf(page, className, extraClass) {
	await page.evaluate(([c, x]) => {
		document.querySelectorAll("#fx-probe").forEach((n) => n.remove());
		const d = document.createElement("div");
		d.id = "fx-probe";
		d.className = x ? `${c} ${x}` : c;
		document.body.appendChild(d);
	}, [className, extraClass]);
	return page.$eval("#fx-probe", (el) => getComputedStyle(el).animationName);
}

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME, headless: true });

	// ============================================================ 正常动效上下文
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	await installRoutes(ctx);
	const page = await ctx.newPage();
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (e) => { console.error("pageerror:", e); failed++; });

	// 新流不弹开：拦截 WS（拿不到就跳过该断言）
	let ws = null;
	if (typeof page.routeWebSocket === "function") {
		try {
			await page.routeWebSocket("**/ws", (socket) => {
				ws = socket;
				socket.onMessage(() => {});
				socket.send(JSON.stringify({ type: "hello" }));
			});
		} catch (e) {
			console.error("routeWebSocket 设置失败：", e);
		}
	}

	console.log("\n── A) Steps：运行中长步骤，展开完整 / 折叠保状态 / 新流不弹开 ──");
	await page.goto(`${base}/?agent=a1`);
	await page.locator('[data-mid="u1"]').waitFor({ timeout: 20_000 });
	await page.locator('[data-testid="steps"]').waitFor({ timeout: 20_000 });
	const stepsA = page.locator('[data-testid="steps"]');
	check("运行中默认展开", (await stepsA.getAttribute("class")).includes("open"), await stepsA.getAttribute("class"));
	check("头部 aria-expanded=true", (await stepsA.locator(".pa-steps-head").getAttribute("aria-expanded")) === "true");
	const headA = (await stepsA.locator(".pa-steps-head").innerText()).trim();
	check("头部显示进行中状态", headA.includes("正在进行"), headA);

	const measured = await page.$eval('[data-testid="steps"] .pa-steps-list > ol', (el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
	check("展开后步骤列表未被裁切（scrollHeight≈clientHeight）", measured.sh <= measured.ch + 2, JSON.stringify(measured));
	check("长步骤高度超过旧固定上限 420px（证明修的是真问题）", measured.ch > 420, JSON.stringify(measured));

	await stepsA.locator(".pa-steps-head").click();
	await page.waitForTimeout(420);
	check("点击头部可收起（运行中）", !(await stepsA.getAttribute("class")).includes("open"));
	check("收起后头部仍显示状态", (await stepsA.locator(".pa-steps-head").innerText()).includes("正在进行"));
	const collapsed = await page.$eval('[data-testid="steps"] .pa-steps-list > ol', (el) => el.clientHeight);
	check("收起后列表高度≈0（不是整块消失）", collapsed < 8, String(collapsed));

	if (ws) {
		const before = await stepsA.getAttribute("class");
		ws.send(JSON.stringify({ type: "message.created", message: toolMsg("t21", 20, "running", now + 5_000) }));
		await page.waitForTimeout(400);
		const after = await stepsA.getAttribute("class");
		check("新流式步骤不把用户收起的步骤重新弹开", !after.includes("open") && !before.includes("open"), `${before} → ${after}`);
	} else {
		skip("新流式步骤不重新弹开（本机 Playwright 无 routeWebSocket）");
	}

	await stepsA.locator(".pa-steps-head").click();
	await page.waitForTimeout(420);
	check("收起后可再次展开", (await stepsA.getAttribute("class")).includes("open"));
	await page.screenshot({ path: join(OUT, "A-running-steps.png") });

	console.log("\n── B) Steps：已完成默认收起，可展开 ──");
	await page.goto(`${base}/?agent=a2`);
	await page.locator('[data-mid="u2"]').waitFor({ timeout: 20_000 });
	await page.locator('[data-testid="steps"]').waitFor({ timeout: 20_000 });
	const stepsB = page.locator('[data-testid="steps"]');
	check("已完成默认收起", !(await stepsB.getAttribute("class")).includes("open"), await stepsB.getAttribute("class"));
	const headB = (await stepsB.locator(".pa-steps-head").innerText()).trim();
	check("头部显示「N 个步骤 · 全部成功」", /4 个步骤 · 全部成功/.test(headB), headB);
	await stepsB.locator(".pa-steps-head").click();
	await page.waitForTimeout(420);
	check("已完成也可展开", (await stepsB.getAttribute("class")).includes("open"));

	console.log("\n── C) 弹窗 / 下拉 / 折叠的进入动画挂在正确的类上 ──");
	check(".pa-modal 有进入动画", (await cssAnimationOf(page, "pa-modal")) === "pa-modal-in", await cssAnimationOf(page, "pa-modal"));
	check(".pa-pop 有进入动画", (await cssAnimationOf(page, "pa-pop")) === "pa-menu-in");
	check(".pa-menu-in 有进入动画", (await cssAnimationOf(page, "pa-menu-in")) === "pa-menu-in");
	check(".pa-fold-in 有进入动画", (await cssAnimationOf(page, "pa-fold-in")) === "pa-menu-in");
	// 下拉向上翻转靠 inline transform 定位，动画不能改 transform（用 translate 属性）
	const usesTransform = await page.evaluate(() => {
		document.querySelectorAll("#fx-probe").forEach((n) => n.remove());
		const d = document.createElement("div");
		d.id = "fx-probe";
		d.className = "pa-menu-in";
		d.style.transform = "translateY(-100%)";
		document.body.appendChild(d);
		return getComputedStyle(d).transform;
	});
	check("下拉动画不覆盖 inline transform（向上翻转定位保持）", usesTransform.includes("matrix"), usesTransform);

	console.log("\n── D) 应用内 Select：键盘 / Esc / 点外部 / 焦点回到触发器（设置 › 助理电脑）──");
	await page.goto(`${base}/?settings=computer`);
	const idle = page.getByTestId("desktop-idle");
	await idle.waitFor({ timeout: 20_000 });
	const label0 = (await idle.innerText()).trim();
	await idle.click();
	const menu = page.getByTestId("desktop-idle-menu");
	await menu.waitFor();
	check("点击打开菜单", await menu.isVisible());
	check("aria-expanded=true", (await idle.getAttribute("aria-expanded")) === "true");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await page.waitForTimeout(200);
	check("↑↓ + Enter 选择后关闭菜单", (await page.getByTestId("desktop-idle-menu").count()) === 0);
	check("选择后焦点回到触发器", await idle.evaluate((el) => document.activeElement === el));
	const label1 = (await idle.innerText()).trim();
	check("选择真的改了值", label1 !== label0, `${label0} → ${label1}`);
	await idle.click();
	await page.getByTestId("desktop-idle-menu").waitFor();
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
	check("Esc 关闭菜单", (await page.getByTestId("desktop-idle-menu").count()) === 0);
	check("Esc 后不改值", (await idle.innerText()).trim() === label1);
	check("Esc 后焦点回到触发器", await idle.evaluate((el) => document.activeElement === el));
	await idle.click();
	await page.getByTestId("desktop-idle-menu").waitFor();
	await page.mouse.click(5, 5);
	await page.waitForTimeout(200);
	check("点外部关闭菜单", (await page.getByTestId("desktop-idle-menu").count()) === 0);
	await page.screenshot({ path: join(OUT, "D-settings-select.png") });
	await ctx.close();

	// ============================================================ reduced-motion 上下文
	console.log("\n── E) prefers-reduced-motion：无循环 / spinner 静态可读 ──");
	const rm = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
	await installRoutes(rm);
	const rpage = await rm.newPage();
	rpage.setDefaultTimeout(20_000);
	rpage.on("pageerror", (e) => { console.error("pageerror:", e); failed++; });
	await rpage.goto(`${base}/?agent=a1`);
	await rpage.locator('[data-mid="u1"]').waitFor({ timeout: 20_000 });
	await rpage.locator('[data-testid="steps"]').waitFor({ timeout: 20_000 });
	check("reduced-motion 被识别", await rpage.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches));
	check("spinner 停转（animation:none）", (await rpage.$eval(".pa-spinner", (el) => getComputedStyle(el).animationName)) === "none");
	const spinnerStyle = await rpage.$eval(".pa-spinner", (el) => ({ bt: getComputedStyle(el).borderTopColor, b: getComputedStyle(el).borderBottomColor }));
	check("spinner 仍有强调色半环（不是空圆）", spinnerStyle.bt !== spinnerStyle.b, JSON.stringify(spinnerStyle));
	// 流式 shimmer 文本（Activity 正在…）：停转后不能是透明
	await rpage.evaluate(() => {
		document.querySelectorAll("#fx-probe").forEach((n) => n.remove());
		const d = document.createElement("div");
		d.id = "fx-probe";
		d.className = "pa-shimmer";
		d.textContent = "正在思考";
		document.body.appendChild(d);
	});
	const shim = await rpage.$eval("#fx-probe", (el) => ({ anim: getComputedStyle(el).animationName, color: getComputedStyle(el).color }));
	check("shimmer 停转", shim.anim === "none", shim.anim);
	check("shimmer 停止后文字不透明", shim.color !== "rgba(0, 0, 0, 0)", shim.color);
	check("reduced-motion 下 .pa-modal 无进入动画", (await cssAnimationOf(rpage, "pa-modal")) === "none");
	check("reduced-motion 下 .pa-menu-in 无进入动画", (await cssAnimationOf(rpage, "pa-menu-in")) === "none");
	check("reduced-motion 下 .pa-fold-in 无进入动画", (await cssAnimationOf(rpage, "pa-fold-in")) === "none");
	await rpage.screenshot({ path: join(OUT, "E-reduced-motion.png") });
	await rm.close();

	// ============================================================ 多主题 × 视口 不横向溢出
	console.log("\n── F) 390 / 桌面 × 多主题：聊天区不横向溢出 ──");
	for (const [w, h, tag] of [[390, 844, "390"], [1440, 900, "desktop"]]) {
		const c = await browser.newContext({ viewport: { width: w, height: h }, locale: "zh-CN" });
		await installRoutes(c);
		const p = await c.newPage();
		p.setDefaultTimeout(20_000);
		await p.goto(`${base}/?agent=a1`);
		await p.locator('[data-mid="u1"]').waitFor({ timeout: 20_000 });
		await p.locator('[data-testid="steps"]').waitFor({ timeout: 20_000 });
		for (const skin of ["glass", "warm", "pixel", "noir"]) {
			for (const mode of ["light", "dark"]) {
				await p.evaluate(([s, m]) => {
					document.documentElement.dataset.skin = s;
					document.documentElement.dataset.mode = m;
				}, [skin, mode]);
				await p.waitForTimeout(40);
				const ov = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
				check(`${tag} · ${skin}/${mode} 不横向溢出`, ov.sw <= ov.cw + 1, JSON.stringify(ov));
			}
		}
		await p.screenshot({ path: join(OUT, `F-${tag}-pixel.png`) });
		await c.close();
	}
} catch (e) {
	failed++;
	console.error("夹具异常：", e);
} finally {
	await browser?.close().catch(() => {});
	await new Promise((r) => web.close(r));
}
console.log(failed ? `\n❌ ${failed} 项失败` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);
