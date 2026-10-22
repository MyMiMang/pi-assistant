/**
 * 定向 e2e：输入栏的「权限」按钮（替换了原来的「技能」按钮，2026-10-22 用户定）+「整理上下文指定重点」。
 *
 * 真实服务进程 + Mock 模型 + 临时数据目录；不碰真实的电脑控制驱动：
 * 「操作这台电脑」的开关状态用 page.route 改写 GET /api/host-control 的响应（只把 enabled 置真），
 * 改档位走真实接口（临时数据里的设置，守护进程不启动）。消息 / 整理请求用 page.route 拦截，不触发模型、不花钱。
 * 覆盖：
 *  - 输入栏没有技能按钮；没开「操作这台电脑」时按钮显示「权限·未开启」，点开有说明和「全局电脑设置」入口；
 *  - 开启后按钮显示档位；点开就地切换（调低直接保存、调高要确认，确认框里点击不会把弹层关掉），按钮跟着变；完全权限按钮标红；
 *  - 整理上下文小弹窗：按重点整理带 instructions、直接整理不带、取消不发请求；
 *  - 390 窄屏：按钮只剩图标，弹层不撑宽整页，麦克风 / 发送仍在。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { withoutCredentials } from "./fixtures/temp-server.mjs";

const ROOT = new URL("..", import.meta.url);
const { fileURLToPath } = await import("node:url");
const REPO = fileURLToPath(ROOT);
const OUT = artifactDir("composer-permission-ui");
const DATA = "/tmp/pia-verify-composer-permission";
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let server, browser;
const waitFor = async (fn, ms = 25_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`); return data; };
const start = async () => { server = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], { cwd: REPO, env: { ...withoutCredentials(process.env), PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] }); server.stdout.on("data", (d) => process.stdout.write(d)); server.stderr.on("data", (d) => process.stderr.write(d)); await waitFor(async () => (await fetch(BASE + "/api/system")).ok); };
const stop = async () => { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await done; };

let failed = 0;
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };

try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "权限按钮验证" });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (e) => { console.error("pageerror:", e); failed++; });
	page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()); });

	// 「操作这台电脑」开没开：只改写读到的状态，其余用真实响应
	let hostOn = false;
	await page.route("**/api/host-control", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		const r = await route.fetch();
		const d = await r.json();
		if (hostOn) { d.status.enabled = true; d.settings.enabled = true; d.settings.agents = "all"; d.settings.apps = [{ name: "访达", id: "com.apple.finder" }]; }
		await route.fulfill({ json: d });
	});
	const compacts = [];
	await page.route("**/api/conversations/*/compact", async (route) => {
		compacts.push(route.request().postDataJSON());
		await route.fulfill({ json: { ok: true, summary: "s" } });
	});

	await page.goto(`${BASE}/?agent=${a.id}`);
	const composer = page.locator("[data-testid=main-conversation] .pa-composer");
	await composer.waitFor();
	const btn = page.getByTestId("host-tier-button");

	// ---------------- 1) 没开「操作这台电脑」
	console.log("\n[1] 输入栏是「权限」按钮（没有技能按钮）；没开启时显示未开启");
	await btn.waitFor();
	check("输入栏没有技能按钮", (await page.getByTestId("skill-picker").count()) === 0);
	await waitFor(async () => (await btn.getAttribute("data-tier")) === "off");
	check("按钮显示「权限·未开启」", ((await btn.textContent()) ?? "").includes("权限·未开启"));
	await btn.click();
	const menu = page.getByTestId("host-tier-menu");
	await menu.waitFor();
	check("弹层说明去哪开启", ((await menu.textContent()) ?? "").includes("在 设置 › 操作这台电脑 开启"));
	await page.screenshot({ path: join(OUT, "01-permission-off.png") });
	await page.getByTestId("host-tier-open-settings").click();
	await waitFor(async () => (await menu.count()) === 0);
	await page.getByTestId("settings-dialog").getByTestId("host-settings").waitFor();
	check("点「全局电脑设置」打开 设置 › 操作这台电脑 并收起弹层", true);
	await page.keyboard.press("Escape");
	await page.goto(`${BASE}/?agent=${a.id}`);
	await composer.waitFor();

	// ---------------- 2) 开启后切档位
	console.log("\n[2] 开启后：按钮显示档位，点开就地切换");
	hostOn = true;
	await page.reload();
	await composer.waitFor();
	await waitFor(async () => (await btn.getAttribute("data-tier")) === "bounded");
	check("默认档位「限定」", ((await btn.textContent()) ?? "").includes("权限·限定"));
	await btn.click();
	await menu.waitFor();
	await menu.getByTestId("tier-observe").click();
	await waitFor(async () => (await btn.getAttribute("data-tier")) === "observe");
	check("调低直接保存，按钮变「只看」", ((await btn.textContent()) ?? "").includes("权限·只看"));
	check("调低后弹层还开着", (await menu.count()) === 1);
	await menu.getByTestId("tier-trusted").click();
	const dlg = page.getByTestId("confirm-dialog");
	await dlg.waitFor();
	await dlg.locator(".font-semibold, h2, h3").first().click().catch(() => {});
	check("在确认框里点击不会关掉弹层", (await menu.count()) === 1);
	await dlg.getByRole("button", { name: "确定", exact: true }).click();
	await waitFor(async () => (await btn.getAttribute("data-tier")) === "trusted");
	check("调高确认后按钮变「信任」", ((await btn.textContent()) ?? "").includes("权限·信任"));
	await menu.getByTestId("tier-full").click();
	await dlg.waitFor();
	await dlg.getByRole("button", { name: "确定启用", exact: true }).click();
	await waitFor(async () => (await btn.getAttribute("data-tier")) === "full");
	check("完全权限按钮标红", /red/.test((await btn.getAttribute("class")) ?? ""));
	check("档位真的存进设置", (await j("/api/host-control")).settings.tiers[a.id] === "full");
	await page.screenshot({ path: join(OUT, "02-permission-full.png") });
	await page.keyboard.press("Escape");
	await waitFor(async () => (await menu.count()) === 0);
	check("Esc 收起弹层", true);

	// ---------------- 3) 整理上下文小弹窗
	console.log("\n[3] 整理上下文：按重点 / 直接 / 取消");
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
	await page.screenshot({ path: join(OUT, "03-compact-dialog.png") });

	// ---------------- 4) 390 窄屏：只剩图标、不撑宽、麦克风 / 发送仍在
	console.log("\n[4] 390 窄屏布局");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${BASE}/?agent=${a.id}`);
	await composer.waitFor();
	await page.waitForTimeout(600);
	// 390 下信息面板是覆盖层，先关掉以免挡住输入栏
	const paneClose = page.locator('.pa-pane-wrap button[aria-label="关闭"]');
	if (await paneClose.count()) { await paneClose.first().click(); await page.waitForTimeout(300); }
	check("390：按钮文字收起只剩图标", !(await btn.getByText("权限·").isVisible()));
	await btn.click();
	await menu.waitFor();
	const docOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
	check("390：弹层不撑宽整页", docOverflow <= 1, `overflow=${docOverflow}`);
	const mb = await menu.boundingBox();
	check("390：弹层在屏内", mb.x >= 0 && mb.x + mb.width <= 391, JSON.stringify(mb));
	check("390：麦克风仍在", await page.getByTestId("voice-mic").isVisible());
	check("390：发送按钮仍在", await page.locator("[data-testid=main-conversation] .pa-send").isVisible());
	await page.screenshot({ path: join(OUT, "04-390-permission-menu.png") });
} catch (e) {
	console.error("异常：", e);
	failed++;
} finally {
	await browser?.close();
	await stop();
}
console.log(failed ? `\n❌ ${failed} 项未通过` : "\n全部通过");
process.exitCode = failed ? 1 : 0;
