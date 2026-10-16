/**
 * 子代理思考档位「选项不全」前端回归（真实服务端 + 真实 React 构建 + Chromium，不是只跑 tsc）。
 *
 * 覆盖（对应 subagent-thinking-options-fix 的并集修复）：
 *  1) 单模型 follow（候选池为空 = 跟随主会话）：菜单档位 = 主会话当前模型的档位；主会话模型没有 off 时菜单也不该有 off。
 *  2) 候选池 mixed（一个有 xhigh/max、一个只到 high、一个非推理）：取并集，xhigh / max / off / minimal 都在。
 *     旧实现（整池交集）会同时缺 xhigh、max、off —— 这里用「并集是旧交集的严格超集」证伪。
 *  3) 候选池只有一个非推理模型：只有 off，没有 high / xhigh / max。
 *  4) 固定档位不被当前候选池支持：黄字说明 + 按钮 tooltip 都出现，不静默吞用户选择。
 *  5) 390 窄屏：菜单限高 + 内部滚动，底部 max 项可达、可点（不是被裁掉）。
 *
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 全程临时数据目录 + PIA_MOCK + PIA_OFFLINE，不碰钥匙串 / 真实 Key / 真实 db / 付费模型。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = "/tmp/pia-e2e-subagent-thinking-levels";
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/subagent-thinking-levels";
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(OUT, { recursive: true });

let server, browser, failed = 0;
const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`); return data; };
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };
const start = async () => { server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] }); server.stdout.on("data", (d) => process.stdout.write(d)); server.stderr.on("data", (d) => process.stdout.write(d)); await waitFor(async () => (await fetch(BASE + "/api/system")).ok); };
const stop = async () => { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await done; };

/** 切换信息面板的 tab（窄屏可能收进「更多」菜单） */
const openTab = async (page, name) => {
	const bar = page.getByTestId("info-tabs");
	const tab = bar.getByRole("tab", { name, exact: true });
	if (await tab.count()) await tab.click();
	else { await page.getByTestId("info-tabs-more").click(); await page.getByTestId("info-tabs-menu").getByRole("menuitem", { name, exact: true }).click(); }
};
/** 第一次打开「助理设置 › 子代理模型」区块（真实信息面板 + 设置 tab） */
const openAgentSettings = async (page, agentId) => {
	await page.goto(`${BASE}/?agent=${agentId}`);
	await page.waitForSelector(".pa-pane-wrap, button[aria-label='信息面板']");
	await page.waitForTimeout(500); // 等 store 从 localStorage 恢复，避免和自动打开抢状态
	if (!(await page.locator(".pa-pane-wrap").isVisible().catch(() => false))) await page.getByRole("button", { name: "信息面板" }).click();
	await page.locator(".pa-pane-wrap").waitFor({ state: "visible" });
	await openTab(page, "设置");
	await page.getByTestId("agent-subagent-model").waitFor();
};
/** 池子改了以后重挂载设置面板（切到别的 tab 再切回来，不整页刷新，避免和持久化的面板状态抢） */
const remountSettings = async (page) => {
	await openTab(page, "概览");
	await openTab(page, "设置");
	await page.getByTestId("agent-subagent-model").waitFor();
};
const menu = (page) => page.getByTestId("agent-subagent-thinking-menu");
const openMenu = async (page) => { await page.getByTestId("agent-subagent-thinking").click(); await menu(page).waitFor(); };
const closeMenu = async (page) => { await page.keyboard.press("Escape"); await menu(page).waitFor({ state: "detached" }); };
const hasLevel = (page, l) => menu(page).getByTestId(`agent-subagent-thinking-${l}`).count().then((n) => n > 0);
const openLabels = async (page) => (await menu(page).locator("button[data-testid]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid").replace("agent-subagent-thinking-", ""))));
const setPool = async (agentId, pool) => { await j(`/api/agents/${agentId}/subagent-model`, "PUT", { pool }); };
const viewLevels = async (agentId) => (await j(`/api/agents/${agentId}/subagent-model`)).pool;

