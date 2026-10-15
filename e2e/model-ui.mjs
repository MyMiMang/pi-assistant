/**
 * 模型 UI 专项验证（只跑这一个脚本，不跑全量 e2e）：
 * 1) 长列表多服务：按 provider 分组折叠、搜索能找到折叠组里的模型
 * 2) 常用 5：按选择频次置顶、分组里不重复、刷新后仍在（服务端持久化）
 * 3) 模型 + 思考强度合并在同一个菜单 / 同一个按钮
 * 4) 390 窄中栏：按钮只留图标、无横向溢出、上下文圆环独立
 * 5) 设置 › 模型：顶部紧凑（默认使用 / 识图模型都是合一的按钮）、整个「模型服务 / 渠道」（添加渠道 + 内置 + 我的渠道）
 *    是一个带图标 / 数量 / 箭头的可折叠大分类、可一键全部关上；里面渠道按内置/我的分组成「带服务图标的卡片网格」，
 *    点卡片展开看该服务模型、模型行内改能力标签、编辑/删除沿用应用内确认框（无原生 confirm）
 * 6) 群聊成员与子代理的模型入口复用同一个菜单
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = "/tmp/pia-e2e-model-ui";
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/model-ui";
rmSync(DATA, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const PORT = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: decodeURIComponent(ROOT), env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
const j = async (path, method = "GET", body) => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const t = await r.text();
	assert.ok(r.ok, `${path} ${r.status} ${t}`);
	return t ? JSON.parse(t) : null;
};
const wait = async (fn, ms = 25_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("timeout");
};
const ok = (name) => console.log(`✅ ${name}`);
let browser;
try {
	await wait(async () => (await fetch(`${BASE}/api/system`)).ok);
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = await j("/api/agents", "POST", { name: "模型 UI 验证" });

	// ---- 造一个「模型很多、服务很多」的场景：6 个自定义渠道，每个 8 个模型
	const providers = [];
	for (let i = 1; i <= 6; i++) {
		const p = await j("/api/models/custom", "POST", { name: `渠道${i}`, api: "openai-completions", baseUrl: `http://127.0.0.1:1/v${i}`, noKey: true, models: Array.from({ length: 8 }, (_, k) => ({ id: `m-${i}-${k + 1}`, contextWindow: 131072, maxTokens: 8192 })) });
		providers.push(p);
	}
	const allModels = await j("/api/models");
	assert.ok(allModels.length >= 48, `模型数量应 ≥48，实际 ${allModels.length}`);

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	let nativeDialogs = 0;
	page.on("dialog", (d) => {
		nativeDialogs++;
		void d.dismiss();
	});
	page.on("pageerror", (e) => console.error("pageerror:", e));
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.getByTestId("model-picker").waitFor();
	assert.equal(await page.getByTestId("thinking-picker").count(), 0, "不再有独立的思考强度按钮");

	// ============================================================ 1) 分组折叠 + 搜索
	console.log("\n[1] 长列表多服务：分组折叠 + 搜索");
	await page.getByTestId("model-picker").click();
	const menu = page.getByTestId("model-menu");
	await menu.waitFor();
	for (const p of providers) {
		await menu.getByTestId(`model-group-${p.id}`).waitFor();
		assert.equal(await menu.getByTestId(`model-group-${p.id}`).getAttribute("aria-expanded"), "false", `${p.name} 默认应收起`);
	}
	// 分组名用用户起的名字，不是内部 id
	const headers = await menu.locator('[data-testid^="model-group-"]').allTextContents();
	assert.ok(headers.some((t) => t.includes("渠道3")), `分组名应用用户命名：${headers}`);
	assert.ok(!headers.some((t) => /custom-/.test(t)), "分组名不能出现内部 id");
	// 展开一个渠道
	await menu.getByTestId(`model-group-${providers[2].id}`).click();
	assert.equal(await menu.getByTestId(`model-group-${providers[2].id}`).getAttribute("aria-expanded"), "true");
	assert.equal(await menu.getByTestId("model-option").filter({ hasText: "m-3-1" }).count(), 1);
	await page.screenshot({ path: join(OUT, "01-menu-groups.png") });
	// 搜索：折叠组里的模型也能搜到
	await menu.getByTestId("model-search").fill("m-5-7");
	await wait(async () => (await menu.getByTestId("model-option").count()) === 1);
	assert.equal(await menu.getByTestId("model-option").first().getAttribute("data-model"), `${providers[4].id}/m-5-7`);
	assert.equal(await menu.getByTestId("model-frequent").count(), 0, "搜索时不显示常用分组");
	await page.screenshot({ path: join(OUT, "02-menu-search.png") });
	await menu.getByTestId("model-search").fill("");
	await page.keyboard.press("Escape");
	ok("按服务折叠、用户命名、搜索能找到全部模型");

	// ============================================================ 2) 常用 5
	console.log("\n[2] 常用 5：按频次置顶、不与分组重复、刷新后仍在");
	const pick = async (providerIdx, modelId) => {
		await page.getByTestId("model-picker").click();
		await page.getByTestId("model-menu").waitFor();
		await page.getByTestId("model-search").fill(modelId);
		await page.getByTestId("model-option").first().click();
	};
	await pick(0, "m-1-1");
	await pick(1, "m-2-2");
	await pick(0, "m-1-1"); // 再选一次 → 频次 2
	for (const [i, id] of [[2, "m-3-3"], [3, "m-4-4"], [4, "m-5-5"], [5, "m-6-6"]]) await pick(i, id);
	const expectFreq = [`${providers[0].id}/m-1-1`, `${providers[5].id}/m-6-6`, `${providers[4].id}/m-5-5`, `${providers[3].id}/m-4-4`, `${providers[2].id}/m-3-3`];
	const freqOf = async () => {
		await page.getByTestId("model-picker").click();
		await page.getByTestId("model-frequent").waitFor();
		const freq = await page.getByTestId("model-frequent").getByTestId("model-option").evaluateAll((els) => els.map((e) => e.dataset.model));
		const all = await page.getByTestId("model-menu").getByTestId("model-option").evaluateAll((els) => els.map((e) => e.dataset.model));
		return { freq, all };
	};
	let { freq, all } = await freqOf();
	assert.deepEqual(freq, expectFreq, `常用应按频次/最近排序：${freq}`);
	assert.equal(new Set(all).size, all.length, `常用与分组不应重复：${all}`);
	await page.screenshot({ path: join(OUT, "03-menu-frequent.png") });
	await page.keyboard.press("Escape");
	const picks = (await j("/api/models/picks")).picks;
	assert.equal(picks[`${providers[0].id}/m-1-1`].count, 2, "服务端应记录频次");
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	({ freq } = await freqOf());
	assert.deepEqual(freq, expectFreq, `刷新后常用应保留：${freq}`);
	await page.keyboard.press("Escape");
	ok("常用 5 置顶、按频次 + 最近选择、分组不重复、刷新后保留");

	// ============================================================ 3) 模型 + 思考强度统一
	console.log("\n[3] 模型 + 思考强度合并在一个菜单 / 一个按钮");
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: "mock", id: "echo-think" } });
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	await page.getByTestId("model-picker").click();
	await page.getByTestId("model-thinking").waitFor();
	await page.getByTestId("thinking-high").click();
	await wait(async () => (await j("/api/agents")).find((x) => x.id === agent.id).thinking === "high");
	await page.getByTestId("model-picker").getByText(/· 高/).waitFor();
	await page.getByTestId("model-picker").click();
	await page.getByTestId("model-thinking").waitFor();
	await page.screenshot({ path: join(OUT, "04-model-thinking.png") });
	await page.keyboard.press("Escape");
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: "mock", id: "echo" } });
	await page.reload();
	await page.getByTestId("model-picker").click();
	await page.getByTestId("model-menu").waitFor();
	assert.equal(await page.getByTestId("model-thinking").count(), 0, "不支持推理的模型不应显示思考强度");
	await page.keyboard.press("Escape");
	ok("一个按钮里同时换模型和设思考强度");

	// ============================================================ 4) 390 窄中栏
	console.log("\n[4] 390 窄中栏：只留图标、无横向溢出");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(400);
	const composer = page.locator("[data-testid=main-conversation] .pa-composer");
	const narrow = await composer.evaluate((el) => {
		const btn = el.querySelector("[data-testid=model-picker]");
		return {
			labelShown: [...btn.querySelectorAll("span")].some((s) => s.textContent.trim() && s.getClientRects().length > 0),
			docOverflow: document.documentElement.scrollWidth - innerWidth,
			toolsOverflow: (() => {
				const t = el.querySelector(".pa-composer-tools");
				return t.scrollWidth - t.clientWidth;
			})(),
			hasRing: !!el.querySelector("[data-testid=context-ring]"),
		};
	});
	assert.equal(narrow.labelShown, false, "窄容器里模型按钮只留图标");
	assert.ok(narrow.docOverflow <= 1, `整页不应横向溢出：${narrow.docOverflow}`);
	assert.ok(narrow.toolsOverflow <= 1, `工具栏不应横向溢出：${narrow.toolsOverflow}`);
	assert.equal(narrow.hasRing, true, "上下文圆环独立保留");
	await page.getByTestId("model-picker").click();
	const mmenu = page.getByTestId("model-menu");
	await mmenu.waitFor();
	const box = await mmenu.boundingBox();
	assert.ok(box && box.x >= 0 && box.x + box.width <= 390 + 1, `菜单应在屏幕内：${JSON.stringify(box)}`);
	await page.screenshot({ path: join(OUT, "05-390-composer.png") });
	await page.keyboard.press("Escape");
	ok("390 窄中栏只留图标、无溢出、圆环独立");

	// ============================================================ 5) 设置 › 模型：新版排版 + 折叠渠道 + 渠道内能力 + 编辑/删除
	console.log("\n[5] 设置 › 模型：默认使用/识图紧凑、渠道分组折叠、能力标签在模型行内、编辑/删除走应用内确认框");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${BASE}/?agent=${agent.id}&settings=models`);
	const acc = page.getByTestId("provider-accordion");
	await acc.waitFor();
	// 顶部：默认使用 / 识图模型各是一个按钮（模型 + 思考强度合一）；不再有全局模型擅长长清单
	assert.equal(await page.getByTestId("default-model-picker").count(), 1, "默认使用应是一个按钮");
	await page.getByTestId("vision-model-picker").waitFor();
	assert.equal(await page.getByTestId("model-strengths").count(), 0, "不应再有全局模型擅长长清单");
	assert.equal(await page.getByTestId("default-model-select").count(), 0, "默认模型不再是下拉框");
	await j("/api/models/default", "PUT", { provider: "mock", model: "echo-think" });
	await page.reload();
	await page.getByTestId("default-model-picker").waitFor();
	// 等模型列表与 store 加载完（按钮文字出现模型名）再打开菜单，避免空列表竞态
	await wait(async () => (await page.getByTestId("default-model-picker").innerText()).includes("Mock 推理模型"));
	await page.getByTestId("default-model-picker").click();
	await page.getByTestId("default-model-thinking").waitFor();
	await page.getByTestId("thinking-low").click();
	await wait(async () => (await j("/api/models/defaults")).thinking === "low");
	await page.screenshot({ path: join(OUT, "06a-default-vision.png") });
	// 渠道分组：内置服务 / 我的渠道
	await page.getByTestId("provider-group-builtin").waitFor();
	await page.getByTestId("provider-group-mine").waitFor();
	assert.match(await page.getByTestId("provider-group-mine").innerText(), /我的渠道（6）/, "6 个自定义渠道应归到「我的渠道」");
	// 服务是「带图标的卡片网格」：每张卡都有服务图标、图标各不相同（不能所有服务一个样）、桌面多列
	const builtinGrid = page.getByTestId("provider-grid-builtin");
	const mineGrid = page.getByTestId("provider-grid-mine");
	await builtinGrid.waitFor();
	await mineGrid.waitFor();
	const gridCols = await builtinGrid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
	assert.ok(gridCols >= 2, `桌面内置服务应是多列网格，实际 ${gridCols} 列`);
	assert.equal(await page.locator('[data-testid=provider-row] [data-testid=provider-icon]').count(), await page.getByTestId("provider-row").count(), "每张服务卡都应有图标");
	const mineIcons = await mineGrid.getByTestId("provider-icon").allTextContents();
	assert.equal(mineIcons.length, 6, `我的渠道应有 6 个图标：${mineIcons.length}`);
	assert.equal(new Set(mineIcons).size, mineIcons.length, `6 个渠道图标必须互不相同：${JSON.stringify(mineIcons)}`);
	assert.ok(mineIcons.every((t) => t.trim().length > 0), "自定义渠道图标不能为空");
	const builtinIcons = await builtinGrid.getByTestId("provider-icon").evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute("data-provider-icon-kind"), html: e.innerHTML })));
	const brandCount = builtinIcons.filter((i) => i.kind === "brand").length;
	assert.ok(brandCount >= Math.floor(builtinIcons.length * 0.8), `内置服务大部分要有品牌图标：${builtinIcons.length} 个里只有 ${brandCount} 个有品牌图标`);
	// 同一品牌的多个渠道（moonshotai/-cn、openai/codex、xiaomi 的几个 token plan…）共用一张 logo，所以只要求足够多不重复、不能所有服务一个样
	assert.ok(new Set(builtinIcons.map((i) => i.html)).size >= Math.floor(builtinIcons.length * 0.6), `内置服务图标不能所有服务一个样：${builtinIcons.length} 个服务只有 ${new Set(builtinIcons.map((i) => i.html)).size} 种图标`);
	assert.ok(builtinIcons.every((i) => i.html.trim().length > 0), "服务图标不能为空");
	const target = providers[0];
	assert.equal(await acc.getByTestId(`provider-toggle-${target.id}`).getAttribute("aria-expanded"), "false", "服务默认应收起");
	assert.equal(await acc.getByTestId(`provider-models-${target.id}`).count(), 0);
	await acc.getByTestId(`provider-toggle-${target.id}`).click();
	const modelRows = acc.getByTestId(`provider-models-${target.id}`).getByTestId("provider-model");
	await modelRows.first().waitFor();
	assert.equal(await modelRows.count(), 8, "展开应看到该服务支持的模型");
	await page.screenshot({ path: join(OUT, "06-settings-accordion.png") });
	// 能力标签：在渠道的模型行里展开编辑（原来那个全局长清单已去掉）
	await acc.getByTestId("provider-toggle-mock").click();
	const mockRow = acc.getByTestId("provider-models-mock").getByTestId("provider-model").first();
	await mockRow.waitFor();
	await mockRow.getByTestId("model-strength-toggle").click();
	const tag = page.getByTestId("strength-row").first().getByTestId("tag-coding");
	await tag.waitFor();
	const was = await tag.getAttribute("aria-pressed");
	await tag.click();
	await wait(async () => (await page.getByTestId("strength-row").first().getByTestId("tag-coding").getAttribute("aria-pressed")) !== was);
	await page.screenshot({ path: join(OUT, "06b-model-strength.png") });
	await acc.getByTestId(`provider-edit-${target.id}`).click();
	const form = page.getByTestId("custom-provider-form");
	await form.waitFor();
	await form.getByRole("button", { name: "取消" }).click();
	await acc.getByTestId(`provider-toggle-${target.id}`).click();
	await acc.getByTestId(`provider-edit-${target.id}`).click();
	await form.waitFor();
	await form.getByRole("button", { name: "删除", exact: true }).click();
	await page.getByTestId("confirm-dialog").waitFor();
	await page.getByTestId("confirm-cancel").click();
	assert.ok((await j("/api/models/custom")).providers.some((p) => p.id === target.id), "取消后服务仍在");
	await form.getByRole("button", { name: "删除", exact: true }).click();
	await page.getByTestId("confirm-ok").click();
	await wait(async () => !(await j("/api/models/custom")).providers.some((p) => p.id === target.id));
	assert.equal(nativeDialogs, 0, "不得调用原生 confirm");
	// 删除完成后回到列表（等列表 / 默认使用 / 识图模型都重新渲染完再验大分类折叠）
	await page.getByTestId("provider-accordion").waitFor();
	await page.getByTestId("default-model-picker").waitFor();
	await page.getByTestId("vision-model-picker").waitFor();
	// 大分类折叠：整个「模型服务 / 渠道」（添加渠道 + 内置服务 + 我的渠道）能一键全部关上，默认使用 / 识图模型不受影响
	const foldToggle = page.getByTestId("provider-section-toggle");
	await foldToggle.waitFor();
	assert.equal(await foldToggle.getAttribute("aria-expanded"), "true", "模型服务 / 渠道默认展开");
	assert.match(await foldToggle.innerText(), /模型服务 \/ 渠道/, "保留标题");
	assert.match(await foldToggle.innerText(), /\d+/, "标题应带服务数量");
	assert.equal(await page.getByTestId("provider-accordion").count(), 1, "展开时能看到渠道列表");
	const rowsOpen = await page.getByTestId("provider-row").count();
	assert.ok(rowsOpen > 0, `展开时应有渠道行：${rowsOpen}`);
	await foldToggle.scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(OUT, "10-services-expanded.png") });
	await foldToggle.click();
	assert.equal(await page.getByTestId("provider-section-toggle").getAttribute("aria-expanded"), "false", "可一键收起");
	assert.equal(await page.getByTestId("provider-accordion").count(), 0, "父级收起应完全不渲染渠道列表");
	assert.equal(await page.getByTestId("provider-row").count(), 0, "父级收起应隐藏所有渠道");
	assert.equal(await page.getByTestId("provider-group-builtin").count(), 0, "内置服务分组也隐藏");
	assert.equal(await page.getByTestId("provider-group-mine").count(), 0, "我的渠道分组也隐藏");
	assert.equal(await page.getByTestId("default-model-picker").count(), 1, "默认使用不受父级折叠影响");
	assert.equal(await page.getByTestId("vision-model-picker").count(), 1, "识图模型不受父级折叠影响");
	await foldToggle.scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(OUT, "11-services-collapsed.png") });
	// 390 窄屏同样可收起 / 展开，且不横向溢出
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	await page.getByTestId("provider-section-toggle").scrollIntoViewIfNeeded();
	assert.equal(await page.getByTestId("provider-accordion").count(), 0, "390 收起后仍不渲染渠道");
	assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, "390 收起不应横向溢出");
	await page.screenshot({ path: join(OUT, "12-services-collapsed-390.png") });
	await page.getByTestId("provider-section-toggle").click();
	await page.getByTestId("provider-accordion").waitFor();
	assert.equal(await page.getByTestId("provider-section-toggle").getAttribute("aria-expanded"), "true", "390 可重新展开");
	// 390 下卡片网格自适应为单列、不横向溢出
	const cols390 = await page.getByTestId("provider-grid-builtin").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
	assert.equal(cols390, 1, `390 应是单列网格，实际 ${cols390} 列`);
	assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, "390 展开不应横向溢出");
	await page.getByTestId("provider-section-toggle").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(OUT, "13-services-expanded-390.png") });
	await page.setViewportSize({ width: 1280, height: 900 });
	ok("设置按服务折叠、可看模型、编辑/删除用应用内确认框");
	ok("模型服务是带图标的卡片网格（每张卡一个可区分图标）");
	ok("模型服务 / 渠道是一个大分类，可一键全部关上，默认使用 / 识图模型不受影响");

	// ============================================================ 5b) 模型菜单锚定触发器（回归：设置弹窗里跑到容器右边 / 出屏 / 被裁）
	console.log("\n[5b] 模型菜单锚定触发器：设置弹窗里不再跑到右边，多视口 / 滚动 / 翻转都贴住按钮");
	const geom = async (btnId, menuId) => ({ btn: await page.getByTestId(btnId).boundingBox(), menu: await page.getByTestId(menuId).boundingBox() });
	const assertAnchored = (g, label, vw, vh) => {
		assert.ok(g.btn && g.menu, `${label}：应有按钮和菜单`);
		// 关键回归：旧实现 absolute right-0 贴的是整行容器右边，菜单会比按钮左缘偏出几百像素
		assert.ok(Math.abs(g.menu.x - g.btn.x) <= 2, `${label}：菜单左缘应贴住按钮（btn.x=${g.btn.x} menu.x=${g.menu.x}）`);
		assert.ok(g.menu.x >= -0.5 && g.menu.x + g.menu.width <= vw + 1, `${label}：菜单不能水平出屏`);
		assert.ok(g.menu.y >= -0.5 && g.menu.y + g.menu.height <= vh + 1, `${label}：菜单不能垂直出屏（不能被弹窗 overflow 裁掉）`);
	};
	const settingsStillOpen = async () => assert.ok(await page.getByTestId("settings-dialog").isVisible(), "模型菜单不应把设置弹窗一起关掉");

	// 识图模型 / 默认使用两个 picker 都锚定按钮（设置弹窗是块级容器，正是以前跑偏的地方）
	await page.getByTestId("vision-model-picker").click();
	await page.getByTestId("vision-model-menu").waitFor();
	{
		const g = await geom("vision-model-picker", "vision-model-menu");
		assertAnchored(g, "1280 识图模型", 1280, 900);
		assert.ok(g.menu.y >= g.btn.y + g.btn.height - 1 && g.menu.y <= g.btn.y + g.btn.height + 14, `识图模型菜单应贴在按钮下方：btnBottom=${g.btn.y + g.btn.height} menuTop=${g.menu.y}`);
		await settingsStillOpen();
	}
	// 滚动设置弹窗内容：菜单要跟着触发器一起走（不能留在原地）
	{
		const before = await geom("vision-model-picker", "vision-model-menu");
		await page.getByTestId("settings-content").evaluate((el) => (el.scrollTop += 120));
		await page.waitForTimeout(150);
		const after = await geom("vision-model-picker", "vision-model-menu");
		assert.ok(Math.abs((after.menu.y - after.btn.y) - (before.menu.y - before.btn.y)) <= 2, `滚动后菜单要贴回触发器：before ${before.menu.y - before.btn.y} / after ${after.menu.y - after.btn.y}`);
		assert.ok(Math.abs((after.menu.x - after.btn.x) - (before.menu.x - before.btn.x)) <= 2, "滚动后水平偏移不变");
		await page.getByTestId("settings-content").evaluate((el) => (el.scrollTop -= 120));
		await page.waitForTimeout(150);
	}
	// 窗口缩放后仍锚定
	await page.setViewportSize({ width: 1024, height: 800 });
	await page.waitForTimeout(150);
	assertAnchored(await geom("vision-model-picker", "vision-model-menu"), "1024 识图模型", 1024, 800);
	await page.keyboard.press("Escape");
	assert.equal(await page.getByTestId("vision-model-menu").count(), 0, "Escape 应只关菜单");
	await settingsStillOpen();

	// 视口矮时下方放不下：菜单要翻到按钮上方，而不是被弹窗 overflow 裁掉。
	// 先把触发器滚到滚动容器底部，确定性地制造“下方放不下”（否则滚动位置会因数据量不同而在下方恰好放得下，翻不翻转都合规）。
	await page.setViewportSize({ width: 1280, height: 420 });
	await page.waitForTimeout(150);
	await page.getByTestId("vision-model-picker").evaluate((el) => el.scrollIntoView({ block: "end" }));
	await page.waitForTimeout(100);
	await page.getByTestId("vision-model-picker").click();
	await page.getByTestId("vision-model-menu").waitFor();
	{
		const g = await geom("vision-model-picker", "vision-model-menu");
		assert.ok(g.btn && g.menu);
		assert.ok(g.menu.y + g.menu.height <= 420 + 1, "矮视口菜单不能出屏");
		assert.ok(g.menu.y + g.menu.height <= g.btn.y + 2, `下方放不下应翻到按钮上方：menuBottom=${g.menu.y + g.menu.height} btnTop=${g.btn.y}`);
		assert.ok(Math.abs(g.menu.x - g.btn.x) <= 2, "翻转后水平仍锚定按钮");
	}
	await page.keyboard.press("Escape");
	// 390 窄屏：底部弹窗模式，菜单仍在屏内、仍不裁
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(200);
	await page.getByTestId("vision-model-picker").scrollIntoViewIfNeeded();
	await page.getByTestId("vision-model-picker").click();
	await page.getByTestId("vision-model-menu").waitFor();
	{
		const m = await page.getByTestId("vision-model-menu").boundingBox();
		assert.ok(m && m.x >= -0.5 && m.x + m.width <= 390 + 1, `390 菜单不能水平出屏：${JSON.stringify(m)}`);
		assert.ok(m && m.y >= -0.5 && m.y + m.height <= 844 + 1, `390 菜单不能垂直出屏：${JSON.stringify(m)}`);
	}
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.waitForTimeout(150);
	ok("模型菜单锚定触发器：设置弹窗不再跑偏，滚动 / 缩放 / 翻转 / 390 都正常");

	// ============================================================ 6) 群聊成员 / 子代理入口复用
	console.log("\n[6] 群聊成员与子代理复用同一个模型菜单");
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.getByTestId("model-picker").waitFor();
	await j(`/api/agents/${agent.id}/messages`, "POST", { text: "帮我组个团队做个活动" });
	const card = page.getByTestId("room-proposal").last();
	await card.waitFor({ timeout: 30_000 });
	await card.getByTestId("pm-model").first().click();
	const pmMenu = page.getByTestId("pm-model-menu");
	await pmMenu.waitFor();
	await pmMenu.getByTestId("pm-model-option").first().waitFor();
	const pmFirst = await pmMenu.getByTestId("pm-model-option").first().getAttribute("data-model");
	await pmMenu.getByTestId("pm-model-option").first().click();
	await card.getByTestId("pm-reason").first().waitFor();
	assert.match(await card.getByTestId("pm-reason").first().innerText(), /你选的/, "选完模型应显示理由");
	await page.screenshot({ path: join(OUT, "07-room-member-picker.png") });
	assert.ok(pmFirst, "群聊成员菜单应有可选模型");

	// 设置 › 模型 › 子代理：只剩任务侧（并发 + 最长运行），不再有全局模型指定/挑选
	await page.goto(`${BASE}/?agent=${agent.id}&settings=models`);
	await page.getByTestId("subagent-section-toggle").waitFor();
	await page.getByTestId("subagent-section-toggle").click();
	const task = page.getByTestId("subagent-concurrency");
	await task.waitFor();
	assert.equal(await task.locator("select").count(), 0, "全局子代理设置不应有原生下拉框");
	assert.equal(await page.getByTestId("subagent-models").count(), 0, "全局不再有子代理模型选择");
	await page.screenshot({ path: join(OUT, "08-subagent-task-settings.png") });
	// 助理设置 › 子代理模型：候选池多选，勾选不关菜单（不是原生单选下拉）
	await page.goto(`${BASE}/?agent=${agent.id}`);
	if (!(await page.locator(".pa-pane-wrap").count())) await page.getByRole("button", { name: "信息面板" }).click();
	await page.locator(".pa-pane-wrap").waitFor();
	{
		const bar = page.getByTestId("info-tabs");
		const tab = bar.getByRole("tab", { name: "设置", exact: true });
		if (await tab.count()) await tab.click();
		else { await page.getByTestId("info-tabs-more").click(); await page.getByTestId("info-tabs-menu").getByRole("menuitem", { name: "设置", exact: true }).click(); }
	}
	const sub = page.getByTestId("agent-subagent-model");
	await sub.waitFor();
	assert.equal(await sub.locator("select").count(), 0, "候选池不应是原生 select");
	await sub.getByTestId("subagent-model").click();
	await page.getByTestId("subagent-model-menu").waitFor();
	await page.getByTestId("subagent-model-check").first().check();
	await wait(async () => (await j(`/api/agents/${agent.id}/subagent-model`)).pool.length === 1);
	await page.getByTestId("subagent-model-check").nth(1).check();
	await wait(async () => (await j(`/api/agents/${agent.id}/subagent-model`)).pool.length === 2);
	assert.ok(await page.getByTestId("subagent-model-menu").isVisible(), "勾选后菜单不关，可连续多选");
	await page.screenshot({ path: join(OUT, "09-subagent-pool.png") });
	await j(`/api/agents/${agent.id}/subagent-model`, "PUT", { pool: [] });
	assert.equal(nativeDialogs, 0, "全程不应出现原生 confirm");
	console.log("\n全部通过");
} catch (e) {
	console.error(logs.slice(-4000));
	console.error("异常：", e);
	process.exitCode = 1;
} finally {
	await browser?.close();
	server.kill("SIGTERM");
}
