// 端到端验证：启动服务（Mock 模型）→ Playwright 无头浏览器走完主要流程 → 截图 → 重启服务验证持久化。
// 用法：node e2e/run.mjs   （需要先 npm run build -w apps/web）
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { fakeHindsight } from "./fixtures/fake-hindsight.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startMockOpenAI } from "./mock-openai.mjs";
import { cspProblems, probeCsp } from "./fixtures/csp-probe.mjs";
import { startMockImages } from "./mock-images.mjs";
import { infoTab as selectInfoTab, taskTab as selectTaskTab, agentProfileSave, expandDetails, expandAgentModelSection } from "./fixtures/info-pane.mjs";

// fileURLToPath 而不是 URL.pathname：路径含空格/中文时 pathname 会保留 %20，导致子进程 cwd 与文件读取都找不到。
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = process.env.E2E_DATA ?? "/tmp/pia-e2e";
const SHOTS = join(ROOT, "docs/screenshots");
// 每次用一个空闲端口：上次没退干净的服务占着 8787 时，不会误连到旧进程（以前偶发整轮失败的原因）
const PORT = Number(process.env.E2E_PORT) || (await new Promise((r) => { const sv = createNetServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => r(p)); }); }));
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
mkdirSync(SHOTS, { recursive: true });
rmSync(DATA, { recursive: true, force: true });

let server;
let page;
process.on("exit", () => server?.kill("SIGKILL"));
const log = (...a) => console.log("[e2e]", ...a);
function startServer() {
	server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_HOST_CONTROL_DRY_RUN: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
	server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
	server.stderr.on("data", (d) => !String(d).includes("ExperimentalWarning") && process.stdout.write(`[server!] ${d}`));
	return waitFor(async () => (await fetch(`${BASE}/api/system`)).ok, 30_000);
}
async function stopServer() {
	server.kill("SIGTERM");
	await new Promise((r) => server.once("exit", r));
}
async function waitFor(fn, ms = 15_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("timeout");
}
// 下面的步骤都作用在本轮的 page 上：保留 `infoTab("资料")` / `taskTab("routines")` 这种短写法。
const infoTab = (name) => selectInfoTab(page, name);
const taskTab = (name) => selectTaskTab(page, name);
const results = [];
let AGENT = "";
async function step(name, fn) {
	// E2E_ONLY=正则：只跑首次运行向导 + 名字匹配的步骤（调试用）
	if (process.env.E2E_ONLY && results.length && !new RegExp(process.env.E2E_ONLY).test(name)) return;
	try {
		await fn();
		results.push(["✅", name]);
		log("✅", name);
	} catch (e) {
		results.push(["❌", name, String(e).slice(0, 5000)]);
		log("❌", name, e);
		await page?.screenshot({ path: `/tmp/e2e-fail-${results.length}.png` }).catch(() => {});
		if (process.env.FAIL_FAST) process.exit(1);
	}
}

await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true, colorScheme: "light" });
page = await ctx.newPage();
page.on("pageerror", (e) => log("页面错误", String(e).slice(0, 500)));
page.setDefaultTimeout(15_000);
const bubbleCount = () => page.locator("main .prose").count();
// 发送前等输入框可用；发送后确认输入框已清空（真的发出去了）。
// 页面刚加载时对话历史还在异步载入，那时填进去的字可能被重渲染冲掉——这是以前偶发失败的原因之一。
const send = async (text) => {
	const box = page.locator("main textarea:not(.pa-card textarea)");
	await box.waitFor();
	await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
	for (let i = 0; i < 3; i++) {
		await box.fill(text);
		if ((await box.inputValue()) === text) break;
	}
	await box.press("Enter");
	// 聊天里可能还有提议卡片里的 textarea，只等主输入框清空
	await page.waitForFunction(() => document.querySelector("main textarea:not(.pa-card textarea)")?.value === "", null, { timeout: 10_000 });
};

await step("首次运行向导（选择 provider → 登录 → 默认模型 → 创建第一个助理）", async () => {
	await page.goto(BASE);
	await page.getByText("欢迎使用 Pi Assistant").waitFor();
	await page.screenshot({ path: join(SHOTS, "01-onboarding-welcome.png") });
	// 「给助理安装电脑」默认推荐开启；e2e 关掉（不下载镜像），设置页里再单独验证
	const desk = page.getByTestId("onboarding-desktop");
	if (!(await desk.isChecked())) throw new Error("向导里「给助理安装电脑」应默认勾选");
	await page.getByText(/预计下载 ≈1\.5 GB，磁盘占用 ≈5 GB/).first().waitFor();
	await desk.uncheck();
	await page.getByRole("button", { name: "开始设置" }).click();
	await page.getByText("选择模型服务").first().waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "02-onboarding-providers.png") });
	const n = await page.locator("button:has-text('个模型')").count();
	if (n < 20) throw new Error(`provider 太少: ${n}`);
	// 通用地选一个同时支持 API Key 与订阅登录的 provider（不针对任何特定厂商），只看登录方式、不提交
	await page.locator("button:has-text('订阅登录')").first().click();
	const methods = page.locator("h2:has-text('登录') + div button");
	if ((await methods.count()) < 2) throw new Error("应同时显示 API Key 与订阅登录两种方式");
	await page.screenshot({ path: join(SHOTS, "03-onboarding-auth-methods.png") });
	await methods.first().click(); // API Key：Pi 通过通用交互发来 secret 提示
	await page.locator("input[type=password]").waitFor();
	await page.screenshot({ path: join(SHOTS, "03-onboarding-login.png") });
	await page.getByRole("button", { name: "上一步" }).click();
	await page.getByRole("button", { name: /Mock 模型/ }).click();
	await page.getByRole("button", { name: "下一步" }).click();
	await page.getByRole("button", { name: "测试连接" }).click();
	await page.getByText(/连接成功/).waitFor();
	await page.screenshot({ path: join(SHOTS, "03-onboarding-default-model.png") });
	await page.getByRole("button", { name: "设为默认模型" }).click();
	// 不再有预置助理：引导用户创建并命名第一个助理
	await page.getByText("创建你的第一个助理").waitFor();
	await page.getByRole("button", { name: "Nova", exact: true }).click();
	await page.getByRole("button", { name: "🦊" }).click();
	await page.waitForTimeout(200);
	await page.screenshot({ path: join(SHOTS, "03b-onboarding-create-agent.png") });
	await page.getByRole("button", { name: "创建并开始" }).click();
	await page.getByText("欢迎使用 Pi Assistant").waitFor({ state: "detached" });
	await page.locator("main").getByText("你好，我是Nova").waitFor();
	const agents = await (await fetch(`${BASE}/api/agents`)).json();
	if (agents.length !== 1 || agents[0].name !== "Nova") throw new Error(`助理列表异常: ${JSON.stringify(agents.map((a) => a.name))}`);
	AGENT = agents[0].id;
});

await step("布局：右栏默认收起 → 打开 → 拖动调整两侧宽度 → 刷新后保持 → 窄屏变覆盖抽屉 → 收起左栏", async () => {
	if (await page.locator(".pa-pane-wrap").count()) throw new Error("右侧信息面板默认应收起");
	await page.waitForTimeout(200);
	await page.screenshot({ path: join(SHOTS, "35-layout-default.png") });
	await page.getByRole("button", { name: "信息面板" }).click();
	await page.locator(".pa-pane-wrap").waitFor();
	const drag = async (sel, dx) => {
		const b = await page.locator(sel).boundingBox();
		await page.mouse.move(b.x + b.width / 2, b.y + 200);
		await page.mouse.down();
		await page.mouse.move(b.x + b.width / 2 + dx, b.y + 200, { steps: 8 });
		await page.mouse.up();
	};
	await drag(".pa-resizer.right", 60);
	await drag(".pa-resizer.left", -80);
	const lay = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.layout")));
	if (Math.abs(lay.sideW - 324) > 4 || Math.abs(lay.paneW - 420) > 4 || !lay.info) throw new Error(`布局未保存：${JSON.stringify(lay)}`);
	await page.reload();
	await page.locator(".pa-pane-wrap").waitFor();
	const w = await page.locator(".pa-app > .pa-drawer").evaluate((el) => el.getBoundingClientRect().width);
	if (Math.abs(w - 324) > 4) throw new Error(`刷新后左栏宽度应保持：${w}`);
	await page.screenshot({ path: join(SHOTS, "36-layout-resized.png") });
	// 1100px：右栏变覆盖抽屉，不挤压聊天区
	await page.setViewportSize({ width: 1100, height: 800 });
	await page.waitForTimeout(200);
	const pos = await page.locator(".pa-pane-wrap").evaluate((el) => getComputedStyle(el).position);
	if (pos !== "fixed") throw new Error("窄屏时右栏应为覆盖式抽屉");
	const chatW = await page.locator("main.pa-chat").evaluate((el) => el.getBoundingClientRect().width);
	if (chatW < 700) throw new Error(`聊天区被挤压：${chatW}`);
	await page.screenshot({ path: join(SHOTS, "37-layout-overlay.png") });
	await page.setViewportSize({ width: 1440, height: 900 });
	// 收起左栏 → 头部出现展开按钮
	await page.getByRole("button", { name: "收起助理列表" }).click();
	await page.getByRole("button", { name: "展开助理列表" }).click();
	await page.locator(".pa-app.side-docked").waitFor();
	// 恢复默认宽度，后面的截图保持一致
	await page.locator(".pa-resizer.right").dblclick();
	await page.locator(".pa-resizer.left").dblclick();
});

await step("发送消息并看到流式回复", async () => {
	await send("你好，介绍一下你自己");
	await page.locator(".caret").first().waitFor({ timeout: 10_000 });
	await page.screenshot({ path: join(SHOTS, "04-chat-streaming.png") });
	await page.locator("main").getByText("可以试试这些关键词").last().waitFor();
	await page.locator(".caret").waitFor({ state: "detached" });
});

await step("生成文件并从聊天里下载", async () => {
	await send("帮我生成一个报告文件");
	const card = page.locator("main button[title=下载]:has-text('report.md')").first();
	await card.waitFor({ timeout: 15_000 });
	const [dl] = await Promise.all([page.waitForEvent("download"), card.click()]);
	const p = await dl.path();
	const text = readFileSync(p, "utf8");
	if (!text.includes("测试报告")) throw new Error("下载内容不对");
	await page.locator("main").getByText("报告已经生成并发给你了").last().waitFor();
});

await step("触发审批卡片并批准", async () => {
	await send("帮我删除旧笔记");
	await page.locator("main").getByText("需要你的批准").last().waitFor({ timeout: 15_000 });
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "05-approval-card.png") });
	await page.getByRole("button", { name: "批准", exact: true }).click();
	await page.getByText("已删除 old-notes.txt").last().waitFor({ timeout: 15_000 });
});

await step("选项提问卡片", async () => {
	await send("问我一个问题");
	await page.getByRole("button", { name: "写周报" }).waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: "写周报" }).click();
	await page.locator("main").getByText(/你选了「写周报」/).last().waitFor({ timeout: 15_000 });
});

await step("上传文件给助理", async () => {
	const f = join(DATA, "notes.txt");
	writeFileSync(f, "这是一份上传测试文件：明天上午十点开会。");
	await page.locator("main input[type=file]").setInputFiles(f);
	await page.getByText("notes.txt").first().waitFor();
	await send("请看看这个附件");
	await page.locator("main").getByText("我读完了这个文件").last().waitFor({ timeout: 15_000 });
	// 图片：看图模型直接收到图片；文档：附上文字摘录
	await page.locator("main [data-testid=attach-input]").setInputFiles([join(import.meta.dirname, "..", "apps", "web", "public", "icon-192.png"), f]);
	await page.getByTestId("attach-chip").nth(1).waitFor();
	const tip = await page.getByTestId("attach-btn").first().getAttribute("title");
	if (!/100MB/.test(tip) || !/看图/.test(tip)) throw new Error(`附件按钮说明不完整：${tip}`);
	await send("请看看这个附件");
	await page.locator("main").getByText(/看到 1 张图片，已看到文档文字/).last().waitFor({ timeout: 15_000 });
	await page.locator("main img[alt='icon-192.png']").last().waitFor();
});

await step("后台任务", async () => {
	await send("把统计工作放到后台做");
	await page.locator("main").getByText("后台任务：统计工作区文件").last().waitFor({ timeout: 15_000 });
	await page.locator("main").getByText("已完成").first().waitFor({ timeout: 30_000 });
	await page.screenshot({ path: join(SHOTS, "06-desktop-chat.png") });
});

await step("右侧信息面板：文件 / 电脑", async () => {
	await infoTab("文件");
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(SHOTS, "07-info-files.png") });
	await infoTab("电脑");
	await page.locator("aside").last().getByText("report.md").waitFor();
});

await step("右侧信息面板标签栏自适应：240/320/420/600 宽下每个标签都可达（可见或在「更多」里），不被裁切", async () => {
	const aside = page.locator(".pa-pane-wrap");
	const want = ["overview", "models", "profile", "capabilities", "tasks", "memory", "files", "computer"];
	for (const w of [240, 320, 420, 600]) {
		await page.evaluate((w) => { const el = document.querySelector(".pa-pane-wrap"); el.style.width = `${w}px`; el.style.flex = `0 0 ${w}px`; }, w);
		await page.waitForTimeout(250);
		const r = await page.evaluate(() => {
			const bar = document.querySelector("[data-testid=info-tabs]");
			const br = bar.getBoundingClientRect();
			const vis = [...bar.querySelectorAll("[role=tab]")];
			const clipped = [...vis, ...bar.querySelectorAll("[data-more]")].filter((b) => { const r = b.getBoundingClientRect(); return r.left < br.left - 0.5 || r.right > br.right + 0.5; }).map((b) => b.textContent);
			return { vis: vis.map((b) => b.dataset.itab), more: !!bar.querySelector("[data-more]"), clipped };
		});
		if (r.clipped.length) throw new Error(`[${w}] 标签被裁切：${r.clipped}`);
		let inMenu = [];
		if (r.more) {
			await page.getByTestId("info-tabs-more").click();
			inMenu = await page.getByTestId("info-tabs-menu").locator("[role=menuitem]").evaluateAll((bs) => bs.map((b) => b.dataset.itab));
			await page.keyboard.press("Escape");
		}
		const all = [...r.vis, ...inMenu];
		for (const k of want) if (!all.includes(k)) throw new Error(`[${w}] 标签 ${k} 不可达：可见 ${r.vis} 菜单 ${inMenu}`);
		if (w === 240 && !r.more) throw new Error("240 宽应出现「更多」");
		// 选中溢出的标签 → 它变为可见
		if (inMenu.length) {
			const k = inMenu[inMenu.length - 1];
			await page.getByTestId("info-tabs-more").click();
			await page.getByTestId("info-tabs-menu").locator(`[data-itab=${k}]`).click();
			await page.locator(`[data-testid=info-tabs] [role=tab][data-itab=${k}][aria-selected=true]`).waitFor({ timeout: 2000 });
			await page.screenshot({ path: join(SHOTS, `60-info-tabs-${w}.png`) });
			await page.locator("[data-testid=info-tabs] [role=tab]").first().click();
		}
		log(`[${w}] 可见`, r.vis.join(","), "更多", inMenu.join(","));
	}
	await page.evaluate(() => { const el = document.querySelector(".pa-pane-wrap"); el.style.width = ""; el.style.flex = ""; });
	void aside;
});

let pairUrl = "";
await step("设置：模型页 + 配对二维码", async () => {
	await page.getByRole("button", { name: "设置" }).first().click();
	await page.getByText("模型服务").first().waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "08-settings-models.png") });
	await page.getByRole("button", { name: "远程访问与设备" }).click();
	await page.getByRole("button", { name: "生成配对二维码" }).click();
	await page.getByAltText("配对二维码").waitFor();
	pairUrl = await page.locator("input[readonly]").inputValue();
	await page.screenshot({ path: join(SHOTS, "09-settings-pairing.png") });
});

await step("手机配对：认领 → 电脑确认 → 获得设备 token", async () => {
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
	const pp = await phone.newPage();
	await pp.goto(pairUrl);
	await pp.getByRole("button", { name: "连接" }).click();
	await page.getByText("新设备请求连接").waitFor();
	await page.screenshot({ path: join(SHOTS, "10-device-approval.png") });
	await page.getByRole("button", { name: "允许连接" }).click();
	await pp.waitForFunction(() => JSON.parse(localStorage.getItem("pia.conn") ?? "null")?.token, null, { timeout: 10_000 });
	const conn = await pp.evaluate(() => JSON.parse(localStorage.getItem("pia.conn")));
	if (!conn?.token?.startsWith("hh_")) throw new Error("没有拿到 token");
	// 用 token 访问 API（模拟经隧道的远程请求：带转发头时必须鉴权）
	const r1 = await fetch(`${BASE}/api/agents`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
	const r2 = await fetch(`${BASE}/api/agents`, { headers: { "cf-connecting-ip": "1.2.3.4", authorization: `Bearer ${conn.token}` } });
	if (r1.status !== 401 || r2.status !== 200) throw new Error(`鉴权异常 ${r1.status} ${r2.status}`);
	await phone.close();
	await page.keyboard.press("Escape");
	await page.getByText("远程访问与设备").first().waitFor({ state: "detached" });
});

await step("免确认配对 + 固定地址设置页", async () => {
	await page.getByRole("button", { name: "设置" }).first().click();
	await page.getByRole("button", { name: "远程访问与设备" }).click();
	await page.getByTestId("pre-approved").check();
	await page.getByRole("button", { name: "生成配对二维码" }).click();
	await page.getByText("扫码即通过，无需确认").waitFor();
	const url = await page.locator("input[readonly]").inputValue();
	await page.screenshot({ path: join(SHOTS, "09b-pairing-preapproved.png") });
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale: "zh-CN" });
	const pp = await phone.newPage();
	await pp.goto(url);
	await pp.getByRole("button", { name: "连接" }).click();
	// 不在电脑上点“允许”，手机也应直接拿到 token
	await pp.waitForFunction(() => JSON.parse(localStorage.getItem("pia.conn") ?? "null")?.token, null, { timeout: 10_000 });
	// 在浏览器（非主屏 App）里配对成功：提示“添加到主屏幕后要在 App 里输入一次配对码”
	await pp.getByTestId("pair-a2hs-hint").waitFor();
	await pp.screenshot({ path: join(SHOTS, "09d-pair-done-a2hs-hint.png") });
	await phone.close();
	await page.getByRole("button", { name: "固定地址 / 入口" }).click();
	await page.getByTestId("named-tunnel").getByText("Account › Cloudflare Tunnel › Edit").first().waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "09c-named-tunnel.png") });
	await page.keyboard.press("Escape");
	await page.getByText("远程访问与设备").first().waitFor({ state: "detached" });
});

