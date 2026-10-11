// 端到端验证：启动服务（Mock 模型）→ Playwright 无头浏览器走完主要流程 → 截图 → 重启服务验证持久化。
// 用法：node e2e/run.mjs   （需要先 npm run build -w apps/web）
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = process.env.E2E_DATA ?? "/tmp/huhao-e2e";
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
	server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, HUHAO_DATA_DIR: DATA, HUHAO_MOCK: "1", HUHAO_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
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

await step("首次运行向导（选择 provider → 登录 → 默认模型）", async () => {
	await page.goto(BASE);
	await page.getByText("欢迎使用胡好好").waitFor();
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
	await page.getByText("欢迎使用胡好好").waitFor({ state: "detached" });
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
	await page.locator("aside").getByRole("button", { name: "文件" }).click();
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(SHOTS, "07-info-files.png") });
	await page.locator("aside").getByRole("button", { name: "电脑" }).click();
	await page.locator("aside").getByText("report.md").waitFor();
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
	await pp.waitForFunction(() => JSON.parse(localStorage.getItem("huhao.conn") ?? "null")?.token, null, { timeout: 10_000 });
	const conn = await pp.evaluate(() => JSON.parse(localStorage.getItem("huhao.conn")));
	if (!conn?.token?.startsWith("hh_")) throw new Error("没有拿到 token");
	// 用 token 访问 API（模拟经隧道的远程请求：带转发头时必须鉴权）
	const r1 = await fetch(`${BASE}/api/agents`, { headers: { "cf-connecting-ip": "1.2.3.4" } });
	const r2 = await fetch(`${BASE}/api/agents`, { headers: { "cf-connecting-ip": "1.2.3.4", authorization: `Bearer ${conn.token}` } });
	if (r1.status !== 401 || r2.status !== 200) throw new Error(`鉴权异常 ${r1.status} ${r2.status}`);
	await phone.close();
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

await step("深色模式截图", async () => {
	const d = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", locale: "zh-CN" });
	const dp = await d.newPage();
	await dp.goto(BASE);
	await dp.getByText("后台任务：统计工作区文件").waitFor();
	await dp.waitForTimeout(500);
	await dp.screenshot({ path: join(SHOTS, "14-desktop-dark.png") });
	await d.close();
});

let before = 0;
await step("重启服务后历史仍在 + 未完成工作自动续跑", async () => {
	before = (await (await fetch(`${BASE}/api/agents/huhao/messages`)).json()).length;
	// 发起一个耗时命令，执行中途杀掉服务
	await fetch(`${BASE}/api/agents/huhao/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "统计工作区文件" }) });
	await new Promise((r) => setTimeout(r, 900));
	await stopServer();
	await startServer();
	await page.reload();
	await page.locator("main").getByText("服务已重启，正在继续上次未完成的工作").last().waitFor({ timeout: 15_000 });
	await page.locator("main").getByText("报告已经生成并发给你了").last().waitFor();
	const after = (await (await fetch(`${BASE}/api/agents/huhao/messages`)).json()).length;
	if (after <= before) throw new Error(`消息数 ${before} → ${after}`);
	await page.waitForTimeout(3000);
	await page.screenshot({ path: join(SHOTS, "15-after-restart.png") });
});

await browser.close();
await stopServer();
console.log("\n===== 结果 =====");
for (const r of results) console.log(r.join(" "));
writeFileSync(join(SHOTS, "RESULTS.md"), `# E2E 结果（${new Date().toISOString()}）\n\n${results.map((r) => `- ${r[0]} ${r[1]}${r[2] ? `：${r[2]}` : ""}`).join("\n")}\n`);
process.exit(results.some((r) => r[0] === "❌") ? 1 : 0);
