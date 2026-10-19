// 卡住上报（决策 0014 第 3 步）：真实浏览器 + 临时数据 + Mock 模型。
// 单聊帮手（子代理）一直没有动静 → 先标暂无进展并叫醒主会话 → 主会话之后仍没动静 → 主会话里出现「帮手…下一步怎么办？」提问卡片
// → 用户点「停止这个帮手」→ 帮手停下，主会话收到回报。卡住时长用 PIA_SUBAGENT_STALL_MS 调短。截图写 artifacts/screenshots。
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-e2e-stuck-");
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = artifactDir("screenshots");
let server, browser;
const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(JSON.stringify(data)); return data; };
try {
	server = startTempServer({ root: ROOT, port: PORT, run, extra: { PIA_SUBAGENT_STALL_MS: "3000" }, log: (d) => process.stdout.write(d) });
	await waitFor(async () => (await fetch(BASE + "/api/system")).ok, 30_000);
	await j("/api/settings", "PUT", { onboarded: true });
	await j("/api/models/default", "PUT", { provider: "mock", model: "echo" }).catch(() => {});
	const a = await j("/api/agents", "POST", { name: "卡住测试" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
	page.setDefaultTimeout(15_000);
	page.on("pageerror", console.error);
	await page.goto(`${BASE}/?agent=${a.id}`);
	const box = page.locator("[data-testid=main-conversation] textarea:visible:not(.pa-card textarea)");
	const text = "派个子代理卡住测试";
	const said = async () => (await j(`/api/agents/${a.id}/messages`)).some((m) => m.role === "user" && m.content === text);
	for (let i = 0; i < 5 && !(await said()); i++) {
		await box.fill(text);
		await box.press("Enter");
		await waitFor(said, 3000).catch(() => {});
	}
	const helper = async () => (await j(`/api/subagents?agent=${a.id}`))[0];
	await waitFor(async () => (await helper())?.status === "running");
	await waitFor(async () => (await helper()).status === "stalled", 30_000);
	await page.getByText(/子代理回报：.*停滞/).last().waitFor({ timeout: 30_000 });
	console.log("✅ 帮手没有动静 → 标暂无进展，先叫醒主会话");
	const card = page.locator(".pa-question", { hasText: /帮手「.*」已经 \d+ 分钟没有进展/ }).last();
	await card.waitFor({ timeout: 40_000 });
	await page.waitForTimeout(800);
	await page.screenshot({ path: join(SHOTS, "stuck-escalation-question.png") });
	console.log("✅ 主会话处理后仍没动静 → 主会话里出现提问卡片问你下一步");
	await card.getByRole("button", { name: "停止这个帮手", exact: true }).click();
	await waitFor(async () => (await helper()).status === "stopped");
	await page.getByText(/子代理回报：.*已停止/).last().waitFor({ timeout: 30_000 });
	assert.equal((await helper()).escalation ?? null, null, "回答后不再挂着上报");
	await page.waitForTimeout(800);
	await page.screenshot({ path: join(SHOTS, "stuck-escalation-stopped.png") });
	console.log("✅ 你点「停止这个帮手」→ 帮手停下，主会话收到回报");
} finally {
	await browser?.close().catch(() => {});
	await server?.stop().catch(() => {});
	cleanupTempRun(run);
}