await step("主屏 App（与浏览器存储隔离）：未配对页输入配对码 → 电脑确认 → 进入助理", async () => {
	await page.getByRole("button", { name: "设置" }).first().click();
	await page.getByRole("button", { name: "远程访问与设备" }).click();
	await page.getByRole("button", { name: "生成配对二维码" }).click();
	const short = (await page.getByTestId("pair-short-code").textContent()).trim();
	if (!/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(short)) throw new Error(`配对码格式不对：${short}`);
	await page.waitForTimeout(200);
	await page.screenshot({ path: join(SHOTS, "09e-pairing-short-code.png") });
	// 模拟 iPhone 主屏 App：经隧道的远程请求（带 cf-connecting-ip）、全新存储、display-mode: standalone
	const app = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN", extraHTTPHeaders: { "cf-connecting-ip": "203.0.113.7" }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
	await app.addInitScript(() => {
		const mm = window.matchMedia.bind(window);
		window.matchMedia = (q) => (q.includes("display-mode: standalone") ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } : mm(q));
		Object.defineProperty(navigator, "standalone", { get: () => true });
	});
	try {
		const ap = await app.newPage();
		await ap.goto(BASE);
		await ap.getByTestId("unpaired").waitFor();
		await ap.getByText("主屏 App 和浏览器的登录是分开的").waitFor();
		const input = ap.getByTestId("pair-code-input");
		// 错误的码：提示失效，不会配上
		await input.fill(short.startsWith("A") ? "BBBB-CCCC" : "AAAA-CCCC");
		await ap.getByTestId("pair-code-submit").click();
		await ap.getByText("配对码不对或已失效").waitFor();
		// 小写、不带横线也能认
		await input.fill(short.toLowerCase().replace("-", ""));
		await ap.screenshot({ path: join(SHOTS, "09f-pwa-unpaired-enter-code.png") });
		await ap.getByTestId("pair-code-submit").click();
		await ap.getByText("请在电脑上点击「允许连接」").waitFor();
		await page.getByText("新设备请求连接").waitFor();
		await page.getByRole("button", { name: "允许连接" }).click();
		await ap.getByTestId("pair-done").waitFor();
		await ap.locator("main textarea").waitFor({ timeout: 15_000 });
		const conn = await ap.evaluate(() => JSON.parse(localStorage.getItem("pia.conn")));
		if (!conn?.token?.startsWith("hh_") || !conn.serverId || !conn.publicKey) throw new Error(`连接信息不完整：${JSON.stringify(conn)}`);
		await ap.waitForTimeout(400);
		await ap.screenshot({ path: join(SHOTS, "09g-pwa-paired.png") });
		// 同一个码不能再用
		const again = await fetch(`${BASE}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" }, body: JSON.stringify({ code: short, name: "x" }) });
		if (again.ok) throw new Error("配对码应只能用一次");
	} finally {
		await app.close();
	}
	await page.keyboard.press("Escape");
	await page.getByText("远程访问与设备").first().waitFor({ state: "detached" });
});

await step("手机视口截图（单栏 + 抽屉）", async () => {
	const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });
	const mp = await m.newPage();
	await mp.goto(BASE);
	await mp.getByText("后台任务：统计工作区文件").waitFor();
	await mp.waitForTimeout(500);
	await mp.screenshot({ path: join(SHOTS, "11-mobile-chat.png") });
	await mp.getByLabel("打开助理列表").click();
	await mp.waitForTimeout(400);
	await mp.screenshot({ path: join(SHOTS, "12-mobile-drawer.png") });
	await mp.goto(`${BASE}/`);
	await mp.locator("main textarea").fill("帮我删除旧笔记");
	await mp.getByLabel("发送").click();
	await mp.getByRole("button", { name: "批准", exact: true }).waitFor({ timeout: 15_000 });
	await mp.waitForTimeout(300);
	await mp.screenshot({ path: join(SHOTS, "13-mobile-approval.png") });
	await mp.getByRole("button", { name: "拒绝", exact: true }).click();
	await mp.getByText("没有获得批准").last().waitFor({ timeout: 15_000 });
	await m.close();
});

await step("设置窗口固定尺寸：切换所有标签，窗口/标签栏/每个标签按钮的位置和大小都不变（电脑 + 手机）", async () => {
	const layouts = [
		["desktop", { viewport: { width: 1440, height: 900 } }],
		["laptop", { viewport: { width: 1280, height: 640 } }],
		["mobile", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
	];
	for (const [name, opt] of layouts) {
		const c = await browser.newContext({ ...opt, colorScheme: "light", locale: "zh-CN" });
		const p = await c.newPage();
		try {
			await p.goto(`${BASE}/?settings=models`);
			const nav = p.getByTestId("settings-nav");
			await nav.waitFor();
			const keys = await nav.locator("button[data-tab]").evaluateAll((bs) => bs.map((b) => b.dataset.tab));
			if (keys.length < 10) throw new Error(`标签太少：${keys}`);
			// 按钮用 offsetLeft/offsetTop（相对标签栏，不受手机上横向滚动影响）；窗口、标签栏、内容区用屏幕坐标
			const measure = () =>
				p.evaluate(() => {
					const r = (el) => { const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10).join(","); };
					const dlg = document.querySelector("[data-testid=settings-dialog]");
					const nav = document.querySelector("[data-testid=settings-nav]");
					const content = document.querySelector("[data-testid=settings-content]");
					return { dialog: r(dlg), nav: r(nav), content: r(content), contentClientWidth: content.clientWidth, tabs: [...nav.querySelectorAll("button[data-tab]")].map((b) => `${b.dataset.tab}:${b.offsetLeft},${b.offsetTop},${b.offsetWidth},${b.offsetHeight}`).join(" ") };
				});
			let base = null;
			for (const k of [...keys, ...keys.slice().reverse()]) {
				await nav.locator(`button[data-tab=${k}]`).click();
				await p.waitForFunction((k) => document.querySelector(`[data-testid=settings-nav] button[data-tab=${k}]`)?.getAttribute("aria-current") === "page", k);
				await p.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
				await p.waitForTimeout(350);
				const m = await measure();
				if (!base) base = m;
				for (const f of Object.keys(base)) if (m[f] !== base[f]) throw new Error(`[${name}] 切到「${k}」后 ${f} 变了：${base[f]} → ${m[f]}`);
				if (k === "skills" || k === "about") {
					const shot = join(SHOTS, `55-settings-fixed-${name}-${k}.png`);
					await p.screenshot({ path: shot });
					if (name !== "laptop") await p.screenshot({ path: `/workspace/settings-fixed-${name}-${k}.png` }).catch(() => {});
				}
			}
			// 内容区内部滚动，窗口本身不滚
			const sc = await p.evaluate(() => { const c = document.querySelector("[data-testid=settings-content]"); return getComputedStyle(c).overflowY; });
			if (sc !== "auto") throw new Error(`[${name}] 内容区应 overflow-y:auto，实际 ${sc}`);
			log(`[${name}] 设置窗口`, base.dialog, "标签栏", base.nav);
		} finally {
			await c.close();
		}
	}
});

await step("外观：4 套主题 + 浅色/深色/跟随系统 + 强调色，按设备持久化", async () => {
	const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", locale: "zh-CN" });
	const p = await c.newPage();
	await p.goto(`${BASE}/?settings=appearance`);
	await p.getByRole("button", { name: "跟随系统" }).waitFor();
	const radios = p.getByRole("radio");
	if ((await radios.count()) < 4) throw new Error("应至少有 4 套主题");
	if ((await p.evaluate(() => document.documentElement.dataset.skin)) !== "noir") throw new Error("默认主题应为 noir");
	await p.waitForTimeout(400);
	await p.screenshot({ path: join(SHOTS, "16-settings-appearance.png") });
	await p.getByRole("radio", { name: "暖色人文" }).click();
	await p.getByRole("button", { name: "深色", exact: true }).click();
	await p.getByLabel("#4f6b5a").click();
	await p.waitForTimeout(300);
	await p.screenshot({ path: join(SHOTS, "16b-settings-appearance-warm-dark.png") });
	await p.goto(BASE);
	await p.locator("main textarea").waitFor();
	const st = await p.evaluate(() => ({ skin: document.documentElement.dataset.skin, mode: document.documentElement.dataset.mode, dark: document.documentElement.classList.contains("dark"), accent: document.documentElement.style.getPropertyValue("--user-acc") }));
	if (st.skin !== "warm" || st.mode !== "dark" || !st.dark || st.accent !== "#4f6b5a") throw new Error(`未持久化：${JSON.stringify(st)}`);
	// 跟随系统：系统为浅色时应为浅色
	await p.evaluate(() => localStorage.setItem("pia.theme", "system"));
	await p.reload();
	await p.locator("main textarea").waitFor();
	if (await p.evaluate(() => document.documentElement.dataset.mode !== "light")) throw new Error("跟随系统未生效");
	await c.close();
});
await step("外观 DIY：AI 生成/继续改/保存/另存 + 导入校验 + 全应用预览 + 取消恢复 + 390", async () => {
	// 前面向导失败 / 未建助理时，这里兜底建一个，保证本步能独立验证 AI 创作
	if (!AGENT) {
		const a = await (await fetch(`${BASE}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "主题测试" }) })).json();
		if (!a?.id) throw new Error(`兜底创建助理失败：${JSON.stringify(a)}`);
		AGENT = a.id;
	}
	const REQUIRED = { "--bg": "#fffdf8", "--side": "#f6f1e6", "--panel": "#f6f1e6", "--card": "#ffffff", "--fg": "#2a251f", "--mut": "#5f564b", "--mut2": "#9a8f80", "--line": "#e4dccd", "--line-strong": "#cfc4b1", "--hover": "#ebe4d6", "--active": "#e6dccb", "--user-bg": "#ece4d4", "--user-fg": "#2a251f", "--acc": "#8fd3c1", "--acc-fg": "#123123", "--acc-soft": "rgba(143,211,193,.12)", "--ok": "#5f8a5a", "--warn": "#c08a2c", "--z-light": "#ffffff", "--z-dark": "#2a251f" };
	const mk = (id, name) => ({ manifestVersion: 1, id, name, modes: { light: { ...REQUIRED }, dark: { ...REQUIRED, "--bg": "#141218", "--fg": "#f3eee6", "--z-light": "#f3eee6", "--z-dark": "#141218" } }, createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z" });
	const importFile = (p, obj) => p.getByTestId("theme-import-input").setInputFiles({ name: "t.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(obj)) });

	const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", locale: "zh-CN" });
	const p = await c.newPage();
	await p.goto(`${BASE}/?settings=appearance`);
	await p.getByTestId("open-theme-designer").waitFor();
	const before = await p.evaluate(() => document.documentElement.dataset.skin);

	// 主入口打开设计面板；已接真实后端（Mock 模型）→ AI 生成进入全应用临时预览，但不写 localStorage
	await p.getByTestId("open-theme-designer").click();
	await p.getByTestId("theme-prompt").fill("奶油底色加淡紫点缀，圆角小一点");
	await p.getByTestId("theme-generate").click();
	await p.getByTestId("theme-apply").waitFor({ timeout: 60000 });
	const aiSkin = await p.evaluate(() => document.documentElement.dataset.skin);
	if (!aiSkin.startsWith("custom-")) throw new Error(`AI 生成后应进入预览：${aiSkin}`);
	if ((await p.evaluate(() => localStorage.getItem("pia.skin"))) === aiSkin) throw new Error("AI 预览不应写 localStorage");
	// 继续修改：仍保持预览
	await p.getByTestId("theme-generate").click();
	await p.getByTestId("theme-apply").waitFor({ timeout: 60000 });
	// 取消：完整恢复（AI 预览不落库）
	await p.getByTestId("theme-cancel").click();
	if ((await p.evaluate(() => document.documentElement.dataset.skin)) !== before) throw new Error("取消应恢复原主题");
	if ((await p.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").length)) !== 0) throw new Error("取消后不应留下 AI 主题");

	// AI 生成 → 应用并保存 → 出现「我的主题」卡片
	await p.getByTestId("open-theme-designer").click();
	await p.getByTestId("theme-prompt").fill("薄荷清爽一点");
	await p.getByTestId("theme-generate").click();
	await p.getByTestId("theme-apply").waitFor({ timeout: 60000 });
	await p.getByTestId("theme-apply").click();
	await p.getByTestId("theme-designer").waitFor({ state: "detached" });
	const aiIds = await p.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
	if (aiIds.length !== 1) throw new Error(`AI 保存应产生 1 条自定义主题：${JSON.stringify(aiIds)}`);
	if ((await p.evaluate(() => document.documentElement.dataset.skin)) !== `custom-${aiIds[0]}`) throw new Error("保存后应切到 AI 主题");
	await p.getByTestId(`edit-${aiIds[0]}`).waitFor();

	// 「编辑 / 用 AI 改」：继续改已保存主题 → 保存回同一 id（不新增）
	await p.getByTestId(`edit-${aiIds[0]}`).click();
	await p.getByTestId("theme-prompt").fill("再暖一点，奶油紫");
	await p.getByTestId("theme-generate").click();
	await p.getByTestId("theme-apply").waitFor({ timeout: 60000 });
	await p.getByTestId("theme-apply").click();
	await p.getByTestId("theme-designer").waitFor({ state: "detached" });
	const afterEdit = await p.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
	if (afterEdit.length !== 1 || afterEdit[0] !== aiIds[0]) throw new Error(`AI 继续修改应更新同一主题：${JSON.stringify(afterEdit)}`);

	// 恶意 JSON：报错、不改变当前主题
	await p.getByTestId("open-theme-designer").click();
	await importFile(p, { manifestVersion: 1, id: "../etc/passwd", name: "x", modes: { light: { "--bg": "url(https://evil/x.png)" }, dark: {} } });
	await p.getByTestId("theme-errors").waitFor();
	if ((await p.evaluate(() => document.documentElement.dataset.skin)) !== `custom-${aiIds[0]}`) throw new Error("坏 JSON 不应改变当前主题");

	// 合法 JSON：进入全应用临时预览，但不写 localStorage
	await importFile(p, mk("11111111-2222-3333-4444-555555555555", "测试奶油"));
	await p.getByTestId("theme-apply").waitFor();
	const previewSkin = await p.evaluate(() => document.documentElement.dataset.skin);
	if (previewSkin !== "custom-11111111-2222-3333-4444-555555555555") throw new Error(`预览 skin 不对：${previewSkin}`);
	if ((await p.evaluate(() => localStorage.getItem("pia.skin"))) === previewSkin) throw new Error("预览不应写 localStorage");

	// 取消：完整恢复
	await p.getByTestId("theme-cancel").click();
	if ((await p.evaluate(() => document.documentElement.dataset.skin)) !== `custom-${aiIds[0]}`) throw new Error("取消应恢复原主题");

	// 再导入并「应用并保存」
	await p.getByTestId("open-theme-designer").click();
	await importFile(p, mk("11111111-2222-3333-4444-555555555555", "测试奶油"));
	await p.getByTestId("theme-apply").click();
	await p.getByTestId("theme-designer").waitFor({ state: "detached" });
	if ((await p.evaluate(() => document.documentElement.dataset.skin)) !== "custom-11111111-2222-3333-4444-555555555555") throw new Error("保存后应切到自定义主题");
	await p.getByTestId("edit-11111111-2222-3333-4444-555555555555").waitFor();

	// 刷新后仍生效（注册表在 store 初始化前安装）
	await p.reload();
	await p.getByTestId("open-theme-designer").waitFor();
	if ((await p.evaluate(() => document.documentElement.dataset.skin)) !== "custom-11111111-2222-3333-4444-555555555555") throw new Error("刷新后自定义主题丢失");

	// 编辑 → 另存为新主题 → 新 id、原主题保留
	await p.getByTestId("edit-11111111-2222-3333-4444-555555555555").click();
	await importFile(p, mk("11111111-2222-3333-4444-555555555555", "测试奶油"));
	await p.getByTestId("theme-save-as").click();
	await p.getByTestId("theme-designer").waitFor({ state: "detached" });
	const ids = await p.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
	if (ids.length !== 3 || new Set(ids).size !== 3) throw new Error(`另存为新主题应产生新 id：${JSON.stringify(ids)}`);
	const activeId = (await p.evaluate(() => document.documentElement.dataset.skin)).replace("custom-", "");
	if (!ids.includes(activeId)) throw new Error("另存后应切到新主题");

	// 390 宽度下面板可用、不横向溢出
	await p.setViewportSize({ width: 390, height: 780 });
	await p.getByTestId("open-theme-designer").click();
	await p.getByTestId("theme-prompt").waitFor();
	const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	if (overflow > 2) throw new Error(`390 下面板横向溢出 ${overflow}px`);
	await p.screenshot({ path: join(SHOTS, "16c-theme-designer-390.png") });
	await c.close();
});

await step("深色模式截图", async () => {
	const d = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", locale: "zh-CN" });
	const dp = await d.newPage();
	await dp.goto(BASE);
	await dp.getByText("后台任务：统计工作区文件").waitFor();
	await dp.waitForTimeout(500);
	await dp.screenshot({ path: join(SHOTS, "14-desktop-dark.png") });
	await d.close();
});

await step("多个助理：新建第二个助理 → 侧边栏列出 → 上传头像 / 改名", async () => {
	await page.getByRole("button", { name: "新建助理" }).first().click();
	const dlg = page.locator("div.fixed.inset-0");
	await dlg.getByPlaceholder("给助理起个名字").fill("研究员小R");
	await dlg.getByRole("button", { name: "研究员" }).click();
	await dlg.getByRole("button", { name: "🦉" }).click();
	await page.screenshot({ path: join(SHOTS, "21-new-agent.png") });
	await dlg.getByRole("button", { name: "创建", exact: true }).click();
	await page.locator("main").getByText("你好，我是研究员小R").waitFor();
	const list = await (await fetch(`${BASE}/api/agents`)).json();
	if (list.length !== 2) throw new Error(`应有 2 个助理，实际 ${list.length}`);
	// 第三个助理（纯 API），让侧边栏更像真实使用
	await fetch(`${BASE}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "写作助手", avatar: "✍️", color: "#ec4899", description: "写文章、润色、翻译" }) });
	// 编辑第二个助理：上传图片头像 + 改名（资料页显式保存；限定在可见的资料面板里，避免选到隐藏草稿）
	await infoTab("profile");
	const profilePane = page.locator(".pa-pane-wrap");
	await profilePane.getByTestId("agent-profile").waitFor();
	await profilePane.locator("[data-testid=avatar-file]").setInputFiles(join(import.meta.dirname, "..", "apps", "web", "public", "icon-192.png"));
	await profilePane.getByPlaceholder("给助理起个名字").fill("研究员 R");
	await agentProfileSave(profilePane).click();
	await page.waitForFunction(() => document.querySelector('[data-testid="agent-profile-state"]')?.textContent?.trim() === "已保存");
	const r = (await (await fetch(`${BASE}/api/agents`)).json()).find((a) => a.name === "研究员 R");
	if (!r?.avatar.startsWith("img:")) throw new Error("头像未保存为图片");
	if ((await fetch(`${BASE}/api/agents/${r.id}/avatar`)).status !== 200) throw new Error("头像图片取不到");
	await page.waitForTimeout(500);
	await page.screenshot({ path: join(SHOTS, "22-multi-agents-edit-avatar.png") });
	// 切回第一个助理
	await page.locator("aside").first().getByText("Nova").first().click();
	await page.locator("main").getByText("你好，我是Nova").waitFor();
});

let before = 0;
await step("重启服务后历史仍在 + 未完成工作自动续跑", async () => {
	before = (await (await fetch(`${BASE}/api/agents/${AGENT}/messages`)).json()).length;
	// 发起一个耗时命令，执行中途杀掉服务
	await fetch(`${BASE}/api/agents/${AGENT}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "统计工作区文件" }) });
	await new Promise((r) => setTimeout(r, 900));
	await stopServer();
	await startServer();
	await page.reload();
	await page.locator("main").getByText("服务已重启，正在继续上次未完成的工作").last().waitFor({ timeout: 15_000 });
	await page.locator("main").getByText("报告已经生成并发给你了").last().waitFor();
	const after = (await (await fetch(`${BASE}/api/agents/${AGENT}/messages`)).json()).length;
	if (after <= before) throw new Error(`消息数 ${before} → ${after}`);
	await page.waitForTimeout(3000);
	await page.screenshot({ path: join(SHOTS, "15-after-restart.png") });
});

await step("活动提示行 + 步骤列表（进行中展开、完成后自动收起）+ 小任务完成打勾", async () => {
	await page.locator("aside").first().getByText("Nova").first().click();
	await send("统计工作区文件");
	await page.locator("[data-testid=activity]").last().waitFor({ timeout: 10_000 });
	await page.locator(".pa-steps.open").last().waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "23-activity-line.png") });
	await page.locator("main").getByText("命令执行完成").last().waitFor({ timeout: 20_000 });
	await page.locator("[data-testid=activity]").waitFor({ state: "detached" });
	await page.waitForTimeout(400);
	if ((await page.locator(".pa-steps").last().getAttribute("class")).includes("open")) throw new Error("完成后步骤列表应自动收起");
	await page.locator(".pa-reaction.done").last().waitFor();
	await page.screenshot({ path: join(SHOTS, "24-steps-collapsed-check.png") });
});

