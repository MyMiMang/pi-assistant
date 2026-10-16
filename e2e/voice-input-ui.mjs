/**
 * 语音输入（浏览器侧）纯前端验证。
 *
 * 覆盖（用户点名）：麦克风按钮可见 / **idle 未配置不常驻状态行与「去设置」、只有点了麦克风才提示去设置（0 getUserMedia / 0 转写）** /
 * 录音→停止→转写插入草稿（不自动发送）/
 * 取消不误发（0 次转写、草稿与引用保持）/ 切后台停轨道不发送 / 390 无横向溢出；
 * 以及新增的「云 ASR 设置」与「本地 SenseVoice 许可卡」：ASR 声明区块可见、许可限制默认可见、
 * 许可未确认时下载安装按钮 disabled（接受勾选不能绕过）、导入入口可用。
 *
 * 纯前端：静态托管 apps/web/dist + page.route 拦所有 /api；用 Chromium 假麦克风设备，不碰真实麦克风 / 服务端 / 云。
 * 运行前先构建：npm run build -w @pi-assistant/web
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const root = decodeURIComponent(new URL("..", import.meta.url).pathname);
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/voice-input-ui";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".map": "application/json" };
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
const hostInfo = { settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } };
const mkMsg = (over) => ({ id: "x", agent_id: "a1", role: "assistant", content: "", meta: {}, status: "done", created_at: now, updated_at: now, conversation_id: "c1", ...over });
const MSGS = [mkMsg({ id: "u1", role: "user", content: "先前的对话", created_at: now - 4000, updated_at: now - 4000 }), mkMsg({ id: "a1m", content: "好的。", created_at: now - 3000, updated_at: now - 3000 })];
const ROOM = { id: "r1", name: "测试群", purpose: "验证群聊麦克风位置", managerId: "a1", caps: { maxTurns: 12, maxDepth: 2, perAgent: 3, tokenBudget: 0, followup: true }, unread: 0, paused: null, members: [{ agentId: "a1", name: "测试助理", avatar: "测", color: "#3b82f6", left: false, deleted: false, scope: "user", status: "idle" }], last: null, created_at: now, updated_at: now, state: { running: false, current: null, queue: [] } };

const ASR_PROVIDER = {
	id: "openai", name: "OpenAI", kind: "custom", configured: true, baseUrl: "https://api.openai.com/v1",
	models: [{ provider: "openai", id: "whisper-1", name: "whisper-1", type: "asr", capabilities: ["asr"], confirmed: true, inferred: [], source: "custom", configured: true, asrAdapter: { protocol: "openai-audio-transcriptions", location: "cloud", requiresApiKey: true, baseUrl: "https://api.openai.com/v1" } }],
};
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
	source: { project: "SenseVoiceSmall（FunAudioLLM / FunASR）· sherpa-onnx 转换", repoUrl: "https://github.com/FunAudioLLM/SenseVoice", weightsRepo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", weightsRevision: "2365baeacb507f821a0c8120fcee3d484dba7a07", weightsLicense: "FunASR Model Open Source License Agreement v1.1", note: "许可按 FunASR MODEL_LICENSE v1.1" },
	model: { id: "sensevoice-small-int8", bytes: 239_549_735, sampleRate: 16000, channels: 1, languages: ["zh", "yue", "en", "ja", "ko"], punctuation: true },
	notes: ["本机未实测：冷启动 / RTF / 峰值内存均无本机数据，不给性能承诺"],
};

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};

/** 语音按钮几何（用户 UI 修正）：麦克风必须在发送键左侧、同一行、同一 composer-bar，且不在附件工具列。 */
async function voiceLayout(page) {
	return page.evaluate(() => {
		const mic = document.querySelector('[data-testid="voice-mic"]');
		const send = document.querySelector(".pa-composer-bar .pa-send");
		if (!mic || !send) return { ok: false, why: !mic ? "缺 voice-mic" : "缺发送键" };
		const m = mic.getBoundingClientRect();
		const s = send.getBoundingClientRect();
		const r = {
			domBefore: !!(mic.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING),
			sameComposer: !!mic.closest(".pa-composer-bar") && mic.closest(".pa-composer-bar") === send.closest(".pa-composer-bar"),
			notInTools: !mic.closest(".pa-composer-tools"),
			sameRow: Math.abs(m.top + m.height / 2 - (s.top + s.height / 2)) <= 6,
			leftOf: m.right <= s.left + 1,
			gap: +(s.left - m.right).toFixed(1),
			micRect: { x: Math.round(m.x), y: Math.round(m.y) },
			sendRect: { x: Math.round(s.x), y: Math.round(s.y) },
		};
		r.ok = r.domBefore && r.sameComposer && r.notInTools && r.sameRow && r.leftOf && r.gap <= 14;
		return r;
	});
}

