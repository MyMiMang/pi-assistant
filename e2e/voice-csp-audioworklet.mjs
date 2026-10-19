/**
 * 语音采集 / 首屏主题 与**真实服务端 CSP** 的兼容性核查（发布前平台静态核查的一部分）。
 *
 * 探针本身在 `e2e/fixtures/csp-probe.mjs`（与 `e2e/run.mjs` 的同名步骤共用一份实现）；
 * 这里负责起一个**真实 server**（真响应头）+ 真 Chromium 跑一遍，便于发布前单独复核。
 *
 * 覆盖：真实 server（Mock、临时数据目录、本机随机端口）+ 真实 Chromium：
 *  1) 页面真的加载成功（模块脚本没被 CSP 拦）、`/theme-boot.js` 生效（首屏 data-skin / data-mode 已有值）；
 *  2) 控制台没有 CSP violation、没有 pageerror；
 *  3) `audioWorklet.addModule(blob:)` 真能在该 CSP 下加载并 `AudioWorkletNode` 能创建；
 *  4) 文件预览的 `<object data="blob:" type="application/pdf">` 不被 object-src / frame-src 拦；
 *  5) 打印实际响应头里的 CSP 与探针结果，便于报告里逐条对照。
 *
 * 不碰真实麦克风（不调 getUserMedia）、不碰真实 ASR / 云、不写用户数据目录。
 * 运行前先构建：`npm run build -w @pi-assistant/web`。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { cspProblems, probeCsp } from "./fixtures/csp-probe.mjs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PIA_E2E_PORT ?? 0) || 18000 + Math.floor(Math.random() * 2000);
const DATA = mkdtempSync(join(tmpdir(), "pia-csp-"));
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
	cwd: ROOT,
	env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT), PIA_HOST_CONTROL_DRY_RUN: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (b) => (serverLog += String(b)));
server.stderr.on("data", (b) => (serverLog += String(b)));

const fail = (m) => {
	console.error(`✗ ${m}`);
	cleanup();
	process.exit(1);
};
let browser;
function cleanup() {
	try {
		browser?.close();
	} catch {}
	server.kill("SIGKILL");
	rmSync(DATA, { recursive: true, force: true });
}

async function ready() {
	for (let i = 0; i < 200; i++) {
		try {
			const r = await fetch(`${BASE}/api/system/public`);
			if (r.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`服务未就绪：\n${serverLog.slice(-2000)}`);
}

try {
	await ready();
	const res = await fetch(BASE);
	const csp = res.headers.get("content-security-policy") ?? "";
	if (!csp) fail("非 /api 响应没有 CSP 头");

	browser = await chromium.launch({
		executablePath: CHROME,
		headless: true,
		args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
	});
	const page = await browser.newPage();
	const console_msgs = [];
	const errors = [];
	page.on("console", (m) => console_msgs.push(`${m.type()}: ${m.text()}`));
	page.on("pageerror", (e) => errors.push(String(e.message ?? e)));

	await page.goto(BASE, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => !!document.querySelector("#root")?.children.length, null, { timeout: 30_000 });

	const probe = await probeCsp(page);
	const problems = cspProblems(csp, probe, console_msgs);
	console.log(JSON.stringify({ csp, probe, cspViolations: console_msgs.filter((m) => /Content Security Policy|Refused to/i.test(m)), pageErrors: errors }, null, 2));
	if (errors.length) fail(`页面报错：${errors.join(" | ")}`);
	if (problems.length) fail(problems.join("；"));
	console.log("✓ 语音 AudioWorklet(blob:) 与首屏主题在真实 CSP 下均可用");
	cleanup();
} catch (e) {
	console.error(e);
	cleanup();
	process.exit(1);
}