await step("工作途中插话：消息立即显示、在下一个工具边界送达 → 助理回应并调整；说「停」全部停下", async () => {
	await page.locator("aside").first().getByText("Nova").first().click();
	await send("慢慢数");
	await page.locator("[data-testid=activity]").last().waitFor({ timeout: 10_000 });
	// 正在工作：输入框仍可用，发出的消息马上出现，标“等当前这一步做完送达…”
	await send("改成数到5");
	await page.locator("main").getByText("改成数到5").last().waitFor({ timeout: 3000 });
	await page.locator("[data-testid=delivery][data-state=delivered]").last().waitFor({ timeout: 15_000 });
	await page.locator("main").getByText("收到插话：改成数到5").last().waitFor({ timeout: 15_000 });
	await page.locator("[data-testid=activity]").waitFor({ state: "detached", timeout: 15_000 });
	await page.waitForTimeout(500);
	const msgs = await (await fetch(`${BASE}/api/agents/${AGENT}/messages`)).json();
	const idx = msgs.findLastIndex((m) => m.role === "user" && m.content === "改成数到5");
	if (msgs.slice(idx).some((m) => /数完了/.test(m.content))) throw new Error("插话改了方向后不应再按原计划做完");
	// 插话发出时正在进行的那一步可以做完（工具边界才送达），之后不应再开新的步骤
	if (msgs.slice(idx).filter((m) => m.role === "tool").length > 1) throw new Error("插话送达后不应再跑原来的步骤");
	await page.screenshot({ path: join(SHOTS, "95-interject-delivered.png") });
	// 停止：说「停」→ 正在跑的命令被中止，不再继续
	await send("慢慢数");
	await page.locator("[data-testid=activity]").last().waitFor({ timeout: 10_000 });
	const t0 = Date.now();
	await send("停");
	await page.locator("main").getByText("好的，已经停下了。").last().waitFor({ timeout: 5000 });
	await waitFor(async () => (await (await fetch(`${BASE}/api/agents`)).json()).find((a) => a.id === AGENT)?.status !== "running", 5000);
	if (Date.now() - t0 > 4000) throw new Error("停止太慢");
	await page.waitForTimeout(4500);
	const after = await (await fetch(`${BASE}/api/agents/${AGENT}/messages`)).json();
	const si = after.findLastIndex((m) => m.role === "user" && m.content === "停");
	if (after.slice(si).some((m) => /第[23]步|数完了/.test(m.content + JSON.stringify(m.meta?.result ?? "")))) throw new Error("停下后不应继续执行");
	if (after[si].meta?.delivery !== "stop") throw new Error("停止消息应标为 stop");
	await page.screenshot({ path: join(SHOTS, "96-interject-stop.png") });
});

await step("Phase 2：记忆（聊天里记住 → 记忆页可见/编辑）", async () => {
	await send("记住：我喜欢简洁的回答");
	await page.locator("main").getByText("好的，我记住了").last().waitFor({ timeout: 15_000 });
	const pane = page.locator("aside").last();
	await infoTab("记忆");
	await pane.getByText("我喜欢简洁的回答").waitFor();
	await pane.getByRole("button", { name: "添加记忆" }).click();
	await pane.locator("textarea:visible").fill("我在上海，时区 Asia/Shanghai");
	await pane.getByRole("button", { name: "保存", exact: true }).click();
	await pane.getByText("我在上海，时区 Asia/Shanghai").waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "25-memory-tab.png") });
});

await step("高级记忆（Hindsight）：设置三个模型 → 连接（假的远程 Hindsight）→ 助理单独切换后端 → 旧记忆补写 → 问问记忆 → 导入", async () => {
	const hs = fakeHindsight("hs-e2e-key");
	const port = await hs.start();
	const pane = page.locator("aside").last();
	try {
		const c = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: "light", locale: "zh-CN" });
		const p = await c.newPage();
		await p.goto(`${BASE}/?settings=memory`);
		const panel = p.getByTestId("hindsight-settings");
		await panel.waitFor();
		await panel.getByText("连接远程 Hindsight").click();
		await panel.getByPlaceholder("https://hindsight.example.com").fill(`http://127.0.0.1:${port}`);
		await panel.getByPlaceholder("API Key").first().fill("hs-e2e-key");
		await panel.getByTestId("hs-rr-off").click();
		await panel.getByLabel("记忆用模型").selectOption("mock/echo");
		await panel.getByRole("button", { name: "测试", exact: true }).click();
		await panel.getByText(/mock\/echo 可用/).waitFor();
		await panel.getByRole("button", { name: "保存", exact: true }).click();
		await panel.getByTestId("hs-msg").getByText(/已保存/).waitFor();
		await panel.scrollIntoViewIfNeeded();
		await p.waitForTimeout(300);
		await p.screenshot({ path: join(SHOTS, "38-settings-hindsight.png"), fullPage: true });
		await c.close();
		// 这个助理单独改用高级记忆：之前在 basic 里记下的内容自动补写进 Hindsight
		await infoTab("记忆");
		await pane.getByTestId("memory-provider").click();
		await page.getByTestId("memory-provider-option-hindsight").click();
		await pane.getByTestId("hindsight-status").getByText("高级记忆运行中").waitFor({ timeout: 20_000 });
		for (let i = 0; i < 40 && ![...hs.banks.values()].some((d) => [...d.values()].includes("我喜欢简洁的回答")); i++) await page.waitForTimeout(250);
		if (![...hs.banks.values()].some((d) => [...d.values()].includes("我喜欢简洁的回答"))) throw new Error("旧记忆没有补写进 Hindsight");
		await pane.getByPlaceholder(/问问记忆/).fill("我喜欢什么样的回答");
		await pane.getByPlaceholder(/问问记忆/).press("Enter");
		await pane.getByTestId("reflect-answer").getByText(/根据记忆：.*简洁/).waitFor();
		// 导入（统一格式，可来自另一个后端或另一台电脑）
		const data = { format: "pi-assistant-memory/1", bank: "x", items: [{ id: "x1", text: "我每周五下午健身", createdAt: new Date().toISOString(), meta: { kind: "fact" } }] };
		await pane.getByTestId("memory-import").setInputFiles({ name: "memory.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });
		await pane.getByText("已导入 1 条").waitFor();
		await pane.getByText("我每周五下午健身").waitFor();
		for (let i = 0; i < 40 && ![...hs.banks.values()].some((d) => [...d.values()].includes("我每周五下午健身")); i++) await page.waitForTimeout(250);
		if (![...hs.banks.values()].some((d) => [...d.values()].includes("我每周五下午健身"))) throw new Error("导入的记忆没有写进 Hindsight");
		await page.waitForTimeout(300);
		await page.screenshot({ path: join(SHOTS, "39-memory-hindsight.png") });
	} finally {
		// 后面的步骤继续用基础记忆
		await pane.getByTestId("memory-provider").click().catch(() => {});
		await page.getByTestId("memory-provider-option-").click().catch(() => {});
		await hs.stop();
	}
});

await step("Phase 2：定时任务（助理创建需审批 → 定时任务页 → 立即运行 → 运行历史）", async () => {
	await send("每天早上 8 点给我一份简报");
	await page.locator("main").getByText("需要你的批准").last().waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: "批准", exact: true }).last().click();
	await page.locator("main").getByText("定时任务设好了").last().waitFor({ timeout: 15_000 });
	const pane = page.locator("aside").last();
	await taskTab("routines");
	const item = pane.locator("[data-testid=routine-item]").first();
	await item.getByText("每日简报").waitFor();
	await item.getByText("每天 08:00").waitFor();
	await item.getByRole("button", { name: "运行" }).click();
	await item.getByText(/上次：/).waitFor({ timeout: 15_000 });
	await item.getByText("完成").first().waitFor({ timeout: 30_000 });
	await item.getByText("运行历史").click();
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(SHOTS, "26-routines-tab.png") });
	await pane.getByRole("button", { name: "新建" }).click();
	await pane.locator("[data-testid=routine-form]").getByText(/下次/).waitFor();
	await page.screenshot({ path: join(SHOTS, "26b-routine-form.png") });
	await pane.getByRole("button", { name: "取消" }).click();
});

await step("Phase 2：技能（聊天里存成技能 → 设置 › 技能库）", async () => {
	await send("把刚才的流程存成技能");
	await page.locator("main").getByText("已经存成技能了").last().waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: "设置" }).first().click();
	await page.getByRole("button", { name: "技能库" }).click();
	await page.locator("[data-testid=skills-tab]").getByText("daily-brief").waitFor();
	await page.locator("[data-testid=skills-tab]").getByText("web-research").waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "27-skills.png") });
	await page.locator("[data-testid=skills-tab]").getByText("daily-brief").click();
	await page.getByText("每日简报").first().waitFor();
	await page.screenshot({ path: join(SHOTS, "27b-skill-detail.png") });
	await page.keyboard.press("Escape");
});

await step("技能建议：多步任务完成后问“要不要做成技能？” → 同意 → 助理查重后创建", async () => {
	await send("帮我做一下月度汇总");
	await page.locator("main").getByText("月度汇总做好了").last().waitFor({ timeout: 20_000 });
	await page.getByRole("button", { name: "做成技能" }).last().waitFor({ timeout: 10_000 });
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "29-skill-suggestion.png") });
	await page.getByRole("button", { name: "做成技能" }).last().click();
	await page.locator("main").getByText(/存好了.*monthly-summary/).last().waitFor({ timeout: 20_000 });
	const s = await (await fetch(`${BASE}/api/skills/monthly-summary`)).json();
	if (!s.body?.includes("月度汇总")) throw new Error("技能没有创建");
});

await step("技能更新：diff 审批卡片 → 批准 → 版本历史 → 回滚", async () => {
	await send("把技能 daily-brief 改成五条以内的要点");
	const card = page.locator("[data-testid=approval-card]").last();
	await card.locator("[data-testid=diff]").waitFor({ timeout: 15_000 });
	await card.locator("[data-testid=diff] .add").first().waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "30-skill-diff-approval.png") });
	await card.getByRole("button", { name: "批准", exact: true }).click();
	await page.locator("main").getByText("技能更新好了").last().waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: "设置" }).first().click();
	await page.getByRole("button", { name: "技能库" }).click();
	await page.locator("[data-testid=skills-tab]").getByText("daily-brief").click();
	const hist = page.locator("[data-testid=skill-versions]");
	await hist.getByText("v2").waitFor();
	await hist.getByText("v2").click();
	await hist.locator("[data-testid=diff] .add").first().waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "31-skill-versions.png") });
	page.once("dialog", (d) => d.accept());
	await hist.getByRole("button", { name: /回滚到此版本/ }).first().click();
	await hist.getByText("v3").waitFor();
	const sk = await (await fetch(`${BASE}/api/skills/daily-brief`)).json();
	if (sk.body.includes("五条以内")) throw new Error("回滚没生效");
	await page.keyboard.press("Escape");
});

await step("扩展：添加 MCP 服务（本机命令）→ 测试连接/工具列表 → 助理调用只读工具 → 有副作用的工具需审批", async () => {
	await page.getByRole("button", { name: "设置" }).first().click();
	await page.getByRole("button", { name: "扩展（MCP）" }).click();
	const tab = page.locator("[data-testid=extensions-tab]");
	await tab.getByRole("button", { name: "添加" }).click();
	const form = tab.locator("[data-testid=mcp-form]");
	await form.getByPlaceholder("github", { exact: true }).fill("demo");
	await form.getByPlaceholder("npx", { exact: true }).fill(process.execPath);
	await form.getByPlaceholder("-y @modelcontextprotocol/server-github", { exact: true }).fill(join(ROOT, "e2e/fixtures/mock-mcp.mjs"));
	await form.getByPlaceholder("查询和管理 GitHub 仓库、Issue、PR").fill("测试用天气与便签服务");
	await form.getByRole("button", { name: "保存并测试连接" }).click();
	const item = tab.locator("[data-testid=mcp-item]").first();
	await item.getByText("已连接 · 2 个工具").waitFor({ timeout: 20_000 });
	await item.getByText("工具列表").click();
	await item.locator("[data-testid=mcp-tools]").getByText("get_weather").waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "32-settings-mcp.png") });

	const pk = page.locator("[data-testid=packages-section]");
	await pk.getByPlaceholder(/npm:@scope/).fill(join(ROOT, "e2e/fixtures/demo-pi-package"));
	await pk.getByRole("button", { name: "安装" }).click();
	await pk.locator("[data-testid=package-item]").getByText("已安装").waitFor({ timeout: 20_000 });
	await pk.getByText(/扩展 1/).waitFor();
	await pk.scrollIntoViewIfNeeded();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "33-settings-pi-packages.png") });

	// npx 型 MCP：保存后预先下载到本机，统一下载组件里能看到进度并变成“已下载”，之后用装好的可执行文件连接
	const mem = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "memory", config: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } }) }).then((r) => r.json());
	const row = page.locator(`[data-testid=download-row][data-id="mcp:${mem.id}"]`);
	await row.waitFor({ timeout: 20_000 });
	await page.locator(`[data-testid=download-row][data-id="mcp:${mem.id}"][data-state=ready]`).waitFor({ timeout: 180_000 });
	await tab.locator("[data-testid=mcp-item]").filter({ hasText: "memory" }).getByText(/已连接 · \d+ 个工具/).waitFor({ timeout: 60_000 });
	await row.scrollIntoViewIfNeeded();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "66-mcp-download.png") });
	await fetch(`${BASE}/api/mcp/${mem.id}`, { method: "DELETE" });
	await page.keyboard.press("Escape");

	await send("查一下上海天气");
	await page.locator("main").getByText(/晴，22°C（mock-mcp）/).last().waitFor({ timeout: 30_000 });
	await send("给小王发一条便签");
	const card = page.locator("[data-testid=approval-card]").last();
	await card.getByText("mcp__demo__send_note").first().waitFor({ timeout: 20_000 });
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "34-mcp-approval.png") });
	await card.getByRole("button", { name: "拒绝" }).click();
	await page.locator("main").getByText("没有获得批准，便签没有发送").last().waitFor({ timeout: 15_000 });

	// 能力页里按助理启用
	const pane = page.locator("aside").last();
	await infoTab("capabilities");
	await pane.locator("[data-testid=agent-extensions]").getByText("demo", { exact: true }).waitFor();
});

await step("Phase 2：多对话（新对话 → 切回旧对话历史仍在）", async () => {
	await page.locator("[data-testid=conv-menu]").click();
	await page.getByRole("button", { name: /新对话/ }).first().click();
	await page.locator("main").getByText("我喜欢简洁的回答").waitFor({ state: "detached" });
	await send("你好");
	await page.locator("main").getByText("可以试试这些关键词").last().waitFor({ timeout: 15_000 });
	await page.locator("[data-testid=conv-menu]").click();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "28-conversations.png") });
	await page.getByRole("menu").getByText(/你好，介绍一下你自己/).first().click();
	await page.locator("main").getByText("我喜欢简洁的回答").first().waitFor();
});

