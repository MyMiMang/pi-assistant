/**
 * 模型菜单「常用」专项验证（只跑这一个脚本，不跑全量 e2e）：
 * 需求：常用是快捷入口，**不把模型从原渠道（provider 分组）里搬走**。
 * 回归场景：选过一个「只有 1 个模型」的渠道后，原渠道分组整组消失、只剩常用。
 * 覆盖：
 *  1) 选过单模型渠道的模型后，该渠道分组仍在、行仍在（常用 + 原渠道各 1 行）
 *  2) 多模型渠道：选过的模型留在自己渠道里，其余模型不受影响
 *  3) canonical key 去重：两个渠道有同名模型 id，各在自己渠道各一行，跨渠道不合并
 *  4) 从常用 / 从原渠道点同一个模型，发出同一个 provider/id；已选勾两处同步
 *  5) 模型被挤出常用前 5 后，原渠道行仍在（取消常用 ≠ 从目录里消失）
 *  6) 删掉渠道后（ghost）常用与分组都不再显示
 *  7) 子代理候选池（ModelPoolMenu）与主菜单同一套规则
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { closeModelPanel, openModelMenu } from "./model-menu-flow.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = `/tmp/pia-e2e-model-favorites-${process.pid}`;
const OUT = process.env.SHOT_DIR ?? "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/model-picker-favorites";
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
	const agent = await j("/api/agents", "POST", { name: "常用入口验证" });

	// 单模型渠道（用户报的复现场景：只有 gpt-6.1-sol）+ 多模型渠道（同名模型跨渠道） + 第三个渠道
	const single = await j("/api/models/custom", "POST", { name: "单模型渠道", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true, models: [{ id: "gpt-6.1-sol", contextWindow: 131072, maxTokens: 8192 }] });
	const multi = await j("/api/models/custom", "POST", { name: "多模型渠道", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v2", noKey: true, models: [{ id: "gpt-6.1-sol", contextWindow: 131072, maxTokens: 8192 }, { id: "deepseek-v3", contextWindow: 131072, maxTokens: 8192 }, { id: "kimi-k2", contextWindow: 131072, maxTokens: 8192 }] });
	const third = await j("/api/models/custom", "POST", { name: "第三渠道", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v3", noKey: true, models: [{ id: "claude-4.5-sonnet", contextWindow: 131072, maxTokens: 8192 }] });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (e) => console.error("pageerror:", e));
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.getByTestId("model-picker").waitFor();

	// 聊天入口是两层弹层：先紧凑层，点模型名才进目录；选完模型回到紧凑层（弹层不关），
	// 所以关闭要按到底（Esc 先退一层），否则下一次「打开」实际是把它关掉。
	const open = async () => {
		await openModelMenu(page);
	};
	const close = async () => {
		await closeModelPanel(page);
		await page.waitForTimeout(60);
	};
	const ensureGroupOpen = async (menu, providerId) => {
		const g = menu.getByTestId(`model-group-${providerId}`);
		await g.waitFor();
		if ((await g.getAttribute("aria-expanded")) !== "true") await g.click();
	};
	/** 某个 canonical 条目在菜单里渲染了几行（常用 1 + 原渠道 1 = 2 是预期的） */
	const rowCount = (menu, key) => menu.locator(`[data-testid=model-option][data-model="${key}"]`).count();
	/** 某个渠道分组里渲染的模型行（分组头按钮的父节点就是分组容器，选项是它的兄弟） */
	const groupRows = async (menu, providerId) => {
		await ensureGroupOpen(menu, providerId);
		return menu.getByTestId(`model-group-${providerId}`).locator("xpath=..").locator("[data-testid=model-option]").evaluateAll((els) => els.map((e) => e.dataset.model));
	};

	// ================================================== 1) 单模型渠道：选过之后分组与行都还在
	console.log("\n[1] 单模型渠道选过之后：原渠道分组与行不能消失");
	await open();
	let menu = page.getByTestId("model-menu");
	await ensureGroupOpen(menu, single.id);
	await menu.locator(`[data-testid=model-option][data-model="${single.id}/gpt-6.1-sol"]`).click();
	await close();
	await open();
	menu = page.getByTestId("model-menu");
	await menu.getByTestId("model-frequent").waitFor();
	const freq1 = await menu.getByTestId("model-frequent").getByTestId("model-option").evaluateAll((els) => els.map((e) => e.dataset.model));
	assert.deepEqual(freq1, [`${single.id}/gpt-6.1-sol`], `常用应有刚选的模型：${freq1}`);
	await page.screenshot({ path: join(OUT, "01-single-provider-after-pick.png") });
	// 原渠道分组必须还在，且行还在（改前：整组消失，只剩常用）
	await menu.getByTestId(`model-group-${single.id}`).waitFor();
	assert.equal(await rowCount(menu, `${single.id}/gpt-6.1-sol`), 2, "常用 1 行 + 原渠道 1 行（原渠道条目不能被搬走）");
	await ensureGroupOpen(menu, single.id);
	const both = menu.locator(`[data-testid=model-option][data-model="${single.id}/gpt-6.1-sol"]`);
	assert.ok((await both.nth(0).isVisible()) && (await both.nth(1).isVisible()), "常用与原渠道两行都要可见");
	await both.nth(1).scrollIntoViewIfNeeded();
	await page.waitForTimeout(120);
	await page.screenshot({ path: join(OUT, "02-single-provider-group-kept.png") });
	ok("单模型渠道：选过之后分组仍在、原渠道行仍在（常用 + 原渠道各 1）");

	// ================================================== 2) 多模型渠道：选过的留在渠道里
	console.log("\n[2] 多模型渠道：选过的模型留在自己渠道里，其余模型不受影响");
	await ensureGroupOpen(menu, multi.id);
	await menu.locator(`[data-testid=model-option][data-model="${multi.id}/deepseek-v3"]`).click();
	await close();
	await open();
	menu = page.getByTestId("model-menu");
	await menu.getByTestId("model-frequent").waitFor();
	let rows = await groupRows(menu, multi.id);
	assert.ok(rows.includes(`${multi.id}/deepseek-v3`), `原渠道应仍有选过的模型：${rows}`);
	assert.ok(rows.includes(`${multi.id}/gpt-6.1-sol`) && rows.includes(`${multi.id}/kimi-k2`), `其余模型不受影响：${rows}`);
	assert.equal(new Set(rows).size, rows.length, `同一分组内不能重复渲染：${rows}`);
	await menu.locator(`[data-testid=model-option][data-model="${multi.id}/kimi-k2"]`).scrollIntoViewIfNeeded().catch(() => {});
	await page.waitForTimeout(120);
	await page.screenshot({ path: join(OUT, "03-multi-provider-kept.png") });
	ok("多模型渠道：选过的模型留在渠道里，同分组内不重复");

	// ================================================== 3) 同名模型跨渠道：各在自己渠道，各自一行
	console.log("\n[3] 两个渠道有同名模型 id：各在自己渠道各一行，跨渠道不合并");
	assert.equal(Number(multi.id !== single.id), 1);
	rows = await groupRows(menu, multi.id);
	assert.ok(rows.includes(`${multi.id}/gpt-6.1-sol`), `多模型渠道应保留自己的 gpt-6.1-sol：${rows}`);
	rows = await groupRows(menu, single.id);
	assert.ok(rows.includes(`${single.id}/gpt-6.1-sol`), `单模型渠道应保留自己的 gpt-6.1-sol：${rows}`);
	const freq3 = await menu.getByTestId("model-frequent").getByTestId("model-option").evaluateAll((els) => els.map((e) => e.dataset.model));
	assert.ok(!freq3.includes(`${multi.id}/gpt-6.1-sol`), "没选过的同名模型不应进常用（canonical 不能只按 id 匹配）");
	ok("跨渠道同名模型不合并，各自渠道各一行");

	// ================================================== 4) 已选勾两处同步 + 两处点击发出同一 id
	console.log("\n[4] 已选勾在常用与原渠道同步；两处点击发出同一个 provider/id");
	const keySingle = `${single.id}/gpt-6.1-sol`;
	// 当前选中值是 step 2 选的 multi/deepseek-v3；先从原渠道把 single/gpt-6.1-sol 选回来
	await ensureGroupOpen(menu, single.id);
	await menu.getByTestId(`model-group-${single.id}`).locator("xpath=..").locator(`[data-testid=model-option][data-model="${keySingle}"]`).click();
	await open();
	menu = page.getByTestId("model-menu");
	await menu.getByTestId("model-frequent").waitFor();
	// 已选勾：同一个 canonical 条目在常用与原渠道两行都要有（按 svg 上的 text-accent 判断，避 CSS 选择器差异）
	const checkMarks = (key) => menu.locator(`[data-testid=model-option][data-model="${key}"]`).evaluateAll((els) => els.map((e) => [...e.querySelectorAll("svg")].filter((s) => s.classList.contains("text-accent")).length));
	assert.deepEqual(await checkMarks(keySingle), [1, 1], "常用与原渠道两行都应显示已选勾");
	// 从常用再点一次同一个模型：记录同一个 canonical key
	const picksBefore = (await j("/api/models/picks")).picks[keySingle].count;
	await menu.getByTestId("model-frequent").locator(`[data-testid=model-option][data-model="${keySingle}"]`).click();
	await wait(async () => (await j("/api/models/picks")).picks[keySingle].count === picksBefore + 1);
	// 从原渠道点同一个模型：还是同一个 key，不产生第二个条目
	await open();
	menu = page.getByTestId("model-menu");
	await ensureGroupOpen(menu, single.id);
	await menu.getByTestId(`model-group-${single.id}`).locator("xpath=..").locator(`[data-testid=model-option][data-model="${keySingle}"]`).click();
	await wait(async () => (await j("/api/models/picks")).picks[keySingle].count === picksBefore + 2);
	assert.equal(Object.keys((await j("/api/models/picks")).picks).filter((k) => k.endsWith("/gpt-6.1-sol")).length, 1, "两处点击只记一个 canonical key");
	ok("已选勾两处同步，常用/原渠道点击发出同一个 id");

	// ================================================== 5) 被挤出常用前 5：原渠道行仍在
	console.log("\n[5] 模型被挤出常用前 5 后，原渠道行仍在（取消常用 ≠ 目录里消失）");
	const bump = async (provider, id, n) => {
		for (let i = 0; i < n; i++) await j("/api/models/picks", "POST", { provider, id });
	};
	// 把 single/gpt-6.1-sol（频次 3）挤出常用前 5
	await bump(third.id, "claude-4.5-sonnet", 6);
	await bump(multi.id, "gpt-6.1-sol", 5);
	await bump(multi.id, "deepseek-v3", 5);
	await bump(multi.id, "kimi-k2", 4);
	await bump("mock", "echo", 4);
	// 页面里的常用来自挂载时拉取的 picks，直接改服务端后刷新一次页面再看
	await close();
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	await open();
	menu = page.getByTestId("model-menu");
	await menu.getByTestId("model-frequent").waitFor();
	const freq5 = await menu.getByTestId("model-frequent").getByTestId("model-option").evaluateAll((els) => els.map((e) => e.dataset.model));
	assert.ok(!freq5.includes(`${single.id}/gpt-6.1-sol`), `单模型渠道的模型应已被挤出常用：${freq5}`);
	rows = await groupRows(menu, single.id);
	assert.ok(rows.includes(`${single.id}/gpt-6.1-sol`), `不在常用时原渠道仍要能看到：${rows}`);
	await page.screenshot({ path: join(OUT, "05-kept-after-leaving-frequent.png") });
	ok("掉出常用后原渠道行仍在");

	// ================================================== 6) 删除渠道后 ghost 不再出现
	console.log("\n[6] 删掉渠道后：常用与分组都不再显示这个模型");
	await close();
	const deletedId = single.id;
	await j(`/api/models/custom/${deletedId}`, "DELETE");
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	await open();
	menu = page.getByTestId("model-menu");
	await menu.waitFor();
	assert.equal(await menu.getByTestId(`model-group-${deletedId}`).count(), 0, "已删除渠道不应再出现在菜单里");
	assert.equal(await rowCount(menu, `${deletedId}/gpt-6.1-sol`), 0, "已删除渠道的模型不能从常用里 ghost 显示");
	await page.screenshot({ path: join(OUT, "06-deleted-provider-ghost.png") });
	await close();
	ok("删除渠道后常用/分组都不再显示（ghost 不回流）");

	// ================================================== 7) 子代理候选池同一套规则
	console.log("\n[7] 子代理候选池（多选菜单）与主菜单同一套规则");
	await page.goto(`${BASE}/?agent=${agent.id}`);
	if (!(await page.locator(".pa-pane-wrap").count())) await page.getByRole("button", { name: "信息面板" }).click();
	await page.locator(".pa-pane-wrap").waitFor();
	{
		const bar = page.getByTestId("info-tabs");
		const tab = bar.getByRole("tab", { name: "设置", exact: true });
		if (await tab.count()) await tab.click();
		else {
			await page.getByTestId("info-tabs-more").click();
			await page.getByTestId("info-tabs-menu").getByRole("menuitem", { name: "设置", exact: true }).click();
		}
	}
	await page.getByTestId("subagent-model").click();
	const pool = page.getByTestId("subagent-model-menu");
	await pool.waitFor();
	// 候选池里选过（勾选）的模型，同样要留在原渠道分组里
	const poolGroup = pool.getByTestId(`subagent-model-group-${multi.id}`);
	await poolGroup.waitFor();
	if ((await poolGroup.getAttribute("aria-expanded")) !== "true") await poolGroup.click();
	await pool.getByTestId(`subagent-model-group-${multi.id}`).locator("xpath=..").locator(`[data-testid=subagent-model-option][data-model="${multi.id}/kimi-k2"]`).locator("input").check();
	await wait(async () => (await j(`/api/agents/${agent.id}/subagent-model`)).pool.length === 1);
	const poolRows = await pool.getByTestId(`subagent-model-group-${multi.id}`).locator("xpath=..").locator("[data-testid=subagent-model-option]").evaluateAll((els) => els.map((e) => e.dataset.model));
	assert.ok(poolRows.includes(`${multi.id}/kimi-k2`), `候选池里选过的模型也应留在原渠道：${poolRows}`);
	assert.equal(new Set(poolRows).size, poolRows.length, "候选池同一分组内不能重复");
	await page.screenshot({ path: join(OUT, "07-subagent-pool-kept.png") });
	await j(`/api/agents/${agent.id}/subagent-model`, "PUT", { pool: [] });
	ok("子代理候选池：选过的模型留在原渠道分组");
	console.log("\n全部通过");
} catch (e) {
	console.error(logs.slice(-4000));
	console.error("异常：", e);
	process.exitCode = 1;
} finally {
	await browser?.close();
	server.kill("SIGTERM");
	setTimeout(() => server.kill("SIGKILL"), 1500).unref();
	rmSync(DATA, { recursive: true, force: true });
}
