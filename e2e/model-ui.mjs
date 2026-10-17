/**
 * 模型 UI 专项验证（只跑这一个脚本，不跑全量 e2e）：
 * 1) 长列表多服务：按 provider 分组折叠、搜索能找到折叠组里的模型
 * 2) 常用 5：按选择频次置顶、原渠道分组里仍保留同一模型（常用是快捷入口）、刷新后仍在（服务端持久化）
 * 3) 模型 + 思考强度合并在同一个菜单 / 同一个按钮
 * 4) 390 窄中栏：按钮只留图标、无横向溢出、上下文圆环独立
 * 5) 设置 › 模型：顶部紧凑（默认使用 / 识图模型都是合一的按钮）、整个「模型服务 / 渠道」（添加渠道 + 内置 + 我的渠道）
 *    是一个带图标 / 数量 / 箭头的可折叠大分类、可一键全部关上；里面渠道按内置/我的分组成「带服务图标的卡片网格」，
 *    点卡片展开看该服务模型、模型行内改能力标签、编辑/删除沿用应用内确认框（无原生 confirm）
 * 6) 群聊成员与子代理的模型入口复用同一个菜单
 * 隔离：每次 mkdtemp 的临时 DATA / WORKSPACE / HOME / TMPDIR，服务走 `test/launch-memory.ts`
 * （内存凭据，不构造生产后端）；原生 Chrome 用 `e2e/fixtures/native-launch-env.mjs` 的真实 HOME / TMPDIR。
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { closeModelPanel, openCompact, openModelMenu } from "./model-menu-flow.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
// 本次运行独占的临时目录（DATA / WORKSPACE / HOME / TMPDIR）；finally 只删它自己
const run = makeTempRun("pia-e2e-model-ui-");
const OUT = process.env.SHOT_DIR ?? "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/model-ui";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const PORT = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
const srv = startTempServer({ root: ROOT, port: PORT, run });
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

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
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
	// 聊天入口是两层弹层：先紧凑层，点模型名才进完整目录
	const menu = await openModelMenu(page);
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
	await closeModelPanel(page);
	ok("按服务折叠、用户命名、搜索能找到全部模型");

	// ============================================================ 2) 常用 5
	console.log("\n[2] 常用 5：按频次置顶、原渠道仍保留、刷新后仍在");
	const pick = async (providerIdx, modelId) => {
		await openModelMenu(page);
		await page.getByTestId("model-search").fill(modelId);
		await page.getByTestId("model-option").first().click();
	};
	await pick(0, "m-1-1");
	await pick(1, "m-2-2");
	await pick(0, "m-1-1"); // 再选一次 → 频次 2
	for (const [i, id] of [[2, "m-3-3"], [3, "m-4-4"], [4, "m-5-5"], [5, "m-6-6"]]) await pick(i, id);
	const expectFreq = [`${providers[0].id}/m-1-1`, `${providers[5].id}/m-6-6`, `${providers[4].id}/m-5-5`, `${providers[3].id}/m-4-4`, `${providers[2].id}/m-3-3`];
	const freqOf = async () => {
		await openModelMenu(page);
		await page.getByTestId("model-frequent").waitFor();
		const freq = await page.getByTestId("model-frequent").getByTestId("model-option").evaluateAll((els) => els.map((e) => e.dataset.model));
		const all = await page.getByTestId("model-menu").getByTestId("model-option").evaluateAll((els) => els.map((e) => e.dataset.model));
		return { freq, all };
	};
	let { freq, all } = await freqOf();
	assert.deepEqual(freq, expectFreq, `常用应按频次/最近排序：${freq}`);
	assert.equal(new Set(freq).size, freq.length, `常用内不应重复：${freq}`);
	// 常用是快捷入口：选过的模型在原渠道分组里必须还有 1 行（不能把条目从目录里搬走）
	const freqMenu = page.getByTestId("model-menu");
	const openGroup = async (providerId) => {
		const g = freqMenu.getByTestId(`model-group-${providerId}`);
		if ((await g.getAttribute("aria-expanded")) !== "true") await g.click();
	};
	await openGroup(providers[5].id);
	const rows5 = await freqMenu.getByTestId(`model-group-${providers[5].id}`).locator("xpath=..").locator("[data-testid=model-option]").evaluateAll((els) => els.map((e) => e.dataset.model));
	assert.ok(rows5.includes(`${providers[5].id}/m-6-6`), `常用里的模型必须仍在原渠道：${rows5}`);
	assert.equal(new Set(rows5).size, rows5.length, `同一分组内不应重复：${rows5}`);
	assert.equal(await freqMenu.locator(`[data-testid=model-option][data-model="${providers[5].id}/m-6-6"]`).count(), 2, "常用 1 行 + 原渠道 1 行");
	assert.ok(all.length >= freq.length, "渲染的条目数至少要覆盖常用");
	await page.screenshot({ path: join(OUT, "03-menu-frequent.png") });
	await closeModelPanel(page);
	const picks = (await j("/api/models/picks")).picks;
	assert.equal(picks[`${providers[0].id}/m-1-1`].count, 2, "服务端应记录频次");
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	({ freq } = await freqOf());
	assert.deepEqual(freq, expectFreq, `刷新后常用应保留：${freq}`);
	await closeModelPanel(page);
	ok("常用 5 置顶、按频次 + 最近选择、原渠道仍保留、刷新后保留");

	// ============================================================ 3) 模型 + 思考强度统一
	console.log("\n[3] 模型 + 思考强度合并在一个菜单 / 一个按钮");
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: "mock", id: "echo-think" } });
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	// 紧凑层就带滑块，不用先进目录（用户参考 Codex 的两层结构）
	const compact3 = await openCompact(page);
	await compact3.getByTestId("thinking-body").waitFor();
	await compact3.getByTestId("thinking-high").click();
	await wait(async () => (await j("/api/agents")).find((x) => x.id === agent.id).thinking === "high");
	await page.getByTestId("model-picker").getByText(/· 高/).waitFor();
	await openCompact(page);
	await page.screenshot({ path: join(OUT, "04-model-thinking.png") });
	// 目录层只选模型：同一套强度 / Fast 不在这里重复一遍
	await page.getByTestId("model-picker-compact").getByTestId("thinking-model").click();
	await page.getByTestId("model-menu").waitFor();
	assert.equal(await page.getByTestId("model-menu").getByTestId("model-thinking").count(), 0, "目录层不再重复整块滑块");
	assert.equal(await page.getByTestId("model-menu").getByTestId("thinking-fast").count(), 0, "目录层不再重复 Fast");
	await page.getByTestId("model-back").click();
	await page.getByTestId("model-picker-compact").waitFor();
	assert.equal((await page.getByTestId("model-picker").getAttribute("aria-label"))?.includes("高"), true, "返回只退一层，不改已存档位");
	await closeModelPanel(page);
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: "mock", id: "echo" } });
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	const compactNoReason = await openCompact(page);
	// 打开后模型目录可能还在加载（加载中不冒充「不支持」）；等目录落地再看空态。
	// Pi 对不支持推理的模型只给一档 off，界面是「只有一档 / 不需要调整」（fixed），不是 unsupported。
	await wait(async () => (await compactNoReason.getByTestId("thinking-fixed").count()) === 1);
	assert.equal(await compactNoReason.getByTestId("thinking-fixed").count(), 1, "只有一档的模型仍打开紧凑层，并说明不需要调整");
	assert.match(await compactNoReason.getByTestId("thinking-fixed").innerText(), /只有一档/, "说明是一档而不是假装有滑块");
	assert.equal(await compactNoReason.getByTestId("thinking-body").locator('[role="slider"]').count(), 0, "不画滑块");
	await closeModelPanel(page);
	ok("一个按钮里同时换模型和设思考强度（两层：紧凑层调档、目录层只选模型）");

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
	const compact390 = await openCompact(page);
	const cbox = await compact390.boundingBox();
	assert.ok(cbox && cbox.x >= 0 && cbox.x + cbox.width <= 390 + 1, `390 下紧凑层应在屏幕内：${JSON.stringify(cbox)}`);
	await compact390.getByTestId("thinking-model").click();
	const mmenu = page.getByTestId("model-menu");
	await mmenu.waitFor();
	const box = await mmenu.boundingBox();
	assert.ok(box && box.x >= 0 && box.x + box.width <= 390 + 1, `菜单应在屏幕内：${JSON.stringify(box)}`);
	await page.screenshot({ path: join(OUT, "05-390-composer.png") });
	await closeModelPanel(page);
	ok("390 窄中栏只留图标、无溢出、圆环独立");

	// ============================================================ 5) 设置 › 模型：新版排版 + 折叠渠道 + 渠道内能力 + 编辑/删除
	// ============================================================ 5) 设置 › 模型：统一面板 + 卡片网格 + 擅长标签 + 编辑/删除确认
	console.log("\n[5] 设置 › 模型：默认使用紧凑、统一模型服务面板、卡片网格、模型行内擅长标签、编辑/删除走应用内确认框");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${BASE}/?agent=${agent.id}&settings=models`);
	const panel = page.getByTestId("model-services-panel");
	await panel.waitFor();
	// 顶部：默认使用是一个合一按钮；旧的独立识图模型选择器已删除（图片跟当前 chat）
	assert.equal(await page.getByTestId("default-model-picker").count(), 1, "默认使用应是一个按钮");
	assert.equal(await page.getByTestId("vision-model-picker").count(), 0, "不再有独立识图模型选择器");
	assert.equal(await page.getByTestId("default-model-select").count(), 0, "默认模型不再是下拉框");
	// 服务卡片网格：每张卡都有可区分图标
	const grid = page.getByTestId("service-grid");
	await grid.waitFor();
	const cardIcons = await grid.locator("[data-testid=service-icon]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-service-icon-kind")}:${e.innerHTML}`));
	assert.ok(cardIcons.length >= 6, `应至少有 6 个服务卡片图标：${cardIcons.length}`);
	assert.ok(new Set(cardIcons).size >= 2, "服务图标不能所有服务一个样");
	// 展开一个自定义渠道：看模型 + 在模型行内改「擅长」标签（建群按这个挑）
	const target = providers[0];
	const serviceCard = page.locator(`[data-testid=service-card][data-service=${target.id}]`);
	await serviceCard.getByTestId(`service-toggle-${target.id}`).click();
	const modelRow = serviceCard.getByTestId("service-model").first();
	await modelRow.waitFor();
	await modelRow.getByTestId("model-strength-toggle").click();
	const tag = page.getByTestId("strength-row").first().getByTestId("tag-coding");
	await tag.waitFor();
	const was = await tag.getAttribute("aria-pressed");
	await tag.click();
	await wait(async () => (await page.getByTestId("strength-row").first().getByTestId("tag-coding").getAttribute("aria-pressed")) !== was);
	// 编辑渠道：内嵌真实表单（保存 / 删除走公开 API），取消回列表
	await serviceCard.getByTestId(`service-edit-${target.id}`).click();
	const form = page.getByTestId("custom-provider-form");
	await form.waitFor();
	await form.getByRole("button", { name: "取消" }).click();
	// 删除：应用内确认框（不是原生 confirm）；取消后服务仍在
	await serviceCard.getByTestId(`service-delete-${target.id}`).click();
	await page.getByTestId("confirm-dialog").waitFor();
	await page.getByTestId("confirm-cancel").click();
	await page.waitForTimeout(80);
	assert.ok((await j("/api/models/custom")).providers.some((p) => p.id === target.id), "取消后服务仍在");
	assert.equal(nativeDialogs, 0, "不得调用原生 confirm");
	// 大分类折叠：整个「模型服务」可一键关上，默认使用不受影响
	const foldToggle = page.getByTestId("model-services-toggle");
	await foldToggle.waitFor();
	assert.equal(await foldToggle.getAttribute("aria-expanded"), "true", "模型服务默认展开");
	assert.match(await foldToggle.innerText(), /模型服务/, "保留标题");
	await foldToggle.click();
	assert.equal(await page.getByTestId("model-services-toggle").getAttribute("aria-expanded"), "false", "可一键收起");
	assert.equal(await page.getByTestId("service-grid").count(), 0, "父级收起应完全不渲染服务网格");
	assert.equal(await page.getByTestId("default-model-picker").count(), 1, "默认使用不受父级折叠影响");
	await foldToggle.click();
	await page.getByTestId("service-grid").waitFor();
	// 390 窄屏：单列、不横向溢出
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	const cols390 = await page.getByTestId("service-grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
	assert.equal(cols390, 1, `390 应是单列网格，实际 ${cols390} 列`);
	assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1, "390 展开不应横向溢出");
	await page.screenshot({ path: join(OUT, "13-services-expanded-390.png") });
	await page.setViewportSize({ width: 1280, height: 900 });
	ok("设置统一面板：卡片网格、模型行内擅长标签、编辑/删除应用内确认、可一键折叠、390 单列不溢出");
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
	await page.getByTestId("default-model-picker").click();
	await page.getByTestId("default-model-menu").waitFor();
	{
		const g = await geom("default-model-picker", "default-model-menu");
		assertAnchored(g, "1280 识图模型", 1280, 900);
		assert.ok(g.menu.y >= g.btn.y + g.btn.height - 1 && g.menu.y <= g.btn.y + g.btn.height + 14, `识图模型菜单应贴在按钮下方：btnBottom=${g.btn.y + g.btn.height} menuTop=${g.menu.y}`);
		await settingsStillOpen();
	}
	// 滚动设置弹窗内容：菜单要跟着触发器一起走（不能留在原地）
	{
		const before = await geom("default-model-picker", "default-model-menu");
		await page.getByTestId("settings-content").evaluate((el) => (el.scrollTop += 120));
		await page.waitForTimeout(150);
		const after = await geom("default-model-picker", "default-model-menu");
		assert.ok(Math.abs((after.menu.y - after.btn.y) - (before.menu.y - before.btn.y)) <= 2, `滚动后菜单要贴回触发器：before ${before.menu.y - before.btn.y} / after ${after.menu.y - after.btn.y}`);
		assert.ok(Math.abs((after.menu.x - after.btn.x) - (before.menu.x - before.btn.x)) <= 2, "滚动后水平偏移不变");
		await page.getByTestId("settings-content").evaluate((el) => (el.scrollTop -= 120));
		await page.waitForTimeout(150);
	}
	// 窗口缩放后仍锚定
	await page.setViewportSize({ width: 1024, height: 800 });
	await page.waitForTimeout(150);
	assertAnchored(await geom("default-model-picker", "default-model-menu"), "1024 识图模型", 1024, 800);
	await page.keyboard.press("Escape");
	assert.equal(await page.getByTestId("default-model-menu").count(), 0, "Escape 应只关菜单");
	await settingsStillOpen();

	// 视口矮时下方放不下：菜单要翻到按钮上方，而不是被弹窗 overflow 裁掉。
	// 触发器在模型页顶部，靠滚动无法把它移到下半屏；用很矮的视口（200）确定性地制造「下方放不下」。
	await page.setViewportSize({ width: 1280, height: 200 });
	await page.waitForTimeout(150);
	await page.getByTestId("default-model-picker").click();
	await page.getByTestId("default-model-menu").waitFor();
	{
		const g = await geom("default-model-picker", "default-model-menu");
		assert.ok(g.btn && g.menu);
		assert.ok(g.menu.y >= -0.5 && g.menu.y + g.menu.height <= 200 + 1, "矮视口菜单不能出屏");
		assert.ok(g.menu.y < g.btn.y, `下方放不下应翻到按钮上方：menuTop=${g.menu.y} btnTop=${g.btn.y}`);
		assert.ok(Math.abs(g.menu.x - g.btn.x) <= 2, "翻转后水平仍锚定按钮");
	}
	await page.keyboard.press("Escape");
	// 390 窄屏：底部弹窗模式，菜单仍在屏内、仍不裁
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(200);
	await page.getByTestId("default-model-picker").scrollIntoViewIfNeeded();
	await page.getByTestId("default-model-picker").click();
	await page.getByTestId("default-model-menu").waitFor();
	{
		const m = await page.getByTestId("default-model-menu").boundingBox();
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

	// 设置 › 模型：只剩在线服务（不再有本地 Laya / SenseVoice 卡，也不再有子代理折叠区）
	await page.goto(`${BASE}/?agent=${agent.id}&settings=models`);
	await page.getByTestId("model-services").waitFor();
	assert.equal(await page.getByTestId("subagent-section").count(), 0, "模型页不再有子代理折叠区");
	assert.equal(await page.getByTestId("subagent-concurrency").count(), 0, "模型页不再有全局子代理任务设置");
	assert.equal(await page.getByTestId("local-laya-card").count(), 0, "模型页不再有 Laya 卡");
	assert.equal(await page.getByTestId("local-sensevoice-card").count(), 0, "模型页不再有 SenseVoice 卡");
	await page.screenshot({ path: join(OUT, "08-model-services-slim.png") });
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
	console.error(srv.logs().slice(-4000));
	console.error("异常：", e);
	process.exitCode = 1;
} finally {
	await browser?.close();
	await srv.stop();
	cleanupTempRun(run);
}
