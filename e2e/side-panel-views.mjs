/**
 * 聊天里的查看类面板进侧栏（docs/design/side-panel-views.md）：真实服务 / 真实 PiMock / 真实构建页面。
 *
 * 覆盖：桌面宽窗口里「执行概览 / 任务看板（含详情）/ 项目 / 提醒」都在聊天右边的侧栏打开（聊天区仍可见）；
 * 同一时间只有一个（新的打开会关掉旧的，打开文件也一样）；「放大」变大窗口、Esc 关闭；侧栏里 Esc / × 关闭；
 * 390 窄屏这四个仍是弹窗。文件预览自身的侧栏行为见 file-preview.mjs（共用同一套 SidePanel）。
 * 运行前先构建：npm run build -w @pi-assistant/web；然后 node e2e/side-panel-views.mjs（截图写 artifacts/screenshots/side-panel-views/）。
 * 全程临时 DATA/WORKSPACE/HOME/TMPDIR + 内存凭据 + loopback Mock，不碰生产库 / 凭据 / 付费模型。
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { seedSubagent } from "./fixtures/seed-subagent.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-side-views-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run, log: process.env.WORK_DEBUG ? (d) => process.stdout.write(d) : undefined });
const out = process.env.SHOT_DIR ?? join(artifactDir("screenshots"), "side-panel-views");
mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch {} if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${t.slice(0, 300)}`); return d; };
const wait = async (fn, ms = 30000, label = "condition") => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`${label} timed out`); };
let browser;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok, 30000, "server");
	await j("/api/settings", "PUT", { onboarded: true });
	await j("/api/models/default", "PUT", { provider: "mock", model: "echo" }).catch(() => {});
	const agent = await j("/api/agents", "POST", { name: "侧栏助理", model: { provider: "mock", id: "echo" } });
	const member = await j("/api/agents", "POST", { name: "甲", model: { provider: "mock", id: "echo" } });
	const room = await j("/api/rooms", "POST", { name: "侧栏群", memberIds: [agent.id, member.id], managerId: agent.id });
	const conv = (await j(`/api/agents/${agent.id}/conversations`)).current;
	seedSubagent(run, { id: "sv-sub-1", agentId: agent.id, conversationId: conv, provider: "mock", modelId: "echo", task: "侧栏验证帮手", status: "done" });
	await j(`/api/rooms/${room.id}/work-items`, "POST", { title: "侧栏验证任务", requirement: "看详情是否在侧栏", ownerAgentId: member.id, start: false });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const docked = (id) => page.locator(`[data-testid=${id}][data-docked]`).count();
	const modals = () => page.locator(".pa-modal").count();
	const box = (sel) => page.locator(sel).first().boundingBox();
	const gone = (id) => page.locator(`[data-testid=${id}]`).waitFor({ state: "detached", timeout: 5000 });
	/** 面板在聊天区右边、贴右缘、聊天区仍可见且 ≥ 520 */
	const checkDocked = async (id, label) => {
		assert.equal(await docked(id), 1, `${label} 在侧栏（带 data-docked）`);
		assert.equal(await modals(), 0, `${label} 不是弹窗`);
		const pb = await box(`[data-testid=${id}]`);
		const cb = await box("[data-testid=main-conversation]");
		assert.ok(pb.x >= cb.x + cb.width - 2 && Math.abs(pb.x + pb.width - 1440) <= 3, `${label} 在聊天区右边、贴右缘 ${JSON.stringify({ pb, cb })}`);
		assert.ok(cb.width >= 520 && (await page.locator("[data-testid=main-conversation]").isVisible()), `${label} 聊天区仍可见且宽度 ≥ 520（${cb.width}）`);
	};

	// ---- 单聊：执行概览 / 项目 / 提醒
	await page.goto(`${base}/?agent=${agent.id}`);
	const ta = page.locator("[data-testid=main-conversation] textarea:visible:not(.pa-card textarea)");
	await ta.waitFor();
	console.log("[1] 执行概览在侧栏");
	await page.getByTestId("subagent-tasks").waitFor({ timeout: 30000 });
	await page.getByTestId("subagent-tasks").click();
	await page.getByTestId("task-overview").waitFor();
	await checkDocked("task-overview", "执行概览");
	assert.equal(await page.getByTestId("task-overview").getByTestId("subagent-row").count(), 1, "执行概览里有帮手");
	await stableShot(page, page.locator("body"), join(out, "01-overview-docked.png"));

	console.log("[2] 提醒（收件箱）替换执行概览：同一时间只有一个");
	await page.getByTestId("inbox-button").click();
	await page.getByTestId("inbox").waitFor();
	await gone("task-overview");
	assert.equal(await page.locator("[data-docked] [data-testid=inbox]").count(), 1, "提醒在侧栏里");
	assert.equal(await modals(), 0, "提醒不是弹窗");
	assert.equal(await page.locator("[data-docked]").count(), 1, "侧栏里只有一个面板");
	await page.keyboard.press("Escape");
	await gone("inbox");

	console.log("[3] 项目在侧栏；打开文件会替换它");
	const idle = () => wait(async () => (await j("/api/agents")).find((a) => a.id === agent.id)?.status !== "running", 30000, "助理空闲");
	await idle();
	await ta.fill("做个大事");
	await ta.press("Enter");
	const chip = page.getByTestId("room-projects-chip");
	await chip.waitFor({ timeout: 30000 });
	await chip.click();
	await page.getByTestId("room-projects-panel").waitFor();
	await checkDocked("room-projects-panel", "项目");
	// 确认方案 → 交付卡里的文件；先重新打开提醒，再点文件，验证文件预览替换提醒
	await page.keyboard.press("Escape");
	await gone("room-projects-panel");
	await page.getByTestId("room-plan-confirm").first().click();
	await page.locator('[aria-label^="预览 "]').first().waitFor({ timeout: 60000 });
	await page.getByTestId("inbox-button").click();
	await page.getByTestId("inbox").waitFor();
	await page.locator('[aria-label^="预览 "]').first().click();
	await page.getByTestId("file-preview").waitFor();
	await gone("inbox");
	await checkDocked("file-preview", "文件预览");
	await page.getByTestId("file-preview-close").click();
	await gone("file-preview");

	console.log("[4] 「放大」变大窗口、Esc 关闭；× 关闭侧栏");
	await page.getByTestId("subagent-tasks").click();
	await page.getByTestId("task-overview").waitFor();
	await page.getByTestId("side-panel-expand").click();
	await page.locator(".pa-modal[data-testid=task-overview]").waitFor();
	assert.equal(await docked("task-overview"), 0, "放大后侧栏收起");
	assert.equal(await page.getByTestId("side-panel-expand").count(), 0, "大窗口里没有「放大」");
	assert.equal(await page.getByTestId("task-overview").getByTestId("subagent-row").count(), 1, "大窗口里是同一份内容");
	await stableShot(page, page.locator("body"), join(out, "03-overview-expanded.png"));
	await page.keyboard.press("Escape");
	await gone("task-overview");
	await page.getByTestId("subagent-tasks").click();
	await page.getByTestId("task-overview").waitFor();
	await page.getByTestId("side-panel-close").click();
	await gone("task-overview");

	// ---- 群：任务看板含详情
	console.log("[5] 群任务看板（含点进详情）在侧栏");
	await page.goto(`${base}/?room=${room.id}`);
	await page.getByTestId("room-work-items").waitFor();
	await page.getByTestId("room-work-items").click();
	await page.getByTestId("work-board").waitFor();
	await checkDocked("work-items-overview", "任务看板");
	await page.getByTestId("work-item-row").first().click();
	await page.getByTestId("work-detail").waitFor();
	await checkDocked("work-items-overview", "任务详情");
	assert.match(await page.getByTestId("work-items-overview").innerText(), /任务详情/);
	assert.match(await page.getByTestId("work-detail-title").innerText(), /侧栏验证任务/);
	await stableShot(page, page.locator("body"), join(out, "02-task-detail-docked.png"));
	await page.getByTestId("work-detail-back").click();
	await page.getByTestId("work-board").waitFor();
	await page.keyboard.press("Escape");
	await gone("work-items-overview");

	// ---- 390 窄屏：四个仍是弹窗
	console.log("[6] 390 窄屏：四个面板仍是弹窗");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await page.getByTestId("room-work-items").waitFor();
	await page.getByTestId("room-work-items").click();
	await page.locator(".pa-modal [data-testid=work-board]").waitFor();
	assert.equal(await page.locator("[data-docked]").count(), 0, "任务看板在窄屏不是侧栏");
	await page.getByTestId("work-item-row").first().click();
	await page.locator(".pa-modal [data-testid=work-detail]").waitFor();
	await page.keyboard.press("Escape");
	await page.locator(".pa-modal").waitFor({ state: "detached" });
	await page.goto(`${base}/?agent=${agent.id}`);
	await page.getByTestId("subagent-tasks").waitFor({ timeout: 30000 });
	await page.getByTestId("subagent-tasks").click();
	await page.locator(".pa-modal[data-testid=task-overview]").waitFor();
	assert.equal(await page.locator("[data-docked]").count(), 0, "执行概览在窄屏不是侧栏");
	assert.equal(await page.getByTestId("side-panel-expand").count(), 0, "窄屏弹窗没有「放大」");
	await page.keyboard.press("Escape");
	await page.locator(".pa-modal").waitFor({ state: "detached" });
	if (await page.getByTestId("room-projects-chip").count()) {
		await page.getByTestId("room-projects-chip").click();
		await page.locator(".pa-modal[data-testid=room-projects-panel]").waitFor();
		await page.keyboard.press("Escape");
		await page.locator(".pa-modal").waitFor({ state: "detached" });
	}
	await page.getByTestId("inbox-button").click().catch(async () => { await page.getByRole("button", { name: "打开助理列表" }).click().catch(() => {}); await page.getByTestId("inbox-button").click(); });
	await page.locator(".pa-modal [data-testid=inbox]").waitFor();
	assert.equal(await page.locator("[data-docked]").count(), 0, "提醒在窄屏不是侧栏");
	assert.deepEqual(errors, [], "控制台无报错");
	console.log("side-panel-views 全部通过");
} finally {
	await browser?.close();
	await server.stop();
	cleanupTempRun(run);
}
