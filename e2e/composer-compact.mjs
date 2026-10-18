/**
 * 定向验证：移除两个重复「电脑」入口 + 输入栏按容器宽度紧凑化（只留图标）。
 * 覆盖：单聊 / 群聊 / 子代理三个输入栏，390 / 1280（桌面左右栏挤压，聊天区≈600）/ 1440 三档。
 * 断言：无横向溢出、按钮文字按容器宽度显隐、tooltip+aria-label 齐全、按钮可点击出菜单、
 *       右侧信息面板「电脑」tab 入口仍在、header 不再有「电脑」chip、composer 不再有「助理电脑」。
 * 只跑这一个脚本，不跑全量 e2e。
 * 隔离：每次 mkdtemp 的临时 DATA / WORKSPACE / HOME / TMPDIR，服务走 `test/launch-memory.ts`
 * （内存凭据，不构造生产后端）；原生 Chrome 用 `e2e/fixtures/native-launch-env.mjs` 的真实 HOME / TMPDIR。
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { openCompact } from "./model-menu-flow.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const ROOT = new URL("..", import.meta.url);
const { fileURLToPath } = await import("node:url");
const REPO = fileURLToPath(ROOT);
const OUT = artifactDir("composer-compact");
// 本次运行独占的临时目录（DATA / WORKSPACE / HOME / TMPDIR）；finally 只删它自己
const run = makeTempRun("pia-e2e-composer-compact-");
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const LONG = "派个子代理 检查输入栏紧凑化，工作区仓库 /Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/pi-assistant";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let srv, browser;
const waitFor = async (fn, ms = 25_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`); return data; };
const start = async () => { srv = startTempServer({ root: REPO, port: PORT, run, log: (d) => process.stdout.write(d) }); await waitFor(async () => (await fetch(BASE + "/api/system")).ok); };
const stop = async () => { await srv?.stop(); };

let failed = 0;
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };

/** 量一个输入栏：宽度、溢出、文字标签显隐、aria/title、是否还有「助理电脑」按钮 */
const probe = (loc) => loc.evaluate((el) => {
	const q = (t) => el.querySelector(`[data-testid="${t}"]`);
	const labelShown = (t) => {
		const b = q(t);
		if (!b) return null;
		return [...b.querySelectorAll("span")].some((s) => s.textContent.trim() && s.getClientRects().length > 0);
	};
	const tools = el.querySelector(".pa-composer-tools");
	const rows = tools ? new Set([...tools.children].filter((c) => c.getBoundingClientRect().width > 0).map((c) => Math.round(c.getBoundingClientRect().top))).size : null;
	return {
		width: Math.round(el.getBoundingClientRect().width),
		content: Math.round(el.clientWidth),
		overflowX: el.scrollWidth - el.clientWidth,
		toolsOverflowX: tools ? tools.scrollWidth - tools.clientWidth : null,
		toolsRows: rows,
		hostLabel: labelShown("host-tier-pill"),
		modelLabel: labelShown("model-picker"),
		proactiveLabel: labelShown("proactive-picker"),
		hostAria: q("host-tier-pill")?.getAttribute("aria-label") ?? "",
		hostTitle: q("host-tier-pill")?.getAttribute("title") ?? "",
		modelAria: q("model-picker")?.getAttribute("aria-label") ?? "",
		modelTitle: q("model-picker")?.getAttribute("title") ?? "",
		proactiveAria: q("proactive-picker")?.getAttribute("aria-label") ?? "",
		computerChip: [...el.querySelectorAll("button")].filter((b) => /助理电脑/.test(b.textContent)).length,
		approvalFoot: [...el.closest(".pa-composer-wrap").querySelectorAll(".pa-foot-note")].filter((n) => /请你批准/.test(n.textContent)).length,
	};
});

