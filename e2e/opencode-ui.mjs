/**
 * OpenCode（本机，ACP）接入 e2e（方案 docs/design/acp-cli-models.md）。
 * 临时数据 + Mock + 假 opencode（packages/server/test/fixtures/fake-opencode.mjs 包一层脚本），绝不调用真实 opencode，不联网不花钱。
 * 覆盖：模型服务页卡片（没装 → 装好没登录也注册 → 登录凭据在，重新检测不用重启）、模型选择里出现 `opencode models --verbose` 的模型
 * （名字标明 Zen 免费 / 按量 / Go 套餐，不支持工具调用的没有，没有 Fast）、单聊选 DeepSeek V4.1 Flash（OpenCode Go）发消息看到假 opencode 的回答
 * （用量行不显示钱）、假 opencode 调 bash 出现审批卡、批准后回答继续、390 宽不横向溢出。
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
const FAKE = join(root, "packages/server/test/fixtures/fake-opencode.mjs");
const OUT = artifactDir("opencode-ui");
const run = makeTempRun("pia-oc-ui-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const binDir = join(run.runDir, "bin");
mkdirSync(binDir, { recursive: true });
const OC = join(binDir, "opencode"); // 一开始还不存在 = 「没装」
const scenarioFile = join(run.runDir, "scenario");
const xdgData = join(run.runDir, "xdg-data"); // 登录凭据 auth.json 的位置（XDG_DATA_HOME），只看在不在
const authFile = join(xdgData, "opencode", "auth.json");
writeFileSync(scenarioFile, "text");
const installFake = () => {
	writeFileSync(OC, `#!/bin/sh\nFAKE_OPENCODE_SCENARIO_FILE="${scenarioFile}" exec "${process.execPath}" "${FAKE}" "$@"\n`);
	chmodSync(OC, 0o755);
};
const server = startTempServer({ root, port, run, extra: { PIA_OPENCODE_COMMAND: OC, XDG_DATA_HOME: xdgData } });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path} ${r.status}`); return r.json(); };
const wait = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("condition timed out"); };
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}：页面不横向溢出`);
let browser;
try {
	await wait(async () => { if (server.child.exitCode !== null) throw new Error("临时服务提前退出"); try { return (await fetch(base + "/api/system", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } });
	await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
	const agent = await j("/api/agents", "POST", { name: "OpenCode 测试助理" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));

	// ---- 1) 模型服务页卡片：没装 → 装好没登录（照样可用）→ 登录凭据在
	await page.goto(`${base}/?settings=models`);
	const card = page.getByTestId("opencode-cli-card");
	await card.waitFor();
	await page.getByTestId("opencode-cli-status").getByText("没装").waitFor();
	assert.match(await page.getByTestId("opencode-cli-hint").innerText(), /重新检测/);
	await card.scrollIntoViewIfNeeded();
	await card.screenshot({ path: join(OUT, "01-card-not-installed.png") });
	assert.equal((await j("/api/models")).some((m) => m.provider === "opencode-cli"), false, "没装时模型列表里没有 OpenCode（本机）");

	installFake();
	await page.getByTestId("opencode-cli-recheck").click();
	await wait(async () => (await card.getAttribute("data-installed")) === "true");
	await wait(async () => (await card.getAttribute("data-registered")) === "true");
	assert.equal(await card.getAttribute("data-logged-in"), "false");
	assert.match(await page.getByTestId("opencode-cli-status").innerText(), /已安装 v1\.18\.35.*未登录（可用免费模型）/s);
	assert.match(await page.getByTestId("opencode-cli-hint").innerText(), /opencode auth login/);
	await card.screenshot({ path: join(OUT, "02-card-free-only.png") });

	mkdirSync(join(xdgData, "opencode"), { recursive: true });
	writeFileSync(authFile, "{}");
	await page.getByTestId("opencode-cli-recheck").click();
	await wait(async () => (await card.getAttribute("data-logged-in")) === "true");
	assert.equal(await card.getAttribute("data-registered"), "true");
	assert.match(await page.getByTestId("opencode-cli-status").innerText(), /已登录/);
	assert.equal(await page.getByTestId("opencode-cli-hint").count(), 0);
	await card.screenshot({ path: join(OUT, "03-card-ready.png") });
	assert.equal(await page.locator('[data-testid=service-card][data-service="opencode-cli"]').count(), 0, "不重复成普通服务卡片");
	await noOverflow(page, "桌面设置页");

	// ---- 2) 模型列表：不支持工具调用的没有；名字标明来源；没有 Fast；没有 variants 的没有思考强度
	const list = (await j("/api/models")).filter((m) => m.provider === "opencode-cli");
	assert.deepEqual(list.map((m) => m.id).sort(), ["opencode-go/deepseek-v4.1-flash", "opencode-go/mimo-v2.5-pro", "opencode/beam-free", "opencode/claude-fable-5"]);
	assert.deepEqual(list.map((m) => m.name).sort(), ["Beam Free（OpenCode Zen 免费）", "Claude Fable 5（OpenCode Zen 按量）", "DeepSeek V4.1 Flash（OpenCode Go）", "MiMo V2.5 Pro（OpenCode Go）"]);
	assert.ok(list.find((m) => m.id === "opencode-go/deepseek-v4.1-flash").thinking.includes("max"));
	assert.deepEqual(list.find((m) => m.id === "opencode-go/mimo-v2.5-pro").thinking, ["off"]);
	assert.ok(list.every((m) => m.fast.capability === "unsupported"), "没有 Fast");

	// ---- 3) 单聊：选 DeepSeek V4.1 Flash（OpenCode Go），发消息
	await page.goto(`${base}/?agent=${agent.id}`);
	const menu = await openModelMenu(page);
	await page.getByTestId("model-search").fill("OpenCode Go");
	const names = await menu.getByTestId("model-option").allInnerTexts();
	assert.ok(names.some((t) => t.includes("DeepSeek V4.1 Flash（OpenCode Go）")), `模型选择里有 OpenCode Go 的模型：${names.join("|")}`);
	await page.screenshot({ path: join(OUT, "04-model-picker.png") });
	await menu.locator('[data-testid=model-option][data-model="opencode-cli/opencode-go/deepseek-v4.1-flash"]').first().click();
	await wait(async () => (await j("/api/agents")).find((a) => a.id === agent.id)?.model?.id === "opencode-go/deepseek-v4.1-flash");
	await page.keyboard.press("Escape");
	const send = async (text) => {
		const box = page.locator("main textarea:not(.pa-card textarea)");
		await box.fill(text);
		await box.press("Enter");
	};
	await send("你好，OpenCode");
	await page.locator("main").getByText("你好，收到：", { exact: false }).last().waitFor({ timeout: 30_000 });
	const usage = page.getByTestId("msg-usage").last();
	await usage.waitFor({ state: "attached" });
	const usageText = await usage.textContent();
	assert.match(usageText, /token/);
	assert.doesNotMatch(usageText, /[¥$]/, `用量行只显示 token：${usageText}`);
	await page.screenshot({ path: join(OUT, "05-chat-reply.png") });

	// ---- 4) 假 opencode 调 bash：出现审批卡，批准后回答继续（同一个长驻进程）
	writeFileSync(scenarioFile, "bash-approval");
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
	await page.getByTestId("opencode-cli-card").waitFor();
	await page.getByTestId("opencode-cli-status").getByText("已登录").waitFor();
	await noOverflow(page, "390 设置页");
	await page.getByTestId("opencode-cli-card").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(OUT, "08-mobile-card.png") });
	await page.goto(`${base}/?agent=${agent.id}`);
	await page.locator("main textarea").first().waitFor();
	await noOverflow(page, "390 聊天页");
	assert.deepEqual(errors, [], `页面不应有报错：${errors.join("|")}`);
	console.log(`✅ opencode-ui 通过，截图：${OUT}`);
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