await step("四套主题截图（桌面浅色/深色 + 手机）", async () => {
	mkdirSync(join(SHOTS, "themes"), { recursive: true });
	for (const skin of ["glass", "warm", "pixel", "noir"]) {
		for (const [mode, vp] of [["light", { width: 1440, height: 900 }], ["dark", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
			const m = mode === "mobile" ? (skin === "noir" ? "dark" : "light") : mode;
			const c = await browser.newContext({ viewport: vp, deviceScaleFactor: mode === "mobile" ? 2 : 1, colorScheme: m, locale: "zh-CN", isMobile: mode === "mobile", hasTouch: mode === "mobile" });
			await c.addInitScript(([s, t]) => {
				localStorage.setItem("pia.skin", s);
				localStorage.setItem("pia.theme", t);
				localStorage.removeItem("pia.accent");
			}, [skin, m]);
			const p = await c.newPage();
			await p.goto(`${BASE}/?agent=${AGENT}`);
			await p.locator("main textarea").waitFor();
			await p.locator("main").getByText("命令执行完成").last().waitFor();
			if ((await p.evaluate(() => document.documentElement.dataset.skin)) !== skin) throw new Error(`主题未生效：${skin}`);
			await p.waitForTimeout(700);
			await p.screenshot({ path: join(SHOTS, "themes", `${skin}-${mode === "mobile" ? "mobile" : `desktop-${mode}`}.png`) });
			await c.close();
		}
	}
});

await step("自定义模型服务（中转站）：自动获取模型 → 保存 → 测试连接 → 用它聊天 → 编辑 → 删除", async () => {
	const relay = await startMockOpenAI({ key: "sk-relay-test", requiredHeader: ["x-relay-team", "e2e"] });
	try {
		const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", locale: "zh-CN" });
		const p = await c.newPage();
		await p.goto(`${BASE}/?settings=models`);
		await p.getByRole("button", { name: /添加自定义服务/ }).click();
		const f = p.getByTestId("custom-provider-form");
		await f.getByPlaceholder("例如：我的中转站").fill("我的中转站");
		await f.getByLabel("API 类型").selectOption("openai-completions");
		await f.getByPlaceholder("https://api.example.com/v1").fill(relay.url);
		await f.getByPlaceholder("sk-…").fill("sk-relay-test");
		await f.getByRole("button", { name: "添加", exact: true }).first().click();
		await f.getByPlaceholder("Header 名称").fill("x-relay-team");
		await f.getByPlaceholder("值").fill("e2e");
		await f.getByRole("button", { name: "自动获取" }).click();
		await f.getByText("获取到 2 个模型").waitFor();
		await f.getByRole("button", { name: "relay-chat", exact: true }).click();
		await f.getByPlaceholder("手动输入模型 ID，回车添加").fill("relay-manual");
		await f.getByPlaceholder("手动输入模型 ID，回车添加").press("Enter");
		await f.getByRole("button", { name: "保存", exact: true }).click();
		await f.getByText("已保存：我的中转站").waitFor();
		// 每个模型显示上下文 / 最大输出和来源：relay-chat 由模型列表接口识别（64K），手动加的 relay-manual 用默认（128K / 8K）
		await f.locator("[data-testid=custom-model-row][data-model=relay-chat] [data-testid=limits-source]").getByText("自动识别").waitFor();
		const lt = async (id) => (await f.locator(`[data-testid=custom-model-row][data-model="${id}"] [data-testid=limits-text]`).textContent())?.trim();
		if ((await lt("relay-chat")) !== "64K 上下文 · 4K 输出") throw new Error(`relay-chat 上下文没识别出来：${await lt("relay-chat")}`);
		await f.locator("[data-testid=custom-model-row][data-model=relay-manual] [data-testid=limits-source]").getByText("自动（默认）").waitFor();
		if (!(await lt("relay-manual"))?.startsWith("256K 上下文 · 128K 输出")) throw new Error(`默认不是 256K / 128K：${await lt("relay-manual")}`);
		// 点数值展开编辑：预设 + 带单位输入（1m），来源变“手动”；恢复自动后回到默认
		await f.getByRole("button", { name: "编辑 relay-manual 的上下文和输出长度" }).click();
		const ed = f.locator("[data-testid=custom-model-row][data-model=relay-manual] [data-testid=custom-model-editor]");
		await ed.getByTestId("ctx-input").fill("1m");
		await ed.getByTestId("ctx-input").press("Enter");
		await ed.getByRole("button", { name: "16K", exact: true }).click();
		if ((await lt("relay-manual")) !== "1M 上下文 · 16K 输出") throw new Error(`编辑没生效：${await lt("relay-manual")}`);
		await f.locator("[data-testid=custom-model-row][data-model=relay-manual] [data-testid=limits-source]").getByText("手动").waitFor();
		await ed.getByText("恢复自动").click();
		await f.getByRole("button", { name: "测试连接" }).click();
		await f.getByText(/连接成功：中转站回复/).waitFor();
		// 很长的模型 ID 在各种宽度下：模型名一定看得见（截断而不是被挤没），整行不溢出
		const longIds = ["deepseek-ai/DeepSeek-V4.1-Flash-Vision-Experimental-2026-10-01-extra-long-suffix", "accounts/fireworks/models/qwen3p8-2p4t-a95b-instruct-preview"];
		for (const id of longIds) {
			await f.getByPlaceholder("手动输入模型 ID，回车添加").fill(id);
			await f.getByPlaceholder("手动输入模型 ID，回车添加").press("Enter");
		}
		for (const w of [1440, 1024, 760, 390]) {
			await p.setViewportSize({ width: w, height: 900 });
			await p.waitForTimeout(250);
			const bad = await f.locator("[data-testid=custom-models]").evaluate((list) => {
				const lr = list.getBoundingClientRect();
				const out = [];
				if (list.scrollWidth > list.clientWidth + 1) out.push("列表横向溢出");
				for (const row of list.querySelectorAll("[data-testid=custom-model-row]")) {
					const n = row.querySelector("[data-testid=custom-model-name]").getBoundingClientRect();
					const l = row.querySelector("[data-testid=custom-model-limits]").getBoundingClientRect();
					if (n.width < 80 || n.height < 10) out.push(`${row.dataset.model} 名字宽 ${n.width}`);
					if (n.right > lr.right + 1 || l.right > lr.right + 1) out.push(`${row.dataset.model} 超出`);
				}
				return out;
			});
			if (bad.length) throw new Error(`宽度 ${w}：${bad.join("；")}`);
			if (w === 1024) await p.screenshot({ path: join(SHOTS, "17b-custom-models-1024.png") });
			if (w === 390) await p.screenshot({ path: join(SHOTS, "17c-custom-models-390.png") });
		}
		await p.setViewportSize({ width: 1440, height: 900 });
		for (const id of longIds) await f.getByRole("button", { name: `移除 ${id}` }).click();
		await p.waitForTimeout(300);
		await p.screenshot({ path: join(SHOTS, "17-settings-custom-provider.png") });
		const cfg = readFileSync(join(DATA, "models.json"), "utf8");
		if (!cfg.includes("custom-") || cfg.includes("sk-relay-test") || cfg.includes('"e2e"')) throw new Error("models.json 内容不对（Key/请求头值不应明文出现）");
		// 返回列表，自定义服务带“自定义”标记
		await p.getByRole("button", { name: "← 返回列表" }).click();
		await p.locator("button:has-text('我的中转站')").filter({ hasText: "自定义" }).first().waitFor();
		// 设为默认模型并用它聊天（流式经过中转站）
		const cid = (await (await fetch(`${BASE}/api/models/custom`)).json()).providers[0].id;
		// 模型是按助理保存的（输入框工具栏的模型选择器做的就是这个 PATCH）
		const r = await fetch(`${BASE}/api/agents/${AGENT}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { provider: cid, id: "relay-chat" } }) });
		if (!r.ok) throw new Error(`切换助理模型失败 ${r.status}`);
		await c.close();
		await page.goto(BASE);
		// 等输入框工具栏的模型选择器显示新模型再发
		await page.locator("[data-testid=model-picker]").getByText("relay-chat").waitFor({ timeout: 15_000 }).catch(() => {});
		await send("你好，中转站");
		await page.locator("main").getByText("中转站回复（relay-chat）：收到「你好，中转站」").last().waitFor({ timeout: 30_000 });
		await page.locator("header").getByText("正在工作").waitFor({ state: "detached" }).catch(() => {});
		await page.waitForTimeout(500);
		if (!relay.seen.some((x) => x.url === "/v1/chat/completions" && x.headers["x-relay-team"] === "e2e")) throw new Error("请求没有带上自定义请求头");
		await page.screenshot({ path: join(SHOTS, "18-chat-via-custom-provider.png") });
		// 输入框旁的上下文圆环用的就是这个模型的上下文长度（自动压缩也按它）
		await page.locator("[data-testid=context-ring]").click();
		await page.locator("[data-testid=context-pop]").getByText(/\/ 65\.5k/).waitFor({ timeout: 10_000 });
		await page.locator("[data-testid=context-ring]").click();
		// 编辑后删除
		const list = await (await fetch(`${BASE}/api/models/custom`)).json();
		const id = list.providers[0].id;
		const put = await fetch(`${BASE}/api/models/custom/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "中转站 B", api: "openai-completions", baseUrl: relay.url, headers: [{ name: "x-relay-team" }], models: [{ id: "relay-pro" }] }) });
		if (!put.ok) throw new Error(`编辑失败 ${await put.text()}`);
		const t = await (await fetch(`${BASE}/api/models/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: id, model: "relay-pro" }) })).json();
		if (!t.ok) throw new Error(`编辑后测试失败：${t.message}`);
		await fetch(`${BASE}/api/models/custom/${id}`, { method: "DELETE" });
		const after = await (await fetch(`${BASE}/api/models/providers`)).json();
		if (after.some((x) => x.id === id)) throw new Error("删除后仍在列表里");
	} finally {
		relay.close();
		await fetch(`${BASE}/api/agents/${AGENT}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { provider: "mock", id: "echo" } }) }).catch(() => {});
	}
});

await step("多个自定义服务（中文名）：各自独立 id；默认模型、“当前”、输入框模型菜单都显示用户起的服务名并按服务分组", async () => {
	const relay = await startMockOpenAI({ key: "sk-two" });
	const before = (await (await fetch(`${BASE}/api/system`)).json()).defaultModel;
	const ids = [];
	try {
		for (const name of ["灯灯国产", "另一家中转"]) {
			const r = await fetch(`${BASE}/api/models/custom`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, api: "openai-completions", baseUrl: relay.url, apiKey: "sk-two", models: [{ id: "relay-chat" }] }) });
			if (!r.ok) throw new Error(`添加 ${name} 失败：${await r.text()}`);
			ids.push((await r.json()).id);
		}
		if (ids[0] === ids[1] || ids.includes("custom-provider")) throw new Error(`自定义服务 id 冲突：${ids}`);
		const list = (await (await fetch(`${BASE}/api/models/custom`)).json()).providers;
		if (!ids.every((id) => list.some((x) => x.id === id))) throw new Error("有一个自定义服务被覆盖了");
		const ms = await (await fetch(`${BASE}/api/models`)).json();
		if (ms.find((m) => m.provider === ids[0])?.providerName !== "灯灯国产") throw new Error("模型列表没带服务名");

		const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", locale: "zh-CN" });
		const p = await c.newPage();
		await p.goto(`${BASE}/?settings=models`);
		await p.getByTestId("default-model-picker").click();
		const dmenu = p.getByTestId("default-model-menu");
		await dmenu.waitFor();
		const groups = await dmenu.locator('[data-testid^="default-model-group-"]').allTextContents();
		if (!groups.some((t) => t.includes("灯灯国产")) || !groups.some((t) => t.includes("另一家中转"))) throw new Error(`默认模型菜单没按服务分组：${groups}`);
		if ((await dmenu.innerText()).includes("custom-")) throw new Error("默认模型菜单里出现了内部 id");
		await dmenu.getByTestId("default-model-search").fill("relay-chat");
		await dmenu.locator(`[data-testid="default-model-option"][data-model="${ids[1]}/relay-chat"]`).click();
		await p.waitForFunction(() => (document.querySelector('[data-testid="default-model-picker"]')?.textContent ?? "").includes("另一家中转 / relay-chat"), null, { timeout: 10_000 });
		await p.screenshot({ path: join(SHOTS, "70-custom-providers-names.png") });
		await c.close();

		await page.goto(BASE);
		await page.locator("[data-testid=model-picker]").click();
		const menu = page.locator("[data-testid=model-menu]");
		await menu.getByText("灯灯国产", { exact: true }).waitFor();
		await menu.getByText("另一家中转", { exact: true }).waitFor();
		if ((await menu.innerText()).includes("custom-")) throw new Error("模型菜单里出现了内部 id");
		await page.locator("[data-testid=model-picker]").click();
	} finally {
		await fetch(`${BASE}/api/models/default`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: before?.provider ?? "mock", model: before?.id ?? "echo" }) }).catch(() => {});
		for (const id of ids) await fetch(`${BASE}/api/models/custom/${id}`, { method: "DELETE" });
		relay.close();
	}
});

