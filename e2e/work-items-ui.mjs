/**
 * 长期任务看板 + 群内自然语言纠正闭环（真实服务 / 真实 PiMock / 真实构建页面）。
 *
 * 覆盖：
 *  1) 管理者在群里记录长期任务并派活 → 成员提交 → 管理者核验完成；
 *  2) 用户在看板「在群里说」指出具体问题 → 服务端带上可信任务关联 → 管理者重开原任务 / 更新要求 / 安排第二次执行
 *     → 成员再次提交 → 管理者核验完成（同一任务新修订，不新建副本，不自动完成）；
 *  3) 看板详情、执行历史、旧修订标记、持久化（刷新后仍在）；
 *  4) 保存 / 操作失败可见且保留草稿；
 *  5) 390px 窄屏真实内容边界。
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
import { stableShot, waitStable } from "./fixtures/stable-shot.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-work-items-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run, log: process.env.WORK_DEBUG ? (d) => process.stdout.write(d) : undefined });
const out = process.env.SHOT_DIR ?? join(root, "docs/screenshots/work-items");
mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch {} if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${t.slice(0, 300)}`); return d; };
const wait = async (fn, ms = 20000, label = "condition") => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`${label} timed out`); };
let browser;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok, 30000, "server");
	await j("/api/settings", "PUT", { onboarded: true });
	await j("/api/models/default", "PUT", { provider: "mock", model: "echo" }).catch(() => {});
	const manager = await j("/api/agents", "POST", { name: "组长", model: { provider: "mock", id: "echo" } });
	const member = await j("/api/agents", "POST", { name: "甲", model: { provider: "mock", id: "echo" } });
	const room = await j("/api/rooms", "POST", { name: "任务验收群", memberIds: [manager.id, member.id], managerId: manager.id });
	const items = () => j(`/api/rooms/${room.id}/work-items`);
	const detail = (id) => j(`/api/work-items/${id}`);

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e.message));
	await page.goto(`${base}/?room=${room.id}`);
	await page.getByTestId("room-chat").waitFor();
	await page.getByTestId("room-work-items").waitFor();
	assert.equal(await page.getByTestId("room-work-items").innerText(), "任务", "顶部是明确的「任务」入口，不和「执行」混在一起");
	if (await page.getByTestId("subagent-tasks").count()) assert.match(await page.getByTestId("subagent-tasks").innerText(), /执行/, "原执行概览改名为「执行」");

	// ---------------- 1) 管理者记录任务 → 成员提交 → 管理者核验完成（真实 PiMock + 群调度）
	console.log("[1] 群里首次长期任务：记录 → 派活 → 提交 → 核验");
	await j(`/api/rooms/${room.id}/messages`, "POST", { text: "长期任务：季度报告。要求：整理 Q3 数据并给出结论。完成标准：报告里每条结论都附来源链接，且有第 3 行检查点。派给甲" });
	try {
		await wait(async () => (await items()).items.some((x) => x.title === "季度报告" && x.status === "done"), 90000, "first work item done");
	} catch (e) {
		console.log("DEBUG items", JSON.stringify(await items(), null, 2));
		console.log("DEBUG room", JSON.stringify((await j(`/api/rooms/${room.id}`)), null, 2));
		console.log("DEBUG msgs", JSON.stringify((await j(`/api/rooms/${room.id}/messages`)).slice(-20).map((m) => ({ role: m.role, agent: m.agent_id, content: m.content?.slice(0, 300), meta: m.meta })), null, 2));
		console.log("DEBUG server logs", server.logs().slice(-4000));
		throw e;
	}
	const list1 = await items();
	const first = list1.items.find((x) => x.title === "季度报告");
	assert.equal(first.ownerName, "甲");
	const d1 = await detail(first.id);
	assert.equal(d1.item.revision, 1, "首次执行只用了 1 个修订");
	assert.equal(d1.item.verification?.verdict, "pass");
	assert.match(String(d1.item.verification?.note), /检查点/, "完成必须有检查结论，不是模型自报");
	assert.equal(d1.runs.length, 1);
	assert.ok(d1.runs[0].submittedAt, "成员提交过结果");
	assert.equal(d1.item.status, "done", "只有管理者核验后才是完成");
	// 群里出现结果卡
	await page.reload();
	await page.getByTestId("room-chat").waitFor();
	await page.getByTestId("work-result-card").last().waitFor({ timeout: 20000 });
	assert.match(await page.getByTestId("work-result-card").last().innerText(), /季度报告/);

	// 看板：已完成默认折叠；打开后能看到负责人、完成结论
	await page.getByTestId("room-work-items").click();
	await page.getByTestId("work-items-overview").waitFor();
	await page.getByTestId("work-filter-done").click();
	await page.getByTestId("work-group-done").getByTestId("work-item-row").first().click();
	await page.getByTestId("work-detail").waitFor();
	assert.match(await page.getByTestId("work-detail-title").innerText(), /季度报告/);
	assert.match(await page.getByTestId("work-detail").innerText(), /验收结论/);
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "01-detail-done.png"));
	await page.getByTestId("work-detail-back").click();
	await page.getByTestId("work-filter-all").click();

	// ---------------- 2) 看板上指出具体问题 → 同一任务重开 / 改要求 / 第二次执行 → 再核验
	console.log("[2] 看板「在群里说」→ 管理者更新原任务 → 第二次执行 → 再核验");
	await page.getByTestId("work-filter-done").click();
	await page.getByTestId("work-group-done").getByTestId("work-item-row").first().click();
	await page.getByTestId("work-feedback-text").fill("这版有问题：总结里都是空话，改成每条结论都必须附来源链接");
	await page.getByTestId("work-feedback-send").click();
	await page.getByTestId("work-items-overview").waitFor({ state: "detached", timeout: 15000 });
	try {
		await wait(async () => {
			const d = await detail(first.id);
			return d.item.status === "done" && d.item.revision > 1 && d.runs.length >= 2;
		}, 90000, "corrected second run done");
	} catch (e) {
		console.log("DEBUG detail", JSON.stringify(await detail(first.id), null, 2));
		console.log("DEBUG msgs", JSON.stringify((await j(`/api/rooms/${room.id}/messages`)).slice(-24).map((m) => ({ role: m.role, agent: m.agent_id, content: m.content?.slice(0, 400), meta: m.meta })), null, 2));
		throw e;
	}
	const d2 = await detail(first.id);
	assert.ok(d2.item.revision >= 4, `重开 + 更新要求 + 继续都应推进修订（实际 ${d2.item.revision}）`);
	assert.match(d2.item.requirement, /来源链接/, "新要求写在原任务上");
	assert.equal(d2.item.title, "季度报告", "没有新建副本");
	assert.equal(d2.item.status, "done");
	const kinds = d2.events.map((e) => e.kind);
	assert.ok(kinds.includes("reopened"), "已完成任务需要先显式重开");
	assert.ok(kinds.includes("edited"), "更新了原任务要求");
	assert.ok(kinds.includes("verified.return") || kinds.includes("reopened"), "有退回 / 重开记录");
	assert.ok(d2.runs.some((r) => r.stale), "旧执行保留为历史并标记过期");
	assert.equal(d2.runs.filter((r) => !r.stale && r.submittedAt).length >= 1, true, "新修订也有成员提交");
	// 群里仍是主入口：成员真实产物、管理者核验结论可见；结果卡不重复刷屏
	const roomMsgs = await j(`/api/rooms/${room.id}/messages`);
	const texts = roomMsgs.map((m) => String(m.content ?? ""));
	assert.ok(texts.some((t) => /已提交结果.*out\.txt/.test(t)), "成员在自己的回合把真实交付说在群里");
	assert.ok(texts.some((t) => /任务「季度报告」核验通过/.test(t)), "管理者核验结论回到原群");
	assert.ok(texts.some((t) => /已退回修改|已重开/.test(t)), "退回修改 / 重开也在群里可见");
	const cards = roomMsgs.filter((m) => m.role === "card" && m.meta?.kind === "work-result" && m.meta?.workItemId === first.id);
	assert.equal(cards.length, 2, `同一任务两次交付各一张结果卡，不重复刷屏（实际 ${cards.length}）`);
	// 看板显示两次执行 + 旧修订
	await page.getByTestId("room-work-items").click();
	await page.getByTestId("work-filter-done").click();
	try {
		await page.getByTestId("work-group-done").getByTestId("work-item-row").first().click();
	} catch (e) {
		console.log("DEBUG board", await page.getByTestId("work-board").innerText().catch(() => "no board"));
		console.log("DEBUG itemsApi", JSON.stringify(await items()));
		console.log("DEBUG detailApi", JSON.stringify(await detail(first.id)));
		throw e;
	}
	await page.getByTestId("work-detail").waitFor();
	assert.equal(await page.getByTestId("work-run").count() >= 2, true);
	assert.match(await page.getByTestId("work-detail").innerText(), /旧修订/);
	assert.match(await page.getByTestId("work-detail").innerText(), /来源链接/);
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "02-detail-second-run.png"));

	// ---------------- 3) 失败可见 + 保留草稿
	console.log("[3] 操作失败可见、草稿保留");
	await page.getByTestId("work-detail-back").click();
	await page.getByTestId("work-create-open").click();
	await page.getByTestId("work-create").waitFor();
	await page.getByTestId("work-create-title").fill("失败可见任务");
	await page.getByTestId("work-create-requirement").fill("先记责任，不马上执行");
	await page.getByTestId("work-create-owner").click();
	await page.locator('[role="option"]').filter({ hasText: "甲" }).first().click();
	await page.getByTestId("work-create-start").uncheck();
	await page.getByTestId("work-create-submit").click();
	await page.getByTestId("work-detail").waitFor();
	const pendingId = (await items()).items.find((x) => x.title === "失败可见任务").id;
	assert.equal((await detail(pendingId)).item.status, "pending");
	// 开始失败：503 → 错误可见，状态不变
	await page.route(`**/api/work-items/${pendingId}/start`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "模拟开始失败" }) }));
	await page.getByTestId("work-action-start").click();
	await page.getByTestId("work-action-error").waitFor();
	assert.match(await page.getByTestId("work-action-error").innerText(), /模拟开始失败/);
	assert.equal((await detail(pendingId)).item.status, "pending");
	await page.unroute(`**/api/work-items/${pendingId}/start`);
	// 编辑失败：错误可见，草稿不被清空
	await page.getByTestId("work-action-edit").click();
	await page.getByTestId("work-edit-requirement").fill("这是用户写到一半的新要求");
	await page.route(`**/api/work-items/${pendingId}`, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "模拟保存失败" }) }) : route.continue()));
	await page.getByTestId("work-edit-save").click();
	await page.getByTestId("work-action-error").waitFor();
	assert.equal(await page.getByTestId("work-edit-requirement").inputValue(), "这是用户写到一半的新要求", "失败保留草稿");
	assert.match(await page.getByTestId("work-action-error").innerText(), /模拟保存失败/);
	await page.getByTestId("work-edit").scrollIntoViewIfNeeded();
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "03-error-draft.png"));
	await page.unroute(`**/api/work-items/${pendingId}`);
	await page.getByTestId("work-edit-save").click();
	await wait(async () => (await detail(pendingId)).item.requirement.includes("写到一半"), 10000, "edit saved");

	// ---------------- 4) 390px 窄屏真实内容边界
	console.log("[4] 390px 窄屏");
	await page.getByTestId("work-detail-back").click();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByTestId("work-board").waitFor();
	const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth, board: document.querySelector('[data-testid="work-board"]')?.scrollWidth ?? 0 }));
	const wide = await page.evaluate(() => [...document.querySelectorAll('[data-testid="work-board"] *')].map((el) => ({ tag: el.tagName, cls: (el.getAttribute("class") ?? "").slice(0, 60), sw: el.scrollWidth, ow: el.getBoundingClientRect().width, text: (el.textContent ?? "").slice(0, 30) })).filter((x) => x.sw > window.innerWidth + 1).slice(0, 8));
	if (process.env.WORK_DEBUG) console.log("WIDE", JSON.stringify(wide));
	assert.ok(m.doc <= m.view + 1 && m.board <= m.view + 1, `390 不横向溢出：${JSON.stringify(m)}`);
	await page.getByTestId("work-filter-all").click();
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "04-board-390.png"));
	// 详情也检查正文可见边界（终态默认折叠，先筛“已完成”再打开）
	await page.getByTestId("work-filter-done").click();
	await page.getByTestId("work-group-done").getByTestId("work-item-row").first().click();
	await page.getByTestId("work-detail").waitFor();
	await waitStable(page, page.getByTestId("work-items-overview"));
	const d = await page.evaluate(() => {
		const el = document.querySelector('[data-testid="work-detail"]');
		const r = el?.getBoundingClientRect();
		const modal = document.querySelector('[data-testid="work-items-overview"]')?.getBoundingClientRect();
		return { doc: document.documentElement.scrollWidth, view: window.innerWidth, left: r?.left ?? -1, right: r?.right ?? 0, modalLeft: modal?.left ?? -1, modalRight: modal?.right ?? 0, height: r?.height ?? 0 };
	});
	assert.ok(d.doc <= d.view + 1 && d.left >= -1 && d.right <= d.view + 1 && d.modalLeft >= -1 && d.modalRight <= d.view + 1 && d.height > 300, `390 详情正文可见：${JSON.stringify(d)}`);
	await stableShot(page, page.getByTestId("work-items-overview"), join(out, "05-detail-390.png"));

	// ---------------- 5) 持久化
	console.log("[5] 刷新后仍持久");
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.reload();
	await page.getByTestId("room-work-items").waitFor();
	await page.getByTestId("room-work-items").click();
	await page.getByTestId("work-items-overview").waitFor();
	await page.getByTestId("work-item-row").first().waitFor();
	assert.ok(await page.getByTestId("work-item-row").count() >= 1);
	await page.keyboard.press("Escape");
	assert.equal(pageErrors.length, 0, `页面无异常：${pageErrors.join(" | ")}`);
	console.log("PASS work-items: 首次任务/核验、看板反馈→同一任务重开+新修订+二次执行、失败可见+草稿、390 边界、持久化");
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
