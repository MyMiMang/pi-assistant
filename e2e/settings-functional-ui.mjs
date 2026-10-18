/**
 * 设置信息架构重排（功能位）纯前端验证：导航分组 / 模型页瘦身 / 新「语音配置」/ 语音入口清理。
 *
 * 纯前端：静态托管 apps/web/dist + page.route 拦所有 /api；不碰真实麦克风 / 服务端 / 云 / 后端接口。
 * 新接口（`/api/audio/asr/source`、`/api/agents/:id/subagents/settings`）由后端 owner 实现，这里按契约用 fixture 模拟。
 *
 * 覆盖：
 *  1) 导航：17 项 / 5 个分组标题 / `?settings=model` 别名 / entry、downloads 仍可达 / 390 不横向溢出。
 *  2) 模型页瘦身：不再有本地 Laya / SenseVoice 卡、没有子代理折叠区；ASR 只保留「声明」。
 *  3) 语音配置：云空态去模型服务 / 选云模型保存并持久化 / 保存失败回滚 / 本地许可「下载暂不可用」常驻 + 导入可用 / 无第二套 Key 输入。
 *  4) 语音入口：未配置 idle 干净；点麦克风才出现「去设置」；点它打开「语音配置」且链接真的消失；切助理清提示。
 *  5) Help：Tab 聚焦打开、Escape 只关气泡不关设置弹窗。
 * 运行前先构建：npm run build -w @pi-assistant/web
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = decodeURIComponent(new URL("..", import.meta.url).pathname);
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = artifactDir("settings-functional-ui");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".map": "application/json" };
const web = createServer(async (req, res) => {
	const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
	const file = path === "/" || path === "" ? join(dist, "index.html") : join(dist, path);
	try {
		const data = await readFile(file);
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
		res.end(data);
	} catch {
		const html = await readFile(join(dist, "index.html"));
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(html);
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
const mkMsg = (over) => ({ id: "x", agent_id: "a1", role: "assistant", content: "", meta: {}, status: "done", created_at: now, updated_at: now, conversation_id: "c1", ...over });
const MSGS = { a1: [mkMsg({ id: "a1m", content: "好的。" })], a2: [mkMsg({ id: "a2m", agent_id: "a2", content: "在。" })] };

const CLOUD_ASR = { id: "openai", name: "OpenAI", kind: "custom", configured: true, models: [{ provider: "openai", id: "whisper-1", name: "whisper-1", type: "asr", capabilities: ["asr"], confirmed: true, inferred: [], source: "custom", configured: true, asrAdapter: { protocol: "openai-audio-transcriptions", location: "cloud" } }] };
const LOCAL_ASR = { id: "local-sensevoice", name: "本地语音识别（SenseVoice）", kind: "local", configured: true, models: [{ provider: "local-sensevoice", id: "sensevoice-small-int8", name: "SenseVoice", type: "asr", capabilities: ["asr"], confirmed: true, inferred: [], source: "runtime", configured: true, asrAdapter: { protocol: "local-asr-http", location: "local" } }] };
const LAYA = { id: "local-laya", name: "本地快速操作模型（Laya）", kind: "local", configured: true, models: [{ provider: "local-laya", id: "multilingual", name: "multilingual", type: "classifier", capabilities: ["classifier"], confirmed: true, inferred: [], source: "runtime", configured: true }] };

const SENSEVOICE_STATUS = {
	platform: { os: "darwin", arch: "arm64", support: "supported" },
	license: {
		licenseName: "FunASR Model Open Source License Agreement", termsVersion: "1.1", decision: "unresolved", redistribution: false,
		attribution: "SenseVoiceSmall by FunASR / FunAudioLLM",
		links: { modelCard: "https://huggingface.co/FunAudioLLM/SenseVoiceSmall", modelLicense: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE", issue: "https://github.com/QwenAudio/SenseVoice/issues/334", engineLicense: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE" },
		restrictions: ["使用 / 复制 / 修改 / 分享须署名来源与作者并保留模型名（§2.2）", "条款写「for reference and learning purposes only」（§3），适用范围未由许可方最终确认"],
		reason: "权重许可为 FunASR MODEL_LICENSE v1.1（非 Apache）；适用范围未最终确认，故不随 App 分发、安装入口默认关闭",
		acceptValue: "1.1",
	},
	install: { state: "not_installed", phase: "idle", received: 0, total: null, error: null, source: null },
	runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1", lastError: null },
	configured: false, registered: null,
	source: { project: "SenseVoiceSmall", repoUrl: "https://github.com/FunAudioLLM/SenseVoice", weightsRepo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", weightsRevision: "2365baeacb507f821a0c8120fcee3d484dba7a07", weightsLicense: "FunASR Model Open Source License Agreement v1.1", note: "许可按 FunASR MODEL_LICENSE v1.1" },
	model: { id: "sensevoice-small-int8", bytes: 239_549_735, sampleRate: 16000, channels: 1, languages: ["zh", "en"], punctuation: true },
	notes: ["本机未实测：冷启动 / RTF / 峰值内存均无本机数据，不给性能承诺"],
};
/** 本地多模型 catalog（与后端 LocalAsrCatalog 同形）；settings 页只用它验证统一选择器渲染。 */
const ASR_LICENSE = (over = {}) => ({ licenseName: "x", termsVersion: "x", decision: "cleared", selfServe: true, redistribution: true, attribution: "x", links: { modelCard: "https://x", modelLicense: "https://x", issue: "", engineLicense: "https://x" }, restrictions: [], reason: "", agreementRequired: false, acceptValue: "x", ...over });
const mkAsrModel = (over) => ({
	family: "paraformer",
	variant: "int8",
	nameEn: over.id,
	languages: ["zh"],
	note: "n",
	tier: "light",
	tags: ["light"],
	recommended: false,
	recommendationReason: "",
	available: true,
	unavailableReason: null,
	weightsBytes: 243_446_974,
	depsBytes: null,
	depsNote: "另需运行环境",
	suggestedMemoryBytes: 900 * 1024 ** 2,
	memoryNote: "估算（非实测）",
	capabilities: ["中文"],
	multilingual: false,
	license: ASR_LICENSE(),
	source: { source: { project: "p", repoUrl: "https://x", weightsRepo: "x/y", weightsRevision: "a".repeat(40), weightsLicense: "x", engineLicense: "Apache-2.0", engineVersion: "1.13.8", note: "" }, model: { id: over.id, repo: "x/y", revision: "a".repeat(40), files: [{ path: "model.int8.onnx", size: 1, sha256: "a".repeat(64) }] } },
	installed: false,
	selected: false,
	running: false,
	install: { state: "not_installed", phase: null, phaseLabel: null, received: 0, total: null, percent: null, error: null, installedAt: null, source: null, jobId: null, attempt: null },
	runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1", restarts: 0, lastError: null, healthOk: false, loaded: false },
	...over,
});
const ASR_CATALOG_FIXTURE = {
	hardware: { os: "darwin", arch: "arm64", cpuCores: 10, memoryBytes: 16 * 1024 ** 3, tier: "balanced", tierNote: "系统内存约 16.0GB，按 16GB 档保守估计（估算，未实测；未跑 benchmark）" },
	runtime: { engine: "sherpa-onnx", version: "1.13.8", python: "3.12", depsBytes: null, depsNote: "共享运行环境估算约 0.2GB；未在本机实测" },
	recommendedId: "paraformer-zh-2023-09-14-int8",
	notes: ["内存 / 档位均为估算，未在本机跑 benchmark"],
	models: [
		mkAsrModel({ id: "paraformer-zh-2023-09-14-int8", provider: "local-paraformer", name: "Paraformer 中文（本地）", recommended: true, recommendationReason: "推荐", capabilities: ["中文", "无标点"] }),
		mkAsrModel({
			id: "sensevoice-small-int8",
			provider: "local-sensevoice",
			family: "sensevoice",
			name: "SenseVoice Small（本地）",
			languages: ["zh", "en", "ja", "ko", "yue"],
			capabilities: ["标点", "中英粤日韩"],
			multilingual: true,
			tier: "balanced",
			tags: ["balanced"],
			weightsBytes: 239_549_735,
			suggestedMemoryBytes: 1100 * 1024 ** 2,
			note: "本地个人自用可从官方源一键下载安装",
			license: ASR_LICENSE({ licenseName: "FunASR Model Open Source License Agreement v1.1", termsVersion: "1.1", decision: "unresolved", selfServe: true, redistribution: false, attribution: "SenseVoiceSmall by FunASR / FunAudioLLM", links: { modelCard: "https://huggingface.co/FunAudioLLM/SenseVoiceSmall", modelLicense: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE", issue: "https://github.com/QwenAudio/SenseVoice/issues/334", engineLicense: "https://github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE" }, restrictions: ["使用 / 复制 / 修改 / 分享须署名来源与作者并保留模型名（§2.2）", "本地按需下载仅限个人自用；不随 App 分发、不镜像、不代分发", "条款写「for reference and learning purposes only」（§3）；商用 / 再分发未由许可方最终确认（issue #334 仍 open）"], reason: "FunASR MODEL_LICENSE v1.1：本地个人自用可下载；不随 App 分发；商用未确认", acceptValue: "1.1" }),
		}),
	],
};

const LAYA_STATUS = { platform: { key: "darwin-arm64", os: "darwin", arch: "arm64", accelerator: "cpu", support: "supported", torchBackend: "cpu", pins: [], reason: "" }, install: { state: "not_installed", phase: "idle", received: 0, total: null, error: null, installedAt: null }, runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1" }, health: null, configured: false, registered: null, source: { project: "Laya", repoUrl: "https://github.com/", weightsOrg: "convaiinnovations", codeLicense: "Apache-2.0", weightsLicense: "Apache-2.0", version: "0.4.8", reviewedRevisions: {} } };

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};

async function countGum(ctx) {
	await ctx.addInitScript(() => {
		window.__gum = 0;
		const md = navigator.mediaDevices;
		if (!md) return;
		const orig = md.getUserMedia.bind(md);
		md.getUserMedia = (...a) => {
			window.__gum = (window.__gum ?? 0) + 1;
			return orig(...a);
		};
	});
}

async function installRoutes(context, state) {
	await context.route("**/api/**", async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT("a1", "助理A"), AGENT("a2", "助理B")]);
		if (p === "/api/rooms") return json([]);
		if (p === "/api/channels") return json({ items: [], publicUrl: null });
		if (p === "/api/wechat") return json({ enabled: false, acknowledgedAt: null, agentIds: [] });
		if (p === "/api/downloads") return json({ items: [] });
		if (p.startsWith("/api/proactive/inbox")) return json({ items: [], count: 0, defaultLevel: "normal" });
		if (p === "/api/devices") return json([]);
		if (p === "/api/remote/cloudflare") return json({ configured: false, hasToken: false, config: null });
		if (p === "/api/models/providers") return json([]);
		if (p === "/api/models/custom") return json({ providers: [], apis: [], classifierProtocols: [] });
		if (p === "/api/image-models/providers") return json({ providers: [], models: [], default: null });
		if (p === "/api/image-models") return json({ kinds: [], providers: [], models: [], default: null, reusable: [] });
		if (p === "/api/models/registry") return json({ providers: [CLOUD_ASR, LOCAL_ASR, LAYA] });
		if (p === "/api/models") return json([]);
		if (p === "/api/model-strengths") return json({ labels: [], models: [] });
		if (p === "/api/fast-computer/settings") return json({ settings: { enabled: false, kind: "systemone", provider: "", id: "", baseUrl: "", model: "", threshold: 0.5, timeoutMs: 3000 }, classifierModels: [] });
		if (p === "/api/fast-computer/benchmark") return json({ availability: { available: false, reason: "未启用" }, runs: [] });
		if (p === "/api/host-control") return json({ settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } });
		if (p.startsWith("/api/usage/summary")) return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
		if (p === "/api/memory/providers") return json({ global: "basic", providers: [] });
		if (p === "/api/skill-suggest") return json({ enabled: false });
		if (p === "/api/settings") return json({});
		if (p === "/api/audio/asr/config") return json({ maxDurationMs: 60000, maxBytes: 5242880, protocol: "openai-audio-transcriptions" });
		if (p === "/api/audio/asr/providers") return json({ protocols: ["openai-audio-transcriptions", "local-asr-http"], providers: [] });
		if (p === "/api/audio/asr/source") {
			const opts = [];
			if (state.cloudOption) opts.push({ location: "cloud", provider: "openai", model: "whisper-1", name: "OpenAI / whisper-1", protocol: "openai-audio-transcriptions", availability: "ready", reason: null, selected: state.source?.location === "cloud" && state.source?.provider === "openai" && state.source?.model === "whisper-1" });
			opts.push({ location: "local", provider: "local-sensevoice", model: "sensevoice-small-int8", name: "本地语音识别（SenseVoice）", protocol: "local-asr-http", availability: "not_installed", reason: "本地语音识别未安装", selected: state.source?.location === "local" });
			if (req.method() === "PUT") {
				if (state.putFails) return json({ error: "asr_not_configured", message: "模拟保存失败" }, 400);
				state.source = JSON.parse(req.postData() ?? "{}").source ?? null;
			}
			return json({ source: state.source ?? null, options: opts });
		}
		if (p === "/api/local-models/asr/catalog") return json({ ...ASR_CATALOG_FIXTURE, models: ASR_CATALOG_FIXTURE.models.map((m) => ({ ...m, installed: false, selected: state.source?.location === "local" && state.source?.model === m.id, running: false })) });
		if (p === "/api/local-models/asr/sensevoice/status") return json(SENSEVOICE_STATUS);
		if (p === "/api/local-models/laya/status") return json(LAYA_STATUS);
		if (p === "/api/agents/a1/computer" || p === "/api/agents/a2/computer") return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		const msgMatch = p.match(/^\/api\/agents\/(a\d)\/messages$/);
		if (msgMatch) return json(MSGS[msgMatch[1]] ?? []);
		const convMatch = p.match(/^\/api\/agents\/(a\d)\/conversations$/);
		if (convMatch && req.method() === "GET") return json({ current: "c1", items: [{ id: "c1", agent_id: convMatch[1], title: "对话", created_at: now, updated_at: now, message_count: 1, last: "。" }] });
		if (/^\/api\/agents\/a\d\/tasks$/.test(p)) return json([]);
		if (/^\/api\/agents\/a\d\/subagent-model$/.test(p)) return json({ pool: [] });
		if (/^\/api\/agents\/a\d\/subagent-thinking$/.test(p)) return json({ mode: "follow" });
		if (/^\/api\/agents\/a\d\/subagents\/settings$/.test(p)) return json({ settings: { maxConcurrent: 10, maxMinutes: 60 }, overrides: {}, defaults: { maxConcurrent: 10, maxMinutes: 60 } });
		if (p.startsWith("/api/subagents")) return json([]);
		if (p.endsWith("/read")) return json({});
		return json({});
	});
}

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
	const state = { cloudOption: true, source: null, putFails: false };
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", permissions: ["microphone"] });
	await installRoutes(ctx, state);
	await countGum(ctx);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.error("  ⚠️ pageerror", String(e.stack ?? e).slice(0, 600)));
	page.setDefaultTimeout(15_000);

	console.log("\n── 导航：17 项 / 5 组 / 别名 / entry + downloads 仍可达 ──");
	await page.goto(`${base}/?settings=models`);
	await page.getByTestId("settings-nav").waitFor();
	const tabs = await page.getByTestId("settings-nav").locator("button[data-tab]").evaluateAll((bs) => bs.map((b) => b.dataset.tab));
	check(`导航 17 项且包含 voice / chat`, tabs.length === 17 && tabs.includes("voice") && tabs.includes("chat"), JSON.stringify(tabs));
	check("导航含 entry 与 downloads", tabs.includes("entry") && tabs.includes("downloads"));
	const groups = await page.getByTestId("settings-nav").locator("[data-settings-group]").evaluateAll((bs) => bs.map((b) => b.dataset.settingsGroup));
	check("5 个分组标题（模型与语音 / 电脑 / 助理能力 / 连接 / 偏好与系统）", groups.length === 5, JSON.stringify(groups));
	await page.getByTestId("model-services").waitFor();
	await page.screenshot({ path: join(OUT, "01-nav-models.png") });
	// 别名 ?settings=model
	await page.goto(`${base}/?settings=model`);
	await page.getByTestId("model-services").waitFor();
	check("?settings=model 别名指向模型服务", (await page.getByTestId("settings-nav").locator("button[data-tab=models]").getAttribute("aria-current")) === "page");
	// entry / downloads 仍可达
	await page.goto(`${base}/?settings=entry`);
	await page.getByTestId("named-tunnel").waitFor();
	check("?settings=entry 仍打开固定地址页", await page.getByTestId("named-tunnel").isVisible());
	await page.goto(`${base}/?settings=downloads`);
	await page.getByTestId("settings-content").getByText("下载与组件").first().waitFor();
	check("?settings=downloads 仍打开下载页", true);
	// 390 不横向溢出
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${base}/?settings=models`);
	await page.getByTestId("model-services").waitFor();
	const ov = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: innerWidth, c: (() => { const c = document.querySelector("[data-testid=settings-content]"); return c.scrollWidth - c.clientWidth; })() }));
	check("390：页面与内容区不横向溢出", ov.doc <= ov.vw && ov.c <= 1, JSON.stringify(ov));
	await page.screenshot({ path: join(OUT, "02-nav-390.png") });
	await page.setViewportSize({ width: 1440, height: 900 });

	console.log("\n── 模型页瘦身：无 Laya / SenseVoice / 子代理；ASR 只声明 ──");
	await page.goto(`${base}/?settings=models`);
	await page.getByTestId("model-services").waitFor();
	check("模型页不再有 Laya 卡", (await page.getByTestId("local-laya-card").count()) === 0);
	check("模型页不再有 SenseVoice 卡", (await page.getByTestId("local-sensevoice-card").count()) === 0);
	check("模型页不再有子代理折叠区", (await page.getByTestId("subagent-section").count()) === 0 && (await page.getByTestId("subagent-concurrency").count()) === 0);
	check("模型页不含每助理任务上限", (await page.getByTestId("agent-subagent-limits").count()) === 0);
	const modelsText = (await page.getByTestId("settings-content").textContent()) ?? "";
	check("模型页不再有「当前：」重复行", !modelsText.includes("当前："), modelsText.slice(0, 200));
	check("模型页常规 footer 已收进 Help（不在正文）", !modelsText.includes("生图与快速操作模型统一在这里"));
	await page.getByTestId("service-toggle-openai").click();
	await page.getByTestId("asr-adapter-section-openai").waitFor();
	const asrText = (await page.getByTestId("asr-adapter-section-openai").textContent()) ?? "";
	check("ASR 区块标明「声明」", asrText.includes("声明"));
	await page.screenshot({ path: join(OUT, "03-model-slim.png") });

	console.log("\n── 电脑 › 操作这台电脑：快速操作模型 / Laya 入口已撤下 ──");
	await page.goto(`${base}/?settings=host`);
	await page.getByTestId("settings-dialog").waitFor();
	check("电脑设置里不再有本地 Laya 卡", (await page.getByTestId("host-local-laya").count()) === 0);
	check("电脑设置里不再有快速操作模型区块", (await page.getByTestId("host-fast-computer").count()) === 0);
	await page.screenshot({ path: join(OUT, "03b-host-no-fast.png") });

	console.log("\n── 语音配置：云空态 / 选择保存 / 失败回滚 / 无第二套 Key ──");
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	check("语音页没有密码框（不新建第二套 Key）", (await page.locator("input[type=password]").count()) === 0);
	check("初始未配置", ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("未配置"));
	check("打开语音页 0 次 getUserMedia", (await page.evaluate(() => window.__gum ?? 0)) === 0);
	// 选择云模型并保存
	await page.getByTestId("voice-cloud-select").click();
	await page.getByTestId("voice-cloud-select-menu").getByRole("option").first().click();
	await page.getByTestId("voice-cloud-save").click();
	await page.waitForFunction(() => true);
	await page.waitForTimeout(200);
	check("保存后写入 source（cloud · whisper-1）", state.source?.location === "cloud" && state.source?.model === "whisper-1", JSON.stringify(state.source));
	check("状态显示当前云端模型", ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("whisper-1"));
	check("已选云端时显示隐私提醒", await page.getByTestId("voice-cloud-privacy").isVisible());
	await page.screenshot({ path: join(OUT, "04-voice-cloud.png") });
	// 刷新后仍在
	await page.reload();
	await page.getByTestId("voice-source-status").waitFor();
	await page.waitForFunction(() => (document.querySelector('[data-testid="voice-source-status"]')?.textContent ?? "").includes("whisper-1"), null, { timeout: 10_000 });
	check("刷新后仍是云端 whisper-1", ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("whisper-1"));
	// 保存失败回滚
	state.source = null;
	state.putFails = true;
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	await page.getByTestId("voice-cloud-select").click();
	await page.getByTestId("voice-cloud-select-menu").getByRole("option").first().click();
	await page.getByTestId("voice-cloud-save").click();
	await page.getByTestId("voice-save-error").waitFor();
	check("保存失败显示错误", (await page.getByTestId("voice-save-error").isVisible()));
	check("保存失败已回滚（仍是未配置）", state.source === null && ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("未配置"));
	state.putFails = false;
	await page.screenshot({ path: join(OUT, "05-voice-rollback.png") });

	console.log("\n── 语音配置：云空态 → 去模型服务 ──");
	state.cloudOption = false;
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-cloud-empty").waitFor();
	check("云空态可见 + 添加入口", (await page.getByTestId("voice-cloud-empty").isVisible()) && (await page.getByTestId("voice-cloud-go-models").isVisible()));
	await page.getByTestId("voice-cloud-go-models").click();
	await page.getByTestId("settings-nav").locator("button[data-tab=models]").waitFor();
	check("点「添加在线服务」跳到模型服务页", (await page.getByTestId("settings-nav").locator("button[data-tab=models]").getAttribute("aria-current")) === "page");
	state.cloudOption = true;

	console.log("\n── 语音配置：本地多模型（含 SenseVoice 一键） + 详情里的合法导入 ──");
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("local-asr-models").waitFor();
	check("本地段是统一多模型选择器（旧 SenseVoice 卡已移除）", (await page.getByTestId("local-asr-models").isVisible()) && (await page.getByTestId("local-sensevoice-card").count()) === 0);
	check("不再有第二套「使用已导入的 SenseVoice」按钮", (await page.getByTestId("voice-local-use").count()) === 0);
	// 选中 SenseVoice：许可标「本地自用可下载」、按钮可用、无强制勾选框
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /SenseVoice/ }).click();
	const licText = (await page.getByTestId("local-asr-license").textContent()) ?? "";
	check("SenseVoice 许可标「本地自用可下载」（不是「暂不提供下载」）", licText.includes("本地自用可下载") && !licText.includes("暂不提供下载"), licText);
	check("许可未确认时不显示永远不能勾选的同意复选框", (await page.getByTestId("local-asr-accept").count()) === 0);
	check("SenseVoice 一键安装按钮可用", !(await page.getByTestId("local-asr-install-use").isDisabled()));
	check("默认不出现长规格 / 详情", (await page.getByTestId("local-asr-details").count()) === 0);
	// 默认（紧凑）状态截图：主看新图用这个
	await page.screenshot({ path: join(OUT, "06-voice-local.png") });
	// 详情里保留合法导入（不占主流程）
	await page.getByTestId("local-asr-details-toggle").click();
	await page.getByTestId("local-asr-import-toggle").click();
	check("详情里目录输入 / 导入动作可访问（保留合法导入）", (await page.getByTestId("local-asr-import-dir").isVisible()) && (await page.getByTestId("local-asr-import-btn").isVisible()));
	const detail = (await page.getByTestId("local-asr-details").textContent()) ?? "";
	check("详情展开可看来源 / 引擎 / 未实测说明", detail.includes("sherpa-onnx") && detail.includes("未在本机实测"), detail);
	await page.screenshot({ path: join(OUT, "06b-voice-local-expanded.png") });
	// license 关键不可藏：完整条款与链接放在「?」里
	await page.getByTestId("local-asr-license").getByTestId("help").hover();
	await page.getByTestId("help-pop").waitFor();
	const popText = (await page.getByTestId("help-pop").textContent()) ?? "";
	check("完整许可条款（署名 / 链接）在「?」里", popText.includes("署名") && popText.includes("FunASR") && ((await page.getByTestId("help-pop").getByTestId("local-asr-license-link").getAttribute("href")) ?? "").startsWith("https://"), popText);
	await page.keyboard.press("Escape");
	await page.waitForTimeout(100);

	console.log("\n── Help：Tab 聚焦打开 / Escape 只关气泡 ──");
	const help = page.locator('[data-testid="settings-content"] [data-testid="help"]').first();
	await help.focus();
	await page.getByTestId("help-pop").waitFor();
	check("聚焦即打开（键盘可访问）", await page.getByTestId("help-pop").isVisible());
	await page.keyboard.press("Escape");
	await page.waitForTimeout(150);
	check("Escape 关闭气泡", (await page.getByTestId("help-pop").count()) === 0);
	check("Escape 不关闭设置弹窗", await page.getByTestId("settings-dialog").isVisible());
	// Escape 后焦点仍在按钮上，但不立刻重开（要等下一次真正聚焦 / 悬停）
	await page.waitForTimeout(250);
	check("Escape 后不自动重开", (await page.getByTestId("help-pop").count()) === 0);
	// 悬停打开
	await help.hover();
	await page.getByTestId("help-pop").waitFor();
	check("悬停打开 Help", await page.getByTestId("help-pop").isVisible());
	await page.keyboard.press("Escape");
	// 触摸：390 手机上下文 tap 打开，气泡不越出视口（tooltip clamp）
	const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "zh-CN" });
	await installRoutes(mctx, state);
	await countGum(mctx);
	const mp = await mctx.newPage();
	mp.setDefaultTimeout(15_000);
	await mp.goto(`${base}/?settings=voice`);
	await mp.getByTestId("settings-content").waitFor();
	const mhelp = mp.locator('[data-testid="settings-content"] [data-testid="help"]').first();
	// 触摸 / 点击路径：直接派发 click（touch 浏览器首点不会先 hover，避免鼠标 hover 与 click 互相抵消）
	await mhelp.evaluate((el) => el.click());
	await mp.getByTestId("help-pop").waitFor();
	const box = await mp.getByTestId("help-pop").boundingBox();
	check("触摸 tap 打开 Help", !!box && (await mp.getByTestId("help-pop").isVisible()));
	check("390 窄屏 Help 不越出视口", !!box && box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box));
	await mp.keyboard.press("Escape");
	await mp.waitForTimeout(150);
	check("移动端 Escape 关气泡不关设置窗", (await mp.getByTestId("help-pop").count()) === 0 && (await mp.getByTestId("settings-dialog").isVisible()));
	await mctx.close();

	console.log("\n── 语音入口：idle 干净 / 去设置跳语音配置 / 切助理清提示 ──");
	state.source = null;
	await page.goto(`${base}/?agent=a1`);
	await page.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });
	await page.getByTestId("voice-mic").waitFor();
	check("未配置 idle 不常驻状态行 / 去设置", (await page.getByTestId("voice-status").count()) === 0 && (await page.getByTestId("voice-open-settings").count()) === 0);
	await page.getByTestId("voice-mic").click();
	await page.getByTestId("voice-open-settings").waitFor();
	check("点麦克风提示去设置（0 次 getUserMedia）", (await page.evaluate(() => window.__gum ?? 0)) === 0);
	await page.getByTestId("voice-open-settings").click();
	await page.getByTestId("voice-source-status").waitFor();
	check("「去设置」打开「语音配置」", (await page.getByTestId("settings-nav").locator("button[data-tab=voice]").getAttribute("aria-current")) === "page");
	check("点「去设置」后链接真的消失", (await page.getByTestId("voice-open-settings").count()) === 0 && (await page.getByTestId("voice-status").count()) === 0);
	await page.keyboard.press("Escape");
	await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
	// 切助理：临时提示不跟到新对话
	await page.getByTestId("voice-mic").click();
	await page.getByTestId("voice-open-settings").waitFor();
	await page.getByTestId("sidebar-agent").filter({ hasText: "助理B" }).first().click();
	await page.locator('[data-mid="a2m"]').waitFor({ timeout: 20_000 });
	await page.waitForTimeout(300);
	check("切助理后不再有临时提示 / 去设置", (await page.getByTestId("voice-open-settings").count()) === 0 && (await page.getByTestId("voice-status").count()) === 0);
	await page.screenshot({ path: join(OUT, "07-voice-entry.png") });
} catch (e) {
	console.error("运行失败：", e);
	failed++;
} finally {
	await browser?.close().catch(() => {});
	web.close();
}
console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌  截图：${OUT}`);
process.exit(failed === 0 ? 0 : 1);
