/**
 * 请求级 Fast（`service_tier: priority`）的**真实界面交互**验证（只跑这一个脚本，不跑全量 e2e）。
 *
 * 覆盖（对应 docs/design/fast-mode-contract.md §7，之前只有纯函数 / 静态 DOM 测试，这里补真 DOM）：
 *  1) 紧凑层里的闪电是真按钮：aria-pressed / 能力不可用时 aria-disabled 仍可聚焦看原因；
 *  2) 悬停约 450ms 出说明（不是 native title）；**说明开着时按 Esc 只关说明，紧凑层菜单还在**；
 *  3) 点一下真的 PATCH `{fast:true}` → aria-pressed 跟手 → 刷新后仍在（服务端持久化）；
 *  4) 保存失败：只回滚 fast（界面回到原状态）+ 给原因，不假装成功；
 *  5) 键盘打开（Enter）焦点落在模型名；Esc 关闭后焦点不留在已移除的弹层里；
 *  6) 390 宽：紧凑层不横向溢出、不出屏；
 *  7) 协议不支持（anthropic-messages）：灯仍显示但 aria-disabled，点击不发请求，说明里写清原因。
 *
 * 不碰真实数据 / 真实 Key / 付费模型：临时 PIA_DATA_DIR + HOME + TMPDIR（mkdtemp，结束只删本次），
 * `PIA_MOCK=1` + `PIA_OFFLINE=1`，模型渠道指向 127.0.0.1:1（连不通也不会发真实请求）。
 *
 * ⚠️ 浏览器环境统一走 `e2e/fixtures/native-launch-env.mjs`（`nativeLaunchBrowserEnv()`：原生进程用真实 HOME /
 * 真实 TMPDIR，服务进程仍用临时目录）。该 helper 还没合进本树（由 heavy 槽接线），**本脚本不自行跨树复制**：
 * helper 不在时明确退出码 2 并说明，不用真实 HOME 冒充也没接线地起 Chrome。
 * helper 落进本树后直接 `node e2e/fast-mode-ui.mjs` 即可（先 `npm run build -w @pi-assistant/web`）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 浏览器环境 helper（heavy 槽接线后落进本树）；没有就明确「没运行」，不拿真实 HOME 硬起 Chrome
const HELPER = fileURLToPath(new URL("./fixtures/native-launch-env.mjs", import.meta.url));
if (!existsSync(HELPER)) {
	console.error(
		[
			"⏸  fast-mode-ui 未运行：e2e/fixtures/native-launch-env.mjs（native 浏览器环境 helper）还没合进本树。",
			"   本脚本不跨树复制 helper，也不会用真实 HOME / 改过的 TMPDIR 硬起 Chrome。",
			"   helper 落进本树后直接重跑；服务端仍然只用临时 HOME / DATA / WORKSPACE / TMPDIR。",
		].join("\n"),
	);
	process.exit(2);
}
const { nativeLaunchBrowserEnv } = await import(pathToFileURL(HELPER).href);
const { chromium } = await import("playwright-core");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN_DIR = mkdtempSync(join(tmpdir(), "pia-e2e-fast-mode-"));
const DATA = join(RUN_DIR, "data");
const FAKE_HOME = join(RUN_DIR, "home");
const WORKSPACE = join(RUN_DIR, "workspace");
const OUT = process.env.SHOT_DIR ?? join(RUN_DIR, "shots");
mkdirSync(DATA, { recursive: true });
mkdirSync(FAKE_HOME, { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(OUT, { recursive: true });
const PORT = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], {
	cwd: ROOT,
	env: {
		...process.env,
		PIA_DATA_DIR: DATA,
		PIA_WORKSPACE_DIR: WORKSPACE,
		HOME: FAKE_HOME,
		TMPDIR: RUN_DIR,
		PIA_MOCK: "1",
		PIA_OFFLINE: "1",
		PIA_PORT: String(PORT),
	},
	stdio: ["ignore", "pipe", "pipe"],
	detached: true, // 独立进程组：结束时按组收，异常也不留孤儿
});
let logs = "";
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
const j = async (path, method = "GET", body) => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const t = await r.text();
	if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t}`);
	return t ? JSON.parse(t) : null;
};
const waitFor = async (fn, ms = 20_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("timeout");
};
let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};
let browser;
const stop = async () => {
	try {
		if (browser) await browser.close();
	} catch {}
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {}
	await new Promise((r) => setTimeout(r, 500));
	try {
		process.kill(-server.pid, "SIGKILL");
	} catch {}
};

try {
	await waitFor(async () => (await fetch(`${BASE}/api/system`)).ok);
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = await j("/api/agents", "POST", { name: "Fast 交互验证" });
	// OpenAI 兼容协议 = requestable-unverified（可切、写明未知）；不确定的渠道只连 127.0.0.1:1
	const relay = await j("/api/models/custom", "POST", { name: "本地假中转", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true, models: [{ id: "fast-model", contextWindow: 131072, maxTokens: 8192 }] });
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: relay.id, id: "fast-model" } });

	// 原生 Chromium 用 helper 给的那份环境（真实 HOME / 真实 TMPDIR）；服务进程那份临时目录不受影响
	const browserEnv = nativeLaunchBrowserEnv({ syntheticRoots: [RUN_DIR, DATA, WORKSPACE, FAKE_HOME] });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"], env: browserEnv });
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	const page = await ctx.newPage();
	page.setDefaultTimeout(20_000);
	const patches = [];
	page.on("request", (r) => {
		if (r.method() === "PATCH" && /\/api\/agents\/[^/]+$/.test(r.url())) {
			try {
				const body = r.postDataJSON();
				if ("fast" in body) patches.push(body);
			} catch {}
		}
	});
	const fastBtn = () => page.getByTestId("thinking-fast");
	const compact = () => page.getByTestId("model-picker-compact");
	const openCompact = async () => {
		if (!(await compact().count())) await page.getByTestId("model-picker").click();
		await compact().waitFor();
	};
	const closeAll = async () => {
		for (let i = 0; i < 3; i++) {
			if (!(await compact().count())) return;
			await page.keyboard.press("Escape");
			await page.waitForTimeout(80);
		}
	};
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.getByTestId("model-picker").waitFor();

	// ---------------- 1) 紧凑层里的闪电是真按钮
	console.log("\n[1] 紧凑层：Fast 是真按钮，可请求（requestable）时不 aria-disabled");
	await openCompact();
	await fastBtn().waitFor();
	check("闪电出现在紧凑层（第一层就能切，不用先进目录）", true);
	check("aria-pressed=false（默认关）", (await fastBtn().getAttribute("aria-pressed")) === "false");
	check("requestable-unverified 不禁用（仍可显式请求）", (await fastBtn().getAttribute("aria-disabled")) === null);
	const label = await fastBtn().getAttribute("aria-label");
	check("aria-label 说明「已关：不附加任何参数」", /已关：不附加任何参数/.test(label ?? ""), label);
	check("没有 native disabled（aria-disabled 不挡 focus / 说明）", (await fastBtn().isDisabled()) === false);

	// ---------------- 2) 悬停说明 + Esc 只关说明
	console.log("\n[2] 悬停约 450ms 出说明；Esc 只关说明，不误关紧凑层");
	await fastBtn().hover();
	await page.waitForTimeout(250);
	check("悬停 250ms 还没出（不是一点就弹）", (await page.getByTestId("hover-tip").count()) === 0);
	await page.getByTestId("hover-tip").waitFor({ timeout: 3000 }).catch(() => {});
	check("悬停后出说明气泡", (await page.getByTestId("hover-tip").count()) === 1);
	check("说明里写清只对下一次请求生效", /只对下一次请求生效/.test((await page.getByTestId("hover-tip").innerText().catch(() => "")) ?? ""));
	check("说明里写明可能增加费用（不承诺通用倍率）", /可能增加用量 \/ 费用/.test((await page.getByTestId("hover-tip").innerText().catch(() => "")) ?? ""));
	await page.keyboard.press("Escape");
	await page.waitForTimeout(120);
	check("Esc 关掉说明气泡", (await page.getByTestId("hover-tip").count()) === 0);
	check("Esc 没有顺手关掉紧凑层（菜单还在）", (await compact().count()) === 1);
	await page.screenshot({ path: join(OUT, "01-fast-tip-esc.png") });

	// ---------------- 3) 真实保存 + 刷新后仍在
	console.log("\n[3] 点一下真的保存：PATCH {fast:true}、aria-pressed 跟手、刷新后仍在");
	patches.length = 0;
	await fastBtn().click();
	await waitFor(() => patches.length === 1);
	check("只发一次 PATCH，且 body 只有 fast 字段", patches.length === 1 && Object.keys(patches[0]).join(",") === "fast", JSON.stringify(patches));
	await waitFor(async () => (await fastBtn().getAttribute("aria-pressed")) === "true");
	check("aria-pressed=true（保存成功后跟手）", true);
	check("服务端已落库", (await j("/api/agents")).find((x) => x.id === agent.id)?.fast === true);
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	await openCompact();
	check("刷新后仍是开（不是只存在界面里）", (await fastBtn().getAttribute("aria-pressed")) === "true");
	await page.screenshot({ path: join(OUT, "02-fast-on.png") });

	// ---------------- 4) 保存失败：只回滚 fast + 给原因
	console.log("\n[4] 保存失败：回滚到原状态、不假装成功，并说明原因");
	await page.route(`**/api/agents/${agent.id}`, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"模拟保存失败"}' }) : route.continue()));
	await fastBtn().click();
	await waitFor(async () => (await fastBtn().getAttribute("aria-pressed")) === "true");
	check("失败后回到开（原状态），没有留下假的关", true);
	await fastBtn().focus();
	await page.getByTestId("hover-tip").waitFor();
	check("说明里给出「保存失败，已恢复原状态」", /保存失败，已恢复原状态/.test((await page.getByTestId("hover-tip").innerText()) ?? ""));
	await page.screenshot({ path: join(OUT, "03-fast-save-failed.png") });
	await page.unroute(`**/api/agents/${agent.id}`);
	await page.keyboard.press("Escape");
	await closeAll();

	// ---------------- 5) 键盘：Enter 打开焦点落在模型名；Esc 不留在已移除的弹层
	console.log("\n[5] 键盘：Enter 打开焦点进紧凑层（模型名）；Esc 关闭后焦点不留在弹层");
	await page.getByTestId("model-picker").focus();
	await page.keyboard.press("Enter");
	await compact().waitFor();
	const focusedInPanel = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="model-picker-compact"]'));
	check("键盘打开后焦点在紧凑层内", focusedInPanel, await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)));
	check("焦点落在模型名（可继续按 Enter 进目录）", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "thinking-model"));
	await page.keyboard.press("Tab");
	const onFast = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "thinking-fast");
	check("Tab 能移到 Fast（键盘可达）", onFast);
	await page.keyboard.press("Escape"); // 先关说明（若有）
	await page.keyboard.press("Escape");
	await waitFor(async () => (await compact().count()) === 0);
	check("Esc 关闭后焦点不留在已移除的弹层里", await page.evaluate(() => !document.activeElement?.closest('[data-testid="model-picker-compact"]')));

	// ---------------- 6) 390 宽
	console.log("\n[6] 390 宽：紧凑层不出屏、不横向溢出");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	await openCompact();
	const box = await compact().boundingBox();
	check("紧凑层在屏幕内", !!box && box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box));
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
	check("整页无横向溢出", overflow <= 1, `${overflow}`);
	await page.screenshot({ path: join(OUT, "04-fast-390.png") });
	await closeAll();

	// ---------------- 7) 协议不支持：可聚焦看原因，点击不发请求
	console.log("\n[7] 协议不支持（anthropic-messages）：灯仍显示但 aria-disabled，点击不发请求");
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: "mock", id: "echo" } });
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	await openCompact();
	patches.length = 0;
	const disabledLabel = await fastBtn().getAttribute("aria-label");
	check("不可用用 aria-disabled（仍能聚焦看原因）", (await fastBtn().getAttribute("aria-disabled")) === "true");
	check("没有 native disabled", (await fastBtn().isDisabled()) === false);
	check("说明写清「不可用：当前接口暂未接入 Fast」", /不可用：当前接口暂未接入 Fast/.test(disabledLabel ?? ""), disabledLabel);
	await fastBtn().click();
	await page.waitForTimeout(300);
	check("点击不产生 PATCH（不假装能开）", patches.length === 0, JSON.stringify(patches));
	await page.screenshot({ path: join(OUT, "05-fast-unsupported.png") });

	console.log(failed ? `\n❌ ${failed} 项失败` : "\n✅ 全部通过");
} catch (e) {
	failed++;
	console.error("❌ 脚本异常：", e);
	console.error(logs.slice(-3000));
} finally {
	await stop();
	if (!process.env.KEEP) rmSync(RUN_DIR, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
