/** 群成员 / 单聊模型页上下文入口；临时服务、Mock、独立浏览器配置。 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
import { infoTab } from "./fixtures/info-pane.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-member-context-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const out = join(artifactDir("screenshots"), "member-context");
mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path}: ${r.status}`); return r.json(); };
const wait = async (fn) => { const end = Date.now() + 30000; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error("等待超时"); };
let browser;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok);
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "上下文成员", model: { provider: "mock", id: "echo" } });
	const room = await j("/api/rooms", "POST", { name: "上下文验收群", memberIds: [a.id], managerId: a.id });
	await j(`/api/rooms/${room.id}/messages`, "POST", { text: "你好，请简短回应" });
	let cid;
	await wait(async () => {
		const r = await j(`/api/rooms/${room.id}`);
		cid = r.members.find((m) => m.agentId === a.id)?.conversationId;
		return cid && !r.state.current && !r.state.background?.length && (await j(`/api/conversations/${cid}/context`)).tokens > 0;
	});
	const ctx = await j(`/api/conversations/${cid}/context`);
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(`${base}/?room=${room.id}`);
	await page.getByTestId("room-members").locator('button[title^="上下文成员"]').click();
	await infoTab(page, "models");
	const section = page.getByTestId("agent-context");
	await section.getByText("在本群的上下文", { exact: true }).waitFor();
	await wait(async () => /已用 [\d.]+[kM]? \/ /.test(await section.innerText()));
	const fmt = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}k` : String(n);
	assert.ok((await section.innerText()).includes(`已用 ${fmt(ctx.tokens)} / ${fmt(ctx.contextWindow)}`));
	await stableShot(page, section, join(out, "group-model-context.png"));
	await section.getByTestId("context-compact").click();
	await page.getByTestId("compact-dialog").waitFor();
	await stableShot(page, page.getByTestId("compact-dialog"), join(out, "group-compact-dialog.png"));
	await page.getByTestId("compact-cancel").click();
	await page.setViewportSize({ width: 390, height: 844 });
	await stableShot(page, section, join(out, "group-context-390.png"));
	const bounds = await section.boundingBox();
	assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, "上下文区域在窄屏内");
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`${base}/?agent=${a.id}`);
	await page.getByTestId("context-ring").waitFor();
	// 详情开关会持久化；只在未展开时打开。
	if (!await page.getByTestId("info-tabs").isVisible()) await page.getByRole("button", { name: "信息面板", exact: true }).click();
	await page.getByTestId("info-tabs").waitFor();
	await infoTab(page, "models");
	await section.getByText("上下文", { exact: true }).first().waitFor();
	assert.equal(await section.getByText("在本群的上下文", { exact: true }).count(), 0);
	await wait(async () => /已用 0 \/ 128k/.test(await section.innerText()));
	await stableShot(page, section, join(out, "single-model-context.png"));
	assert.deepEqual(errors, []);
	console.log(`PASS member-context-ui；截图：${out}`);
} catch (e) {
	console.error(server.logs().slice(-3000));
	throw e;
} finally {
	await browser?.close();
	await server.stop();
	cleanupTempRun(run);
}
