/**
 * 聊天气泡里 Markdown 内容（表格 / 代码块 / 长链接 / 图片附件）的横向溢出定向验证。
 *
 * 用户报的 bug：UI review 的三列表格在桌面上横向超出、右侧最后一列被裁掉
 * （桌面左右栏同时展开、中间列可用宽度不足时最明显）。
 *
 * 根因（在真实 dist 里量出来的）：`.pa-scroll-x > table` 之前是 `width: max-content`，
 * 表格按「最长一行」铺开、单元格里的中文根本不换行，于是整张表比气泡宽，
 * 被外层 `.pa-scroll-x`（overflow-x:auto）藏起来，而 macOS 的覆盖式滚动条静止不可见
 * → 用户看到的就是「最后一列被裁掉、也没有滚动条」。
 *
 * 这里验证修好后的行为：
 *  - 正常中文长表格按可用宽度排版，单元格内自然换行，表格不撑父 layout，最后一列始终可见；
 *  - 真的放不下（很多列 / 列里有不可断长串）时，在表格自己的块里局部横滚，可滚到最后一列；
 *  - 溢出的表格 / 代码块给常显的横向滚动条（可见提示），并且键盘可聚焦、左右键可滚；
 *  - 代码块保持原始空格不换行，需要时局部横滚；
 *  - 正文长链接、图片附件卡片都不越过内容容器边界；
 *  - 桌面 2000（左右栏开）/ 1280（左右栏开、中栏更窄）/ 1100 / 手机 390 都无整页横向溢出；
 *  - 5 个皮肤抽查（light/dark 玻璃、暖色、像素、暗夜）+ 自定义主题变量规则下行为一致。
 *
 * 纯前端 fixture：静态托管 apps/web/dist，用 page.route 拦截 /api，不启动 packages/server/src/main.ts，
 * 因此不碰真实数据目录、不碰系统钥匙串、不下载任何模型。运行前先构建：
 *   npm run build -w @pi-assistant/web
 *
 * 诚实的边界：只在 Playwright 的 Chromium（桌面 + 手机模拟）里跑；真机 Safari / iOS 触摸滚动、
 * 真实文件附件的下载链路未验。注意 Playwright 默认给 Chromium 传 `--hide-scrollbars`，
 * 所以「常显横向滚动条」只能断言 `::-webkit-scrollbar` 规则确实作用到该元素（同 .pa-scroll 的既有做法），
 * 不能断言它在截图里占位；真机（Chrome / WebKit / Tauri）上该规则会让滚动条变成非覆盖式常显。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const root = decodeURIComponent(new URL("..", import.meta.url).pathname);
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/chat-content-overflow";
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

// ------------------------------------------------------------------ 夹具内容
const now = Date.now();

/** 正常三列表格：中文长句 + 一条很长的不可断 URL（模拟用户截图里的那张表） */
const TABLE3 = [
	"| 可以学习的经验 | 我们可以怎样优化 | 依据与备注 |",
	"| --- | --- | --- |",
	"| 统一的任务状态表达 | 思考、工具、子代理、后台任务统一表达「等待、运行、完成、失败」，用一致的图标与短文案；收起后仍能看见当前进度和失败原因 | 源码层面判断，未在真实设备上验证 |",
	"| 输入区附近的明确反馈 | 网络断开、发送失败、录音未收到声音、正在识别，都在操作附近反馈，并提供对应操作，减少「点了有没有反应」的疑惑 | 与我们的输入栏一致 |",
	"| 局部自适应布局 | 输入栏、模型选择栏根据自身可用宽度收缩；手机先收次要文字和快捷键提示，保留必要操作，避免按钮挤压或遮挡 | 参考组件源码 |",
	"| 长链接 | https://example.com/some/very/long/path/that/never/breaks/anywhere/at/all/abcdefghijklmnopqrstuvwxyz0123456789?query=verylongvalue1234567890 | 需要自然换行 |",
].join("\n");

/** 宽表：8 列、每列都是不可断长串 → 再怎么换行也放不下，必须局部横滚 */
const WIDE = [
	"| " + Array.from({ length: 8 }, (_, i) => `列${i + 1}`).join(" | ") + " |",
	"| " + Array.from({ length: 8 }, () => "---").join(" | ") + " |",
	"| " + Array.from({ length: 8 }, (_, i) => "A".repeat(40) + i).join(" | ") + " |",
].join("\n");

/** 代码块：长行，必须保持原始空格、不换行、局部横滚 */
const PRE = "```text\n" + Array.from({ length: 3 }, (_, i) => `line ${i} ` + "x".repeat(320)).join("\n") + "\n```";