/** 断言「无溢出」+「标题/可访问名齐全」 */
const assertClean = (tag, m) => {
	check(`${tag}：输入栏无横向溢出（${m.width}px）`, m.overflowX <= 1, `overflowX=${m.overflowX}`);
	check(`${tag}：工具栏无横向溢出`, (m.toolsOverflowX ?? 0) <= 1, `toolsOverflowX=${m.toolsOverflowX}`);
	check(`${tag}：不再有「助理电脑」按钮`, m.computerChip === 0);
	check(`${tag}：不再有「…都会先请你批准」footer`, m.approvalFoot === 0);
	check(`${tag}：权限按钮 title+aria-label`, !!m.hostTitle && !!m.hostAria, `${m.hostTitle} / ${m.hostAria}`);
	check(`${tag}：模型按钮 title+aria-label`, !!m.modelTitle && !!m.modelAria, `${m.modelTitle} / ${m.modelAria}`);
	check(`${tag}：主动按钮 aria-label`, !m.proactiveAria ? m.proactiveLabel === null : !!m.proactiveAria);
};

const openInfoTab = async (page, key) => {
	const direct = page.locator(`[data-testid=info-tabs] [role=tab][data-itab=${key}]`);
	if (await direct.count()) return direct.click();
	await page.getByTestId("info-tabs-more").click();
	await page.getByTestId("info-tabs-menu").locator(`[data-itab=${key}]`).click();
};

/** 关掉右侧信息面板（390 下是覆盖层，不关会挡住截图） */
const closePane = async (page) => {
	const x = page.locator('.pa-pane-wrap button[aria-label="关闭"]');
	if (await x.count()) { await x.first().click(); await page.waitForTimeout(300); }
};

