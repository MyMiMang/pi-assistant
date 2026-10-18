/** Fast关闭时的普通default回显不常驻；真loopback协议→Pi→落库meta→构建UI，不伪造消息响应。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-fast-message-");
const out = process.env.SHOT_DIR ?? join(run.runDir, "shots");
mkdirSync(out, { recursive: true });
const seen = [];
const replies = ["关闭Fast时的正常回复，正文应保留。", "开启Fast时的回复，实际加速仍需服务确认。", "再次关闭Fast后的正常回复。"];
const relay = createServer(async (req, res) => {
	let raw = "";
	for await (const part of req) raw += part;
	const body = JSON.parse(raw || "{}");
	seen.push(body);
	const content = replies[seen.length - 1] ?? "正常回复";
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: "fast-fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
	res.write(chunk({ role: "assistant", content: "" }, { service_tier: "default" }));
	res.write(chunk({ content }));
	res.write(`data: ${JSON.stringify({ id: "fast-fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ id: "fast-fixture", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
	res.end("data: [DONE]\n\n");
});
const relayPort = await new Promise((resolve) => relay.listen(0, "127.0.0.1", () => resolve(relay.address().port)));
const reserve = createServer();
const port = await new Promise((resolve) => reserve.listen(0, "127.0.0.1", () => { const p = reserve.address().port; reserve.close(() => resolve(p)); }));
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
let browser;
const j = async (path, method = "GET", body) => {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	assert.ok(r.ok, `${method} ${path} ${r.status}`);
	return r.json();
};
const wait = async (fn, label, ms = 20000) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (await fn().catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 80));
	}
	throw new Error(`timeout: ${label}`);
};
try {
	await wait(async () => (await fetch(base + "/api/system/public")).ok, "server");
	await j("/api/settings", "PUT", { onboarded: true });
	const service = await j("/api/models/custom", "POST", { name: "普通回显验证", api: "openai-completions", baseUrl: `http://127.0.0.1:${relayPort}/v1`, noKey: true, models: [{ id: "fast-message-fixture", reasoning: true }] });
	const agent = await j("/api/agents", "POST", { name: "消息档位验证", model: { provider: service.id, id: "fast-message-fixture" } });
	await j(`/api/agents/${agent.id}`, "PATCH", { thinking: "medium", fast: false });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	page.setDefaultTimeout(8000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(`${base}/?agent=${agent.id}`);
	await page.getByTestId("model-picker").waitFor();
	const msgs = () => j(`/api/agents/${agent.id}/messages?limit=40`);
	const send = async (n) => {
		await j(`/api/agents/${agent.id}/messages`, "POST", { text: `请给出第${n}条普通回复` });
		await wait(async () => (await msgs()).some((m) => m.role === "assistant" && m.status === "done" && m.content === replies[n - 1]), `reply ${n}`);
		// loopback回复极快，可能先于首次WS握手；本项验持久meta渲染，不用握手时序冒充失败。
		await page.reload();
		await page.getByTestId("model-picker").waitFor();
		await page.getByText(replies[n - 1], { exact: true }).waitFor();
	};
	await send(1);
	let messages = await msgs();
	const off = messages.find((m) => m.role === "assistant" && m.content === replies[0]);
	assert.equal(off.meta.fast.enabled, false);
	assert.equal(off.meta.fast.reportedKind, "standard", "普通default已走真实协议并保留审计元数据");
	assert.equal("service_tier" in seen[0], false, "未开Fast不附加tier");
	assert.equal(await page.getByTestId("msg-fast").count(), 0, "不开Fast的default回显不占位");
	await stableShot(page, page.locator(`[data-mid="${off.id}"]`), join(out, "01-fast-off-default-hidden.png"));
	await page.reload();
	await page.getByText(replies[0], { exact: true }).waitFor();
	assert.equal(await page.getByTestId("msg-fast").count(), 0, "刷新读取已存meta仍不出现误导Fast行");
	await j(`/api/agents/${agent.id}`, "PATCH", { fast: true });
	await send(2);
	assert.equal(seen[1].service_tier, "priority");
	assert.equal(seen[1].reasoning_effort, seen[0].reasoning_effort, "Fast与思考强度独立");
	await page.getByTestId("msg-fast").waitFor();
	assert.equal(await page.getByTestId("msg-fast").count(), 1);
	assert.match(await page.getByTestId("msg-fast").innerText(), /Fast · 服务回显 default（实际加速未确认）/);
	await j(`/api/agents/${agent.id}`, "PATCH", { fast: false });
	await send(3);
	assert.equal("service_tier" in seen[2], false);
	const historic = (await msgs()).find((m) => m.role === "assistant" && m.content === replies[1]);
	assert.equal(historic.meta.fast.enabled, true, "历史请求快照不随当前开关改变");
	assert.equal(historic.meta.fast.requested, true);
	await page.getByTestId("msg-fast").waitFor();
	assert.equal(await page.getByTestId("msg-fast").count(), 1, "再次关灯不擦掉历史上实际请求过Fast的事实");
	await page.setViewportSize({ width: 390, height: 844 });
	const third = (await msgs()).find((m) => m.role === "assistant" && m.content === replies[2]);
	const bubble = page.locator(`[data-mid="${third.id}"]`);
	await bubble.scrollIntoViewIfNeeded();
	const geometry = await bubble.evaluate((el) => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, right: el.getBoundingClientRect().right, width: innerWidth }));
	assert.ok(!geometry.overflow && geometry.right <= geometry.width + 1);
	await stableShot(page, bubble, join(out, "02-fast-off-mobile.png"));
	assert.deepEqual(errors, []);
	assert.equal(seen.length, 3, "只有预期3次loopback请求，无额外重试");
	console.log("PASS Fast消息真链：关闭default不显示，刷新仍隐藏；开启保留不确定说明；再关不注入/不擦旧事实；390正文可见；3次请求无额外重试");
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	relay.closeAllConnections();
	await new Promise((resolve) => relay.close(resolve));
	cleanupTempRun(run);
}
