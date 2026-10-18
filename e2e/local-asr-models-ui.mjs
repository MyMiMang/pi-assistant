/**
 * 本地语音「多模型选择器」纯前端验证：静态托管 apps/web/dist + page.route 拦所有 /api。
 *
 * 真实前端代码 + 真实 fixture（catalog 由服务端返回，前端不 hardcode）；不碰真实麦克风 / 服务端 / 云 / 真下载。
 * fixture 与 backendowner 的 `local-asr-multi-model` LocalAsrCatalog DTO 同形（tier / capabilities / 嵌套 source /
 * install_and_use / selected），验证 UI 渲染与 intent 行为（契约见 docs/design/local-asr-model-catalog.md）。
 *
 * 覆盖：
 *  1) 选择器列出服务端返回的 5 个模型（名称 / 推荐档位 / 权重体积 / 内存建议「估算，未实测」/ 许可）。
 *  2) 能力标签来自 catalog：Whisper 显示「原生输出（含标点…）」，Paraformer 显示自己的「无标点」，不互相套用。
 *  3) 「安装并使用」：install { intent:"install_and_use", acceptLicense }；total 未知画不确定进度条；
 *     装完服务端写来源 → selected → UI 显示使用中（前端不自己 late PUT）。
 *  4) stale intent：安装中改选云端并保存 → 装完不 late 覆盖；来源保持云端、不显示使用中。
 *  5) 取消：进行中可取消，进度消失、不写来源。
 *  6) 失败：显示可读原因 + 「重试安装并使用」。
 *  7) 390 窄屏不横向溢出 + 截图。
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
const OUT = artifactDir("local-asr-models-ui");
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
const MSGS = { a1: [mkMsg({ id: "a1m", content: "好的。" })] };

const CLOUD_ASR = { id: "openai", name: "OpenAI", kind: "custom", configured: true, models: [{ provider: "openai", id: "whisper-1", name: "whisper-1", type: "asr", capabilities: ["asr"], confirmed: true, inferred: [], source: "custom", configured: true, asrAdapter: { protocol: "openai-audio-transcriptions", location: "cloud" } }] };
const LOCAL_ASR = { id: "local-sensevoice", name: "本地语音识别（SenseVoice）", kind: "local", configured: true, models: [{ provider: "local-sensevoice", id: "sensevoice-small-int8", name: "SenseVoice", type: "asr", capabilities: ["asr"], confirmed: true, inferred: [], source: "runtime", configured: true, asrAdapter: { protocol: "local-asr-http", location: "local" } }] };
const SENSEVOICE_STATUS = {
	platform: { os: "darwin", arch: "arm64", support: "supported" },
	license: { licenseName: "FunASR Model Open Source License Agreement", termsVersion: "1.1", decision: "unresolved", redistribution: false, attribution: "SenseVoiceSmall", links: { modelCard: "https://x/card", modelLicense: "https://x/lic", issue: "https://x/issue", engineLicense: "https://x/engine" }, restrictions: [], reason: "适用范围未最终确认", acceptValue: "1.1" },
	install: { state: "not_installed", phase: "idle", received: 0, total: null, error: null, source: null },
	runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1", lastError: null },
	configured: false, registered: null,
	source: { project: "SenseVoiceSmall", repoUrl: "https://x/git", weightsRepo: "x/y", weightsRevision: "abc", weightsLicense: "FunASR", note: "" },
	model: { id: "sensevoice-small-int8", bytes: 239_549_735, sampleRate: 16000, channels: 1, languages: ["zh", "en"], punctuation: true },
	notes: [],
};

const CLEARED_LICENSE = (licenseName, termsVersion) => ({ licenseName, termsVersion, decision: "cleared", selfServe: true, redistribution: true, attribution: "fixture", links: { modelCard: "https://x/card", modelLicense: "https://x/lic", issue: "", engineLicense: "https://x/engine" }, restrictions: [], reason: "", agreementRequired: false, acceptValue: termsVersion });
/** SenseVoice：整体 unresolved（商用 / 再分发未确认），但**本地自用下载放行**（selfServe=true）；上游未要求点击同意。 */
const SENSEVOICE_LICENSE_FIXTURE = {
	licenseName: "FunASR Model Open Source License Agreement v1.1",
	termsVersion: "1.1",
	decision: "unresolved",
	selfServe: true,
	redistribution: false,
	attribution: "SenseVoiceSmall by FunASR / FunAudioLLM",
	links: { modelCard: "https://x/card", modelLicense: "https://x/lic", issue: "https://x/issue", engineLicense: "https://x/engine" },
	restrictions: ["使用 / 复制 / 修改 / 分享须署名来源与作者并保留模型名（§2.2）", "本地按需下载仅限个人自用；不随 App 分发、不镜像、不代分发", "条款写「for reference and learning purposes only」（§3）；商用 / 再分发未由许可方最终确认（issue #334 仍 open）"],
	reason: "FunASR MODEL_LICENSE v1.1：本地个人自用可下载；不随 App 分发；商用与再分发未确认",
	agreementRequired: false,
	acceptValue: "1.1",
};