const LONG_URL = "https://example.com/a/very/long/link/without/any/spaces/abcdefghijklmnopqrstuvwxyz0123456789/end-of-link";

const CONTENT = [
	"## 经验",
	"",
	TABLE3,
	"",
	"宽表：",
	"",
	WIDE,
	"",
	"代码：",
	"",
	PRE,
	"",
	`正文里的长链接：${LONG_URL}`,
].join("\n");

const ATTACH = [
	{ fileId: "img1", name: "wide-shot.png", mime: "image/png", size: 4096 },
	{ fileId: "doc1", name: "一个非常长的文件名用来验证附件卡片不会撑破内容容器边界-2026-10-17.md", mime: "text/markdown", size: 2048 },
];
const msgs = [
	{ id: "m1", agent_id: "a1", task_id: null, role: "user", content: "看一下这个表格", meta: { attachments: [] }, status: "done", created_at: now - 60_000, updated_at: now - 60_000, conversation_id: "c1" },
	{ id: "m2", agent_id: "a1", task_id: null, role: "assistant", content: CONTENT, meta: { attachments: ATTACH }, status: "done", created_at: now - 30_000, updated_at: now - 30_000, conversation_id: "c1" },
];
const AGENT = { id: "a1", name: "测试助理", avatar: "测", color: "#3b82f6", persona: "", description: "", status: "idle", unread: 0, model: { provider: "mock", id: "mock" }, model_provider: "mock", model_id: "mock", workspace: "/tmp/ws/a1", scope: "user" };
const system = () => ({ serverId: "srv", publicKey: "pk", pi: { version: "0.0.0", testedWith: "0.0.0", compatible: true, message: "ok" }, mock: true, local: true, owner: true, server: false, deviceId: "dev", onboarded: true, modelSetupDone: true, defaultModel: { provider: "mock", id: "mock" }, credentialBackend: "file", sandbox: { mode: "workspace", preference: "workspace", dockerAvailable: false }, entryDomain: null, tunnel: { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "off" }, binary: null, named: {} }, workspaceRoot: "/tmp/ws", push: { publicKey: "pk" }, seq: 1 });
const hostInfo = { settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } };

/** 1600x300 的宽 PNG（附件卡片的边界用例） */
const WIDE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAABkAAAAEsCAYAAAB2E0mNAAAAP0lEQVR4nO3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvBt0AAGfQ0G0AAAAAElFTkSuQmCC",
	"base64",
);

let failed = 0;
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };

const route = async (page) => {
	await page.route("**/api/**", async (r) => {
		const req = r.request();
		const p = new URL(req.url()).pathname;
		const json = (b, s = 200) => r.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
		if (p.startsWith("/api/files/")) return r.fulfill({ status: 200, contentType: "image/png", body: WIDE_PNG });
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT]);
		if (p === "/api/rooms") return json([]);
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
		if (p === "/api/agents/a1/conversations" && req.method() === "GET") return json({ current: "c1", items: [{ id: "c1", agent_id: "a1", title: "t", created_at: now, updated_at: now, message_count: 2, last: "你好" }] });
		if (p === "/api/agents/a1/tasks") return json([]);
		if (p === "/api/agents/a1/computer") return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		return json({});
	});
};