const sendX = (page) => page.evaluate(() => Math.round(document.querySelector(".pa-composer-bar .pa-send").getBoundingClientRect().x));

/** 包一层 getUserMedia 计数：验证「未配置时点麦克风不真开麦克风、不录音」。 */
const countGum = (context) =>
	context.addInitScript(() => {
		window.__gum = 0;
		const md = navigator.mediaDevices;
		if (!md) return;
		const orig = md.getUserMedia.bind(md);
		md.getUserMedia = (...a) => {
			window.__gum = (window.__gum ?? 0) + 1;
			return orig(...a);
		};
	});

async function installRoutes(context, state) {
	await context.route("**/api/**", async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT("a1", "测试助理")]);
		if (p === "/api/rooms") return json([ROOM]);
		if (p.startsWith("/api/rooms/")) return json(p.endsWith("/messages") ? [] : {});
		if (p === "/api/channels") return json({ items: [], publicUrl: null });
		if (p === "/api/wechat") return json({ enabled: false, acknowledgedAt: null, agentIds: [] });
		if (p === "/api/downloads") return json({ items: [] });
		if (p.startsWith("/api/proactive/inbox")) return json({ items: [], count: 0, defaultLevel: "normal" });
		if (p === "/api/devices") return json([]);
		if (p === "/api/models/providers") return json([]);
		if (p === "/api/models/custom") return json({ providers: [], apis: [], classifierProtocols: [] });
		if (p === "/api/image-models/providers") return json({ providers: [], models: [], default: null });
		if (p === "/api/image-models") return json({ kinds: [], providers: [], models: [], default: null, reusable: [] });
		if (p === "/api/models/registry") return json({ providers: state.asr ? [ASR_PROVIDER] : [] });
		if (p === "/api/models") return json([]);
		if (p === "/api/model-strengths") return json({ labels: [], models: [] });
		if (p === "/api/fast-computer/benchmark") return json({ availability: { available: false, reason: "未启用" }, runs: [] });
		if (p === "/api/host-control") return json(hostInfo);
		if (p.startsWith("/api/usage/summary")) return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
		if (p === "/api/memory/providers") return json({ global: "basic", providers: [] });
		if (p === "/api/skill-suggest") return json({ enabled: false });
		if (p === "/api/settings") return json({});
		if (p === "/api/audio/asr/config") return json({ maxDurationMs: 60000, maxBytes: 5242880, protocol: "openai-audio-transcriptions" });
		if (p === "/api/audio/asr/providers") return json({ protocols: ["openai-audio-transcriptions", "local-asr-http"], providers: [] });
		if (p === "/api/local-models/asr/sensevoice/status") return json(SENSEVOICE_STATUS);
		if (p === "/api/local-models/laya/status") return json({ platform: { key: "darwin-arm64", os: "darwin", arch: "arm64", accelerator: "cpu", support: "supported", torchBackend: "cpu", pins: [], reason: "" }, install: { state: "not_installed", phase: "idle", received: 0, total: null, error: null, installedAt: null }, runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1" }, health: null, configured: false, registered: null, source: { project: "Laya", repoUrl: "https://github.com/", weightsOrg: "convaiinnovations", codeLicense: "Apache-2.0", weightsLicense: "Apache-2.0", version: "0.4.8", reviewedRevisions: {} } });
		if (p === "/api/audio/transcriptions" && req.method() === "POST") {
			state.transcribeCalls.push(req.postData() ?? "");
			return json({ text: "这是转写出来的文字", provider: "openai", model: "whisper-1", durationMs: 500 });
		}
		if (p === "/api/audio/asr/source") {
			if (req.method() === "PUT") {
				state.source = JSON.parse(req.postData() ?? "{}").source ?? null;
				return json({ source: state.source });
			}
			return json({ source: state.source ?? null });
		}
		if (p === "/api/audio/asr/lease" && req.method() === "POST") return json({ leaseId: "lease-1" });
		if (p.startsWith("/api/audio/asr/lease/")) return json({ ok: true });
		if (p === "/api/agents/a1/computer") return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		if (p === "/api/agents/a1/messages") {
			if (req.method() === "POST") {
				state.sent.push(JSON.parse(req.postData() ?? "{}"));
				return json({ id: "sent", agent_id: "a1", conversation_id: "c1", role: "user", content: "", meta: {}, status: "done", created_at: Date.now(), updated_at: Date.now() });
			}
			return json(MSGS);
		}
		if (p === "/api/agents/a1/conversations" && req.method() === "GET") return json({ current: "c1", items: [{ id: "c1", agent_id: "a1", title: "对话", created_at: now, updated_at: now, message_count: 2, last: "好的" }] });
		if (p === "/api/agents/a1/tasks") return json([]);
		if (p.startsWith("/api/subagents")) return json([]);
		if (p.endsWith("/read")) return json({});
		return json({});
	});
}

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
try {
	browser = await chromium.launch({
		executablePath: CHROME,
		headless: true,
		args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
	});
	const state = { sent: [], transcribeCalls: [], asr: false, source: null };
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", permissions: ["microphone"] });
	await installRoutes(ctx, state);
	await countGum(ctx);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.error("  ⚠️ pageerror", String(e.stack ?? e).slice(0, 800)));
	await page.goto(`${base}/?agent=a1`);
	await page.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });
	const ta = page.locator("main textarea").first();

	console.log("\n── 未配置 ASR：idle 不常驻入口；点麦克风才提示去设置 ──");
	await page.locator('[data-testid="voice-mic"]').waitFor({ timeout: 10_000 });
	check("麦克风按钮可见", await page.locator('[data-testid="voice-mic"]').isVisible());
	const lay0 = await voiceLayout(page);
	check("麦克风紧贴发送键左侧（同一行、同一 composer-bar、不在附件工具列）", lay0.ok, JSON.stringify(lay0));
	check("权限 / 模型选择器仍在输入栏（未被麦克风挤掉）", (await page.locator('[data-testid="host-tier-pill"]').isVisible()) && (await page.locator('[data-testid="model-picker"]').isVisible()));
	check("未配置时按钮提示「未配置语音识别模型」", ((await page.locator('[data-testid="voice-mic"]').getAttribute("aria-label")) ?? "").includes("未配置语音识别模型"));
	check("idle 未配置时不常驻状态行 / 「去设置」（只有麦克风图标）", (await page.locator('[data-testid="voice-status"]').count()) === 0 && (await page.locator('[data-testid="voice-open-settings"]').count()) === 0);
	check("点麦克风前未调用 getUserMedia", (await page.evaluate(() => window.__gum ?? 0)) === 0);
	await page.locator('[data-testid="voice-mic"]').click();
	await page.locator('[data-testid="voice-open-settings"]').waitFor({ timeout: 5000 });
	check("点了未配置的麦克风才浮现短提示 + 「去设置」", (await page.locator('[data-testid="voice-status"]').isVisible()) && (await page.locator('[data-testid="voice-open-settings"]').isVisible()));
	check("未配置点击不真开麦克风（0 次 getUserMedia）、不转写（0 次请求）", (await page.evaluate(() => window.__gum ?? 0)) === 0 && state.transcribeCalls.length === 0);
	check("未配置给出明确错误提示", ((await page.locator('[data-testid="voice-hint"]').textContent()) ?? "").includes("配置语音识别模型"));
	// 「去设置」打开「语音配置」，且临时提示随之清掉（不残留）
	await page.locator('[data-testid="voice-open-settings"]').click();
	await page.locator('[data-testid="voice-source-status"]').waitFor({ timeout: 20_000 });
	check("「去设置」打开设置 › 语音配置", await page.locator('[data-testid="voice-source-status"]').isVisible());
	check("点「去设置」后链接真的消失（hook error 已被清）", (await page.locator('[data-testid="voice-open-settings"]').count()) === 0 && (await page.locator('[data-testid="voice-status"]').count()) === 0);
	await page.goto(`${base}/?agent=a1`);
	await page.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });
	check("回到对话后不再有临时提示 / 「去设置」", (await page.locator('[data-testid="voice-status"]').count()) === 0 && (await page.locator('[data-testid="voice-open-settings"]').count()) === 0);

	console.log("\n── 配置 ASR：录音 → 停止 → 转写插入（不自动发送） ──");
	// 声明 ASR 还不够：语音来源必须显式选择（不再自动挑第一个已配置的）
	state.asr = true;
	state.source = { location: "cloud", provider: "openai", model: "whisper-1" };
	await page.reload();
	await page.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });
	await page.locator('[data-testid="voice-mic"]').waitFor({ timeout: 10_000 });
	check("配置后按钮变为可用语音输入", ((await page.locator('[data-testid="voice-mic"]').getAttribute("aria-label")) ?? "").includes("语音输入"));
	check("配置后 idle 也不常驻状态行 / 「去设置」", (await page.locator('[data-testid="voice-status"]').count()) === 0 && (await page.locator('[data-testid="voice-open-settings"]').count()) === 0);
	await ta.fill("原有草稿 ");
	await ta.press("End");
	const sendXBefore = await sendX(page);
	await page.locator('[data-testid="voice-mic"]').click();
	await page.locator('[data-testid="voice-stop"]').waitFor({ timeout: 10_000 });
	check("开始录音出现停止按钮", await page.locator('[data-testid="voice-stop"]').isVisible());
	check("录音时发送键不位移（提示走独立 status 行，不拖动发送键）", (await sendX(page)) === sendXBefore, `before=${sendXBefore} after=${await sendX(page)}`);
	await page.waitForTimeout(600);
	await page.locator('[data-testid="voice-stop"]').click();
	await page.waitForTimeout(1500);
	check("停止后发出一次转写请求", state.transcribeCalls.length === 1, `实际 ${state.transcribeCalls.length}`);
	check("转写结果插入到光标锚点、保留原有草稿", (await ta.inputValue()).includes("原有草稿") && (await ta.inputValue()).includes("这是转写出来的文字"), await ta.inputValue());
	check("不自动发送（无 POST 消息）", state.sent.length === 0);
	await page.screenshot({ path: join(OUT, "desktop-voice.png") });

	console.log("\n── 取消录音：不误发、草稿与引用保持 ──");
	await ta.fill("保留草稿");
	// 引用一条消息，验证取消语音不动引用
	await page.locator('[data-mid="a1m"] [data-testid="quote-btn"]').click();
	await page.locator('[data-testid="quote-bar"]').waitFor({ timeout: 5000 });
	const before = state.transcribeCalls.length;
	await page.locator('[data-testid="voice-mic"]').click();
	await page.locator('[data-testid="voice-cancel"]').waitFor({ timeout: 10_000 });
	await page.locator('[data-testid="voice-cancel"]').click();
	await page.waitForTimeout(600);
	check("取消后 0 次转写（不误发）", state.transcribeCalls.length === before, `实际 ${state.transcribeCalls.length - before}`);
	check("取消不动草稿", (await ta.inputValue()) === "保留草稿", await ta.inputValue());
	check("取消不动引用条", (await page.locator('[data-testid="quote-bar"]').count()) === 1);

	console.log("\n── 切后台：停轨道取消、不发送 ──");
	const before2 = state.transcribeCalls.length;
	await page.locator('[data-testid="voice-mic"]').click();
	await page.locator('[data-testid="voice-stop"]').waitFor({ timeout: 10_000 });
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { value: true, configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.waitForTimeout(700);
	check("切后台后取消（0 次转写）", state.transcribeCalls.length === before2);
	check("切后台回到空闲（麦克风按钮回来）", (await page.locator('[data-testid="voice-mic"]').count()) === 1);
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { value: false, configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await page.locator('[data-testid="quote-cancel"]').click();

	console.log("\n── 群聊：麦克风同样紧贴发送键左侧 ──");
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${base}/?room=r1`);
	await page.locator('[data-testid="room-input"]').waitFor({ timeout: 20_000 });
	check("群聊麦克风按钮可见", await page.locator('[data-testid="voice-mic"]').isVisible());
	const layRoom = await voiceLayout(page);
	check("群聊麦克风紧贴发送键左侧（与单聊一致）", layRoom.ok, JSON.stringify(layRoom));
	await page.screenshot({ path: join(OUT, "room-desktop-voice.png") });

	console.log("\n── 390 窄屏 ──");
	const ctx2 = await browser.newContext({ viewport: { width: 390, height: 700 }, locale: "zh-CN", permissions: ["microphone"], hasTouch: true });
	await installRoutes(ctx2, state);
	const p2 = await ctx2.newPage();
	await p2.goto(`${base}/?agent=a1`);
	await p2.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });
	check("390 麦克风按钮可见", await p2.locator('[data-testid="voice-mic"]').isVisible());
	const lay390 = await voiceLayout(p2);
	check("390 麦克风仍在发送键左侧且不换行", lay390.ok, JSON.stringify(lay390));
	const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	check("390 不横向溢出", overflow <= 1, `overflow=${overflow}`);
	await p2.screenshot({ path: join(OUT, "mobile-390-voice.png") });

	console.log("\n── 矮窗（1440×560）──");
	const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 560 }, locale: "zh-CN", permissions: ["microphone"] });
	await installRoutes(ctx3, state);
	const p3 = await ctx3.newPage();
	await p3.goto(`${base}/?agent=a1`);
	await p3.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });
	const layShort = await voiceLayout(p3);
	check("矮窗麦克风仍在发送键左侧且不换行", layShort.ok, JSON.stringify(layShort));
	check("矮窗发送键在视口内（未被挤出）", await p3.evaluate(() => {
		const s = document.querySelector(".pa-composer-bar .pa-send").getBoundingClientRect();
		return s.bottom <= window.innerHeight + 1 && s.left >= 0;
	}));
	await p3.screenshot({ path: join(OUT, "short-window-voice.png") });

	console.log("\n── 模型页 ASR 声明 + 语音配置里的本地 SenseVoice 许可卡 ──");
	// 模型页只放「声明」
	await page.goto(`${base}/?settings=models`);
	await page.getByTestId("model-services").waitFor({ timeout: 20_000 });
	await page.locator('[data-testid="service-toggle-openai"]').click();
	await page.locator('[data-testid="asr-adapter-section-openai"]').waitFor({ timeout: 10_000 });
	check("自定义服务里有「语音识别（ASR）声明」区块", await page.locator('[data-testid="asr-adapter-section-openai"]').isVisible());
	check("模型页不再有本地 Laya / SenseVoice 卡", (await page.locator('[data-testid="local-laya-card"]').count()) === 0 && (await page.locator('[data-testid="local-sensevoice-card"]').count()) === 0);
	// SenseVoice 许可卡在「语音配置」页
	await page.goto(`${base}/?settings=voice`);
	await page.locator('[data-testid="voice-tab-local"]').click();
	await page.locator('[data-testid="local-sensevoice-card"]').waitFor({ timeout: 20_000 });
	check("本地 SenseVoice 许可卡可见", await page.locator('[data-testid="local-sensevoice-card"]').isVisible());
	check("许可卡标注适用范围未最终确认", (await page.locator('[data-testid="local-sensevoice-card"]').getAttribute("data-license-decision")) === "unresolved");
	const licText = (await page.locator('[data-testid="sensevoice-license"]').textContent()) ?? "";
	check("许可摘要常驻可见（含「下载暂不可用」）", licText.includes("未最终确认") && licText.includes("下载暂不可用"));
	await page.locator('[data-testid="sensevoice-terms-toggle"]').click();
	await page.locator('[data-testid="sensevoice-license-detail"]').waitFor();
	const detailText = (await page.locator('[data-testid="sensevoice-license-detail"]').textContent()) ?? "";
	check("条款详情（折叠）含限制文案", detailText.includes("for reference and learning purposes only") || detailText.includes("署名"));
	check("许可正文 / 来源链接可用", (await page.locator('[data-testid="sensevoice-link-license"]').getAttribute("href"))?.startsWith("https://") && (await page.locator('[data-testid="sensevoice-link-repo"]').getAttribute("href"))?.startsWith("https://"));
	check("接受勾选在许可未确认时被禁用（不能绕过）", await page.locator('[data-testid="sensevoice-accept"]').isDisabled());
	check("下载安装按钮在许可未确认时禁用", await page.locator('[data-testid="sensevoice-install"]').isDisabled());
	check("自行导入入口可用", await page.locator('[data-testid="sensevoice-import"]').isVisible());
	await page.screenshot({ path: join(OUT, "settings-asr.png") });

	console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
	process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
	console.error("运行失败：", e);
	process.exitCode = 1;
} finally {
	await browser?.close();
	web.close();
}
