import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)), run = makeTempRun("pia-browser-workspace-");
const out = join(root, "artifacts/right-workspace/browser"); mkdirSync(out, { recursive: true });
const freePort = () => new Promise(resolve => { const server = createServer().listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const port = await freePort(), base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run, extra: { PIA_BROWSER_TEST_DIR: run.runDir, NODE_OPTIONS: `--import tsx --import ${new URL("./fixtures/browser-workspace.mjs", import.meta.url).href}` } });
const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "set-cookie": "sid=temporary; Path=/" }); res.end(`<title>同页整合测试</title><style>body{font:24px sans-serif;background:#f3f8fc;color:#173550;padding:30px}input{font:24px sans-serif;width:350px;position:absolute;left:100px;top:140px}button{font:22px sans-serif}</style><h1>真实网页，同一页面</h1><label>姓名 <input id="name" aria-label="姓名"></label><p><a href="/popup" target="_blank">新窗口</a></p><form method="post"><button type="submit">提交表单</button></form><script>window.marker ||= Math.random();</script>`); });
await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://127.0.0.1:${site.address().port}`;
const wait = async (read, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const result = await read().catch(() => false); if (result) return result; await new Promise(resolve => setTimeout(resolve, 80)); } throw new Error("等待条件超时"); };
const json = async (path, method = "GET", body, headers = {}) => { const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result; };
const call = async (agentId, tool, input = {}) => {
	const resultPath = join(run.runDir, "browser-result.json"); if (existsSync(resultPath)) unlinkSync(resultPath);
	writeFileSync(join(run.runDir, "browser-command.json"), JSON.stringify({ agentId, tool, input }));
	await wait(async () => existsSync(resultPath), 35000);
	const result = JSON.parse(readFileSync(resultPath, "utf8")); if (result.error) throw new Error(result.error);
	return result.result.content.map(c => c.text ?? "").join("\n");
};
let browser, appPage;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok, 30000);
	await json("/api/settings", "PUT", { onboarded: true });
	const agent = await json("/api/agents", "POST", { name: "浏览器阶段三", model: { provider: "mock", id: "echo" } });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
	appPage = page;
	page.setDefaultTimeout(12000);
	const errors = []; page.on("pageerror", e => errors.push(e.message));
	await page.goto(`${base}/?agent=${agent.id}`); await wait(async () => /:conversation:.+/.test(await page.getByTestId("right-workspace").getAttribute("data-scope"))); await page.getByTestId("workspace-browser-open").click(); await page.getByTestId("workspace-browser-empty").waitFor();
	await page.screenshot({ path: join(out, "browser-empty.png") });
	const nav = await call(agent.id, "browser_navigate", { url: siteUrl });
	assert.match(nav, /页面：同页整合测试/);
	const ref = nav.split("\n").find(l => l.includes('textbox "姓名"')).match(/ref=(\w+)/)[1];
	assert.match(await call(agent.id, "browser_type", { ref, text: "工具写入同一页" }), /工具写入同一页/);
	await page.getByTestId("browser-takeover").waitFor();
	await wait(async () => (await page.getByTestId("browser-control-status").innerText()).includes("已连接"));
	await page.getByTestId("browser-takeover").click();
	await page.getByTestId("browser-give-back").waitFor();
	await wait(async () => page.getByLabel("输入到网页当前光标处").isEnabled());
	const canvas = page.getByTestId("browser-canvas");
	const box = await canvas.boundingBox();
	await canvas.click({ position: { x: 220 / 1280 * box.width, y: 156 / 860 * box.height } });
	await wait(async () => page.getByLabel("输入到网页当前光标处").isEnabled());
	// 使用明确网页坐标点击后，以同一工具结构读取核对焦点输入。
	await page.getByLabel("输入到网页当前光标处").fill("用户接管");
	await page.getByRole("button", { name: "输入", exact: true }).click();
	await wait(async () => page.getByLabel("输入到网页当前光标处").isEnabled());
	const userSnap = await call(agent.id, "browser_snapshot", { screenshot: false });
	assert.match(userSnap, /用户接管/, "UI 与工具读回同一个输入框");
	assert.match(await call(agent.id, "browser_type", { ref, text: "禁止覆盖" }), /控制权/);
	await page.screenshot({ path: join(out, "browser-user-light.png") });
	await page.getByTestId("workspace-expand").click(); await page.getByTestId("workspace-restore").click();
	await page.getByTestId("workspace-collapse").click(); await page.getByTestId("workspace-reopen").click();
	await wait(async () => page.getByLabel("输入到网页当前光标处").isEnabled());
	assert.match(await call(agent.id, "browser_snapshot", { screenshot: false }), /用户接管/);
	await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(out, "browser-user-390.png") });
	assert.equal(await page.getByTestId("right-workspace").getAttribute("data-mode"), "mobile");
	await page.getByTestId("browser-give-back").click(); await page.getByTestId("browser-takeover").waitFor();
	assert.match(await call(agent.id, "browser_type", { ref, text: "交还后工具恢复" }), /交还后工具恢复/);
	const submitRef = (await call(agent.id, "browser_snapshot", { screenshot: false })).split("\n").find(l => l.includes('button "提交表单"')).match(/ref=(\w+)/)[1];
	const submission = call(agent.id, "browser_click", { ref: submitRef });
	const requestId = await wait(async () => (await json(`/api/agents/${agent.id}/messages`)).find(m => m.meta?.kind === "approval" && m.meta?.status === "pending")?.meta.requestId);
	await page.getByTestId("browser-takeover").click(); await page.getByTestId("browser-give-back").waitFor();
	await json(`/api/requests/${requestId}`, "POST", { approved: true });
	assert.match(await submission, /控制权/, "真正requests批准后不能绕过接管租约");
	await page.getByTestId("browser-give-back").click(); await page.getByTestId("browser-takeover").waitFor();
	// 查看关闭不关闭 Page，重新打开还可见同样内容。
	await page.getByTestId("workspace-close-tab").click();
	assert.match(await call(agent.id, "browser_snapshot", { screenshot: false }), /交还后工具恢复/);
	await page.getByTestId("workspace-browser-open").click(); await page.getByTestId("browser-takeover").waitFor();
	const state = await json(`/api/agents/${agent.id}/browser/state`);
	// 两个真实查看连接：旧控制代际不能交还或影响后来一轮接管。
	const viewers = [];
	const connectViewer = async () => {
		const { ticket } = await json(`/api/agents/${agent.id}/browser/ticket`, "POST", { pageId: state.current }, { origin: base });
		const ws = new WebSocket(`${base.replace("http", "ws")}/browser/ws?ticket=${ticket}`, { origin: base }); viewers.push(ws);
		await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
		let serial = 0;
		return (type, record) => new Promise((resolve, reject) => {
			const requestId = `control-${++serial}`, timer = setTimeout(() => { ws.off("message", receive); reject(new Error("WS控制响应超时")); }, 10000);
			const receive = raw => { const m = JSON.parse(String(raw)); if (m.type === "result" && m.requestId === requestId) { clearTimeout(timer); ws.off("message", receive); resolve(m); } };
			ws.on("message", receive); ws.send(JSON.stringify({ ...record, type, requestId }));
		});
	};
	try {
		const first = await connectViewer(), second = await connectViewer();
		const current = async () => (await json(`/api/agents/${agent.id}/browser/state`)).pages.find(p => p.pageId === state.current);
		assert.equal((await first("takeover", await current())).error, undefined);
		const oldUser = await current();
		assert.equal((await first("give-back", oldUser)).error, undefined);
		const oldAgent = await current();
		assert.equal((await second("takeover", oldAgent)).error, undefined);
		const newUser = await current();
		for (const type of ["give-back", "takeover", "recover"]) {
			assert.ok((await first(type, oldUser)).error, `旧generation ${type}必须拒绝`);
			const still = await current(); assert.equal(still.control, "user"); assert.equal(still.controlGeneration, newUser.controlGeneration);
		}
		assert.equal((await second("give-back", newUser)).error, undefined);
		assert.equal((await current()).control, "agent");
		assert.ok((await first("takeover", oldAgent)).error, "旧agent代际不能重新夺取控制");
		assert.equal((await current()).control, "agent");
		console.log("PASS 真实WS双viewer：旧give-back/takeover/recover拒绝，当前user不变，当前交还成功");
	} finally { for (const ws of viewers) ws.close(); }
	const cross = await fetch(`${base}/api/agents/${agent.id}/browser/state`, { headers: { origin: "https://evil.invalid" } }); assert.equal(cross.status, 403);
	const { ticket } = await json(`/api/agents/${agent.id}/browser/ticket`, "POST", { pageId: state.current }, { origin: base });
	const rejected = origin => new Promise(resolve => { const ws = new WebSocket(`${base.replace("http", "ws")}/browser/ws?ticket=${ticket}`, { origin }); ws.on("open", () => { ws.close(); resolve(false); }); ws.on("error", () => resolve(true)); });
	assert.equal(await rejected("https://evil.invalid"), true, "跨源握手拒绝"); assert.equal(await rejected(base), true, "一次票据拒绝重放");
	await json(`/api/agents/${agent.id}/desktop/pause`, "POST", { paused: true });
	assert.match(await call(agent.id, "browser_navigate", { url: siteUrl }), /已暂停/);
	await wait(async () => (await page.getByTestId("browser-control-status").innerText()).includes("已暂停"));
	await json(`/api/agents/${agent.id}/desktop/pause`, "POST", { paused: false });
	assert.deepEqual(errors, []);
	console.log("PASS 临时服务真实工作区：工具/UI同页、接管/交还、收起/关闭/390保状态、跨源/ticket重放、全局暂停");
} catch (e) { writeFileSync(join(out, "server-failure.log"), server.logs()); if (appPage) { await appPage.screenshot({ path: join(out, "failure.png") }); writeFileSync(join(out, "failure-text.txt"), await appPage.locator("body").innerText()); } throw e; }
finally { await browser?.close(); await server.stop(); await new Promise(resolve => site.close(resolve)); cleanupTempRun(run); }
