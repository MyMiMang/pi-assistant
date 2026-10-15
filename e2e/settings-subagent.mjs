/**
 * 定向验证「设置 › 模型 › 子代理」的「子代理并发上限」「子代理最长运行」两个数字输入框。
 * 覆盖：
 *  1) 打开即显示生效值：预置一条「旧版」设置记录（只有 maxMinutes、没有 maxConcurrent），
 *     期望并发上限显示后端默认 10、最长运行保留已配置的 42（不是空白，也不是假默认）。
 *  2) 保存后刷新仍在：改并发上限 → 失焦保存 → reload 后仍是新值。
 *  3) 非法 / 空输入：清空、0、越界，失焦后恢复成仍生效的值，且不静默写 0。
 *  4) 接口失败：显示错误原因，不渲染可编辑的空输入框、不用默认值覆盖。
 *  5) 390 窄屏：不横向溢出，输入框内文字不被 spinner 挤掉。
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

/** 打开设置 › 模型 › 子代理，返回两个输入框 locator */
const openSection = async (page, agentId) => {
	await page.goto(`${BASE}/?agent=${agentId}&settings=models`);
	await page.getByTestId("subagent-section-toggle").waitFor();
	if ((await page.getByTestId("subagent-concurrency").locator("input").count()) === 0) await page.getByTestId("subagent-section-toggle").click();
	await page.getByTestId("subagent-concurrency").waitFor();
	return { sec: page.getByTestId("subagent-concurrency"), conc: page.getByLabel("子代理并发上限"), mins: page.getByLabel("子代理最长运行分钟") };
};

try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "设置测试" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
	page.setDefaultTimeout(15_000);

	// ---------------------------------------------------------------- 1) 默认 + 旧缺字段
	console.log("\n[1] 打开默认 / 旧记录缺字段");
	let { sec, conc, mins } = await openSection(page, a.id);
	check("旧记录缺 maxConcurrent：并发上限显示后端默认 10", (await conc.inputValue()) === "10", await conc.inputValue());
	check("旧记录已配置的 maxMinutes 保留：最长运行显示 42", (await mins.inputValue()) === "42", await mins.inputValue());
	await page.screenshot({ path: join(OUT, "01-default.png") });

	// ---------------------------------------------------------------- 2) 保存后刷新仍在
	console.log("\n[2] 改并发上限 → 失焦保存 → 刷新");
	await conc.fill("25");
	await conc.blur();
	await waitFor(async () => (await j("/api/subagents/settings")).settings.maxConcurrent === 25);
	check("失焦即保存到后端", true);
	({ sec, conc, mins } = await openSection(page, a.id));
	check("刷新后并发上限仍是 25", (await conc.inputValue()) === "25", await conc.inputValue());
	check("刷新后最长运行仍是 42", (await mins.inputValue()) === "42", await mins.inputValue());

	// ---------------------------------------------------------------- 3) 非法 / 空输入
	console.log("\n[3] 清空 / 0 / 越界 → 失焦恢复，不静默存 0");
	for (const bad of ["", "0", "999", "-3"]) {
		await conc.fill(bad);
		await conc.blur();
		await page.waitForTimeout(250);
		check(`并发上限输入「${bad}」后恢复成 25`, (await conc.inputValue()) === "25", await conc.inputValue());
	}
	check("非法输入没有写进后端（仍是 25）", (await j("/api/subagents/settings")).settings.maxConcurrent === 25);
	for (const bad of ["", "0", "-5"]) {
		await mins.fill(bad);
		await mins.blur();
		await page.waitForTimeout(250);
		check(`最长运行输入「${bad}」后恢复成 42`, (await mins.inputValue()) === "42", await mins.inputValue());
	}
	check("最长运行没被写成 0", (await j("/api/subagents/settings")).settings.maxMinutes === 42);
	// 合法边界：1 和 100 都能存
	await conc.fill("100");
	await conc.blur();
	await waitFor(async () => (await j("/api/subagents/settings")).settings.maxConcurrent === 100);
	check("边界 100 可以保存", (await conc.inputValue()) === "100", await conc.inputValue());
	await conc.fill("25");
	await conc.blur();
	await waitFor(async () => (await j("/api/subagents/settings")).settings.maxConcurrent === 25);

	// ---------------------------------------------------------------- 4) 接口失败
	console.log("\n[4] 接口失败：显示原因，不渲染空输入框、不用默认值覆盖");
	await page.route("**/api/subagents/settings", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟接口失败" }) }));
	({ sec, conc, mins } = await openSection(page, a.id));
	check("接口失败时不渲染可编辑输入框", (await sec.locator("input").count()) === 0, String(await sec.locator("input").count()));
	check("接口失败时显示错误原因", ((await sec.textContent()) ?? "").includes("模拟接口失败"), (await sec.textContent()) ?? "");
	await page.unroute("**/api/subagents/settings");
	({ sec, conc, mins } = await openSection(page, a.id));
	check("接口恢复后回到生效值 25 / 42", (await conc.inputValue()) === "25" && (await mins.inputValue()) === "42", `${await conc.inputValue()}/${await mins.inputValue()}`);

	// ---------------------------------------------------------------- 5) 390 窄屏
	console.log("\n[5] 390 窄屏：不溢出、文字不被 spinner 挤掉");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	const m = await page.evaluate(() => {
		const sec = document.querySelector('[data-testid="subagent-concurrency"]');
		const inputs = [...(sec?.querySelectorAll("input") ?? [])];
		return {
			doc: document.documentElement.scrollWidth, vw: innerWidth,
			sec: sec ? sec.scrollWidth - sec.clientWidth : -1,
			// scrollWidth <= clientWidth 说明输入框里的数字没有被 spinner 挤到需要横向滚动
			inputs: inputs.map((i) => ({ v: i.value, sw: i.scrollWidth, cw: i.clientWidth })),
		};
	});
	check("390：页面不横向溢出", m.doc <= m.vw, JSON.stringify({ doc: m.doc, vw: m.vw }));
	check("390：子代理区块不横向溢出", m.sec <= 1, String(m.sec));
	check("390：两个输入框文字都放得下（不被 spinner 遮挡）", m.inputs.length === 2 && m.inputs.every((i) => i.sw <= i.cw && i.v.length > 0), JSON.stringify(m.inputs));
	await page.screenshot({ path: join(OUT, "02-390.png") });
} finally {
	if (browser) await browser.close().catch(() => {});
	await stop();
}
console.log(failed ? `\n${failed} 项失败 ❌  截图：${OUT}` : `\n全部通过 ✅  截图：${OUT}`);
process.exit(failed ? 1 : 0);