/** 与 backend `LocalAsrModelView` 同形的 fixture；id / provider 用后端真实命名。 */
const mkModel = (id, provider, name, tier, weights, mem, extra = {}) => ({
	id,
	provider,
	family: provider === "local-paraformer" ? "paraformer" : "whisper",
	variant: "int8",
	name,
	nameEn: id,
	languages: ["zh", "en"],
	note: "fixture 说明",
	tier,
	tags: [tier],
	recommended: false,
	recommendationReason: "",
	available: true,
	unavailableReason: null,
	weightsBytes: weights,
	depsBytes: null,
	depsNote: "另需下载共享运行环境（sherpa-onnx 引擎 + venv/cache，估算约 0.2GB）；未在本机实测",
	suggestedMemoryBytes: mem,
	memoryNote: "模型进程内存估算（非实测）；整机内存建议见硬件档位",
	capabilities: ["多语"],
	multilingual: true,
	license: CLEARED_LICENSE("MIT License (OpenAI Whisper)", "MIT"),
	source: { source: { project: "fixture · sherpa-onnx 转换", repoUrl: "https://x/git", weightsRepo: "x/y", weightsRevision: "rev1234567890", weightsLicense: "MIT", engineLicense: "Apache-2.0", engineVersion: "1.13.8", note: "" }, model: { id, repo: "x/y", revision: "rev1234567890", files: [{ path: "model.int8.onnx", size: weights, sha256: "a".repeat(64) }] } },
	installed: false,
	selected: false,
	running: false,
	install: { state: "not_installed", phase: null, phaseLabel: null, received: 0, total: null, percent: null, error: null, installedAt: null, source: null, jobId: null, attempt: null },
	runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1", restarts: 0, lastError: null, healthOk: false, loaded: false },
	...extra,
});

const initialModels = () => [
	mkModel("paraformer-zh-2023-09-14-int8", "local-paraformer", "Paraformer 中文（本地）", "light", 243_446_974, 900 * 1024 ** 2, { capabilities: ["中文", "中英混说", "无标点"], multilingual: false, languages: ["zh", "en"], license: CLEARED_LICENSE("Apache License 2.0", "Apache-2.0") }),
	mkModel("whisper-base-int8", "local-whisper", "Whisper Base（本地）", "light", 161_608_560, 900 * 1024 ** 2, { capabilities: ["多语", "原生输出（含标点 / 大小写）"], languages: ["zh", "en", "ja"] }),
	mkModel("whisper-small-int8", "local-whisper", "Whisper Small（本地）", "balanced", 375_485_327, 1500 * 1024 ** 2, { recommended: true, recommendationReason: "你这台机器推荐它：多语均衡档", capabilities: ["多语", "原生输出（含标点 / 大小写）"], languages: ["zh", "en", "ja"] }),
	mkModel("whisper-turbo-int8", "local-whisper", "Whisper Turbo（本地）", "high", 1_036_613_791, 2000 * 1024 ** 2, { capabilities: ["多语", "原生输出（含标点 / 大小写）"], languages: ["zh", "en"] }),
	mkModel("whisper-large-v3-int8", "local-whisper", "Whisper Large v3（本地）", "high", 1_775_753_918, 2800 * 1024 ** 2, { capabilities: ["多语", "原生输出（含标点 / 大小写）"], languages: ["zh", "en", "ja", "ko"] }),
	mkModel("sensevoice-small-int8", "local-sensevoice", "SenseVoice Small（本地）", "balanced", 239_549_735, 1100 * 1024 ** 2, { family: "sensevoice", capabilities: ["标点", "中英粤日韩"], multilingual: true, languages: ["zh", "yue", "en", "ja", "ko"], note: "中英粤日韩；本地个人自用可从官方源一键下载安装，不随 App 分发", license: SENSEVOICE_LICENSE_FIXTURE }),
];

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};

