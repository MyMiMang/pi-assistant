/**
 * 定向验证「设置 › 助理电脑」：空闲自动关机改用应用内下拉（非原生 select）+ 虚拟机资源（CPU / 内存 / 磁盘）。
 * 覆盖：
 *  1) 空闲自动关机是应用内下拉（button + listbox，页面里没有原生 select），Esc 只关菜单不关设置弹窗。
 *  2) 资源区块读现有实例的实际值（cpus 6 / 8GiB / 120GiB），不因“建议值”强行降配。
 *  3) 磁盘只扩不缩：选项里不出现比现值小的值。
 *  4) 菜单定位：portal 到 body、贴住触发器、不越出视口（含 420 高短视口下的翻转）。
 *  5) 菜单自己内部滚动不会把它关掉。
 *  6) 保存 + 刷新：改 CPU / 磁盘后写入后端、刷新仍在，并提示「关机后生效」。
 *  7) 非法值被 API 拒（超范围 / 缩小磁盘 / 非整数），且不落库。
 *  8) 390 窄屏不横向溢出、菜单在视口内。
 * 不碰真实虚拟机：只写设置，不触发安装 / 开机（PIA_LIMA_HOME 指向临时目录）。
 * 运行前先构建：npm run build -w @pi-assistant/web
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = "/tmp/pia-e2e-desktop-resources";
const LIMA_HOME = "/tmp/pia-e2e-desktop-resources-lima";
const OUT = artifactDir("desktop-resources");
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true });
rmSync(LIMA_HOME, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(join(LIMA_HOME, "pia-desktop"), { recursive: true });
mkdirSync(OUT, { recursive: true });

// 预置：开关已开启（但不触发安装，见下）+ 一台“现有虚拟机”的 lima.yaml（cpus 6 / 8GiB / 120GiB）
{
	const seed = new DatabaseSync(join(DATA, "data.db"));
	seed.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	const put = seed.prepare("INSERT INTO settings(key, value) VALUES(?, ?)");
	put.run("desktop", JSON.stringify({ enabled: true, backend: "auto", idleMinutes: 10, mirror: "", fileMirror: "", separate: [], legacyMigrated: false, resources: {} }));
	put.run("onboarded", "true");
	seed.close();
}
writeFileSync(join(LIMA_HOME, "pia-desktop", "lima.yaml"), 'vmType: vz\ncpus: 6\nmemory: "8GiB"\ndisk: "120GiB"\n');

let server, browser, failed = 0;
const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(data)}`); return data; };
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };
const start = async () => { server = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_LIMA_HOME: LIMA_HOME, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] }); server.stdout.on("data", (d) => process.stdout.write(d)); server.stderr.on("data", (d) => process.stdout.write(d)); await waitFor(async () => (await fetch(BASE + "/api/system")).ok); };
const stop = async () => { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await done; };

/** 打开设置 › 助理电脑 */
const openSettings = async (page, agentId) => {
	await page.goto(`${BASE}/?agent=${agentId}&settings=computer`);
	await page.getByTestId("desktop-advanced").evaluate((d) => (d.open = true));
	await page.getByTestId("desktop-resources").waitFor();
};
/** 打开某个下拉，返回菜单 rect 与触发器 rect */
const openMenu = async (page, testId) => {
	await page.getByTestId(testId).click();
	const menu = page.getByTestId(`${testId}-menu`);
	await menu.waitFor();
	const r = await page.evaluate((id) => {
		const btn = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
		const m = document.querySelector(`[data-testid="${id}-menu"]`);
		const mr = m.getBoundingClientRect();
		return { btn: { left: btn.left, right: btn.right, top: btn.top, bottom: btn.bottom }, menu: { left: mr.left, right: mr.right, top: mr.top, bottom: mr.bottom }, parent: m.parentElement === document.body, role: m.getAttribute("role") };
	}, testId);
	return { menu, r };
};
const label = async (page, testId) => ((await page.getByTestId(testId).textContent()) ?? "").trim();
/** 等 UI 反映出来（接口先更新、界面后渲染） */
const waitLabel = async (page, testId, want) => { await waitFor(async () => (await label(page, testId)).includes(want)); return label(page, testId); };

