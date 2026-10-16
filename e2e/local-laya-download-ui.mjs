/**
 * 本地 Laya「下载与组件」取消 / 错误态前端夹具（静态托管 apps/web/dist + page.route 拦所有 /api）。
 * 不启动真实服务、不下载权重、不碰真实数据 / 钥匙串 / 网络。
 *
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 运行：node e2e/local-laya-download-ui.mjs
 *
 * 覆盖（主审列的缺口）：
 *  ① 下载行有「取消」按钮：点它 → POST /api/downloads/local-laya/cancel（同一 job，不另建 controller）；
 *  ② 权重阶段用真实字节百分比（已知总量）；依赖阶段总量未知 → 不定进度条 + 阶段文字，不拿「约 xx」当已下载分母（跨阶段不混字节）；
 *  ③ GET /api/downloads 失败 → 可见错误 + 重试，且**保留已加载的旧行**（不是「读失败 = 没有组件」）；POST 失败也有短可见错误；
 *  ④ 电脑页（设置 › 操作这台电脑）的系统 Laya 卡：安装中「取消」→ POST /api/local-models/laya/cancel；
 *  ⑤ 390 窄屏不横向溢出。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = process.env.LAYA_UI_OUT ?? join(root, "evidence/local-laya-download");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".map": "application/json" };
const web = createServer(async (req, res) => {
	const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
	const file = path === "/" || path === "" ? join(dist, "index.html") : join(dist, path);
	try {
		const data = await readFile(file);
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
		res.end(data);
	} catch {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(await readFile(join(dist, "index.html")));
	}
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${web.address().port}`;

const AGENT = { id: "a1", name: "助理A", avatar: "A", color: "#3b82f6", persona: "", description: "", status: "idle", unread: 0, model: { provider: "mock", id: "mock" }, model_provider: "mock", model_id: "mock", workspace: "/tmp/ws/a1", scope: "user" };
const system = () => ({
	serverId: "srv", publicKey: "pk", pi: { version: "0.0.0", testedWith: "0.0.0", compatible: true, message: "ok" },
	mock: true, local: true, owner: true, server: false, deviceId: "dev", onboarded: true, modelSetupDone: true,
	defaultModel: { provider: "mock", id: "mock" }, credentialBackend: "file",
	sandbox: { mode: "workspace", preference: "workspace", dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "off" }, binary: null, named: {} },
	workspaceRoot: "/tmp/ws", push: { publicKey: "pk" }, seq: 1,
});

/** 权重阶段：已知总量（真实字节百分比）。 */
const layaWeights = () => ({ id: "local-laya", name: "本地快速操作模型（Laya）", group: "本地模型", state: "downloading", received: 323_000_000, total: 646_000_000, percent: 50, size: 646_000_000, detail: "下载模型权重", error: null, canStart: true, canCancel: true });
/** 依赖阶段：总量未知 → 不定进度（total=null），只有真实目录字节，不拿 size 当分母。 */
const layaTorch = () => ({ id: "local-laya", name: "本地快速操作模型（Laya）", group: "本地模型", state: "downloading", received: 12_582_912, total: null, percent: null, size: 646_000_000, detail: "安装 Python 依赖（torch / laya）", error: null, canStart: true, canCancel: true });
const layaErr = () => ({ id: "local-laya", name: "本地快速操作模型（Laya）", group: "本地模型", state: "error", received: 0, total: null, percent: null, size: 646_000_000, detail: null, error: "权重校验未通过：大小不符：model.safetensors", canStart: true, canCancel: true });
const layaMissing = () => ({ id: "local-laya", name: "本地快速操作模型（Laya）", group: "本地模型", state: "missing", received: 0, total: null, percent: null, size: 646_000_000, detail: null, error: null, canStart: true, canCancel: true });
const layaStatus = (state) => ({
	platform: { os: "darwin", arch: "arm64", support: "supported", reason: null },
	install: state === "installing" ? { state: "installing", phase: "weights", received: 323_000_000, total: 646_000_000, error: null, installedAt: null } : { state: "not_installed", phase: "idle", received: 0, total: null, error: null, installedAt: null },
	runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1" },
	health: null, configured: false, registered: null,
	source: { project: "Laya", repoUrl: "", weightsOrg: "", codeLicense: "Apache-2.0", weightsLicense: "apache-2.0", version: "0.4.8", reviewedRevisions: {} },
});

