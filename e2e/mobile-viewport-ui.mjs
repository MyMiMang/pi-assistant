/**
 * 手机浏览器 App shell / 输入控件 viewport 定向验证。
 *
 * 用户报的 bug：手机浏览器里顶栏和底部输入栏会随整页上下移动（不固定）；点输入框整页自动放大，
 * 打完看聊天还要手动缩回去。
 *
 * 这里验证修好后的行为（390/375/430 三种窄屏 + 短窗键盘模拟 + 桌面回归）：
 *  - 页面本身不滚动（html/body 锁死，#root 用可视高度），顶栏贴顶、输入栏贴底，window.scrollTo 无效；
 *  - 视口变矮（模拟键盘）后顶栏仍在 0、输入栏仍在可视区底部、最后一条消息仍可见（聊天区自动贴底）；
 *  - 横竖屏切换后同样贴住；
 *  - 手机上所有输入类控件 computed font-size >= 16px（iOS Safari 聚焦自动放大的阈值），
 *    但整页字号不变（不允许把整页乱放大）；
 *  - viewport meta 保留双指缩放（没有 user-scalable=no / maximum-scale=1）；
 *  - 主会话 / 群聊共用同一套 shell（群聊也逐项验证一遍），不是三份复制；
 *  - 桌面 1280 不套手机规则（字号、滚动行为都不变）。
 *
 * 纯前端 fixture：静态托管 apps/web/dist，用 page.route 拦截 /api，不启动 packages/server/src/main.ts，
 * 因此不碰真实数据目录、不碰系统钥匙串。运行前先构建：npm run build -w @pi-assistant/web
 *
 * 诚实的边界：Playwright 的 Chromium 移动模拟没有真 iOS 键盘（Safari 键盘是覆盖式的，不缩布局视口），
 * 所以「键盘弹起」用 setViewportSize 缩小视口来近似；真机上这一步由 viewport.ts 的 visualViewport 完成。
 * 本脚本能证明的是「视口尺寸变化后 shell 跟随、整页不滚动、控件字号达标」，不能替代真机确认。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = decodeURIComponent(new URL("..", import.meta.url).pathname);
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = artifactDir("mobile-viewport");
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
		const html = await readFile(join(dist, "index.html"));
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(html);
	}
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${web.address().port}`;

const now = Date.now();
const AGENT = { id: "a1", name: "测试助理", avatar: "测", color: "#3b82f6", persona: "", description: "", status: "idle", unread: 0, model: { provider: "mock", id: "mock" }, model_provider: "mock", model_id: "mock", workspace: "/tmp/ws/a1", scope: "user" };
const LONG = Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 行：把聊天内容撑长，用来验证滚动与贴底行为。`).join("\n\n");
const msgs = [
	{ id: "m1", agent_id: "a1", task_id: null, role: "user", content: "手机端顶栏会不会跟着整页滚动？", meta: { attachments: [] }, status: "done", created_at: now - 60_000, updated_at: now - 60_000, conversation_id: "c1" },
	{ id: "m2", agent_id: "a1", task_id: null, role: "assistant", content: LONG, meta: { attachments: [] }, status: "done", created_at: now - 30_000, updated_at: now - 30_000, conversation_id: "c1" },
];
const ROOM = {
	id: "r1", name: "测试群", purpose: "验证群聊共用同一套 shell", managerId: "a1", caps: { maxTurns: 3, maxDepth: 2, perAgent: 4, tokenBudget: 100000, followup: true }, unread: 0, paused: null,
	members: [{ agentId: "a1", name: "测试助理", avatar: "测", color: "#3b82f6", left: false, deleted: false, scope: "user", status: "idle" }],
	last: { content: "群里的最后一条", role: "assistant", agent_id: "a1", created_at: now }, created_at: now, updated_at: now,
	state: { running: false, current: null, queue: [] },
};
const system = () => ({
	serverId: "srv", publicKey: "pk", pi: { version: "0.0.0", testedWith: "0.0.0", compatible: true, message: "ok" },
	mock: true, local: true, owner: true, server: false, deviceId: "dev", onboarded: true, modelSetupDone: true,
	defaultModel: { provider: "mock", id: "mock" }, credentialBackend: "file",
	sandbox: { mode: "workspace", preference: "workspace", dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "off" }, binary: null, named: {} },
	workspaceRoot: "/tmp/ws", push: { publicKey: "pk" }, seq: 1,
});
const hostInfo = { settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } };

let failed = 0;
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

/** 量一次关键布局：整页是否可滚、顶栏/输入栏贴边、控件字号、可视高度变量 */
const probe = (page) => page.evaluate(() => {
	const q = (s) => document.querySelector(s);
	const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
	const de = document.documentElement;
	const scroller = q(".pa-scroll");
	const controls = [...document.querySelectorAll("input, textarea, select")].filter((el) => !el.closest(".pa-pet")).map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type ?? "", fs: parseFloat(getComputedStyle(el).fontSize) }));
	return {
		innerHeight: window.innerHeight,
		innerWidth: window.innerWidth,
		vvHeight: window.visualViewport ? Math.round(window.visualViewport.height) : null,
		vhVar: getComputedStyle(de).getPropertyValue("--pa-vvh").trim(),
		htmlOverflow: getComputedStyle(de).overflowY,
		bodyOverflow: getComputedStyle(document.body).overflowY,
		rootH: Math.round((q("#root")?.getBoundingClientRect().height ?? 0)),
		docScrollable: de.scrollHeight - de.clientHeight,
		docScrollW: de.scrollWidth - de.clientWidth,
		scrollY: window.scrollY,
		header: box(q(".pa-chat-head")),
		composer: box(q(".pa-composer-wrap")),
		composerTA: box(q(".pa-composer textarea")),
		appFont: getComputedStyle(q(".pa-app")).fontSize,
		controls,
		stickGap: scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null,
		lastMsgBottom: box(q(".pa-thread-body")),
		hasComposer: !!q(".pa-composer"),
	};
});

