// 端到端验证：启动服务（Mock 模型）→ Playwright 无头浏览器走完主要流程 → 截图 → 重启服务验证持久化。
// 用法：node e2e/run.mjs   （需要先 npm run build -w apps/web）
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { fakeHindsight } from "./fixtures/fake-hindsight.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startMockOpenAI } from "./mock-openai.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
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
const results = [];
let AGENT = "";
async function step(name, fn) {
	try {
		await fn();
		results.push(["✅", name]);
		log("✅", name);
	} catch (e) {
		results.push(["❌", name, String(e).slice(0, 300)]);
		log("❌", name, e);
		await page?.screenshot({ path: `/tmp/e2e-fail-${results.length}.png` }).catch(() => {});
		if (process.env.FAIL_FAST) process.exit(1);
	}
}

await startServer();
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true, colorScheme: "light" });
page = await ctx.newPage();
page.setDefaultTimeout(15_000);
const bubbleCount = () => page.locator("main .prose").count();
// 发送前等输入框可用；发送后确认输入框已清空（真的发出去了）。
// 页面刚加载时对话历史还在异步载入，那时填进去的字可能被重渲染冲掉——这是以前偶发失败的原因之一。
const send = async (text) => {
	const box = page.locator("main textarea");
	await box.waitFor();
	await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
	for (let i = 0; i < 3; i++) {
		await box.fill(text);
		if ((await box.inputValue()) === text) break;
	}
	await box.press("Enter");
	await page.waitForFunction(() => document.querySelector("main textarea")?.value === "", null, { timeout: 10_000 });
};

await step("首次运行向导（选择 provider → 登录 → 默认模型 → 创建第一个助理）", async () => {
	await page.goto(BASE);
	await page.getByText("欢迎使用 Pi Assistant").waitFor();
	await page.screenshot({ path: join(SHOTS, "01-onboarding-welcome.png") });
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
});

await step("后台任务", async () => {
	await send("把统计工作放到后台做");
	await page.locator("main").getByText("后台任务：统计工作区文件").last().waitFor({ timeout: 15_000 });
	await page.locator("main").getByText("已完成").first().waitFor({ timeout: 30_000 });
	await page.screenshot({ path: join(SHOTS, "06-desktop-chat.png") });
});

await step("右侧信息面板：文件 / 电脑", async () => {
	await page.locator("aside").last().getByRole("tab", { name: "文件" }).click();
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(SHOTS, "07-info-files.png") });
	await page.locator("aside").last().getByRole("tab", { name: "电脑" }).click();
	await page.locator("aside").last().getByText("report.md").waitFor();
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
	await phone.close();
	await page.getByRole("button", { name: "固定地址 / 入口" }).click();
	await page.getByTestId("named-tunnel").getByText("Account › Cloudflare Tunnel › Edit").first().waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "09c-named-tunnel.png") });
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

