/**
 * 高级记忆健康（真实临时服务 + Mock 模型 + 假的远程 Hindsight）：
 *  测试按钮三步逐项显示；备用模型下拉；Hindsight 掉线 → 召回失败 → 角标红「有问题」+ 一句话 + 设置入口小圆点；恢复后角标回到「运行中」。
 * 截图写 artifacts/screenshots（gitignore）。运行前先构建 web：npm run build -w @pi-assistant/web
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { fakeHindsight } from "./fixtures/fake-hindsight.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-memory-health-");
const freePort = () => new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run, extra: { PIA_MEMORY_TIMEOUT_MS: "2000" } });
const SHOTS = artifactDir("screenshots");
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path} ${r.status} ${await r.clone().text()}`); return r.json(); };
const wait = async (fn, ms = 20000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("condition timed out"); };
const reflect = (id) => fetch(`${base}/api/agents/${id}/memory/reflect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "我喜欢喝什么茶" }) }).then((r) => r.json());
const hsPort = await freePort();
let hs = fakeHindsight("hk", hsPort);
await hs.start();
let browser;
try {
	await wait(async () => { try { return (await fetch(base + "/api/system")).ok; } catch { return false; } });
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "记忆测试", model: { provider: "mock", id: "echo" } });
	await j("/api/memory/hindsight", "PUT", { mode: "remote", remoteUrl: `http://127.0.0.1:${hsPort}`, remoteKey: "hk", reranker: { kind: "off" }, llm: { provider: "mock", id: "echo" } });
	await j(`/api/agents/${a.id}/memory-provider`, "PUT", { id: "hindsight" });
	await wait(async () => (await j("/api/memory/hindsight")).status.state === "ready");
	await j(`/api/agents/${a.id}/memory`, "POST", { text: "我喜欢喝乌龙茶" }).catch(() => {});

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, locale: "zh-CN" });
	page.setDefaultTimeout(15000);
	await page.goto(`${base}/?settings=memory`);
	const panel = page.getByTestId("hindsight-settings");
	await panel.waitFor();
	await panel.getByTestId("hs-advanced").evaluate((d) => (d.open = true));
	// 测试按钮：三步逐项显示
	await panel.getByRole("button", { name: "测试", exact: true }).click();
	const steps = panel.getByTestId("hs-test-steps");
	await steps.waitFor();
	assert.equal(await steps.locator("li").count(), 3);
	assert.equal(await steps.locator('li[data-ok="true"]').count(), 3, await steps.innerText());
	assert.match(await steps.innerText(), /多轮工具调用[\s\S]*JSON 输出[\s\S]*真实召回/);
	await panel.getByTestId("hs-msg").getByText(/三项检查都通过/).waitFor();
	// 备用模型：复用模型下拉，选一个就多出下一个空位
	await panel.getByLabel("备用模型 1").selectOption("mock/echo-think");
	await panel.getByLabel("备用模型 2").waitFor();
	await panel.getByTestId("hs-fallbacks").scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(SHOTS, "memory-health-test-steps.png"), fullPage: true });
	await panel.getByRole("button", { name: "保存", exact: true }).click();
	await panel.getByTestId("hs-msg").getByText(/已保存/).waitFor();
	assert.deepEqual((await j("/api/memory/hindsight")).settings.llmFallbacks, [{ provider: "mock", id: "echo-think" }]);
	await wait(async () => (await j("/api/memory/hindsight")).status.state === "ready");

	// 掉线：召回连续失败 → 红色角标 + 一句话 + 设置入口小圆点
	await hs.stop();
	for (let i = 0; i < 3; i++) await reflect(a.id);
	const h = (await j("/api/memory/hindsight")).status.health;
	console.log("health after outage:", h.level, h.summary);
	await panel.getByTestId("hs-badge").and(page.locator('[data-level="failing"]')).waitFor();
	await panel.getByTestId("hs-health").waitFor();
	assert.match(await panel.getByTestId("hs-badge").innerText(), /有问题/);
	await page.getByTestId("settings-nav").getByTestId("memory-health-dot").waitFor();
	await panel.scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(SHOTS, "memory-health-badge-failing.png") });
	await panel.getByTestId("hs-health").locator("button").first().hover();
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(SHOTS, "memory-health-badge-tooltip.png") });

	// 恢复：同一端口重启假服务，召回成功几次 → 回到「运行中」，小圆点消失
	hs = fakeHindsight("hk", hsPort);
	await hs.start();
	await j("/api/memory/hindsight/restart", "POST");
	await wait(async () => (await j("/api/memory/hindsight")).status.state === "ready");
	for (let i = 0; i < 3; i++) await reflect(a.id);
	await panel.getByTestId("hs-badge").and(page.locator('[data-level="ok"], [data-level="slow"]')).waitFor();
	await page.getByTestId("settings-nav").getByTestId("memory-health-dot").waitFor({ state: "detached" }).catch(() => {});
	await page.screenshot({ path: join(SHOTS, "memory-health-recovered.png") });
	console.log("memory-health-ui: 全部通过");
} catch (e) {
	console.error(server.logs().slice(-4000));
	throw e;
} finally {
	await browser?.close();
	await hs.stop().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