const state = {};
function reset(over = {}) {
	state.dlItem = "weights";
	state.dlFail = false;
	state.dlFailOnce = false;
	state.startFail = false;
	state.layaInstalling = false;
	state.cancels = [];
	state.starts = [];
	Object.assign(state, over);
}
const currentItem = () => (state.dlItem === "weights" ? layaWeights() : state.dlItem === "torch" ? layaTorch() : state.dlItem === "error" ? layaErr() : layaMissing());

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};

async function newPage(browser, { width = 1440, height = 900 } = {}) {
	const ctx = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
	await ctx.route("**/api/**", async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT]);
		if (p === "/api/rooms") return json([]);
		if (p === "/api/downloads" && req.method() === "GET") {
			if (state.dlFail) return json({ error: "boom", message: "模拟载入失败" }, 500);
			if (state.dlFailOnce) {
				state.dlFailOnce = false;
				return json({ error: "boom", message: "模拟载入失败" }, 500);
			}
			return json({ items: [currentItem()] });
		}
		if (/^\/api\/downloads\/[^/]+\/start$/.test(p)) {
			if (state.startFail) return json({ error: "boom", message: "启动失败" }, 500);
			state.starts.push(decodeURIComponent(p.split("/")[3]));
			state.dlItem = "weights";
			return json({ ok: true, item: currentItem() });
		}
		if (/^\/api\/downloads\/[^/]+\/cancel$/.test(p)) {
			state.cancels.push(decodeURIComponent(p.split("/")[3]));
			state.dlItem = "error";
			return json({ ok: true, item: currentItem() });
		}
		if (p === "/api/local-models/laya/status") return json(layaStatus(state.layaInstalling ? "installing" : "idle"));
		if (p === "/api/local-models/laya/cancel") {
			state.cancels.push("local-models/laya");
			state.layaInstalling = false;
			return json({ ok: true, status: layaStatus("idle") });
		}
		if (p === "/api/local-models/laya/platform") return json({ platform: { support: "supported" }, nvidia: { available: false }, cudaAvailable: false, options: [{ id: "cpu", label: "CPU" }] });
		// 设置页启动需要的其余接口：凡是期望数组 / 对象的一律给对形状，避免 `undefined.length` 崩页。
		if (p === "/api/channels") return json({ items: [], publicUrl: null });
		if (p === "/api/wechat") return json({ enabled: false, acknowledgedAt: null, agentIds: [] });
		if (p === "/api/proactive/inbox") return json({ items: [], count: 0, defaultLevel: "normal" });
		if (p === "/api/devices") return json([]);
		if (p === "/api/remote/cloudflare") return json({ configured: false, hasToken: false, config: null });
		if (p === "/api/models/providers") return json(req.method() === "GET" ? [] : {});
		if (p === "/api/models/custom") return json({ providers: [], apis: [], classifierProtocols: [] });
		if (p === "/api/image-models/providers") return json({ providers: [], models: [], default: null });
		if (p === "/api/image-models") return json({ kinds: [], providers: [], models: [], default: null, reusable: [] });
		if (p === "/api/models/registry") return json({ providers: [] });
		if (p === "/api/models") return json([]);
		if (p === "/api/model-strengths") return json({ labels: [], models: [] });
		if (p === "/api/fast-computer/settings") return json({ settings: { enabled: false, kind: "systemone", provider: "", id: "", baseUrl: "", model: "", threshold: 0.5, timeoutMs: 3000 }, classifierModels: [] });
		if (p === "/api/fast-computer/benchmark") return json({ availability: { available: false, reason: "未启用" }, runs: [] });
		if (p === "/api/usage/summary") return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
		if (p === "/api/memory/providers") return json({ global: "basic", providers: [] });
		if (p === "/api/skill-suggest") return json({ enabled: false });
		if (p === "/api/settings") return json({});
		if (p === "/api/audio/asr/config") return json({ maxDurationMs: 60000, maxBytes: 5242880, protocol: "openai-audio-transcriptions" });
		if (p === "/api/audio/asr/providers") return json({ protocols: [], providers: [] });
		if (p === "/api/audio/asr/source") return json({ source: null, options: [] });
		if (p === "/api/sandbox-computer") return json({ approvals: "none" });
		if (p === "/api/desktop") return json({ settings: { enabled: false, backend: "auto", idleMinutes: 10, mirror: "", fileMirror: "", separate: [], resources: {} }, backend: { id: "auto", label: "自带运行时", ok: true }, builtin: { id: "lima", label: "Lima", ready: true }, dockerAvailable: false, image: null, installed: false, install: { phase: "idle", progress: 0, layersDone: 0, layersTotal: 0 }, vm: null, resources: { supported: false, choice: {}, suggested: { cpus: 2, memoryGiB: 2, diskGiB: 20 }, bounds: { cpus: { min: 1, max: 4 }, memoryGiB: { min: 1, max: 8 }, diskGiB: { min: 10, max: 100 } }, applied: null, note: "" } });
		if (p === "/api/subagents") return json([]);
		if (/^\/api\/agents\/[^/]+\/messages$/.test(p)) return json([]);
		if (/^\/api\/agents\/[^/]+\/tasks$/.test(p)) return json([]);
		if (/^\/api\/agents\/[^/]+\/conversations$/.test(p)) return json({ current: null, items: [] });
		if (/^\/api\/agents\/[^/]+\/computer$/.test(p)) return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		if (/^\/api\/agents\/[^/]+\/(subagents\/settings|subagent-model|subagent-thinking)$/.test(p)) return json({});
		if (p === "/api/host-control" && req.method() === "GET") return json({ settings: { enabled: true, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "未运行" }, platform: "darwin", installed: false, version: "0.35.0" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } });
		if (p === "/api/host-control/apps") return json([]);
		if (p === "/api/host-control/plan") return json({ yaml: "", hash: "" });
		if (p.startsWith("/api/host-control")) return json({});
		// 其余设置页请求：一个都不匹配时返回空对象，页面照常渲染。
		return json({});
	});
	const page = await ctx.newPage();
	page.setDefaultTimeout(15_000);
	return { ctx, page };
}