const state = { models: initialModels(), source: null, cloudOption: true, putLog: [], installLog: [], cancelLog: [], selectLog: [] };

async function installRoutes(context, st) {
	await context.route("**/api/**", async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT("a1", "助理A")]);
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
		if (p === "/api/models/registry") return json({ providers: [CLOUD_ASR, LOCAL_ASR] });
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

		// 本地多模型 catalog（真实新接口；selected 由当前来源算出，和后端一致）
		if (p === "/api/local-models/asr/catalog") {
			const sel = st.source;
			return json({
				hardware: { os: "darwin", arch: "arm64", cpuCores: 10, memoryBytes: 16 * 1024 ** 3, tier: "balanced", tierNote: "系统内存约 16.0GB，按 16GB 档保守估计（估算，未实测；未跑 benchmark）" },
				runtime: { engine: "sherpa-onnx", version: "1.13.8", python: "3.11", depsBytes: null, depsNote: "共享运行环境估算约 0.2GB；未在本机实测" },
				recommendedId: "whisper-small-int8",
				models: st.models.map((m) => ({ ...m, installed: m.install.state === "installed", selected: !!sel && sel.location === "local" && sel.provider === m.provider && sel.model === m.id, running: m.install.state === "installed" })),
				notes: ["内存 / 档位均为估算，未在本机跑 benchmark", "一次只运行一个本地语音模型"],
			});
		}
		const installMatch = p.match(/^\/api\/local-models\/asr\/models\/([^/]+)\/install$/);
		if (installMatch) {
			const id = decodeURIComponent(installMatch[1]);
			st.installLog.push({ id, body: JSON.parse(req.postData() ?? "{}") });
			const m = st.models.find((x) => x.id === id);
			if (m) m.install = { state: "installing", phase: "weights", phaseLabel: "下载 / 导入权重", received: 0, total: null, percent: null, error: null, installedAt: null, source: "download", jobId: `asr:${id}`, attempt: 1 };
			return json({ ok: true });
		}
		const cancelMatch = p.match(/^\/api\/local-models\/asr\/models\/([^/]+)\/cancel$/);
		if (cancelMatch) {
			const id = decodeURIComponent(cancelMatch[1]);
			st.cancelLog.push({ id });
			const m = st.models.find((x) => x.id === id);
			if (m) m.install = { state: "not_installed", phase: null, phaseLabel: null, received: 0, total: null, percent: null, error: null, installedAt: null, source: null, jobId: null, attempt: null };
			return json({ ok: true });
		}
		const statusMatch = p.match(/^\/api\/local-models\/asr\/models\/([^/]+)\/status$/);
		if (statusMatch) {
			const m = st.models.find((x) => x.id === decodeURIComponent(statusMatch[1]));
			return json(m ?? null);
		}
		const selectMatch = p.match(/^\/api\/local-models\/asr\/models\/([^/]+)\/select$/);
		if (selectMatch) {
			const id = decodeURIComponent(selectMatch[1]);
			st.selectLog.push({ id });
			const m = st.models.find((x) => x.id === id);
			if (!m || m.install.state !== "installed") return json({ ok: false, error: "该模型还没安装完成" }, 400);
			// 与后端一致：select 写来源（selection.write）+ 启停 worker
			st.source = { location: "local", provider: m.provider, model: m.id };
			return json({ ok: true });
		}
		if (/^\/api\/local-models\/asr\/models\/[^/]+$/.test(p) && req.method() === "DELETE") return json({ ok: true });
		if (p === "/api/local-models/asr/sensevoice/status") return json(SENSEVOICE_STATUS);

		if (p === "/api/audio/asr/source") {
			const opts = [];
			if (st.cloudOption) opts.push({ location: "cloud", provider: "openai", model: "whisper-1", name: "OpenAI / whisper-1", protocol: "openai-audio-transcriptions", availability: "ready", reason: null, selected: st.source?.location === "cloud" });
			opts.push({ location: "local", provider: "local-sensevoice", model: "sensevoice-small-int8", name: "本地语音识别（SenseVoice）", protocol: "local-asr-http", availability: "not_installed", reason: "本地语音识别未安装", selected: false });
			for (const m of st.models) {
				if (m.install.state !== "installed") continue;
				opts.push({ location: "local", provider: m.provider, model: m.id, name: m.name, protocol: "local-asr-http", availability: "ready", reason: null, selected: st.source?.location === "local" && st.source?.model === m.id });
			}
			if (req.method() === "PUT") {
				st.source = JSON.parse(req.postData() ?? "{}").source ?? null;
				st.putLog.push(st.source);
			}
			return json({ source: st.source ?? null, options: opts });
		}

		if (p === "/api/agents/a1/computer") return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		if (/^\/api\/agents\/a\d\/messages$/.test(p)) return json(MSGS.a1);
		if (/^\/api\/agents\/a\d\/conversations$/.test(p) && req.method() === "GET") return json({ current: "c1", items: [{ id: "c1", agent_id: "a1", title: "对话", created_at: now, updated_at: now, message_count: 1, last: "。" }] });
		if (/^\/api\/agents\/a\d\/tasks$/.test(p)) return json([]);
		if (p.startsWith("/api/subagents")) return json([]);
		return json({});
	});
}

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	await installRoutes(ctx, state);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.error("  ⚠️ pageerror", String(e.stack ?? e).slice(0, 600)));
	page.setDefaultTimeout(15_000);

	console.log("\n── 1) 选择器：服务端返回的模型 / 推荐 / 体积 / 内存建议 / 许可 ──");
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("local-asr-models").waitFor();
	check("本地模型区已渲染", await page.getByTestId("local-asr-models").isVisible());
	check("旧版重复导入卡已移除，主流程只有一套来源按钮", (await page.getByTestId("local-sensevoice-card").count()) === 0 && (await page.getByTestId("voice-local-use").count()) === 0);
	check("模型内部 ID 收进详情，不占主卡", !(await page.getByTestId("local-asr-detail").innerText()).includes("whisper-small-int8"));
	check("列出 6 个服务端模型（含 SenseVoice，非前端写死）", (await page.getByTestId("local-asr-models").getAttribute("data-models")) === "6");
	check("硬件档位可见 + 标「估算，未实测」", ((await page.getByTestId("local-asr-tier-note").textContent()) ?? "").includes("未实测"));
	check("默认选中推荐项（whisper-small-int8）", (await page.getByTestId("local-asr-detail").getAttribute("data-model-id")) === "whisper-small-int8");
	check("推荐理由来自 catalog", ((await page.getByTestId("local-asr-reason").textContent()) ?? "").includes("推荐它"));
	const body1 = (await page.getByTestId("local-asr-detail").textContent()) ?? "";
	check("显示权重体积 375 MB", body1.includes("375 MB"), body1.slice(0, 240));
	check("内存建议标「估算，未实测」", ((await page.getByTestId("local-asr-memory").textContent()) ?? "").includes("估算，未实测"));
	check("显示许可（已确认）", ((await page.getByTestId("local-asr-license").textContent()) ?? "").includes("已确认"));
	check("推荐档位显示为「均衡」", body1.includes("均衡"));
	check("Whisper 能力标签来自 catalog（含标点）", body1.includes("原生输出（含标点"));
	// 切到 Paraformer：显示它自己的「无标点」能力，不套用 Whisper 的标点标签
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /Paraformer 中文/ }).click();
	const para = (await page.getByTestId("local-asr-detail").textContent()) ?? "";
	check("切到 Paraformer（local-paraformer）", (await page.getByTestId("local-asr-detail").getAttribute("data-model-id")) === "paraformer-zh-2023-09-14-int8");
	check("Paraformer 显示自身「无标点」，不套 Whisper 标点标签", para.includes("无标点") && !para.includes("原生输出"));
	// 切到 large-v3：体积 GB + 允许选更大（不禁用安装）
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /Whisper Large v3/ }).click();
	const big = (await page.getByTestId("local-asr-detail").textContent()) ?? "";
	check("大模型显示 1.7x GB", /1\.7\d GB/.test(big), big.slice(0, 200));
	check("允许选更大的模型（安装按钮可用）", !(await page.getByTestId("local-asr-install-use").isDisabled()));
	await page.screenshot({ path: join(OUT, "01-models-selector.png") });

	console.log("\n── 2) 「安装并使用」：install intent=install_and_use → 装好服务端写来源 ──");
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /Whisper Small/ }).click();
	await page.getByTestId("local-asr-install-use").click();
	await page.getByTestId("local-asr-progress").waitFor();
	const req = state.installLog.find((x) => x.id === "whisper-small-int8");
	check("install 带 intent=install_and_use", req?.body.intent === "install_and_use", JSON.stringify(req));
	check("cleared 许可不偷传 acceptLicense（不伪造同意）", !!req && req.body.acceptLicense === undefined, JSON.stringify(req));
	check("total 未知 → 不确定进度条 indet", (await page.locator('[data-testid="local-asr-progress"] .pa-dl-bar.indet').count()) === 1);
	check("显示阶段名（后端给的 phaseLabel）", ((await page.getByTestId("local-asr-progress").textContent()) ?? "").includes("下载"));
	check("安装中前端不自己 PUT source", state.putLog.length === 0);
	await page.screenshot({ path: join(OUT, "02-installing-indeterminate.png") });
	// 模拟后端装完并写来源（intent=install_and_use 且选择未变）
	const wsm = state.models.find((m) => m.id === "whisper-small-int8");
	wsm.install = { state: "installed", phase: "done", phaseLabel: "完成", received: 375_485_327, total: 375_485_327, percent: 100, error: null, installedAt: Date.now(), source: "download", jobId: "asr:whisper-small-int8", attempt: 1 };
	state.source = { location: "local", provider: "local-whisper", model: "whisper-small-int8" };
	await page.getByTestId("local-asr-in-use").waitFor({ timeout: 10_000 });
	check("装好后显示使用中（selected 由服务端写）", await page.getByTestId("local-asr-in-use").isVisible());
	check("前端仍没有自己 PUT（来源由服务端写）", state.putLog.length === 0, JSON.stringify(state.putLog));
	check("语音来源状态同步到本地 Whisper Small", ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("Whisper Small"), (await page.getByTestId("voice-source-status").textContent()) ?? "");
	await page.screenshot({ path: join(OUT, "03-installed-in-use.png") });

	console.log("\n── 3) stale intent：安装中改选云端 → 装完不 late 覆盖 ──");
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /Whisper Base/ }).click();
	await page.getByTestId("local-asr-install-use").click();
	await page.getByTestId("local-asr-progress").waitFor();
	// 用户反悔：切到云端并保存
	await page.getByTestId("voice-tab-cloud").click();
	await page.getByTestId("voice-cloud-select").click();
	await page.getByTestId("voice-cloud-select-menu").getByRole("option").first().click();
	await page.getByTestId("voice-cloud-save").click();
	await page.waitForFunction(() => document.querySelector('[data-testid="voice-source-status"]')?.textContent?.includes("whisper-1"));
	// 后端因选择已变不会写来源：把 base 标成装好但不 selected
	const base2 = state.models.find((m) => m.id === "whisper-base-int8");
	base2.install = { state: "installed", phase: "done", phaseLabel: "完成", received: 161_608_560, total: 161_608_560, percent: 100, error: null, installedAt: Date.now(), source: "download", jobId: "asr:whisper-base-int8", attempt: 1 };
	await page.waitForTimeout(2600);
	check("改选云端后来源仍是云端 whisper-1", state.source?.location === "cloud" && state.source?.model === "whisper-1", JSON.stringify(state.source));
	check("装好的 base 不显示使用中", (await page.getByTestId("local-asr-in-use").count()) === 0);
	await page.screenshot({ path: join(OUT, "04-stale-not-overwritten.png") });
	// 「使用这个模型」（已装未选中）→ 走后端 /select（与 install_and_use 同一写来源路径，不前端另造 PUT source）
	const putBeforeUse = state.putLog.length;
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("local-asr-models").waitFor();
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /Whisper Base/ }).click();
	await page.getByTestId("local-asr-use").click();
	await page.waitForFunction(() => !!document.querySelector('[data-testid="local-asr-in-use"]'));
	check("「使用这个模型」调后端 /select", state.selectLog.some((x) => x.id === "whisper-base-int8"), JSON.stringify(state.selectLog));
	check("select 后来源切到本地 base", state.source?.location === "local" && state.source?.model === "whisper-base-int8", JSON.stringify(state.source));
	check("前端没有另走 PUT source", state.putLog.length === putBeforeUse, JSON.stringify(state.putLog.slice(putBeforeUse)));

	console.log("\n── 4) 取消：进行中可取消，进度消失、不写来源 ──");
	state.source = null;
	state.models.forEach((m) => {
		m.install = { state: "not_installed", phase: null, phaseLabel: null, received: 0, total: null, percent: null, error: null, installedAt: null, source: null, jobId: null, attempt: null };
	});
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("local-asr-models").waitFor();
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /Whisper Turbo/ }).click();
	await page.getByTestId("local-asr-install-use").click();
	await page.getByTestId("local-asr-progress").waitFor();
	await page.getByTestId("local-asr-cancel").click();
	await page.waitForFunction(() => !document.querySelector('[data-testid="local-asr-progress"]'));
	check("取消已发送到后端", state.cancelLog.some((x) => x.id === "whisper-turbo-int8"));
	check("取消后进度消失、回到未安装按钮", await page.getByTestId("local-asr-install-use").isVisible());
	check("取消后不写来源", state.source === null);

	console.log("\n── 5) 失败：可读原因 + 重试安装并使用 ──");
	const failedModel = state.models.find((m) => m.id === "whisper-base-int8");
	failedModel.install = { state: "failed", phase: "weights", phaseLabel: "下载 / 导入权重", received: 0, total: null, percent: null, error: "权重下载校验失败（sha256 不匹配）", installedAt: null, source: "download", jobId: "asr:whisper-base-int8", attempt: 1 };
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("local-asr-models").waitFor();
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /Whisper Base/ }).click();
	await page.getByTestId("local-asr-install-error").waitFor();
	check("显示可读失败原因", ((await page.getByTestId("local-asr-install-error").textContent()) ?? "").includes("sha256"));
	check("有「重试安装并使用」按钮", await page.getByTestId("local-asr-retry").isVisible());
	await page.screenshot({ path: join(OUT, "05-install-failed-retry.png") });
	const installBefore = state.installLog.length;
	await page.getByTestId("local-asr-retry").click();
	await page.waitForTimeout(300);
	check("点重试重新发起 install", state.installLog.length > installBefore, JSON.stringify(state.installLog));

	console.log("\n── 5b) SenseVoice：留在列表里、像其他模型一样一键下载安装（本地自用） ──");
	state.source = null;
	state.models.forEach((m) => {
		m.install = { state: "not_installed", phase: null, phaseLabel: null, received: 0, total: null, percent: null, error: null, installedAt: null, source: null, jobId: null, attempt: null };
	});
	const putBeforeSense = state.putLog.length;
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("local-asr-models").waitFor();
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /SenseVoice Small/ }).click();
	check("SenseVoice 仍在模型列表里（未被移出）", (await page.getByTestId("local-asr-detail").getAttribute("data-model-id")) === "sensevoice-small-int8");
	check("本地自用下载放行（selfServe=true）", (await page.getByTestId("local-asr-license").getAttribute("data-self-serve")) === "true");
	const svLic = (await page.getByTestId("local-asr-license").textContent()) ?? "";
	check("许可说明标「本地自用可下载」，不写已确认商用", svLic.includes("本地自用可下载") && !svLic.includes("已确认"), svLic);
	check("一键安装按钮可用（不再被许可禁用）", !(await page.getByTestId("local-asr-install-use").isDisabled()));
	check("没有额外强制「我同意」复选框", (await page.getByTestId("local-asr-accept").count()) === 0);
	// 保留合法导入（收进详情，不再另开一套旧卡）
	await page.getByTestId("local-asr-details-toggle").click();
	check("详情里有「导入已有权重」入口（保留合法导入）", await page.getByTestId("local-asr-import-toggle").isVisible());
	await page.getByTestId("local-asr-import-toggle").click();
	check("导入目录输入 / 导入按钮可访问", (await page.getByTestId("local-asr-import-dir").isVisible()) && (await page.getByTestId("local-asr-import-btn").isVisible()));
	await page.getByTestId("local-asr-import-toggle").click();
	await page.screenshot({ path: join(OUT, "05b-sensevoice-oneclick.png") });
	// 一键安装并使用
	const svInstalls = state.installLog.filter((x) => x.id === "sensevoice-small-int8").length;
	await page.getByTestId("local-asr-install-use").click();
	await page.getByTestId("local-asr-progress").waitFor();
	const svReq = state.installLog.filter((x) => x.id === "sensevoice-small-int8").at(-1);
	check("SenseVoice install 带 intent=install_and_use", svReq?.body.intent === "install_and_use", JSON.stringify(svReq));
	check("SenseVoice 不偷传 acceptLicense（不伪造同意）", !!svReq && svReq.body.acceptLicense === undefined, JSON.stringify(svReq));
	check("SenseVoice 安装有真实进度条", (await page.locator('[data-testid="local-asr-progress"] .pa-dl-bar').count()) === 1);
	await page.screenshot({ path: join(OUT, "05c-sensevoice-installing.png") });
	// 取消
	await page.getByTestId("local-asr-cancel").click();
	await page.waitForFunction(() => !document.querySelector('[data-testid="local-asr-progress"]'));
	check("SenseVoice 取消发送到后端", state.cancelLog.some((x) => x.id === "sensevoice-small-int8"));
	check("SenseVoice 取消后不写来源", state.source === null);
	// 失败 + 重试
	const svm = state.models.find((m) => m.id === "sensevoice-small-int8");
	svm.install = { state: "failed", phase: "weights", phaseLabel: "下载 / 导入权重", received: 0, total: null, percent: null, error: "网络中断（权重下载失败）", installedAt: null, source: "download", jobId: "asr:sensevoice-small-int8", attempt: 1 };
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("local-asr-models").waitFor();
	await page.getByTestId("local-asr-model-select").click();
	await page.getByTestId("local-asr-model-select-menu").getByRole("option", { name: /SenseVoice Small/ }).click();
	await page.getByTestId("local-asr-install-error").waitFor();
	check("SenseVoice 失败显示可读原因", ((await page.getByTestId("local-asr-install-error").textContent()) ?? "").includes("网络中断"));
	await page.getByTestId("local-asr-retry").click();
	await page.waitForTimeout(300);
	check("SenseVoice 重试重新发起 install", state.installLog.filter((x) => x.id === "sensevoice-small-int8").length > svInstalls + 1);
	// 装好并使用（服务端写来源 → selected）
	svm.install = { state: "installed", phase: "done", phaseLabel: "完成", received: 239_549_735, total: 239_549_735, percent: 100, error: null, installedAt: Date.now(), source: "download", jobId: "asr:sensevoice-small-int8", attempt: 2 };
	state.source = { location: "local", provider: "local-sensevoice", model: "sensevoice-small-int8" };
	await page.getByTestId("local-asr-in-use").waitFor({ timeout: 10_000 });
	check("SenseVoice 装好后显示使用中（selected 由服务端写）", await page.getByTestId("local-asr-in-use").isVisible());
	check("语音来源状态同步到 SenseVoice", ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("SenseVoice"));
	check("前端没有自己另写一套 source（不 late PUT）", state.putLog.length === putBeforeSense, JSON.stringify(state.putLog.slice(putBeforeSense)));
	await page.screenshot({ path: join(OUT, "05d-sensevoice-in-use.png") });

	console.log("\n── 6) 390 窄屏不横向溢出 ──");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${base}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("local-asr-models").waitFor();
	const ov = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: innerWidth, c: (() => { const c = document.querySelector("[data-testid=settings-content]"); return c ? c.scrollWidth - c.clientWidth : 0; })() }));
	check("390：页面与内容区不横向溢出", ov.doc <= ov.vw && ov.c <= 1, JSON.stringify(ov));
	await page.screenshot({ path: join(OUT, "06-390-local-models.png") });
} catch (e) {
	console.error("运行失败：", e);
	failed++;
} finally {
	await browser?.close().catch(() => {});
	web.close();
}
console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌  截图：${OUT}`);
process.exit(failed === 0 ? 0 : 1);
