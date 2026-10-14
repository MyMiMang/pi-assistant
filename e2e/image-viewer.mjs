// 图片查看器（全屏 lightbox）真实渲染验证：Mock 服务 + 无头 Chrome。
// 用法：node pia-imageviewer-verify.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const { fileURLToPath } = await import("node:url");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TEST_IMG = join(REPO, "docs/screenshots/91-chat-generated-image.png");
const NODE = process.execPath;

const pw = await import(join(REPO, "node_modules/playwright-core/index.js"));
const chromium = pw.chromium ?? pw.default?.chromium;

const PORT = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = "/tmp/pia-imageviewer-verify";
rmSync(DATA, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log("[verify]", ...a);
const results = [];
const check = (name, ok, detail = "") => {
	results.push([ok ? "✅" : "❌", name, ok ? "" : detail]);
	log(ok ? "✅" : "❌", name, ok ? "" : detail);
};

const server = spawn(NODE, ["--import", "tsx", "packages/server/src/main.ts"], {
	cwd: REPO,
	env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_HOST_CONTROL_DRY_RUN: "1", PIA_PORT: String(PORT) },
	stdio: ["ignore", "pipe", "pipe"],
});
import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync("/tmp/pia-iv-server.log", "");
server.stdout.on("data", (d) => appendFileSync("/tmp/pia-iv-server.log", d));
server.stderr.on("data", (d) => appendFileSync("/tmp/pia-iv-server.log", d));
server.on("exit", (c) => appendFileSync("/tmp/pia-iv-server.log", `\n[exit ${c}]\n`));
process.on("exit", () => server.kill("SIGKILL"));

const waitFor = async (fn, ms = 90_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return true;
		} catch (e) {
			if (process.env.VERBOSE) log("wait:", String(e), String(e.cause));
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
};
if (!(await waitFor(async () => (await fetch(`${BASE}/api/system`)).ok))) throw new Error("mock 服务没起来");
log("mock 服务已启动", BASE);