async function open(page, key) {
	await page.goto(`${base}/?settings=${key}`);
	await page.getByTestId("settings-content").waitFor();
}

let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME, headless: true });

	// ① 权重阶段：真实百分比 + 取消按钮 → 取消请求
	{
		reset({ dlItem: "weights" });
		const { ctx, page } = await newPage(browser);
		await open(page, "downloads");
		const row = page.locator('[data-testid="download-row"][data-id="local-laya"]');
		await row.waitFor();
		check("下载与组件：Laya 行可见", await row.isVisible());
		check("权重阶段状态为 downloading", (await row.getAttribute("data-state")) === "downloading");
		const txt = await row.textContent();
		check("显示真实字节百分比 50%", txt.includes("50%"), txt);
		const bar = row.locator(".pa-dl-bar");
		check("进度条不是 indeterminate", !(await bar.getAttribute("class")).includes("indet"));
		const width = await bar.locator("i").getAttribute("style");
		check("进度条宽度=50%", /width:\s*50%/.test(width), width);
		const cancel = row.getByTestId("download-cancel");
		check("下载中显示取消按钮", await cancel.isVisible());
		await page.screenshot({ path: join(OUT, "downloads-weights-desktop.png") });
		await cancel.click();
		await page.waitForTimeout(150);
		check("点取消 → POST /api/downloads/local-laya/cancel", JSON.stringify(state.cancels) === JSON.stringify(["local-laya"]), JSON.stringify(state.cancels));
		await row.waitFor();
		check("取消后行进入 error 且出现重试", (await row.getAttribute("data-state")) === "error" && (await row.getByTestId("download-start").textContent()).includes("重试"));
		await page.screenshot({ path: join(OUT, "downloads-cancelled-desktop.png") });
		await ctx.close();
	}

	// ② 依赖阶段：总量未知 → 不定进度 + 阶段文字，不显示「0 B / 约 xx」把 size 当分母
	{
		reset({ dlItem: "torch" });
		const { ctx, page } = await newPage(browser);
		await open(page, "downloads");
		const row = page.locator('[data-testid="download-row"][data-id="local-laya"]');
		await row.waitFor();
		const txt = await row.textContent();
		check("依赖阶段显示阶段文字", txt.includes("安装 Python 依赖"), txt);
		check("依赖阶段不把「约 646 MB」当已下载分母（跨阶段不混字节）", !txt.includes("约"), txt);
		check("依赖阶段进度条 indeterminate", (await row.locator(".pa-dl-bar").getAttribute("class")).includes("indet"));
		await page.screenshot({ path: join(OUT, "downloads-torch-desktop.png") });
		await ctx.close();
	}

	// ③ GET 失败：可见错误 + 重试；且保留已加载旧行（不是「读失败 = 没有组件」）
	{
		reset({ dlItem: "weights" });
		const { ctx, page } = await newPage(browser);
		await open(page, "downloads");
		const row = page.locator('[data-testid="download-row"][data-id="local-laya"]');
		await row.waitFor();
		// 先成功加载，再让下一次 GET 失败（点取消会触发 reload）
		state.dlFail = true;
		await row.getByTestId("download-cancel").click();
		await page.waitForTimeout(200);
		const banner = page.getByTestId("downloads-error");
		check("GET 失败显示可见错误条", await banner.isVisible());
		check("错误条带重试按钮", await page.getByTestId("downloads-retry").isVisible());
		check("读失败仍保留已加载的旧行（不清空成「没有组件」）", (await page.locator('[data-testid="download-row"][data-id="local-laya"]').count()) === 1);
		await page.screenshot({ path: join(OUT, "downloads-load-error-desktop.png") });
		// 重试成功
		state.dlFail = false;
		await page.getByTestId("downloads-retry").click();
		await page.waitForTimeout(150);
		check("重试后错误条消失", (await page.getByTestId("downloads-error").count()) === 0);
		await ctx.close();
	}

	// ③b POST start 失败：行内短可见错误（不吞、不 alert）
	{
		reset({ dlItem: "missing", startFail: true });
		const { ctx, page } = await newPage(browser);
		await open(page, "downloads");
		const row = page.locator('[data-testid="download-row"][data-id="local-laya"]');
		await row.waitFor();
		await row.getByTestId("download-start").click();
		await page.waitForTimeout(200);
		const err = row.getByTestId("download-row-error");
		check("POST start 失败显示行内错误", await err.isVisible());
		check("错误文字包含服务端消息", (await err.textContent()).includes("启动失败"));
		await page.screenshot({ path: join(OUT, "downloads-action-error-desktop.png") });
		await ctx.close();
	}

	// ④ 电脑页（设置 › 操作这台电脑）Laya 卡：安装中取消 → POST /api/local-models/laya/cancel
	{
		reset({ layaInstalling: true });
		const { ctx, page } = await newPage(browser);
		await open(page, "host");
		const card = page.getByTestId("local-laya-card");
		await card.waitFor();
		const cancel = card.getByTestId("laya-cancel");
		await cancel.waitFor(); // 卡片先渲染占位（正在读取状态），等真实状态到位再断言
		check("电脑页 Laya 卡安装中显示取消", await cancel.isVisible());
		await page.screenshot({ path: join(OUT, "host-laya-installing-desktop.png") });
		await cancel.click();
		await page.waitForTimeout(200);
		check("电脑页取消 → POST /api/local-models/laya/cancel", state.cancels.includes("local-models/laya"), JSON.stringify(state.cancels));
		await ctx.close();
	}

	// ⑤ 390 窄屏：不横向溢出 + 截图
	{
		reset({ dlItem: "weights" });
		const { ctx, page } = await newPage(browser, { width: 390, height: 844 });
		await open(page, "downloads");
		await page.locator('[data-testid="download-row"][data-id="local-laya"]').waitFor();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		check("390 窄屏不横向溢出", overflow <= 1, `overflow=${overflow}`);
		await page.screenshot({ path: join(OUT, "downloads-weights-390.png"), fullPage: true });
		await ctx.close();
	}
} catch (e) {
	failed++;
	console.error("💥 夹具异常：", e);
} finally {
	await browser?.close();
	web.close();
}

console.log(failed === 0 ? `\n全部通过，截图：${OUT}` : `\n${failed} 项失败，截图：${OUT}`);
process.exit(failed === 0 ? 0 : 1);
