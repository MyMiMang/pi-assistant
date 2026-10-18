/**
 * 子代理「思考强度」在模型目录加载中的语义（真实服务端 + 真实构建 + Chromium）。
 *
 * 用户口径：第一次加载目录时**不能误报「这个模型不支持调整思考强度」**。
 * 覆盖一条精准的纯前端 API 拦截用例（不改后端、不依赖真实模型）：
 *  1) `/api/models` 请求 pending → 弹层显示「正在加载模型档位…」，没有「不支持」、没有假七档；
 *  2) 加载中不锁返回 / Esc 能关，按钮仍显示用户已选的档位（不会把 thinking 变成 off）；
 *  3) 请求 fulfill 后，**弹层不关**也直接变成完整七档滑块（不用退出再进）；
 *  4) 请求失败 → 短失败说明 + 重试；点重试成功后又变成七档滑块。
 *
 * 运行前先构建：`npm run build -w @pi-assistant/web`。
 * 隔离：mkdtemp 的 HOME / PIA_DATA_DIR / PIA_WORKSPACE / TMPDIR，PIA_MOCK + PIA_OFFLINE；
 * 通过 launch-memory 注入内存凭据后启动服务，不能用生产 main 或真实 HOME 绕过启动问题。
 * **浏览器例外**：Chromium 是原生进程，必须给它登录用户家目录 / 真实 TMPDIR（`nativeLaunchBrowserEnv`，
 * 规则与 `packages/server/src/native-launch-env.ts` 一致）。合成 HOME 传给原生进程是已证实的环境传播问题；
 * 本机那次「找不到用于储存 Chrome 的钥匙串」弹窗只有时间上的相关，macOS 因果未验。
 * finally 结束自建的 server 进程组。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { nativeLaunchBrowserEnv } from "./fixtures/native-launch-env.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// 隔离目录必须在起服务 / 起浏览器之前就位（HOME / 数据目录 / 工作区 / 临时目录都在这里）
const SCRATCH = mkdtempSync(join(tmpdir(), "pia-e2e-thinking-loading-"));
const DATA = join(SCRATCH, "data");
const WORKSPACE = join(DATA, "workspace");
const TMP = join(SCRATCH, "tmp");
const HOME = join(SCRATCH, "home");
for (const d of [DATA, WORKSPACE, TMP, HOME]) mkdirSync(d, { recursive: true });
// 原生浏览器环境统一走 helper：家目录取 OS 账户信息，合成临时目录（包括本次自己的 SCRATCH/TMP）一律不带。
const browserEnv = nativeLaunchBrowserEnv({ syntheticRoots: [SCRATCH, DATA, WORKSPACE, TMP, HOME] });
process.env.TMPDIR = TMP;
process.env.HOME = HOME;
const OUT = join(SCRATCH, "shots");
mkdirSync(OUT, { recursive: true });

const PORT = await new Promise((resolve) => {
	const sv = createServer().listen(0, "127.0.0.1", () => {
		const p = sv.address().port;
		sv.close(() => resolve(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;

let server, browser, failed = 0;
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
const j = async (path, method = "GET", body) => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const data = await r.json();
	if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`);
	return data;
};
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};
const start = async () => {
	server = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
		cwd: ROOT,
		detached: true,
		env: { ...process.env, HOME, TMPDIR: TMP, PIA_DATA_DIR: DATA, PIA_WORKSPACE: WORKSPACE, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (d) => process.stdout.write(d));
	server.stderr.on("data", (d) => process.stderr.write(d));
	await waitFor(async () => (await fetch(BASE + "/api/system")).ok);
};
/** 关掉自己起的整组进程（server 用 detached 起，负 pid = 组） */
const stop = async () => {
	if (!server || server.exitCode !== null) return;
	const done = new Promise((r) => server.once("exit", r));
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		server.kill("SIGTERM");
	}
	await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
	if (server.exitCode === null) {
		try {
			process.kill(-server.pid, "SIGKILL");
		} catch {}
	}
};
const openTab = async (page, name) => {
	const bar = page.getByTestId("info-tabs");
	const tab = bar.getByRole("tab", { name, exact: true });
	if (await tab.count()) await tab.click();
	else {
		await page.getByTestId("info-tabs-more").click();
		await page.getByTestId("info-tabs-menu").getByRole("menuitem", { name, exact: true }).click();
	}
};
const openAgentSettings = async (page, agentId) => {
	await page.goto(`${BASE}/?agent=${agentId}`);
	await page.waitForSelector(".pa-pane-wrap, button[aria-label='信息面板']");
	await page.waitForTimeout(500);
	if (!(await page.locator(".pa-pane-wrap").isVisible().catch(() => false))) await page.getByRole("button", { name: "信息面板" }).click();
	await page.locator(".pa-pane-wrap").waitFor({ state: "visible" });
	await openTab(page, "模型");
	await page.getByTestId("agent-subagent-model").waitFor();
};
const remountSettings = async (page) => {
	await openTab(page, "概览");
	await openTab(page, "模型");
	await page.getByTestId("agent-subagent-model").waitFor();
};
const menu = (page) => page.getByTestId("agent-subagent-thinking-menu");
const openMenu = async (page) => {
	if (!(await menu(page).count())) await page.getByTestId("agent-subagent-thinking").click();
	await menu(page).waitFor();
};
const closeMenu = async (page) => {
	await page.keyboard.press("Escape");
	await menu(page).waitFor({ state: "detached" });
};
const steps = (page) => menu(page).locator(".pa-think-step").count();

