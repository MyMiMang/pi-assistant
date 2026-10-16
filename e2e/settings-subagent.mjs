/**
 * 定向验证「助理设置 › 子代理模型 › 任务上限」：每助理覆盖 + 缺省继承旧全局默认值。
 *
 * 背景：旧版把「并发上限 / 最长运行」当全局值放在「设置 › 模型」页；现在改为每个助理可覆盖，
 * 缺省 / 清空 = 继承整个安装的默认值（后端 `defaults` 兼容旧 `settings.subagentModels` 只读）。
 *
 * 后端接口（`GET/PUT /api/agents/:id/subagents/settings` → `{settings, overrides, defaults}`）由后端 owner 实现，
 * 本测试用 page.route 以纯前端 fixture 模拟，不依赖后端合并；旧全局 key 仍用真实服务端读取以确认兼容。
 *
 * 覆盖：
 *  1) 旧库只有 maxMinutes 时：默认并发 10、最长 42，且显示「默认 N」= 继承。
 *  2) 改并发上限 → 失焦保存 → reload 后仍是新值（只改这个助理）。
 *  3) 清空 → 继承默认（PUT 传 null），输入框回到默认值。
 *  4) 非法 / 空 / 越界：失焦恢复成生效值，不静默写 0。
 *  5) 接口失败：显示错误原因，不渲染可编辑的空输入框。
 *  6) 两个助理互不受影响（per-agent scope）。
 *  7) 390 窄屏不横向溢出。
 * 运行前先构建：npm run build -w @pi-assistant/web
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = "/tmp/pia-e2e-settings-subagent";
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/settings-subagent";
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(OUT, { recursive: true });

// 预置旧版设置记录：只有 maxMinutes，缺 maxConcurrent（旧库 / 旧客户端写下的形状）
{
	const seed = new DatabaseSync(join(DATA, "data.db"));
	seed.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	seed.prepare("INSERT INTO settings(key, value) VALUES(?, ?)").run("subagentModels", JSON.stringify({ maxMinutes: 42 }));
	seed.close();
}

let server, browser, failed = 0;
const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`); return data; };
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };
const start = async () => { server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] }); server.stdout.on("data", (d) => process.stdout.write(d)); server.stderr.on("data", (d) => process.stdout.write(d)); await waitFor(async () => (await fetch(BASE + "/api/system")).ok); };
const stop = async () => { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await done; };

/** 打开信息面板（`info` 会按设备持久化，reload 后可能自动开，所以按可见性收敛而不是盲点）。 */
const openPane = async (page) => {
	for (let i = 0; i < 3; i++) {
		if (await page.locator(".pa-pane-wrap").isVisible().catch(() => false)) return;
		const btn = page.getByRole("button", { name: "信息面板" });
		if (await btn.count()) await btn.click({ timeout: 3000 }).catch(() => {});
		await page.waitForTimeout(250);
	}
	await page.locator(".pa-pane-wrap").waitFor();
};
/** 打开「助理设置 › 设置」tab（信息面板），返回任务上限区块 */
const openLimits = async (page, agentId) => {
	await page.goto(`${BASE}/?agent=${agentId}`);
	await page.waitForTimeout(150);
	await openPane(page);
	const bar = page.getByTestId("info-tabs");
	const tab = bar.getByRole("tab", { name: "设置", exact: true });
	if (await tab.count()) await tab.click();
	else { await page.getByTestId("info-tabs-more").click(); await page.getByTestId("info-tabs-menu").getByRole("menuitem", { name: "设置", exact: true }).click(); }
	const sec = page.getByTestId("agent-subagent-limits");
	await sec.waitFor();
	return { sec, conc: page.getByLabel("子代理并发上限"), mins: page.getByLabel("子代理最长运行分钟") };
};

