/**
 * 单聊也走方案流程（docs/design/group-team.md §13）：真实服务 / 真实 PiMock / 真实构建页面。
 *
 * 覆盖：
 *  1) 单聊里说「做个大事」→ 助理出方案卡（假设区可见、不越框）→ 点「就这么干」→ 卡片已确认、聊天里两条阶段进度、交付卡（文件可预览）、项目结束；
 *  2) 再来一次，这次在聊天里说「可以」确认（和点按钮同效果）；
 *  3) 「先不做」：卡片 dismissed、没有项目、助理不开工；
 *  4) 慢速项目：顶部 chip「项目名 · 阶段 n/m」→ 点开面板看方案和进度 → 中途「停下这个项目」→ 项目 stopped、chip 消失、助理手上的活停下；
 *  5) 390 宽：方案卡 / 交付卡不越框；
 *  6) 旧的群聊 room-goal 卡片在历史里只读显示（没有输入框和按钮，不调接口）；
 *  7) 小事照常直接做（说「写一份报告」不出方案卡）。
 *
 * 全程临时 DATA/WORKSPACE/HOME/TMPDIR + 内存凭据 + loopback Mock，不碰生产库 / 凭据 / 付费模型。
 * Mock 行为见 packages/server/src/pi-adapter/mock-chat-plan-provider.ts。
 * 运行：node e2e/chat-plan-ui.mjs（截图写 artifacts/screenshots/chat-plan/）
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-chat-plan-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run, log: process.env.WORK_DEBUG ? (d) => process.stdout.write(d) : undefined });
const out = process.env.SHOT_DIR ?? join(artifactDir("screenshots"), "chat-plan");
mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch {} if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${t.slice(0, 300)}`); return d; };
const wait = async (fn, ms = 30000, label = "condition") => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`${label} timed out`); };
let browser, agent, page;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok, 30000, "server");
	await j("/api/settings", "PUT", { onboarded: true });
	await j("/api/models/default", "PUT", { provider: "mock", model: "echo" }).catch(() => {});
	agent = await j("/api/agents", "POST", { name: "项目助理", model: { provider: "mock", id: "echo" } });
	const convId = async () => (await j(`/api/agents/${agent.id}/conversations`)).current;
	const messages = () => j(`/api/agents/${agent.id}/messages`);
	const projects = async (all = true) => (await j(`/api/conversations/${await convId()}/projects${all ? "?all=1" : ""}`)).projects;

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	if (process.env.CHAT_PLAN_DEBUG) { const t0 = Date.now(); page.on("response", async (r) => { if (/\/projects/.test(r.url())) console.log(((Date.now() - t0) / 1000).toFixed(1), r.request().method(), r.status(), r.url().replace(base, "").slice(-60), (await r.text().catch(() => "")).replace(/"plan":.*/, "").slice(0, 140)); }); }
	await page.goto(`${base}/?agent=${agent.id}`);
	const ta = page.locator("[data-testid=main-conversation] textarea:visible:not(.pa-card textarea)");
	await ta.waitFor();
	const chip = page.getByTestId("room-projects-chip");
	// 助理这一轮彻底收尾后再说话（收尾时说话会作为插话送达，那是另一条路径，这里不测）
	const idle = () => wait(async () => (await j("/api/agents")).find((a) => a.id === agent.id)?.status !== "running", 30000, "助理空闲");
	const say = async (text) => { await idle(); await ta.fill(text); await ta.press("Enter"); };
	const card = (pid) => page.locator(`[data-testid=room-plan][data-project="${pid}"]`);
	const deliv = (pid) => page.locator(`[data-testid=project-delivery][data-project="${pid}"]`);
	const noOverflow = async (loc, label) => {
		const r = await loc.evaluate((el) => ({ pad: parseFloat(getComputedStyle(el).paddingLeft), sw: el.scrollWidth, cw: el.clientWidth }));
		assert.ok(r.pad >= 12, `${label} 文字不贴边（padding ${r.pad}）`);
		assert.ok(r.sw <= r.cw + 1, `${label} 内容不超出卡片（${r.sw} > ${r.cw}）`);
	};
	/** 说一句话，等出现一个新的待确认项目（返回它） */
	const proposeNew = async (text) => {
		const before = new Set((await projects()).map((p) => p.id));
		await say(text);
		let p;
		await wait(async () => (p = (await projects()).find((x) => !before.has(x.id) && x.status === "proposed")), 30000, `plan for ${text}`);
		await card(p.id).waitFor();
		assert.equal(await card(p.id).getAttribute("data-status"), "pending");
		return p;
	};
	const sysNotices = async () => (await messages()).filter((m) => m.role === "system" && m.meta?.kind === "chat-project");
	const checkDelivery = async (pid, label) => {
		await wait(async () => (await projects()).find((p) => p.id === pid)?.status === "done", 60000, `${label} 项目交付`);
		const dm = (await messages()).find((m) => m.meta?.kind === "project-delivery" && m.meta.projectId === pid);
		assert.ok(dm, `${label} 有交付卡消息`);
		assert.ok(dm.meta.summary && dm.meta.howToUse && dm.meta.notDone, `${label} 交付卡有做成了什么 / 怎么用 / 还没做的`);
		assert.ok(dm.meta.files.some((f) => f.name === "chat-plan-result.md" && f.fileId), `${label} 交付卡带上工作区里写的文件`);
		const d = deliv(pid);
		await d.waitFor();
		await d.scrollIntoViewIfNeeded();
		assert.ok(!/花费|费用|¥|\$/.test(await d.textContent()), `${label} 交付卡不谈花费`);
		await noOverflow(d, `${label} 交付卡`);
		return d;
	};

	console.log("[1] 小事照常直接做：说「写一份报告」不出方案卡");
	await say("写一份报告");
	await page.getByText("报告已经生成并发给你了").first().waitFor({ timeout: 30000 });
	assert.equal((await projects()).length, 0, "小事没有项目");
	assert.equal(await page.getByTestId("room-plan").count(), 0, "小事没有方案卡");
	assert.equal(await chip.count(), 0, "没有项目 chip");

	console.log("[2] 说「做个大事」→ 助理出方案卡（假设区可见）+ 顶部 chip 待确认");
	const p1 = await proposeNew("做个大事");
	const c1 = card(p1.id);
	assert.equal((await c1.getByTestId("room-plan-status").textContent()).trim(), "待你确认");
	assert.ok(await c1.getByTestId("room-plan-assumptions").isVisible(), "假设区可见");
	assert.ok(p1.plan.goal && p1.plan.stages.length === 2 && p1.plan.deliverables, "方案字段齐全、两个阶段");
	await c1.getByText("梳理要点").first().waitFor();
	assert.match(await c1.textContent(), /想改哪里，直接跟我说/, "单聊的提示是跟「我」说，不是群里的管理者");
	await noOverflow(c1, "方案卡");
	await chip.filter({ hasText: p1.title }).filter({ hasText: "待确认" }).waitFor();
	await stableShot(page, c1, join(out, "01-plan-card.png"));
	await page.setViewportSize({ width: 390, height: 844 });
	await c1.scrollIntoViewIfNeeded();
	const cb = await c1.boundingBox();
	assert.ok(cb.x >= -1 && cb.x + cb.width <= 391, "方案卡 390 不越框");
	await noOverflow(c1, "方案卡 390");
	await stableShot(page, c1, join(out, "01b-plan-card-390.png"));
	await page.setViewportSize({ width: 1440, height: 1000 });

	console.log("[3] 点「就这么干」→ 卡片已确认；聊天里两条阶段进度；交付卡（文件可预览）；项目结束、chip 消失");
	await c1.getByTestId("room-plan-confirm").click();
	await wait(async () => (await c1.getAttribute("data-status")) === "confirmed", 10000, "card confirmed");
	assert.equal(await c1.getByTestId("room-plan-confirm").count(), 0, "确认后按钮收起");
	const d1 = await checkDelivery(p1.id, "按钮确认");
	const notices = (await sysNotices()).map((m) => m.content);
	assert.ok(notices.some((t) => /方案已确认，项目「整理一份小结」开始了/.test(t)), "有开始告知");
	assert.ok(notices.some((t) => /阶段「梳理要点」完成了（1\/2）——要点清单整理好了/.test(t)), "第一阶段进度");
	assert.ok(notices.some((t) => /阶段「整理成稿」完成了（2\/2）/.test(t)), "第二阶段进度");
	assert.ok(notices.some((t) => /已完成，成果见下面的交付卡/.test(t)), "有完成告知");
	await page.getByText(/阶段「梳理要点」完成了（1\/2）/).first().waitFor();
	await d1.getByTestId("delivery-summary").waitFor();
	await stableShot(page, d1, join(out, "02-delivery-card.png"));
	await d1.getByTestId("file-preview-open").first().click();
	await page.getByTestId("file-preview-name").filter({ hasText: "chat-plan-result.md" }).waitFor();
	await page.getByTestId("file-preview-close").click();
	await wait(async () => (await chip.count()) === 0, 10000, "项目结束后 chip 消失");
	await page.setViewportSize({ width: 390, height: 844 });
	await d1.scrollIntoViewIfNeeded();
	const db1 = await d1.boundingBox();
	assert.ok(db1.x >= -1 && db1.x + db1.width <= 391, "交付卡 390 不越框");
	await noOverflow(d1, "交付卡 390");
	await stableShot(page, d1, join(out, "02b-delivery-card-390.png"));
	await page.setViewportSize({ width: 1440, height: 1000 });

	console.log("[4] 再来一次，这次在聊天里说「可以」确认（和点按钮同效果）");
	const p2 = await proposeNew("做个大事，再来一次");
	await say("可以"); // 助理收尾时说也行（会作为插话送达），Mock 都按普通的一句话处理
	await wait(async () => (await card(p2.id).getAttribute("data-status")) === "confirmed", 30000, "说可以后卡片已确认");
	await checkDelivery(p2.id, "口头确认");
	const calls = (await messages()).filter((m) => m.role === "tool" && m.meta?.toolName === "chat_project_start");
	assert.equal(calls.length, 1, "助理用 chat_project_start 确认（用户说过话之后）");

	console.log("[5] 「先不做」：卡片 dismissed、项目 dismissed、助理不开工");
	const p3 = await proposeNew("做个大事，先看看方案");
	await chip.filter({ hasText: "待确认" }).click();
	const panel = page.getByTestId("room-projects-panel");
	await panel.getByTestId("room-project-item").filter({ hasText: p3.title }).waitFor();
	await panel.getByText("方案卡在聊天里，确认后开始。").waitFor();
	assert.equal(await panel.getByTestId("room-project-stop").count(), 0, "还没开始的项目没有停下按钮");
	await stableShot(page, panel, join(out, "03-panel-proposed.png"));
	await page.keyboard.press("Escape");
	await card(p3.id).getByTestId("room-plan-dismiss").click();
	await wait(async () => (await card(p3.id).getAttribute("data-status")) === "dismissed", 10000, "card dismissed");
	assert.equal((await projects()).find((p) => p.id === p3.id).status, "dismissed");
	await wait(async () => (await chip.count()) === 0, 10000, "先不做后 chip 消失");
	await page.waitForTimeout(800);
	assert.ok(!(await sysNotices()).some((m) => m.meta.projectId === p3.id && m.meta.event === "started"), "先不做不会开工");

	console.log("[6] 慢速项目：chip「项目名 · 阶段 n/m」→ 面板看方案和进度 → 中途停下");
	const p4 = await proposeNew("做个大事（慢）");
	assert.match(p4.title, /（慢）/);
	await card(p4.id).getByTestId("room-plan-confirm").click();
	await chip.filter({ hasText: p4.title }).filter({ hasText: "阶段 1/2" }).waitFor({ timeout: 20000 });
	await chip.click();
	const panel2 = page.getByTestId("room-projects-panel");
	const item = panel2.getByTestId("room-project-item").filter({ hasText: p4.title });
	await item.waitFor();
	assert.equal(await item.getAttribute("data-status"), "active");
	const prog = item.getByTestId("room-project-progress");
	await prog.waitFor();
	assert.match(await prog.textContent(), /梳理要点.*进行中.*整理成稿.*没开始/, "进度清单：第一阶段进行中、第二阶段没开始");
	assert.equal(await prog.getByTestId("room-progress-item").count(), 0, "单聊项目没有任务清单");
	assert.ok(!/还没有任务/.test(await prog.textContent()), "单聊项目不显示「还没有任务」");
	await stableShot(page, panel2, join(out, "04-panel-active.png"));
	await item.getByTestId("room-project-stop").click();
	await page.getByTestId("confirm-ok").click();
	await wait(async () => (await projects()).find((x) => x.id === p4.id)?.status === "stopped", 15000, "项目停下");
	await wait(async () => (await chip.count()) === 0 || !(await panel2.getByTestId("room-project-item").filter({ hasText: p4.title }).count()), 10000, "停下后进行中列表里没有它");
	await page.keyboard.press("Escape");
	await page.getByText(/项目「整理一份小结（慢）」已停下，进度保留/).first().waitFor();
	await wait(async () => (await j("/api/agents")).find((a) => a.id === agent.id)?.status !== "running", 15000, "助理手上的活停下");
	assert.ok(!(await messages()).some((m) => m.meta?.kind === "project-delivery" && m.meta.projectId === p4.id), "停下的项目没有交付卡");
	assert.equal((await projects(false)).length, 0, "没有待确认 / 进行中的项目");

	console.log("[7] 旧的群聊 room-goal 卡片在历史里只读显示（没有输入框和按钮）");
	const room = await j("/api/rooms", "POST", { name: "旧卡片群", memberIds: [agent.id], managerId: agent.id });
	const sqlite = new DatabaseSync(join(run.data, "data.db"));
	sqlite.exec("PRAGMA busy_timeout = 5000");
	const t = Date.now();
	sqlite.prepare("INSERT INTO messages(id, agent_id, conversation_id, role, content, meta, status, created_at, updated_at, room_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run("m_legacy_goal", agent.id, null, "card", "", JSON.stringify({ kind: "room-goal", roomId: room.id, status: "pending", goal: "把官网改版上线", doneCriteria: "新页面能正常访问" }), "done", t, t, room.id);
	sqlite.close();
	const reqs = [];
	page.on("request", (r) => reqs.push(`${r.method()} ${new URL(r.url()).pathname}`));
	await page.goto(`${base}/?room=${room.id}`);
	const goal = page.getByTestId("room-goal");
	await goal.waitFor();
	assert.equal(await goal.getByTestId("room-goal-goal").textContent(), "把官网改版上线");
	assert.equal(await goal.getByTestId("room-goal-done").textContent(), "新页面能正常访问");
	assert.equal(await goal.locator("textarea, button, input").count(), 0, "旧卡片只读：没有输入框和按钮");
	assert.match(await goal.textContent(), /已经不能再确认/);
	assert.ok(!reqs.some((r) => /\/api\/proposals\//.test(r)), "不调旧接口");
	await stableShot(page, goal, join(out, "05-legacy-goal-card.png"));

	assert.equal(errors.length, 0, errors.join(" | "));
	console.log("PASS chat-plan: 小事直接做、单聊出方案卡（假设区、390 不越框）、点按钮确认 / 说「可以」确认、阶段进度两条、交付卡（文件可预览、不谈花费）、先不做、慢速项目 chip+面板+中途停下、旧 room-goal 卡片只读");
} catch (e) {
	console.error("CHAT PLAN FAIL", e.message);
	await page?.screenshot({ path: join(out, "fail.png") }).catch(() => {});
	if (agent) console.error("messages", JSON.stringify((await j(`/api/agents/${agent.id}/messages`).catch(() => [])).slice(-12).map((m) => [m.role, m.meta?.kind ?? m.meta?.toolName, String(m.content ?? "").slice(0, 120)])));
	if (agent) {
		const cid = (await j(`/api/agents/${agent.id}/conversations`).catch(() => ({}))).current;
		console.error("projects", JSON.stringify((await j(`/api/conversations/${cid}/projects?all=1`).catch(() => ({ projects: [] }))).projects.map((p) => [p.id, p.title, p.status])));
		console.error("timeline", JSON.stringify((await j(`/api/agents/${agent.id}/messages`).catch(() => [])).filter((m) => m.role === "user" || m.role === "card" || m.role === "system").map((m) => [m.role, m.meta?.kind, String(m.content ?? "").slice(0, 40), m.meta?.projectId, m.meta?.status])));
	}
	if (process.env.WORK_DEBUG) console.error(server.logs?.().slice(-6000));
	throw e;
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
