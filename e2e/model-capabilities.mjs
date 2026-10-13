// 模型能力相关回归：不刷新页面新增中转模型 → 聊天思考强度；图片列表按输出能力过滤。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
const ROOT = new URL("..", import.meta.url).pathname;
const DATA = "/tmp/pia-e2e-model-capabilities";
rmSync(DATA, { recursive: true, force: true });
const PORT = await new Promise((r) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const relay = httpServer((req, res) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ data: [
		{ id: "relay-painter", modalities: { input: ["text"], output: ["image"] } },
		{ id: "image-chat", modalities: { input: ["text", "image"], output: ["text"] } },
		{ id: "deepseek-r1" }, { id: "gpt-image-1" },
	] }));
}).listen(0, "127.0.0.1");
await new Promise((r) => relay.once("listening", r));
const relayBase = `http://127.0.0.1:${relay.address().port}/v1`;
const server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: ROOT, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_PORT: String(PORT), PIA_MOCK: "1", PIA_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
server.stderr.on("data", (d) => process.stdout.write(d));
const wait = async (fn) => { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) }); assert.ok(r.ok, await r.clone().text()); return r.json(); };
let browser;
try {
	await wait(async () => (await fetch(BASE + "/api/system")).ok);
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "模型测试" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
	await page.goto(`${BASE}/?agent=${a.id}`);
	await page.getByTestId("model-picker").waitFor();
	assert.equal(await page.getByTestId("thinking-picker").count(), 0);
	const p = await j("/api/models/custom", "POST", { name: "推理中转", api: "openai-completions", baseUrl: relayBase, noKey: true, models: [{ id: "deepseek-r1" }] });
	await j(`/api/agents/${a.id}`, "PATCH", { model: { provider: p.id, id: "deepseek-r1" } });
	await page.getByTestId("thinking-picker").click();
	await page.getByTestId("thinking-high").click();
	await wait(async () => (await j("/api/agents")).find((x) => x.id === a.id).thinking === "high");
	console.log("✅ 新增中转后无需刷新，聊天模型旁可选思考强度并保存");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByTestId("thinking-picker").click();
	await page.getByTestId("thinking-low").click();
	await wait(async () => (await j("/api/agents")).find((x) => x.id === a.id).thinking === "low");
	console.log("✅ 手机聊天可选择思考强度");
	await page.goto(`${BASE}/?agent=${a.id}&settings=models`);
	await page.getByTestId("add-image-provider").click();
	const f = page.getByTestId("image-provider-form");
	await f.getByTestId("image-base-url").fill(relayBase);
	await f.getByTestId("image-fetch").click();
	await f.locator('[data-model="relay-painter"]').waitFor();
	assert.equal(await f.locator('[data-model="image-chat"]').count(), 0);
	assert.equal(await f.locator('[data-model="deepseek-r1"]').count(), 0);
	assert.equal(await f.getByRole("button", { name: /显示全部/ }).count(), 0);
	await f.locator('[data-model="gpt-image-1"]').waitFor();
	console.log("✅ 图片输出模型可见，识图 / 语言模型不混入，没有显示全部入口");
	await f.getByTestId("image-manual").fill("ep-my-painter");
	await f.getByTestId("image-manual").press("Enter");
	await f.locator('[data-model="ep-my-painter"]').waitFor();
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
	console.log("✅ 保留手动输入图片模型别名，手机无横向溢出");
} finally {
	await browser?.close();
	relay.close();
	const exited = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await exited;
}
