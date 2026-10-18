// 桌宠端到端：启动服务（Mock 模型）+ 模拟图片服务 → 截图桌宠窗口各状态、设置页、孵化流程、导入宠物包。
// 用法：npm run build -w @pi-assistant/web && node e2e/pet.mjs
// 截图写到 docs/screenshots/pet-*.png
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { PNG } from "pngjs";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = process.env.E2E_DATA ?? "/tmp/pia-e2e-pet";
const SHOTS = artifactDir("screenshots");
const freePort = () => new Promise((r) => { const sv = createNetServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => r(p)); }); });
const PORT = Number(process.env.E2E_PORT) || (await freePort());
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME ?? "/usr/bin/google-chrome";
mkdirSync(SHOTS, { recursive: true });
rmSync(DATA, { recursive: true, force: true });
const log = (...a) => console.log("[pet-e2e]", ...a);

// ---- 模拟图片模型：按提示词里的姿势，从内置宠物「小铁」的精灵图里取一格，贴到 512x512 白底上返回（测试去底 / 拼图流程）
const sheet = PNG.sync.read(readFileSync(join(ROOT, "apps/web/public/pets/xiaotie/spritesheet.png")));
const POSE_CELL = [[/jumping with joy/, 4, 2], [/sad and deflated/, 5, 5], [/typing busily/, 7, 1], [/head tilted/, 8, 1], [/raising one paw/, 6, 0], [/./, 0, 0]];
function poseImage(prompt) {
	const [, row, col] = POSE_CELL.find(([re]) => re.test(prompt));
	const out = new PNG({ width: 512, height: 512 });
	out.data.fill(255);
	const k = 2.2;
	for (let y = 0; y < 512; y++)
		for (let x = 0; x < 512; x++) {
			const sx = Math.floor((x - 45) / k), sy = Math.floor((y - 30) / k);
			if (sx < 0 || sy < 0 || sx >= 192 || sy >= 208) continue;
			const si = ((row * 208 + sy) * sheet.width + col * 192 + sx) * 4, di = (y * 512 + x) * 4;
			const a = sheet.data[si + 3] / 255;
			for (let c = 0; c < 3; c++) out.data[di + c] = Math.round(sheet.data[si + c] * a + 255 * (1 - a));
		}
	return PNG.sync.write(out);
}
const seen = [];
const img = createServer(async (req, res) => {
	const bufs = [];
	for await (const c of req) bufs.push(c);
	const body = Buffer.concat(bufs).toString("latin1");
	const send = (j) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(j)));
	if (req.url.endsWith("/models")) return send({ data: [{ id: "gpt-image-1" }] });
	const prompt = req.headers["content-type"]?.includes("json") ? JSON.parse(body).prompt : (/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/.exec(body)?.[1] ?? "");
	seen.push({ path: req.url, prompt });
	send({ data: [{ b64_json: poseImage(prompt).toString("base64") }] });
}).listen(0, "127.0.0.1");
await new Promise((r) => img.once("listening", r));
const IMG = `http://127.0.0.1:${img.address().port}/v1`;