const jpost = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// ---- 准备：一个助理 + 一张上传的大图 + 一条带图片附件的用户消息
const agent = await jpost("/api/agents", { name: "图片测试" });
const fd = new FormData();
fd.append("file", new Blob([readFileSync(TEST_IMG)], { type: "image/png" }), "测试大图.png");
const up = await fetch(`${BASE}/api/agents/${agent.id}/upload`, { method: "POST", body: fd }).then((r) => r.json());
if (!up.fileId) throw new Error("上传失败：" + JSON.stringify(up));
log("已上传测试图片", up.fileId, up.size, up.mime);
await jpost(`/api/agents/${agent.id}/messages`, { text: "看这张图", attachments: [up.fileId] });
// 用于验证 Markdown 外链：单独成段的链接（链接卡片）+ 正文里的裸链接 + 带标题的链接
await jpost(`/api/agents/${agent.id}/messages`, { text: "构建进度见 https://github.com/MyMiMang/pi-assistant/actions ，说明见 [文档](https://example.com/docs) 和 https://www.example.org/a?b=1 。" });
// 单独成段的链接 → 应渲染成链接卡片
await jpost(`/api/agents/${agent.id}/messages`, { text: "https://github.com/MyMiMang/pi-assistant/releases" });
// 标记首次向导已完成，否则 Onboarding 浮层会挡住页面
await fetch(`${BASE}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ onboarded: true }) });
const sys = await fetch(`${BASE}/api/system`).then((r) => r.json());
if (!sys.onboarded) throw new Error("onboarded 没生效，页面会被向导浮层挡住");
log("向导已跳过，onboarded =", sys.onboarded);

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });

const box = (page, sel) => page.locator(sel).boundingBox();
const viewerState = (page) =>
	page.evaluate(() => {
		const v = document.querySelector("[data-testid=image-viewer]");
		const img = document.querySelector("[data-viewer-img]");
		const r = v?.getBoundingClientRect();
		const ir = img?.getBoundingClientRect();
		return {
			portalToBody: v?.parentElement === document.body,
			position: v ? getComputedStyle(v).position : null,
			zIndex: v ? getComputedStyle(v).zIndex : null,
			rect: r && { x: r.x, y: r.y, w: r.width, h: r.height },
			img: ir && { x: ir.x, y: ir.y, w: ir.width, h: ir.height },
			nw: img?.naturalWidth,
			nh: img?.naturalHeight,
			transform: img ? getComputedStyle(img).transform : null,
			vw: innerWidth,
			vh: innerHeight,
		};
	});

async function desktop() {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", colorScheme: "light" });
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.locator("[data-testid=image-attachment] img").first().waitFor({ timeout: 30_000 });

	// 打开前：图片被聊天区限制在 300px 内
	const thumb = await box(page, "[data-testid=image-attachment] img");
	check("打开前缩略图被限制（≤300px）", thumb.width <= 300 + 1, JSON.stringify(thumb));

	await page.locator("[data-testid=image-attachment] img").first().click();
	await page.locator("[data-testid=image-viewer]").waitFor({ timeout: 10_000 });
	await page.locator("[data-viewer-img]").waitFor();
	await page.waitForTimeout(400);

	let s = await viewerState(page);
	check("查看器 Portal 到 body", s.portalToBody === true, JSON.stringify(s.portalToBody));
	check("查看器 fixed 且 z-index ≥ 60", s.position === "fixed" && Number(s.zIndex) >= 60, `${s.position}/${s.zIndex}`);
	check("查看器铺满视口（不再被困聊天区）", Math.abs(s.rect.x) < 1 && Math.abs(s.rect.y) < 1 && Math.abs(s.rect.w - s.vw) < 1 && Math.abs(s.rect.h - s.vh) < 1, JSON.stringify(s.rect));
	check("初始适配视口（图片完整落在视口内）", s.img.x >= -1 && s.img.y >= -1 && s.img.x + s.img.w <= s.vw + 1 && s.img.y + s.img.h <= s.vh + 1, JSON.stringify(s.img));
	check("初始 100%", (await page.getByTestId("viewer-scale").textContent()) === "100%", await page.getByTestId("viewer-scale").textContent());
	const fitW = s.img.w;
	await page.screenshot({ path: join(SHOTS, "image-viewer-desktop-open.png") });

	// 放大按钮
	await page.getByTestId("viewer-zoom-in").click();
	await page.waitForTimeout(250);
	let s2 = await viewerState(page);
	const scaleTxt = await page.getByTestId("viewer-scale").textContent();
	check("「放大」按钮生效（百分比 > 100%）", parseInt(scaleTxt) > 100 && s2.img.w > fitW * 1.1, `${scaleTxt} ${s2.img.w} vs ${fitW}`);

	// 滚轮以指针为中心缩放：指针下的图块保持不动
	const c = { x: s2.img.x + s2.img.w * 0.3, y: s2.img.y + s2.img.h * 0.35 };
	const before = await page.evaluate(([x, y]) => {
		const img = document.querySelector("[data-viewer-img]");
		const r = img.getBoundingClientRect();
		return { u: (x - r.x) / r.width, v: (y - r.y) / r.height };
	}, [c.x, c.y]);
	await page.mouse.move(c.x, c.y);
	await page.mouse.wheel(0, -400);
	await page.waitForTimeout(300);
	const s3 = await viewerState(page);
	const after = await page.evaluate(([x, y]) => {
		const img = document.querySelector("[data-viewer-img]");
		const r = img.getBoundingClientRect();
		return { u: (x - r.x) / r.width, v: (y - r.y) / r.height };
	}, [c.x, c.y]);
	check("滚轮缩放生效", parseInt(await page.getByTestId("viewer-scale").textContent()) > parseInt(scaleTxt), await page.getByTestId("viewer-scale").textContent());
	check("滚轮以指针为锚点（锚点处内容不跑）", Math.abs(after.u - before.u) < 0.03 && Math.abs(after.v - before.v) < 0.03, `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);

	// 拖动
	const t0 = await page.evaluate(() => getComputedStyle(document.querySelector("[data-viewer-img]")).transform);
	await page.mouse.move(s3.vw / 2, s3.vh / 2);
	await page.mouse.down();
	await page.mouse.move(s3.vw / 2 - 180, s3.vh / 2 - 90, { steps: 12 });
	await page.mouse.up();
	await page.waitForTimeout(250);
	const t1 = await page.evaluate(() => getComputedStyle(document.querySelector("[data-viewer-img]")).transform);
	check("拖动可移动图片", t0 !== t1, `${t0} → ${t1}`);
	check("拖动松手后不会被当成点击关闭", await page.locator("[data-testid=image-viewer]").isVisible());
	await page.screenshot({ path: join(SHOTS, "image-viewer-desktop-zoomed.png") });

	// 重置
	await page.getByTestId("viewer-reset").click();
	await page.waitForTimeout(250);
	const s4 = await viewerState(page);
	check("重置回 100% 且归位", (await page.getByTestId("viewer-scale").textContent()) === "100%" && /matrix\(1, 0, 0, 1, 0, 0\)|none/.test(s4.transform ?? ""), `${s4.transform}`);

	// 双击放大 / 还原
	await page.mouse.dblclick(s4.vw / 2, s4.vh / 2);
	await page.waitForTimeout(300);
	const s5 = await viewerState(page);
	check("双击放大到 250%", (await page.getByTestId("viewer-scale").textContent()) === "250%", await page.getByTestId("viewer-scale").textContent());
	await page.mouse.dblclick(s5.vw / 2, s5.vh / 2);
	await page.waitForTimeout(300);
	check("再次双击还原 100%", (await page.getByTestId("viewer-scale").textContent()) === "100%", await page.getByTestId("viewer-scale").textContent());

	// 下载入口
	const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), page.getByTestId("viewer-download").click()]);
	check("查看器里能下载原图", /\.png$/.test(dl.suggestedFilename()), dl.suggestedFilename());

	// Esc 关闭
	await page.keyboard.press("Escape");
	await page.locator("[data-testid=image-viewer]").waitFor({ state: "detached", timeout: 5000 });
	check("Esc 关闭", true);

	// 点图片外的空白关闭；点图片本身不关闭
	await page.locator("[data-testid=image-attachment] img").first().click();
	await page.locator("[data-testid=image-viewer]").waitFor();
	await page.waitForTimeout(300);
	const v = await viewerState(page);
	await page.mouse.click(v.img.x + v.img.w / 2, v.img.y + v.img.h / 2);
	await page.waitForTimeout(250);
	check("点图片本身不关闭", await page.locator("[data-testid=image-viewer]").isVisible());
	await page.mouse.click(4, v.vh / 2);
	await page.locator("[data-testid=image-viewer]").waitFor({ state: "detached", timeout: 5000 });
	check("点图片外空白关闭", true);

	// 信息面板「文件」里的图片也能打开（统一入口）
	const infoBtn = page.getByRole("button", { name: "信息面板" });
	if (await infoBtn.count()) await infoBtn.click();
	// 默认是「概览」标签，先切到「文件」（窄面板时可能收进「更多」菜单）
	const fileTab = page.locator("[data-testid=info-tabs] [data-itab=files]");
	if (await fileTab.count()) await fileTab.click();
	else {
		await page.getByTestId("info-tabs-more").click();
		await page.locator("[data-testid=info-tabs-menu] [data-itab=files]").click();
	}
	const grid = page.locator(".pa-pane-wrap img").first();
	try {
		await grid.waitFor({ timeout: 15_000 });
		await grid.click();
		await page.locator("[data-testid=image-viewer]").waitFor({ timeout: 5000 });
		check("信息面板里的图片同样打开全屏查看器", true);
		await page.keyboard.press("Escape");
	} catch (e) {
		check("信息面板里的图片同样打开全屏查看器", false, String(e).slice(0, 120));
	}

	// Markdown 外链：必须带 target=_blank + rel（Tauri 靠它把外部链接交给系统浏览器，而不是在应用内跳走）
	const links = await page.evaluate(() =>
		[...document.querySelectorAll(".pa-md a[href^='http']")].map((a) => ({
			href: a.getAttribute("href"),
			target: a.getAttribute("target"),
			rel: a.getAttribute("rel") ?? "",
			card: a.classList.contains("pa-link-card"),
		})),
	);
	const ext = links.filter((l) => /github\.com|example\.(com|org)/.test(l.href ?? ""));
	check("Markdown 渲染出外链", ext.length >= 3, JSON.stringify(links.map((l) => l.href)));
	check(
		"外链都带 target=_blank 且 rel 含 noreferrer",
		ext.length >= 3 && ext.every((l) => l.target === "_blank" && /noreferrer/.test(l.rel)),
		JSON.stringify(ext),
	);
	// 链接卡片（单独成段的链接）需要 agent 回复正好只有一条链接；mock 模型不会产生，
	// 这里只当出现 pa-link-card 时校验它也遵守 target=_blank（不把“没出现”算失败）。
	const cards = links.filter((l) => l.card);
	check("链接卡片（如有）也带 target=_blank", cards.every((l) => l.target === "_blank"), JSON.stringify(cards));

	check("控制台无报错", errors.length === 0, errors.slice(0, 3).join(" | "));
	await ctx.close();
}

