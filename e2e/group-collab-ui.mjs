/**
 * 群协作（决策 0006 / 0019）：真实服务 / 真实 PiMock / 真实构建页面。
 *
 * 覆盖：
 *  1) 立项：用户说「立项：…」→ 管理者 room_plan 出方案卡（假设区可见、卡片有内边距不溢出、390 不越框），顶部出现项目 chip（待确认）；
 *  2) 点「就这么干」→ 卡片已确认、chip 进行中、群里有 started 告知；按方案阶段自动建两个任务，第一个完成后第二个自动开始交接，
 *     chip 显示「阶段 n/m」；项目面板看到两阶段进度清单；任务详情看到交接说明 / 成果文件、前置任务与阶段；
 *     打开项目面板看到方案 → 停下项目（确认框）→ chip 消失 → 已结束列表里点「接着做」恢复（chip 和进度清单回来）→ 再停下还原；
 *  3) 另起一个方案点「先不做」→ 卡片先不做；再起一个在群里打字「可以」→ 管理者 room_project_start 确认；面板里能展开已结束的项目；
 *  4) 任务在负责人自己的会话里执行：正常任务提交 → 管理者被唤醒核验完成；成员报卡点 → 「卡住」；
 *     管理者判断需要用户拍板 → 「等你决定」高亮置顶，用户在看板上直接回答，决定发回群里；
 *  5) 看板四组（等你决定 / 卡住 / 进行中 / 已完成·已停止折叠）+ 390px；
 *  6) 停群不停任务：停群后正在执行的任务继续跑，看板「全部暂停」才停；
 *  7) 看板上用户直接核验「这条路走不通」→ 任务受阻，不自动重做；
 *  8) 成员直接协作（决策 0019 第 4 步）：干活中途问同事（群里「提问」「回答」成组、可跳回）、任务详情「在等同事回答」、上游有问题 → 上游重做 → 下游拿新版本。
 *  9) 第 5 步：阶段完成通知、关键点卡片（chip 等你看一眼 + 面板琥珀框 + 点选项继续）、交付卡（文件可预览，390 不溢出）、两个进行中项目时的按项目筛选和项目标签。
 *
 * 全程临时 DATA/WORKSPACE/HOME/TMPDIR + 内存凭据 + loopback Mock，不碰生产库 / 凭据 / 付费模型。
 *
 * Mock 行为说明（packages/server/src/pi-adapter/mock-room-provider.ts）：方案确认后按分工阶段自动建任务，
 * 只有「用户按钮确认」（走 /confirm，带着「把第一批任务派给对口成员」的唤醒原因）才会在同一次唤醒里把两个阶段都建出来；
 * 群里打字「可以」（管理者自己调 room_project_start）不触发这段唤醒文案，所以不会自动建任务——这是 Mock 的真实行为，
 * 不是本脚本的假设，已用临时探测脚本跑过确认。两段测试分别用 p1（按钮确认）和 p3（打字确认）覆盖，互不冲突。
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
	// 群里还有管理者在说话（比如上一个项目刚交付、兜底唤醒）时用户发话会被当成插话塞进那一回合，Mock 不认插话就不会出方案卡：发话前先等群安静。
	const quiet = (ms = 30000) => wait(async () => !(await roomNow()).state?.running, ms, "room quiet").catch(() => {});
	const proposeNew = async (text) => {
		await quiet();
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
	// chip 一旦有进度清单就显示「阶段 n/m」，不再是「进行中」字样；按钮确认这条路自动建任务很快，这里只认 chip 里有这个项目
	await chip.filter({ hasText: p1.title }).waitFor();
	assert.equal((await roomNow()).projects.find((p) => p.id === p1.id)?.status, "active");
	await wait(() => started(p1.id), 10000, "started notice");
	await page.getByText(/方案已确认，项目「/).first().waitFor();
	await stableShot(page, c1, join(out, "02-plan-confirmed.png"));

	console.log("[2b] 按钮确认后按方案自动建两阶段任务；第一阶段完成后第二阶段自动开始，chip 显示「阶段 n/m」");
	await chip.filter({ hasText: p1.title }).filter({ hasText: "阶段 2/2" }).waitFor({ timeout: 30000 });
	const p1Stages = (await allProjects()).find((p) => p.id === p1.id).plan.stages;
	assert.equal(p1Stages.length, 2, "方案两个阶段");

	console.log("[2c] 任务详情能看到交接说明 / 成果文件（第一阶段）与前置任务 / 阶段（第二阶段）");
	// 阶段名字本身很短（准备 / 完成），进度摘要里常常也带着这几个字，不能用整行文字模糊匹配；只认任务名字（<b>）精确等于阶段名的那一行。
	const rowByTitle = (name) => page.locator(`[data-testid="work-item-row"]:has(b:text-is("${name}"))`);
	await page.getByTestId("room-work-items").click();
	const closedToggle = page.getByTestId("work-closed");
	// 两个阶段任务很快就核验通过变成「已完成」，默认折叠在这里面；先等列表真正加载完，再决定要不要展开。
	await closedToggle.waitFor({ timeout: 10000 }).catch(() => {});
	if (await closedToggle.count()) await closedToggle.locator("summary").click();
	const stage1Row = rowByTitle(p1Stages[0].name);
	await stage1Row.waitFor();
	await stage1Row.click();
	await page.getByTestId("work-detail").getByText(`阶段：${p1Stages[0].name}`).waitFor();
	await page.getByTestId("work-run-files").waitFor();
	await page.getByTestId("work-run-file").filter({ hasText: "out.txt" }).waitFor();
	await page.getByText(/交接：/).first().waitFor();
	await stableShot(page, page.getByTestId("work-detail"), join(out, "02d-handoff-files.png"));
	await page.getByTestId("work-detail-back").click();
	// 第二阶段核验可能还没完成（还在「待核验」），不管哪种状态都要能按名字精确找到那一行，重新展开折叠。
	if (await closedToggle.count()) await closedToggle.locator("summary").click().catch(() => {});
	const stage2Row = rowByTitle(p1Stages[1].name);
	await stage2Row.waitFor();
	await stage2Row.click();
	await page.getByTestId("work-detail").getByText(`阶段：${p1Stages[1].name}`).waitFor();
	const depends = page.getByTestId("work-detail-depends");
	await depends.waitFor();
	await depends.getByText(p1Stages[0].name).first().waitFor();
	await stableShot(page, page.getByTestId("work-detail"), join(out, "02e-depends-on.png"));
	await page.getByTestId("work-detail-back").click();
	await page.keyboard.press("Escape");

	console.log("[3] 项目面板看方案 + 两阶段进度清单 → 停下项目（确认框）→ chip 消失");
	await chip.click();
	const panel = page.getByTestId("room-projects-panel");
	const item = panel.getByTestId("room-project-item").filter({ hasText: p1.title });
	await item.getByText(p1.plan.goal).first().waitFor();
	await item.getByText(p1.plan.doneCriteria).first().waitFor();
	const progress1 = item.getByTestId("room-project-progress");
	await progress1.waitFor();
	await progress1.getByText(p1Stages[0].name).first().waitFor();
	await progress1.getByText(p1Stages[1].name).first().waitFor();
	assert.ok((await progress1.getByTestId("room-progress-item").count()) >= 2, "进度清单里两个阶段各有一条任务");
	await stableShot(page, panel, join(out, "03-projects-panel.png"));
	await page.setViewportSize({ width: 390, height: 844 });
	await panel.scrollIntoViewIfNeeded();
	await stableShot(page, panel, join(out, "03b-projects-panel-390.png"));
	await page.setViewportSize({ width: 1440, height: 1000 });
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
	// 打字「可以」和点按钮一样：管理者在同一回合里确认项目、按方案把两个阶段的任务都建出来（Mock 不再依赖系统提示里有没有阶段行，见 mock-room-provider.ts），
	// chip 显示「阶段 n/2」，两个阶段都建出来；以前这里放宽成「进行中 / 阶段 n/m / 已完成」三选一，就是因为 Mock 偶尔只建 0 或 1 个。
	await chip.filter({ hasText: p3.title }).filter({ hasText: "阶段 2/2" }).waitFor({ timeout: 30000 });
	const p3Items = (await j(`/api/rooms/${room.id}/work-items`)).items.filter((x) => x.projectId === p3.id);
	assert.deepEqual(p3Items.map((x) => x.stage).sort(), ["准备", "完成"].sort(), "打字确认也把方案两个阶段的任务都建出来");
	await chip.click();
	await page.getByTestId("room-projects-ended-toggle").click();
	await panel.getByText(p1.title).first().waitFor();
	await panel.getByText(p2.title).first().waitFor();
	await stableShot(page, panel, join(out, "05-projects-ended.png"));

	console.log("[5b] 已结束列表里停下的项目点「接着做」→ 恢复进行中、chip 回来 → 再停下还原");
	const endedP1 = panel.getByTestId("room-project-ended-item").filter({ hasText: p1.title });
	await endedP1.getByTestId("room-project-resume").click();
	await wait(async () => (await allProjects()).find((p) => p.id === p1.id)?.status === "active", 10000, "p1 resumed");
	// 这时 p1、p3 都在进行中，顶部 chip 显示「项目 2」（不再是单项目的名字 + 阶段）；用项目面板确认 p1 真的恢复了。
	await chip.waitFor();
	await item.getByTestId("room-project-progress").waitFor();
	await stableShot(page, panel, join(out, "05b-project-resumed.png"));
	await item.getByTestId("room-project-stop").click();
	await page.getByTestId("confirm-ok").click();
	await wait(async () => (await allProjects()).find((p) => p.id === p1.id)?.status === "stopped", 10000, "p1 re-stopped");
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

	console.log("[8b] 成员干活中途问同事：群里出现「提问」「回答」两条，看得出是一组，回答点了回到提问；提问者拿到回答后提交");
	// 前面留下的卡住 / 拍板任务会让 Mock 管理者每次被叫醒都先处理它们；这一步只看成员互问，先把它们收掉
	for (const x of [stuck, ask]) await j(`/api/work-items/${x.item.id}/cancel`, "POST", {});
	const MOCK_ANSWER = "按第一版口径来，数据以内部表为准";
	const askItem = await j(`/api/rooms/${room.id}/work-items`, "POST", { title: "整理口径说明", requirement: "整理可核验的结果，动手前先问一下同事口径", doneCriteria: "结果有第 3 行检查点", ownerAgentId: worker.id, start: true });
	let askMsg, ansMsg;
	await wait(async () => {
		const ms = await messages();
		askMsg = ms.find((m) => m.meta?.kind === "peer-ask");
		ansMsg = askMsg && ms.find((m) => m.meta?.kind === "peer-answer" && m.meta.askId === askMsg.meta.askId);
		return !!ansMsg;
	}, 45000, "peer ask + answer in room");
	assert.equal(askMsg.agent_id, worker.id, "提问者是干活的成员");
	assert.equal(askMsg.meta.to, helper.id, "问的是管理者以外的另一位成员");
	assert.equal(askMsg.meta.toName, "乙");
	assert.equal(askMsg.meta.rounds, 1);
	assert.equal(ansMsg.agent_id, helper.id, "回答者是被问的成员");
	assert.equal(ansMsg.meta.rounds, 1, "问和答同一轮同一个数");
	assert.ok(ansMsg.content.includes(MOCK_ANSWER));
	const askBox = page.locator(`[data-testid=peer-msg][data-peer=ask][data-ask-id="${askMsg.meta.askId}"]`);
	const ansBox = page.locator(`[data-testid=peer-msg][data-peer=answer][data-ask-id="${askMsg.meta.askId}"]`);
	await askBox.waitFor();
	await ansBox.waitFor();
	assert.equal((await askBox.getByTestId("peer-tag").textContent()).trim(), "提问 · 第 1 轮");
	assert.equal((await askBox.getByTestId("peer-to").textContent()).trim(), "问 @乙");
	assert.equal(((await askBox.innerText()).match(/@乙/g) ?? []).length, 1, "提问气泡里「@乙」只出现一次：上面的「问 @乙」已经写了，正文开头不再重复");
	assert.ok(askMsg.content.startsWith("@乙"), "存储的消息不变，只是显示时去掉开头的 @乙");
	assert.equal((await ansBox.getByTestId("peer-tag").textContent()).trim(), "回答 · 第 1 轮");
	await ansBox.getByTestId("peer-ref").getByText("回复 甲 的提问").waitFor();
	await ansBox.scrollIntoViewIfNeeded();
	await ansBox.getByTestId("peer-ref").click();
	await wait(async () => {
		const b = await page.locator(`[data-mid="${askMsg.id}"]`).first().boundingBox();
		return !!b && b.y >= 0 && b.y + b.height <= 1000;
	}, 10000, "点回答里的回指后提问在可视范围内");
	assert.equal(await page.getByTestId("quote-jump-state").count(), 0, "定位成功不留失败提示");
	// 被问的人用 answer_colleague 回答之后，回合结尾那句「已回答。」不再发到群里
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal((await messages()).filter((m) => m.agent_id === helper.id && m.role === "assistant" && /^已回答。?$/.test((m.content ?? "").trim())).length, 0, "回答完不再多发一句「已回答。」");
	await stableShot(page, askBox, join(out, "11-peer-ask.png"));
	await stableShot(page, ansBox, join(out, "11-peer-answer.png"));
	await wait(async () => (await detail(askItem.item.id)).item.status === "done", 60000, "提问者拿到回答后提交、管理者核验完成");
	const askDone = await detail(askItem.item.id);
	assert.ok(JSON.stringify(askDone.runs).includes(MOCK_ANSWER), "提交结果里带回了同事的回答");
	assert.equal((askDone.asks ?? []).filter((a) => a.status === "open").length, 0, "回答后没有还在等的提问");
	// 手机宽度：两条互问消息不溢出
	await page.setViewportSize({ width: 390, height: 844 });
	await ansBox.scrollIntoViewIfNeeded();
	for (const loc of [askBox, ansBox]) {
		const b = await loc.boundingBox();
		assert.ok(b.x >= -1 && b.x + b.width <= 391, "互问消息 390 不越框");
	}
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "390 页面没有横向滚动");
	await stableShot(page, ansBox, join(out, "11b-peer-answer-390.png"));

	console.log("[8c] 任务详情「在等同事回答」：真实数据里提问已答完所以不显示；用一份带未答提问的响应检查它的样子（桌面 + 390）");
	await page.setViewportSize({ width: 1440, height: 1000 });
	const openAsk = { id: "ask_e2e", to: helper.id, toName: "乙", from: worker.id, fromName: "甲", kind: "question", status: "open", rounds: 1, question: "这份交付的数据口径按哪个版本来？", updatedAt: Date.now() };
	const openWork = async () => {
		await page.getByTestId("room-work-items").click();
		const toggle = page.getByTestId("work-closed");
		await toggle.waitFor({ timeout: 10000 }).catch(() => {});
		if (await toggle.count() && !(await toggle.evaluate((e) => e.open))) await toggle.locator("summary").click();
		await page.getByTestId("work-item-row").filter({ hasText: "整理口径说明" }).click();
		await page.getByTestId("work-detail").waitFor();
	};
	await openWork();
	assert.equal(await page.getByTestId("work-asks").count(), 0, "提问都答完了，不显示「在等同事回答」");
	await page.getByTestId("work-detail-back").click();
	await page.keyboard.press("Escape");
	const injectAsks = (asks) => page.route(`**/api/work-items/${askItem.item.id}`, async (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		const res = await route.fetch();
		await route.fulfill({ response: res, json: { ...(await res.json()), asks } });
	});
	await injectAsks([openAsk, { ...openAsk, id: "ask_e2e2", kind: "upstream", status: "escalated", rounds: 3, question: "上游的第 3 行检查点没有来源" }]);
	await openWork();
	const waiting = page.getByTestId("work-asks");
	await waiting.waitFor();
	assert.equal(await waiting.getByTestId("work-ask").count(), 2);
	await waiting.getByText("甲 在等 乙 回答").waitFor();
	await waiting.getByText("已交给管理者").waitFor();
	await stableShot(page, page.getByTestId("work-detail"), join(out, "12-work-asks.png"));
	await page.setViewportSize({ width: 390, height: 844 });
	const wb = await waiting.boundingBox();
	assert.ok(wb.x >= -1 && wb.x + wb.width <= 391, "「在等同事回答」390 不越框");
	await stableShot(page, waiting, join(out, "12b-work-asks-390.png"));
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.unroute(`**/api/work-items/${askItem.item.id}`);
	await page.getByTestId("work-detail-back").click();
	await page.keyboard.press("Escape");

	console.log("[8d] 上游有问题：下游成员反馈前置任务 → 群里看到上游提问 → 上游重做后重新通过 → 下游拿到新版本并提交");
	const seen = new Set((await j(`/api/rooms/${room.id}/work-items`)).items.map((x) => x.id));
	const p4 = await proposeNew("立项：整理一份对账说明");
	await card(p4.id).getByTestId("room-plan-confirm").click();
	let up, down;
	await wait(async () => {
		const items = (await j(`/api/rooms/${room.id}/work-items`)).items.filter((x) => !seen.has(x.id));
		up = items.find((x) => x.stage === "准备");
		down = items.find((x) => x.stage === "完成");
		return !!up && !!down;
	}, 30000, "方案两阶段任务建出来");
	assert.equal(down.status, "pending", "第二阶段还在等前置，这时改它的要求和负责人");
	assert.equal(up.ownerAgentId, worker.id, "第一阶段交给甲");
	await j(`/api/work-items/${down.id}`, "PATCH", { requirement: "明确最终交付物。上游有问题", ownerAgentId: helper.id });
	let upAsk, upAns;
	await wait(async () => {
		const ms = await messages();
		upAsk = ms.find((m) => m.meta?.kind === "peer-ask" && m.meta.upstream);
		return !!upAsk;
	}, 90000, "下游向上游反馈");
	assert.equal(upAsk.agent_id, helper.id, "反馈的是下游负责人");
	assert.equal(upAsk.meta.to, worker.id, "反馈给上游负责人");
	await page.locator(`[data-testid=peer-msg][data-peer=ask][data-ask-id="${upAsk.meta.askId}"]`).waitFor();
	assert.ok(upAsk.content.startsWith("@甲"), "上游反馈同样先写 @甲（存储不变）");
	await wait(async () => {
		upAns = (await messages()).find((m) => m.meta?.kind === "peer-answer" && m.meta.askId === upAsk.meta.askId);
		return !!upAns || (await detail(up.id)).item.revision >= 2;
	}, 60000, "上游负责人处理（重做）");
	await wait(async () => {
		const u = await detail(up.id);
		return u.item.revision >= 2 && u.item.status === "done" && u.events.filter((e) => e.kind === "verified.pass").length >= 2;
	}, 90000, "上游重做后重新通过核验");
	await wait(async () => (await detail(down.id)).item.status === "done", 90000, "下游拿到新版本后提交并通过");
	assert.equal((await messages()).filter((m) => m.agent_id === worker.id && m.role === "assistant" && /已重开任务，马上重做/.test(m.content ?? "")).length, 0, "上游用 work_rework 重做之后，回合结尾那句「已重开任务，马上重做」不再发到群里");
	const downDone = await detail(down.id);
	assert.ok(JSON.stringify(downDone.runs).includes("已按上游的新版本更新"), "下游提交结果里带着“用了上游新版本”");
	await page.locator(`[data-testid=peer-msg][data-ask-id="${upAsk.meta.askId}"]`).first().scrollIntoViewIfNeeded();
	await stableShot(page, page.locator(`[data-testid=peer-msg][data-peer=ask][data-ask-id="${upAsk.meta.askId}"]`), join(out, "13-upstream-ask.png"));

	console.log("[G1] 阶段完成通知：没带关键点的项目（p1）第一阶段做完后，管理者在群里说进度");
	const stageNotice = (await messages()).find((m) => m.agent_id === manager.id && /阶段「准备」做完了/.test(m.content ?? ""));
	assert.ok(stageNotice, "管理者发了阶段完成的进度通知");

	console.log("[G2] 含「关键点」「交付卡」的立项：第一阶段完成后出关键点卡片（chip 等你看一眼、面板琥珀框），点「可以，继续」后继续，最后出交付卡");
	const p5 = await proposeNew("立项：整理对外说明，要有关键点和交付卡");
	await card(p5.id).getByTestId("room-plan-confirm").click();
	// 方案有关键点：第一阶段完成后，第二阶段任务先暂缓（pending），等用户答复后管理者回合结束才自动开始
	const stageTwo = async () => (await j(`/api/rooms/${room.id}/work-items`)).items.find((x) => x.projectId === p5.id && x.stage === "完成");
	await wait(stageTwo, 60000, "第二阶段任务建出来");
	let cpWait;
	await wait(async () => (cpWait = (await roomNow()).projects?.find((p) => p.id === p5.id)?.waiting), 120000, "项目出现 waiting（关键点）");
	assert.ok(cpWait.checkpoint && cpWait.message, "waiting 带关键点和说明");
	assert.equal((await stageTwo()).status, "pending", "关键点卡片出现时第二阶段任务没有开始（暂缓）");
	assert.deepEqual(cpWait.options, ["可以，继续", "要改"]);
	const cpMsg = (await messages()).find((m) => m.role === "card" && m.meta?.kind === "question" && m.meta.checkpoint);
	assert.equal(cpMsg?.meta.projectId, p5.id, "关键点卡片带 projectId");
	await chip.filter({ hasText: "等你看一眼" }).waitFor();
	assert.equal(await chip.getAttribute("data-waiting"), "1");
	const cpCard = page.locator(".pa-question").filter({ hasText: "关键点：" }).last();
	await cpCard.scrollIntoViewIfNeeded();
	await stableShot(page, cpCard, join(out, "20-checkpoint-card.png"));
	await chip.click();
	const waitBox = page.getByTestId("room-project-waiting");
	await waitBox.waitFor();
	await waitBox.getByText(cpWait.checkpoint).first().waitFor();
	assert.ok((await waitBox.textContent()).includes(cpWait.message), "面板里显示关键点说明");
	await waitBox.scrollIntoViewIfNeeded();
	await stableShot(page, waitBox.locator("xpath=ancestor::*[@data-testid='room-project-item'][1]"), join(out, "21-project-waiting-panel.png"));
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 390, height: 844 });
	assert.ok(await chip.isVisible(), "390 下 chip 还在（只留图标和小圆点）");
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391), "390 页面没有横向溢出");
	await page.setViewportSize({ width: 1440, height: 1000 });
	await cpCard.getByRole("button", { name: "可以，继续" }).click();
	await wait(async () => !(await roomNow()).projects?.find((p) => p.id === p5.id)?.waiting, 10000, "答复后 waiting 清掉");
	assert.ok((await messages()).some((m) => m.role === "user" && /关于关键点「.*」：可以，继续/.test(m.content)), "答复以用户身份发到群里");
	await wait(async () => (await stageTwo()).status !== "pending", 60000, "答复后第二阶段任务自动开始");
	const deliv = page.locator(`[data-testid=project-delivery][data-project="${p5.id}"]`);
	let dm;
	await wait(async () => (dm = (await messages()).find((m) => m.meta?.kind === "project-delivery" && m.meta.projectId === p5.id)), 120000, "交付卡消息");
	assert.ok(dm.meta.summary && dm.meta.howToUse && dm.meta.notDone, "交付卡有做成了什么 / 怎么用 / 还没做的");
	assert.ok(dm.meta.files.some((f) => f.name === "out.txt" && f.fileId), "交付卡带上 out.txt");
	await deliv.waitFor();
	await deliv.scrollIntoViewIfNeeded();
	assert.ok((await deliv.getByText("交付：").first().textContent()).includes(p5.title), "标题是交付：项目名");
	assert.ok(!/花费|费用|¥|\$/.test(await deliv.textContent()), "交付卡不谈花费");
	await noOverflow(deliv, "交付卡");
	await deliv.getByTestId("delivery-howto").waitFor();
	await deliv.getByTestId("delivery-notdone").waitFor();
	await stableShot(page, deliv, join(out, "22-delivery-card.png"));
	await deliv.getByTestId("file-preview-open").first().click();
	await page.getByTestId("file-preview-name").filter({ hasText: "out.txt" }).waitFor();
	await page.getByTestId("file-preview-close").click();
	await page.setViewportSize({ width: 390, height: 844 });
	await deliv.scrollIntoViewIfNeeded();
	const db = await deliv.boundingBox();
	assert.ok(db.x >= -1 && db.x + db.width <= 391, "交付卡 390 不越框");
	await noOverflow(deliv, "交付卡 390");
	await stableShot(page, deliv, join(out, "22b-delivery-card-390.png"));
	await page.setViewportSize({ width: 1440, height: 1000 });
	await wait(async () => (await allProjects()).find((p) => p.id === p5.id)?.status === "done", 10000, "项目交付后结束");

	console.log("[G3] 同时有两个进行中项目：顶部出现筛选，选一个项目后只剩它的消息（加用户消息）；气泡带项目名小标签");
	const pa = await proposeNew("立项：整理甲方案");
	const pb = await proposeNew("立项：整理乙方案");
	await card(pa.id).getByTestId("room-plan-confirm").click();
	await card(pb.id).getByTestId("room-plan-confirm").click();
	await wait(async () => (await roomNow()).projects.filter((p) => p.status === "active").length >= 2, 10000, "两个进行中项目");
	const filter = page.getByTestId("room-project-filter");
	await filter.waitFor();
	await wait(() => started(pa.id).then((a) => a && started(pb.id)), 20000, "两个项目都开始了");
	await page.getByTestId("project-tag").filter({ hasText: pa.title }).first().waitFor();
	await card(pa.id).waitFor();
	await card(pb.id).waitFor();
	await filter.click();
	await page.getByRole("option", { name: pa.title }).click();
	await wait(async () => (await card(pb.id).count()) === 0, 10000, "筛选后看不到另一个项目的消息");
	assert.equal(await card(pa.id).count(), 1, "选中项目的方案卡还在");
	await page.getByText("立项：整理乙方案").first().waitFor();
	assert.equal(await page.locator(`[data-testid=project-tag]`).filter({ hasText: pb.title }).count(), 0, "另一个项目的标签不出现");
	await stableShot(page, page.getByTestId("room-chat"), join(out, "23-project-filter.png"));
	await page.setViewportSize({ width: 390, height: 844 });
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391), "390 页面没有横向溢出");
	const head = page.locator("header.pa-chat-head");
	// 缩到 390 后侧边栏收起、顶部重新排版要一点时间：等筛选进屏再量，量不到就带上排版数据报错
	await wait(async () => { const b = await filter.boundingBox(); return b && b.x >= 0 && b.x + b.width <= 391; }, 5000, "390 排版稳定").catch(() => {});
	const fb = await filter.boundingBox();
	const headLayout = () => head.evaluate((h) => [...h.querySelectorAll(":scope > *, .pa-head-actions > *")].map((e) => `${e.className || e.tagName}:${Math.round(e.getBoundingClientRect().x)}+${Math.round(e.getBoundingClientRect().width)}`).join(" | "));
	assert.ok(fb.width >= 48, `390 下筛选没被挤扁：${JSON.stringify(fb)}`);
	assert.ok(fb.x >= 0 && fb.x + fb.width <= 391, `筛选在 390 屏内：${JSON.stringify(fb)} ${await headLayout()}`);
	assert.ok((await page.getByTestId("room-title").boundingBox()).width >= 40, "390 下群名仍看得到");
	// 顶部可能还在重新渲染（元素会被换掉），滑动和量位置都重试
	await wait(async () => { const b = page.getByTestId("room-settings-btn"); await b.scrollIntoViewIfNeeded({ timeout: 1000 }); const sb = await b.boundingBox(); return sb && sb.x >= 0 && sb.x + sb.width <= 391; }, 8000, "按钮多时群设置能滑到屏内");
	await page.locator(".pa-head-actions").evaluate((el) => el.scrollTo(0, 0));
	await stableShot(page, head, join(out, "23b-project-filter-390.png"));
	await page.setViewportSize({ width: 1440, height: 1000 });
	await filter.click();
	await page.getByRole("option", { name: "全部项目" }).click();
	await card(pb.id).waitFor();
	await card(pa.id).waitFor();

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

	console.log("[10] 看板上用户直接核验「这条路走不通」→ 任务受阻，不自动重做（群已停，管理者不会抢着核验）");
	const impossible = await create("待核验探针", worker.id, true);
	await wait(async () => (await detail(impossible.item.id)).item.status === "review", 30000, "impossible 探针进入待核验");
	// 上一步「全部暂停」之后任务看板一直开着：它的遮罩盖住了页面上的 chip，不能再点一次打开，直接在已开着的看板里操作。
	if (!(await page.getByTestId("work-items-overview").isVisible().catch(() => false))) await page.getByTestId("room-work-items").click();
	await page.getByTestId("work-filter-all").click();
	// 「待核验」映射到「进行中」组，默认不折叠，不用展开已完成 / 已停止
	await page.getByTestId("work-item-row").filter({ hasText: impossible.item.title }).click();
	await page.getByTestId("work-verify-note").fill("试过这个方向，根本拿不到数据源，方法本身走不通");
	await page.getByTestId("work-verify-impossible").click();
	await wait(async () => (await detail(impossible.item.id)).item.status === "blocked", 10000, "标为受阻");
	assert.match((await detail(impossible.item.id)).item.blocker ?? "", /^这条路走不通：/);
	await page.getByTestId("work-detail").getByText(/受阻：这条路走不通：/).waitFor();
	await stableShot(page, page.getByTestId("work-detail"), join(out, "10-verify-impossible.png"));
	await page.getByTestId("work-detail-back").click();

	assert.equal(errors.length, 0, errors.join(" | "));
	console.log("PASS group-collab: 立项出方案卡、按钮确认 / 先不做 / 群里说「可以」确认、项目 chip 与面板（看方案、停下、恢复、已结束）、两阶段进度清单+自动交接+chip 阶段、负责人会话执行+管理者唤醒核验、卡住/等你决定/直接拍板、四组看板+390、停群不停任务+全部暂停、看板「这条路走不通」、成员互问（提问/回答成组可跳回、在等同事回答、上游有问题→重做→下游新版本）");
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
