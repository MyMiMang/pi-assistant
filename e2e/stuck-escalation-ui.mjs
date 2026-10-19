// 卡住处理（决策 0014 第 3 步，按用户反馈改为主会话自己解决）：真实浏览器 + 临时数据 + Mock 模型。
// 1) 慢但在动：命令跑得比预计久但一直在输出 → 不标卡住、不打断，正常完成；
// 2) 真卡住：模型请求一直不回 → 系统诊断后叫醒主会话 → 主会话自己带纠正 subagent_restart → 帮手从检查点续跑完成，全程不问用户；
// 3) 只有用户能给的东西才找用户：帮手要删文件 → 主会话里出现审批卡片（说清楚要批准什么），等批准期间不算卡住。
// 卡住时长用 PIA_SUBAGENT_STALL_MS、工具预计时长用 PIA_SUBAGENT_TOOL_EXPECT_MS 调短。截图写 artifacts/screenshots。
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
	server = startTempServer({ root: ROOT, port: PORT, run, extra: { PIA_SUBAGENT_STALL_MS: "3000", PIA_SUBAGENT_TOOL_EXPECT_MS: "1000" }, log: (d) => process.stdout.write(d) });
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
	const userSaid = async (text) => (await j(`/api/agents/${a.id}/messages`)).some((m) => m.role === "user" && m.content === text);
	const say = async (text) => {
		for (let i = 0; i < 5 && !(await userSaid(text)); i++) {
			await box.fill(text);
			await box.press("Enter");
			await waitFor(() => userSaid(text), 3000).catch(() => {});
		}
	};
	const rows = () => j(`/api/subagents?agent=${a.id}`);
	const launch = async (text) => { const n = (await rows()).length; await say(text); await waitFor(async () => (await rows()).length > n); return (await rows())[0]; };
	const row = async (id) => (await rows()).find((r) => r.id === id);
	const noStuckQuestion = async () => assert.equal(await page.locator(".pa-question", { hasText: /继续等|停止这个帮手|没有进展/ }).count(), 0, "不再问用户要不要等 / 停");

	// 1) 慢但在动：10 秒的命令（预计 1 秒）一直在输出，期间每次检查都不是卡住
	const long = await launch("派个子代理长命令测试");
	const seen = new Set();
	const end = Date.now() + 60_000;
	while (Date.now() < end) {
		const r = await row(long.id);
		seen.add(r.status);
		if (["done", "failed"].includes(r.status)) break;
		await new Promise((res) => setTimeout(res, 300));
	}
	assert.equal((await row(long.id)).status, "done", `长命令应正常完成：${[...seen]}`);
	assert.ok(!seen.has("stalled"), "一直在输出的长命令不能被标成卡住");
	console.log("✅ 慢但在动（命令超过预计时长但持续输出）→ 不标卡住、不打断，正常完成");

	// 2) 真卡住：主会话自己带纠正重启，帮手续跑完成
	const stuck = await launch("派个子代理卡住测试");
	await waitFor(async () => (await row(stuck.id)).status === "stalled", 30_000);
	await page.getByText(/帮手卡住了，我看一下再带着纠正/).last().waitFor({ timeout: 30_000 });
	await page.waitForTimeout(800);
	await page.screenshot({ path: join(SHOTS, "stuck-self-recover.png") });
	await waitFor(async () => (await row(stuck.id)).status === "done", 60_000);
	assert.ok((await row(stuck.id)).attempt >= 1, "是同一个帮手从检查点续跑（不是重新派活）");
	await page.getByText(/子代理回报：.*已完成/).last().waitFor({ timeout: 30_000 });
	await noStuckQuestion();
	console.log("✅ 真卡住 → 系统诊断后叫醒主会话 → 主会话带纠正从检查点重启 → 帮手完成，没问用户");

	// 3) 只有用户能给的：审批卡片说清楚要批准什么；等批准期间不算卡住
	const ask = await launch("派个子代理测试审批");
	const approve = page.getByRole("button", { name: "批准", exact: true });
	await approve.waitFor({ timeout: 30_000 });
	await page.waitForTimeout(3000 * 2 + 500); // 超过两个卡住周期
	assert.equal((await row(ask.id)).status, "running", "等用户批准期间不算卡住");
	await noStuckQuestion();
	await page.screenshot({ path: join(SHOTS, "stuck-user-only-need.png") });
	await approve.click();
	await waitFor(async () => (await row(ask.id)).status === "done", 30_000);
	console.log("✅ 只有需要用户批准时才找用户（审批卡片写明要批准的操作），等待期间不算卡住");
} finally {
	await browser?.close().catch(() => {});
	await server?.stop().catch(() => {});
	cleanupTempRun(run);
}