/** 每档窄屏都跑的公共断言：顶栏贴顶、输入栏贴底、整页不滚、控件字号 >= 16px、整页字号不变 */
const assertGluing = (label, m, expectH) => {
	check(`${label} 顶栏贴顶 (top=${m.header?.top})`, m.header && m.header.top <= 1, JSON.stringify(m.header));
	check(`${label} 输入栏贴底 (bottom=${m.composer?.bottom} / 视口=${m.innerHeight})`, m.composer && near(m.composer.bottom, m.innerHeight), JSON.stringify(m.composer));
	check(`${label} 整页不可滚 (可滚=${m.docScrollable})`, m.docScrollable <= 1, `scrollHeight-clientHeight=${m.docScrollable}`);
	check(`${label} window.scrollTo 无效 (scrollY=${m.scrollY})`, m.scrollY === 0);
	check(`${label} App 字号未被放大 (${m.appFont})`, parseFloat(m.appFont) < 16, m.appFont);
	const bad = m.controls.filter((c) => c.fs < 16);
	check(`${label} 输入类控件字号 >= 16px（${m.controls.length} 个）`, bad.length === 0, JSON.stringify(bad));
	check(`${label} 无横向溢出 (${m.docScrollW}px)`, m.docScrollW <= 1);
	check(`${label} shell 高 = 可视高 (${m.rootH} vs ${m.innerHeight})`, near(m.rootH, m.innerHeight), `${m.rootH}/${m.innerHeight}`);
	if (expectH) check(`${label} --pa-vvh 已写入 (${m.vhVar})`, m.vhVar.endsWith("px"), m.vhVar);
};