/** 量一次关键布局：整页横向溢出、表格 / 代码块是否溢出、滚动条是否占位、容器边界 */
const probe = (page) => page.evaluate(() => {
	const r = (el) => (el ? Math.round(el.getBoundingClientRect().right) : null);
	const l = (el) => (el ? Math.round(el.getBoundingClientRect().left) : null);
	const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : null);
	const wraps = [...document.querySelectorAll('[data-testid="md-table-wrap"]')];
	const tables = [...document.querySelectorAll(".pa-md table")];
	const pre = document.querySelector(".pa-md pre");
	const code = document.querySelector(".pa-md pre code");
	const md = document.querySelector(".pa-md");
	const body = document.querySelector(".pa-thread-body");
	const bubble = document.querySelector(".pa-bot-msg .pa-bubble");
	const imageAtt = document.querySelector('[data-testid="image-attachment"] img');
	const fileAtt = document.querySelector('[data-testid="file-card"], .pa-file-card');
	const desc = (el) => el ? {
		w: w(el), right: r(el), left: l(el),
		cw: el.clientWidth, sw: el.scrollWidth,
		ox: getComputedStyle(el).overflowX,
		// 非覆盖式滚动条会占布局高度；>0 说明横向滚动条真的常显（可见提示）
		sbH: el.offsetHeight - el.clientHeight,
		// Playwright 默认给 Chromium 传 --hide-scrollbars，占位高度恒为 0；
		// 所以直接查该元素 ::-webkit-scrollbar 的计算高度（base.css 里设了 --pa-sbw），确认「常显滚动条」规则真的作用到了它。
		sbCss: getComputedStyle(el, "::-webkit-scrollbar").height,
		tab: el.tabIndex, label: el.getAttribute("aria-label"),
	} : null;
	return {
		innerWidth: window.innerWidth,
		docScrollW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		bodyScrollW: document.body.scrollWidth,
		finePointer: matchMedia("(hover: hover) and (pointer: fine)").matches,
		md: md ? { w: w(md), cw: md.clientWidth, sw: md.scrollWidth } : null,
		body: body ? { w: w(body), right: r(body), cw: body.clientWidth, sw: body.scrollWidth } : null,
		bubble: bubble ? { w: w(bubble), right: r(bubble), cw: bubble.clientWidth, sw: bubble.scrollWidth } : null,
		wraps: wraps.map(desc),
		tables: tables.map((t) => ({ w: w(t), cw: t.clientWidth, sw: t.scrollWidth, lastCellRight: (() => { const cells = t.querySelectorAll("tr:last-child > *"); return cells.length ? r(cells[cells.length - 1]) : null; })(), firstCellLeft: (() => { const cells = t.querySelectorAll("tr:last-child > *"); return cells.length ? l(cells[0]) : null; })() })),
		pre: pre ? { ...desc(pre), ws: getComputedStyle(pre).whiteSpace } : null,
		code: code ? { cw: code.clientWidth, sw: code.scrollWidth, ws: getComputedStyle(code).whiteSpace, ow: getComputedStyle(code).overflowWrap } : null,
		imageAtt: imageAtt ? { w: w(imageAtt), right: r(imageAtt), complete: imageAtt.complete } : null,
		fileAtt: fileAtt ? { w: w(fileAtt), right: r(fileAtt) } : null,
		skin: document.documentElement.dataset.skin,
		mode: document.documentElement.dataset.mode,
	};
});

/** 把某个横向滚动容器滚到最右，再量它的最后一个可见元素是否落进可视区 */
const scrollToEndAndMeasure = (page, sel, idx = 0) => page.evaluate(({ s, i }) => {
	const el = document.querySelectorAll(s)[i];
	if (!el) return null;
	el.scrollLeft = el.scrollWidth;
	const inner = el.querySelector("table") ?? el.querySelector("code") ?? el;
	const innerCells = inner.tagName === "TABLE" ? [...inner.querySelectorAll("tr:last-child > *")] : [];
	const target = innerCells.length ? innerCells[innerCells.length - 1] : inner;
	return { scrollLeft: Math.round(el.scrollLeft), maxScroll: Math.round(el.scrollWidth - el.clientWidth), innerRight: Math.round(target.getBoundingClientRect().right), boxRight: Math.round(el.getBoundingClientRect().right) };
}, { s: sel, i: idx });

const pageFixture = async (context, layout, skin) => {
	await context.addInitScript(({ l, s }) => {
		localStorage.setItem("pia.layout", JSON.stringify(l));
		if (s) localStorage.setItem("pia.skin", s);
	}, { l: layout, s: skin });
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	await route(page);
	await page.goto(base + "/", { waitUntil: "domcontentloaded" });
	await page.waitForSelector(".pa-md table", { timeout: 15_000 });
	await page.waitForTimeout(400);
	return page;
};

