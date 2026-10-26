/**
 * 助理工作状态（member-status.ts / MemberStatus.tsx）：群顶部成员条每个成员有状态，最左边是群总状态；单聊顶部名字下面写状态。
 * 覆盖：全停下「都停下了」→ 成员在群里说话「在群里回复」→ 帮手做群任务「做任务「X」」（2 人在干活）→ 390 不溢出
 *       → 停群 + 全部暂停后回到「都停下了」→ 审批卡「等你审批」（总状态「1 人等你」）→ 批准后空闲 → 单聊「正在工作」→ 停下后「空闲」。
 * 全程临时 DATA/WORKSPACE/HOME/TMPDIR + 内存凭据 + Mock，不碰生产数据。截图写 artifacts/screenshots/room-member-status/。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { roomHelpers } from "./fixtures/page-checks.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-member-status-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const out = process.env.SHOT_DIR ?? join(artifactDir("screenshots"), "room-member-status");
mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${t.slice(0, 300)}`); try { return JSON.parse(t); } catch { return {}; } };
const wait = async (fn, ms = 30000, what = "condition") => { const until = Date.now() + ms; while (Date.now() < until) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`${what} timed out`); };
let browser;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok, 30000, "server");
	await j("/api/settings", "PUT", { onboarded: true });
	const mk = (name) => j("/api/agents", "POST", { name, model: { provider: "mock", id: "echo" } });
	const lead = await mk("组长"), a = await mk("甲"), b = await mk("乙");
	const room = await j("/api/rooms", "POST", { name: "状态验收群", memberIds: [lead.id, a.id, b.id], managerId: lead.id });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const { roomSay } = roomHelpers(page);
	const summary = page.getByTestId("room-activity");
	const member = (name) => page.getByTestId("room-members").locator(`button[title^="${name}"]`);
	const stateOf = async (loc) => loc.getAttribute("data-state");
	const textOf = async (name) => (await member(name).getByTestId("member-activity").innerText()).trim();
	const strip = (name) => page.getByTestId("room-members").screenshot({ path: join(out, name) });

	// 1) 一开始都没在干活：总状态明说「都停下了」，每个人「空闲」
	await page.goto(`${base}/?room=${room.id}`);
	await summary.waitFor();
	assert.equal(await stateOf(summary), "idle");
	assert.match(await summary.innerText(), /都停下了/);
	for (const n of ["组长", "甲", "乙"]) assert.equal(await textOf(n), "空闲", `${n} 空闲`);
	await strip("1-idle.png");

	// 2) 甲在群里说话（Mock「慢慢」会 sleep 20 秒）：甲「在群里回复」，总状态「1 人在干活」
	await roomSay("@甲 慢慢做");
	await wait(async () => (await stateOf(member("甲"))) === "work" && (await textOf("甲")) === "在群里回复", 20000, "甲在群里回复");
	assert.equal(await stateOf(summary), "work");
	assert.match(await summary.innerText(), /1 人在干活/);
	assert.equal(await stateOf(member("乙")), "idle", "乙没被叫到，仍是空闲");
	await strip("2-speaking.png");

	// 3) 乙的帮手在任务会话里做群任务（Mock：「取消隔离探针」的任务会 sleep 20 秒）：乙「做任务「…」」，总状态「2 人在干活」
	const item = await j(`/api/rooms/${room.id}/work-items`, "POST", { title: "取消隔离探针：整理素材", requirement: "整理素材清单", doneCriteria: "有清单", ownerAgentId: b.id, start: true });
	await wait(async () => /^做任务「取消隔离探针/.test(await textOf("乙")), 20000, "乙在做任务");
	assert.equal(await stateOf(member("乙")), "work");
	await wait(async () => /2 人在干活/.test(await summary.innerText()), 10000, "2 人在干活");
	await page.screenshot({ path: join(out, "3-working-desktop.png") });

	// 手机 390：成员条横向滑动、页面不横向溢出，状态字截断不撑破胶囊
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(400);
	const overflow = await page.evaluate(() => {
		const s = document.querySelector("[data-testid=room-members]");
		const bad = [...s.querySelectorAll("button")].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.title);
		return { page: document.documentElement.scrollWidth, strip: s.getBoundingClientRect().right, bad };
	});
	assert.ok(overflow.page <= 390 && overflow.strip <= 390.5, `390 宽不溢出：${JSON.stringify(overflow)}`);
	assert.deepEqual(overflow.bad, [], "成员胶囊内容不溢出");
	await page.screenshot({ path: join(out, "4-working-390.png") });
	await page.setViewportSize({ width: 1440, height: 900 });

	// 4) 停群 + 全部暂停：所有人回到空闲，总状态「都停下了」
	await j(`/api/rooms/${room.id}/stop`, "POST");
	await j(`/api/rooms/${room.id}/work-items/pause-all`, "POST");
	await wait(async () => (await stateOf(summary)) === "idle", 20000, "全部停下");
	assert.match(await summary.innerText(), /都停下了/);
	for (const n of ["组长", "甲", "乙"]) assert.equal(await textOf(n), "空闲", `${n} 停下后空闲`);
	assert.equal((await j(`/api/work-items/${item.item?.id ?? item.id}`)).item.status, "paused");
	await strip("5-all-stopped.png");

	// 5) 审批卡：乙「等你审批」，总状态「1 人等你」；批准后回到空闲
	await roomSay("@乙 审批一下删除");
	await wait(async () => (await stateOf(member("乙"))) === "wait", 30000, "乙等你审批");
	assert.equal(await textOf("乙"), "等你审批");
	assert.equal(await stateOf(summary), "wait");
	assert.match(await summary.innerText(), /1 人等你/);
	await strip("6-waiting.png");
	// 点「1 人等你」：先把聊天滚到最上面，点了要滚到审批卡并高亮
	await page.evaluate(() => document.querySelectorAll(".overflow-y-auto").forEach((el) => (el.scrollTop = 0)));
	await summary.click();
	const card = page.locator(".pa-msg-flash");
	await card.waitFor({ timeout: 5000 });
	assert.ok(await card.first().evaluate((el) => !!el.querySelector('[data-testid="approval-card"]')), "高亮的是审批卡");
	await page.waitForTimeout(600);
	assert.ok(await page.getByTestId("approval-card").last().isVisible(), "审批卡滚到可见");
	await page.screenshot({ path: join(out, "6b-jump-to-pending.png") });
	await page.getByTestId("approval-card").last().getByRole("button", { name: "批准" }).click();
	await wait(async () => (await stateOf(summary)) === "idle", 30000, "批准后都停下");

	// 6) 单聊：主会话在跑「正在工作」，停下后「空闲」
	// 先等推送连上（hello）再发消息：否则「开始工作」那条 agent.status 会在连上之前发出、被错过
	const hello = new Promise((resolve) => page.on("websocket", (ws) => ws.on("framereceived", (f) => String(f.payload).includes('"type":"hello"') && resolve())));
	await page.goto(`${base}/?agent=${a.id}`);
	const line = page.getByTestId("agent-activity");
	await line.waitFor();
	await hello;
	await wait(async () => (await stateOf(line)) === "idle", 20000, "单聊开始空闲");
	assert.match(await line.innerText(), /^空闲 · /);
	await j(`/api/agents/${a.id}/messages`, "POST", { text: "慢慢数" });
	await wait(async () => (await stateOf(line)) === "work", 20000, "单聊正在工作");
	assert.match(await line.innerText(), /正在工作/);
	await page.locator("header").screenshot({ path: join(out, "7-chat-working.png") });
	await j(`/api/agents/${a.id}/abort`, "POST");
	await wait(async () => (await stateOf(line)) === "idle", 20000, "单聊停下后空闲");
	await page.locator("header").screenshot({ path: join(out, "8-chat-idle.png") });

	assert.deepEqual(errors, []);
	console.log("PASS room-member-status: 群成员 / 群总状态 / 单聊状态随实际情况变化，全停下明确显示，390 不溢出");
} finally {
	await browser?.close();
	await server.stop?.();
	cleanupTempRun(run);
}
