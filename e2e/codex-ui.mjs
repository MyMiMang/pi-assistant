/**
 * Codex（本机）接入 e2e（方案 docs/design/cli-models.md §5）。
 * 临时数据 + Mock + 假 codex（packages/server/test/fixtures/fake-codex.mjs 包一层脚本），绝不调用真实 codex。
 * 覆盖：模型服务页卡片（没装 → 未登录 → 已登录，重新检测不用重启；全局 AGENTS.md 提示）、模型选择里出现 model/list 的 Codex 模型
 * （luna 没有 max 档、没有 Fast）、单聊选 GPT-6.1-Sol 发消息看到假 codex 的回答（用量行不显示钱）、
 * 假 codex 调 bash 出现审批卡、批准后回答继续、390 宽不横向溢出。
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";
import { openModelMenu } from "./model-menu-flow.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const FAKE = join(root, "packages/server/test/fixtures/fake-codex.mjs");
const OUT = artifactDir("codex-ui");
const run = makeTempRun("pia-codex-ui-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const binDir = join(run.runDir, "bin");
mkdirSync(binDir, { recursive: true });
const CODEX = join(binDir, "codex"); // 一开始还不存在 = 「没装」
const scenarioFile = join(run.runDir, "scenario");
const codexHome = join(run.runDir, "codex-home"); // 假 codex 用「目录下有 logged-out 文件」表示未登录（环境白名单挡掉自定义变量）
mkdirSync(codexHome, { recursive: true });
const loggedOut = join(codexHome, "logged-out");
writeFileSync(scenarioFile, "text");
const installFake = () => {
	writeFileSync(CODEX, `#!/bin/sh\nFAKE_CODEX_SCENARIO_FILE="${scenarioFile}" exec "${process.execPath}" "${FAKE}" "$@"\n`);
	chmodSync(CODEX, 0o755);
};
const server = startTempServer({ root, port, run, extra: { PIA_CODEX_COMMAND: CODEX, CODEX_HOME: codexHome } });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path} ${r.status}`); return r.json(); };
const wait = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("condition timed out"); };
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}：页面不横向溢出`);
let browser;
try {
	await wait(async () => { if (server.child.exitCode !== null) throw new Error("临时服务提前退出"); try { return (await fetch(base + "/api/system", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } });
	await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
	const agent = await j("/api/agents", "POST", { name: "Codex 测试助理" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));

	// ---- 1) 模型服务页卡片：没装 → 未登录 → 已登录
	await page.goto(`${base}/?settings=models`);
	const card = page.getByTestId("codex-card");
	await card.waitFor();
	await page.getByTestId("codex-status").getByText("没装").waitFor();
	assert.match(await page.getByTestId("codex-status").innerText(), /没装/);
	assert.match(await page.getByTestId("codex-hint").innerText(), /重新检测/);
	await card.scrollIntoViewIfNeeded();
	await card.screenshot({ path: join(OUT, "01-card-not-installed.png") });
	assert.equal((await j("/api/models")).some((m) => m.provider === "codex"), false, "没装时模型列表里没有 Codex");

	writeFileSync(loggedOut, "");
	writeFileSync(join(codexHome, "AGENTS.md"), "这份内容不会被读取");
	installFake();
	await page.getByTestId("codex-recheck").click();
	await wait(async () => (await card.getAttribute("data-installed")) === "true");
	assert.equal(await card.getAttribute("data-logged-in"), "false");
	assert.match(await page.getByTestId("codex-status").innerText(), /已安装 v0\.161\.0.*未登录/s);
	assert.match(await page.getByTestId("codex-hint").innerText(), /codex login/);
	await card.screenshot({ path: join(OUT, "02-card-not-logged-in.png") });

	assert.match(await page.getByTestId("codex-agents-md").innerText(), /全局 AGENTS\.md/);
	rmSync(loggedOut);
	await page.getByTestId("codex-recheck").click();
	await wait(async () => (await card.getAttribute("data-logged-in")) === "true");
	assert.equal(await card.getAttribute("data-registered"), "true");
	assert.match(await page.getByTestId("codex-status").innerText(), /已登录/);
	assert.equal(await page.getByTestId("codex-hint").count(), 0);
	await card.screenshot({ path: join(OUT, "03-card-ready.png") });
	assert.equal(await page.locator('[data-testid=service-card][data-service="codex"]').count(), 0, "不重复成普通服务卡片");
	await noOverflow(page, "桌面设置页");

	// ---- 2) 模型列表：来自 model/list，隐藏的不要；luna 没有 max 档；没有 Fast
	const list = (await j("/api/models")).filter((m) => m.provider === "codex");
	assert.deepEqual(list.map((m) => m.id).sort(), ["gpt-6-luna", "gpt-6.1-sol"]);
	assert.ok(list.find((m) => m.id === "gpt-6.1-sol").thinking.includes("max"));
	assert.ok(!list.find((m) => m.id === "gpt-6-luna").thinking.includes("max"), "luna 没有 max");
	assert.ok(list.every((m) => m.fast.capability === "unsupported"), "没有 Fast");

	// ---- 3) 单聊：选 Codex · GPT-6.1-Sol，发消息
	await page.goto(`${base}/?agent=${agent.id}`);
	const menu = await openModelMenu(page);
	await page.getByTestId("model-search").fill("Codex");
	const names = await menu.getByTestId("model-option").allInnerTexts();
	assert.ok(["GPT-6.1-Sol", "GPT-6-Luna"].every((n) => names.some((t) => t.includes(`Codex · ${n}`))), `模型选择里有两个 Codex 模型：${names.join("|")}`);
	await page.screenshot({ path: join(OUT, "04-model-picker.png") });
	await menu.locator('[data-testid=model-option][data-model="codex/gpt-6.1-sol"]').first().click();
	await wait(async () => (await j("/api/agents")).find((a) => a.id === agent.id)?.model?.id === "gpt-6.1-sol");
	await page.keyboard.press("Escape");
	const send = async (text) => {
		const box = page.locator("main textarea:not(.pa-card textarea)");
		await box.fill(text);
		await box.press("Enter");
	};
	await send("你好，Codex");
	await page.locator("main").getByText("你好，收到：", { exact: false }).last().waitFor({ timeout: 30_000 });
	const usage = page.getByTestId("msg-usage").last();
	await usage.waitFor({ state: "attached" });
	const usageText = await usage.textContent();
	assert.match(usageText, /token/);
	assert.doesNotMatch(usageText, /[¥$]/, `用量行只显示 token：${usageText}`);
	await page.screenshot({ path: join(OUT, "05-chat-reply.png") });

	// ---- 4) 假 codex 调 bash：出现审批卡，批准后回答继续
	writeFileSync(scenarioFile, "e2e-bash");
	await send("帮我清理旧笔记");
	await page.locator("main").getByText("需要你的批准").last().waitFor({ timeout: 30_000 });
	await page.screenshot({ path: join(OUT, "06-approval-card.png") });
	await page.getByRole("button", { name: "批准", exact: true }).click();
	await page.locator("main").getByText("got:", { exact: false }).last().waitFor({ timeout: 30_000 });
	assert.match(await page.locator("main").innerText(), /已删除 old-notes\.txt/);
	await page.screenshot({ path: join(OUT, "07-approved-reply.png") });

	// ---- 5) 390 宽
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${base}/?settings=models`);
	await page.getByTestId("codex-card").waitFor();
	await page.getByTestId("codex-status").getByText("已登录").waitFor();
	await noOverflow(page, "390 设置页");
	await page.getByTestId("codex-card").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(OUT, "08-mobile-card.png") });
	await page.goto(`${base}/?agent=${agent.id}`);
	await page.locator("main textarea").first().waitFor();
	await noOverflow(page, "390 聊天页");
	assert.deepEqual(errors, [], `页面不应有报错：${errors.join("|")}`);
	console.log(`✅ codex-ui 通过，截图：${OUT}`);
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