async function mobile() {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "zh-CN", colorScheme: "light" });
	const page = await ctx.newPage();
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.locator("[data-testid=image-attachment] img").first().waitFor({ timeout: 30_000 });
	await page.locator("[data-testid=image-attachment] img").first().tap();
	await page.locator("[data-testid=image-viewer]").waitFor({ timeout: 10_000 });
	await page.locator("[data-viewer-img]").waitFor();
	await page.waitForTimeout(400);
	const s = await viewerState(page);
	check("[390] 查看器铺满视口", Math.abs(s.rect.w - s.vw) < 1 && Math.abs(s.rect.h - s.vh) < 1, JSON.stringify(s.rect));
	check("[390] 图片完整可见", s.img.x >= -1 && s.img.y >= -1 && s.img.x + s.img.w <= s.vw + 1 && s.img.y + s.img.h <= s.vh + 1, JSON.stringify(s.img));
	const bar = await box(page, "[data-testid=viewer-reset]");
	const barRow = await page.locator("[data-testid=viewer-zoom-out]").boundingBox();
	check("[390] 控制栏在视口内", bar && bar.x >= 0 && bar.x + bar.width <= 390 && bar.y >= 0 && bar.y + bar.height <= 844, JSON.stringify(bar));
	check("[390] 控制栏只有一行（高度 ≤ 64）", !!barRow && barRow.height <= 64, JSON.stringify(barRow));
	const overlaps = !(s.img.y + s.img.h <= bar.y + 0.5 || s.img.y >= bar.y + bar.height - 0.5);
	check("[390] 控制栏不遮挡图片", !overlaps, JSON.stringify({ img: s.img, bar }));
	check("[390] 图片铺满可用宽度（宽图）", s.img.w >= 390 - 16, `${s.img.w} vs 374`);
	await page.screenshot({ path: join(SHOTS, "image-viewer-mobile-390.png") });

	const cdp = await ctx.newCDPSession(page);
	const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });

	// 双指张开 = 放大（以两指中点为锚点）
	const cx = 195, cy = 420;
	await touch("touchStart", [{ x: cx - 40, y: cy }, { x: cx + 40, y: cy }]);
	await touch("touchMove", [{ x: cx - 80, y: cy }, { x: cx + 80, y: cy }]);
	await touch("touchMove", [{ x: cx - 130, y: cy }, { x: cx + 130, y: cy }]);
	await touch("touchEnd", []);
	await page.waitForTimeout(300);
	const pinchScale = parseInt(await page.getByTestId("viewer-scale").textContent());
	check("[390] 双指张开能放大", pinchScale > 100, `${pinchScale}%`);
	check("[390] 双指缩放不会误关查看器", await page.locator("[data-testid=image-viewer]").isVisible());

	// 单指拖动
	const t0 = await page.evaluate(() => getComputedStyle(document.querySelector("[data-viewer-img]")).transform);
	await touch("touchStart", [{ x: 195, y: 420 }]);
	await touch("touchMove", [{ x: 150, y: 390 }]);
	await touch("touchMove", [{ x: 110, y: 360 }]);
	await touch("touchEnd", []);
	await page.waitForTimeout(250);
	const t1 = await page.evaluate(() => getComputedStyle(document.querySelector("[data-viewer-img]")).transform);
	check("[390] 单指拖动可移动图片", t0 !== t1, `${t0} → ${t1}`);
	check("[390] 拖动松手后不误关", await page.locator("[data-testid=image-viewer]").isVisible());
	await page.screenshot({ path: join(SHOTS, "image-viewer-mobile-zoomed.png") });

	// 双击轻点还原
	await page.getByTestId("viewer-reset").tap();
	await page.waitForTimeout(200);
	const tap = async (x, y) => {
		await touch("touchStart", [{ x, y }]);
		await touch("touchEnd", []);
	};
	await tap(195, 420);
	await page.waitForTimeout(80);
	await tap(195, 420);
	await page.waitForTimeout(350);
	const dtScale = await page.getByTestId("viewer-scale").textContent();
	check("[390] 双击轻点放大", parseInt(dtScale) > 100, dtScale);

	// 关闭按钮（手机上可点）
	await page.getByTestId("viewer-close").tap();
	await page.locator("[data-testid=image-viewer]").waitFor({ state: "detached", timeout: 5000 });
	check("[390] 关闭按钮可点", true);
	await ctx.close();
}

try {
	await desktop();
	await mobile();
} finally {
	await browser.close();
	server.kill("SIGTERM");
}

console.log("\n===== 结果 =====");
for (const r of results) console.log(r.join(" "));
const bad = results.filter((r) => r[0] === "❌").length;
console.log(bad ? `\n${bad} 项未通过` : "\n全部通过");
process.exit(bad ? 1 : 0);
