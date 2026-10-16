/**
 * 快速操作模型 UI 专项（Mock 模型 + 临时数据目录 + 内存凭据，不连真实付费服务、不碰真实 App）：
 *  A. 首屏：首次进入「快速操作模型」区，设置接口延迟返回时先显示「正在载入…」，加载完即出现选项（无需退出重进）。
 *  B. 注册变化刷新：已开页面里新增一个分类器（走既有 settings.changed 广播），列表自动出现，不重开设置。
 *  C. 实际操作测试：从分类器卡片点开 → 显示「本次测试」的 provider/model；按所点模型评估（GET 带 provider/model/target）；
 *     POST body 带同一 provider/model/target；未就绪时显示原因、开始按钮禁用；Laya 已装未运行给「启动本地 Laya」入口。
 *  D. 目标切换：换「测试电脑」会带新 target 重新评估。
 *
 * 用法：node e2e/fast-computer-benchmark-model-ui.mjs（需先 npm run build -w apps/web）
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startMockOpenAI } from "./mock-openai.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const data = mkdtempSync(`${tmpdir()}/pia-bench-ui-`);
const port = await new Promise((resolve) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => resolve(p));
	});
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: root, env: { ...process.env, PIA_DATA_DIR: data, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
const api = async (path, method = "GET", body) => {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	assert.ok(r.ok, await r.clone().text());
	return r.json();
};
const makeRun = (provider, model, target = "computer") => ({
	id: `run-${Date.now()}`,
	status: "done",
	provider,
	model,
	modelVersion: "v-test",
	provenance: "cua",
	target: { prefix: target, fixtureId: "fx" },
	startedAt: new Date(Date.now() - 1000).toISOString(),
	finishedAt: new Date().toISOString(),
	coldStartMs: null,
	samples: 1,
	successRatio: 1,
	p50Ms: 120,
	p95Ms: 120,
	p95Approx: true,
	actions: 1,
	retries: 0,
	programAssists: 0,
	abstains: 0,
	timeouts: 0,
	errors: 0,
	correctness: 1,
	fallbackCount: 0,
	advisory: { verdict: "ok", message: "路径打通（UI 夹具，非真实桌面）" },
});

let browser;
let relay;
try {
	const end = Date.now() + 30_000;
	while (Date.now() < end) {
		try {
			if ((await fetch(`${base}/api/system`)).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	await api("/api/settings", "PUT", { onboarded: true });

	relay = await startMockOpenAI({ key: "sk-bench" });
	const provider = await api("/api/models/custom", "POST", { name: "测试中转", api: "openai-completions", baseUrl: relay.url, apiKey: "sk-bench", models: [{ id: "relay-chat" }], classifiers: [{ protocol: "typesafe-system-one", modelId: "jev-ui" }] });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	page.on("pageerror", (e) => console.error("[pageerror]", e?.stack ?? e));
	page.on("console", (m) => (m.type() === "error" ? console.error("[console]", m.text()) : undefined));

	// ---- A. 首屏：延迟首个 settings 请求，先「正在载入…」再出现选项
	let delayFirstSettings = true;
	await page.route("**/api/fast-computer/settings**", async (route) => {
		if (delayFirstSettings && route.request().method() === "GET") {
			delayFirstSettings = false;
			await new Promise((r) => setTimeout(r, 500));
		}
		await route.continue();
	});
	await page.goto(`${base}/?settings=host`);
	const sec = page.getByTestId("fast-computer-hostpc");
	await sec.waitFor();
	await sec.getByText("正在载入快速操作设置…").waitFor();
	await sec.getByTestId("fast-refresh-hostpc").waitFor();
	await sec.getByLabel("开启快速操作模型").click();
	await sec.getByTestId("fast-classifier-hostpc").click();
	await page.getByTestId(`fast-classifier-hostpc-option-${provider.id}/jev-ui`).waitFor();
	await page.keyboard.press("Escape");
	console.log("A 通过：首次进入先载入、加载完即出现选项（无需退出重进）。");

	// ---- B. 注册变化刷新：已开页面新增分类器 → 列表自动刷新（走 settings.changed 广播），不重开设置
	const provider2 = await api("/api/models/custom", "POST", { name: "第二个中转", api: "openai-completions", baseUrl: relay.url, apiKey: "sk-bench", models: [{ id: "relay-chat-2" }], classifiers: [{ protocol: "typesafe-system-one", modelId: "jev-ui-2" }] });
	await sec.getByTestId("fast-classifier-hostpc").click();
	await page.getByTestId(`fast-classifier-hostpc-option-${provider2.id}/jev-ui-2`).waitFor({ timeout: 5000 });
	await page.keyboard.press("Escape");
	console.log("B 通过：模型目录变化广播后，已开页面自动刷新列表。");

	// ---- C/D. 实际操作测试：控制 benchmark API 响应，验证「点哪条测哪条」+ 目标切换 + 未就绪原因
	let lastGet = "";
	const posts = [];
	let avail = { cuaReady: true, modelReady: true, fixtureReady: true, reasons: [], model: { provider: provider.id, id: "jev-ui" }, targetKind: "sandbox-app" };
	await page.route("**/api/fast-computer/benchmark**", async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (req.method() === "GET" && url.pathname.endsWith("/benchmark")) {
			lastGet = url.search;
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ availability: avail, runs: [] }) });
		}
		if (req.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(makeRun(provider.id, "jev-ui", url.searchParams.get("target") ?? "computer")) });
		if (req.method() === "POST" && url.pathname.endsWith("/cancel")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
		if (req.method() === "POST") {
			const body = JSON.parse(req.postData() ?? "{}");
			posts.push(body);
			if (!avail.modelReady) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, blocked: true, availability: avail }) });
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, run: makeRun(body.provider, body.model, body.target) }) });
		}
		return route.continue();
	});

	// 切到「模型服务」页，展开对应服务卡片，找到分类器的「实际操作测试」
	await page.locator('[data-tab="models"]').click();
	await page.getByTestId(`service-toggle-${provider.id}`).click();
	const open = page.getByTestId("benchmark-open-jev-ui");
	await open.scrollIntoViewIfNeeded();
	await open.click();
	const dlg = page.getByTestId("actual-task-test");
	await dlg.waitFor();
	await page.getByTestId("benchmark-model").waitFor();
	assert.equal(await page.getByTestId("benchmark-model").getAttribute("data-model"), `${provider.id}/jev-ui`, "弹窗应显示所点模型");
	// GET 按所点模型 + 目标评估
	assert.match(lastGet, new RegExp(`provider=${provider.id}`), "GET 应带所点 provider");
	assert.match(lastGet, /model=jev-ui/, "GET 应带所点 model");
	assert.match(lastGet, /target=computer/);
	// 全局快速模型没开，但所点模型 ready → 开始按钮可用（勾选确认后）
	await page.getByTestId("actual-task-ack").click();
	assert.equal(await page.getByTestId("actual-task-start").isDisabled(), false, "按所点模型评估为 ready 时开始按钮应可用");
	await page.getByTestId("actual-task-start").click();
	await page.waitForFunction(() => document.querySelector('[data-testid="actual-task-verdict"]')?.textContent?.includes("建议使用"));
	assert.equal(posts.length, 1, "应只发一次 POST");
	assert.equal(posts[0].provider, provider.id, "POST 应带所点 provider");
	assert.equal(posts[0].model, "jev-ui", "POST 应带所点 model");
	assert.equal(posts[0].target, "computer");
	console.log("C 通过：按所点 provider/model 评估并测试，POST 带同一模型，不依赖全局快速模型已开启。");

	// D. 目标切换 → 带新 target 重新评估（不 fallback 到另一台）
	await dlg.getByTestId("actual-task-target").click();
	await page.getByTestId("actual-task-target-option-hostpc").click();
	await page.waitForFunction(() => true);
	await page.waitForTimeout(200);
	assert.match(lastGet, /target=hostpc/, "换目标电脑应带新 target 重新评估");
	console.log("D 通过：目标切换按所选电脑重新评估。");

	// 未就绪：模型不可用 → 显示原因、开始禁用；Laya 已装未运行 → 给启动入口
	avail = { cuaReady: true, modelReady: false, fixtureReady: true, reasons: ["本地 Laya 已安装但未运行：先点「启动」，再回来测试。"], model: null, modelStartable: true };
	await dlg.getByRole("button", { name: "取消" }).click();
	await page.getByTestId("benchmark-open-jev-ui").click();
	await page.getByTestId("actual-task-test").waitFor();
	await dlg.waitFor();
	await page.getByTestId("benchmark-availability").getByText(/已安装但未运行/).waitFor();
	await page.getByTestId("benchmark-start-laya").waitFor();
	await page.getByTestId("actual-task-ack").click();
	assert.equal(await page.getByTestId("actual-task-start").isDisabled(), true, "模型未就绪时开始按钮应禁用");
	console.log("未就绪 通过：原因可见、开始禁用、给出「启动本地 Laya」入口（不伪 ready）。");

	{
		const { mkdirSync } = await import("node:fs");
		const out = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/fast-computer-benchmark-model";
		mkdirSync(out, { recursive: true });
		await dlg.screenshot({ path: `${out}/benchmark-dialog-not-ready.png` });
	}
	console.log("全部通过：首屏加载、注册变化刷新、点哪测哪、目标切换、未就绪原因与启动入口。");
} catch (e) {
	console.error(logs.slice(-4000));
	throw e;
} finally {
	await browser?.close();
	relay?.close();
	server.kill("SIGTERM");
}