await step("分类器元数据：自定义渠道声明 Jev 分类器 → 目录可见、非法协议被拒（电脑快速操作选择器已撤下，不再有设置入口）", async () => {
	const relay = await startMockOpenAI({ key: "sk-fast" });
	let id;
	try {
		const r = await fetch(`${BASE}/api/models/custom`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "快速中转", api: "openai-completions", baseUrl: relay.url, apiKey: "sk-fast", models: [{ id: "relay-chat" }], classifiers: [{ protocol: "typesafe-system-one", modelId: "jev-relay" }] }) });
		if (!r.ok) throw new Error(`添加自定义渠道失败：${await r.text()}`);
		id = (await r.json()).id;
		const reg = await (await fetch(`${BASE}/api/models/registry`)).json();
		const prov = reg.providers.find((p) => p.id === id);
		const cls = prov?.models?.find((m) => m.id === "jev-relay");
		if (!cls || !cls.capabilities.includes("classifier")) throw new Error("自定义 classifier 没进统一目录或能力缺失");
		// 非法协议被拒（通用分类器校验仍在，不因撤下选择器而放松）
		const bad = await fetch(`${BASE}/api/models/custom/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "快速中转", api: "openai-completions", baseUrl: relay.url, models: [{ id: "relay-chat" }], classifiers: [{ protocol: "nope", modelId: "x" }] }) });
		if (bad.status !== 400) throw new Error("非法 classifier 协议应 400");
	} finally {
		if (id) await fetch(`${BASE}/api/models/custom/${id}`, { method: "DELETE" }).catch(() => {});
		relay.close();
	}
});

// ================================================================ Phase 3
await step("助理电脑开箱即用：向导没开启时什么都不下载；「电脑」标签显示未安装 → 去设置；设置里开关说明、运行方式、空闲关机、镜像加速", async () => {
	const g0 = await (await fetch(`${BASE}/api/desktop`)).json();
	if (g0.settings.enabled || g0.install.phase !== "idle") throw new Error(`向导没勾选却开启/下载了：${JSON.stringify(g0)}`);
	await page.goto(BASE);
	await page.locator("main textarea").waitFor();
	await page.waitForTimeout(500); // 等信息面板按记住的布局渲染完再判断开没开
	if (!(await page.locator(".pa-pane-wrap").count())) await page.getByRole("button", { name: "信息面板" }).click();
	await infoTab("电脑");
	const ni = page.getByTestId("desktop-not-installed");
	await ni.getByText("未安装，去设置安装").waitFor();
	await page.screenshot({ path: join(SHOTS, "58-desktop-not-installed.png") });
	await ni.getByRole("button", { name: "去设置" }).click();
	const ds = page.getByTestId("desktop-settings");
	await ds.waitFor();
	if (!(await page.getByTestId("settings-nav").locator("button[data-tab=computer]").getAttribute("aria-current"))) throw new Error("没有跳到「助理电脑」标签");
	await ds.getByTestId("desktop-cost").getByText(/≈1\.5 GB.*≈5 GB.*3–4 GB/).waitFor();
	if (await ds.getByTestId("desktop-enabled").isChecked()) throw new Error("开关应为关闭");
	await ds.getByTestId("desktop-idle").click();
	await page.getByTestId("desktop-idle-option-30").click();
	await page.waitForFunction(async (b) => (await (await fetch(`${b}/api/desktop`)).json()).settings.idleMinutes === 30, BASE);
	await ds.getByTestId("desktop-mirror").fill("https://ghcr.nju.edu.cn/");
	await ds.getByRole("button", { name: "保存" }).click();
	await ds.getByText("ghcr.nju.edu.cn/mymimang/pi-assistant-desktop", { exact: false }).waitFor();
	await ds.getByTestId("desktop-backend-docker").click();
	await page.waitForFunction(async (b) => (await (await fetch(`${b}/api/desktop`)).json()).settings.backend === "docker", BASE);
	await page.screenshot({ path: join(SHOTS, "59-settings-desktop.png") });
	const bad = await fetch(`${BASE}/api/desktop`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ idleMinutes: 7 }) });
	if (bad.status !== 400) throw new Error("非法空闲时间应被拒绝");
	const g1 = await (await fetch(`${BASE}/api/desktop`)).json();
	if (g1.settings.enabled || g1.install.phase !== "idle") throw new Error("改设置不应触发下载");
	// 恢复默认，避免影响后面的步骤
	await fetch(`${BASE}/api/desktop`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "auto", idleMinutes: 10, mirror: "" }) });
	await page.keyboard.press("Escape");
});
const openPane = async (tab) => {
	if (!(await page.locator(".pa-pane-wrap").count())) await page.getByRole("button", { name: "信息面板" }).click();
	await infoTab(tab);
};
const SHOP = `data:text/html;charset=utf-8,${encodeURIComponent(`<title>测试商店</title><body style="font-family:sans-serif;padding:40px"><h1>测试商店 · 结算</h1><p>无线耳机 × 1　¥199</p><form onsubmit="document.body.innerHTML='<h1>下单成功</h1>';return false"><label>收货人 <input name="n" value="邓邓"></label><br><br><button type="submit">提交订单</button></form></body>`)}`;
await step("Phase 3 浏览器：助理打开网页（有 Docker 时在「电脑」实时画面里）→ 点「提交订单」需审批 → 拒绝不提交 → 本任务内都允许", async () => {
	if (process.env.E2E_DESKTOP) {
		await fetch(`${BASE}/api/desktop`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, backend: "docker" }) });
		const r = await fetch(`${BASE}/api/agents/${AGENT}/desktop/start`, { method: "POST" });
		if (!r.ok) throw new Error(`助理电脑启动失败：${await r.text()}`);
	}
	await page.goto(BASE);
	await send(`用浏览器打开 ${SHOP} 然后提交订单`);
	const card = page.locator("[data-testid=approval-card]").last();
	await card.getByText(/提交订单/).first().waitFor({ timeout: 60_000 });
	if (process.env.E2E_DESKTOP) {
		await openPane("电脑");
		await page.locator("[data-testid=desktop-view] canvas").first().waitFor({ timeout: 30_000 });
		await page.waitForTimeout(4000);
	}
	await page.screenshot({ path: join(SHOTS, "40-browser-submit-approval.png") });
	await card.getByRole("button", { name: "拒绝" }).click();
	await page.locator("main").getByText("好的，没有提交。").last().waitFor({ timeout: 20_000 });
	await send(`用浏览器打开 ${SHOP} 然后提交订单`);
	const card2 = page.locator("[data-testid=approval-card]").last();
	await card2.getByRole("button", { name: "本任务内都允许" }).click({ timeout: 60_000 });
	await page.locator("main").getByText(/已提交 ✅/).last().waitFor({ timeout: 30_000 });
	if (process.env.E2E_DESKTOP) {
		await page.waitForTimeout(2500);
		await page.screenshot({ path: join(SHOTS, "41-browser-live-view.png") });
	}
});

await step("助理电脑关机时：助理自己开机（computer_open）并在同一轮里用电脑工具（cua-driver MCP + 看屏幕），截图不是空白", async () => {
	if (!process.env.E2E_DESKTOP) return log("跳过（需要 E2E_DESKTOP=1 和 Docker）");
	await fetch(`${BASE}/api/desktop`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, backend: "docker" }) });
	// 已安装（镜像在本机）但关着机：先开一次确保装好，再关机
	const r0 = await fetch(`${BASE}/api/agents/${AGENT}/desktop/start`, { method: "POST" });
	if (!r0.ok) throw new Error(`助理电脑启动失败：${await r0.text()}`);
	await fetch(`${BASE}/api/agents/${AGENT}/desktop/stop`, { method: "POST" });
	const st0 = await fetch(`${BASE}/api/agents/${AGENT}/desktop`).then((r) => r.json()).catch(() => ({}));
	if (st0.state === "running") throw new Error("测试前助理电脑应该是关机状态");
	await page.goto(BASE);
	await send("打开你的电脑看看屏幕");
	await page.locator("main").getByText(/电脑开好了，屏幕信息：.*\d{3,4}x\d{3,4}/).last().waitFor({ timeout: 60_000 }).catch(async (e) => {
		await page.screenshot({ path: join(SHOTS, "65-computer-open-same-turn-fail.png") });
		throw e;
	});
	const txt = await page.locator("main").getByText(/电脑开好了，屏幕信息：.*\d{3,4}x\d{3,4}/).last().innerText();
	log("同一轮结果：", txt);
	if (/未知|error|错误|not found|找不到|unknown/i.test(txt) || !/\d{3,4}/.test(txt)) throw new Error(`电脑工具没有在同一轮可用：${txt}`);
	const png = await fetch(`${BASE}/api/agents/${AGENT}/desktop/screenshot`).then((r) => r.arrayBuffer());
	if (png.byteLength < 5000) throw new Error(`截图像是空白的（${png.byteLength} 字节）`);
	// 操作记录里有这次的 MCP 调用
	const acts = await fetch(`${BASE}/api/actions?target=sandbox&limit=20`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
	if (acts && JSON.stringify(acts).length && !JSON.stringify(acts).includes("get_screen_size")) throw new Error("操作记录里没有 get_screen_size");
	await page.screenshot({ path: join(SHOTS, "65-computer-open-same-turn.png") });
});

await step("共用电脑：两个助理同一台电脑（界面显示共用）、给助理开自己的屏幕并切换查看、关机前提醒、单独的电脑开关、设置里的列表", async () => {
	if (!process.env.E2E_DESKTOP) return log("跳过（需要 E2E_DESKTOP=1 和 Docker）");
	const j = (u, init) => fetch(`${BASE}${u}`, init).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`${u} → ${r.status} ${await r.text()}`))));
	const put = (u, b) => j(u, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
	const post = (u, b) => j(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });
	const two = await post("/api/agents", { name: "共用测试乙" });
	try {
		await post(`/api/agents/${AGENT}/desktop/start`);
		const s1 = await j(`/api/agents/${AGENT}/desktop`);
		const s2 = await post(`/api/agents/${two.id}/desktop/start`);
		if (!s1.computer?.shared || s1.computer.id !== s2.computer?.id || s1.port !== s2.port) throw new Error(`两个助理应该在同一台共用电脑上：${JSON.stringify([s1.computer, s2.computer])}`);
		await page.goto(BASE);
		await page.locator("main textarea").waitFor();
		await page.waitForTimeout(800); // 等信息面板按记住的布局渲染完
		await openPane("电脑");
		const dv = page.getByTestId("desktop-view");
		await dv.locator('[data-testid=desktop-computer][title*="共用电脑"]').waitFor({ timeout: 30_000 });
		// 窄面板（240 / 320px）：标题行的文字收起成图标，不能挤成竖排
		for (const w of [240, 320, 420]) {
			const bad = await dv.evaluate((el, w) => {
				el.style.width = `${w}px`;
				const out = [];
				const hdr = el.querySelector("[data-testid=desktop-header]");
				if (hdr.scrollWidth > hdr.clientWidth + 1) out.push(`标题行溢出 ${hdr.scrollWidth}/${hdr.clientWidth}`);
				for (const c of hdr.querySelectorAll("span")) {
					const r = c.getBoundingClientRect();
					const fs = parseFloat(getComputedStyle(c).fontSize) || 14;
					if (r.width && (c.textContent || "").trim().length >= 2 && r.height > fs * 2.2) out.push((c.textContent || "").trim());
				}
				el.style.width = "";
				return out;
			}, w);
			if (bad.length) throw new Error(`${w}px 下文字挤成竖排：${bad.join("、")}`);
		}
		await dv.locator("canvas").first().waitFor({ timeout: 30_000 });
		// 给它开自己的屏幕 → 画面切到它的屏幕；再切去看主屏幕；回主屏幕
		await dv.getByTestId("screen-own").click();
		await dv.getByTestId("screen-release").waitFor({ timeout: 30_000 });
		const s3 = await j(`/api/agents/${AGENT}/desktop`);
		if (!s3.screen || s3.screen === "main") throw new Error(`应该有自己的屏幕：${JSON.stringify(s3)}`);
		await dv.locator(`[data-testid="screen-${s3.screen}"]`).getByText(/它在用/).waitFor();
		await dv.locator("canvas").first().waitFor({ timeout: 30_000 });
		await page.waitForTimeout(2500);
		await page.screenshot({ path: join(SHOTS, "66-shared-own-screen.png") });
		const own = await fetch(`${BASE}/api/agents/${AGENT}/desktop/screenshot`).then((r) => r.arrayBuffer());
		const main = await fetch(`${BASE}/api/agents/${AGENT}/desktop/screenshot?screen=main`).then((r) => r.arrayBuffer());
		if (own.byteLength < 5000 || main.byteLength < 5000) throw new Error("屏幕截图像是空白的");
		await dv.getByTestId("screen-main").click();
		await page.waitForTimeout(1500);
		await dv.locator("canvas").first().waitFor({ timeout: 30_000 });
		await dv.getByTestId("screen-release").click();
		await dv.getByTestId("screen-own").waitFor({ timeout: 30_000 });
		// 关机前提醒（取消 = 不关）
		await dv.getByTestId("desktop-stop").click();
		const dlg = page.getByTestId("confirm-dialog");
		await dlg.getByText("关掉共用电脑？").waitFor();
		await page.screenshot({ path: join(SHOTS, "67-shared-stop-confirm.png") });
		await dlg.getByTestId("confirm-cancel").click();
		if ((await j(`/api/agents/${AGENT}/desktop`)).state !== "running") throw new Error("取消后不应关机");
		// 单独的电脑：开 → 用自己的电脑；关 → 回共用，数据保留可合并
		const on = await put(`/api/agents/${two.id}/computer`, { separate: true });
		if (!on.separate || on.desktop.computer.shared) throw new Error(`应该是单独的电脑：${JSON.stringify(on)}`);
		const st = await post(`/api/agents/${two.id}/desktop/start`);
		if (st.port === s1.port) throw new Error("单独的电脑不应和共用电脑同一个端口");
		const off = await put(`/api/agents/${two.id}/computer`, { separate: false });
		if (off.separate || !off.desktop.computer.shared || off.hasData !== true) throw new Error(`改回共用后数据应保留：${JSON.stringify(off)}`);
		// 设置 › 助理电脑：共用说明 + 每个助理一行，乙那行有“合并进共用电脑”
		await page.goto(BASE);
		await page.locator("main textarea").waitFor();
		await page.getByRole("button", { name: "设置" }).first().click();
		await page.getByTestId("settings-nav").locator("button[data-tab=computer]").click();
		const sec = page.getByTestId("desktop-shared");
		await sec.getByText("共用电脑", { exact: true }).waitFor();
		await sec.getByTestId(`desktop-agent-${two.id}`).getByTestId("agent-merge").waitFor();
		await page.screenshot({ path: join(SHOTS, "68-settings-shared.png") });
		await page.keyboard.press("Escape");
		// 合并
		const m = await post(`/api/agents/${two.id}/computer/merge`);
		if (!m.ok) throw new Error("合并失败");
		const after = await j(`/api/agents/${two.id}/computer`);
		if (after.hasData !== false) throw new Error("合并后单独电脑的数据应该删掉了");
	} finally {
		await fetch(`${BASE}/api/agents/${two.id}`, { method: "DELETE" });
	}
});

await step("Phase 3 操作这台电脑：设置页（默认关闭、风险提示、允许的应用、能力清单）", async () => {
	await page.getByRole("button", { name: "设置" }).first().click();
	await page.getByRole("button", { name: "操作这台电脑" }).click();
	await page.getByText(/默认关闭|风险/).first().waitFor();
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(SHOTS, "42-settings-host-control.png") });
	// 设置页只有“新助理的默认权限”；选“完全权限”出现强警告
	await page.locator("[data-testid=default-tier-full]").click();
	await page.locator("[data-testid=host-full-warning]").waitFor();
	await page.locator("[data-testid=host-tiers]").scrollIntoViewIfNeeded();
	await page.mouse.move(5, 5);
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(SHOTS, "43-host-default-tier.png") });
	await page.locator("[data-testid=default-tier-bounded]").click();
	await page.keyboard.press("Escape");
});

await step("权限档位：输入框工具栏「助理电脑」旁的权限按钮切换本助理档位（调高弹确认框，完全权限只需确认启用）", async () => {
	// 用 API 开启（演练模式，不启动 Cua）
	const r = await page.evaluate(async () => {
		const j = (u, m, b) => fetch(u, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then((x) => x.json());
		await j("/api/host-control", "PUT", { enabled: false, agents: "all", apps: [{ name: "Text Editor", id: "/usr/bin/gedit" }], defaultTier: "bounded" });
		const g = await j("/api/host-control", "GET");
		return j("/api/host-control", "PUT", { enabled: true, acknowledged: true, manifestHash: g.manifestHash });
	});
	if (!r.ok) throw new Error(JSON.stringify(r));
	const pill = page.locator("[data-testid=host-tier-pill]");
	await pill.waitFor({ timeout: 10_000 });
	await pill.getByText("限定").waitFor();
	await pill.click();
	const menu = page.locator("[data-testid=host-tier-menu]");
	await menu.locator("[data-testid=tier-trusted]").click();
	const dlg = page.locator("[data-testid=confirm-dialog]");
	await dlg.waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "44-chat-tier-menu.png") });
	await dlg.locator("[data-testid=confirm-ok]").click();
	await pill.getByText("信任").waitFor({ timeout: 10_000 });
	// 完全权限：只弹确认框（不用再输入确认语）；取消不生效
	await pill.click();
	await menu.locator("[data-testid=tier-full]").click();
	await dlg.getByText("启用完全权限？").waitFor();
	await dlg.locator("[data-testid=confirm-cancel]").click();
	await dlg.waitFor({ state: "detached" });
	await pill.getByText("信任").waitFor();
	// 取消后菜单仍开着，直接再选
	await menu.locator("[data-testid=tier-full]").click();
	await dlg.getByText("启用完全权限？").waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "45-chat-tier-full-confirm.png") });
	await dlg.getByRole("button", { name: "确定启用" }).click();
	await pill.getByText("完全权限").waitFor({ timeout: 10_000 });
	// 调低直接生效
	await pill.click();
	await menu.locator("[data-testid=tier-bounded]").click();
	await pill.getByText("限定").waitFor({ timeout: 10_000 });
	await page.evaluate(() => fetch("/api/host-control", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) }));
	await page.waitForTimeout(300);
});

await step("输入框工具栏：一个模型按钮里选模型 + 设思考强度（可搜索，思考强度只在支持推理的模型上出现）", async () => {
	const mp = page.locator("[data-testid=model-picker]");
	await mp.waitFor();
	await mp.click();
	if (await page.locator("[data-testid=model-thinking]").count()) throw new Error("不支持推理的模型不应显示思考强度");
	await page.locator("[data-testid=model-search]").fill("推理");
	const opt = page.locator("[data-testid=model-option]");
	await opt.first().waitFor();
	if ((await opt.count()) !== 1) throw new Error("搜索应只剩 1 个模型");
	await page.waitForTimeout(200);
	await page.screenshot({ path: join(SHOTS, "46-composer-model-picker.png") });
	await opt.first().click();
	await mp.getByText(/Mock 推理模型/).waitFor();
	// 同一个菜单里设思考强度（按钮上直接显示模型 + 档位）
	await mp.click();
	await page.locator("[data-testid=model-thinking]").waitFor();
	await page.locator("[data-testid=thinking-high]").click();
	await mp.getByText(/· 高/).waitFor();
	await mp.click();
	await page.locator("[data-testid=model-menu]").waitFor();
	await page.waitForTimeout(200);
	await page.screenshot({ path: join(SHOTS, "47-composer-thinking.png") });
	await page.keyboard.press("Escape");
	// 换模型后照常聊天（服务端原地切换 Pi 会话的模型 / 思考强度）
	await send("你好");
	await page.locator("main").getByText(/你好/).last().waitFor();
	const before = await bubbleCount();
	await page.waitForFunction((n) => document.querySelectorAll("main .prose").length > n, before - 1, { timeout: 20_000 });
	// 换回不支持推理的模型：菜单里不再出现思考强度
	await mp.click();
	await page.locator("[data-testid=model-search]").fill("Mock 模型");
	await page.locator("[data-testid=model-option]").first().click();
	await mp.click();
	await page.locator("[data-testid=model-menu]").waitFor();
	if (await page.locator("[data-testid=model-thinking]").count()) throw new Error("换回不支持推理的模型后不应显示思考强度");
	await page.keyboard.press("Escape");
});

await step("Phase 3 渠道：飞书 / 钉钉 / 企业微信 添加表单 + 分步指引；个人微信需确认风险后开启", async () => {
	await page.getByRole("button", { name: "设置" }).first().click();
	await page.getByRole("button", { name: "渠道" }).click();
	await page.locator("[data-testid=add-channel-feishu]").click();
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(SHOTS, "43-settings-channels-feishu.png") });
	await page.getByRole("button", { name: "取消" }).first().click().catch(() => {});
	const wx = page.locator("[data-testid=wechat-section]");
	await wx.locator("[data-testid=wechat-warning]").waitFor();
	if (!(await wx.locator("[data-testid=wechat-enable]").isDisabled())) throw new Error("未确认风险时不应能开启");
	await wx.locator("[data-testid=wechat-ack]").check();
	await wx.locator("[data-testid=wechat-enable]").click();
	await wx.getByText("哪些助理有自己的微信").waitFor();
	await wx.locator("button.pa-chip").first().click();
	await wx.getByRole("button", { name: "打开微信" }).first().waitFor();
	await wx.scrollIntoViewIfNeeded();
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(SHOTS, "44-settings-wechat-optin.png") });
	await fetch(`${BASE}/api/wechat`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false, agentIds: [] }) });
	await page.keyboard.press("Escape");
});

await step("思考过程：App 里折叠显示「思考」（默认收起，点开可看），正文不出现 <think> 标签；桌面 + 手机宽度", async () => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await send("演示思考");
	const box = page.locator("[data-testid=thinking]").last();
	await box.waitFor({ timeout: 15_000 });
	await page.getByText("这是回答：思考过程收在上面的「思考」里。").last().waitFor();
	if (await box.evaluate((el) => el.open)) throw new Error("思考应默认收起");
	if (await page.locator("main").getByText("<think>").count()) throw new Error("正文里出现了 <think> 标签");
	await box.locator("summary").click();
	await box.getByText("第二步：给出简短回答").waitFor();
	await page.getByText("这是回答：思考过程收在上面的「思考」里。").last().scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(SHOTS, "93-thinking-desktop.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	const sw = await page.evaluate(() => document.documentElement.scrollWidth);
	if (sw > 392) throw new Error(`手机宽度横向溢出：${sw}`);
	// 手机宽度下右侧面板是浮层：先关掉再看聊天
	for (let i = 0; i < 3 && (await page.locator("aside").last().getByText("后台任务").isVisible().catch(() => false)); i++) {
		await page.keyboard.press("Escape");
		await page.waitForTimeout(200);
		if (await page.locator("aside").last().getByText("后台任务").isVisible().catch(() => false)) await page.locator("aside").last().locator("button").first().click().catch(() => {});
		await page.waitForTimeout(300);
	}
	await page.getByText("这是回答：思考过程收在上面的「思考」里。").last().scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(SHOTS, "93-thinking-mobile.png") });
	await page.setViewportSize({ width: 1280, height: 800 });
});

await step("微信 ClawBot（模拟 iLink）：扫码连接 → 二维码 → 确认后已连接 → 微信里发消息 → 助理回复发回微信", async () => {
	const { createServer: http } = await import("node:http");
	let qr = "wait";
	const inbox = [];
	const sent = [];
	const ilink = http(async (req, res) => {
		let b = "";
		for await (const c of req) b += c;
		const j = (o) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(o)));
		const u = req.url ?? "";
		if (u.startsWith("/ilink/bot/get_bot_qrcode")) return j({ qrcode: "Q", qrcode_img_content: "https://liteapp.weixin.qq.com/q/e2e-demo" });
		if (u.startsWith("/ilink/bot/get_qrcode_status")) return (await new Promise((r) => setTimeout(r, 300)), j(qr === "confirmed" ? { status: "confirmed", bot_token: "T", ilink_bot_id: "bot@im.bot", ilink_user_id: "me@im.wechat" } : { status: qr }));
		if (u === "/ilink/bot/getupdates") {
			for (let i = 0; i < 10 && !inbox.length; i++) await new Promise((r) => setTimeout(r, 50));
			return j({ ret: 0, msgs: inbox.splice(0), get_updates_buf: "b" });
		}
		if (u === "/ilink/bot/sendmessage") sent.push(JSON.parse(b));
		if (u === "/ilink/bot/getconfig") return j({ ret: 0, typing_ticket: "TT" });
		if (u === "/ilink/bot/getuploadurl") return j({ upload_full_url: `${IL}/cdn/upload` });
		if (u === "/cdn/upload") return (res.setHeader("x-encrypted-param", "DL"), res.end());
		j({ ret: 0 });
	});
	await new Promise((r) => ilink.listen(0, "127.0.0.1", r));
	const IL = `http://127.0.0.1:${ilink.address().port}`;
	const c = await (await fetch(`${BASE}/api/channels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "wechat_clawbot", agentId: AGENT, name: "微信 ClawBot", config: { apiBase: IL, cdnBase: IL } }) })).json();
	await page.getByRole("button", { name: "设置" }).first().click();
	await page.getByRole("button", { name: "渠道" }).click();
	const sec = page.locator("[data-testid=clawbot-section]");
	await sec.locator("[data-testid=clawbot-login]").click();
	await sec.locator("[data-testid=clawbot-qr] img").waitFor();
	qr = "scaned";
	await sec.getByText("已扫码，请在微信里确认").waitFor();
	await sec.scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(SHOTS, "50-settings-clawbot-qr.png") });
	qr = "confirmed";
	await sec.getByText("已连接你的微信").waitFor({ timeout: 15_000 });
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "51-settings-clawbot-connected.png") });
	inbox.push({ message_id: "1", from_user_id: "me@im.wechat", message_type: 1, context_token: "CTX", item_list: [{ type: 1, text_item: { text: "你好，从微信发来" } }] });
	await waitFor(() => sent.some((m) => m.msg?.context_token === "CTX" && JSON.stringify(m).includes("你好，从微信发来")), 20_000);
	// 助理交付的文件发成微信原生文件消息（不是“请在 App 里查看”），说明文字一起发；渠道说明不回显给用户
	inbox.push({ message_id: "2", from_user_id: "me@im.wechat", message_type: 1, context_token: "CTX2", item_list: [{ type: 1, text_item: { text: "给我一份报告" } }] });
	await waitFor(() => sent.some((m) => m.msg?.context_token === "CTX2" && m.msg.item_list?.some((i) => i.type === 4 && i.file_item?.file_name === "report.md")), 20_000);
	if (sent.some((m) => /App 里查看|［渠道/.test(JSON.stringify(m)))) throw new Error("微信里出现了“请在 App 里查看”或渠道说明");
	await fetch(`${BASE}/api/channels/${c.id}`, { method: "DELETE" });
	ilink.close();
	await page.keyboard.press("Escape");
});

await step("主动性：输入框「主动」按钮切换等级 → 聊天里约好跟进 → 助理面板「主动」页 → 现在看看 → 提醒收件箱 → 标记有用", async () => {
	await page.locator("[data-testid=proactive-picker]").click();
	await page.locator("[data-testid=proactive-menu]").waitFor();
	await page.screenshot({ path: join(SHOTS, "52-composer-proactive.png") });
	await page.locator("[data-testid=proactive-normal]").click();
	await page.locator("[data-testid=proactive-picker]").getByText("中").waitFor();
	// e2e 可能在深夜跑：关掉免打扰，避免提醒被顺延
	// 前面的步骤可能切到了别的助理：所有助理都关掉
	for (const a of await (await fetch(`${BASE}/api/agents`)).json()) await fetch(`${BASE}/api/agents/${a.id}/proactive`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cfg: { quiet: null } }) });
	await send("这个方案晚点再看看");
	await page.getByText("到时我再看看").first().waitFor({ timeout: 20_000 });
	await page.locator("[data-testid=proactive-picker]").click();
	await page.getByRole("button", { name: "更多设置" }).click();
	// 「更多设置」进入助理 › 任务 › 主动跟进，而不是只开一个临时弹层
	await page.locator(".pa-pane-wrap").waitFor();
	await page.locator("[data-testid=agent-task-tabs] [data-itab=proactive][aria-selected=true]").waitFor();
	await page.locator("[data-testid=proactive-tab] [data-testid=followup]").first().waitFor();
	await page.locator("[data-testid=proactive-run]").click();
	await waitFor(async () => (await (await fetch(`${BASE}/api/proactive/inbox`)).json()).items.some((i) => i.status === "delivered"), 30_000).catch(async (e) => {
		const agents = await (await fetch(`${BASE}/api/agents`)).json();
		const st = await Promise.all(agents.map(async (a) => [a.name, await (await fetch(`${BASE}/api/agents/${a.id}/proactive`)).json()]));
		throw new Error(`${e} inbox=${JSON.stringify(await (await fetch(`${BASE}/api/proactive/inbox?all=1`)).json()).slice(0, 1500)} state=${JSON.stringify(st).slice(0, 3000)}`);
	});
	await page.waitForTimeout(500);
	await page.screenshot({ path: join(SHOTS, "53-proactive-tab.png") });
	await page.locator("[data-testid=inbox-button]").click();
	await page.locator("[data-testid=inbox] [data-testid=inbox-item]").first().waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "54-proactive-inbox.png") });
	await page.locator("[data-testid=inbox] [data-testid=inbox-done]").first().click();
	await waitFor(async () => (await (await fetch(`${BASE}/api/proactive/inbox`)).json()).items.every((i) => i.status !== "delivered" || i.id), 5_000);
	await page.keyboard.press("Escape");
});

await step("Phase 3 邮箱：添加邮箱（模拟 IMAP/SMTP）→ 助理写草稿 → 发送审批卡片（完整内容）→ 批准后发出", async () => {
	const { createRequire } = await import("node:module");
	const req = createRequire(join(ROOT, "packages/server/package.json"));
	const hoodiecrow = req("hoodiecrow-imap");
	const { SMTPServer } = req("smtp-server");
	const imap = hoodiecrow({ plugins: ["ID", "SPECIAL-USE", "UIDPLUS"], storage: { INBOX: { messages: [{ raw: "From: wang@school.cn\r\nTo: me@qq.com\r\nSubject: =?UTF-8?B?" + Buffer.from("家长会通知").toString("base64") + "?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n周五下午三点开家长会。" }] }, "": { separator: "/", folders: { "Sent Messages": { "special-use": "\\Sent" } } } } });
	await new Promise((r) => imap.listen(0, "127.0.0.1", r));
	const sent = [];
	const smtp = new SMTPServer({ allowInsecureAuth: true, disabledCommands: ["STARTTLS"], logger: false, onAuth: (a, _s, cb) => cb(null, { user: a.username }), onData: (st, s, cb) => { st.resume(); st.on("end", () => (sent.push(s.envelope.rcptTo.map((x) => x.address)), cb())); } });
	await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
	try {
		const r = await fetch(`${BASE}/api/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "custom", address: "dengdeng@qq.com", user: "testuser", password: "testpass", name: "邓邓", imap: { host: "127.0.0.1", port: imap.server.address().port, secure: false }, smtp: { host: "127.0.0.1", port: smtp.server.address().port, secure: false }, insecure: true }) });
		if (!r.ok) throw new Error(await r.text());
		const acc = await r.json();
		const t = await (await fetch(`${BASE}/api/email/${acc.id}/test`, { method: "POST" })).json();
		if (!t.ok) throw new Error(`测试失败：${t.message}`);
		await page.getByRole("button", { name: "设置" }).first().click();
		await page.getByRole("button", { name: "邮箱" }).click();
		await page.locator("[data-testid=email-account]").getByText("dengdeng@qq.com").waitFor();
		await page.locator("[data-testid=add-email]").click();
		await page.waitForTimeout(300);
		await page.screenshot({ path: join(SHOTS, "45-settings-email.png") });
		// Gmail：用 Google 登录（OAuth 客户端设置 → 出现登录按钮；真正授权要真实 Google 账号）
		await page.locator("[data-testid=email-form]").getByRole("button", { name: "Gmail", exact: true }).click();
		const go = page.locator("[data-testid=gmail-oauth]");
		await go.getByText("桌面应用").waitFor();
		await go.locator("[data-testid=gmail-client-id]").fill("123-e2e.apps.googleusercontent.com");
		await go.locator("[data-testid=gmail-client-secret]").fill("GOCSPX-e2e");
		await go.locator("[data-testid=gmail-client-save]").click();
		await go.locator("[data-testid=gmail-oauth-start]").waitFor();
		const st = await (await fetch(`${BASE}/api/email/oauth/google/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
		if (!/accounts\.google\.com.*code_challenge=/.test(st.url ?? "")) throw new Error(`授权地址不对：${JSON.stringify(st)}`);
		const cb = await (await fetch(`${BASE}/api/email/oauth/google/callback?code=x&state=forged`)).text();
		if (!cb.includes("连接失败")) throw new Error("伪造 state 应失败");
		await page.waitForTimeout(200);
		await page.screenshot({ path: join(SHOTS, "48-settings-gmail-oauth.png") });
		await fetch(`${BASE}/api/email/oauth/google`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ clear: true }) });
		await page.keyboard.press("Escape");
		await page.goto(BASE);
		await send("帮我写邮件给王老师，说周五家长会我会参加");
		const card = page.locator("[data-testid=approval-card]").last();
		await card.getByText(/发送邮件给 wang@school.cn/).first().waitFor({ timeout: 30_000 });
		if (sent.length) throw new Error("批准前不应发出");
		await page.waitForTimeout(400);
		await page.screenshot({ path: join(SHOTS, "46-email-send-approval.png") });
		await card.getByRole("button", { name: "批准", exact: true }).click();
		await page.locator("main").getByText(/邮件发出去了/).last().waitFor({ timeout: 30_000 });
		if (sent.length !== 1 || sent[0][0] !== "wang@school.cn") throw new Error(`SMTP 收到 ${JSON.stringify(sent)}`);
	} finally {
		imap.close?.();
		smtp.close();
	}
});

await step("左侧助理列表：右键 → 编辑 / 删除助理（确认框）；手机长按出菜单", async () => {
	const mk = async (name) => (await (await fetch(`${BASE}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json());
	const a = await mk("临时助理甲");
	const b = await mk("临时助理乙");
	await page.goto(BASE);
	const item = (n) => page.locator("[data-testid=sidebar-agent]", { hasText: n });
	await item("临时助理甲").click({ button: "right" });
	await page.locator("[data-testid=agent-menu]").getByText("编辑").click();
	// 侧边栏「编辑」直达该助理的资料页（资料面板可见，不是只切了个隐藏 tab）
	await page.locator(".pa-pane-wrap").waitFor();
	await page.getByTestId("agent-profile").waitFor();
	// 资料页把危险操作收进折叠区：真的点开再找「删除助理」，不假定默认展开。
	await expandDetails(page.locator(".pa-pane-wrap"), "agent-danger-details");
	await page.getByText("删除助理").last().waitFor();
	await item("临时助理甲").click({ button: "right" });
	await page.waitForTimeout(200);
	await page.screenshot({ path: join(SHOTS, "56-sidebar-context-menu.png") });
	await page.locator("[data-testid=agent-menu]").getByText("删除助理").click();
	const dlg = page.locator("[data-testid=delete-agent-dialog]");
	await dlg.getByText(/对话、定时任务和记忆会一起清掉/).waitFor();
	await dlg.getByText(/回收站/).waitFor();
	await page.screenshot({ path: join(SHOTS, "57-sidebar-delete-confirm.png") });
	await page.locator("[data-testid=confirm-delete-agent]").click();
	await item("临时助理甲").waitFor({ state: "detached" });
	const list = await (await fetch(`${BASE}/api/agents`)).json();
	if ((list.agents ?? list).some((x) => x.id === (a.agent ?? a).id)) throw new Error("助理没有被删除");
	// 手机：长按 ~500ms
	const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "zh-CN" });
	const mp = await m.newPage();
	await mp.goto(BASE);
	await mp.getByLabel("打开助理列表").click();
	const it = mp.locator("[data-testid=sidebar-agent]", { hasText: "临时助理乙" });
	await it.waitFor();
	await mp.waitForTimeout(600); // 等抽屉滑入动画结束，坐标才准
	const box = await it.boundingBox();
	const o = { pointerType: "touch", isPrimary: true, bubbles: true, clientX: box.x + 40, clientY: box.y + 10 };
	await it.dispatchEvent("pointerdown", o);
	await mp.waitForTimeout(250);
	if (await mp.locator("[data-testid=agent-menu]").count()) throw new Error("短按不应出菜单");
	await mp.waitForTimeout(400);
	await mp.locator("[data-testid=agent-menu]").waitFor();
	await it.dispatchEvent("pointerup", o);
	await mp.locator("[data-testid=agent-menu]").getByText("删除助理").click();
	await mp.locator("[data-testid=confirm-delete-agent]").click();
	await it.waitFor({ state: "detached" });
	await m.close();
	void b;
});

