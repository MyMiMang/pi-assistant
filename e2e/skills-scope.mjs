/**
 * 技能作用域定向 e2e（真实 server + 临时数据目录 + Mock 模型，不联网、不碰钥匙串 / 真实用户数据）。
 * 覆盖：
 *  1) 库存带 canonical id / 来源；默认所有助理都不启用任何技能（内置也不启用）。
 *  2) 按助理启用 / 停用落库，库存 enabledAgents 跟着变。
 *  3) 外部导入 zip：入库（external 来源）并只启用目标助理；同名内容不同返回 409，不静默覆盖。
 *  4) 删除在用技能先 409 带影响列表，确认（?force=1）后 unassign + 删物理文件。
 *  5) 界面：助理 › 设置 › 技能 勾选；设置 › 技能库 显示「N 个助理已启用」与按助理配置弹窗。
 * 运行前先构建：npm run build -w @pi-assistant/web
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { strToU8, zipSync } from "fflate";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = "/tmp/pia-e2e-skills-scope";
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/skills-scope";
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
mkdirSync(OUT, { recursive: true });

let server, browser, failed = 0;
const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); return { status: r.status, data }; };
const ok = async (path, method = "GET", body) => { const { status, data } = await j(path, method, body); if (status >= 400) throw new Error(`${path} ${status} ${JSON.stringify(data)}`); return data; };
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };
const start = async () => { server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] }); server.stdout.on("data", (d) => process.stdout.write(d)); server.stderr.on("data", (d) => process.stdout.write(d)); await waitFor(async () => (await fetch(BASE + "/api/system")).ok); };
const stop = async () => { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await done; };
const zip = (name, desc) => zipSync({ "s/SKILL.md": strToU8(`---\nname: ${name}\ndescription: ${desc}\n---\n\n步骤\n`) });
const importZip = async (bytes, fields = {}) => { const fd = new FormData(); fd.append("file", new Blob([bytes], { type: "application/zip" }), "s.zip"); for (const [k, v] of Object.entries(fields)) fd.append(k, v); const r = await fetch(BASE + "/api/skills/import", { method: "POST", body: fd }); return { status: r.status, data: await r.json() }; };

try {
	await start();
	await ok("/api/settings", "PUT", { onboarded: true });
	const a = (await ok("/api/agents", "POST", { name: "技能甲" })).id;
	const b = (await ok("/api/agents", "POST", { name: "技能乙" })).id;

	// ---------------------------------------------------------------- 1) 库存 / 默认 none
	console.log("\n[1] 库存带 id/source；默认都不启用");
	let skills = await ok("/api/skills");
	check("技能带 canonical id 与 source", skills.every((s) => typeof s.id === "string" && ["builtin", "user", "external"].includes(s.source)), JSON.stringify(skills[0] ?? {}));
	check("默认没有任何技能被启用（内置也不启用）", skills.every((s) => (s.enabledAgents ?? []).length === 0), JSON.stringify(skills.filter((s) => s.enabledAgents.length).map((s) => s.id)));
	const builtin = skills.find((s) => s.builtin);
	check("库存里有内置技能（确认上面不是库存为空）", !!builtin);
	check("两个助理默认启用集合都是空", (await ok(`/api/agents/${a}/skills`)).enabled.length === 0 && (await ok(`/api/agents/${b}/skills`)).enabled.length === 0);

	// ---------------------------------------------------------------- 2) 按助理启用
	console.log("\n[2] 只给甲启用内置技能，乙不受影响");
	await ok(`/api/agents/${a}/skills`, "PUT", { ids: [builtin.id] });
	check("甲的启用集合 = 该技能", JSON.stringify((await ok(`/api/agents/${a}/skills`)).enabled) === JSON.stringify([builtin.id]));
	check("乙仍为空", (await ok(`/api/agents/${b}/skills`)).enabled.length === 0);
	skills = await ok("/api/skills");
	check("库存该技能 enabledAgents 只含甲", JSON.stringify(skills.find((s) => s.id === builtin.id).enabledAgents) === JSON.stringify([a]));

	// ---------------------------------------------------------------- 3) 外部导入
	console.log("\n[3] 导入 zip 到库存并只启用甲；同名不同内容 409");
	let imp = await importZip(zip("e2e-ext", "e2e 导入技能 A"), { agentId: a });
	check("导入成功，来源 external", imp.status === 200 && imp.data.id === "external/e2e-ext", JSON.stringify(imp));
	skills = await ok("/api/skills");
	check("导入技能在库存里且只启用甲", JSON.stringify(skills.find((s) => s.id === "external/e2e-ext")?.enabledAgents) === JSON.stringify([a]));
	check("乙没有被连带启用", (await ok(`/api/agents/${b}/skills`)).enabled.length === 0);
	const conflict = await importZip(zip("e2e-ext", "e2e 导入技能 B 内容不同"));
	check("同名内容不同 → 409 且带 existing", conflict.status === 409 && conflict.data.error === "conflict" && conflict.data.existing?.id === "external/e2e-ext", JSON.stringify(conflict));
	const renamed = await importZip(zip("e2e-ext", "e2e 导入技能 B 内容不同"), { mode: "rename", newName: "e2e-ext-b" });
	check("rename 换名另存成功", renamed.status === 200 && renamed.data.id === "external/e2e-ext-b", JSON.stringify(renamed));

	// ---------------------------------------------------------------- 4) 删除影响
	console.log("\n[4] 删除在用技能：先 409 影响提示，force 后删除");
	const del1 = await j("/api/skills/e2e-ext", "DELETE");
	check("在用删除 → 409 且列出影响助理", del1.status === 409 && del1.data.error === "in_use" && del1.data.agents.includes(a), JSON.stringify(del1));
	check("未 force 时技能仍在库存", (await ok("/api/skills")).some((s) => s.id === "external/e2e-ext"));
	const del2 = await j("/api/skills/e2e-ext?force=1", "DELETE");
	check("force 删除成功", del2.status === 200 && del2.data.ok === true);
	check("删除后从库存消失", !(await ok("/api/skills")).some((s) => s.id === "external/e2e-ext"));
	check("删除后甲不再启用它", !(await ok(`/api/agents/${a}/skills`)).enabled.includes("external/e2e-ext"));

	// ---------------------------------------------------------------- 5) 界面
	console.log("\n[5] 界面：技能库启用数 / 按助理配置 / 助理设置勾选");
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(15_000);

	// 先把 builtin 启用给甲，便于界面断言
	await ok(`/api/agents/${a}/skills`, "PUT", { ids: [builtin.id] });
	await page.goto(`${BASE}/?settings=skills`);
	await page.getByTestId("skills-tab").waitFor();
	await page.getByTestId(`skill-enabled-${builtin.name}`).waitFor();
	check("技能库显示「已启用」计数", /1 个助理已启用/.test(await page.getByTestId(`skill-enabled-${builtin.name}`).innerText()), await page.getByTestId(`skill-enabled-${builtin.name}`).innerText());
	await page.getByTestId(`skill-assign-${builtin.name}`).click();
	await page.getByTestId("skill-assign-modal").waitFor();
	check("按助理配置弹窗打开", await page.getByTestId("skill-assign-modal").isVisible());
	check("弹窗里甲已勾选", await page.getByTestId(`skill-assign-${builtin.name}-${a}`).isChecked());
	await page.keyboard.press("Escape");
	await page.screenshot({ path: join(OUT, "01-inventory.png") });

	// 助理设置 › 技能（打开右侧信息面板的「设置」页）
	await page.addInitScript(() => localStorage.setItem("pia.layout", JSON.stringify({ sideW: 264, paneW: 340, sideCollapsed: false, info: true })));
	await page.goto(`${BASE}/?agent=${a}`);
	await page.getByTestId("info-tabs").waitFor();
	let settingTab = page.getByTestId("info-tabs").locator('[data-itab="settings"]');
	if ((await settingTab.count()) === 0) {
		await page.getByTestId("info-tabs-more").click();
		settingTab = page.getByTestId("info-tabs-menu").locator('[data-itab="settings"]');
	}
	await settingTab.click();
	await page.getByTestId("agent-skills").waitFor();
	const cnt = await page.getByTestId("agent-skills-count").innerText();
	check("助理技能区显示已启用计数", /已启用 1 \/ \d+/.test(cnt), cnt);
	// 取消勾选内置
	await page.getByTestId(`agent-skill-${builtin.name}`).uncheck();
	await waitFor(async () => (await ok(`/api/agents/${a}/skills`)).enabled.length === 0);
	check("界面取消勾选已落库", (await ok(`/api/agents/${a}/skills`)).enabled.length === 0);
	await page.getByTestId(`agent-skill-${builtin.name}`).check();
	await waitFor(async () => (await ok(`/api/agents/${a}/skills`)).enabled.includes(builtin.id));
	check("界面勾选已落库", (await ok(`/api/agents/${a}/skills`)).enabled.includes(builtin.id));
	await page.screenshot({ path: join(OUT, "02-agent-skills.png") });
} finally {
	if (browser) await browser.close().catch(() => {});
	await stop();
}
console.log(failed ? `\n${failed} 项失败 ❌  截图：${OUT}` : `\n全部通过 ✅  截图：${OUT}`);
process.exit(failed ? 1 : 0);
