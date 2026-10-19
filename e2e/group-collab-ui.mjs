/**
 * 群协作（decision 0006）：真实服务 / 真实 PiMock / 真实构建页面。
 *
 * 覆盖：
 *  1) 管理者 room_goal → 用户在确认卡上改完成标准 → 群进入自主推进（看板顶部显示目标）；
 *  2) 任务在负责人自己的会话里执行：正常任务提交 → 管理者被唤醒核验完成；成员报卡点 → 「卡住」；
 *     管理者判断需要用户拍板 → 「等你决定」高亮置顶，用户在看板上直接回答，决定发回群里；
 *  3) 看板四组（等你决定 / 卡住 / 进行中 / 已完成·已停止折叠）+ 390px；
 *  4) 停群不停任务：停群后正在执行的任务继续跑，看板「全部暂停」才停。
 *
 * 全程临时 DATA/WORKSPACE/HOME/TMPDIR + 内存凭据 + loopback Mock，不碰生产库 / 凭据 / 付费模型。
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-group-collab-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run, log: process.env.WORK_DEBUG ? (d) => process.stdout.write(d) : undefined });
const out = process.env.SHOT_DIR ?? join(artifactDir("screenshots"), "group-collab");
mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch {} if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${t.slice(0, 300)}`); return d; };
const wait = async (fn, ms = 30000, label = "condition") => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`${label} timed out`); };
const detail = (id) => j(`/api/work-items/${id}`);
let browser, room;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok, 30000, "server");
	await j("/api/settings", "PUT", { onboarded: true });
	await j("/api/models/default", "PUT", { provider: "mock", model: "echo" }).catch(() => {});
	const mk = (name) => j("/api/agents", "POST", { name, model: { provider: "mock", id: "echo" } });
	const manager = await mk("组长"), worker = await mk("甲"), helper = await mk("乙");
	room = await j("/api/rooms", "POST", { name: "协作验收群", memberIds: [manager.id, worker.id, helper.id], managerId: manager.id });
	const messages = () => j(`/api/rooms/${room.id}/messages`);
	const create = (title, owner, start) => j(`/api/rooms/${room.id}/work-items`, "POST", { title, requirement: "整理可核验的结果", doneCriteria: "结果有第 3 行检查点", ownerAgentId: owner, start });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(`${base}/?room=${room.id}`);
	await page.getByTestId("room-work-items").waitFor();

	console.log("[1] 管理者提议目标 → 用户改完成标准后确认 → 自主推进");
	await j(`/api/rooms/${room.id}/messages`, "POST", { text: "定个目标：本周交一份竞品报告" });
	const card = page.getByTestId("room-goal");
	await card.waitFor();
	assert.match(await page.getByTestId("room-goal-goal").inputValue(), /本周交一份竞品报告/);
	await page.getByTestId("room-goal-done").fill("三家竞品各有一页，结论都有来源");
	await stableShot(page, card, join(out, "01-goal-card.png"));
	await page.getByTestId("room-goal-confirm").click();
	await wait(async () => (await j("/api/rooms")).find((r) => r.id === room.id)?.autonomy?.doneCriteria === "三家竞品各有一页，结论都有来源", 10000, "autonomy on");
	await card.getByText("已开启").waitFor();

	console.log("[2] 任务在负责人会话里执行：完成 / 卡住 / 等你决定 / 进行中 / 已停止");
	const ok = await create("整理竞品报告", worker.id, true);
	await wait(async () => (await detail(ok.item.id)).item.status === "done", 60000, "normal item verified by woken manager");
	const okd = await detail(ok.item.id);
	assert.ok(okd.events.some((e) => e.kind === "verified.pass" && JSON.stringify(e).includes(manager.id)), "管理者核验通过，不是成员自报完成");
	const stuck = await create("数据接入【卡点】", helper.id, true);
	await wait(async () => (await detail(stuck.item.id)).item.board === "stuck", 30000, "stuck");
	const ask = await create("账号权限【卡点】需拍板", worker.id, true);
	await wait(async () => (await detail(ask.item.id)).item.board === "decision", 45000, "manager escalated to user");
	await create("写周报草稿", helper.id, false);
	const old = await create("旧方案", helper.id, false);
	await j(`/api/work-items/${old.item.id}/pause`, "POST", {});
	assert.equal((await detail(stuck.item.id)).item.board, "stuck", "管理者没有把每个卡点都甩给用户");

	console.log("[3] 看板四组 + 等你决定高亮置顶 + 390px");
	await page.getByTestId("room-work-items").click();
	await page.getByTestId("work-group-decision").waitFor();
	await page.getByTestId("work-autonomy").getByText("本周交一份竞品报告").waitFor();
	const order = await page.locator("[data-testid^=work-group-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
	assert.deepEqual(order.slice(0, 3), ["work-group-decision", "work-group-stuck", "work-group-doing"]);
	assert.equal(await page.getByTestId("work-closed").evaluate((e) => e.open), false, "已完成 / 已停止默认折叠");
	await page.getByTestId("work-closed").locator("summary").click();
	assert.ok(await page.getByTestId("work-group-done").isVisible());
	assert.ok(await page.getByTestId("work-group-stopped").isVisible());
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "02-board-groups.png"));
	await page.getByTestId("work-filter-decision").click();
	await page.getByTestId("work-decision").waitFor();
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "03-decision-highlight.png"));
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByTestId("work-filter-all").click();
	await page.getByTestId("work-group-decision").waitFor();
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "04-board-390.png"));
	const box = await page.getByTestId("work-items-overview").boundingBox();
	assert.ok(box.x >= -1 && box.x + box.width <= 391, "390 不溢出");
	await page.setViewportSize({ width: 1440, height: 1000 });

	console.log("[4] 在看板上直接拍板 → 决定发回群里交给管理者");
	await page.getByTestId("work-decision").getByTestId("work-decision-option").filter({ hasText: "先用公开数据" }).click();
	await wait(async () => !(await detail(ask.item.id)).item.needsUser, 10000, "decision cleared");
	await wait(async () => (await messages()).some((m) => m.role === "user" && /账号权限【卡点】需拍板」，我的决定：先用公开数据/.test(m.content ?? "")), 10000, "decision posted to room");
	await page.keyboard.press("Escape");

	console.log("[5] 停群不停任务；看板「全部暂停」才停");
	const long = await create("取消隔离探针", worker.id, true);
	const running = async () => (await messages()).some((m) => m.role === "tool" && m.status === "running" && String(m.meta?.args?.command).includes("cancellation-probe.txt"));
	await wait(running, 20000, "work bash running");
	await j(`/api/rooms/${room.id}/stop`, "POST", {});
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal((await detail(long.item.id)).item.status, "active", "停群后任务仍在执行");
	assert.ok(await running(), "停群没有中止任务里的命令");
	await page.getByTestId("room-work-items").click();
	await page.getByTestId("work-pause-all").click();
	await stableShot(page, page.getByTestId("confirm-dialog"), join(out, "05-pause-all-confirm.png"));
	await page.getByTestId("confirm-ok").click();
	await wait(async () => (await detail(long.item.id)).item.status === "paused", 10000, "pause-all paused");
	await wait(async () => !(await running()), 10000, "bash stopped");
	assert.equal(errors.length, 0, errors.join(" | "));
	console.log("PASS group-collab: 目标卡确认→自主推进、负责人会话执行+管理者唤醒核验、卡住/等你决定/直接拍板、四组看板+390、停群不停任务+全部暂停");
} catch (e) {
	console.error("GROUP COLLAB FAIL", e.message);
	if (room) console.error("messages", JSON.stringify((await j(`/api/rooms/${room.id}/messages`).catch(() => [])).slice(-10).map((m) => [m.role, m.agent_id, m.meta?.kind ?? m.meta?.toolName, String(m.content ?? "").slice(0, 160)])));
	if (room) console.error("fixture", JSON.stringify(await j(`/api/rooms/${room.id}/work-items`).catch(() => ({}))).slice(0, 3000));
	if (process.env.WORK_DEBUG) console.error(server.logs?.().slice(-6000));
	throw e;
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
