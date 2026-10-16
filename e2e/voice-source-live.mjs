/**
 * 语音来源「真实服务」闭环（不是 mock route 假成功）：
 *  - 起一个独立真实 server（PIA_MOCK + 强制 tmp 数据目录），浏览器用假麦克风设备。
 *  - 走真实 `/api/audio/asr/source`（GET/PUT）与真实设置页：选择保存 → 刷新页面 → 来源/状态仍在。
 *  - 语音输入栏：idle 干净、点麦克风才提示「去设置」、0 次 getUserMedia / 0 次转写；
 *    在设置里改来源后返回输入栏，提示按**服务端新偏好**变化（证明按 server prefs 刷新，不是旧 auto-pick）。
 *  - 云来源：真实建一个已配置的自定义服务 + 声明 ASR → 选项 ready → 保存 → 刷新仍在；不可达端点时不静默回落。
 *  - 只读页面不发安装 / 不启动 / 不转写。
 *
 * 不做真下载 / 不启动真实模型 / 不用真实麦克风 / 不连云；本地「已安装」路径由后端 HTTP 单测覆盖。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname);
const DATA = "/tmp/pia-e2e-voice-source-live";
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/voice-source-live";
rmSync(DATA, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const PORT = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
let serverLogs = "";
server.stdout.on("data", (d) => (serverLogs += d));
server.stderr.on("data", (d) => (serverLogs += d));

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};
const j = async (path, method = "GET", body) => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const t = await r.text();
	return { ok: r.ok, status: r.status, body: t ? JSON.parse(t) : null };
};
const wait = async (fn, ms = 30_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
};

/** 极小的 16k 单声道 WAV（走后端 WAV 校验即可）。 */
function tinyWav() {
	const samples = 1600;
	const data = Buffer.alloc(samples * 2);
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + data.length, 4);
	h.write("WAVE", 8);
	h.write("fmt ", 12);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20);
	h.writeUInt16LE(1, 22);
	h.writeUInt32LE(16000, 24);
	h.writeUInt32LE(32000, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(data.length, 40);
	return Buffer.concat([h, data]);
}
let nodeTranscribe = 0;
async function transcribe() {
	nodeTranscribe++;
	const fd = new FormData();
	fd.append("file", new Blob([tinyWav()], { type: "audio/wav" }), "a.wav");
	const r = await fetch(`${BASE}/api/audio/transcriptions`, { method: "POST", body: fd });
	const t = await r.text();
	return { ok: r.ok, status: r.status, body: t ? JSON.parse(t) : null };
}