try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "紧凑验证" });
	const room = await j("/api/rooms", "POST", { name: "紧凑群", purpose: "验证群聊输入栏", memberIds: [a.id], managerId: a.id });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (e) => { console.error("pageerror:", e); failed++; });
	await page.goto(`${BASE}/?agent=${a.id}`);
	await page.locator("[data-testid=main-conversation] .pa-composer").waitFor();
	await page.waitForTimeout(700);

	const composer = page.locator("[data-testid=main-conversation] .pa-composer");
	const headActions = page.locator(".pa-head-actions");

	// ---------------- 1) 宽屏 1440：文字正常显示
	console.log("\n[1] 单聊 · 1440 宽屏（聊天区≈1176）");
	check("header 不再有「电脑」chip", !(await headActions.locator("button").allTextContents()).some((t) => t.trim() === "电脑"));
	let m = await probe(composer);
	assertClean("1440", m);
	check("1440：文字标签显示", m.hostLabel === true && m.modelLabel === true, JSON.stringify({ h: m.hostLabel, mo: m.modelLabel, p: m.proactiveLabel }));
	await page.screenshot({ path: join(OUT, "01-single-1440-wide.png") });

	// ---------------- 2) 1440 打开信息面板 → 点「电脑」tab（保留的入口）
	console.log("\n[2] 右侧信息面板「电脑」tab 入口仍在");
	await page.locator('.pa-head-actions button[aria-label="信息面板"]').click();
	await page.locator(".pa-pane-wrap").waitFor();
	await openInfoTab(page, "computer");
	await page.locator(".pa-pane-wrap").getByText("工作区").first().waitFor();
	check("信息面板「电脑」tab 可打开且显示工作区", true);
	await page.screenshot({ path: join(OUT, "02-infopane-computer-tab.png") });

	// ---------------- 3) 1280 + 左右栏挤压：聊天区≈676 → 容器窄 → 只留图标
	console.log("\n[3] 单聊 · 1280 且左右栏常驻（聊天区≈676，容器≈628）");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.waitForTimeout(500);
	m = await probe(composer);
	assertClean("1280-挤压", m);
	check("1280-挤压：文字标签隐藏（只留图标）", m.hostLabel === false && m.modelLabel === false, JSON.stringify({ w: m.width, c: m.content, h: m.hostLabel, mo: m.modelLabel, p: m.proactiveLabel }));
	await page.screenshot({ path: join(OUT, "03-single-1280-squeezed.png") });

	// 按钮仍可点击（图标态）
	await page.getByTestId("host-tier-pill").click();
	await page.getByTestId("host-tier-menu").waitFor();
	check("1280-挤压：权限按钮可点开菜单", true);
	await page.getByTestId("host-tier-pill").click();
	await page.waitForTimeout(150);
	await openCompact(page);
	check("1280-挤压：模型按钮可点开紧凑层", true);
	await page.getByTestId("model-picker").click();
	await page.waitForTimeout(150);

	// ---------------- 4) 390 手机：容器更窄，仍只留图标、无溢出
	console.log("\n[4] 单聊 · 390 手机");
	await page.locator('.pa-head-actions button[aria-label="信息面板"]').click(); // 关掉信息面板覆盖层
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(500);
	m = await probe(composer);
	assertClean("390", m);
	check("390：文字标签隐藏", m.hostLabel === false && m.modelLabel === false, JSON.stringify({ w: m.width, h: m.hostLabel, mo: m.modelLabel }));
	check("390：整页不被撑宽", (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 1);
	await page.screenshot({ path: join(OUT, "04-single-390.png") });

	// ---------------- 5) 群聊输入栏：390 与 1280 挤压
	console.log("\n[5] 群聊 · 390 / 1280 挤压");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${BASE}/?room=${room.id}`);
	const roomComposer = page.locator("[data-testid=room-chat] .pa-composer");
	await roomComposer.waitFor();
	await page.waitForTimeout(700);
	// 打开信息面板（点成员），让左右栏把聊天区挤到 ≈676，验证“大屏被挤压也 compact”
	await page.locator("[data-testid=room-members] button").first().click();
	await page.locator(".pa-pane-wrap").waitFor();
	await page.waitForTimeout(500);
	let rm = await roomComposer.evaluate((el) => {
		const tools = el.querySelector(".pa-composer-tools");
		const hint = el.querySelector(".pa-room-hint");
		return { width: Math.round(el.getBoundingClientRect().width), overflowX: el.scrollWidth - el.clientWidth, toolsOverflowX: tools ? tools.scrollWidth - tools.clientWidth : null, hintShown: !!hint && hint.getClientRects().length > 0, computerChip: [...el.querySelectorAll("button")].filter((b) => /助理电脑/.test(b.textContent)).length, approvalFoot: [...el.closest(".pa-composer-wrap").querySelectorAll(".pa-foot-note")].filter((n) => /请你批准/.test(n.textContent)).length };
	});
	check(`群聊 1280 挤压（${rm.width}px）：无溢出`, rm.overflowX <= 1 && (rm.toolsOverflowX ?? 0) <= 1, JSON.stringify(rm));
	check("群聊 1280 挤压：提示文字隐藏", rm.hintShown === false);
	check("群聊：不再有「助理电脑」按钮", rm.computerChip === 0);
	check("群聊：不再有审批 footer", rm.approvalFoot === 0);
	await page.screenshot({ path: join(OUT, "05-room-1280-squeezed.png") });
	await closePane(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(500);
	rm = await roomComposer.evaluate((el) => ({ width: Math.round(el.getBoundingClientRect().width), overflowX: el.scrollWidth - el.clientWidth, docOverflow: document.documentElement.scrollWidth - innerWidth, hintShown: !!el.querySelector(".pa-room-hint") && el.querySelector(".pa-room-hint").getClientRects().length > 0 }));
	check("群聊 390：无溢出", rm.overflowX <= 1 && rm.docOverflow <= 1, JSON.stringify(rm));
	check("群聊 390：提示文字隐藏", rm.hintShown === false);
	await page.screenshot({ path: join(OUT, "06-room-390.png") });

	// ---------------- 6) 子代理输入栏：390
	console.log("\n[6] 子代理聊天 · 390");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${BASE}/?agent=${a.id}`);
	await closePane(page);
	const box = page.locator("[data-testid=main-conversation] textarea:visible:not(.pa-card textarea)");
	await box.waitFor();
	await box.fill(LONG);
	await page.keyboard.press("Enter");
	// 子代理任务从 header 的「子代理」入口 → 任务概览 → 详情（聊天里不再显示指令卡）
	await page.getByTestId("subagent-tasks").waitFor({ timeout: 30_000 });
	await page.getByTestId("subagent-tasks").click();
	const taskRow = page.getByTestId("subagent-row").first();
	await taskRow.waitFor();
	await taskRow.click();
	const panel = page.locator('[data-testid="subagent-detail"]:visible');
	await panel.waitFor();
	const subComposer = panel.locator(".pa-composer");
	await subComposer.waitFor();
	await closePane(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(500);
	const sm = await subComposer.evaluate((el) => ({ width: Math.round(el.getBoundingClientRect().width), overflowX: el.scrollWidth - el.clientWidth, docOverflow: document.documentElement.scrollWidth - innerWidth }));
	check("子代理 390：无溢出", sm.overflowX <= 1 && sm.docOverflow <= 1, JSON.stringify(sm));
	await page.screenshot({ path: join(OUT, "07-subagent-390.png") });

	// ---------------- 7) 新默认：Enter 发送 / Shift+Enter 换行 / IME 不误发
	console.log("\n[7] Enter 发送 / Shift+Enter 换行 / IME（默认偏好回归）");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto(`${BASE}/?agent=${a.id}`);
	const b2 = page.locator("[data-testid=main-conversation] textarea:visible:not(.pa-card textarea)");
	await b2.waitFor();
	const before = (await j(`/api/agents/${a.id}/messages`)).filter((x) => x.role === "user").length;
	await b2.fill("第一行");
	await b2.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
	await page.keyboard.press("Shift+Enter");
	check("Shift+Enter 换行", (await b2.inputValue()) === "第一行\n", await b2.inputValue());
	const cdp = await page.context().newCDPSession(page);
	await b2.click();
	await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(250);
	check("IME 组合期间 Enter 不发送", (await j(`/api/agents/${a.id}/messages`)).filter((x) => x.role === "user").length === before);
	await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
	await b2.fill("紧凑验证发送");
	await page.keyboard.press("Enter");
	await waitFor(async () => (await j(`/api/agents/${a.id}/messages`)).some((x) => x.role === "user" && x.content === "紧凑验证发送"));
	check("Enter 发送", (await b2.inputValue()) === "");

	// ---------------- 8) queued 子代理：状态文案「排队中」+ 可停止（固定数据，不依赖 mock 时序）
	console.log("\n[8] queued 子代理显示 / 停止按钮");
	const realRows = await j(`/api/subagents?agent=${a.id}`);
	const convId = realRows[0]?.conversation_id;
	const queuedRow = { id: "sub-queued-1", agent_id: a.id, conversation_id: convId, parent_message_id: null, task: "排队等空位的任务", context: "", model_provider: "mock", model_id: "echo", model_reason: "跟随主会话模型", status: "queued", last_activity_at: Date.now(), error_reason: null, notified_at: null, result_summary: null, created_at: Date.now(), finished_at: null };
	let stopCalled = false;
	await page.route((url) => url.pathname === "/api/subagents", (r) => r.fulfill({ json: [queuedRow] }));
	await page.route((url) => url.pathname === "/api/subagents/sub-queued-1", (r) => r.fulfill({ json: { subagent: queuedRow, messages: [] } }));
	await page.route((url) => url.pathname === "/api/subagents/sub-queued-1/stop", (r) => { stopCalled = true; return r.fulfill({ json: { ok: true } }); });
	await page.goto(`${BASE}/?agent=${a.id}`);
	await page.getByTestId("subagent-tasks").waitFor();
	await page.getByTestId("subagent-tasks").click();
	const row = page.getByText("排队等空位的任务").first();
	await row.waitFor();
	check("queued：子代理列表显示「排队中」", (await page.locator(".pa-modal").getByText("排队中").count()) > 0);
	await row.click();
	const detail = page.locator('[data-testid="subagent-detail"]:visible');
	await detail.waitFor();
	const stateTxt = (await detail.locator("[data-testid=subagent-state]").first().textContent()) ?? "";
	check("queued：详情状态显示「排队中」且不带秒数", stateTxt.includes("排队中") && !stateTxt.includes("秒前"), stateTxt);
	check("queued：输入栏提示排队中", ((await detail.locator(".pa-composer-bar").first().textContent()) ?? "").includes("排队中"));
	const stopBtn = detail.getByLabel("停止子代理");
	check("queued：详情右侧无重复停止按钮", (await detail.getByTestId("subagent-stop").count()) === 0);
	check("queued：输入框停止按钮可用", (await stopBtn.count()) === 1 && (await stopBtn.isEnabled()));
	await stopBtn.click();
	await page.waitForTimeout(300);
	check("queued：点停止会调用 /stop", stopCalled);
	await page.screenshot({ path: join(OUT, "08-subagent-queued.png") });
} catch (e) {
	console.error("异常：", e);
	failed++;
} finally {
	await browser?.close();
	await stop();
	cleanupTempRun(run);
}
console.log(failed ? `\n❌ ${failed} 项未通过` : "\n全部通过");
process.exitCode = failed ? 1 : 0;