const server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_HOST_CONTROL_DRY_RUN: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => !String(d).includes("ExperimentalWarning") && process.stdout.write(`[server!] ${d}`));
process.on("exit", () => server.kill("SIGKILL"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 150; i++) {
	try {
		if ((await fetch(`${BASE}/api/system`)).ok) break;
	} catch {}
	await sleep(200);
}
const j = async (path, method = "GET", body) => (await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();

// 准备：完成引导、两个助理、开启桌宠
await j("/api/settings", "PUT", { onboarded: true });
const a1 = await j("/api/agents", "POST", { name: "小派", avatar: "🐱" });
const a2 = await j("/api/agents", "POST", { name: "设计师", avatar: "🎨" });
await j("/api/pet/settings", "PUT", { enabled: true, scale: 1 });
const db = new DatabaseSync(join(DATA, "data.db"));
const now = () => Date.now();

const results = [];
const check = (name, ok, extra = "") => (results.push([ok ? "✅" : "❌", name, extra]), log(ok ? "✅" : "❌", name, extra));

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
// 桌宠窗口：和托盘里一样大（300x340），截图时垫一张“桌面”背景，看透明效果
const pctx = await browser.newContext({ viewport: { width: 300, height: 340 }, locale: "zh-CN", deviceScaleFactor: 2 });
const pet = await pctx.newPage();
pet.on("pageerror", (e) => log("页面错误", String(e)));
await pet.goto(`${BASE}/pet`);
await pet.waitForSelector("[data-testid=pet-sprite]");
const desk = async (file) => {
	await pet.addStyleTag({ content: "html.pa-pet-root body{background:linear-gradient(135deg,#7dd3fc,#a78bfa 60%,#f9a8d4)!important}.pa-pet-preview-tip{display:none}" }).catch(() => {});
	await sleep(700);
	await pet.screenshot({ path: join(SHOTS, file) });
};
const stateIs = async (s) => {
	for (let i = 0; i < 30; i++) {
		if ((await pet.getAttribute("[data-testid=pet-window]", "data-state")) === s) return true;
		await sleep(200);
	}
	return false;
};

check("空闲状态", await stateIs("idle"));
await sleep(1500); // 让开场挥手播完
await desk("pet-01-idle.png");

// 思考 / 干活
db.prepare("UPDATE agents SET status='running' WHERE id=?").run(a1.id);
db.prepare("INSERT INTO messages(id, agent_id, role, content, meta, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)").run("m_tool", a1.id, "tool", "", JSON.stringify({ toolName: "mcp__hostpc__click" }), "running", now(), now());
check("操作电脑状态", await stateIs("computer"));
check("气泡显示在做什么", (await pet.textContent("[data-testid=pet-bubble]"))?.includes("正在操作你的电脑") ?? false);
await desk("pet-02-computer.png");

// 等你批准：气泡里批准
db.prepare("INSERT INTO requests(id, agent_id, kind, tool_name, payload, status, created_at) VALUES(?,?,?,?,?,?,?)").run("ap_pet", a1.id, "approval", "bash", JSON.stringify({ summary: "删除下载文件夹里 3 个 .dmg 安装包", risk: "medium" }), "pending", now());
check("等批准状态", await stateIs("approval"));
await pet.waitForSelector("[data-testid=pet-request]");
await desk("pet-03-approval.png");
// 没有真正等待的 Promise（是直接插库的），resolve 仍会更新状态
await pet.click("[data-testid=pet-approve]");
await sleep(600);
check("批准后请求关闭", db.prepare("SELECT status FROM requests WHERE id='ap_pet'").get().status === "approved");

// 单击：快速对话
db.prepare("UPDATE agents SET status='idle'").run();
db.prepare("UPDATE messages SET status='done' WHERE id='m_tool'").run();
await sleep(1200);
const body = await pet.$("[data-testid=pet-sprite]");
const bb = await body.boundingBox();
await pet.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
await pet.waitForSelector("[data-testid=pet-chat]");
await pet.fill("[data-testid=pet-input]", "帮我总结一下今天的待办");
await desk("pet-04-quick-chat.png");
await pet.press("[data-testid=pet-input]", "Enter");
let sent = false;
for (let i = 0; i < 30 && !sent; i++) {
	sent = !!db.prepare("SELECT 1 FROM messages WHERE agent_id=? AND role='user' AND content=?").get(a1.id, "帮我总结一下今天的待办");
	await sleep(200);
}
check("快速对话发给当前助理", sent);
// Mock 模型回复后：做完（跳一下 + 回复摘要）
check("做完状态", await stateIs("done"));
await sleep(2000); // 等“已发给…”提示消失，露出回复摘要
await desk("pet-05-done.png");

// 右键菜单
await pet.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2, { button: "right" });
await pet.waitForSelector("[data-testid=pet-menu]");
await desk("pet-06-menu.png");
await pet.keyboard.press("Escape");
await sleep(200);
check("Esc 收起菜单", !(await pet.isVisible("[data-testid=pet-menu]")));

// 出错
db.prepare("INSERT INTO messages(id, agent_id, role, content, meta, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)").run("m_err", a1.id, "assistant", "", "{}", "error", now() + 10_000, now() + 10_000);
check("出错状态", await stateIs("error"));
await pet.mouse.click(5, 5);
await desk("pet-07-error.png");

// ---- 设置页
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "zh-CN", colorScheme: "light" });
const page = await ctx.newPage();
page.on("pageerror", (e) => log("页面错误", String(e)));
await page.goto(`${BASE}/?settings=pet`);
await page.waitForSelector("[data-testid=pet-settings]");
await sleep(800);
check("设置页列出 4 只内置宠物", (await page.locator("[data-pet]").count()) === 4);
check("没配图片模型时提示去配置", await page.isVisible("[data-testid=pet-hatch-nomodel]"));
await page.screenshot({ path: join(SHOTS, "pet-10-settings.png") });
await page.click("[data-pet=xiaotie]");
await sleep(400);
check("改默认宠物", (await j("/api/pet/settings")).defaultPet === "xiaotie");
await page.click("[data-pet=miao]");

