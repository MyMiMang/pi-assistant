// 后台任务重启安全（决策 0014 第 2 步）：真实浏览器 + 临时数据 + Mock 模型。
// 重启时后台任务的命令已派发、结果没落库 → 标「中断待核验」不自动重放；卡片上点「继续」→ 在原会话先核验再续跑 → 已完成。
// 先构建 apps/web：npm run build -w @pi-assistant/web。截图写 artifacts/screenshots。
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-e2e-task-restart-");
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = artifactDir("screenshots");
let server, browser;
const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(JSON.stringify(data)); return data; };
const start = async () => { server = startTempServer({ root: ROOT, port: PORT, run, log: (d) => process.stdout.write(d) }); await waitFor(async () => (await fetch(BASE + "/api/system")).ok, 30_000); };
try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	await j("/api/models/default", "PUT", { provider: "mock", model: "echo" }).catch(() => {});
	const a = await j("/api/agents", "POST", { name: "重启测试" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
	page.setDefaultTimeout(15_000);
	page.on("pageerror", console.error);
	await page.goto(`${BASE}/?agent=${a.id}`);
	const box = page.locator("[data-testid=main-conversation] textarea:visible:not(.pa-card textarea)");
	// 输入框打开后会再水合一次：以服务端收到用户消息为准，没收到才重发
	const said = async (text) => (await j(`/api/agents/${a.id}/messages`)).some((m) => m.role === "user" && m.content === text);
	for (let i = 0; i < 5 && !(await said("后台慢任务")); i++) {
		await box.fill("后台慢任务");
		await box.press("Enter");
		await waitFor(() => said("后台慢任务"), 3000).catch(() => {});
	}
	const task = async () => (await j(`/api/agents/${a.id}/tasks`))[0];
	await waitFor(async () => (await task())?.status === "running");
	const id = (await task()).id;
	// 命令已经派发（工具步骤落了消息）再重启：结果未知
	await waitFor(async () => (await j(`/api/tasks/${id}/messages`)).some((m) => m.role === "tool"), 20_000);
	await server.stop();
	await start();
	await waitFor(async () => (await task()).status === "lost");
	assert.match((await task()).error ?? "", /服务重启.*bash/, "原因里要说清哪个操作结果未知");
	console.log("✅ 重启时命令结果未知 → 标中断待核验，不自动重放");
	await page.reload();
	await page.getByText(/后台任务「慢慢核对工作区」中断待核验/).last().waitFor();
	const card = page.locator(".pa-card", { hasText: "后台任务：慢慢核对工作区" }).last();
	await card.getByText("中断待核验").waitFor();
	await page.waitForTimeout(1000); // 等进场动画结束再截图
	await page.screenshot({ path: join(SHOTS, "task-restart-lost.png") });
	await card.getByTestId("task-resume").click();
	await waitFor(async () => (await task()).status === "done", 90_000);
	const msgs = await j(`/api/tasks/${id}/messages`);
	assert.ok(msgs.filter((m) => m.role === "tool").length >= 1);
	await card.getByText("已完成").waitFor();
	await page.waitForTimeout(1000);
	await page.screenshot({ path: join(SHOTS, "task-restart-resumed.png") });
	console.log("✅ 卡片上点继续 → 原会话先核验再续跑 → 已完成");
} finally {
	await browser?.close().catch(() => {});
	await server?.stop().catch(() => {});
	cleanupTempRun(run);
}
