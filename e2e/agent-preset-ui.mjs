/**
 * 新建助理的「全能培训师」模板：真实服务 / 真实构建页面 / 临时数据。
 *
 * 覆盖：新建助理 → 点「全能培训师」→ 人设自动填好 → 创建 → 这个助理启用了内置技能 builtin/team-onboarding；
 *       用别的模板新建的助理不会多启用技能；390 宽对话框截图。
 *
 * 全程临时 DATA/WORKSPACE/HOME/TMPDIR + 内存凭据 + Mock，不碰生产库 / 凭据 / 付费模型。
 * 运行：node e2e/agent-preset-ui.mjs（截图写 artifacts/screenshots/agent-preset/）
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-agent-preset-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const out = join(artifactDir("screenshots"), "agent-preset");
mkdirSync(out, { recursive: true });
const j = async (path) => { const r = await fetch(base + path); if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); };
const wait = async (fn, ms = 30000, label = "condition") => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`${label} timed out`); };
let browser, page;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok, 30000, "server");
	await fetch(base + "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ onboarded: true }) });
	// 先有一个助理，跳过首次向导，从侧边栏「新建助理」进
	await fetch(base + "/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "原有助理" }) });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" })).newPage();
	await page.goto(base);

	const create = async (name, preset, shot) => {
		await page.getByRole("button", { name: "新建助理" }).first().click();
		const dlg = page.locator("div.fixed.inset-0");
		await dlg.getByPlaceholder("给助理起个名字").fill(name);
		await dlg.getByRole("button", { name: preset, exact: true }).click();
		if (shot) await shot(dlg);
		await dlg.getByRole("button", { name: "创建", exact: true }).click();
		let a;
		await wait(async () => (a = (await j("/api/agents")).find((x) => x.name === name)), 15000, `${name} 建好`);
		return a;
	};

	console.log("[1] 用「全能培训师」模板新建：人设自动填好，建好后启用 team-onboarding 技能");
	const trainer = await create("培训师", "全能培训师", async (dlg) => {
		const persona = await dlg.locator("textarea").first().inputValue();
		assert.match(persona, /全能培训师/, "人设自动填好");
		assert.match(persona, /team-onboarding/, "人设提到要用的技能");
		assert.doesNotMatch(persona, /灯灯/, "模板人设是通用的");
		await page.screenshot({ path: join(out, "01-preset-trainer.png") });
		await page.setViewportSize({ width: 390, height: 844 });
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391), "390 对话框不横向溢出");
		await page.screenshot({ path: join(out, "02-preset-trainer-390.png") });
		await page.setViewportSize({ width: 1440, height: 1000 });
	});
	await wait(async () => (await j(`/api/agents/${trainer.id}/skills`)).enabled.includes("builtin/team-onboarding"), 10000, "培训师启用了内置技能");
	assert.deepEqual((await j(`/api/agents/${trainer.id}/skills`)).enabled, ["builtin/team-onboarding"]);

	console.log("[2] 用别的模板新建：不额外启用技能");
	const writer = await create("写手", "写作助手");
	assert.deepEqual((await j(`/api/agents/${writer.id}/skills`)).enabled, [], "普通模板默认不启用技能");
	console.log("PASS agent-preset: 全能培训师模板填好人设并启用内置技能；普通模板不受影响");
} catch (e) {
	console.error("AGENT PRESET FAIL", e.message);
	await page?.screenshot({ path: join(out, "fail.png") }).catch(() => {});
	throw e;
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