// 导入：选 pet.json + 精灵图
await page.setInputFiles("[data-testid=pet-import-file]", [
	{ name: "pet.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ id: "robo", displayName: "导入的小铁", description: "导入测试", spritesheetPath: "spritesheet.png" })) },
	{ name: "spritesheet.png", mimeType: "image/png", buffer: readFileSync(join(ROOT, "apps/web/public/pets/xiaotie/spritesheet.png")) },
]);
await page.waitForSelector("text=已导入「导入的小铁」");
check("导入宠物包", (await j("/api/pets")).items.some((p) => p.id === "robo"));
// 导入尺寸不对的图 → 明确报错
await page.setInputFiles("[data-testid=pet-import-file]", [{ name: "x.png", mimeType: "image/png", buffer: PNG.sync.write(new PNG({ width: 64, height: 64 })) }]);
await page.waitForSelector("text=/1536×1872/");
check("尺寸不对时提示", true);

// ---- 孵化：接上模拟图片服务
const prov = await j("/api/image-models/providers", "POST", { kind: "openai", name: "测试图片服务", baseUrl: IMG, apiKey: "sk-test", models: ["gpt-image-1"] });
await j("/api/image-models/default", "PUT", { provider: prov.id, model: "gpt-image-1" });
await page.reload();
await page.waitForSelector("[data-testid=pet-hatch-desc]");
await page.fill("[data-testid=pet-hatch-desc]", "戴耳机的蓝色小机器人");
await page.click("[data-testid=pet-hatch-go]");
await page.waitForSelector("[data-testid=pet-hatch-result]", { timeout: 60_000 });
check("孵化调用了 6 次图片模型（第 2 张起带参考图）", seen.length === 6 && seen.slice(1).every((s) => s.path.endsWith("/images/edits")), JSON.stringify(seen.map((s) => s.path)));
await page.locator("[data-testid=pet-hatch]").scrollIntoViewIfNeeded();
await sleep(600);
await page.locator("[data-testid=pet-hatch]").screenshot({ path: join(SHOTS, "pet-11-hatch.png") });
await page.click("[data-testid=pet-hatch-keep]");
await page.waitForSelector("text=/孵化好了/");
const all = (await j("/api/pets")).items;
const hatched = all.find((p) => !p.builtin && p.prompt === "戴耳机的蓝色小机器人");
check("孵化的宠物已保存并设为默认", !!hatched && (await j("/api/pet/settings")).defaultPet === hatched.id);
// 校验孵化出的精灵图
const hs = PNG.sync.read(Buffer.from(await (await fetch(BASE + hatched.url)).arrayBuffer()));
const FR = [6, 8, 8, 4, 5, 8, 6, 6, 6];
let bad = [];
for (let r = 0; r < 9; r++)
	for (let c = 0; c < 8; c++) {
		let n = 0;
		for (let y = 0; y < 208; y += 2) for (let x = 0; x < 192; x += 2) if (hs.data[((r * 208 + y) * hs.width + c * 192 + x) * 4 + 3] > 8) n++;
		if (c < FR[r] && n < 50) bad.push(`${r}/${c} 空`);
		if (c >= FR[r] && n > 0) bad.push(`${r}/${c} 不透明`);
	}
const corner = hs.data[3];
check("孵化精灵图 1536x1872、格子正确、背景透明", hs.width === 1536 && hs.height === 1872 && !bad.length && corner === 0, bad.join(","));
await page.screenshot({ path: join(SHOTS, "pet-12-settings-after.png") });
// 桌宠换成孵化的宠物
await pet.reload();
await pet.waitForSelector("[data-testid=pet-sprite]");
await sleep(1500);
await desk("pet-08-hatched.png");

await browser.close();
server.kill("SIGTERM");
img.close();
const fail = results.filter((r) => r[0] === "❌");
console.log(`\n${results.length - fail.length}/${results.length} 通过`);
for (const r of fail) console.log(r.join(" "));
process.exit(fail.length ? 1 : 0);