/** 每个视口 / 皮肤都跑的公共断言 */
const assertContent = (label, m) => {
	check(`${label} 整页无横向溢出 (docScrollW=${m.docScrollW})`, m.docScrollW <= 1, `scrollWidth-clientWidth=${m.docScrollW}`);
	check(`${label} body 不超视口 (${m.bodyScrollW} <= ${m.innerWidth})`, m.bodyScrollW <= m.innerWidth + 1, `${m.bodyScrollW}`);
	// 内容容器边界：正文 / 气泡都不该被表格撑宽
	if (m.body) check(`${label} 消息区不被撑宽 (body sw=${m.body.sw} <= cw=${m.body.cw})`, m.body.sw <= m.body.cw + 1);
	if (m.bubble) check(`${label} 气泡不被撑宽 (bubble sw=${m.bubble.sw} <= cw=${m.bubble.cw})`, m.bubble.sw <= m.bubble.cw + 1);

	// 正常三列表格：按可用宽度排版、单元格内自然换行 → 不需要横滚，最后一列在容器内
	const t0 = m.tables[0], w0 = m.wraps[0];
	check(`${label} 三列表格在容器内（表宽 ${t0.w} <= 容器 ${w0.cw}）`, t0.w <= w0.cw + 1, JSON.stringify(t0));
	check(`${label} 三列表格无横向溢出（sw=${w0.sw} <= cw=${w0.cw}）`, w0.sw <= w0.cw + 1, JSON.stringify(w0));
	check(`${label} 三列表格最后一列可见（right=${t0.lastCellRight} <= 容器右 ${w0.right}）`, t0.lastCellRight !== null && t0.lastCellRight <= w0.right + 1, JSON.stringify(t0));
	check(`${label} 三列表格不被裁切（overflowX=${w0.ox}）`, w0.ox === "auto" || w0.ox === "visible", w0.ox);
	check(`${label} 不溢出的表格不留多余 Tab 停靠点 (tabIndex=${w0.tab})`, w0.tab !== 0, `${w0.tab}`);

	// 宽表：局部横滚，可滚到最后一列；溢出时有可见滚动条 + 键盘可聚焦
	const t1 = m.tables[1], w1 = m.wraps[1];
	check(`${label} 宽表不撑破父容器（表宽 ${t1.w}，父容器 ${w1.cw}）`, w1.sw <= w1.cw + 1 || w1.ox === "auto", JSON.stringify(w1));
	check(`${label} 宽表首列仍在容器内（left=${t1.firstCellLeft} >= 容器左 ${w1.left}）`, t1.firstCellLeft !== null && t1.firstCellLeft >= w1.left - 1, JSON.stringify(t1));
	if (w1.sw > w1.cw + 1) {
		check(`${label} 溢出的宽表是横向滚动容器（overflowX=${w1.ox}）`, w1.ox === "auto");
		check(`${label} 溢出的宽表可键盘聚焦 (tabIndex=${w1.tab}, label=${w1.label})`, w1.tab === 0 && !!w1.label, JSON.stringify(w1));
		if (m.finePointer) check(`${label} 溢出的宽表配置了常显横向滚动条（::-webkit-scrollbar 高 ${w1.sbCss}）`, parseFloat(w1.sbCss) > 0, JSON.stringify(w1));
	} else {
		check(`${label} 宽表也没溢出（sw=${w1.sw} <= cw=${w1.cw}）`, true);
	}

	// 代码块：保留原始空格不换行；溢出时局部横滚 + 可见滚动条 + 键盘可聚焦
	check(`${label} 代码块 white-space=pre（不折行）`, m.code?.ws === "pre", m.code?.ws);
	check(`${label} 代码块没把容器撑宽（md sw=${m.md.sw} <= cw=${m.md.cw}）`, m.md.sw <= m.md.cw + 1, JSON.stringify(m.md));
	if (m.pre.sw > m.pre.cw + 1) {
		check(`${label} 溢出的代码块是横向滚动容器（overflowX=${m.pre.ox}）`, m.pre.ox === "auto");
		check(`${label} 溢出的代码块可键盘聚焦 (tabIndex=${m.pre.tab})`, m.pre.tab === 0, `${m.pre.tab}`);
		if (m.finePointer) check(`${label} 溢出的代码块配置了常显横向滚动条（::-webkit-scrollbar 高 ${m.pre.sbCss}）`, parseFloat(m.pre.sbCss) > 0, JSON.stringify(m.pre));
	}

	// 图片 / 文件附件卡片不越界
	if (m.imageAtt) {
		const containerRight = m.body?.right ?? m.innerWidth;
		check(`${label} 图片附件不越界（right=${m.imageAtt.right} <= ${containerRight}）`, m.imageAtt.right <= containerRight + 1, JSON.stringify(m.imageAtt));
	}
	if (m.fileAtt) check(`${label} 文件附件卡片不越界（right=${m.fileAtt.right} <= ${m.body?.right}）`, m.fileAtt.right <= (m.body?.right ?? m.innerWidth) + 1, JSON.stringify(m.fileAtt));
};

