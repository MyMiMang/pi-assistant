/**
 * 设置体验收口（A 错误态 / B 助理电脑归属 / C 计数与 ASR 文案 / D 关闭态保存反馈 / E 下载来源折叠）
 * 的纯前端夹具测试：静态托管 apps/web/dist + page.route 拦所有 /api，不启动真实服务、不碰真实数据 / 钥匙串 / 麦克风 / 云。
 *
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 运行：node e2e/settings-usability-ui.mjs
 *
 * 覆盖：
 *  A) 操作这台电脑 / 助理电脑 / 渠道：失败显示「载入失败 + 重试」、重试成功；挂起显示「正在载入…」（不空白）；
 *     已加载后刷新失败保留旧内容并给非阻塞提示。
 *  B) 「助理自己的电脑」审批只在 ?settings=computer 出现，?settings=host 不再出现；三档保存后刷新仍在。
 *  C) 模型服务折叠计数 = 实际可见服务卡数（不再是 registry.length+1）；ASR 小节「声明 ≠ 启用」只留标题 Help 一处。
 *  D) 关闭态自动保存文案为「已保存草稿（未开启）」；开启计划 → ack → 确认流程仍在。
 *  E) 下载来源两个技术输入默认收进单个 details；有自定义值 / 下载失败时默认展开；390 窄屏不溢出。
 *  F) 「操作这台电脑」底部操作条不再 sticky 浮层：真实 DOM 滚动（桌面 / 390）下随内容移动、不覆盖下方提示，
 *     且 review → ack → 确认开启后提示不被遮挡、无原生弹窗。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = artifactDir("settings-usability-polish");
const OUT_HOST = artifactDir("beta26-hostcontrol-flow");
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

const now = Date.now();
const AGENT = (id, name) => ({ id, name, avatar: name[0], color: "#3b82f6", persona: "", description: "", status: "idle", unread: 0, model: { provider: "mock", id: "mock" }, model_provider: "mock", model_id: "mock", workspace: `/tmp/ws/${id}`, scope: "user" });
const system = () => ({
	serverId: "srv", publicKey: "pk", pi: { version: "0.0.0", testedWith: "0.0.0", compatible: true, message: "ok" },
	mock: true, local: true, owner: true, server: false, deviceId: "dev", onboarded: true, modelSetupDone: true,
	defaultModel: { provider: "mock", id: "mock" }, credentialBackend: "file",
	sandbox: { mode: "workspace", preference: "workspace", dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "off" }, binary: null, named: {} },
	workspaceRoot: "/tmp/ws", push: { publicKey: "pk" }, seq: 1,
});
const HOST_OK = () => ({ settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "未运行" }, platform: "darwin", installed: false, version: "0.35.0" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } });
const DESKTOP_OK = () => ({
	settings: { enabled: false, backend: "auto", idleMinutes: 10, mirror: "", fileMirror: "", separate: [], resources: {} },
	backend: { id: "auto", label: "自带运行时", ok: true },
	builtin: { id: "lima", label: "Lima", ready: true },
	dockerAvailable: false,
	image: { ref: "ghcr.io/mymimang/pi-assistant-desktop:1", version: "1", digest: null, downloadBytes: 1.5e9, diskBytes: 5e9, custom: false },
	installed: false,
	install: { phase: "idle", progress: 0, layersDone: 0, layersTotal: 0 },
	vm: null,
	resources: { supported: false, choice: {}, suggested: { cpus: 2, memoryGiB: 2, diskGiB: 20 }, bounds: { cpus: { min: 1, max: 4 }, memoryGiB: { min: 1, max: 8 }, diskGiB: { min: 10, max: 100 } }, applied: null, note: "当前环境不支持调整" },
});
const CLOUD_ASR = { id: "openai", name: "OpenAI", kind: "custom", configured: true, models: [{ provider: "openai", id: "whisper-1", name: "whisper-1", type: "asr", capabilities: ["asr"], confirmed: true, inferred: [], source: "custom", configured: true, asrAdapter: { protocol: "openai-audio-transcriptions", location: "cloud" } }] };
const EXTRA = { id: "deepseek", name: "DeepSeek", kind: "custom", configured: false, models: [] };

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};

/** 每个场景一套独立 context：state 决定各接口 fail / hang / ok，PUT 可写回 */
async function newPage(browser, state, { width = 1440, height = 900 } = {}) {
	const ctx = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
	await ctx.route("**/api/**", async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		const gate = (key) => {
			if (state[key] === "hang") return new Promise(() => {});
			if (state[key] === "fail") return json({ error: "boom", message: "模拟载入失败" }, 500);
			return null;
		};
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT("a1", "助理A"), AGENT("a2", "助理B")]);
		if (p === "/api/rooms") return json([]);
		if (p === "/api/channels") {
			const g = gate("channels");
			if (g) return g;
			return json(state.channelsData ?? { items: [], publicUrl: null });
		}
		if (p === "/api/wechat") return json({ enabled: false, acknowledgedAt: null, agentIds: [] });
		if (p === "/api/downloads") return json({ items: [] });
		if (p.startsWith("/api/proactive/inbox")) return json({ items: [], count: 0, defaultLevel: "normal" });
		if (p === "/api/devices") return json([]);
		if (p === "/api/remote/cloudflare") return json({ configured: false, hasToken: false, config: null });
		if (p === "/api/models/providers") return json(req.method() === "GET" ? [] : {});
		if (p === "/api/models/custom") return json({ providers: [], apis: [], classifierProtocols: [] });
		if (p === "/api/image-models/providers") return json({ providers: [], models: [], default: null });
		if (p === "/api/image-models") return json({ kinds: [], providers: [], models: [], default: null, reusable: [] });
		if (p === "/api/models/registry") return json({ providers: [CLOUD_ASR, EXTRA] });
		if (p === "/api/models") return json([]);
		if (p === "/api/model-strengths") return json({ labels: [], models: [] });
		if (p === "/api/fast-computer/settings") {
			const g = gate("fast");
			if (g) return g;
			return json({ settings: { enabled: false, kind: "systemone", provider: "", id: "", baseUrl: "", model: "", threshold: 0.5, timeoutMs: 3000 }, classifierModels: [] });
		}
		if (p === "/api/fast-computer/benchmark") return json({ availability: { available: false, reason: "未启用" }, runs: [] });
		if (p === "/api/host-control" && req.method() === "PUT") {
			const body = JSON.parse(req.postData() ?? "{}");
			state.hostSaved = body;
			// PUT 之后组件会重新 GET（load）；据此模拟「保存后刷新失败」
			if (state.hostRefreshFail) state.host = "fail";
			return json({ ok: true, settings: { ...HOST_OK().settings, ...body } });
		}
		if (p === "/api/host-control" && req.method() === "GET") {
			const g = gate("host");
			if (g) return g;
			const base = HOST_OK();
			return json(state.hostSaved ? { ...base, settings: { ...base.settings, ...state.hostSaved } } : base);
		}
		if (p === "/api/host-control/plan") return json({ yaml: "agents: all\napps: []", hash: "h1" });
		if (p === "/api/host-control/apps") return json([]);
		if (p.startsWith("/api/host-control/tier")) return json({ ok: true });
		if (p === "/api/sandbox-computer" && req.method() === "PUT") {
			state.sandbox = JSON.parse(req.postData() ?? "{}").approvals;
			return json({ approvals: state.sandbox });
		}
		if (p === "/api/sandbox-computer") {
			const g = gate("sandbox");
			if (g) return g;
			return json({ approvals: state.sandbox ?? "none" });
		}
		if (p === "/api/desktop" && req.method() === "PUT") {
			if (state.desktopPutFail) return json({ error: "boom", message: "模拟保存失败" }, 500);
			const body = JSON.parse(req.postData() ?? "{}");
			state.desktopSaved = body;
			return json({ ...DESKTOP_OK(), settings: { ...DESKTOP_OK().settings, ...body } });
		}
		if (p === "/api/desktop") {
			const g = gate("desktop");
			if (g) return g;
			return json({ ...DESKTOP_OK(), settings: { ...DESKTOP_OK().settings, mirror: state.mirror ?? "", fileMirror: state.fileMirror ?? "" } });
		}
		if (p === "/api/usage/summary") return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
		if (p === "/api/memory/providers") return json({ global: "basic", providers: [] });
		if (p === "/api/skill-suggest") return json({ enabled: false });
		if (p === "/api/settings") return json({});
		if (p === "/api/audio/asr/config") return json({ maxDurationMs: 60000, maxBytes: 5242880, protocol: "openai-audio-transcriptions" });
		if (p === "/api/audio/asr/providers") return json({ protocols: ["openai-audio-transcriptions", "local-asr-http"], providers: [] });
		if (p === "/api/audio/asr/source") return json({ source: null, options: [] });
		if (p === "/api/local-models/asr/sensevoice/status") return json({ platform: { os: "darwin", arch: "arm64", support: "supported" }, license: { decision: "unresolved" }, install: { state: "not_installed", phase: "idle" }, runtime: { state: "stopped" }, configured: false, source: {}, model: {}, notes: [] });
		if (p === "/api/local-models/laya/status") return json({ platform: { support: "supported" }, install: { state: "not_installed", phase: "idle" }, runtime: { state: "stopped" }, configured: false, source: {} });
		if (/^\/api\/agents\/a\d\/computer$/.test(p)) return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		if (/^\/api\/agents\/a\d\/messages$/.test(p)) return json([]);
		if (/^\/api\/agents\/a\d\/conversations$/.test(p) && req.method() === "GET") return json({ current: "c1", items: [] });
		if (/^\/api\/agents\/a\d\/tasks$/.test(p)) return json([]);
		if (/^\/api\/agents\/a\d\/subagent-model$/.test(p)) return json({ pool: [] });
		if (/^\/api\/agents\/a\d\/subagent-thinking$/.test(p)) return json({ mode: "follow" });
		if (/^\/api\/agents\/a\d\/subagents\/settings$/.test(p)) return json({ settings: { maxConcurrent: 10, maxMinutes: 60 }, overrides: {}, defaults: { maxConcurrent: 10, maxMinutes: 60 } });
		if (p.startsWith("/api/subagents")) return json([]);
		if (p.endsWith("/read")) return json({});
		return json({});
	});
	const page = await ctx.newPage();
	page.setDefaultTimeout(15_000);
	return { ctx, page, state };
}

