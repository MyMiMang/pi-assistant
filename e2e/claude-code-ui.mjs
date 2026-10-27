/**
 * Claude Code（本机）接入 e2e（方案 docs/design/cli-models.md §4.5、§9 第 3b 步）。
 * 临时数据 + Mock + 假 claude（packages/server/test/fixtures/fake-claude.mjs 包一层脚本），绝不调用真实 claude。
 * 覆盖：模型服务页卡片（没装 → 未登录 → 已登录，重新检测不用重启）、模型选择里出现向 claude 问来的 Claude Code 模型
 * （haiku 无思考强度、没有 Fast）、单聊选 Sonnet 发消息看到假 claude 的回答（用量行不显示钱）、
 * 假 claude 调 bash 出现审批卡、批准后回答继续、390 宽不横向溢出。
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";
import { openModelMenu } from "./model-menu-flow.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const FAKE = join(root, "packages/server/test/fixtures/fake-claude.mjs");
const OUT = artifactDir("claude-code-ui");
const run = makeTempRun("pia-claude-code-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const binDir = join(run.runDir, "bin");
mkdirSync(binDir, { recursive: true });
const CLAUDE = join(binDir, "claude"); // 一开始还不存在 = 「没装」
const scenarioFile = join(run.runDir, "scenario");
const loginFile = join(run.runDir, "login");
writeFileSync(scenarioFile, "text");
writeFileSync(loginFile, "1");
const installFake = () => {
	writeFileSync(CLAUDE, `#!/bin/sh\nFAKE_CLAUDE_MODELS=dup FAKE_CLAUDE_SCENARIO=$(cat "${scenarioFile}") FAKE_CLAUDE_LOGGED_IN=$(cat "${loginFile}") exec "${process.execPath}" "${FAKE}" "$@"\n`);
	chmodSync(CLAUDE, 0o755);
};
const server = startTempServer({ root, port, run, extra: { PIA_CLAUDE_COMMAND: CLAUDE } });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path} ${r.status}`); return r.json(); };
const wait = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("condition timed out"); };
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}：页面不横向溢出`);
let browser;
try {
	await wait(async () => { if (server.child.exitCode !== null) throw new Error("临时服务提前退出"); try { return (await fetch(base + "/api/system", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } });
	await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
	const agent = await j("/api/agents", "POST", { name: "Claude Code 测试助理" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));

	// ---- 1) 模型服务页卡片：没装 → 未登录 → 已登录
	await page.goto(`${base}/?settings=models`);
	const card = page.getByTestId("claude-code-card");
	await card.waitFor();
	await page.getByTestId("claude-code-status").getByText("没装").waitFor();
	assert.match(await page.getByTestId("claude-code-status").innerText(), /没装/);
	assert.match(await page.getByTestId("claude-code-hint").innerText(), /重新检测/);
	await card.scrollIntoViewIfNeeded();
	await card.screenshot({ path: join(OUT, "01-card-not-installed.png") });
	assert.equal((await j("/api/models")).some((m) => m.provider === "claude-code"), false, "没装时模型列表里没有 Claude Code");

	writeFileSync(loginFile, "0");
	installFake();
	await page.getByTestId("claude-code-recheck").click();
	await wait(async () => (await card.getAttribute("data-installed")) === "true");
	assert.equal(await card.getAttribute("data-logged-in"), "false");
	assert.match(await page.getByTestId("claude-code-status").innerText(), /已安装 v2\.1\.293.*未登录/s);
	assert.match(await page.getByTestId("claude-code-hint").innerText(), /claude auth login/);
	await card.screenshot({ path: join(OUT, "02-card-not-logged-in.png") });

	writeFileSync(loginFile, "1");
	await page.getByTestId("claude-code-recheck").click();
	await wait(async () => (await card.getAttribute("data-logged-in")) === "true");
	assert.equal(await card.getAttribute("data-registered"), "true");
	assert.match(await page.getByTestId("claude-code-status").innerText(), /已登录/);
	assert.equal(await page.getByTestId("claude-code-hint").count(), 0);
	await card.screenshot({ path: join(OUT, "03-card-ready.png") });
	assert.equal(await page.locator('[data-testid=service-card][data-service="claude-code"]').count(), 0, "不重复成普通服务卡片");
	await noOverflow(page, "桌面设置页");

	// ---- 2) 模型列表：向 claude 问来的完整清单（假 claude 的 dup 场景：含重名别名和 [1m]），haiku 没有思考强度，没有 Fast
	const list = (await j("/api/models")).filter((m) => m.provider === "claude-code");
	assert.deepEqual(list.map((m) => m.id).sort(), ["claude-fable-5-1[1m]", "default", "fable", "haiku", "opus", "same-a", "same-b", "sonnet"]);
	assert.equal(new Set(list.map((m) => m.name)).size, list.length, "显示名没有重名");
	assert.ok(list.find((m) => m.id === "claude-fable-5-1[1m]").name.includes("1M 上下文"));
	assert.deepEqual(list.find((m) => m.id === "haiku").thinking, ["off"]);
	assert.ok(list.find((m) => m.id === "sonnet").thinking.length > 1, "sonnet 有思考强度");
	assert.ok(list.every((m) => m.fast.capability === "unsupported"), "没有 Fast");

	// ---- 3) 单聊：选 Claude Code · Sonnet，发消息
	await page.goto(`${base}/?agent=${agent.id}`);
	const menu = await openModelMenu(page);
	await page.getByTestId("model-search").fill("Claude Code");
	const names = await menu.getByTestId("model-option").allInnerTexts();
	assert.ok(["默认", "Opus", "Sonnet", "Haiku", "Fable · 1M 上下文"].every((n) => names.some((t) => t.includes(`Claude Code · ${n}`))), `模型选择里有向 claude 问来的模型：${names.join("|")}`);
	await page.screenshot({ path: join(OUT, "04-model-picker.png") });
	await menu.locator('[data-testid=model-option][data-model="claude-code/sonnet"]').first().click();
	await wait(async () => (await j("/api/agents")).find((a) => a.id === agent.id)?.model?.id === "sonnet");
	await page.keyboard.press("Escape");
	const send = async (text) => {
		const box = page.locator("main textarea:not(.pa-card textarea)");
		await box.fill(text);
		await box.press("Enter");
	};
	await send("你好，Claude");
	await page.locator("main").getByText("你好，收到：", { exact: false }).last().waitFor({ timeout: 30_000 });
	const usage = page.getByTestId("msg-usage").last();
	await usage.waitFor({ state: "attached" });
	const usageText = await usage.textContent();
	assert.match(usageText, /token/);
	assert.doesNotMatch(usageText, /[¥$]/, `用量行只显示 token：${usageText}`);
	await page.screenshot({ path: join(OUT, "05-chat-reply.png") });

	// ---- 4) 假 claude 调 bash：出现审批卡，批准后回答继续
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
	await page.getByTestId("claude-code-card").waitFor();
	await page.getByTestId("claude-code-status").getByText("已登录").waitFor();
	await noOverflow(page, "390 设置页");
	await page.getByTestId("claude-code-card").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(OUT, "08-mobile-card.png") });
	await page.goto(`${base}/?agent=${agent.id}`);
	await page.locator("main textarea").first().waitFor();
	await noOverflow(page, "390 聊天页");
	assert.deepEqual(errors, [], `页面不应有报错：${errors.join("|")}`);
	console.log(`✅ claude-code-ui 通过，截图：${OUT}`);
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