try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = await j("/api/agents", "POST", { name: "加载态测试" });
	// 真实 Pi 目录里的推理模型（七档），自定义渠道只是让目录里有它，不连真实服务
	const prov = await j("/api/models/custom", "POST", {
		name: "加载态中转",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		noKey: true,
		models: [{ id: "gpt-6.1-sol", reasoning: true }],
	});
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: prov.id, id: "gpt-6.1-sol" } });
	// 用户已选固定档位：加载中不许被改成 off / 默认
	await j(`/api/agents/${agent.id}/subagent-thinking`, "PUT", { mode: "fixed", level: "xhigh" });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
	page.setDefaultTimeout(15_000);

	// 精准拦截：只挂住模型目录接口，providers 照常；不 fixture 真实 user db（数据目录本来就是临时 mkdtemp）
	let mode = "hold"; // hold | pass | fail
	// 挂起屏障：hold 期间的目录请求一起等同一个 promise，放行时一次性 resolve（不各自 continue 两次）
	let barrier = null;
	let openBarrier = null;
	const catalog = await j("/api/models");
	const sol = catalog.find((m) => m.provider === prov.id && m.id === "gpt-6.1-sol");
	assert.ok(sol?.thinking?.includes("xhigh") && sol.thinking.includes("max"), `目录里该模型应有 xhigh/max：${JSON.stringify(sol?.thinking)}`);
	const wantSteps = sol.thinking.length;
	await page.route("**/api/models", async (route) => {
		if (new URL(route.request().url()).pathname !== "/api/models") return route.continue();
		if (mode === "fail") return route.abort();
		if (mode === "hold") {
			if (!barrier) barrier = new Promise((r) => (openBarrier = r));
			await barrier;
		}
		return route.continue().catch(() => {});
	});
	const releaseAll = async () => {
		mode = "pass";
		openBarrier?.();
		openBarrier = null;
		barrier = null;
	};

	// ---------------------------------------------------------------- 1) pending → 加载中，不是「不支持」
	console.log("\n[1] 模型目录 pending：弹层说「正在加载」，不冒充不支持");
	await openAgentSettings(page, agent.id);
	const chipTextBefore = (await page.getByTestId("agent-subagent-thinking").innerText()).trim();
	await openMenu(page);
	await page.getByTestId("agent-subagent-thinking-loading").waitFor();
	check("显示「正在加载模型档位…」", (await page.getByTestId("agent-subagent-thinking-loading").innerText()).includes("正在加载模型档位"));
	check("没有「不支持调整思考强度」", (await page.getByTestId("agent-subagent-thinking-unsupported").count()) === 0);
	check("没有画假档位（0 个刻度）", (await steps(page)) === 0);
	check("按钮仍显示用户已选「超高」，加载不改档位", (await page.getByTestId("agent-subagent-thinking").innerText()).includes("超高"), chipTextBefore);
	const backendThinking = await j(`/api/agents/${agent.id}/subagent-thinking`);
	check("服务端 thinking 仍是 fixed/xhigh（加载态不写库）", backendThinking.mode === "fixed" && backendThinking.level === "xhigh", JSON.stringify(backendThinking));
	await page.screenshot({ path: join(OUT, "01-loading.png") });

	// 加载中不锁关闭：Esc 能关掉弹层
	await closeMenu(page);
	check("加载中 Esc 能关闭弹层（不锁返回 / 关闭）", (await menu(page).count()) === 0);

	// ---------------------------------------------------------------- 2) fulfill → 当前开着的弹层直接变完整七档
	console.log("\n[2] 请求 fulfill：不关弹层也直接变成完整滑块");
	await openMenu(page);
	check("重新打开仍是加载中（请求还没回）", (await page.getByTestId("agent-subagent-thinking-loading").count()) === 1);
	await releaseAll();
	await waitFor(async () => (await steps(page)) === wantSteps);
	check(`弹层没关，直接出现完整滑块（${wantSteps} 个刻度 = 该模型支持档位数）`, (await steps(page)) === wantSteps, String(await steps(page)));
	check("加载态消失，不再显示不支持", (await page.getByTestId("agent-subagent-thinking-unsupported").count()) === 0);
	check("档位含 xhigh / max（真实目录，不凭空补）", (await page.getByTestId("agent-subagent-thinking-xhigh").count()) === 1 && (await page.getByTestId("agent-subagent-thinking-max").count()) === 1);
	await page.screenshot({ path: join(OUT, "02-loaded.png") });
	await closeMenu(page);

	// ---------------------------------------------------------------- 3) 失败 → 短失败 + 重试 → 恢复七档
	console.log("\n[3] 请求失败：短失败 + 重试；重试成功后恢复滑块");
	mode = "fail";
	await remountSettings(page); // 重新挂载组件 = 重新拉一次目录
	await openMenu(page);
	await page.getByTestId("agent-subagent-thinking-error").waitFor();
	check("失败时给短说明（不是「不支持」）", (await page.getByTestId("agent-subagent-thinking-error").innerText()).includes("没加载出来"));
	check("失败时也不画假档位", (await steps(page)) === 0);
	check("失败时有「重试」按钮", (await page.getByTestId("agent-subagent-thinking-retry").count()) === 1);
	check("失败时仍没有「不支持」误报", (await page.getByTestId("agent-subagent-thinking-unsupported").count()) === 0);
	await page.screenshot({ path: join(OUT, "03-error.png") });
	mode = "pass";
	await page.getByTestId("agent-subagent-thinking-retry").click();
	await waitFor(async () => (await steps(page)) === wantSteps);
	check(`重试后弹层不关、直接恢复滑块（${wantSteps} 档）`, (await steps(page)) === wantSteps);
	check("重试后错误消失", (await page.getByTestId("agent-subagent-thinking-error").count()) === 0);
	const after = await j(`/api/agents/${agent.id}/subagent-thinking`);
	check("全程没有把用户档位改成 off（服务端仍 fixed/xhigh）", after.mode === "fixed" && after.level === "xhigh", JSON.stringify(after));
	await page.screenshot({ path: join(OUT, "04-retry-ok.png") });

	console.log(`\n${failed === 0 ? "全部通过" : `有 ${failed} 项失败`}`);
} catch (e) {
	console.error("异常：", e);
	process.exitCode = 1;
} finally {
	if (browser) await browser.close();
	await stop();
	rmSync(SCRATCH, { recursive: true, force: true });
}
process.exit(failed === 0 && !process.exitCode ? 0 : 1);
