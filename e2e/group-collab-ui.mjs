/**
 * 群协作（决策 0006 / 0019）：真实服务 / 真实 PiMock / 真实构建页面。
 *
 * 覆盖：
 *  1) 立项：用户说「立项：…」→ 管理者 room_plan 出方案卡（假设区可见、卡片有内边距不溢出、390 不越框），顶部出现项目 chip（待确认）；
 *  2) 点「就这么干」→ 卡片已确认、chip 进行中、群里有 started 告知；打开项目面板看到方案 → 停下项目（确认框）→ chip 消失；
 *  3) 另起一个方案点「先不做」→ 卡片先不做；再起一个在群里打字「可以」→ 管理者 room_project_start 确认；面板里能展开已结束的项目；
 *  4) 任务在负责人自己的会话里执行：正常任务提交 → 管理者被唤醒核验完成；成员报卡点 → 「卡住」；
 *     管理者判断需要用户拍板 → 「等你决定」高亮置顶，用户在看板上直接回答，决定发回群里；
 *  5) 看板四组（等你决定 / 卡住 / 进行中 / 已完成·已停止折叠）+ 390px；
 *  6) 停群不停任务：停群后正在执行的任务继续跑，看板「全部暂停」才停。
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

	const roomNow = async () => (await j("/api/rooms")).find((r) => r.id === room.id);
	const allProjects = async () => (await j(`/api/rooms/${room.id}/projects?all=1`)).projects;
	const chip = page.getByTestId("room-projects-chip");
	const card = (pid) => page.locator(`[data-testid=room-plan][data-project="${pid}"]`);
	const proposeNew = async (text) => {
		const before = new Set((await allProjects()).map((p) => p.id));
		await j(`/api/rooms/${room.id}/messages`, "POST", { text });
		let p;
		await wait(async () => (p = (await roomNow()).projects?.find((x) => !before.has(x.id) && x.status === "proposed")), 20000, `plan for ${text}`);
		await card(p.id).waitFor();
		assert.equal(await card(p.id).getAttribute("data-status"), "pending");
		return p;
	};
	const started = async (pid) => (await messages()).some((m) => m.meta?.kind === "room-project" && m.meta.event === "started" && m.meta.projectId === pid);
	const noOverflow = async (loc, label) => {
		const r = await loc.evaluate((el) => ({ pad: parseFloat(getComputedStyle(el).paddingLeft), sw: el.scrollWidth, cw: el.clientWidth }));
		assert.ok(r.pad >= 12, `${label} 文字不贴边（padding ${r.pad}）`);
		assert.ok(r.sw <= r.cw + 1, `${label} 内容不超出卡片（${r.sw} > ${r.cw}）`);
	};

	console.log("[1] 立项 → 管理者出方案卡（假设区醒目）+ 顶部项目 chip 待确认");
	const p1 = await proposeNew("立项：写一份竞品报告");
	const c1 = card(p1.id);
	assert.equal((await c1.getByTestId("room-plan-status").textContent()).trim(), "待你确认");
	assert.ok(await c1.getByTestId("room-plan-assumptions").isVisible(), "假设区可见");
	assert.ok(p1.plan.goal && p1.plan.roles.length && p1.plan.stages.length, "方案字段齐全");
	await c1.getByText(p1.plan.goal).first().waitFor();
	await noOverflow(c1, "方案卡");
	await chip.filter({ hasText: p1.title }).filter({ hasText: "待确认" }).waitFor();
	assert.equal(await page.getByTestId("room-autonomy-chip").count(), 0, "不再有自主推进按钮");
	await stableShot(page, c1, join(out, "01-plan-card.png"));
	await page.setViewportSize({ width: 390, height: 844 });
	await c1.scrollIntoViewIfNeeded();
	const cb = await c1.boundingBox();
	assert.ok(cb.x >= -1 && cb.x + cb.width <= 391, "方案卡 390 不越框");
	await noOverflow(c1, "方案卡 390");
	await stableShot(page, c1, join(out, "01b-plan-card-390.png"));
	await page.setViewportSize({ width: 1440, height: 1000 });

	console.log("[2] 点「就这么干」→ 卡片已确认、chip 进行中、群里有开始告知");
	await c1.getByTestId("room-plan-confirm").click();
	await wait(async () => (await c1.getAttribute("data-status")) === "confirmed", 10000, "card confirmed");
	assert.equal((await c1.getByTestId("room-plan-status").textContent()).trim(), "已确认");
	assert.equal(await c1.getByTestId("room-plan-confirm").count(), 0, "确认后按钮收起");
	await chip.filter({ hasText: "进行中" }).waitFor();
	assert.equal((await roomNow()).projects.find((p) => p.id === p1.id)?.status, "active");
	await wait(() => started(p1.id), 10000, "started notice");
	await page.getByText(/方案已确认，项目「/).first().waitFor();
	await stableShot(page, c1, join(out, "02-plan-confirmed.png"));

	console.log("[3] 项目面板看方案 → 停下项目（确认框）→ chip 消失");
	await chip.click();
	const panel = page.getByTestId("room-projects-panel");
	const item = panel.getByTestId("room-project-item").filter({ hasText: p1.title });
	await item.getByText(p1.plan.goal).first().waitFor();
	await item.getByText(p1.plan.doneCriteria).first().waitFor();
	await stableShot(page, panel, join(out, "03-projects-panel.png"));
	await item.getByTestId("room-project-stop").click();
	await stableShot(page, page.getByTestId("confirm-dialog"), join(out, "04-stop-confirm.png"));
	await page.getByTestId("confirm-ok").click();
	await chip.waitFor({ state: "detached" });
	assert.equal(await panel.count(), 0, "没有项目时面板跟着关掉");
	assert.equal((await allProjects()).find((p) => p.id === p1.id)?.status, "stopped");

	console.log("[4] 另起一个方案 → 点「先不做」");
	const p2 = await proposeNew("立项：做一个小程序原型");
	const c2 = card(p2.id);
	await chip.filter({ hasText: "待确认" }).waitFor();
	await c2.getByTestId("room-plan-dismiss").click();
	await wait(async () => (await c2.getAttribute("data-status")) === "dismissed", 10000, "card dismissed");
	assert.equal((await c2.getByTestId("room-plan-status").textContent()).trim(), "先不做");
	await chip.waitFor({ state: "detached" });
	assert.equal((await allProjects()).find((p) => p.id === p2.id)?.status, "dismissed");

	console.log("[5] 再起一个方案 → 在群里打字「可以」确认；面板里展开已结束的项目");
	const p3 = await proposeNew("立项：写一份周报模板");
	const c3 = card(p3.id);
	await j(`/api/rooms/${room.id}/messages`, "POST", { text: "可以" });
	await wait(async () => (await c3.getAttribute("data-status")) === "confirmed", 20000, "card confirmed by chat");
	await wait(async () => (await roomNow()).projects.find((p) => p.id === p3.id)?.status === "active", 10000, "project active by chat");
	await wait(() => started(p3.id), 10000, "started notice by chat");
	await chip.filter({ hasText: p3.title }).filter({ hasText: "进行中" }).waitFor();
	await chip.click();
	await page.getByTestId("room-projects-ended-toggle").click();
	await panel.getByText(p1.title).first().waitFor();
	await panel.getByText(p2.title).first().waitFor();
	await stableShot(page, panel, join(out, "05-projects-ended.png"));
	await page.keyboard.press("Escape");

	console.log("[6] 任务在负责人会话里执行：完成 / 卡住 / 等你决定 / 进行中 / 已停止");
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

	console.log("[7] 看板四组 + 等你决定高亮置顶 + 390px");
	await page.getByTestId("room-work-items").click();
	await page.getByTestId("work-group-decision").waitFor();
	const order = await page.locator("[data-testid^=work-group-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
	assert.deepEqual(order.slice(0, 3), ["work-group-decision", "work-group-stuck", "work-group-doing"]);
	assert.equal(await page.getByTestId("work-closed").evaluate((e) => e.open), false, "已完成 / 已停止默认折叠");
	await page.getByTestId("work-closed").locator("summary").click();
	assert.ok(await page.getByTestId("work-group-done").isVisible());
	assert.ok(await page.getByTestId("work-group-stopped").isVisible());
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "06-board-groups.png"));
	await page.getByTestId("work-filter-decision").click();
	await page.getByTestId("work-decision").waitFor();
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "07-decision-highlight.png"));
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByTestId("work-filter-all").click();
	await page.getByTestId("work-group-decision").waitFor();
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "08-board-390.png"));
	const box = await page.getByTestId("work-items-overview").boundingBox();
	assert.ok(box.x >= -1 && box.x + box.width <= 391, "390 不溢出");
	await page.setViewportSize({ width: 1440, height: 1000 });

	console.log("[8] 在看板上直接拍板 → 决定发回群里交给管理者");
	await page.getByTestId("work-decision").getByTestId("work-decision-option").filter({ hasText: "先用公开数据" }).click();
	await wait(async () => !(await detail(ask.item.id)).item.needsUser, 10000, "decision cleared");
	await wait(async () => (await messages()).some((m) => m.role === "user" && /账号权限【卡点】需拍板」，我的决定：先用公开数据/.test(m.content ?? "")), 10000, "decision posted to room");
	await page.keyboard.press("Escape");

	console.log("[9] 停群不停任务；看板「全部暂停」才停");
	const long = await create("取消隔离探针", worker.id, true);
	// 群任务执行跑在成员的帮手上：命令在帮手详情里（群里只看到帮手卡片）
	const execSteps = async () => (await Promise.all((await j(`/api/subagents?agent=${worker.id}&room=${room.id}`)).filter((x) => x.kind === "work").map((h) => j(`/api/subagents/${h.id}`)))).flatMap((d) => d.messages);
	const running = async () => (await execSteps()).some((m) => m.role === "tool" && m.status === "running" && String(m.meta?.args?.command).includes("cancellation-probe.txt"));
	await wait(running, 20000, "work bash running");
	await j(`/api/rooms/${room.id}/stop`, "POST", {});
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal((await detail(long.item.id)).item.status, "active", "停群后任务仍在执行");
	assert.ok(await running(), "停群没有中止任务里的命令");
	await page.getByTestId("room-work-items").click();
	await page.getByTestId("work-pause-all").click();
	await stableShot(page, page.getByTestId("confirm-dialog"), join(out, "09-pause-all-confirm.png"));
	await page.getByTestId("confirm-ok").click();
	await wait(async () => (await detail(long.item.id)).item.status === "paused", 10000, "pause-all paused");
	await wait(async () => !(await running()), 10000, "bash stopped");
	assert.equal(errors.length, 0, errors.join(" | "));
	console.log("PASS group-collab: 立项出方案卡、按钮确认 / 先不做 / 群里说「可以」确认、项目 chip 与面板（看方案、停下、已结束）、负责人会话执行+管理者唤醒核验、卡住/等你决定/直接拍板、四组看板+390、停群不停任务+全部暂停");
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
