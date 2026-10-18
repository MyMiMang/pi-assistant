/**
 * 模型选择「第二层完整目录」的真实 DOM 布局验收（只跑这一个脚本）。
 *
 * 用户报的 bug（beta.30）：点开模型名进入完整目录后，常用 4 条下面只剩一个服务标题，
 * 目录宽约 230px，看不见更多选项、长模型名互相挤压。
 *
 * 根因（在真实 DOM 里量出来的，两条独立）：
 *  1) 宽度：app.css 的 `.pa-pop { width: max-content; max-width: min(var(--pop-w, 20rem), 100vw - 16px) }`
 *     是未分层规则，会盖掉 Tailwind 的 `w-80`（utilities 层）。目录宽度于是跟着「最宽的那段文字」走，
 *     而条目文字全是 truncate，实测只有 210–230px（长名字顶到 320px 封顶）——长模型名只能截断挤压。
 *  2) 高度：`popoverStyle` 用「量到的自然高度」反推 top。两层弹层切换时，目录层会先带着紧凑层的
 *     maxHeight 渲染一帧，那时量到的自然高度是被裁过的（900 高的窗口里：紧凑层 170 → 目录层量到 242
 *     → 目录被永久限高 314），而输入栏上方其实有 812px 可用。
 *
 * 这里验证修好后的行为（不是「元素存在」就算过，全部按真实几何量）：
 *  - 桌面：目录宽度明显更宽（≥ 380，长名字不再挤成一团），条目文字可用宽度 ≥ 150；
 *  - 桌面上方空间足够时，目录高度按可用空间给（可视区 ≥ 380），**明显更多条可见**（完整可见的模型行 ≥ 8、
 *    同时能看到 ≥ 3 个服务分组），且整块弹层不出视口；
 *  - 多服务 / 常用 5 条 / 超长模型名同时存在时，行不重叠、不横向溢出；
 *  - 390 窄屏：底部弹窗铺满可用宽度（视口 - 16），无整页横向溢出，行同样不挤压，能看见 ≥ 6 行；
 *  - 两层结构不变：紧凑层仍是窄卡片（≤ 360），Esc 从目录只退一层回到紧凑层、焦点回到模型名，
 *    选完模型回到紧凑层并显示新模型名。
 *
 * 纯前端 fixture：静态托管 apps/web/dist + page.route 拦 /api，不启动服务、不碰真实数据 / 凭据 / 付费模型。
 * 运行前先构建：`npm run build -w @pi-assistant/web`，然后
 *   node e2e/model-picker-layout-ui.mjs
 * 诚实边界：只在 Playwright 的 Chromium（桌面 + 手机模拟）里跑；真机 Safari / iOS 触摸、Tauri 窗口未验。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { nativeLaunchBrowserEnv } from "./fixtures/native-launch-env.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = decodeURIComponent(new URL("..", import.meta.url).pathname);
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = process.env.SHOT_DIR ?? artifactDir("model-picker-layout");
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

// ------------------------------------------------------------------ 夹具：3 个服务 / 每个 6 个模型 / 超长名字 / 常用 5 条
const now = Date.now();
const LONG = "claude-4.5-sonnet-2026-01-01-企业内网中转站专用超长模型名称-用于验证不互相挤压";
const svcs = [
	{ id: "svc-a", name: "公司中转站（主）" },
	{ id: "svc-b", name: "备用渠道-东京节点" },
	{ id: "svc-c", name: "个人 OpenAI 直连" },
];
const providers = svcs.map((s) => ({ id: s.id, name: s.name, configured: true, api: "openai-completions", baseUrl: `http://127.0.0.1:1/${s.id}`, models: 6 }));
const models = svcs.flatMap((s, si) =>
	Array.from({ length: 6 }, (_, i) => ({
		provider: s.id,
		id: `${s.id}-m${i}`,
		name: i === 0 ? LONG : i === 1 ? `${s.name} 长名字模型 v${i}（128K 上下文）` : `${s.id.toUpperCase()} 模型 ${i}`,
		reasoning: true,
		thinking: ["low", "medium", "high"],
		fast: { capability: "supported" },
		providerName: s.name,
		star: si === 0 && i === 0,
	})),
);
// 常用 5 条（跨 3 个服务），让「常用」把第一屏占满——这正是用户截图里的场景
const picks = Object.fromEntries(
	[["svc-a", 0], ["svc-b", 0], ["svc-c", 0], ["svc-a", 1], ["svc-b", 1]].map(([p, i], n) => [`${p}/${p}-m${i}`, { count: 5 - n, at: now - n * 1000 }]),
);
const AGENT = { id: "a1", name: "测试助理", avatar: "测", color: "#3b82f6", persona: "", description: "", status: "idle", unread: 0, model: { provider: "svc-a", id: "svc-a-m0" }, model_provider: "svc-a", model_id: "svc-a-m0", workspace: "/tmp/ws/a1", scope: "user" };
const system = () => ({ serverId: "srv", publicKey: "pk", pi: { version: "0.0.0", testedWith: "0.0.0", compatible: true, message: "ok" }, mock: true, local: true, owner: true, server: false, deviceId: "dev", onboarded: true, modelSetupDone: true, defaultModel: { provider: "svc-a", id: "svc-a-m0" }, credentialBackend: "file", sandbox: { mode: "workspace", preference: "workspace", dockerAvailable: false }, entryDomain: null, tunnel: { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "off" }, binary: null, named: {} }, workspaceRoot: "/tmp/ws", push: { publicKey: "pk" }, seq: 1 });
const hostInfo = { settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } };

let failed = 0;
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };

const route = async (page) => {
	await page.route("**/api/**", async (r) => {
		const req = r.request();
		const p = new URL(req.url()).pathname;
		const json = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT]);
		// PATCH 要回显改过的字段：前端只合并响应里出现的 key（选完模型靠它显示新名字）
		if (p === "/api/agents/a1" && req.method() === "PATCH") return json({ ...AGENT, ...(req.postDataJSON() ?? {}) });
		if (p === "/api/rooms") return json([]);
		if (p === "/api/channels") return json({ items: [], publicUrl: null });
		if (p === "/api/wechat") return json({ enabled: false, acknowledgedAt: null, agentIds: [] });
		if (p === "/api/downloads") return json({ items: [] });
		if (p.startsWith("/api/proactive/inbox")) return json({ items: [], count: 0, defaultLevel: "normal" });
		if (p === "/api/devices") return json([]);
		if (p === "/api/models/providers") return json({ providers });
		if (p === "/api/models") return json(models);
		if (p === "/api/models/picks" && req.method() === "GET") return json({ picks });
		if (p === "/api/models/picks") return json({ ok: true });
		if (p === "/api/host-control") return json(hostInfo);
		if (p.startsWith("/api/usage/summary")) return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
		if (p === "/api/memory/providers") return json({ global: "basic", providers: [] });
		if (p === "/api/skill-suggest") return json({ enabled: false });
		if (p === "/api/settings") return json({});
		if (p === "/api/agents/a1/messages") return json([{ id: "m1", agent_id: "a1", task_id: null, role: "user", content: "你好", meta: { attachments: [] }, status: "done", created_at: now - 1000, updated_at: now - 1000, conversation_id: "c1" }]);
		if (p === "/api/agents/a1/conversations" && req.method() === "GET") return json({ current: "c1", items: [{ id: "c1", agent_id: "a1", title: "t", created_at: now, updated_at: now, message_count: 1, last: "你好" }] });
		if (p === "/api/agents/a1/tasks") return json([]);
		if (p === "/api/agents/a1/computer") return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		return json({});
	});
};

/** 量一次完整目录的几何：宽度 / 可视高度 / 完整可见的行数与分组数 / 行内文字宽度 / 是否出视口 */
const probeMenu = (page) => page.evaluate(() => {
	const panel = document.querySelector('[data-testid="model-menu"]');
	if (!panel) return null;
	const box = panel.getBoundingClientRect();
	// 目录内部真正的滚动容器（.pa-pop 是 flex 列，滚动的是它里面那个 overflow-y:auto 的孩子）
	const scroller = [...panel.children].find((c) => getComputedStyle(c).overflowY === "auto") ?? panel;
	const sb = scroller.getBoundingClientRect();
	const rows = [...panel.querySelectorAll('[data-testid="model-option"]')];
	const groups = [...panel.querySelectorAll('[data-testid^="model-group-"]')];
	const inView = (r) => r.top >= sb.top - 0.5 && r.bottom <= sb.bottom + 0.5 && r.height > 0;
	const nameOf = (row) => row.querySelector("span.block.truncate") ?? row.querySelector(".truncate");
	return {
		width: Math.round(box.width),
		height: Math.round(box.height),
		top: Math.round(box.top),
		bottom: Math.round(box.bottom),
		left: Math.round(box.left),
		right: Math.round(box.right),
		viewport: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
		scrollView: { h: Math.round(sb.height), top: Math.round(sb.top), bottom: Math.round(sb.bottom) },
		scroll: { client: Math.round(scroller.clientHeight), total: Math.round(scroller.scrollHeight) },
		rows: rows.length,
		visibleRows: rows.filter((r) => inView(r.getBoundingClientRect())).length,
		visibleGroups: groups.filter((g) => inView(g.getBoundingClientRect())).length,
		groups: groups.length,
		// 行内文字可用宽度 + 是否横向溢出（长名字只能截断，不能撑破行 / 挤压相邻元素）
		nameWidths: rows.map((r) => { const n = nameOf(r); return n ? Math.round(n.getBoundingClientRect().width) : 0; }),
		rowOverflow: rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length,
		// 行高与位置：相邻行不能重叠
		rowBoxes: rows.map((r) => { const b = r.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; }),
		frequentRows: document.querySelectorAll('[data-testid="model-frequent"] [data-testid="model-option"]').length,
		docScrollW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		panelOverflowW: panel.scrollWidth - panel.clientWidth,
	};
});

