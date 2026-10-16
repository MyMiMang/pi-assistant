/**
 * 定向 e2e：「整理上下文指定重点」+「composer 本次选用技能」的真实界面行为。
 *
 * 真实服务进程 + Mock 模型 + 临时数据目录；消息 / 整理请求用 page.route 拦截并核对 payload，
 * 不触发真实模型、不花钱。覆盖：
 *  - 技能入口只列该助理已启用技能（未分配的技能名不出现）；空态「去启用技能」跳该助理设置；
 *  - 点选只挂 chip、可取消；发送 payload 只带 canonical id，成功清 chip；
 *  - 切对话 chip 不串（新对话空、切回来还在）；取消后发送不带 skills；
 *  - 整理上下文小弹窗：按重点整理带 instructions、直接整理不带、取消不发请求；
 *  - 390 窄屏：技能菜单不撑宽整页，麦克风 / 发送仍在、引用条 + 技能 chip 共存。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = new URL("..", import.meta.url);
const { fileURLToPath } = await import("node:url");
const REPO = fileURLToPath(ROOT);
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/skill-pick-ui";
const DATA = "/tmp/pia-verify-skill-pick";
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let server, browser;
const waitFor = async (fn, ms = 25_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`); return data; };
const start = async () => { server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: REPO, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] }); server.stdout.on("data", (d) => process.stdout.write(d)); server.stderr.on("data", (d) => process.stderr.write(d)); await waitFor(async () => (await fetch(BASE + "/api/system")).ok); };
const stop = async () => { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await done; };

let failed = 0;
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };

try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "技能选用验证" });
	const b = await j("/api/agents", "POST", { name: "无技能助理" });
	const pick = await j("/api/skills", "POST", { name: "e2e-pick", description: "e2e 选用测试技能", body: "步骤：按技能说明做。" });
	const pick2 = await j("/api/skills", "POST", { name: "e2e-pick-2", description: "e2e 第二个已启用技能", body: "第二个做法。" });
	const other = await j("/api/skills", "POST", { name: "e2e-unassigned", description: "未分配技能，不该出现在菜单", body: "不该出现。" });
	assert.equal(pick.id, "user/e2e-pick");
	await j(`/api/agents/${a.id}/skills`, "PUT", { ids: [pick.id, pick2.id] });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (e) => { console.error("pageerror:", e); failed++; });
	page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()); });

	// 拦截发送 / 整理请求，记录 payload（不触发真实模型）
	const sends = [];
	await page.route("**/api/agents/*/messages", async (route) => {
		const req = route.request();
		if (req.method() !== "POST") return route.continue();
		sends.push(req.postDataJSON());
		await route.fulfill({ json: { id: `m-${sends.length}`, role: "user", content: "x", created_at: Date.now() } });
	});
	const compacts = [];
	await page.route("**/api/conversations/*/compact", async (route) => {
		compacts.push(route.request().postDataJSON());
		await route.fulfill({ json: { ok: true, summary: "s" } });
	});

	await page.goto(`${BASE}/?agent=${a.id}`);
	const composer = page.locator("[data-testid=main-conversation] .pa-composer");
	await composer.waitFor();
	await page.waitForTimeout(700);

	// ---------------- 1) 技能菜单只列已启用技能
	console.log("\n[1] 技能入口：只列已启用技能，未分配不出现");
	await page.getByTestId("skill-picker").click();
	await page.getByTestId("skill-menu").waitFor();
	check("菜单列出已启用技能", (await page.getByTestId(`skill-${pick.id}`).count()) === 1 && (await page.getByTestId(`skill-${pick2.id}`).count()) === 1);
	check("未分配技能名不出现", (await page.locator('[data-testid=skill-list]').getByText("e2e-unassigned").count()) === 0);
	check("未分配技能描述不出现", (await page.locator('[data-testid=skill-list]').getByText("不该出现").count()) === 0);
	await page.screenshot({ path: join(OUT, "01-skill-menu.png") });

	// ---------------- 2) 点选挂 chip、可取消（第一版一次一个：选另一个会替换）
	console.log("\n[2] 点选只挂 chip、可取消 / 单选替换");
	await page.getByTestId(`skill-${pick.id}`).click();
	check("点选后出现 chip", (await page.getByTestId("skill-chips").count()) === 1);
	check("chip 显示技能名", ((await page.getByTestId("skill-chips").textContent()) ?? "").includes("e2e-pick"));
	await page.getByTestId(`skill-${pick2.id}`).click();
	const chipTxt = (await page.getByTestId("skill-chips").textContent()) ?? "";
	check("选另一个会替换（单选）", chipTxt.includes("e2e-pick-2") && !chipTxt.includes("e2e-pick "), chipTxt);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
	await page.getByTestId(`skill-chip-remove-${pick2.id}`).click();
	check("取消后 chip 消失", (await page.getByTestId("skill-chips").count()) === 0);
	await page.screenshot({ path: join(OUT, "02-skill-chip.png") });

	// ---------------- 3) 发送 payload 带 canonical id，成功清 chip
	console.log("\n[3] 发送 payload 只带 canonical id / 没选不带 skills，成功清 chip");
	const box = composer.locator("textarea").first();
	await box.fill("不带技能");
	await page.keyboard.press("Enter");
	await waitFor(() => sends.length === 1);
	check("没选技能时不带 skills", !("skills" in sends[0]), JSON.stringify(sends[0]));
	await page.getByTestId("skill-picker").click();
	await page.getByTestId(`skill-${pick.id}`).click();
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
	await box.fill("用这个技能");
	await page.keyboard.press("Enter");
	await waitFor(() => sends.length === 2);
	check("payload.skills = [canonical id]", JSON.stringify(sends[1].skills) === JSON.stringify([pick.id]), JSON.stringify(sends[1]));
	check("payload 不含路径 / 正文", !JSON.stringify(sends[1]).includes("SKILL.md") && !JSON.stringify(sends[1]).includes("按技能说明做"));
	check("发送成功清 chip", (await page.getByTestId("skill-chips").count()) === 0);

	// ---------------- 4) 切对话 chip 不串
	console.log("\n[4] 技能 draft 按对话分桶，切换不串");
	await page.getByTestId("skill-picker").click();
	await page.getByTestId(`skill-${pick.id}`).click();
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
	check("旧对话有 chip", (await page.getByTestId("skill-chips").count()) === 1);
	await page.getByTestId("conv-menu").click();
	await page.getByRole("button", { name: "新对话" }).click();
	await page.waitForTimeout(600);
	check("新对话没有 chip（不串）", (await page.getByTestId("skill-chips").count()) === 0);
	// 切回旧对话：draft 仍在（列表按更新时间倒序，旧对话在最后）
	await page.getByTestId("conv-menu").click();
	await page.locator('[role=menu] li').last().click();
	await page.waitForTimeout(600);
	check("切回旧对话 chip 仍在", (await page.getByTestId("skill-chips").count()) === 1);
	await page.screenshot({ path: join(OUT, "03-conv-isolation.png") });

	// ---------------- 5) 取消引用 / 语音不影响技能 chip；引用条与 chip 共存
	console.log("\n[5] 技能 chip 与引用共存、语音取消不清 chip");
	await page.getByTestId("skill-picker").click();
	const hasChip = (await page.getByTestId("skill-chips").count()) === 1;
	if (!hasChip) { await page.getByTestId(`skill-${pick.id}`).click(); }
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
	await page.getByTestId("voice-mic").click();
	await page.waitForTimeout(200);
	await page.getByTestId("voice-cancel").click().catch(() => {});
	await page.waitForTimeout(200);
	check("语音取消后技能 chip 仍在", (await page.getByTestId("skill-chips").count()) === 1);
	await page.screenshot({ path: join(OUT, "04-voice-chip.png") });

	// ---------------- 6) 整理上下文小弹窗
	console.log("\n[6] 整理上下文：按重点 / 直接 / 取消");
	await page.getByTestId("conv-menu").click();
	await page.getByTestId("conv-compact").click();
	await page.getByTestId("compact-dialog").waitFor();
	await page.getByTestId("compact-instructions").fill("保留需求、决策和待办");
	await page.getByTestId("compact-focus").click();
	await waitFor(() => compacts.length === 1);
	check("按重点整理带 instructions", compacts[0]?.instructions === "保留需求、决策和待办", JSON.stringify(compacts[0]));
	await page.waitForTimeout(200);
	// 直接整理：不带 instructions
	await page.getByTestId("conv-menu").click();
	await page.getByTestId("conv-compact").click();
	await page.getByTestId("compact-dialog").waitFor();
	await page.getByTestId("compact-direct").click();
	await waitFor(() => compacts.length === 2);
	check("直接整理不带 instructions", !compacts[1] || compacts[1].instructions === undefined, JSON.stringify(compacts[1]));
	// 取消：不发请求
	await page.getByTestId("conv-menu").click();
	await page.getByTestId("conv-compact").click();
	await page.getByTestId("compact-dialog").waitFor();
	await page.getByTestId("compact-cancel").click();
	await page.waitForTimeout(300);
	check("取消整理不发请求", compacts.length === 2);
	await page.screenshot({ path: join(OUT, "05-compact-dialog.png") });

	// ---------------- 7) 空态：去启用技能
	console.log("\n[7] 空态提示去启用技能");
	await page.goto(`${BASE}/?agent=${b.id}`);
	await page.locator("[data-testid=main-conversation] .pa-composer").waitFor();
	await page.waitForTimeout(500);
	await page.getByTestId("skill-picker").click();
	await page.getByTestId("skill-empty").waitFor();
	check("空态提示", ((await page.getByTestId("skill-empty").textContent()) ?? "").includes("还没有给这个助理启用技能"));
	await page.getByTestId("skill-empty-goto").click();
	await page.locator(".pa-pane-wrap").waitFor();
	check("跳转该助理设置（技能区可见）", (await page.locator(".pa-pane-wrap").getByText("技能").count()) > 0);
	await page.screenshot({ path: join(OUT, "06-empty-state.png") });

	// ---------------- 8) 390 窄屏：不撑宽、麦克风 / 发送仍在
	console.log("\n[8] 390 窄屏布局");
	await page.goto(`${BASE}/?agent=${a.id}`);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator("[data-testid=main-conversation] .pa-composer").waitFor();
	await page.waitForTimeout(600);
	// 390 下信息面板是覆盖层，先关掉以免挡住输入栏
	const paneClose = page.locator('.pa-pane-wrap button[aria-label="关闭"]');
	if (await paneClose.count()) { await paneClose.first().click(); await page.waitForTimeout(300); }
	await page.getByTestId("skill-picker").click();
	await page.getByTestId("skill-menu").waitFor();
	const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
	check("390：技能菜单不撑宽整页", docOverflow <= 1, `overflow=${docOverflow}`);
	check("390：麦克风仍在", await page.getByTestId("voice-mic").isVisible());
	check("390：发送按钮仍在", await page.locator("[data-testid=main-conversation] .pa-send").isVisible());
	await page.screenshot({ path: join(OUT, "07-390-skill-menu.png") });
} catch (e) {
	console.error("异常：", e);
	failed++;
} finally {
	await browser?.close();
	await stop();
}
console.log(failed ? `\n❌ ${failed} 项未通过` : "\n全部通过");
process.exitCode = failed ? 1 : 0;