async function open(page, key) {
	await page.goto(`${base}/?settings=${key}`);
	await page.getByTestId("settings-content").waitFor();
}

let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME, headless: true });

	console.log("\n── A1 操作这台电脑：失败态 → 重试成功 ──");
	{
		const state = { host: "fail" };
		const { ctx, page } = await newPage(browser, state);
		await open(page, "host");
		await page.getByTestId("host-load-error").waitFor();
		const txt = (await page.getByTestId("host-load-error").innerText()).trim();
		check("失败显示「载入失败：…」", /载入失败/.test(txt), txt);
		check("失败不空白（内容区有文字）", txt.length > 0);
		check("有重试按钮", await page.getByTestId("host-retry").isVisible());
		await page.screenshot({ path: join(OUT, "A1-host-error.png") });
		state.host = "ok";
		await page.getByTestId("host-retry").click();
		await page.getByTestId("host-settings").waitFor();
		check("重试后出现正常内容", await page.getByTestId("host-settings").isVisible());
		await ctx.close();
	}

	console.log("\n── A2 操作这台电脑：挂起显示「正在载入…」，不空白 ──");
	{
		const { ctx, page } = await newPage(browser, { host: "hang" });
		await open(page, "host");
		await page.getByTestId("host-loading").waitFor();
		check("挂起时显示「正在载入…」", (await page.getByTestId("host-loading").innerText()).includes("载入"));
		check("挂起时不显示失败", (await page.getByTestId("host-load-error").count()) === 0);
		await page.screenshot({ path: join(OUT, "A2-host-loading.png") });
		await ctx.close();
	}

	console.log("\n── A3 助理电脑：失败态 → 重试成功 ──");
	{
		const state = { desktop: "fail" };
		const { ctx, page } = await newPage(browser, state);
		await open(page, "computer");
		await page.getByTestId("desktop-load-error").waitFor();
		check("失败显示「载入失败：…」", /载入失败/.test(await page.getByTestId("desktop-load-error").innerText()));
		state.desktop = "ok";
		await page.getByTestId("desktop-retry").click();
		await page.getByTestId("desktop-settings").waitFor();
		check("重试后出现正常内容", await page.getByTestId("desktop-settings").isVisible());
		await ctx.close();
	}

	console.log("\n── A4 渠道：失败态 → 重试成功 ──");
	{
		const state = { channels: "fail" };
		const { ctx, page } = await newPage(browser, state);
		await open(page, "channels");
		await page.getByTestId("channels-load-error").waitFor();
		check("失败显示「载入失败：…」", /载入失败/.test(await page.getByTestId("channels-load-error").innerText()));
		state.channels = "ok";
		await page.getByTestId("channels-retry").click();
		await page.getByTestId("channels").waitFor();
		check("重试后出现正常内容", await page.getByTestId("channels").isVisible());
		await ctx.close();
	}

	console.log("\n── A5 操作这台电脑：已加载后刷新失败保留旧内容并提示 ──");
	{
		const state = { host: "ok", hostRefreshFail: true };
		const { ctx, page } = await newPage(browser, state);
		await open(page, "host");
		await page.getByTestId("host-settings").waitFor();
		// 改动默认权限触发关闭态自动保存：PUT 成功 → 随后 GET 失败
		await page.getByTestId("default-tier-trusted").click();
		await page.getByTestId("host-refresh-error").waitFor();
		check("刷新失败有非阻塞提示", /刷新失败/.test(await page.getByTestId("host-refresh-error").innerText()));
		check("旧内容仍在（未被清空）", await page.getByTestId("host-settings").isVisible());
		check("保存草稿的 PUT 真的发出", state.hostSaved?.defaultTier === "trusted", JSON.stringify(state.hostSaved));
		await page.screenshot({ path: join(OUT, "A5-host-refresh-error.png") });
		await ctx.close();
	}

	console.log("\n── B 助理自己的电脑：只在助理电脑页 + 三档保存刷新 ──");
	{
		const state = { sandbox: "none" };
		const { ctx, page } = await newPage(browser, state);
		await open(page, "computer");
		await page.getByTestId("sandbox-approvals").waitFor();
		check("助理电脑页出现 sandbox-approvals", await page.getByTestId("sandbox-approvals").isVisible());
		await page.getByTestId("sandbox-approvals").getByRole("radio").nth(1).click();
		await page.waitForTimeout(200);
		check("选择后 PUT 写回（语义不变）", state.sandbox === "sensitive", String(state.sandbox));
		await page.reload();
		await page.getByTestId("sandbox-approvals").waitFor();
		check("刷新后仍是所选档位", await page.getByTestId("sandbox-approvals").getByRole("radio").nth(1).isChecked());
		await page.screenshot({ path: join(OUT, "B-computer-sandbox.png") });
		await open(page, "host");
		await page.getByTestId("host-settings").waitFor();
		check("操作这台电脑页不再出现 sandbox-approvals", (await page.getByTestId("sandbox-approvals").count()) === 0);
		await ctx.close();
	}

	console.log("\n── C 模型服务计数 + ASR 文案 ──");
	{
		const { ctx, page } = await newPage(browser, {});
		await open(page, "models");
		await page.getByTestId("model-services").waitFor();
		const cards = await page.locator('[data-testid="service-card"]').count();
		const badge = (await page.getByTestId("model-services-toggle").locator("span.rounded-full").innerText()).trim();
		check(`折叠计数 = 实际卡片数（${badge} / ${cards}）`, badge === String(cards), `badge=${badge} cards=${cards}`);
		check("搜索占位同一口径", (await page.getByTestId("service-search").getAttribute("placeholder")) === `搜索 ${cards} 个模型服务…`);
		await page.getByTestId("service-toggle-openai").click();
		await page.getByTestId("asr-adapter-section-openai").waitFor();
		const asr = page.getByTestId("asr-adapter-section-openai");
		const asrText = await asr.innerText();
		check("ASR 空态为短句「尚未添加语音模型」", asrText.includes("尚未添加语音模型"), asrText.replace(/\n/g, " "));
		check("删掉底部重复灰字", !asrText.includes("声明只表示"));
		check("ASR 小节只留一处 Help", (await asr.getByTestId("help").count()) === 1, String(await asr.getByTestId("help").count()));
		check("保留协议选择", (await page.getByTestId("asr-protocol-openai").count()) === 1);
		check("保留模型选择/输入", (await asr.locator('[data-testid^="asr-model"]').count()) >= 1);
		await page.screenshot({ path: join(OUT, "C-model-services.png") });
		await ctx.close();
	}

	console.log("\n── D 关闭态保存反馈 + 计划 → ack → 确认 ──");
	{
		const state = { host: "ok" };
		const { ctx, page } = await newPage(browser, state);
		await open(page, "host");
		await page.getByTestId("host-settings").waitFor();
		await page.getByTestId("default-tier-trusted").click();
		await page.getByTestId("host-autosave").waitFor();
		check("关闭态自动保存文案为草稿", (await page.getByTestId("host-autosave").innerText()).includes("已保存草稿（未开启）"));
		await page.getByTestId("host-review").click();
		await page.getByTestId("host-manifest").waitFor();
		check("仍走权限计划", await page.getByTestId("host-manifest").isVisible());
		await page.getByTestId("host-ack").check();
		await page.getByTestId("host-enable").click();
		await page.getByTestId("host-msg").waitFor();
		check("ack 后确认开启成功", /已开启/.test(await page.getByTestId("host-msg").innerText()));
		await ctx.close();
	}

	console.log("\n── E 下载来源折叠 ──");
	{
		const a = await newPage(browser, {});
		await open(a.page, "computer");
		await a.page.getByTestId("desktop-settings").waitFor();
		check("无自定义值时默认收起", !(await a.page.getByTestId("desktop-download-source").evaluate((el) => el.open)) && !(await a.page.getByTestId("desktop-mirror").isVisible()));
		await a.ctx.close();

		const b = await newPage(browser, { mirror: "ghcr.nju.edu.cn" });
		await open(b.page, "computer");
		await b.page.getByTestId("desktop-mirror").waitFor();
		check("有自定义值时自动展开且值回填", (await b.page.getByTestId("desktop-mirror").inputValue()) === "ghcr.nju.edu.cn");
		await b.page.getByTestId("desktop-download-source").scrollIntoViewIfNeeded();
		await b.page.screenshot({ path: join(OUT, "E-download-source-open.png") });
		await b.ctx.close();

		const c = await newPage(browser, { mirror: "ghcr.nju.edu.cn", desktopPutFail: true });
		await open(c.page, "computer");
		await c.page.getByTestId("desktop-mirror").waitFor();
		await c.page.getByTestId("desktop-mirror").fill("ghcr.nju.edu.cn/alt");
		await c.page.locator('xpath=//input[@data-testid="desktop-mirror"]/following-sibling::button').click();
		await c.page.getByText("模拟保存失败").waitFor();
		check("保存失败显示错误、不崩", await c.page.getByTestId("desktop-settings").isVisible());
		check("保存失败不改动已存值", c.state.desktopSaved === undefined, JSON.stringify(c.state.desktopSaved));
		await c.ctx.close();

		const d = await newPage(browser, { mirror: "ghcr.nju.edu.cn" }, { width: 390, height: 844 });
		await open(d.page, "computer");
		await d.page.getByTestId("desktop-settings").waitFor();
		const ov = await d.page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: innerWidth, c: (() => { const el = document.querySelector("[data-testid=settings-content]"); return el.scrollWidth - el.clientWidth; })() }));
		check("390 窄屏详情展开不横向溢出", ov.doc <= ov.vw && ov.c <= 1, JSON.stringify(ov));
		await d.page.screenshot({ path: join(OUT, "E-download-source-390.png") });
		await d.ctx.close();
	}

	console.log("\n── F 操作这台电脑：底部操作条回普通流（真实 DOM 滚动，桌面 / 390）──");
	mkdirSync(OUT_HOST, { recursive: true });
	const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
	for (const [tag, viewport] of [
		["desktop", { width: 1440, height: 900 }],
		["390", { width: 390, height: 844 }],
	]) {
		const state = { host: "ok" };
		const { ctx, page } = await newPage(browser, state, viewport);
		const dialogs = [];
		page.on("dialog", (d) => {
			dialogs.push(d.message());
			void d.dismiss();
		});
		await open(page, "host");
		await page.getByTestId("host-settings").waitFor();
		const bar = page.getByTestId("host-review");
		await bar.waitFor();
		const content = page.getByTestId("settings-content");

		// 1) 归零后滚动固定距离：按钮位移应等于滚动量（普通流），sticky 固定则位移≈0
		await content.evaluate((el) => el.scrollTo({ top: 0, behavior: "instant" }));
		await page.waitForTimeout(60);
		const box0 = await bar.boundingBox();
		const delta = 260;
		await content.evaluate((el, d) => el.scrollTo({ top: d, behavior: "instant" }), delta);
		await page.waitForTimeout(80);
		const box1 = await bar.boundingBox();
		const moved = box0 && box1 ? box0.y - box1.y : NaN;
		check(`[${tag}] 底部操作条随内容滚动（非 sticky 固定）`, Math.abs(moved - delta) <= 4, `位移=${Number.isNaN(moved) ? "n/a" : moved.toFixed(1)}，期望≈${delta}`);

		// 2) 把下方提示（macOS 权限）滚到底：操作条不得与其重叠
		const hint = page.getByTestId("host-mac-perms");
		await hint.evaluate((el) => el.scrollIntoView({ block: "end" }));
		await page.waitForTimeout(80);
		const hb = await hint.boundingBox();
		const bb = await bar.boundingBox();
		check(`[${tag}] 操作条不覆盖下方提示（macOS 权限）`, !(hb && bb && intersects(bb, hb)), `bar=${JSON.stringify(bb)} hint=${JSON.stringify(hb)}`);

		// 3) 保留 review → ack → 确认开启交互；开启后提示不被操作条遮挡
		// （初始 defaultTier=bounded 且未选应用时按钮按设计禁用，先切「信任」档解除，同 D 段）
		await page.getByTestId("default-tier-trusted").click();
		await page.getByTestId("host-autosave").waitFor();
		await bar.click();
		await page.getByTestId("host-manifest").waitFor();
		check(`[${tag}] 仍走权限计划`, await page.getByTestId("host-manifest").isVisible());
		await page.getByTestId("host-ack").check();
		await page.getByTestId("host-enable").click();
		await page.getByTestId("host-msg").waitFor();
		check(`[${tag}] ack 后确认开启成功`, /已开启/.test(await page.getByTestId("host-msg").innerText()));
		await content.evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "instant" }));
		await page.waitForTimeout(80);
		const msg = await page.getByTestId("host-msg").boundingBox();
		const bar2 = await bar.boundingBox();
		check(`[${tag}] 开启后提示不被操作条遮挡`, !(msg && bar2 && intersects(bar2, msg)), `bar=${JSON.stringify(bar2)} msg=${JSON.stringify(msg)}`);
		check(`[${tag}] 全流程无原生弹窗`, dialogs.length === 0, dialogs.join(" | "));

		if (tag === "390") {
			const ov = await page.evaluate(() => {
				const el = document.querySelector("[data-testid=settings-content]");
				return { x: el.scrollWidth - el.clientWidth, doc: document.documentElement.scrollWidth - innerWidth };
			});
			check("[390] 不横向溢出", ov.x <= 1 && ov.doc <= 1, JSON.stringify(ov));
		}
		await page.screenshot({ path: join(OUT_HOST, `F-host-action-${tag}.png`) });
		await ctx.close();
	}

	console.log("\n── 全部完成 ──");
} catch (e) {
	failed++;
	console.error("  ❌ 运行异常", e?.stack ?? e);
} finally {
	await browser?.close();
	web.close();
}
console.log(failed ? `\n❌ 失败 ${failed} 项` : "\n✅ 全部通过");
process.exit(failed ? 1 : 0);
