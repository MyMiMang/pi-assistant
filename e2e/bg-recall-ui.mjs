/**
 * 长命令转后台 + 发出去没送达的消息可撤回（docs/design/background-commands.md、recall-pending-message.md），
 * 真实服务（Mock 模型 + 临时 DATA/WORKSPACE/HOME + 内存凭据）+ 真实构建页面。
 *  A) 后台命令：命令跑满 5 秒转后台；期间插话在转后台后立刻被助理回应（不用等命令结束）；
 *     命令结束后聊天里出现「后台命令结束」小提示、助理接着处理。
 *  B) 撤回：助理忙时连发三条插话，撤回中间那条 → 变成「你撤回了一条消息」+「重新编辑」；
 *     助理没收到被撤回的那条、其余照常送达；点「重新编辑」原文回到输入框；已送达的没有撤回按钮。
 * 运行前先构建：npm run build -w @pi-assistant/web；运行：node e2e/bg-recall-ui.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-bg-recall-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run, log: process.env.BR_DEBUG ? (d) => process.stdout.write(d) : undefined });
const out = artifactDir("screenshots");
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch {} if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${t.slice(0, 300)}`); return d; };
const wait = async (fn, ms = 30000, label = "condition") => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`${label} timed out`); };
let browser;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok, 30000, "server");
	await j("/api/settings", "PUT", { onboarded: true });
	await j("/api/models/default", "PUT", { provider: "mock", model: "echo" }).catch(() => {});
	const agentA = await j("/api/agents", "POST", { name: "后台助理", persona: "", model: { provider: "mock", id: "echo" } });
	const agentB = await j("/api/agents", "POST", { name: "撤回助理", persona: "", model: { provider: "mock", id: "echo" } });
	const msgs = (id) => j(`/api/agents/${id}/messages`);
	const post = (id, text) => j(`/api/agents/${id}/messages`, "POST", { text });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
	page.setDefaultTimeout(15000);
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e.message));
	const box = () => page.locator("main textarea:not(.pa-card textarea)");
	const send = async (text) => { await box().fill(text); await box().press("Enter"); await page.waitForFunction(() => document.querySelector("main textarea:not(.pa-card textarea)")?.value === ""); };

	console.log("[A] 长命令跑满 5 秒转后台；期间插话不用等命令结束；结束后小提示 + 助理接着处理");
	await page.goto(`${base}/?agent=${agentA.id}`);
	await box().waitFor();
	await send("后台命令测试 跑12秒 忙0");
	await page.locator("main").getByText("好，我跑一下。").last().waitFor();
	await send("加一句 用中文");
	// 插话在命令转后台（5 秒）后就被助理读到并回应，命令（12 秒）这时还在后台跑
	const t0 = Date.now();
	await page.locator("main").getByText("收到插话：加一句 用中文").last().waitFor({ timeout: 10000 });
	assert.ok(Date.now() - t0 < 9000, "插话没有等命令结束");
	const midMsgs = await msgs(agentA.id);
	assert.ok(midMsgs.some((m) => m.role === "tool" && JSON.stringify(m).includes("已转到后台")), "命令转到后台了");
	assert.equal(await page.getByText("后台命令结束").count(), 0, "此时命令还没结束");
	await page.locator("[data-testid=delivery][data-state=delivered]").last().waitFor();
	await page.screenshot({ path: join(out, "bg-01-interject-while-background.png") });
	await page.locator("main").getByText(/后台命令结束：/).first().waitFor({ timeout: 25000 });
	await page.locator("main").getByText(/收到后台结果/).last().waitFor({ timeout: 15000 });
	const doneMsgs = await msgs(agentA.id);
	assert.ok(doneMsgs.some((m) => m.role === "system" && m.meta?.system === "bg-job"), "有后台命令结束的小提示");
	await wait(async () => (await j("/api/agents")).find((a) => a.id === agentA.id)?.status !== "running", 15000, "助理回到空闲");
	await page.screenshot({ path: join(out, "bg-02-background-finished.png") });

	console.log("[B] 助理忙时连发三条插话，撤回中间那条");
	await page.goto(`${base}/?agent=${agentB.id}`);
	await box().waitFor();
	await send("慢慢数");
	await page.locator("main").getByText("好，我慢慢数。").last().waitFor();
	// 直接走接口一次发出三条（窗口很短：第一个工具边界送达甲，随后乙、丙很快跟上）
	await Promise.all(["插话甲", "插话乙", "插话丙"].map((t) => post(agentB.id, t)));
	const row = page.locator(".pa-msg.user").filter({ hasText: "插话乙" }).last();
	await row.waitFor();
	await row.getByTestId("recall-btn").click();
	await page.getByTestId("recalled").waitFor();
	await page.screenshot({ path: join(out, "bg-03-recalled.png") });
	assert.match(await page.getByTestId("recalled").innerText(), /你撤回了一条消息/);
	assert.equal(await page.locator(".pa-msg.user").filter({ hasText: "插话乙" }).count(), 0, "乙不再是一条用户消息");
	// 其余插话照常送达，助理的回答里没有乙
	await page.locator("main").getByText("收到插话：插话丙").last().waitFor({ timeout: 25000 });
	await wait(async () => (await j("/api/agents")).find((a) => a.id === agentB.id)?.status !== "running", 15000, "助理回到空闲");
	const all = await msgs(agentB.id);
	assert.ok(!all.some((m) => m.role === "assistant" && /插话乙/.test(m.content)), "助理没收到被撤回的那条");
	assert.ok(all.some((m) => m.role === "assistant" && /收到插话：插话甲/.test(m.content)), "甲照常送达");
	for (const t of ["插话甲", "插话丙"]) assert.equal(all.find((m) => m.role === "user" && m.content === t)?.meta?.delivery, "delivered", `${t} 已送达`);
	assert.equal(await page.locator(".pa-msg.user").filter({ hasText: "插话甲" }).getByTestId("recall-btn").count(), 0, "已送达的没有撤回按钮");
	const rec = all.find((m) => m.meta?.recalled);
	assert.equal(rec?.meta.recalledText, "插话乙");
	// 重新编辑：原文回到输入框
	await page.getByTestId("recall-reedit").click();
	assert.equal(await box().inputValue(), "插话乙");
	await page.screenshot({ path: join(out, "bg-04-reedit.png") });
	// 已送达的消息服务端也拒绝撤回
	const late = all.find((m) => m.role === "user" && m.content === "插话甲");
	const r = await fetch(`${base}/api/messages/${late.id}/recall`, { method: "POST" });
	assert.equal(r.status, 409);
	assert.deepEqual(pageErrors, []);
	console.log("PASS bg-recall: 转后台、期间插话即时回应、结束后小提示 + 接着处理；撤回中间一条、其余送达、重新编辑、已送达不可撤回");
} catch (e) {
	for (const pg of browser?.contexts().flatMap((c) => c.pages()) ?? []) await pg.screenshot({ path: join(out, "bg-fail.png") }).catch(() => {});
	throw e;
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
