/**
 * Antigravity（agy，本机，实验性）接入 e2e（方案 docs/design/cli-models.md §5b）。
 * 临时数据 + Mock + 假 agy（packages/server/test/fixtures/fake-agy.mjs 包一层脚本），绝不调用真实 agy。
 * 覆盖：模型服务页卡片（没装 → 未登录 → 已登录，重新检测不用重启）、模型选择里出现 agy models 按家族去重的 Antigravity 模型
 * （没有 Fast）、单聊选 Claude Sonnet 5.5 发消息看到假 agy 的回答（用量行不显示钱）、
 * 假 agy 调 bash 出现审批卡、批准后回答继续、390 宽不横向溢出。
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";
import { openModelMenu } from "./model-menu-flow.mjs";
import { makeManagedAgyPreload } from "./fixtures/managed-agy-binary.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const OUT = artifactDir("agy-ui");
const run = makeTempRun("pia-agy-ui-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const scenarioFile = join(run.runDir, "scenario");
writeFileSync(scenarioFile, "text");
const fixture = makeManagedAgyPreload(root, join(run.runDir, "managed-agy"), scenarioFile);
const server = startTempServer({ root, port, run, extra: { NODE_OPTIONS: `--import tsx --import ${JSON.stringify(fixture.preload)}` } });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path} ${r.status}`); return r.json(); };
const wait = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("condition timed out"); };
const noOverflow = async (page, label) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${label}：页面不横向溢出`);
let browser;
try {
	await wait(async () => { if (server.child.exitCode !== null) throw new Error("临时服务提前退出"); try { return (await fetch(base + "/api/system", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } });
	await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
	const agent = await j("/api/agents", "POST", { name: "Antigravity 测试助理" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));

	// ---- 1) 模型服务页卡片：没装 → 未登录 → 已登录
	await page.goto(`${base}/?settings=models`);
	await page.getByTestId("cli-agents-toggle").click(); // 编程工具默认折叠
	const card = page.getByTestId("antigravity-card");
	await card.waitFor();
	await page.getByTestId("antigravity-status").getByText("没装").waitFor();
	assert.doesNotMatch(await card.innerText(), /实验性|本机|打开终端/);
	await card.scrollIntoViewIfNeeded();
	await card.screenshot({ path: join(OUT, "01-card-not-installed.png") });
	assert.equal((await j("/api/models")).some((m) => m.provider === "antigravity"), false, "没装时模型列表里没有 Antigravity");

	await card.getByRole("button", { name: "安装", exact: true }).click();
	await wait(async () => (await card.getAttribute("data-installed")) === "true");
	assert.equal(await card.getAttribute("data-logged-in"), "false");
	assert.match(await page.getByTestId("antigravity-status").innerText(), /已安装 v1\.0\.0.*未登录/s);
	await card.getByRole("button", { name: "登录", exact: true }).waitFor();
	await card.screenshot({ path: join(OUT, "02-card-not-logged-in.png") });

	await card.getByRole("button", { name: "登录", exact: true }).click();
	await card.getByRole("button", { name: "取消", exact: true }).click();
	await card.getByRole("button", { name: "登录", exact: true }).waitFor();
	await card.getByRole("button", { name: "登录", exact: true }).click();
	await wait(async () => (await card.getAttribute("data-logged-in")) === "true");
	assert.equal(await card.getAttribute("data-registered"), "true");
	assert.match(await page.getByTestId("antigravity-status").innerText(), /已登录/);
	assert.equal(await page.getByTestId("antigravity-hint").count(), 0);
	await card.getByRole("button", { name: "检查更新", exact: true }).waitFor();
	await card.screenshot({ path: join(OUT, "03-card-ready.png") });
	await card.getByRole("button", { name: "检查更新", exact: true }).click();
	await card.getByText(/官方尚未提供 SHA256/).waitFor();
	assert.equal(await card.getByRole("button", { name: /更新到/ }).count(), 0);
	writeFileSync(fixture.update, "sha-available");
	await card.getByRole("button", { name: "检查更新", exact: true }).click();
	await card.getByRole("button", { name: "更新到 v1.0.1", exact: true }).click();
	await card.getByText("已安装 v1.0.1", { exact: true }).waitFor();
	await card.getByRole("button", { name: "检查更新", exact: true }).waitFor();
	assert.equal(await card.getAttribute("data-logged-in"), "true", "更新保留私有登录");
	assert.equal(await page.locator('[data-testid=service-card][data-service="antigravity"]').count(), 0, "不重复成普通服务卡片");
	await noOverflow(page, "桌面设置页");

	// ---- 2) 模型列表：agy models 按家族去重；没有 Fast；只有一个档位的家族没有思考强度
	const list = (await j("/api/models")).filter((m) => m.provider === "antigravity");
	assert.deepEqual(list.map((m) => m.id).sort(), ["claude-sonnet-5-5", "gemini-4-argon", "gpt-oss-120b"]);
	assert.ok(list.find((m) => m.id === "claude-sonnet-5-5").thinking.includes("high"));
	assert.deepEqual(list.find((m) => m.id === "gpt-oss-120b").thinking, ["off"]);
	assert.ok(list.every((m) => m.fast.capability === "unsupported"), "没有 Fast");

	// ---- 3) 单聊：选 Antigravity · Claude Sonnet 5.5，发消息
	await page.goto(`${base}/?agent=${agent.id}`);
	const menu = await openModelMenu(page);
	await page.getByTestId("model-search").fill("Antigravity");
	const names = await menu.getByTestId("model-option").allInnerTexts();
	assert.ok(["Claude Sonnet 5.5", "Gemini 4 Argon", "GPT-OSS 120B"].every((n) => names.some((t) => t.includes(`Antigravity · ${n}`))), `模型选择里有三个 Antigravity 模型：${names.join("|")}`);
	await page.screenshot({ path: join(OUT, "04-model-picker.png") });
	await menu.locator('[data-testid=model-option][data-model="antigravity/claude-sonnet-5-5"]').first().click();
	await wait(async () => (await j("/api/agents")).find((a) => a.id === agent.id)?.model?.id === "claude-sonnet-5-5");
	await page.keyboard.press("Escape");
	const send = async (text) => {
		const box = page.locator("main textarea:not(.pa-card textarea)");
		await box.fill(text);
		await box.press("Enter");
	};
	await send("你好，Antigravity");
	await page.locator("main").getByText("你好，收到：", { exact: false }).last().waitFor({ timeout: 30_000 });
	const usage = page.getByTestId("msg-usage").last();
	await usage.waitFor({ state: "attached" });
	const usageText = await usage.textContent();
	assert.match(usageText, /token/);
	assert.doesNotMatch(usageText, /[¥$]/, `用量行只显示 token：${usageText}`);
	await page.screenshot({ path: join(OUT, "05-chat-reply.png") });

	// ---- 4) 假 agy 调 bash：出现审批卡，批准后回答继续（同一个长驻进程）
	writeFileSync(scenarioFile, "bash-approval");
	await send("帮我清理旧笔记");
	await page.locator("main").getByText("需要你的批准").last().waitFor({ timeout: 30_000 });
	await page.screenshot({ path: join(OUT, "06-approval-card.png") });
	await page.getByRole("button", { name: "批准", exact: true }).click();
	await page.locator("main").getByText("got:", { exact: false }).last().waitFor({ timeout: 30_000 });
	assert.match(await page.locator("main").innerText(), /已删除 old-notes\.txt/);
	const finalReply = page.locator("main").getByText("got:", { exact: false }).last();
	await finalReply.scrollIntoViewIfNeeded();
	await stableShot(page, finalReply, join(OUT, "07-approved-reply.png"));

	// ---- 5) 390 宽
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${base}/?settings=models`);
	await page.getByTestId("cli-agents-toggle").click(); // 编程工具默认折叠
	await page.getByTestId("antigravity-card").waitFor();
	await page.getByTestId("antigravity-status").getByText("已登录").waitFor();
	await noOverflow(page, "390 设置页");
	await page.getByTestId("antigravity-card").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(OUT, "08-mobile-card.png") });
	await page.goto(`${base}/?agent=${agent.id}`);
	await page.locator("main textarea").first().waitFor();
	await noOverflow(page, "390 聊天页");
	const captures = readFileSync(fixture.capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.ok(captures.some(c => c.args.join(" ") === "acp --login"));
	assert.ok(captures.some(c => c.args[0] === "models"));
	assert.ok(captures.some(c => c.args.includes("--input-format")));
	assert.ok(captures.every(c => c.autoUpdate === "true" && c.home.includes("/cli-agents/antigravity/home")));
	assert.deepEqual(errors, [], `页面不应有报错：${errors.join("|")}`);
	console.log(`✅ agy-ui 通过，截图：${OUT}`);
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
