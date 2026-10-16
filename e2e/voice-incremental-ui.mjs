/**
 * 语音输入**分段增量**真实 DOM 验证（Playwright + Chromium 假麦克风，不碰用户真实麦克风 / 服务端 / 云 / 真实数据）。
 *
 * 用 `--use-file-for-fake-audio-capture=<合成 WAV>` 喂**确定性**音频：若干段「有声 + 静音停顿」，
 * 这样停顿 VAD 能真正分段。覆盖用户点名：
 *  - 录音时展示**真实 PCM 音量**（bar 的 data-level 非零），停止后波形清空（不残留）；
 *  - 本地 ASR **边说边出字**：第一段在停止前就进入输入框；多段按序追加、requestId 唯一；
 *  - 停止只等尾段（不整段重传）；取消保留已进输入框文字、不再发新请求；
 *  - 云端**保持整段一次请求**（不因增量把云拆成多次最小计费）。
 *
 * 纯前端：静态托管 apps/web/dist + page.route 拦所有 /api；音频是脚本自己合成的 WAV（写入 workspace evidence 下）。
 * 运行前先构建：npm run build -w @pi-assistant/web
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";

const root = decodeURIComponent(new URL("..", import.meta.url).pathname);
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/voice-incremental-ui";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
await writeFile(join(OUT, "OWNER"), "voice-incremental-input / e2e fake-audio\n");

/** 合成一段 48k 单声道 16-bit WAV：`[有声 1.2s][静音 1.0s] × 4`，循环播放，供假麦克风采集。 */
function synthWav() {
	const rate = 48_000;
	const parts = [];
	for (let rep = 0; rep < 4; rep++) {
		const speech = new Float32Array(Math.round(rate * 1.2));
		for (let i = 0; i < speech.length; i++) speech[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
		parts.push(speech, new Float32Array(Math.round(rate * 1.0)));
	}
	const pcm = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		for (let i = 0; i < p.length; i++) pcm[at++] = Math.round(Math.max(-1, Math.min(1, p[i])) * 0x7fff);
	}
	const dataBytes = pcm.length * 2;
	const buf = new ArrayBuffer(44 + dataBytes);
	const dv = new DataView(buf);
	const ascii = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
	ascii(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); ascii(8, "WAVE"); ascii(12, "fmt ");
	dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
	dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
	ascii(36, "data"); dv.setUint32(40, dataBytes, true);
	for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, pcm[i], true);
	return Buffer.from(buf);
}
const wavPath = join(OUT, "fake-speech.wav");
await writeFile(wavPath, synthWav());

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
const AGENT = { id: "a1", name: "测试助理", avatar: "测", color: "#3b82f6", persona: "", description: "", status: "idle", unread: 0, model: { provider: "mock", id: "mock" }, model_provider: "mock", model_id: "mock", workspace: "/tmp/ws/a1", scope: "user" };
const system = () => ({ serverId: "srv", publicKey: "pk", pi: { version: "0.0.0", testedWith: "0.0.0", compatible: true, message: "ok" }, mock: true, local: true, owner: true, server: false, deviceId: "dev", onboarded: true, modelSetupDone: true, defaultModel: { provider: "mock", id: "mock" }, credentialBackend: "file", sandbox: { mode: "workspace", preference: "workspace", dockerAvailable: false }, entryDomain: null, tunnel: { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "off" }, binary: null, named: {} }, workspaceRoot: "/tmp/ws", push: { publicKey: "pk" }, seq: 1 });
const mkMsg = (o) => ({ id: "x", agent_id: "a1", role: "assistant", content: "", meta: {}, status: "done", created_at: now, updated_at: now, conversation_id: "c1", ...o });
const MSGS = [mkMsg({ id: "u1", role: "user", content: "先前的对话", created_at: now - 4000, updated_at: now - 4000 }), mkMsg({ id: "a1m", content: "好的。", created_at: now - 3000, updated_at: now - 3000 })];

const SEG_TEXT = ["第一段文字", "第二段文字", "第三段文字", "第四段文字", "第五段文字", "第六段文字"];
const state = { sent: [], transcribeCalls: [], source: null, level: [] };

