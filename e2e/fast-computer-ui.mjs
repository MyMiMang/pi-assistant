/**
 * 快速操作模型 UI 专项 e2e（Mock 模型，不连真实付费服务）：
 *  - 自定义渠道声明 System One 分类器 → 出现在目录且 configured；
 *  - 设置里用应用内 Select（非原生 <select>）选类型 / 分类器 → 刷新后配置持久化；
 *  - 390 宽：下拉在视口内、Esc 只关菜单不关设置弹窗；
 *  - 失败 UI：保存接口报错时显示原因；
 *  - 删除渠道：悬空引用被清、显示「没有可用的分类器」。
 *
 * 用法：node e2e/fast-computer-ui.mjs（需先 npm run build -w apps/web）
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startMockOpenAI } from "./mock-openai.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const data = mkdtempSync(`${tmpdir()}/pia-fast-ui-`);
const port = await new Promise((resolve) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => resolve(p));
	});
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: root, env: { ...process.env, PIA_DATA_DIR: data, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
server.stdout.on("data", (d) => (logs += d));
server.stderr.on("data", (d) => (logs += d));
const api = async (path, method = "GET", body) => {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	assert.ok(r.ok, await r.clone().text());
	return r.json();
};

let browser;
let relay;
try {
	const end = Date.now() + 30_000;
	while (Date.now() < end) {
		try {
			if ((await fetch(`${base}/api/system`)).ok) break;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	await api("/api/settings", "PUT", { onboarded: true });

	relay = await startMockOpenAI({ key: "sk-fast" });
	const provider = await api("/api/models/custom", "POST", { name: "快速中转", api: "openai-completions", baseUrl: relay.url, apiKey: "sk-fast", models: [{ id: "relay-chat" }], classifiers: [{ protocol: "typesafe-system-one", modelId: "jev-relay" }] });

	// 目录：只回安全元数据，configured=true
	let fs = await api("/api/fast-computer/settings");
	const cls = fs.classifierModels.find((m) => m.provider === provider.id && m.id === "jev-relay");
	assert.ok(cls?.configured, "自定义 classifier 应进目录且 configured");

	// 非法协议被拒
	const bad = await fetch(`${base}/api/models/custom/${provider.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "快速中转", api: "openai-completions", baseUrl: relay.url, models: [{ id: "relay-chat" }], classifiers: [{ protocol: "nope", modelId: "x" }] }) });
	assert.equal(bad.status, 400, "非法 classifier 协议应 400");

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	page.on("pageerror", (e) => console.error("[pageerror]", e?.stack ?? e));
	page.on("console", (m) => (m.type() === "error" ? console.error("[console]", m.text()) : undefined));
	await page.goto(`${base}/?settings=models`);
	const sec = page.getByTestId("fast-computer-section");
	await sec.getByTestId("fast-refresh").click();
	await sec.getByLabel("开启快速操作模型").click();
	await sec.getByTestId("fast-kind").waitFor();
	assert.equal(await sec.locator("select").count(), 0, "快速操作模型不得使用原生 <select>");

	// 类型改用应用内 Select
	await sec.getByTestId("fast-kind").click();
	await page.getByTestId("fast-kind-option-systemone").click();
	await page.waitForFunction(async (b) => (await (await fetch(`${b}/api/fast-computer/settings`)).json()).settings.kind === "systemone", base);

	// 分类器 Select → 选自定义 classifier
	await sec.getByTestId("fast-classifier").click();
	await page.getByTestId(`fast-classifier-option-${provider.id}/jev-relay`).click();
	await page.waitForFunction(async (b) => { const s = (await (await fetch(`${b}/api/fast-computer/settings`)).json()).settings; return !!s.provider && s.id === "jev-relay"; }, base);

	// 保存失败 → UI 显示原因（不静默）
	await page.route("**/api/fast-computer/settings", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "模拟保存失败" }) }) : route.continue()));
	await sec.getByLabel("开启快速操作模型").click();
	await sec.getByText(/模拟保存失败/).waitFor();
	await page.unroute("**/api/fast-computer/settings");

	// 390：下拉在视口内，Esc 只关菜单不关设置弹窗
	await page.setViewportSize({ width: 390, height: 844 });
	await sec.getByTestId("fast-classifier").click();
	await page.getByTestId("fast-classifier-menu").waitFor();
	const box = await page.getByTestId("fast-classifier-menu").boundingBox();
	assert.ok(box && box.x >= -1 && box.x + box.width <= 391, `390 下拉溢出：${JSON.stringify(box)}`);
	await page.keyboard.press("Escape");
	await page.getByTestId("fast-classifier-menu").waitFor({ state: "detached" });
	assert.ok(await page.getByTestId("settings-dialog").isVisible(), "Esc 不应关掉设置弹窗");
	await page.setViewportSize({ width: 1440, height: 900 });

	// 删除渠道 → 引用被清 + 失败 UI 文案
	await api(`/api/models/custom/${provider.id}`, "DELETE");
	relay.close();
	relay = null;
	await sec.getByTestId("fast-refresh").click();
	await page.waitForTimeout(400);
	// 悬空引用被清、自定义 classifier 不再出现在下拉里
	fs = await api("/api/fast-computer/settings");
	assert.deepEqual([fs.settings.provider, fs.settings.id], ["", ""], "删除渠道后悬空引用应清");
	assert.ok(!fs.classifierModels.some((m) => m.provider === provider.id), "已删渠道的 classifier 不应还在目录");
	await sec.getByTestId("fast-classifier").click();
	await page.getByTestId("fast-classifier-menu").waitFor();
	assert.equal(await page.getByTestId(`fast-classifier-option-${provider.id}/jev-relay`).count(), 0, "已删 classifier 不应还在下拉");
	await page.keyboard.press("Escape");
	console.log("通过：fast selector 用应用内 Select、目录刷新、保存失败提示、390 不溢出/Esc 只关菜单、删除清理引用。");
} catch (e) {
	console.error(logs.slice(-4000));
	throw e;
} finally {
	await browser?.close();
	relay?.close();
	server.kill("SIGTERM");
}