await step("弹出菜单不溢出：权限 / 主动性 / 模型 / 思考 / 上下文菜单在 4 套主题、桌面和手机宽度下内容都在菜单内、菜单在屏幕内", async () => {
	const vp0 = page.viewportSize();
	const check = (el) => {
		const r = el.getBoundingClientRect();
		const bad = [];
		if (r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5) bad.push(`菜单超出屏幕 ${Math.round(r.left)}–${Math.round(r.right)} / ${innerWidth}`);
		for (const c of el.querySelectorAll("*")) {
			const cr = c.getBoundingClientRect();
			if (!cr.width) continue;
			const clip = c.closest("[class*=overflow-],.truncate");
			if ((cr.right > r.right + 1 || cr.left < r.left - 1) && !(clip && clip !== c && el.contains(clip))) bad.push(`超出菜单：「${(c.textContent || "").trim().slice(0, 24)}」`);
			const cs = getComputedStyle(c);
			if (cs.overflowX === "visible" && c.clientWidth && c.scrollWidth > c.clientWidth + 1 && cs.display !== "inline") bad.push(`内容溢出：「${(c.textContent || "").trim().slice(0, 24)}」`);
		}
		return [...new Set(bad)].slice(0, 5);
	};
	const menus = [
		["host-tier-pill", "host-tier-menu"],
		["proactive-picker", "proactive-menu"],
		["model-picker", "model-menu"],
		["context-ring", "context-pop"],
	];
	const problems = [];
	let checked = 0;
	for (const vp of [{ width: 1280, height: 800 }, { width: 760, height: 800 }, { width: 390, height: 844 }]) {
		await page.setViewportSize(vp);
		await page.goto(BASE);
		await page.locator("main textarea").waitFor();
		await page.waitForTimeout(400);
		// 窄屏下侧栏 / 信息面板是抽屉：先关掉遮罩
		for (let i = 0; i < 3; i++) {
			const ov = page.locator("div.fixed.inset-0.z-40:not(.pointer-events-none)").first();
			if (!(await ov.isVisible().catch(() => false))) break;
			await ov.dispatchEvent("click").catch(() => {});
			await page.waitForTimeout(300);
		}
		for (const skin of ["glass", "warm", "pixel", "noir"]) {
			await page.evaluate((s) => (document.documentElement.dataset.skin = s), skin);
			for (const [btn, menu] of menus) {
				const b = page.locator(`main [data-testid=${btn}]`).first();
				if (!(await b.isVisible().catch(() => false))) continue;
				await b.click();
				const m = page.locator(`[data-testid=${menu}]`).first();
				await m.waitFor({ timeout: 5000 });
				const bad = await m.evaluate(check);
				if (bad.length) problems.push(`${vp.width}px ${skin} ${menu}: ${bad.join("；")}`);
				checked++;
				if (skin === "warm" && menu === "host-tier-menu") await page.screenshot({ path: join(SHOTS, `69-popover-${vp.width}.png`) });
				// 关菜单：点菜单外面（手机上菜单固定在输入框上方，可能盖住按钮）
				await page.evaluate(() => {
					for (const t of ["pointerdown", "mousedown", "click"]) document.querySelector("main")?.dispatchEvent(new MouseEvent(t, { bubbles: true }));
				});
				if (!(await m.waitFor({ state: "detached", timeout: 2000 }).then(() => true).catch(() => false))) await b.click({ force: true });
				await m.waitFor({ state: "detached", timeout: 5000 });
			}
		}
	}
	await page.evaluate(() => (document.documentElement.dataset.skin = localStorage.getItem("pia.skin") || "noir"));
	if (vp0) await page.setViewportSize(vp0);
	if (checked < 30) throw new Error(`检查到的菜单太少（${checked}）`);
	if (problems.length) throw new Error(problems.join("\n"));
	log(`检查了 ${checked} 个菜单`);
});

