// 端到端验证：启动服务（Mock 模型）→ Playwright 无头浏览器走完主要流程 → 截图 → 重启服务验证持久化。
// 用法：node e2e/run.mjs   （需要先 npm run build -w apps/web）
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startMockOpenAI } from "./mock-openai.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = process.env.E2E_DATA ?? "/tmp/pia-e2e";
const SHOTS = join(ROOT, "docs/screenshots");
const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
mkdirSync(SHOTS, { recursive: true });
rmSync(DATA, { recursive: true, force: true });

let server;
let page;
process.on("exit", () => server?.kill("SIGKILL"));
const log = (...a) => console.log("[e2e]", ...a);
function startServer() {
	server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
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
const send = async (text) => {
	await page.locator("main textarea").fill(text);
	await page.locator("main textarea").press("Enter");
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
	const relay = await startMockOpenAI({ port: 18080, key: "sk-relay-test", requiredHeader: ["x-relay-team", "e2e"] });
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
		const r = await fetch(`${BASE}/api/models/default`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: cid, model: "relay-chat" }) });
		if (!r.ok) throw new Error(`设默认模型失败 ${r.status}`);
		await c.close();
		await page.goto(BASE);
		await send("你好，中转站");
		await page.locator("main").getByText("中转站回复（relay-chat）：收到「你好，中转站」").last().waitFor();
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
		await fetch(`${BASE}/api/models/default`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "mock", model: "echo" }) }).catch(() => {});
	}
});

await browser.close();
await stopServer();
console.log("\n===== 结果 =====");
for (const r of results) console.log(r.join(" "));
writeFileSync(join(SHOTS, "RESULTS.md"), `# E2E 结果（${new Date().toISOString()}）\n\n${results.map((r) => `- ${r[0]} ${r[1]}${r[2] ? `：${r[2]}` : ""}`).join("\n")}\n`);
process.exit(results.some((r) => r[0] === "❌") ? 1 : 0);
