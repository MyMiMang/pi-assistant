/** 统一右栏入口、视图顺序与保留契约：真实 UI + 临时 Mock。 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { BIO_PLACEHOLDER, infoTab, openAgentModelPop } from "./fixtures/info-pane.mjs";
import { openCompact } from "./model-menu-flow.mjs";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-workspace-entries-");
const port = await new Promise((resolve) => {
	const socket = createServer().listen(0, "127.0.0.1", () => {
		const { port } = socket.address();
		socket.close(() => resolve(port));
	});
});
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
let browser;
try {
	const until = Date.now() + 20_000;
	while (!(await fetch(`${base}/api/system`).then((res) => res.ok, () => false))) {
		assert.ok(Date.now() < until, "临时 Mock 服务未就绪");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const json = async (path, method, body) => {
		const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.ok(res.ok, `${method} ${path}: ${res.status}`);
		return res.json();
	};
	await json("/api/settings", "PUT", { onboarded: true });
	const agent = await json("/api/agents", "POST", { name: "入口测试助理", model: { provider: "mock", id: "echo" } });
	const member = await json("/api/agents", "POST", { name: "入口测试成员", model: { provider: "mock", id: "echo" } });
	const { current: conversation } = await json(`/api/agents/${agent.id}/conversations`, "GET");
	const db = new DatabaseSync(join(run.data, "data.db"));
	try {
		const insert = db.prepare("INSERT INTO messages(id, agent_id, conversation_id, role, content, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)");
		const startTime = Date.now() - 120_000;
		for (let i = 0; i < 30; i++) insert.run(`m_stage3_${i}`, agent.id, conversation, "user", `滚动测试消息 ${i}`, "done", startTime + i, startTime + i);
	} finally { db.close(); }
	const out = join(root, "artifacts/screenshots/unified-right-rail-stage3");
	mkdirSync(out, { recursive: true });
	const room = await json("/api/rooms", "POST", { name: "入口测试群", memberIds: [agent.id, member.id], managerId: agent.id });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	await page.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
	page.setDefaultTimeout(12_000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const byId = (id) => page.getByTestId(id);
	const workspace = byId("right-workspace");
	const detail = (id) => workspace.getByTestId("workspace-agent-details").and(workspace.locator(`[data-workspace-key="settings:agent:${id}"]`));
	const heading = (id) => detail(id).getByTestId("agent-info-heading");
	const start = ["workspace-files-open", "workspace-browser-open", "workspace-agent-open", "workspace-model-open"];
	const startPage = workspace.getByTestId("workspace-start");
	const waitForStart = async () => { for (const id of start) await startPage.getByTestId(id).waitFor(); };
	const next = async () => { await byId("workspace-new-tab").click(); await waitForStart(); };
	const close = () => byId("workspace-close-tab").click();
	const model = workspace.getByTestId("agent-model-settings").filter({ visible: true });

	await page.goto(`${base}/?agent=${agent.id}`);
	await byId("agent-detail-open").waitFor();
	await page.locator('[data-testid="right-workspace"][data-scope*="conversation:"]:not([data-scope$="conversation:"])').waitFor({ state: "attached" });
	await workspace.waitFor({ state: "hidden" });
	assert.equal(await byId("workspace-reopen").count(), 1, "只有一个工作区入口");
	assert.equal(await page.getByRole("button", { name: "信息面板", exact: true }).count(), 0, "不再有独立信息面板入口");
	assert.equal(await byId("workspace-browser-open").isVisible(), false, "网页入口不在聊天外层");
	await byId("workspace-reopen").click();
	await waitForStart();
	const filter = startPage.getByRole("searchbox", { name: "筛选工作区入口" });
	await filter.focus();
	await page.screenshot({ path: join(out, "desktop-start.png") });
	const filterRequests = [];
	const recordRequest = r => { if (new URL(r.url()).pathname.startsWith("/api/")) filterRequests.push(r.url()); };
	page.on("request", recordRequest);
	for (const [query, id] of [["  文档 ", start[0]], ["浏览器", start[1]], ["入口测试助理", start[2]], ["fAsT", start[3]]]) {
		await filter.fill(query);
		assert.deepEqual(await startPage.locator(".pa-workspace-shortcuts button").evaluateAll(els => els.map(el => el.dataset.testid)), [id]);
	}
	await filter.fill("滚动测试消息 0");
	assert.equal(await startPage.getByRole("status").innerText(), "没有匹配的入口。");
	assert.equal(await startPage.locator(".pa-workspace-shortcuts button").count(), 0);
	assert.equal(await filter.evaluate(el => document.activeElement === el), true);
	await filter.fill("");
	assert.equal(await startPage.locator(".pa-workspace-shortcuts button").count(), 4);
	page.off("request", recordRequest);
	assert.deepEqual(filterRequests, [], "筛选不访问后端");
	await byId("workspace-files-open").click();
	await detail(agent.id).getByTestId("agent-files").waitFor();
	await startPage.waitFor({ state: "detached" });
	assert.equal(await byId("workspace-reopen").count(), 0, "展开时不重复显示外部工作区入口");
	await next();
	await byId("workspace-browser-open").click();
	await workspace.getByTestId("workspace-browser-empty").waitFor();
	await close();
	await workspace.getByTestId("workspace-browser").waitFor({ state: "detached" });
	await workspace.getByTestId("agent-files").waitFor();

	await next();
	await byId("workspace-agent-open").click();
	await heading(agent.id).waitFor();
	assert.match(await heading(agent.id).innerText(), /入口测试助理/);
	const originalDetail = await detail(agent.id).elementHandle();
	await byId("agent-detail-open").click();
	await heading(agent.id).waitFor();
	assert.equal(await detail(agent.id).count(), 1, "标题和起始页共享一个详情标签");
	assert.equal(await originalDetail.evaluate((el) => el.isConnected), true, "再次打开不重挂详情");
	await detail(agent.id).getByTestId("overview-model-settings").click();
	await model.waitFor();
	const scroll = page.locator(".pa-scroll:visible");
	await page.getByText("滚动测试消息 29", { exact: true }).waitFor();
	await scroll.evaluate(el => { el.scrollTop = 280; });
	await page.waitForFunction(() => document.querySelector('.pa-scroll').scrollTop === 280);
	const verifyScroll = async () => assert.ok(Math.abs(await scroll.evaluate(el => el.scrollTop) - 280) <= 1, "保持聊天滚动位置");

	const draft = page.locator(".pa-composer textarea");
	await draft.fill("聊天草稿保持不变");
	await infoTab(page, "profile");
	const profileDraft = detail(agent.id).getByPlaceholder(BIO_PLACEHOLDER);
	await profileDraft.fill("资料尚未保存");
	await next();
	await byId("workspace-model-open").click();
	await model.waitFor();
	const originalModel = await model.elementHandle();
	await byId("workspace-expand").click();
	await model.waitFor();
	await byId("workspace-restore").click();
	await verifyScroll();
	await next();
	await byId("workspace-browser-open").click();
	await workspace.getByTestId("workspace-browser-empty").waitFor();
	await close();
	await model.waitFor();
	await verifyScroll();
	await infoTab(page, "profile");
	assert.equal(await profileDraft.inputValue(), "资料尚未保存");
	await infoTab(page, "models");
	assert.equal(await draft.inputValue(), "聊天草稿保持不变");
	await byId("workspace-collapse").click();
	await workspace.waitFor({ state: "hidden" });
	// 真实输入栏选择器里的完整设置，不把快速选模型本身当成完整设置页。
	await page.locator(".pa-composer").getByTestId("model-picker").click();
	await byId("model-picker-compact").getByTestId("composer-model-settings").click();
	await model.waitFor();
	assert.equal(await model.count(), 1, "完整设置只显示一个模型设置内容");
	assert.equal(await originalModel.evaluate((el) => el === document.querySelector('[data-testid="right-workspace"] [data-testid="agent-model-settings"]')), true, "完整设置复用起始页打开的模型 DOM");

	await page.setViewportSize({ width: 390, height: 844 });
	const back = workspace.getByTestId("workspace-back-chat");
	await back.waitFor();
	assert.equal(await workspace.getAttribute("data-mode"), "mobile");
	assert.equal(await workspace.getByTestId("workspace-collapse").count(), 0, "手机不重复渲染桌面的收起按钮");
	await back.click();
	await workspace.waitFor({ state: "hidden" });
	await scroll.evaluate(el => { el.scrollTop = 280; });
	await page.waitForFunction(() => document.querySelector('.pa-scroll').scrollTop === 280);
	await byId("agent-detail-open").click();
	await detail(agent.id).getByTestId("overview-model-settings").click();
	await model.waitFor();
	const mobileModel = await model.elementHandle();
	await next();
	await filter.fill("不存在的入口");
	assert.equal(await startPage.getByRole("status").innerText(), "没有匹配的入口。");
	await page.screenshot({ path: join(out, "mobile-no-results.png") });
	await filter.fill("浏览器");
	await byId("workspace-browser-open").click();
	await workspace.getByTestId("workspace-browser-empty").waitFor();
	await close();
	await model.waitFor();
	assert.equal(await mobileModel.evaluate(el => el.isConnected), true);
	await back.click();
	await workspace.waitFor({ state: "hidden" });
	await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "workspace-reopen");
	await verifyScroll();
	assert.equal(await draft.inputValue(), "聊天草稿保持不变");
	await byId("workspace-reopen").click();
	await model.waitFor();
	assert.equal(await originalModel.evaluate((el) => el.isConnected), true, "手机返回聊天和恢复不会重挂模型内容");

	await page.setViewportSize({ width: 1440, height: 900 });
	// 同页切换 scope，避免 reload 自然清空掩盖注册表未清理的回归。
	await page.getByText("入口测试群", { exact: true }).click();
	await byId("room-members").waitFor();
	await detail(agent.id).waitFor({ state: "detached" });
	await byId("room-members").locator('button[title^="入口测试成员"]').click();
	await heading(member.id).waitFor();
	assert.match(await heading(member.id).innerText(), /入口测试成员/);
	assert.equal(await byId("workspace-reopen").count(), 0);
	await detail(member.id).getByTestId("overview-model-settings").click();
	await detail(member.id).getByTestId("agent-model-settings").waitFor();
	const pop = await openAgentModelPop(page);
	const modelName = pop.getByTestId("thinking-model-name");
	if (await pop.getByTestId("model-search").count() === 0) await modelName.click();
	const pick = page.locator('[data-testid="model-option"][data-model="mock/echo-think"]:visible').first();
	const writes = page.waitForResponse(r => r.request().method() === "PATCH" && /\/api\/agents\/[^/]+$/.test(new URL(r.url()).pathname));
	await pick.click();
	const write = await writes;
	assert.equal(new URL(write.url()).pathname, `/api/agents/${member.id}`);
	assert.ok(write.ok());
	const checked = await json("/api/agents", "GET");
	assert.equal(checked.find(a => a.id === member.id).model.id, "echo-think");
	assert.equal(checked.find(a => a.id === agent.id).model.id, "echo");

	// No upstream list or inference: seed an exact local contract, save high, then remove its support.
	const id = "integration-relay-original";
	const relay = { name: "组合测试中转", baseUrl: `${base}/unused-relay`, api: "openai-completions", noKey: true };
	const capabilityScope = { api: relay.api, baseUrl: relay.baseUrl, source: "本地夹具", appliesTo: "all-chat", defaults: { reasoning: true, levels: { high: "fixture-high" } } };
	const channel = await json("/api/models/custom", "POST", { ...relay, capabilityScope, models: [{ id }, { id: "integration-relay-other" }] });
	const scopedAgent = await json("/api/agents", "POST", { name: "组合测试助理", model: { provider: channel.id, id }, thinking: "high" });
	assert.equal(scopedAgent.thinkingSetting, "high");
	const scopePath = `/api/models/custom/${channel.id}`;
	const retained = { id: "integration-relay-other" };
	await json(scopePath, "PUT", { ...relay, capabilityScope: { ...capabilityScope, defaults: { reasoning: false } }, models: [{ id }, retained] });
	const composerPicker = page.locator(".pa-composer").getByTestId("model-picker");
	async function enterScopedChat() {
		await page.goto(`${base}/?agent=${scopedAgent.id}`);
		await page.locator('[data-testid="right-workspace"][data-scope*="conversation:"]:not([data-scope$="conversation:"])').waitFor({ state: "attached" });
		await byId("agent-detail-open").click();
		await detail(scopedAgent.id).getByTestId("overview-model-settings").click();
		await model.waitFor();
		const handle = await model.elementHandle();
		await byId("workspace-collapse").click();
		await workspace.waitFor({ state: "hidden" });
		return handle;
	}
	async function verifySameDetail(handle) {
		await model.waitFor();
		assert.equal(await detail(scopedAgent.id).count(), 1);
		assert.equal(await handle.evaluate(el => el === document.querySelector('[data-testid="right-workspace"] [data-testid="agent-model-settings"]')), true);
	}
	const invalidModelPane = await enterScopedChat();
	await composerPicker.getByText(/原档位不可用/).waitFor();
	const compact = await openCompact(page);
	await compact.getByText(/已保存的「高」.*设置未修改/).waitFor();
	await compact.getByTestId("composer-model-settings").click();
	await verifySameDetail(invalidModelPane);

	await json(scopePath, "PUT", { ...relay, capabilityScope, models: [retained] });
	const removedModelPane = await enterScopedChat();
	await composerPicker.getByText(`已不可用 · ${id}`, { exact: true }).waitFor();
	await composerPicker.click();
	await byId("composer-model-settings").click();
	await verifySameDetail(removedModelPane);
	const preserved = (await json("/api/agents", "GET")).find(a => a.id === scopedAgent.id);
	assert.equal(preserved.model_id, id);
	assert.equal(preserved.thinkingSetting, "high");
	console.log("PASS 失效高档、原模型 ID、两层菜单的完整设置均直达已挂载的同一右栏；无自动改档");
	assert.deepEqual(errors, []);
	console.log("PASS 统一入口、起始页四入口、单聊/群成员详情、模型完整设置及手机恢复");
} finally {
	await browser?.close();
	await server.stop();
	cleanupTempRun(run);
}
