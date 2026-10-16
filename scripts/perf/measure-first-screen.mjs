/**
 * 手机首屏测量：**临时合成历史 + 助理自带浏览器（Playwright）**，不读真实聊天数据、不碰用户手机。
 *
 * 用法：
 *   PIA_DATA_DIR=/tmp/xxx node scripts/perf/measure-first-screen.mjs
 * 前置：scripts/perf/seed-synthetic-history.mjs 已在该目录写入历史；apps/web 已 build（服务端托管 dist）。
 *
 * 网络/CPU 都是 **CDP 模拟**（200ms 延迟 + 1.5Mbps 下行 + 4x CPU 降速），只用于横向比较改动前后，
 * 不代表任何真实用户网络实测。输出：<DATA>/measure-first-screen.json。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const canonical = (p) => (existsSync(p) ? realpathSync(p) : resolve(p));
const trusted = [tmpdir(), "/tmp", "/private/tmp"].map(canonical);
const within = (c, p) => {
	const r = relative(p, c);
	return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const dataDir = process.env.PIA_DATA_DIR?.trim() ?? "";
if (!dataDir || !trusted.some((t) => within(canonical(dataDir), t))) throw new Error(`PIA_DATA_DIR 必须是可信临时目录：${dataDir}`);
const root = resolve(import.meta.dirname, "..", "..");
const seed = JSON.parse(readFileSync(join(dataDir, "seed.json"), "utf8"));

const port = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const base = `http://127.0.0.1:${port}`;
const srv = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
	cwd: root,
	env: { ...process.env, PIA_DATA_DIR: dataDir, PIA_WORKSPACE: join(dataDir, "workspace"), PIA_PORT: String(port), PIA_MOCK: "1", PIA_OFFLINE: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
srv.stdout.on("data", (d) => (out += d));
srv.stderr.on("data", (d) => (out += d));
for (let i = 0; ; i++) {
	if (await fetch(`${base}/api/system`).then((r) => r.ok).catch(() => false)) break;
	if (i > 250) throw new Error(`服务未就绪：\n${out.slice(-2000)}`);
	await new Promise((r) => setTimeout(r, 150));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
	isMobile: true,
	hasTouch: true,
	userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
// 模拟手机网络：200ms 延迟、1.5Mbps 下行、750kbps 上行 + 4x CPU 降速（非真实用户网络实测）
await cdp.send("Network.enable");
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 200, downloadThroughput: (1.5 * 1024 * 1024) / 8, uploadThroughput: (0.75 * 1024 * 1024) / 8 });
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

const msgsResp = [];
const t0 = Date.now();
page.on("response", (r) => {
	if (/\/api\/(agents|rooms)\/[^/]+\/messages/.test(r.url())) {
		r.body()
			.then((b) => msgsResp.push({ url: r.url().replace(base, ""), status: r.status(), bytes: b.byteLength, atMs: Date.now() - t0 }))
			.catch(() => {});
	}
});

await page.goto(base, { waitUntil: "domcontentloaded" });
const navAt = Date.now();

const poll = async (ms) => {
	const end = Date.now() + ms;
	let last = -1;
	let stableSince = 0;
	for (;;) {
		const n = await page.evaluate(() => document.querySelectorAll("[data-mid],[data-testid=steps]").length).catch(() => 0);
		if (n > 0 && n === last) {
			if (!stableSince) stableSince = Date.now();
			if (Date.now() - stableSince > 700) return { n, at: stableSince };
		} else stableSince = 0;
		last = n;
		if (Date.now() > end) return { n, at: Date.now(), timedOut: true };
		await new Promise((r) => setTimeout(r, 100));
	}
};
const firstRowMs = await (async () => {
	const end = Date.now() + 60000;
	while (Date.now() < end) {
		const n = await page.evaluate(() => document.querySelectorAll("[data-mid],[data-testid=steps]").length).catch(() => 0);
		if (n > 0) return Date.now() - navAt;
		await new Promise((r) => setTimeout(r, 50));
	}
	return null;
})();
const settled = await poll(45000);
const metrics = await page.evaluate(() => ({
	domNodes: document.getElementsByTagName("*").length,
	renderedRows: document.querySelectorAll("[data-mid],[data-testid=steps]").length,
	userBubbles: document.querySelectorAll(".pa-msg.user").length,
	botTurns: document.querySelectorAll(".pa-msg.bot").length,
	stepsBlocks: document.querySelectorAll("[data-testid=steps]").length,
	markdownBlocks: document.querySelectorAll(".prose-wrap").length,
	scrollerHeight: document.querySelector(".pa-scroll")?.scrollHeight ?? null,
	devicePixelRatio: window.devicePixelRatio,
}));

const result = {
	seed: { count: seed.count, roomCount: seed.roomCount },
	simulated: { latencyMs: 200, downloadMbps: 1.5, cpuThrottle: 4, viewport: "390x844" },
	firstRowMs,
	settledMs: settled.at - navAt,
	settledRows: settled.n,
	timedOut: !!settled.timedOut,
	metrics,
	messageResponses: msgsResp,
};
const dest = join(dataDir, "measure-first-screen.json");
writeFileSync(dest, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await browser.close();
srv.kill("SIGKILL");
process.exit(0);