const probeCompact = (page) => page.evaluate(() => {
	const el = document.querySelector('[data-testid="model-picker-compact"]');
	if (!el) return null;
	const b = el.getBoundingClientRect();
	return { width: Math.round(b.width), height: Math.round(b.height), bottom: Math.round(b.bottom), viewportH: document.documentElement.clientHeight };
});

const openPicker = async (page) => {
	await page.getByTestId("model-picker").click();
	await page.getByTestId("model-picker-compact").waitFor();
	await page.waitForTimeout(120);
};
const openList = async (page) => {
	await page.getByTestId("model-picker-compact").getByTestId("thinking-model").click();
	await page.getByTestId("model-menu").waitFor();
	await page.waitForTimeout(250); // 等定位 / ResizeObserver 稳定
};

let browser;
try {
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: nativeLaunchBrowserEnv() });
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
	await ctx.addInitScript(() => localStorage.setItem("pia.layout", JSON.stringify({ sideW: 264, paneW: 340, sideCollapsed: true, info: false })));
	const page = await ctx.newPage();
	page.setDefaultTimeout(15_000);
	page.on("pageerror", (e) => console.error("pageerror:", e));
	await route(page);
	await page.goto(base + "/?agent=a1", { waitUntil: "domcontentloaded" });
	await page.getByTestId("model-picker").waitFor();

	// ================================================== 1) 桌面 1280×900：第二层要宽敞、看得见更多
	console.log("\n[1] 桌面 1280×900：完整目录的宽度 / 高度 / 可见条数");
	await openPicker(page);
	const compact = await probeCompact(page);
	check(`紧凑层仍是窄卡片（宽 ${compact.width} ≤ 360，高 ${compact.height}）`, compact.width <= 360, JSON.stringify(compact));
	await openList(page);
	let m = await probeMenu(page);
	assert.ok(m, "完整目录没渲染出来");
	console.log("     ", JSON.stringify({ w: m.width, h: m.height, top: m.top, scrollView: m.scrollView.h, rows: m.rows, visibleRows: m.visibleRows, visibleGroups: m.visibleGroups, frequent: m.frequentRows }));
	check(`目录宽度明显更宽（${m.width} ≥ 380）`, m.width >= 380, JSON.stringify({ width: m.width }));
	check(`目录不出视口左右（left=${m.left} right=${m.right} ≤ ${m.viewport.w}）`, m.left >= 0 && m.right <= m.viewport.w + 1);
	check(`目录不出视口上下（top=${m.top} ≥ 0，bottom=${m.bottom} ≤ ${m.viewport.h}）`, m.top >= 0 && m.bottom <= m.viewport.h + 1);
	check(`上方空间足够时目录按可用空间给高度（可视区 ${m.scrollView.h} ≥ 380，弹层高 ${m.height}）`, m.scrollView.h >= 380, JSON.stringify(m.scrollView));
	check(`完整可见的模型行明显更多（${m.visibleRows} 行 ≥ 8；旧实现只有 4~5 行）`, m.visibleRows >= 8, JSON.stringify({ visibleRows: m.visibleRows, rows: m.rows }));
	check(`同时能看到多个服务分组（${m.visibleGroups} ≥ 3，共 ${m.groups} 组）`, m.visibleGroups >= 3, JSON.stringify({ visibleGroups: m.visibleGroups, groups: m.groups }));
	check(`常用 5 条都在（${m.frequentRows}）`, m.frequentRows === 5, `${m.frequentRows}`);
	check(`长模型名不再被挤成一小条（最窄可用宽度 ${Math.min(...m.nameWidths)} ≥ 150）`, Math.min(...m.nameWidths) >= 150, JSON.stringify(m.nameWidths));
	check(`行内没有横向溢出（${m.rowOverflow} 行溢出）`, m.rowOverflow === 0);
	const overlapping = m.rowBoxes.filter((b, i) => i > 0 && b.top < m.rowBoxes[i - 1].bottom - 1).length;
	check(`相邻行不重叠（${overlapping} 处重叠）`, overlapping === 0, JSON.stringify(m.rowBoxes.slice(0, 6)));
	check(`弹层自身没有横向溢出（${m.panelOverflowW}）`, m.panelOverflowW <= 1);
	check(`整页无横向溢出（${m.docScrollW}）`, m.docScrollW <= 1);
	await stableShot(page, page.getByTestId("model-menu"), join(OUT, "01-desktop-list.png"));

	// ================================================== 2) 两层结构 / Esc / 选完返回
	console.log("\n[2] 两层结构：Esc 只退一层、焦点回模型名；选完模型回紧凑层并显示新名字");
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
	check("Esc 从目录退回紧凑层（目录已关闭、紧凑层还在）", (await page.getByTestId("model-menu").count()) === 0 && (await page.getByTestId("model-picker-compact").count()) === 1);
	const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
	check(`Esc 后焦点回到模型名（${focused}）`, focused === "thinking-model", focused);
	await openList(page);
	// 挑一个长名字模型（svc-c 的第 0 个）
	const picked = models.find((x) => x.provider === "svc-c" && x.id === "svc-c-m0");
	await page.getByTestId("model-menu").locator(`[data-testid=model-option][data-model="svc-c/svc-c-m0"]`).first().click();
	await page.waitForTimeout(200);
	check("选完模型回到紧凑层（目录关闭、紧凑层打开）", (await page.getByTestId("model-menu").count()) === 0 && (await page.getByTestId("model-picker-compact").count()) === 1);
	const modelText = await page.getByTestId("thinking-model").innerText();
	check(`紧凑层显示新模型名（${modelText.slice(0, 18)}…）`, modelText.includes(picked.name.slice(0, 12)), modelText);
	// 收起，准备下一个视口
	await page.keyboard.press("Escape");
	await page.waitForTimeout(120);
	await ctx.close();

	// ================================================== 3) 390 窄屏：底部弹窗铺满可用宽度
	console.log("\n[3] 390×844 窄屏：底部弹窗宽度 / 可见条数 / 无横向溢出");
	const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: "block" });
	await mctx.addInitScript(() => localStorage.setItem("pia.layout", JSON.stringify({ sideW: 264, paneW: 340, sideCollapsed: true, info: false })));
	const mp = await mctx.newPage();
	mp.setDefaultTimeout(15_000);
	mp.on("pageerror", (e) => console.error("pageerror:", e));
	await route(mp);
	await mp.goto(base + "/?agent=a1", { waitUntil: "domcontentloaded" });
	await mp.getByTestId("model-picker").waitFor();
	await openPicker(mp);
	await openList(mp);
	const mm = await probeMenu(mp);
	assert.ok(mm, "窄屏下完整目录没渲染出来");
	console.log("     ", JSON.stringify({ w: mm.width, h: mm.height, top: mm.top, bottom: mm.bottom, scrollView: mm.scrollView.h, visibleRows: mm.visibleRows }));
	check(`窄屏目录铺满可用宽度（${mm.width} ≈ ${mm.viewport.w - 16}）`, Math.abs(mm.width - (mm.viewport.w - 16)) <= 6, JSON.stringify({ width: mm.width, vw: mm.viewport.w }));
	check(`窄屏目录不出视口（left=${mm.left} ≥ 0，right=${mm.right} ≤ ${mm.viewport.w}）`, mm.left >= 0 && mm.right <= mm.viewport.w + 1);
	check(`窄屏目录是底部弹窗、留在输入栏上方（bottom=${mm.bottom} ≤ ${mm.viewport.h - 90}）`, mm.bottom <= mm.viewport.h - 90, JSON.stringify({ bottom: mm.bottom, vh: mm.viewport.h }));
	check(`窄屏也能看见足够多的行（${mm.visibleRows} ≥ 6）`, mm.visibleRows >= 6, JSON.stringify({ visibleRows: mm.visibleRows }));
	check(`窄屏长名字仍不互相挤压（最窄可用宽度 ${Math.min(...mm.nameWidths)} ≥ 150）`, Math.min(...mm.nameWidths) >= 150, JSON.stringify(mm.nameWidths));
	check(`窄屏行内无横向溢出（${mm.rowOverflow}）`, mm.rowOverflow === 0);
	check(`窄屏整页无横向溢出（${mm.docScrollW}）`, mm.docScrollW <= 1);
	await stableShot(mp, mp.getByTestId("model-menu"), join(OUT, "02-mobile-390-list.png"));
	await mctx.close();
} finally {
	await browser?.close();
	web.close();
}

console.log(failed ? `\n❌ ${failed} 项未通过` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);