try {
	await start();
	const a = await j("/api/agents", "POST", { name: "资源测试" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
	page.setDefaultTimeout(15_000);

	// ---------------------------------------------------------------- 1) 空闲自动关机：应用内下拉
	console.log("\n[1] 空闲自动关机：应用内下拉（非原生 select）");
	await openSettings(page, a.id);
	check("页面里没有原生 select", (await page.locator("select").count()) === 0, String(await page.locator("select").count()));
	const idle = await openMenu(page, "desktop-idle");
	check("空闲时间是 button + listbox 菜单", idle.r.role === "listbox" && idle.r.parent, JSON.stringify(idle.r));
	await page.getByTestId("desktop-idle-option-30").click();
	await waitFor(async () => (await j("/api/desktop")).settings.idleMinutes === 30);
	check("选 30 分钟后写入后端", true);
	check("按钮显示新值", (await waitLabel(page, "desktop-idle", "30")) !== "", await label(page, "desktop-idle"));
	await page.getByTestId("desktop-idle").click();
	await page.getByTestId("desktop-idle-menu").waitFor();
	await page.keyboard.press("Escape");
	await page.waitForTimeout(200);
	check("Esc 只关菜单", (await page.getByTestId("desktop-idle-menu").count()) === 0);
	check("Esc 不关设置弹窗", await page.getByTestId("settings-content").isVisible());

	// ---------------------------------------------------------------- 2) 资源读现有实例值
	console.log("\n[2] 资源区块：读现有实例实际值，不强行降配");
	check("CPU 显示现有 6", (await label(page, "desktop-cpus")) === "6", await label(page, "desktop-cpus"));
	check("内存显示现有 8", (await label(page, "desktop-memory")).startsWith("8"), await label(page, "desktop-memory"));
	check("磁盘显示现有 120", (await label(page, "desktop-disk")).startsWith("120"), await label(page, "desktop-disk"));
	await page.screenshot({ path: join(OUT, "01a-resources-loaded.png") });
	const state = (await label(page, "desktop-resources-state"));
	check("状态行写的是当前虚拟机 6 核 / 8 GiB / 120 GiB", /6 核 \/ 8 GiB 内存 \/ 120 GiB 磁盘/.test(state), state);
	await page.screenshot({ path: join(OUT, "01-resources.png") });

	// ---------------------------------------------------------------- 3) 磁盘只扩不缩
	console.log("\n[3] 磁盘只扩不缩：选项里没有比现值小的");
	await page.getByTestId("desktop-disk").click();
	await page.getByTestId("desktop-disk-menu").waitFor();
	const diskVals = await page.getByTestId("desktop-disk-menu").locator("[role=option]").evaluateAll((els) => els.map((e) => Number(e.textContent.replace(/[^\d]/g, ""))));
	check("磁盘选项都 ≥ 120", diskVals.length > 0 && diskVals.every((n) => n >= 120), JSON.stringify(diskVals));
	check("磁盘选项含现值 120", diskVals.includes(120), JSON.stringify(diskVals));
	await page.keyboard.press("Escape");

	// ---------------------------------------------------------------- 4) 菜单定位（portal / 贴住触发器 / 不越界）
	console.log("\n[4] 菜单定位：portal 到 body、贴触发器、不越出视口");
	const mem = await openMenu(page, "desktop-memory");
	check("菜单 portal 到 body（不受弹窗容器宽度 / transform 影响）", mem.r.parent, JSON.stringify(mem.r));
	check("菜单左边缘贴住触发器", Math.abs(mem.r.menu.left - mem.r.btn.left) <= 2, JSON.stringify(mem.r));
	const gapDown = Math.abs(mem.r.menu.top - mem.r.btn.bottom);
	const gapUp = Math.abs(mem.r.menu.bottom - mem.r.btn.top);
	check("菜单贴着触发器（下 6px 或上 6px）", Math.min(gapDown, gapUp) <= 7, JSON.stringify(mem.r));
	check("菜单完全在视口内", mem.r.menu.top >= 0 && mem.r.menu.bottom <= 860 && mem.r.menu.left >= 0 && mem.r.menu.right <= 1280, JSON.stringify(mem.r));
	await page.keyboard.press("Escape");

	// ---------------------------------------------------------------- 5) 菜单内部滚动不关闭
	console.log("\n[5] 菜单内部滚动不把它关掉");
	await page.getByTestId("desktop-memory").click(); // 内存档位多（2–12），会限高 + 内部滚动
	await page.getByTestId("desktop-memory-menu").waitFor();
	const scrollable = await page.getByTestId("desktop-memory-menu").evaluate((el) => { el.scrollTop = 60; return { sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop }; });
	await page.waitForTimeout(200);
	check("菜单可内部滚动（限高后 overflow）", scrollable.sh > scrollable.ch, JSON.stringify(scrollable));
	check("内部滚动后菜单仍然打开", await page.getByTestId("desktop-memory-menu").isVisible());
	await page.keyboard.press("Escape");

	// ---------------------------------------------------------------- 6) 保存 + 刷新
	console.log("\n[6] 改 CPU / 磁盘 → 保存 → 刷新仍在");
	await page.getByTestId("desktop-cpus").click();
	await page.getByTestId("desktop-cpus-option-2").click();
	await waitFor(async () => (await j("/api/desktop")).settings.resources.cpus === 2);
	check("CPU 改成 2 已写入后端", true);
	await page.getByTestId("desktop-disk").click();
	await page.getByTestId("desktop-disk-option-160").click();
	await waitFor(async () => (await j("/api/desktop")).settings.resources.diskGiB === 160);
	check("磁盘改成 160 已写入后端", true);
	check("提示关机后生效", (await label(page, "desktop-resources-state")).includes("关机后生效"), await label(page, "desktop-resources-state"));
	// 界面提交的是用户看到的三项生效值（含没动的内存 8）：这样以后换机器 / 宿主变小也不会让已确认的配置漂移
	const after = (await j("/api/desktop")).settings.resources;
	check("落库的是三项生效值（内存仍是现值 8）", after.cpus === 2 && after.memoryGiB === 8 && after.diskGiB === 160, JSON.stringify(after));
	await openSettings(page, a.id);
	check("刷新后 CPU 仍是 2", (await waitLabel(page, "desktop-cpus", "2")) === "2", await label(page, "desktop-cpus"));
	check("刷新后磁盘仍是 160", (await waitLabel(page, "desktop-disk", "160")) !== "", await label(page, "desktop-disk"));
	check("刷新后内存仍是现值 8", (await label(page, "desktop-memory")).startsWith("8"), await label(page, "desktop-memory"));

	// ---------------------------------------------------------------- 7) 非法值
	console.log("\n[7] 非法值被拒且不落库");
	const bad = async (body, why) => {
		const r = await fetch(BASE + "/api/desktop", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ resources: body }) });
		const d = await r.json();
		check(`${why} → 400 且给中文原因`, r.status === 400 && typeof d.error === "string" && d.error.length > 0, `${r.status} ${JSON.stringify(d)}`);
	};
	await bad({ cpus: 2, memoryGiB: 999 }, "内存超上限");
	await bad({ cpus: 2, diskGiB: 40 }, "磁盘比现值小");
	await bad({ cpus: 2.5 }, "CPU 非整数");
	await bad({ cpus: "2" }, "CPU 传字符串");
	const kept = (await j("/api/desktop")).settings.resources;
	check("被拒后设置没被改坏（仍是 cpu 2 / disk 160）", kept.cpus === 2 && kept.diskGiB === 160, JSON.stringify(kept));
	check("没有因为非法请求触发安装下载", (await j("/api/desktop")).install.phase === "idle", JSON.stringify((await j("/api/desktop")).install));

	// ---------------------------------------------------------------- 8) 390 / 420 高
	console.log("\n[8] 390 窄屏 + 420 高：不溢出、菜单不越界");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	const narrow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: innerWidth }));
	check("390：页面不横向溢出", narrow.doc <= narrow.vw, JSON.stringify(narrow));
	for (const id of ["desktop-idle", "desktop-cpus", "desktop-memory", "desktop-disk"]) {
		const m = await openMenu(page, id);
		check(`390：${id} 菜单在视口内`, m.r.menu.top >= 0 && m.r.menu.bottom <= 844 && m.r.menu.left >= 0 && m.r.menu.right <= 390, JSON.stringify(m.r));
		await page.keyboard.press("Escape");
	}
	await page.screenshot({ path: join(OUT, "02-390.png") });
	// 420 高：把资源区块滚到可视区底部，逼出“向上翻转”，确认不会顶出屏幕
	await page.setViewportSize({ width: 900, height: 420 });
	await page.waitForTimeout(300);
	await page.evaluate(() => { const c = document.querySelector("[data-testid=settings-content]"); c.scrollTop = c.scrollHeight; });
	await page.waitForTimeout(200);
	await page.getByTestId("desktop-disk").scrollIntoViewIfNeeded();
	const flipped = await openMenu(page, "desktop-disk");
	const isUp = flipped.r.menu.bottom <= flipped.r.btn.top + 1;
	check("420 高：菜单不顶出屏幕（top ≥ 0）", flipped.r.menu.top >= 0, JSON.stringify(flipped.r));
	check("420 高：菜单在视口内", flipped.r.menu.bottom <= 420 && flipped.r.menu.top >= 0, JSON.stringify(flipped.r));
	check("420 高：菜单有高度（限高后仍可滚动选择）", flipped.r.menu.bottom - flipped.r.menu.top >= 90, JSON.stringify(flipped.r));
	console.log(`  ℹ️ 420 高下磁盘菜单 ${isUp ? "向上翻转" : "向下展开"}（top=${Math.round(flipped.r.menu.top)}, bottom=${Math.round(flipped.r.menu.bottom)}）`);
	await page.screenshot({ path: join(OUT, "03-420-flip.png") });
	await page.keyboard.press("Escape");
} finally {
	if (browser) await browser.close().catch(() => {});
	await stop();
}
console.log(failed ? `\n${failed} 项失败 ❌  截图：${OUT}` : `\n全部通过 ✅  截图：${OUT}`);
process.exit(failed ? 1 : 0);