let browser;
try {
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });

	const pageFixture = async (context) => {
		const page = await context.newPage();
		page.setDefaultTimeout(15_000);
		await context.addInitScript(() => localStorage.setItem("pia.layout", JSON.stringify({ sideW: 264, paneW: 340, sideCollapsed: false, info: false })));
		await page.route("**/api/**", async (route) => {
			const req = route.request();
			const p = new URL(req.url()).pathname;
			const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
			if (p === "/api/system") return json(system());
			if (p === "/api/system/public") return json({});
			if (p === "/api/agents" && req.method() === "GET") return json([AGENT]);
			if (p === "/api/rooms") return json([ROOM]);
			if (p === "/api/rooms/r1/messages") return json(msgs.map((m) => ({ ...m, room_id: "r1", seq: 1 })));
			if (p === "/api/channels") return json({ items: [], publicUrl: null });
			if (p === "/api/wechat") return json({ enabled: false, acknowledgedAt: null, agentIds: [] });
			if (p === "/api/downloads") return json({ items: [] });
			if (p.startsWith("/api/proactive/inbox")) return json({ items: [], count: 0, defaultLevel: "normal" });
			if (p === "/api/devices") return json([]);
			if (p === "/api/models/providers") return json({ providers: [] });
			if (p === "/api/models") return json([]);
			if (p === "/api/host-control") return json(hostInfo);
			if (p.startsWith("/api/usage/summary")) return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
			if (p === "/api/memory/providers") return json({ global: "basic", providers: [] });
			if (p === "/api/skill-suggest") return json({ enabled: false });
			if (p === "/api/settings") return json({});
			if (p === "/api/agents/a1/messages") return json(msgs);
			if (p === "/api/agents/a1/conversations" && req.method() === "GET") return json({ current: "c1", items: [{ id: "c1", agent_id: "a1", title: "第一段对话", created_at: now, updated_at: now, message_count: 2, last: "你好" }] });
			if (p === "/api/agents/a1/tasks") return json([]);
			if (p === "/api/agents/a1/computer") return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
			return json({});
		});
		return page;
	};

	// ---------- 手机：三种常用窄屏 ----------
	for (const vp of [{ w: 390, h: 800 }, { w: 375, h: 800 }, { w: 430, h: 800 }]) {
		const label = `${vp.w}x${vp.h}`;
		console.log(`\n── 手机 ${label} ──`);
		const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: "block" });
		const page = await pageFixture(context);
		await page.goto(base + "/", { waitUntil: "domcontentloaded" });
		await page.waitForSelector(".pa-composer textarea");
		await page.waitForTimeout(300);

		const m0 = await probe(page);
		assertGluing(label, m0, true);

		// 整页拖不动：即使内容比视口高很多
		await page.evaluate(() => window.scrollTo(0, 600));
		const m1 = await probe(page);
		check(`${label} 拖不动后 scrollY=${m1.scrollY}`, m1.scrollY === 0);
		check(`${label} 拖不动后顶栏仍在 0（top=${m1.header?.top}）`, m1.header?.top === 0);
		check(`${label} 聊天区自己可滚（stickGap=${m0.stickGap}）`, m0.stickGap !== null && m0.stickGap <= 2);

		// 输入控件必须真的 >= 16px 且页面本身没被放大
		const ta = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".pa-composer textarea")).fontSize));
		check(`${label} 输入框真实字号 = ${ta}px`, ta >= 16);

		// 多行自动增高后输入栏仍贴底、聊天区仍贴底
		await page.fill(".pa-composer textarea", "第一行\n第二行\n第三行\n第四行");
		await page.waitForTimeout(200);
		const m2 = await probe(page);
		check(`${label} 多行后输入框变高（${m2.composerTA?.h}px > ${m0.composerTA?.h}px）`, (m2.composerTA?.h ?? 0) > (m0.composerTA?.h ?? 0));
		check(`${label} 多行后输入栏仍贴底 (bottom=${m2.composer?.bottom})`, near(m2.composer?.bottom ?? -1, m2.innerHeight));
		check(`${label} 多行后整页仍不可滚`, m2.docScrollable <= 1);

		// 键盘模拟：先聚焦输入框（键盘就是因为聚焦才弹出来的），再把视口变矮，
		// 顶栏 / 输入栏 / 最后一条消息都要保持可见
		await page.focus(".pa-composer textarea");
		await page.setViewportSize({ width: vp.w, height: 420 });
		await page.waitForTimeout(350);
		const mk = await probe(page);
		check(`${label} 键盘后顶栏仍在 0（top=${mk.header?.top}）`, mk.header?.top === 0);
		check(`${label} 键盘后输入栏在可视区底部 (${mk.composer?.bottom} vs ${mk.innerHeight})`, near(mk.composer?.bottom ?? -1, mk.innerHeight));
		check(`${label} 键盘后整页不可滚`, mk.docScrollable <= 1);
		check(`${label} 键盘后聊天区自动贴底 (gap=${mk.stickGap})`, mk.stickGap !== null && mk.stickGap <= 2);
		check(`${label} 键盘后最后一条消息在可视区内 (bottom=${mk.lastMsgBottom?.bottom})`, (mk.lastMsgBottom?.bottom ?? 0) <= mk.innerHeight + 1);

		// 横竖屏切换
		await page.setViewportSize({ width: vp.h, height: vp.w });
		await page.waitForTimeout(350);
		const mr = await probe(page);
		check(`${label} 横屏后顶栏仍在 0（top=${mr.header?.top}）`, mr.header?.top === 0);
		check(`${label} 横屏后输入栏贴底 (${mr.composer?.bottom} vs ${mr.innerHeight})`, near(mr.composer?.bottom ?? -1, mr.innerHeight));
		check(`${label} 横屏后整页不可滚`, mr.docScrollable <= 1);
		check(`${label} 横屏后无横向溢出 (${mr.docScrollW}px)`, mr.docScrollW <= 1);

		await page.setViewportSize({ width: vp.w, height: vp.h });
		await page.waitForTimeout(200);
		await page.screenshot({ path: join(OUT, `main-${label}.png`) });

		// 群聊复用同一套 shell（手机上左栏是抽屉）
		await page.click('[aria-label="打开助理列表"]');
		await page.waitForSelector('[data-testid="sidebar-room"]');
		await page.click('[data-testid="sidebar-room"]');
		await page.waitForSelector(".pa-composer textarea");
		await page.waitForTimeout(300);
		const mroom = await probe(page);
		assertGluing(`${label} 群聊`, mroom, true);
		await page.focus(".pa-composer textarea");
		await page.setViewportSize({ width: vp.w, height: 420 });
		await page.waitForTimeout(350);
		const mroomKb = await probe(page);
		check(`${label} 群聊键盘后顶栏仍在 0`, mroomKb.header?.top === 0);
		check(`${label} 群聊键盘后输入栏贴底 (${mroomKb.composer?.bottom} vs ${mroomKb.innerHeight})`, near(mroomKb.composer?.bottom ?? -1, mroomKb.innerHeight));
		check(`${label} 群聊键盘后聊天区贴底 (gap=${mroomKb.stickGap})`, mroomKb.stickGap !== null && mroomKb.stickGap <= 2);
		await page.setViewportSize({ width: vp.w, height: vp.h });
		await page.waitForTimeout(200);
		await page.screenshot({ path: join(OUT, `room-${label}.png`) });

		// 保留双指缩放 / 文字缩放：viewport meta 不允许写死缩放
		const meta = await page.getAttribute('meta[name="viewport"]', "content");
		check(`${label} viewport meta 不禁用缩放（${meta}）`, !/user-scalable\s*=\s*no/i.test(meta ?? "") && !/maximum-scale\s*=\s*1(\.0+)?\b/i.test(meta ?? ""));
		check(`${label} 保留 viewport-fit=cover`, /viewport-fit\s*=\s*cover/.test(meta ?? ""));
		await context.close();
	}

	// ---------- 桌面回归：手机规则不泄漏 ----------
	console.log("\n── 桌面 1280x900 回归 ──");
	const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
	const dpage = await pageFixture(dctx);
	await dpage.goto(base + "/", { waitUntil: "domcontentloaded" });
	await dpage.waitForSelector(".pa-composer textarea");
	await dpage.waitForTimeout(300);
	const d = await probe(dpage);
	check("桌面整页不可滚（桌面 App shell 本来就不滚）", d.docScrollable <= 1, `${d.docScrollable}`);
	check("桌面顶栏贴顶", d.header?.top === 0);
	check("桌面输入栏贴底", near(d.composer?.bottom ?? -1, d.innerHeight));
	const dta = await dpage.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".pa-composer textarea")).fontSize));
	check(`桌面输入框字号仍为 ${dta}px（< 16，手机规则不泄漏）`, dta < 16);
	check(`桌面 App 字号仍为 ${d.appFont}`, parseFloat(d.appFont) < 16);
	await dpage.screenshot({ path: join(OUT, "desktop-1280.png") });
	await dctx.close();
} finally {
	await browser?.close();
	web.close();
}

console.log(`\n${failed ? `❌ ${failed} 项失败` : "✅ 全部通过"}（截图：${OUT}）`);
process.exit(failed ? 1 : 0);