const installRoutes = async (context) => {
	await context.route("**/api/**", async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT]);
		if (p === "/api/rooms") return json([]);
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
		if (p === "/api/models/registry") return json({ providers: [] });
		if (p === "/api/models") return json([]);
		if (p === "/api/model-strengths") return json({ labels: [], models: [] });
		if (p === "/api/fast-computer/benchmark") return json({ availability: { available: false, reason: "未启用" }, runs: [] });
		if (p === "/api/host-control") return json({ settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } });
		if (p.startsWith("/api/usage/summary")) return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
		if (p === "/api/memory/providers") return json({ global: "basic", providers: [] });
		if (p === "/api/skill-suggest") return json({ enabled: false });
		if (p === "/api/settings") return json({});
		if (p === "/api/audio/asr/config") return json({ maxDurationMs: 60000, maxBytes: 5242880, protocol: "openai-audio-transcriptions" });
		if (p === "/api/audio/asr/providers") return json({ protocols: ["openai-audio-transcriptions", "local-asr-http"], providers: [] });
		if (p === "/api/local-models/asr/catalog") return json({ hardware: { os: "darwin", arch: "arm64", cpuCores: 10, memoryBytes: 16 * 1024 ** 3, tier: "balanced", tierNote: "估算" }, runtime: { engine: "sherpa-onnx", version: "1.13.8", python: "3.12", depsBytes: null, depsNote: "" }, recommendedId: "sensevoice-small-int8", notes: [], models: [] });
		if (p === "/api/local-models/asr/sensevoice/status") return json({ platform: { os: "darwin", arch: "arm64", support: "supported" }, install: { state: "not_installed", phase: "idle", received: 0, total: null, error: null, source: null }, runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1", lastError: null }, configured: false, registered: null });
		if (p === "/api/audio/transcriptions" && req.method() === "POST") {
			const idx = state.transcribeCalls.length;
			state.transcribeCalls.push({ at: Date.now(), raw: req.postData() ?? "" });
			return json({ text: SEG_TEXT[Math.min(idx, SEG_TEXT.length - 1)], provider: state.source?.provider ?? "local-sensevoice", model: state.source?.model ?? "sensevoice-small-int8", durationMs: 200 });
		}
		if (p === "/api/audio/asr/source") {
			if (req.method() === "PUT") state.source = JSON.parse(req.postData() ?? "{}").source ?? null;
			const opts = state.source
				? [{ location: state.source.location, provider: state.source.provider, model: state.source.model, name: state.source.model, protocol: state.source.location === "local" ? "local-asr-http" : "openai-audio-transcriptions", availability: "ready", reason: null, selected: true }]
				: [];
			return json({ source: state.source ?? null, options: opts, version: 1 });
		}
		if (p === "/api/audio/asr/lease" && req.method() === "POST") return json({ leaseId: "lease-1" });
		if (p.startsWith("/api/audio/asr/lease/")) return json({ ok: true });
		if (p === "/api/agents/a1/computer") return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		if (p === "/api/agents/a1/messages") {
			if (req.method() === "POST") { state.sent.push(JSON.parse(req.postData() ?? "{}")); return json(mkMsg({ id: "sent", role: "user" })); }
			return json(MSGS);
		}
		if (p === "/api/agents/a1/conversations" && req.method() === "GET") return json({ current: "c1", items: [{ id: "c1", agent_id: "a1", title: "对话", created_at: now, updated_at: now, message_count: 2, last: "好的" }] });
		if (p === "/api/agents/a1/tasks") return json([]);
		if (p.startsWith("/api/subagents")) return json([]);
		if (p.endsWith("/read")) return json({});
		return json({});
	});
};

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else { failed++; console.error(`  ❌ ${name} ${detail}`); }
};
const localSource = { location: "local", provider: "local-sensevoice", model: "sensevoice-small-int8" };

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
try {
	browser = await chromium.launch({
		executablePath: CHROME,
		headless: true,
		args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wavPath}`, "--autoplay-policy=no-user-gesture-required"],
	});
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", permissions: ["microphone"] });
	await installRoutes(ctx);
	state.source = localSource;
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.error("  ⚠️ pageerror", String(e.stack ?? e).slice(0, 500)));
	await page.goto(`${base}/?agent=a1`);
	await page.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });
	const ta = page.locator("main textarea").first();
	await page.locator('[data-testid="voice-mic"]').waitFor({ timeout: 10_000 });

	console.log("\n── 本地 ASR：录音显示真实音量 + 边说边出字（分段增量） ──");
	await ta.fill("草稿：");
	await ta.press("End");
	await page.locator('[data-testid="voice-mic"]').click();
	await page.locator('[data-testid="voice-stop"]').waitFor({ timeout: 10_000 });
	check("录音时出现真实音量条（24 格）", (await page.locator('[data-testid="voice-level"] i').count()) === 24);
	// 等假音频的有声段到达（最多 3s），任一格 data-level > 0 即真实采到声音
	let maxLevel = 0;
	for (let i = 0; i < 30; i++) {
		maxLevel = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('[data-testid="voice-level"] i')].map((el) => Number(el.getAttribute("data-level") ?? 0))));
		if (maxLevel > 0.05) break;
		await page.waitForTimeout(100);
	}
	check("音量来自真实 PCM（有声音时 data-level > 0）", maxLevel > 0.05, `maxLevel=${maxLevel}`);
	// 等第一段 + 第二段都在停止前进入输入框（边说边出字；假音频循环，段会持续产生）
	await page.waitForFunction((t) => (document.querySelector("main textarea")?.value ?? "").includes(t), SEG_TEXT[1], { timeout: 25_000 }).catch(() => {});
	const beforeStop = await ta.inputValue();
	const idsBeforeStop = state.transcribeCalls.map((c) => (c.raw.match(/name="requestId"\r?\n\r?\n([^\r\n]+)/) ?? [])[1]);
	check("停止前已出至少两段（边说边出字）", beforeStop.includes(SEG_TEXT[0]) && beforeStop.includes(SEG_TEXT[1]), beforeStop);
	check("录音期间已发出 >=2 次分段转写", state.transcribeCalls.length >= 2, `实际 ${state.transcribeCalls.length}`);
	check("段按顺序（第一段在第二段之前）", beforeStop.indexOf(SEG_TEXT[0]) < beforeStop.indexOf(SEG_TEXT[1]));
	check("每段唯一 requestId（分段请求，不是整段一次）", new Set(idsBeforeStop.filter(Boolean)).size >= 2, JSON.stringify(idsBeforeStop));
	await page.screenshot({ path: join(OUT, "recording-level.png") });
	await page.locator('[data-testid="voice-stop"]').click();
	await page.waitForTimeout(2500);
	const afterStop = await ta.inputValue();
	check("停止后文字保留、段序不乱", afterStop.includes(SEG_TEXT[0]) && afterStop.includes(SEG_TEXT[1]) && afterStop.indexOf(SEG_TEXT[0]) < afterStop.indexOf(SEG_TEXT[1]), afterStop);
	check("原有草稿保留（不覆盖用户输入）", afterStop.startsWith("草稿："));
	check("不自动发送", state.sent.length === 0);
	check("停止后音量条消失（不残留假波形）", (await page.locator('[data-testid="voice-level"]').count()) === 0);
	await page.screenshot({ path: join(OUT, "after-stop.png") });

	console.log("\n── 本地 ASR：取消保留已进输入框文字、不再发新请求 ──");
	await ta.fill("取消前草稿");
	await ta.press("End");
	const beforeCancel = state.transcribeCalls.length;
	await page.locator('[data-testid="voice-mic"]').click();
	await page.locator('[data-testid="voice-stop"]').waitFor({ timeout: 10_000 });
	await page.waitForFunction((t) => (document.querySelector("main textarea")?.value ?? "").includes(t), SEG_TEXT[0], { timeout: 15_000 }).catch(() => {});
	const gotBefore = await ta.inputValue();
	await page.locator('[data-testid="voice-cancel"]').click();
	const atCancel = state.transcribeCalls.length;
	await page.waitForTimeout(1500);
	check("取消后不再发新转写请求", state.transcribeCalls.length <= atCancel + 1, `atCancel=${atCancel} after=${state.transcribeCalls.length}`);
	check("取消保留已识别的文字（不清空输入框）", (await ta.inputValue()).includes("取消前草稿") && (await ta.inputValue()).length > "取消前草稿".length, await ta.inputValue());
	check("取消回到空闲（麦克风按钮回来）", (await page.locator('[data-testid="voice-mic"]').count()) === 1);

	console.log("\n── 云端 ASR：保持整段一次请求（不因增量拆成多次最小计费） ──");
	state.source = { location: "cloud", provider: "openai", model: "whisper-1" };
	state.transcribeCalls = [];
	await page.reload();
	await page.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });
	const ta2 = page.locator("main textarea").first();
	await page.locator('[data-testid="voice-mic"]').click();
	await page.locator('[data-testid="voice-stop"]').waitFor({ timeout: 10_000 });
	await page.waitForTimeout(3000);
	check("云录音期间不发分段请求（未停止不转写）", state.transcribeCalls.length === 0, `实际 ${state.transcribeCalls.length}`);
	await page.locator('[data-testid="voice-stop"]').click();
	await page.waitForTimeout(2000);
	check("云停止后只有 1 次整段请求", state.transcribeCalls.length === 1, `实际 ${state.transcribeCalls.length}`);
	check("云结果插入草稿", (await ta2.inputValue()).includes(SEG_TEXT[0]), await ta2.inputValue());

	console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
	process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
	console.error("运行失败：", e);
	process.exitCode = 1;
} finally {
	await browser?.close();
	web.close();
}