await step("外观：4 套主题 + 浅色/深色/跟随系统 + 强调色，按设备持久化", async () => {
	const c = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", locale: "zh-CN" });
	const p = await c.newPage();
	await p.goto(`${BASE}/?settings=appearance`);
	await p.getByRole("button", { name: "跟随系统" }).waitFor();
	const radios = p.getByRole("radio");
	if ((await radios.count()) < 4) throw new Error("应至少有 4 套主题");
	if ((await p.evaluate(() => document.documentElement.dataset.skin)) !== "linear") throw new Error("默认主题应为 linear");
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
	// 编辑第二个助理：上传图片头像 + 改名
	await page.locator("aside").last().getByRole("tab", { name: "设置", exact: true }).click();
	await page.locator("[data-testid=avatar-file]").setInputFiles(join(import.meta.dirname, "..", "apps", "web", "public", "icon-192.png"));
	await page.getByPlaceholder("给助理起个名字").fill("研究员 R");
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await page.getByRole("button", { name: "已保存" }).waitFor();
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

await step("Phase 2：记忆（聊天里记住 → 记忆页可见/编辑）", async () => {
	await send("记住：我喜欢简洁的回答");
	await page.locator("main").getByText("好的，我记住了").last().waitFor({ timeout: 15_000 });
	const pane = page.locator("aside").last();
	await pane.getByRole("tab", { name: "记忆" }).click();
	await pane.getByText("我喜欢简洁的回答").waitFor();
	await pane.getByRole("button", { name: "添加记忆" }).click();
	await pane.locator("textarea").fill("我在上海，时区 Asia/Shanghai");
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
		await pane.getByRole("tab", { name: "记忆" }).click();
		await pane.getByLabel("此助理的记忆后端").selectOption("hindsight");
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
		await pane.getByLabel("此助理的记忆后端").selectOption("").catch(() => {});
		await hs.stop();
	}
});

await step("Phase 2：定时任务（助理创建需审批 → 定时任务页 → 立即运行 → 运行历史）", async () => {
	await send("每天早上 8 点给我一份简报");
	await page.locator("main").getByText("需要你的批准").last().waitFor({ timeout: 15_000 });
	await page.getByRole("button", { name: "批准", exact: true }).last().click();
	await page.locator("main").getByText("定时任务设好了").last().waitFor({ timeout: 15_000 });
	const pane = page.locator("aside").last();
	await pane.getByRole("tab", { name: "定时任务" }).click();
	const item = pane.locator("[data-testid=routine-item]").first();
	await item.getByText("每日简报").waitFor();
	await item.getByText("0 8 * * *").waitFor();
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

	// 助理设置里按助理启用
	const pane = page.locator("aside").last();
	await pane.getByRole("tab", { name: "设置" }).click();
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
	for (const skin of ["linear", "glass", "warm", "noir"]) {
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
		await f.getByRole("button", { name: "测试连接" }).click();
		await f.getByText(/连接成功：中转站回复/).waitFor();
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

// ================================================================ Phase 3
const openPane = async (tab) => {
	if (!(await page.locator(".pa-pane-wrap").count())) await page.getByRole("button", { name: "信息面板" }).click();
	await page.locator("aside").last().getByRole("tab", { name: tab, exact: true }).click();
};
const SHOP = `data:text/html;charset=utf-8,${encodeURIComponent(`<title>测试商店</title><body style="font-family:sans-serif;padding:40px"><h1>测试商店 · 结算</h1><p>无线耳机 × 1　¥199</p><form onsubmit="document.body.innerHTML='<h1>下单成功</h1>';return false"><label>收货人 <input name="n" value="邓邓"></label><br><br><button type="submit">提交订单</button></form></body>`)}`;
await step("Phase 3 浏览器：助理打开网页（有 Docker 时在「电脑」实时画面里）→ 点「提交订单」需审批 → 拒绝不提交 → 本任务内都允许", async () => {
	if (process.env.E2E_DESKTOP) {
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

await step("权限档位：输入框工具栏「助理电脑」旁的权限按钮切换本助理档位（调高要确认，完全权限要输入确认语）", async () => {
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
	await menu.locator("[data-testid=tier-confirm]").waitFor();
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "44-chat-tier-menu.png") });
	await menu.locator("[data-testid=tier-ack]").check();
	await menu.locator("[data-testid=tier-confirm]").getByRole("button", { name: "确认" }).click();
	await pill.getByText("信任").waitFor({ timeout: 10_000 });
	// 完全权限：要输入确认语
	await pill.click();
	await menu.locator("[data-testid=tier-full]").click();
	await menu.locator("[data-testid=tier-ack]").check();
	if (await menu.locator("[data-testid=tier-confirm]").getByRole("button", { name: "确认" }).isEnabled()) throw new Error("没输入确认语也能确认");
	await menu.locator("[data-testid=tier-confirm-text]").fill("我了解风险，允许完全控制这台电脑");
	await page.waitForTimeout(300);
	await page.screenshot({ path: join(SHOTS, "45-chat-tier-full-confirm.png") });
	await menu.locator("[data-testid=tier-confirm]").getByRole("button", { name: "确认" }).click();
	await pill.getByText("完全权限").waitFor({ timeout: 10_000 });
	// 调低直接生效
	await pill.click();
	await menu.locator("[data-testid=tier-bounded]").click();
	await pill.getByText("限定").waitFor({ timeout: 10_000 });
	await page.evaluate(() => fetch("/api/host-control", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) }));
	await page.waitForTimeout(300);
});

await step("输入框工具栏：模型选择（可搜索）+ 思考强度（只在支持推理的模型上出现）", async () => {
	const mp = page.locator("[data-testid=model-picker]");
	await mp.waitFor();
	if (await page.locator("[data-testid=thinking-picker]").count()) throw new Error("不支持推理的模型不应显示思考强度");
	await mp.click();
	await page.locator("[data-testid=model-search]").fill("推理");
	const opt = page.locator("[data-testid=model-option]");
	await opt.first().waitFor();
	if ((await opt.count()) !== 1) throw new Error("搜索应只剩 1 个模型");
	await page.waitForTimeout(200);
	await page.screenshot({ path: join(SHOTS, "46-composer-model-picker.png") });
	await opt.first().click();
	await mp.getByText("Mock 推理模型").waitFor();
	const tp = page.locator("[data-testid=thinking-picker]");
	await tp.waitFor();
	await tp.click();
	await page.locator("[data-testid=thinking-high]").click();
	await tp.getByText("高").waitFor();
	await tp.click();
	await page.locator("[data-testid=thinking-menu]").waitFor();
	await page.waitForTimeout(200);
	await page.screenshot({ path: join(SHOTS, "47-composer-thinking.png") });
	await page.keyboard.press("Escape");
	// 换模型后照常聊天（服务端原地切换 Pi 会话的模型 / 思考强度）
	await send("你好");
	await page.locator("main").getByText(/你好/).last().waitFor();
	const before = await bubbleCount();
	await page.waitForFunction((n) => document.querySelectorAll("main .prose").length > n, before - 1, { timeout: 20_000 });
	// 换回不支持推理的模型：思考强度隐藏
	await mp.click();
	await page.locator("[data-testid=model-search]").fill("Mock 模型");
	await page.locator("[data-testid=model-option]").first().click();
	await tp.waitFor({ state: "detached", timeout: 10_000 });
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

await browser.close();
await stopServer();
console.log("\n===== 结果 =====");
for (const r of results) console.log(r.join(" "));
writeFileSync(join(SHOTS, "RESULTS.md"), `# E2E 结果（${new Date().toISOString()}）\n\n${results.map((r) => `- ${r[0]} ${r[1]}${r[2] ? `：${r[2]}` : ""}`).join("\n")}\n`);
process.exit(results.some((r) => r[0] === "❌") ? 1 : 0);
