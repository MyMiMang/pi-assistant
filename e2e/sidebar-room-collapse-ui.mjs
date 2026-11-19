import assert from "node:assert/strict";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";

const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const run = makeTempRun("pia-room-fold-");
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root: process.cwd(), port, run, extra: { PIA_HOST: "127.0.0.1" } });
const api = async (path, method = "GET", body) => {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	assert.ok(r.ok, `${method} ${path} ${r.status}`);
	return r.json();
};
let browser;
try {
	const end = Date.now() + 20_000;
	while (!(await fetch(`${base}/api/system`).then((r) => r.ok).catch(() => false))) {
		assert.ok(Date.now() < end && server.child.exitCode === null, server.logs());
		await delay(150);
	}
	await api("/api/settings", "PUT", { onboarded: true });
	const agents = [];
	for (let i = 1; i <= 32; i++) agents.push(await api("/api/agents", "POST", { name: `合成助理 ${i}` }));
	const room = await api("/api/rooms", "POST", { name: "合成讨论群", memberIds: agents.slice(0, 2).map((a) => a.id), managerId: agents[0].id });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	for (const mobile of [false, true]) {
		const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, isMobile: mobile });
		page.setDefaultTimeout(8_000);
		const draft = page.getByTestId("room-input");
		const toggle = page.getByTestId("sidebar-rooms-toggle");
		const row = page.getByTestId("sidebar-room").filter({ hasText: "合成讨论群" });
		const create = page.getByTestId("new-room-btn");
		const drawer = page.getByRole("button", { name: "打开助理列表", exact: true });
		const open = async () => { if (mobile) await drawer.tap(); await toggle.waitFor(); };
		await page.goto(`${base}/?room=${room.id}`);
		await draft.fill("群草稿：只输入，不发送");
		await open();
		assert.equal(await toggle.getAttribute("aria-expanded"), "true");
		await row.waitFor();
		await toggle[mobile ? "tap" : "press"](...(mobile ? [] : ["Enter"]));
		assert.equal(await toggle.getAttribute("aria-expanded"), "false");
		await row.waitFor({ state: "hidden" });
		if (!mobile) assert.equal(await toggle.evaluate((el) => document.activeElement === el), true);
		assert.equal(await draft.inputValue(), "群草稿：只输入，不发送");
		await page.getByTestId("room-title").getByText("合成讨论群").waitFor();
		await create.click();
		await page.getByTestId("new-room").waitFor();
		assert.equal(await toggle.getAttribute("aria-expanded"), "false");
		await page.keyboard.press("Escape");
		await page.reload();
		await open();
		assert.equal(await toggle.getAttribute("aria-expanded"), "false");
		await row.waitFor({ state: "hidden" });
		if (mobile) await toggle.tap(); else await toggle.press("Space");
		await row.waitFor();
		assert.equal(await toggle.getAttribute("aria-expanded"), "true");
		await page.close();
		console.log(`PASS ${mobile ? "390px 轻触" : "1440px 键盘和焦点"}：32 助理，群聊折叠、刷新、独立新建、当前群及草稿`);
	}
} finally {
	await browser?.close();
	await server.stop();
	cleanupTempRun(run);
}