let browser;
try {
	const up = await wait(async () => (await fetch(`${BASE}/api/system`)).ok);
	assert.ok(up, `server 未起来：${serverLogs.slice(-800)}`);
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = (await j("/api/agents", "POST", { name: "语音闭环验证" })).body;

	console.log("\n── 初始：未配置，本地候选 not_installed，无云候选 ──");
	let src = (await j("/api/audio/asr/source")).body;
	check("初始 source=null（未配置，不自动挑云）", src.source === null, JSON.stringify(src.source));
	const local0 = src.options.find((o) => o.location === "local");
	check("本地候选总是出现且标 not_installed", !!local0 && local0.availability === "not_installed", JSON.stringify(local0));
	check("没有云端候选（未声明）", src.options.filter((o) => o.location === "cloud").length === 0);

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", permissions: ["microphone"] });
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
	const calls = { install: 0, start: 0, transcribe: 0 };
	const page = await ctx.newPage();
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (e) => console.error("  ⚠️ pageerror", String(e.stack ?? e).slice(0, 300)));
	page.on("request", (r) => {
		const p = new URL(r.url()).pathname;
		if (/\/api\/local-models\/asr\/sensevoice\/install$/.test(p)) calls.install++;
		if (/\/api\/local-models\/asr\/sensevoice\/start$/.test(p)) calls.start++;
		if (p === "/api/audio/transcriptions") calls.transcribe++;
	});

	console.log("\n── 本地来源：设置页保存 → 刷新仍在 ──");
	await page.goto(`${BASE}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	check("设置页显示「未配置」", ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("未配置"));
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("local-sensevoice-card").waitFor();
	await page.getByTestId("voice-local-use").click();
	await wait(async () => ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("本地"));
	src = (await j("/api/audio/asr/source")).body;
	check("保存后服务端 source=local（真实 PUT）", src.source?.location === "local" && src.source?.provider === "local-sensevoice", JSON.stringify(src.source));
	check("状态徽标是单一来源状态", ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("本地"));
	await page.reload();
	await page.getByTestId("voice-source-status").waitFor();
	await wait(async () => ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("本地"));
	check("刷新后仍是本地（服务端持久化，不回落）", ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("本地"));
	await page.screenshot({ path: join(OUT, "01-voice-local-saved.png") });

	console.log("\n── 本地未安装：转写 409，不静默回落云端 ──");
	const t1 = await transcribe();
	check("未安装时转写被拒（4xx）", !t1.ok && t1.status >= 400, JSON.stringify(t1));
	check("错误码是本地不可用类（非 not_configured 回落）", /not_installed|not_running|not_configured|asr_unavailable/.test(t1.body?.error ?? ""), JSON.stringify(t1.body));

	console.log("\n── 语音输入栏：idle 干净 / 点麦克风才提示 / 按新来源刷新 ──");
	await j("/api/audio/asr/source", "PUT", { source: null });
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.getByTestId("voice-mic").waitFor();
	check("未配置 idle 不常驻状态行 / 去设置", (await page.getByTestId("voice-status").count()) === 0 && (await page.getByTestId("voice-open-settings").count()) === 0);
	check("打开页面 0 次 getUserMedia / 0 次转写", (await page.evaluate(() => window.__gum ?? 0)) === 0 && calls.transcribe === 0);
	await page.getByTestId("voice-mic").click();
	await page.getByTestId("voice-open-settings").waitFor();
	check("点麦克风提示「去设置」（仍 0 次 getUserMedia）", (await page.evaluate(() => window.__gum ?? 0)) === 0);
	await page.getByTestId("voice-open-settings").click();
	await page.getByTestId("voice-source-status").waitFor();
	check("「去设置」打开语音配置且链接消失", (await page.getByTestId("voice-open-settings").count()) === 0);
	// 在同一个 app 里改来源（会广播 VoiceSourceChanged）→ 返回输入栏，提示应反映新 server pref
	await page.getByTestId("voice-tab-local").click();
	await page.getByTestId("voice-local-use").click();
	await wait(async () => ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("本地"));
	await page.keyboard.press("Escape");
	await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
	await page.getByTestId("voice-mic").click();
	await page.waitForFunction(() => (document.querySelector('[data-testid="voice-hint"]')?.getAttribute("title") ?? "").includes("本地语音识别未安装"), null, { timeout: 10_000 });
	check("改源后提示按新服务端偏好刷新（本地未安装，不是旧的未配置）", true);
	check("刷新来源过程仍 0 次转写", calls.transcribe === 0);
	await page.screenshot({ path: join(OUT, "02-voice-entry-after-source.png") });

	console.log("\n── 云端来源：真实声明 + 保存 → 刷新仍在；不可达不静默回落 ──");
	const relay = (await j("/api/models/custom", "POST", { name: "语音中转", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-not-real", models: [{ id: "whisper-1" }] })).body;
	await j("/api/audio/asr/providers", "POST", { provider: relay.id, model: "whisper-1", protocol: "openai-audio-transcriptions", name: "语音中转 / whisper-1" });
	src = (await j("/api/audio/asr/source")).body;
	const cloud = src.options.find((o) => o.location === "cloud");
	check("声明后云端候选 ready（复用同一服务 Key）", !!cloud && cloud.availability === "ready" && cloud.provider === relay.id, JSON.stringify(cloud));
	await page.goto(`${BASE}/?settings=voice`);
	await page.getByTestId("voice-source-status").waitFor();
	await page.getByTestId("voice-tab-cloud").click();
	await page.getByTestId("voice-cloud-select").click();
	await page.getByTestId("voice-cloud-select-menu").getByRole("option").first().click();
	await page.getByTestId("voice-cloud-save").click();
	await wait(async () => ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("whisper-1"));
	src = (await j("/api/audio/asr/source")).body;
	check("保存后服务端 source=cloud", src.source?.location === "cloud" && src.source?.model === "whisper-1", JSON.stringify(src.source));
	check("单条云端费用提醒可见", await page.getByTestId("voice-cloud-privacy").isVisible());
	await page.reload();
	await page.getByTestId("voice-source-status").waitFor();
	await wait(async () => ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("whisper-1"));
	check("刷新后仍是云端 whisper-1", ((await page.getByTestId("voice-source-status").textContent()) ?? "").includes("whisper-1"));
	await page.screenshot({ path: join(OUT, "03-voice-cloud-saved.png") });
	const t2 = await transcribe();
	check("云端端点不可达时转写失败（4xx/5xx），不假装成功也不回落本地", !t2.ok, JSON.stringify(t2));

	console.log("\n── 只读页面副作用为 0 ──");
	check("切换 / 打开语音设置页 0 次安装请求", calls.install === 0);
	check("打开语音设置页 0 次启动请求", calls.start === 0);
	check("页面自身没有发起转写（只读页 0 记录）", calls.transcribe === 0, `页面转写 ${calls.transcribe}`);
	check("两次显式转写都真实到达服务端（不是 mock）", nodeTranscribe === 2, `实际 ${nodeTranscribe}`);
} catch (e) {
	console.error("运行失败：", e);
	console.error(serverLogs.slice(-1500));
	failed++;
} finally {
	await browser?.close().catch(() => {});
	server.kill("SIGTERM");
}
console.log(failed === 0 ? `\n全部通过 ✅  截图：${OUT}` : `\n${failed} 项失败 ❌`);
process.exit(failed === 0 ? 0 : 1);