await step("界面打磨：输入框旁上下文圆环（悬停简要、点开详情）；自定义勾选框；「?」帮助气泡；设置 › 下载与组件；悬浮条关闭按钮", async () => {
	await page.goto(BASE);
	await send("你好，测一下上下文用量");
	await page.waitForTimeout(1500);
	const ring = page.locator("[data-testid=context-ring]");
	await ring.waitFor();
	const title = await ring.getAttribute("title");
	if (!/上下文/.test(title ?? "")) throw new Error(`圆环提示不对：${title}`);
	await ring.click();
	await page.locator("[data-testid=context-pop]").getByText("上下文").first().waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "60-context-ring.png") });
	await ring.click();
	// 设置 › 下载与组件
	await page.evaluate(() => (location.search = "?settings=downloads"));
	await page.locator("[data-testid=settings-dialog]").waitFor();
	await page.locator("[data-tab=downloads]").click();
	const help = page.locator("[data-testid=settings-content] [data-testid=help]").first();
	await help.hover();
	await page.locator("[data-testid=help-pop]").waitFor();
	await page.waitForTimeout(200);
	await page.screenshot({ path: join(SHOTS, "61-settings-downloads.png") });
	// 记忆设置：自定义单选框不是浏览器默认外观
	await page.locator("[data-tab=memory]").click();
	await page.waitForTimeout(400);
	const ap = await page.locator("[data-testid=settings-content] input[type=radio], [data-testid=settings-content] input[type=checkbox]").first().evaluate((el) => getComputedStyle(el).appearance);
	if (ap !== "none") throw new Error(`勾选框仍是浏览器默认样式：${ap}`);
	await page.screenshot({ path: join(SHOTS, "62-settings-memory-polish.png") });
	// 窄窗口：设置内容不横向溢出
	await page.setViewportSize({ width: 760, height: 800 });
	await page.waitForTimeout(300);
	const over = await page.locator("[data-testid=settings-content]").evaluate((el) => el.scrollWidth - el.clientWidth);
	if (over > 2) throw new Error(`窄窗口下设置内容横向溢出 ${over}px`);
	await page.screenshot({ path: join(SHOTS, "63-settings-narrow.png") });
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.keyboard.press("Escape");
	// 聊天顶部“正在操作你的电脑”：没有真实 host 动作时绝不显示（以前只要开启就常驻）
	const hc = await page.evaluate(() => fetch("/api/host-control").then((r) => r.json()));
	if (hc.activity?.active) throw new Error("没有 host 动作时 activity.active 应为 false");
	if (await page.locator("[data-testid=host-bar]").count()) throw new Error("没在操作电脑时聊天顶部不应出现操作提示");
	// 悬浮条：透明背景 + 关闭按钮（关闭后服务端记住，状态变化前不再弹）
	await page.evaluate(() => fetch("/api/host-control/pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: true }) }));
	const bar = await ctx.newPage();
	await bar.setViewportSize({ width: 440, height: 56 });
	await bar.goto(`${BASE}/hostbar`);
	await bar.locator("[data-testid=float-bar]").waitFor();
	const bg = await bar.evaluate(() => getComputedStyle(document.body).backgroundColor);
	if (!/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) throw new Error(`悬浮条页面背景不透明：${bg}`);
	await bar.screenshot({ path: join(SHOTS, "64-hostbar-close.png"), omitBackground: true });
	await bar.locator("[data-testid=float-close]").click();
	const st = await bar.evaluate(() => fetch("/api/host-control/bar").then((r) => r.json()));
	if (!st.dismissed) throw new Error("关闭后 dismissed 应为 true");
	await bar.evaluate(() => fetch("/api/host-control/pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: false }) }));
	const st2 = await bar.evaluate(() => fetch("/api/host-control/bar").then((r) => r.json()));
	if (st2.dismissed) throw new Error("状态变化后悬浮条应能再次出现");
	await bar.close();
});

await step("手机不横向晃动 + 窄处文字不竖排：宽表格 / 长代码 / 长链接只在自己的块里横滑，390px 下整页宽度 = 屏幕宽度", async () => {
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
	const pp = await phone.newPage();
	await pp.goto(BASE);
	const box = pp.locator("main textarea");
	await box.waitFor();
	await pp.waitForTimeout(800);
	await box.fill("给我一个很宽的表格");
	await pp.getByRole("button", { name: "发送" }).click(); // 触屏上回车是换行
	const wrap = pp.getByTestId("md-table-wrap").last();
	await wrap.waitFor({ timeout: 30_000 });
	await pp.waitForTimeout(500);
	const m = await pp.evaluate(() => {
		const w = document.querySelector("[data-testid=md-table-wrap]:last-of-type") ?? document.querySelectorAll("[data-testid=md-table-wrap]")[0];
		const sc = document.querySelector(".pa-scroll");
		return { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: innerWidth, sc: sc ? sc.scrollWidth - sc.clientWidth : 0, wrapScroll: w.scrollWidth > w.clientWidth + 10 };
	});
	if (m.doc > m.vw || m.body > m.vw || m.sc > 1) throw new Error(`页面被撑宽：${JSON.stringify(m)}`);
	if (!m.wrapScroll) throw new Error("宽表格应该在自己的容器里横向滚动");
	// 横向拖一下聊天区：整页不能跟着动
	await pp.evaluate(() => window.scrollTo(200, 0));
	if ((await pp.evaluate(() => window.scrollX)) !== 0) throw new Error("整页可以被横向拖动");
	// 文字不能被挤成竖排（每行一两个字）
	const stacked = await pp.evaluate(() => {
		const bad = [];
		for (const el of document.querySelectorAll("button, [role=tab], span, a, label, h1, h2, h3")) {
			const t = (el.textContent || "").trim();
			if (t.length < 2 || el.children.length > 2) continue;
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height) continue;
			const fs = parseFloat(getComputedStyle(el).fontSize) || 14;
			if (r.width < fs * 2.2 && r.height > fs * 2.6) bad.push(t.slice(0, 12));
		}
		return bad.slice(0, 8);
	});
	if (stacked.length) throw new Error(`文字被挤成竖排：${stacked.join("、")}`);
	await pp.screenshot({ path: join(SHOTS, "70-phone-wide-table.png") });
	await phone.close();
});

await step("Linux 服务器版：控制台设置码 → 网页首次设置成为主人设备 → 主人生成配对码 → 新设备认领 → 主人在网页上批准", async () => {
	// 另起一个服务器模式的服务（PIA_HEADLESS=1：回环请求也要登录，设置码打印到控制台）
	const SP = PORT + 1;
	const SB = `http://127.0.0.1:${SP}`;
	const SDATA = `${DATA}-server`;
	rmSync(SDATA, { recursive: true, force: true });
	let out = "";
	const srv = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: SDATA, PIA_MOCK: "1", PIA_PORT: String(SP), PIA_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	srv.stdout.on("data", (d) => (out += d));
	try {
		await waitFor(() => /设置码：[A-Z0-9]{4}-[A-Z0-9]{4}/.test(out), 30_000);
		const code = /设置码：([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)[1];
		const octx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN", colorScheme: "light" });
		const op = await octx.newPage();
		await op.goto(SB);
		await op.locator("[data-testid=server-setup]").waitFor();
		await op.getByText("欢迎使用，先完成首次设置").waitFor();
		await op.locator("[data-testid=pair-code-input]").fill(code.toLowerCase().replace("-", " "));
		await op.screenshot({ path: join(SHOTS, "70-server-setup-code.png") });
		await op.locator("[data-testid=pair-code-submit]").click();
		await op.locator("[data-testid=pair-done]").waitFor();
		await op.goto(`${SB}/?settings=remote`);
		await op.locator("[data-testid=settings-dialog]").waitFor();
		const sys = await op.evaluate(async () => {
			const c = JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => localStorage.getItem(k)?.includes("hh_"))));
			return (await fetch("/api/system", { headers: { authorization: `Bearer ${c.token}` } })).json();
		});
		if (!sys.owner || !sys.local) throw new Error(`首次设置的设备应是主人设备：${JSON.stringify({ owner: sys.owner, local: sys.local })}`);
		// 设置码已作废
		const again = await fetch(`${SB}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "x" }) });
		if (again.status !== 400) throw new Error("设置码应只能用一次");
		// 主人在网页上生成配对码（原来只能在本机操作）
		await op.getByRole("button", { name: /生成配对二维码/ }).click();
		const pcode = (await op.locator("[data-testid=pair-short-code]").textContent()).trim();
		// 新设备（手机）认领 → 等待主人批准
		const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", isMobile: true, hasTouch: true });
		const pp = await pctx.newPage();
		await pp.goto(SB);
		await pp.locator("[data-testid=pair-code-input]").fill(pcode);
		await pp.locator("[data-testid=pair-code-submit]").click();
		// 主人网页上弹出批准框
		await op.getByRole("button", { name: "允许连接" }).click();
		await pp.locator("[data-testid=pair-done]").waitFor();
		await op.keyboard.press("Escape");
		await op.goto(`${SB}/?settings=remote`);
		await op.locator("[data-testid=settings-dialog]").waitFor();
		await op.getByText("手机", { exact: false }).first().waitFor().catch(() => {});
		await op.locator("[data-testid=settings-content]").getByText("主人", { exact: true }).first().waitFor();
		await op.screenshot({ path: join(SHOTS, "71-server-owner-devices.png") });
		// 手机不是主人：管理接口 403
		const pr = await pp.evaluate(async () => {
			const c = JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => localStorage.getItem(k)?.includes("hh_"))));
			return (await fetch("/api/pair/start", { method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: "{}" })).status;
		});
		if (pr !== 403) throw new Error(`普通设备不应能生成配对码：${pr}`);
		await octx.close();
		await pctx.close();
	} finally {
		srv.kill("SIGTERM");
	}
});

// ---------------------------------------------------------------- 助理群聊
const jpost = async (path, body, method = "POST") => (await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })).json();
let ROOM = "";
const roomSay = async (text) => {
	const box = page.getByTestId("room-input");
	await box.waitFor();
	await box.fill(text);
	await box.press("Enter");
	await page.waitForFunction(() => document.querySelector("[data-testid=room-input]")?.value === "", null, { timeout: 10_000 });
};
const roomIdle = () => page.waitForFunction(() => !document.querySelector("[data-testid=room-status]"), null, { timeout: 60_000 });
const botsOf = (name) => page.locator(`[data-testid=room-bot][data-agent="${name}"]`);
await step("群聊：新建群（A/B/C，管理者 A）→ @A 只有 A 回答 → 不 @ 只有管理者，它派活触发 B → B @C 不会叫醒 C → @ 自动补全", async () => {
	for (const n of ["A", "B", "C"]) await jpost("/api/agents", { name: n });
	await page.goto(BASE);
	await page.getByTestId("new-room-btn").click();
	const dlg = page.getByTestId("new-room");
	await dlg.getByTestId("room-name").fill("三人组");
	for (const n of ["A", "B", "C"]) await dlg.locator(`[data-name="${n}"]`).getByTestId("room-pick-agent").check();
	if (!(await dlg.getByTestId("room-pick-manager").first().textContent()).includes("管理者")) throw new Error("默认第一个选中的是管理者");
	await dlg.getByTestId("room-create").click();
	await page.getByTestId("room-title").filter({ hasText: "三人组" }).waitFor();
	ROOM = (await (await fetch(`${BASE}/api/rooms`)).json()).find((r) => r.name === "三人组").id;
	if ((await page.getByTestId("sidebar-room").count()) < 1) throw new Error("侧边栏没有群聊");
	await roomSay("@A 你好");
	await botsOf("A").getByText("A 回复").waitFor({ timeout: 30_000 });
	await roomIdle();
	if ((await botsOf("B").count()) || (await botsOf("C").count())) throw new Error("@A 时只有 A 应该回答");
	await roomSay("这件事派给B 提醒C");
	await botsOf("B").getByText("B 完成了").waitFor({ timeout: 40_000 });
	await page.locator("main").getByText("A 总结：大家都完成了").last().waitFor({ timeout: 40_000 });
	await roomIdle();
	if (await botsOf("C").count()) throw new Error("B @C 不应该叫醒 C");
	if (!(await page.locator("[data-testid=room-bot][data-agent=A]").first().getByText("管理者").count())) throw new Error("管理者标记");
	// @ 自动补全（桌面弹出层）
	const box = page.getByTestId("room-input");
	await box.fill("");
	await box.pressSequentially("@");
	await page.getByTestId("mention-list").waitFor();
	if (!(await page.getByTestId("mention-opt").filter({ hasText: "所有人" }).count())) throw new Error("@ 列表里应有所有人");
	await page.getByTestId("mention-opt").filter({ hasText: /^B/ }).click();
	if ((await box.inputValue()) !== "@B ") throw new Error(`补全结果不对：${await box.inputValue()}`);
	await box.fill("");
	await page.screenshot({ path: join(SHOTS, "80-room-manager.png") });
});
await step("群聊：上限暂停（本轮已暂停，回复继续）→ 点继续接着跑", async () => {
	await roomSay("循环 派给B");
	await page.locator("main").getByText(/本轮已暂停/).last().waitFor({ timeout: 60_000 });
	await roomIdle();
	const before = await page.locator("[data-testid=room-bot]").count();
	// 回复“继续”：接着跑暂停时没说完的（点“继续”按钮效果相同）
	if (!(await page.getByTestId("room-continue").count())) throw new Error("暂停提示上应有继续按钮");
	await roomSay("继续");
	await page.waitForFunction((n) => document.querySelectorAll("[data-testid=room-bot]").length > n || document.querySelectorAll("[data-testid=room-continue]").length > 1, before, { timeout: 40_000 });
	await roomIdle();
	const msgs = await (await fetch(`${BASE}/api/rooms/${ROOM}/messages`)).json();
	const turns = msgs.filter((m) => m.role === "assistant" && m.content).length;
	if (turns < 6) throw new Error(`发言太少：${turns}`);
});
await step("群聊：审批卡片显示在群里（带助理名）→ 批准；停止按钮中止所有人", async () => {
	await roomSay("@B 审批一下删除");
	const card = botsOf("B").getByTestId("approval-card").last();
	await card.waitFor({ timeout: 30_000 });
	await page.getByTestId("room-status").getByText("等待审批").waitFor();
	await card.getByRole("button", { name: "批准" }).click();
	await botsOf("B").getByText("B：已处理").waitFor({ timeout: 30_000 });
	await roomIdle();
	await roomSay("@C 慢慢做，@A 等一下");
	await page.getByTestId("room-status").getByText("排队中").waitFor({ timeout: 20_000 });
	await page.getByTestId("room-stop").click();
	await page.locator("main").getByText("已停止").last().waitFor({ timeout: 20_000 });
	await roomIdle();
	await page.waitForTimeout(1500);
	if (await botsOf("A").filter({ hasText: "慢慢做" }).count()) throw new Error("停止后排队的 A 不应该再说话");
});
await step("群聊：成员干活时插话送达给它 → 它回应调整；说「停」全群停下", async () => {
	await roomSay("@C 慢慢数");
	await botsOf("C").getByText("好，我慢慢数。").last().waitFor({ timeout: 20_000 });
	await roomSay("@C 换个方向");
	await page.locator("[data-testid=delivery][data-state=delivered]").last().waitFor({ timeout: 15_000 });
	await botsOf("C").getByText(/收到插话：.*换个方向/).last().waitFor({ timeout: 15_000 });
	await roomIdle();
	await roomSay("@C 慢慢数");
	await botsOf("C").getByText("好，我慢慢数。").last().waitFor({ timeout: 20_000 });
	await roomSay("停");
	await page.locator("main").getByText("已停止").last().waitFor({ timeout: 10_000 });
	await roomIdle();
});
await step("群聊附件：发图片+文件 → @A 看到路径和图片 → 管理者把附件派给 B（B 拿到路径）→ C 生成的文件出现在群里 → B 能拿到", async () => {
	await page.goto(`${BASE}/?room=${ROOM}`);
	const plan = join(DATA, "plan.txt");
	writeFileSync(plan, "群聊附件测试：下周发布计划。");
	const input = page.locator("[data-testid=room-chat] [data-testid=attach-input]");
	await input.setInputFiles([join(import.meta.dirname, "..", "apps", "web", "public", "icon-192.png"), plan]);
	await page.locator("[data-testid=room-chat] [data-testid=attach-chip]").nth(1).waitFor();
	await roomSay("@A 看看附件");
	await botsOf("A").getByText(/看到附件：room-files\/\S+icon-192\.png、room-files\/\S+plan\.txt；图片 1 张/).last().waitFor({ timeout: 30_000 });
	await page.locator("main img[alt='icon-192.png']").last().waitFor();
	await page.locator("main").getByText("plan.txt").first().waitFor();
	await roomIdle();
	const plan2 = join(DATA, "brief.txt");
	writeFileSync(plan2, "第二份附件");
	await input.setInputFiles(plan2);
	await page.locator("[data-testid=room-chat] [data-testid=attach-chip]").first().waitFor();
	await roomSay("派给B 处理附件");
	await botsOf("B").getByText(/B 完成了.*看到附件：room-files\/\S+brief\.txt/).last().waitFor({ timeout: 40_000 });
	await roomIdle();
	await roomSay("@C 做个图表");
	await botsOf("C").getByText("chart.svg").last().waitFor({ timeout: 30_000 });
	await roomIdle();
	await roomSay("@B 看看C的图表");
	await botsOf("B").getByText(/看到附件：room-files\/\S+chart\.svg/).last().waitFor({ timeout: 30_000 });
	await roomIdle();
	await page.screenshot({ path: join(SHOTS, "83-room-attachments.png") });
});
await step("群聊：手机宽度 @ 底部面板、整页不横向滚动；4 套主题下群聊界面不溢出", async () => {
	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });
	const pp = await phone.newPage();
	await pp.goto(`${BASE}/?room=${ROOM}`);
	await pp.getByTestId("room-chat").waitFor();
	await pp.getByTestId("mention-btn").click();
	await pp.getByTestId("mention-sheet").waitFor();
	await pp.getByTestId("mention-sheet").getByTestId("mention-opt").filter({ hasText: /^C/ }).click();
	if (!(await pp.getByTestId("room-input").inputValue()).includes("@C")) throw new Error("底部面板选择后应插入 @C");
	// 手机上也能选附件（系统相册 / 文件），附件条不撑宽
	if (!(await pp.getByTestId("attach-btn").isVisible())) throw new Error("手机上应有附件按钮");
	await pp.getByTestId("attach-input").setInputFiles({ name: "一个名字特别特别特别特别特别长的手机照片文件.png", mimeType: "image/png", buffer: readFileSync(join(import.meta.dirname, "..", "apps", "web", "public", "icon-192.png")) });
	await pp.getByTestId("attach-chip").waitFor();
	const m = await pp.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: innerWidth, sc: (() => { const s = document.querySelector(".pa-scroll"); return s ? s.scrollWidth - s.clientWidth : 0; })() }));
	if (m.doc > m.vw || m.sc > 1) throw new Error(`手机上群聊被撑宽：${JSON.stringify(m)}`);
	await pp.screenshot({ path: join(SHOTS, "81-room-phone.png") });
	await phone.close();
	for (const skin of ["glass", "warm", "pixel", "noir"]) {
		const c = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: "zh-CN", colorScheme: skin === "noir" ? "dark" : "light" });
		await c.addInitScript((s) => localStorage.setItem("pia.skin", s), skin);
		const p = await c.newPage();
		await p.goto(`${BASE}/?room=${ROOM}`);
		await p.getByTestId("room-chat").waitFor();
		await p.waitForTimeout(500);
		const bad = await p.evaluate(() => {
			const out = [];
			for (const sel of [".pa-chat-head", ".pa-room-status", ".pa-composer-bar"]) {
				const el = document.querySelector(sel);
				if (el && el.scrollWidth > el.clientWidth + 1) out.push(sel);
			}
			return out;
		});
		if (bad.length) throw new Error(`${skin} 主题溢出：${bad.join(",")}`);
		await p.screenshot({ path: join(SHOTS, "themes", `${skin}-room.png`) });
		await c.close();
	}
});
await step("手机：单聊与群聊消息列左右边距对称（375/390/430），不横向漂移", async () => {
	// 测“左边距 vs 右边距”：机器人正文、步骤/审批卡片、用户气泡都在 .pa-scroll 内容区里左右对称
	const measure = (pp) => pp.evaluate(() => {
		const sc = document.querySelector(".pa-scroll").getBoundingClientRect();
		const body = document.querySelector(".pa-thread-body").getBoundingClientRect();
		const bots = [...document.querySelectorAll(".pa-bot-body")].map((e) => e.getBoundingClientRect()).filter((r) => r.width);
		const left = Math.min(...bots.map((r) => r.left)) - sc.left, right = sc.right - Math.max(...bots.map((r) => r.right));
		const s = document.querySelector(".pa-scroll");
		return { left: Math.round(left), right: Math.round(right), bodyL: Math.round(body.left - sc.left), bodyR: Math.round(sc.right - body.right), drift: s.scrollWidth - s.clientWidth, doc: document.documentElement.scrollWidth - innerWidth };
	});
	const out = {};
	for (const w of [375, 390, 430]) {
		const c = await browser.newContext({ viewport: { width: w, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });
		const pp = await c.newPage();
		await pp.goto(BASE);
		await pp.locator(".pa-bot-body").first().waitFor();
		await pp.waitForTimeout(500);
		const a = await measure(pp);
		await pp.screenshot({ path: join(SHOTS, `82-mobile-chat-gutter-${w}.png`) });
		await pp.goto(`${BASE}/?room=${ROOM}`);
		await pp.getByTestId("room-chat").waitFor();
		await pp.locator(".pa-bot-body").first().waitFor();
		await pp.waitForTimeout(500);
		const r = await measure(pp);
		if (!(await pp.locator(".pa-room-inline-av").first().isVisible())) throw new Error("手机群聊名字前应显示小头像");
		await pp.screenshot({ path: join(SHOTS, `83-mobile-room-gutter-${w}.png`) });
		await c.close();
		out[w] = { chat: a, room: r };
		for (const [k, m] of [["单聊", a], ["群聊", r]]) {
			if (Math.abs(m.left - m.right) > 2) throw new Error(`${w}px ${k}左右边距不对称：${JSON.stringify(m)}`);
			if (m.drift > 1 || m.doc > 0) throw new Error(`${w}px ${k}横向溢出：${JSON.stringify(m)}`);
		}
	}
	log("手机边距", JSON.stringify(out));
	// 桌面不变：仍显示头像列
	const d = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	const dp = await d.newPage();
	await dp.goto(BASE);
	await dp.locator(".pa-bot-body").first().waitFor();
	if (!(await dp.locator(".pa-msg.bot > .pa-av-col").first().isVisible())) throw new Error("桌面应保留头像列");
	await d.close();
});
await step("提议建群：聊天里说目标 → 可编辑的提议卡片（改名/改模型/加删成员/换管理者）→ 确认创建 → 群专属助理不在侧边栏 → 管理者提议加人 → 复制到我的助理 → 删群（保留选项）", async () => {
	await page.goto(`${BASE}/?agent=${AGENT}`);
	await page.locator("main textarea").waitFor();
	await send("帮我组个团队做新品发布");
	const card = page.getByTestId("room-proposal").last();
	await card.waitFor({ timeout: 30_000 });
	await card.getByTestId("proposal-name").fill("发布小组");
	await card.getByTestId("proposal-add").click();
	if ((await card.getByTestId("proposal-member").count()) !== 3) throw new Error("加成员");
	await card.getByTestId("pm-remove").last().click();
	await card.getByTestId("pm-name").nth(1).fill("写手");
	await card.getByTestId("pm-model").nth(1).click();
	await page.getByTestId("pm-model-option").first().click();
	await card.getByTestId("pm-manager").nth(1).click();
	await card.getByTestId("proposal-confirm").click();
	await page.getByTestId("room-title").filter({ hasText: "发布小组" }).waitFor();
	const rooms = await (await fetch(`${BASE}/api/rooms`)).json();
	const r = rooms.find((x) => x.name === "发布小组");
	if (r.managerId !== r.members.find((m) => m.name === "写手").agentId) throw new Error("管理者应是写手");
	const side = await page.getByTestId("sidebar-agent").allTextContents();
	if (side.some((t) => /写手|统筹/.test(t))) throw new Error("群专属助理不应出现在侧边栏");
	// 管理者提议加人（用户确认后才加入）
	await roomSay("帮我加个成员");
	const mp = page.getByTestId("member-proposal").last();
	await mp.waitFor({ timeout: 30_000 });
	await mp.getByTestId("proposal-confirm").click();
	await page.getByTestId("room-members").locator("button[title^='设计']").waitFor({ timeout: 10_000 });
	// 复制到我的助理
	await page.getByTestId("room-members").locator("button[title^='写手']").click();
	await page.getByTestId("room-agent-actions").waitFor();
	await page.getByTestId("copy-to-mine").click();
	await page.getByTestId("copy-memory").check();
	await page.getByTestId("copy-confirm").click();
	await page.getByTestId("copy-done").waitFor();
	await page.getByTestId("sidebar-agent").filter({ hasText: "写手" }).first().waitFor();
	// 删群：列出要删的群专属助理，可以保留
	await page.getByTestId("room-settings-btn").click();
	await page.getByTestId("room-delete").click();
	const dd = page.getByTestId("delete-room-dialog");
	await dd.waitFor();
	if ((await dd.getByTestId("keep-agent").count()) !== 3) throw new Error(`应列出 3 个群专属助理：${await dd.getByTestId("keep-agent").count()}`);
	await dd.locator("label").filter({ hasText: "设计" }).getByTestId("keep-agent").check();
	await page.screenshot({ path: join(SHOTS, "82-room-delete.png") });
	await dd.getByTestId("confirm-delete-room").click();
	await page.waitForFunction(() => !document.querySelector("[data-testid=delete-room-dialog]"));
	const agents = await (await fetch(`${BASE}/api/agents`)).json();
	if (agents.some((a) => a.name === "统筹")) throw new Error("没保留的群专属助理应被删除");
	if (!agents.some((a) => a.name === "设计" && a.scope === "user")) throw new Error("保留的应转成我的助理");
	if (!agents.some((a) => /^写手/.test(a.name) && a.scope === "user")) throw new Error("复制出来的助理不受影响");
	if ((await (await fetch(`${BASE}/api/rooms`)).json()).some((x) => x.name === "发布小组")) throw new Error("群应被删除");
});

await step("组队选模型 + 用量：提议卡片按角色挑模型并给理由、下拉按适合程度排序 → 每条回复的用量 → 设置 › 用量（价格未知显示 —，填自定义价后重算）→ 模型擅长可改 → 手机宽度", async () => {
	await page.setViewportSize({ width: 1280, height: 860 });
	await page.goto(`${BASE}/?agent=${AGENT}`);
	await page.locator("main textarea:not(.pa-card textarea)").waitFor();
	// 上一大步「提议建群」会在历史里留下提议卡，先关掉避免挡住发送
	for (const btn of await page.getByTestId("proposal-dismiss").all()) await btn.click().catch(() => {});
	await send("帮我组个团队做个活动");
	const card = page.getByTestId("room-proposal").last();
	await card.waitFor({ timeout: 30_000 });
	// 管理者「统筹」需要推理 → 挑 mock 推理模型；理由显示在卡片上
	await card.getByTestId("pm-model").nth(0).click();
	const modelMenu = page.getByTestId("pm-model-menu");
	await modelMenu.waitFor();
	const modelOpts = await modelMenu.getByTestId("pm-model-option").all();
	const firstModel = await modelOpts[0].getAttribute("data-model");
	if (firstModel !== "mock/echo-think") throw new Error(`统筹应挑推理模型：${firstModel}`);
	const firstText = (await modelOpts[0].textContent()) ?? "";
	if (!firstText.startsWith("★") || !/价格未知|免费|¥/.test(firstText)) throw new Error(`下拉应按分数排、带价格档：${firstText}`);
	await page.keyboard.press("Escape");
	const reasons = await card.getByTestId("pm-reason").allTextContents();
	if (reasons.length !== 2 || !/推理/.test(reasons[0])) throw new Error(`理由：${reasons}`);
	const ranked = await (await fetch(`${BASE}/api/proposals/models?needs=vision`)).json();
	if (ranked[0].id !== "echo" || !/看图/.test(ranked[0].reason)) throw new Error(`要看图应排 echo 第一：${JSON.stringify(ranked[0])}`);
	await card.scrollIntoViewIfNeeded();
	await card.screenshot({ path: join(SHOTS, "90-proposal-model-pick.png") });
	await card.getByTestId("proposal-dismiss").click();
	// 每条回复的用量（悬停显示）
	const u = page.getByTestId("msg-usage").last();
	await u.waitFor({ state: "attached", timeout: 10_000 });
	await u.hover();
	if (!/token/.test(await u.textContent())) throw new Error("用量行");
	await page.locator(".pa-bot-body").last().screenshot({ path: join(SHOTS, "91-message-usage.png") });
	// 设置 › 用量：mock 没有价格 → 「—」；填自定义价 → 有费用
	await page.goto(`${BASE}/?agent=${AGENT}&settings=usage`);
	const tab = page.getByTestId("usage-tab");
	await tab.waitFor();
	await page.getByTestId("usage-range-30d").click();
	await page.getByTestId("usage-cost").waitFor();
	const before = (await page.getByTestId("usage-cost").textContent()) ?? "";
	if (!/—/.test(before)) throw new Error(`mock 没有价格应显示 —：${before}`);
	const initial = await (await fetch(`${BASE}/api/usage/summary?range=30d`)).json();
	const mockUnknown = initial.byModel.filter((r) => r.provider === "mock").reduce((n, r) => n + r.unknownCalls, 0);
	if (!mockUnknown) throw new Error("应有 Mock 的未知价格调用待补价");
	// 不依赖配置列表顺序；前序测试可能留下其他服务和已删除服务的历史用量。
	const row = page.locator('[data-testid=price-row][data-model="mock/echo"]');
	await row.getByTestId("price-edit").click();
	await row.getByText("填单价").click();
	await row.getByTestId("price-input").fill("10");
	await row.getByTestId("price-output").fill("20");
	await row.locator("select[aria-label='适用范围']").selectOption("provider");
	await row.getByTestId("price-save").click();
	await page.waitForFunction(() => /¥\d/.test(document.querySelector("[data-testid=usage-cost]")?.textContent ?? ""), null, { timeout: 10_000 }).catch(async (e) => {
		throw new Error(`填价后费用没更新：${await page.getByTestId("usage-cost").textContent().catch(() => "?")} ${JSON.stringify(await (await fetch(`${BASE}/api/usage/settings`)).json()).slice(0, 400)} ${e}`);
	});
	const sum = await (await fetch(`${BASE}/api/usage/summary?range=30d`)).json();
	if (sum.totals.calls !== initial.totals.calls || sum.totals.unknownCalls !== initial.totals.unknownCalls - mockUnknown || !(sum.totals.cost > 0)) throw new Error(`汇总：${JSON.stringify(sum.totals)}`);
	if (sum.byModel.some((r) => r.provider === "mock" && r.unknownCalls !== 0)) throw new Error("Mock 的未知价格应全部重算");
	for (const r of initial.byModel.filter((r) => r.provider !== "mock")) {
		const next = sum.byModel.find((m) => m.provider === r.provider && m.model === r.model);
		if (!next || next.cost !== r.cost || next.unknownCalls !== r.unknownCalls) throw new Error(`给 Mock 补价不应修改其他服务的历史用量：${r.provider}/${r.model}`);
	}
	if (!sum.byModel.length || !sum.byAgent.length) throw new Error("分组");
	await page.getByTestId("usage-by-agent").click();
	await page.getByTestId("usage-by-model").click();
	await page.getByTestId("settings-dialog").screenshot({ path: join(SHOTS, "92-settings-usage.png") });
	// 美元显示
	await page.getByTestId("usage-currency").selectOption("USD");
	await page.waitForFunction(() => /\$/.test(document.querySelector("[data-testid=usage-cost]")?.textContent ?? ""), null, { timeout: 10_000 });
	await page.getByTestId("usage-currency").selectOption("CNY");
	// 模型能力（擅长）：在统一面板的服务卡片展开后的模型行里编辑，点标签开关、恢复默认
	await page.goto(`${BASE}/?agent=${AGENT}&settings=models`);
	await page.getByTestId("service-toggle-mock").click();
	const pmRow = page.getByTestId("service-models-mock").getByTestId("service-model").first();
	await pmRow.waitFor();
	await pmRow.getByTestId("model-strength-toggle").click();
	const t = page.getByTestId("strength-row").first().getByTestId("tag-coding");
	await t.waitFor();
	const was = await t.getAttribute("aria-pressed");
	await t.click();
	await page.waitForFunction((w) => document.querySelector("[data-testid=strength-row] [data-testid=tag-coding]")?.getAttribute("aria-pressed") !== w, was);
	await page.getByTestId("service-grid").scrollIntoViewIfNeeded();
	await page.getByTestId("settings-dialog").screenshot({ path: join(SHOTS, "93-model-strengths.png") });
	await r0.getByText("恢复默认").click();
	// 手机宽度：用量页不横向溢出
	const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });
	const p2 = await m.newPage();
	await p2.goto(`${BASE}/?agent=${AGENT}&settings=usage`);
	await p2.getByTestId("usage-cost").waitFor();
	const over = await p2.evaluate(() => document.documentElement.scrollWidth - innerWidth);
	if (over > 1) throw new Error(`手机横向溢出 ${over}px`);
	await p2.screenshot({ path: join(SHOTS, "94-mobile-usage.png") });
	await m.close();
});

await step("图片生成：设置里添加图片服务（自动获取识别图片模型 → 试生成 → 默认模型）→ 单聊让助理画图，图片直接显示可下载 → 安全策略拦截有中文提示 → 群里 @ 成员画图 → 助理可关闭画图", async () => {
	const img = await startMockImages({ key: "sk-img-e2e" });
	try {
		const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light", locale: "zh-CN" });
		const p = await c.newPage();
		await p.goto(`${BASE}/?settings=models`);
		// 统一面板里添加生图服务（不再有独立的「图片生成」区块）
		await p.getByTestId("add-service-open").click();
		await p.getByTestId("add-service").waitFor();
		await p.getByTestId("add-service-kind").click();
		await p.getByRole("option", { name: /生图服务/ }).click();
		const f = p.getByTestId("image-provider-form");
		await f.waitFor();
		await f.locator("[data-kind=openai]").click();
		await f.getByTestId("image-name").fill("画图中转");
		await f.getByTestId("image-base-url").fill(img.url);
		await f.getByTestId("image-key").fill("sk-img-e2e");
		await f.getByTestId("image-fetch").click();
		// 自动识别出图片模型并默认勾上（聊天模型 / 向量模型不算）
		await f.locator("[data-model=gpt-image-1]").filter({ hasText: "✓" }).waitFor();
		if (await f.locator("[data-model=relay-chat]").count()) throw new Error("聊天模型不应出现在图片模型里");
		await f.getByTestId("image-test").filter({ hasText: "gpt-image-1" }).click();
		await f.getByTestId("image-test-ok").waitFor({ timeout: 20_000 });
		await p.screenshot({ path: join(SHOTS, "90-image-provider.png") });
		await f.getByTestId("image-save").click();
		await p.getByTestId("default-image-model").waitFor();
		const opt = await p.getByTestId("default-image-model").innerText();
		if (!/画图中转 \/ gpt-image-1/.test(opt)) throw new Error(`默认图片模型显示不对：${opt}`);
		await c.close();
		// 单聊：画图 → 图片附件（预览 + 下载）
		// 用一个新助理（前面步骤的聊天里可能有带输入框的卡片）
		const painter = (await jpost("/api/agents", { name: "画师" })).id;
		await page.goto(`${BASE}/?agent=${painter}`);
		const before = await page.locator("main [data-testid=image-attachment]").count();
		await send("画一张 海边的橘猫，水彩风格");
		await page.locator("main").getByText("画好了").last().waitFor({ timeout: 30_000 });
		await waitFor(async () => (await page.locator("main [data-testid=image-attachment]").count()) > before);
		await page.locator("main [data-testid=image-attachment] img").last().waitFor();
		const call = img.seen.filter((x) => x.path === "/v1/images/generations").pop();
		if (!/海边的橘猫/.test(call?.json?.prompt ?? "")) throw new Error(`prompt 没传到图片服务：${call?.json?.prompt}`);
		const dl = page.waitForEvent("download");
		await page.locator("main [data-testid=image-attachment]").last().getByRole("button", { name: "下载" }).click();
		if (!/\.png$/.test((await dl).suggestedFilename())) throw new Error("下载的文件名应是 png");
		const ws = await (await fetch(`${BASE}/api/agents/${painter}/workspace?path=images`)).json().catch(() => null);
		if (ws && Array.isArray(ws) && !ws.some((e) => /海边的橘猫/.test(e.name))) throw new Error("图片应存进工作区 images/");
		await page.screenshot({ path: join(SHOTS, "91-chat-generated-image.png") });
		// 安全策略拦截
		await send("画一张 违规内容");
		await page.locator("main").getByText(/没画成.*安全策略/).last().waitFor({ timeout: 30_000 });
		// 模型页：图片模型选择（跟随默认 / 指定 / 不画图）
		if (!(await page.locator(".pa-pane-wrap").count())) await page.getByRole("button", { name: "信息面板" }).click();
		await infoTab("models");
		await expandAgentModelSection(page, "image");
		await page.getByTestId("agent-image-select").selectOption("off");
		await waitFor(async () => (await (await fetch(`${BASE}/api/agents/${painter}/image-model`)).json()).choice.mode === "off");
		await page.getByTestId("agent-image-select").selectOption("default");
		await waitFor(async () => (await (await fetch(`${BASE}/api/agents/${painter}/image-model`)).json()).choice.mode === "default");
		// 群聊：@B 画图，图片显示在 B 的发言里
		const rooms = await (await fetch(`${BASE}/api/rooms`)).json();
		const room = rooms.find((r) => r.name === "三人组") ?? rooms[0];
		if (room) {
			await page.goto(`${BASE}/?room=${room.id}`);
			await roomSay("@B 画一张 群聊海报");
			await botsOf("B").locator("[data-testid=image-attachment] img").last().waitFor({ timeout: 40_000 });
			await roomIdle();
			await page.screenshot({ path: join(SHOTS, "92-room-generated-image.png") });
		}
	} finally {
		img.close();
	}
});

// 语音采集 worklet（blob: 模块）与 PDF 预览（<object data=blob:>）都靠 CSP 里的 blob: 白名单，
// 少写一条就静默失效（真浏览器实测过：worklet 报 AbortError、PDF 被 frame-src 拦）；首屏主题靠同源外部 script。
await step("CSP：语音采集 worklet / PDF 预览 / 首屏主题在真实响应头下可用", async () => {
	const msgs = [];
	const onMsg = (m) => msgs.push(`${m.type()}: ${m.text()}`);
	page.on("console", onMsg);
	try {
		const csp = (await fetch(BASE)).headers.get("content-security-policy") ?? "";
		const probe = await probeCsp(page);
		const problems = cspProblems(csp, probe, msgs);
		if (problems.length) throw new Error(problems.join("；"));
	} finally {
		page.off("console", onMsg);
	}
});

await browser.close();
await stopServer();
console.log("\n===== 结果 =====");
for (const r of results) console.log(r.join(" "));
writeFileSync(join(SHOTS, "RESULTS.md"), `# E2E 结果（${new Date().toISOString()}）\n\n${results.map((r) => `- ${r[0]} ${r[1]}${r[2] ? `：${r[2]}` : ""}`).join("\n")}\n`);
process.exit(results.some((r) => r[0] === "❌") ? 1 : 0);