try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "设置测试 A" });
	const b = await j("/api/agents", "POST", { name: "设置测试 B" });
	// 旧全局默认值（兼容读取）
	const legacy = (await j("/api/subagents/settings")).settings;
	const defaults = { maxConcurrent: legacy.maxConcurrent, maxMinutes: legacy.maxMinutes };

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
	page.setDefaultTimeout(15_000);

	// 纯前端 fixture：模拟每助理覆盖 + defaults（后端合并前不依赖真实接口）
	const overrides = { [a.id]: {}, [b.id]: {} };
	let fail = false;
	const payload = (agentId) => {
		const ov = overrides[agentId] ?? {};
		return { settings: { maxConcurrent: ov.maxConcurrent ?? defaults.maxConcurrent, maxMinutes: ov.maxMinutes ?? defaults.maxMinutes }, overrides: ov, defaults };
	};
	await page.route("**/api/agents/*/subagents/settings", async (route) => {
		const url = new URL(route.request().url());
		const m = url.pathname.match(/\/api\/agents\/([^/]+)\/subagents\/settings/);
		const agentId = decodeURIComponent(m?.[1] ?? "");
		if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟接口失败" }) });
		if (route.request().method() === "PUT") {
			const body = JSON.parse(route.request().postData() ?? "{}");
			const ov = { ...(overrides[agentId] ?? {}) };
			for (const k of ["maxConcurrent", "maxMinutes"]) if (k in body) { if (body[k] === null) delete ov[k]; else ov[k] = body[k]; }
			overrides[agentId] = ov;
		}
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload(agentId)) });
	});

	// ---------------------------------------------------------------- 1) 默认（旧记录缺字段）
	console.log("\n[1] 打开默认：旧全局值作默认 + 显示「继承（默认 N）」");
	let { sec, conc, mins } = await openLimits(page, a.id);
	check("旧记录缺 maxConcurrent：并发上限显示默认 10", (await conc.inputValue()) === "10", await conc.inputValue());
	check("旧记录已配置的 maxMinutes 保留：最长运行显示 42", (await mins.inputValue()) === "42", await mins.inputValue());
	check("未覆盖时显示「默认 10」= 继承", ((await sec.textContent()) ?? "").includes("默认 10"));
	await page.screenshot({ path: join(OUT, "01-default-inherit.png") });

	// ---------------------------------------------------------------- 2) 保存后刷新仍在
	console.log("\n[2] 改并发上限 → 失焦保存 → reload 后仍是新值");
	await conc.fill("25");
	await conc.blur();
	await waitFor(() => overrides[a.id].maxConcurrent === 25);
	check("失焦即保存到后端（per-agent override）", true);
	({ sec, conc, mins } = await openLimits(page, a.id));
	check("刷新后并发上限仍是 25", (await conc.inputValue()) === "25", await conc.inputValue());
	check("刷新后不再显示「默认 10」", !((await sec.textContent()) ?? "").includes("默认 10"));
	check("刷新后最长运行仍是 42", (await mins.inputValue()) === "42", await mins.inputValue());

	// ---------------------------------------------------------------- 3) 清空 = 继承默认
	console.log("\n[3] 清空 → 继承默认（PUT null）");
	await conc.fill("");
	await conc.blur();
	await waitFor(() => overrides[a.id].maxConcurrent === undefined);
	check("清空后 override 被删除（回继承）", overrides[a.id].maxConcurrent === undefined);
	check("清空后输入框回到默认 10", (await conc.inputValue()) === "10", await conc.inputValue());

	// 重新设成 25 继续下面的用例
	await conc.fill("25");
	await conc.blur();
	await waitFor(() => overrides[a.id].maxConcurrent === 25);

	// ---------------------------------------------------------------- 4) 非法 / 空输入
	console.log("\n[4] 清空 / 0 / 越界 → 失焦恢复，不静默存 0");
	for (const bad of ["0", "999", "-3"]) {
		await conc.fill(bad);
		await conc.blur();
		await page.waitForTimeout(250);
		check(`并发上限输入「${bad}」后恢复成 25`, (await conc.inputValue()) === "25", await conc.inputValue());
	}
	check("非法输入没有写进后端（仍是 25）", overrides[a.id].maxConcurrent === 25);
	for (const bad of ["0", "-5"]) {
		await mins.fill(bad);
		await mins.blur();
		await page.waitForTimeout(250);
		check(`最长运行输入「${bad}」后恢复成 42`, (await mins.inputValue()) === "42", await mins.inputValue());
	}
	check("最长运行没被写成 0", overrides[a.id].maxMinutes === undefined || overrides[a.id].maxMinutes === 42);

	// ---------------------------------------------------------------- 5) per-agent scope 独立
	console.log("\n[5] 助理 B 不受 A 的覆盖影响");
	const bLimits = await openLimits(page, b.id);
	check("助理 B 并发上限是默认 10", (await bLimits.conc.inputValue()) === "10", await bLimits.conc.inputValue());
	check("助理 B 最长运行是默认 42", (await bLimits.mins.inputValue()) === "42", await bLimits.mins.inputValue());
	await bLimits.conc.fill("7");
	await bLimits.conc.blur();
	await waitFor(() => overrides[b.id].maxConcurrent === 7);
	check("助理 B 改成 7 只写 B", overrides[b.id].maxConcurrent === 7 && overrides[a.id].maxConcurrent === 25);
	await page.screenshot({ path: join(OUT, "02-per-agent.png") });

	// ---------------------------------------------------------------- 6) 接口失败
	console.log("\n[6] 接口失败：显示原因，不渲染空输入框");
	fail = true;
	({ sec, conc, mins } = await openLimits(page, a.id));
	check("接口失败时不渲染可编辑输入框", (await sec.locator("input").count()) === 0, String(await sec.locator("input").count()));
	check("接口失败时显示错误原因", ((await sec.textContent()) ?? "").includes("模拟接口失败"), (await sec.textContent()) ?? "");
	fail = false;
	({ sec, conc, mins } = await openLimits(page, a.id));
	check("接口恢复后回到生效值 25 / 42", (await conc.inputValue()) === "25" && (await mins.inputValue()) === "42", `${await conc.inputValue()}/${await mins.inputValue()}`);

	// ---------------------------------------------------------------- 7) 390 窄屏
	console.log("\n[7] 390 窄屏：不溢出、文字不被 spinner 挤掉");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	const m = await page.evaluate(() => {
		const sec = document.querySelector('[data-testid="agent-subagent-limits"]');
		const inputs = [...(sec?.querySelectorAll("input") ?? [])];
		return { doc: document.documentElement.scrollWidth, vw: innerWidth, sec: sec ? sec.scrollWidth - sec.clientWidth : -1, inputs: inputs.map((i) => ({ v: i.value, sw: i.scrollWidth, cw: i.clientWidth })) };
	});
	check("390：页面不横向溢出", m.doc <= m.vw, JSON.stringify({ doc: m.doc, vw: m.vw }));
	check("390：任务上限区块不横向溢出", m.sec <= 1, String(m.sec));
	check("390：两个输入框文字都放得下", m.inputs.length === 2 && m.inputs.every((i) => i.sw <= i.cw && i.v.length > 0), JSON.stringify(m.inputs));
	await page.screenshot({ path: join(OUT, "03-390.png") });
} finally {
	if (browser) await browser.close().catch(() => {});
	await stop();
}
console.log(failed ? `\n${failed} 项失败 ❌  截图：${OUT}` : `\n全部通过 ✅  截图：${OUT}`);
process.exit(failed ? 1 : 0);