try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = await j("/api/agents", "POST", { name: "档位测试" });
	// 真实 Pi 目录：gpt-6.1-sol 有 xhigh/max；my-private-model 只到 high；plain-noreason 非推理（只有 off）
	const prov = await j("/api/models/custom", "POST", { name: "档位中转", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true, models: [
		{ id: "gpt-6.1-sol", reasoning: true },
		{ id: "my-private-model", reasoning: true },
		{ id: "plain-noreason", reasoning: false },
	] });
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: prov.id, id: "gpt-6.1-sol" } });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
	page.setDefaultTimeout(15_000);

	// 用真实接口确认 Pi 目录给的能力，避免和 UI 断言对不上
	const catalog = await j("/api/models");
	const sol = catalog.find((m) => m.provider === prov.id && m.id === "gpt-6.1-sol");
	const priv = catalog.find((m) => m.provider === prov.id && m.id === "my-private-model");
	const plain = catalog.find((m) => m.provider === prov.id && m.id === "plain-noreason");
	assert.ok(sol?.thinking?.includes("xhigh") && sol.thinking.includes("max"), `目录里 sol 应有 xhigh/max：${JSON.stringify(sol?.thinking)}`);
	assert.ok(priv?.thinking?.includes("high") && !priv.thinking.includes("xhigh"), `目录里 priv 只到 high：${JSON.stringify(priv?.thinking)}`);
	assert.deepEqual(plain?.thinking, ["off"], `非推理只有 off：${JSON.stringify(plain?.thinking)}`);

	// ---------------------------------------------------------------- 1) 单模型 follow（空池）
	console.log("\n[1] 候选池为空 = 跟随主会话（单模型）");
	await setPool(agent.id, []);
	await openAgentSettings(page, agent.id);
	check("页面真的挂载了设置面板", await page.getByTestId("agent-subagent-model").isVisible());
	check("候选池为空：按钮显示「跟随主会话」", (await page.getByTestId("agent-subagent-thinking").innerText()).includes("跟随主会话"));
	await openMenu(page);
	check("单模型 follow：菜单含 xhigh", await hasLevel(page, "xhigh"));
	check("单模型 follow：菜单含 max", await hasLevel(page, "max"));
	check("单模型 follow：sol 没有 off，菜单也不该有 off（不凭空补档位）", !(await hasLevel(page, "off")));
	await closeMenu(page);
	await page.screenshot({ path: join(OUT, "01-follow-single.png") });

	// ---------------------------------------------------------------- 2) mixed 候选池取并集
	console.log("\n[2] 候选池 mixed：取并集，不取交集");
	await setPool(agent.id, [{ provider: prov.id, id: "gpt-6.1-sol" }, { provider: prov.id, id: "my-private-model" }, { provider: prov.id, id: "plain-noreason" }]);
	await remountSettings(page);
	await openMenu(page);
	const levels = await openLabels(page);
	const oldIntersection = sol.thinking.filter((l) => priv.thinking.includes(l)); // 旧的整池交集写法
	check("mixed：菜单含 xhigh（旧交集会裁掉）", levels.includes("xhigh"), JSON.stringify({ levels, oldIntersection }));
	check("mixed：菜单含 max（旧交集会裁掉）", levels.includes("max"), JSON.stringify({ levels, oldIntersection }));
	check("mixed：菜单含 off（旧交集也会裁掉）", levels.includes("off"), JSON.stringify(levels));
	check("mixed：菜单含 minimal", levels.includes("minimal"), JSON.stringify(levels));
	check("mixed：并集是旧交集的严格超集（修复生效）", levels.length > oldIntersection.length, JSON.stringify({ levels: levels.length, oldIntersection: oldIntersection.length }));
	check("mixed：档位顺序 = Pi 顺序（off 在 xhigh/max 前）", levels.indexOf("off") < levels.indexOf("xhigh") && levels.indexOf("xhigh") < levels.indexOf("max"), JSON.stringify(levels));
	await closeMenu(page);
	await page.screenshot({ path: join(OUT, "02-mixed-union.png") });

	// ---------------------------------------------------------------- 3) 非推理模型只有 off
	console.log("\n[3] 候选池只有一个非推理模型：只有 off");
	await setPool(agent.id, [{ provider: prov.id, id: "plain-noreason" }]);
	await remountSettings(page);
	await openMenu(page);
	check("非推理：菜单有 off", await hasLevel(page, "off"));
	check("非推理：没有 high", !(await hasLevel(page, "high")));
	check("非推理：没有 xhigh", !(await hasLevel(page, "xhigh")));
	check("非推理：没有 max", !(await hasLevel(page, "max")));
	await closeMenu(page);

	// ---------------------------------------------------------------- 4) 固定档位不被候选池支持：说明 + tooltip
	console.log("\n[4] 固定档位不被候选池支持：黄字说明 + tooltip，不静默吞");
	await j(`/api/agents/${agent.id}/subagent-thinking`, "PUT", { mode: "fixed", level: "xhigh" });
	await remountSettings(page);
	const note = page.getByTestId("agent-subagent-thinking-note");
	await note.waitFor();
	check("有黄字说明（候选池没有模型支持）", (await note.innerText()).includes("没有模型支持"), await note.innerText());
	check("按钮 tooltip 说明会被收敛", ((await page.getByTestId("agent-subagent-thinking").getAttribute("title")) ?? "").includes("没有模型支持"), await page.getByTestId("agent-subagent-thinking").getAttribute("title"));
	check("按钮仍显示用户选的档位「超高」，不静默改回", (await page.getByTestId("agent-subagent-thinking").innerText()).includes("超高"), await page.getByTestId("agent-subagent-thinking").innerText());
	await page.screenshot({ path: join(OUT, "03-unsupported-fixed.png") });
	await j(`/api/agents/${agent.id}/subagent-thinking`, "PUT", { mode: "follow" });

	// ---------------------------------------------------------------- 5) 390 窄屏：离散滑块不溢出、7 档可达可点
	console.log("\n[5] 390 窄屏：滑块不横向溢出、7 档刻度都在视口内、max 可达可点");
	await setPool(agent.id, [{ provider: prov.id, id: "gpt-6.1-sol" }, { provider: prov.id, id: "my-private-model" }, { provider: prov.id, id: "plain-noreason" }]);
	await page.setViewportSize({ width: 390, height: 480 });
	await remountSettings(page);
	await openMenu(page);
	const m = await page.evaluate(() => {
		const menuEl = document.querySelector('[data-testid="agent-subagent-thinking-menu"]');
		const doc = document.documentElement;
		// 只数滑块刻度按钮：`[data-testid^="agent-subagent-thinking-"]` 还会命中 -menu / -body / -follow
		const ticks = [...(menuEl?.querySelectorAll(".pa-think-step") ?? [])];
		const mr = menuEl?.getBoundingClientRect();
		const handle = menuEl?.querySelector('[role="slider"]');
		return {
			doc: doc.scrollWidth, vw: innerWidth,
			menuMaxH: menuEl ? getComputedStyle(menuEl).maxHeight : "none",
			scrollerFound: !!menuEl?.querySelector(".overflow-y-auto"),
			tickCount: ticks.length,
			ticksInMenu: mr ? ticks.every((el) => { const r = el.getBoundingClientRect(); return r.left >= mr.left - 1 && r.right <= mr.right + 1; }) : false,
			handleMax: handle?.getAttribute("aria-valuemax") ?? null,
		};
	});
	check("390：页面不横向溢出", m.doc <= m.vw, JSON.stringify({ doc: m.doc, vw: m.vw }));
	check("390：菜单有高度上限（maxHeight 限制）", m.menuMaxH !== "none" && m.menuMaxH !== "", JSON.stringify(m.menuMaxH));
	check("390：菜单内有独立滚动容器", m.scrollerFound);
	check("390：7 档刻度全部渲染", m.tickCount === 7, JSON.stringify(m.tickCount));
	check("390：每个档位刻度都落在弹层水平范围内（不溢出）", m.ticksInMenu);
	check("390：滑块 aria-valuemax = 6（7 档）", m.handleMax === "6", String(m.handleMax));
	await page.screenshot({ path: join(OUT, "04-390-slider.png") });
	// 真能点到底部 max：点了之后后端应落库 fixed/max
	await page.getByTestId("agent-subagent-thinking-max").click();
	await waitFor(async () => (await j(`/api/agents/${agent.id}/subagent-thinking`)).mode === "fixed" && (await j(`/api/agents/${agent.id}/subagent-thinking`)).level === "max");
	check("390：max 档可达且真能选中（后端已落库 fixed/max）", true);

	console.log(`\n${failed === 0 ? "全部通过" : `有 ${failed} 项失败`}`);
} catch (e) {
	console.error("异常：", e);
	process.exitCode = 1;
} finally {
	if (browser) await browser.close();
	await stop();
}
process.exit(failed === 0 && !process.exitCode ? 0 : 1);