let browser;
try {
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });

	// ---------- 桌面 2000 / 1280 / 1100：左右栏开 / 较窄中栏 ----------
	for (const [label, vp] of [["desktop-2000", { width: 2000, height: 1000 }], ["desktop-1280", { width: 1280, height: 900 }], ["desktop-1100", { width: 1100, height: 900 }]]) {
		console.log(`\n── ${label} ──`);
		const ctx = await browser.newContext({ viewport: vp, serviceWorkers: "block" });
		const page = await pageFixture(ctx, { sideW: 264, paneW: 340, sideCollapsed: false, info: true });
		const m = await probe(page);
		assertContent(label, m);
		check(`${label} 三栏布局已生效（skin=${m.skin}）`, !!m.skin);

		// 宽表滚到最右，最后一列必须能完整看到
		if (m.wraps[1].sw > m.wraps[1].cw + 1) {
			const e = await scrollToEndAndMeasure(page, '[data-testid="md-table-wrap"]', 1);
			check(`${label} 宽表可滚到最后一列（innerRight=${e?.innerRight} <= boxRight=${e?.boxRight}）`, !!e && e.scrollLeft > 0 && e.innerRight <= e.boxRight + 1, JSON.stringify(e));
		}
		// 代码块滚到最右
		if (m.pre.sw > m.pre.cw + 1) {
			const e = await scrollToEndAndMeasure(page, ".pa-md pre");
			check(`${label} 代码块可滚到行尾（innerRight=${e?.innerRight} <= boxRight=${e?.boxRight}）`, !!e && e.scrollLeft > 0 && e.innerRight <= e.boxRight + 1, JSON.stringify(e));
		}
		// 键盘：聚焦溢出的宽表，右方向键要能滚动（先回到最左，否则已经在最右滚不动）
		if (m.wraps[1].sw > m.wraps[1].cw + 1) {
			const before = await page.evaluate(() => { const el = document.querySelectorAll('[data-testid="md-table-wrap"]')[1]; el.scrollLeft = 0; el.focus(); return el.scrollLeft; });
			await page.keyboard.press("ArrowRight");
			await page.waitForTimeout(150);
			const after = await page.evaluate(() => document.querySelectorAll('[data-testid="md-table-wrap"]')[1].scrollLeft);
			check(`${label} 键盘左右键可滚宽表（${before} → ${after}）`, after > before, `${before}/${after}`);
		}
		await page.screenshot({ path: join(OUT, `${label}.png`), fullPage: false });
		await ctx.close();
	}

	// ---------- 手机 390 ----------
	console.log("\n── mobile-390 ──");
	{
		const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, serviceWorkers: "block" });
		const page = await pageFixture(ctx, { sideW: 264, paneW: 340, sideCollapsed: false, info: false });
		const m = await probe(page);
		assertContent("mobile-390", m);
		if (m.wraps[1].sw > m.wraps[1].cw + 1) {
			const e = await scrollToEndAndMeasure(page, '[data-testid="md-table-wrap"]', 1);
			check(`mobile-390 宽表可滚到最后一列（innerRight=${e?.innerRight} <= boxRight=${e?.boxRight}）`, !!e && e.scrollLeft > 0 && e.innerRight <= e.boxRight + 1, JSON.stringify(e));
		}
		await page.screenshot({ path: join(OUT, "mobile-390.png") });
		await ctx.close();
	}

	// ---------- 皮肤抽查：light/dark 玻璃、暖色、像素、暗夜 + 自定义主题变量 ----------
	for (const [label, skin, theme] of [
		["glass-light", "glass", "light"],
		["glass-dark", "glass", "dark"],
		["warm-light", "warm", "light"],
		["pixel-light", "pixel", "light"],
		["noir-dark", "noir", "dark"],
	]) {
		console.log(`\n── 皮肤 ${label} ──`);
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
		await ctx.addInitScript((t) => localStorage.setItem("pia.theme", t), theme);
		const page = await pageFixture(ctx, { sideW: 264, paneW: 340, sideCollapsed: false, info: true }, skin);
		const m = await probe(page);
		assertContent(label, m);
		check(`${label} 皮肤已应用（${m.skin} / ${m.mode}）`, m.skin === skin && m.mode === theme, `${m.skin}/${m.mode}`);
		await ctx.close();
	}

	// 自定义主题（DIY）：只换 token 变量、不改组件规则，行为必须一致
	console.log("\n── 自定义主题（DIY 变量）──");
	{
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
		const page = await pageFixture(ctx, { sideW: 264, paneW: 340, sideCollapsed: false, info: true }, "glass");
		await page.addStyleTag({ content: '[data-skin="custom-test"]{--fg:#123;--bg:#fff;--card:#fff;--line:#ddd;--acc:#3366ff;--hover:#eee;--mut:#666;--mut2:#999;--side:#fafafa;--panel:#fff}' });
		await page.evaluate(() => { document.documentElement.dataset.skin = "custom-test"; });
		await page.waitForTimeout(250);
		const m = await probe(page);
		assertContent("custom", m);
		check("custom 自定义 skin 已应用", m.skin === "custom-test", m.skin);
		await ctx.close();
	}
} finally {
	await browser?.close();
	web.close();
}

console.log(`\n${failed ? `❌ ${failed} 项失败` : "✅ 全部通过"}（截图：${OUT}）`);
process.exit(failed ? 1 : 0);
