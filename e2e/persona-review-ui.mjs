/** 手动整理人设：真实临时服务 + Mock；采用只改草稿，显式保存才落库。 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
import { infoPane, openInfoPane, infoTab, agentProfileSave, PERSONA_PLACEHOLDER } from "./fixtures/info-pane.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-persona-review-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
assert.notEqual(port, 8787);
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const out = join(artifactDir("screenshots"), "persona-review");
mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	assert.ok(r.ok, `${method} ${path}: ${r.status}`);
	return r.json();
};
const wait = async (fn, label = "条件", ms = 30000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await fn()) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
	throw new Error(`等待超时：${label}`);
};
let browser, sqlite, releaseReview;
try {
	await wait(async () => {
		if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error("临时服务在就绪前退出");
		try { return (await fetch(base + "/api/system", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
	}, "临时服务启动");
	await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
	const original = "你是做事认真的助理。保留原有要求。";
	const a = await j("/api/agents", "POST", { name: "人设整理验收助理", persona: original, model: { provider: "mock", id: "echo" } });
	const b = await j("/api/agents", "POST", { name: "另一位验收助理", persona: "另一位的人设", model: { provider: "mock", id: "echo" } });
	await j(`/api/agents/${a.id}/messages`, "POST", { text: "以后请回答先说结论，再简洁说明；请记住，这是我明确的做事要求。" });
	await wait(async () => {
		const messages = await j(`/api/agents/${a.id}/messages`);
		return messages.some((m) => m.role === "assistant" && m.content) && (await j("/api/agents")).find((x) => x.id === a.id)?.status !== "running";
	}, "Mock 助理回复结束");
	sqlite = new DatabaseSync(join(run.data, "data.db"), { readOnly: true });
	const stored = (id = a.id) => sqlite.prepare("SELECT persona FROM agents WHERE id = ?").get(id).persona;
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(10000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const pane = infoPane(page);
	const profile = page.getByTestId("agent-profile");
	const persona = profile.getByPlaceholder(PERSONA_PLACEHOLDER);
	const start = profile.getByTestId("persona-review-start");
	const result = profile.getByTestId("persona-review-result");
	const reviewPath = `**/api/agents/${a.id}/persona-review`;
	const fulfill = (route, data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
	const openProfile = async (id) => {
		await page.goto(`${base}/?agent=${id}`);
		await openInfoPane(page);
		await infoTab(page, "profile");
		await persona.waitFor();
	};
	await openProfile(a.id);
	await start.scrollIntoViewIfNeeded();
	await stableShot(page, pane, join(out, "desktop-before.png"));
	await profile.getByTestId("persona-review-entry").getByTestId("help").hover();
	await page.getByTestId("help-pop").getByText(/采用后点保存才生效/).waitFor();
	await page.keyboard.press("Escape");
	const responsePending = page.waitForResponse((r) => r.url() === `${base}/api/agents/${a.id}/persona-review` && r.request().method() === "POST");
	await start.click();
	const response = await responsePending;
	assert.equal(response.status(), 200);
	const reviewed = await response.json();
	assert.deepEqual(reviewed.changes, ["补充了先说结论、简洁说明的要求"]);
	assert.ok(reviewed.persona.includes(original), "保留原人设");
	assert.ok(reviewed.persona.includes("回答先说结论，再简洁说明。"), "真实 Mock 返回整理要求");
	await result.getByText(reviewed.changes[0], { exact: true }).waitFor();
	assert.equal(await persona.inputValue(), original, "看到结果不改草稿");
	assert.equal(stored(), original, "整理接口不写数据库");
	assert.equal(await result.getByTestId("persona-review-text").count(), 0, "全文默认折叠");
	await result.getByTestId("persona-review-full-toggle").click();
	assert.equal(await result.getByTestId("persona-review-text").innerText(), reviewed.persona);
	await result.scrollIntoViewIfNeeded();
	await stableShot(page, pane, join(out, "desktop-result.png"));
	await page.setViewportSize({ width: 390, height: 844 });
	await result.scrollIntoViewIfNeeded();
	const bounds = await stableShot(page, result, join(out, "390.png"));
	assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391, "整理结果在手机视口内");
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "手机页面无横向溢出");
	await page.setViewportSize({ width: 1440, height: 1000 });
	await result.getByTestId("persona-review-adopt").click();
	await result.waitFor({ state: "detached" });
	assert.equal(await persona.inputValue(), reviewed.persona);
	assert.match(await profile.getByTestId("agent-profile-state").innerText(), /未保存/);
	assert.equal(stored(), original, "采用只改草稿，数据库仍未改变");
	await infoTab(page, "models");
	await infoTab(page, "profile");
	assert.equal(await persona.inputValue(), reviewed.persona, "采用后的草稿切分类保留");
	await agentProfileSave(profile).click();
	await wait(async () => stored() === reviewed.persona, "显式保存后数据库改变");
	assert.equal((await j("/api/agents")).find((item) => item.id === a.id).persona, reviewed.persona, "保存后接口返回新人设");
	await wait(async () => !await agentProfileSave(profile).isDisabled(), "保存结束");
	console.log("PASS persona review: 按钮 → 真实 Mock 变化 → 采用仅草稿 → 显式保存落库；desktop/390 截图");

	// 可控边界场景只截取整理接口；资料保存与数据库仍走真实临时服务。
	const unsaved = "用户尚未保存的手工草稿";
	await persona.fill(unsaved);
	const discardRoute = (route) => fulfill(route, { persona: "这份建议应被放弃", changes: ["用于验证放弃"] });
	await page.route(reviewPath, discardRoute);
	await start.click();
	await result.getByText("用于验证放弃", { exact: true }).waitFor();
	await result.getByTestId("persona-review-dismiss").click();
	await result.waitFor({ state: "detached" });
	assert.equal(await persona.inputValue(), unsaved, "放弃保留原草稿");
	assert.equal(stored(), reviewed.persona, "放弃不写数据库");
	await page.unroute(reviewPath, discardRoute);

	const unchangedRoute = (route) => fulfill(route, { persona: reviewed.persona, changes: [] });
	await page.route(reviewPath, unchangedRoute);
	await start.click();
	await result.getByText("没发现需要补充的", { exact: true }).waitFor();
	assert.equal(await result.getByTestId("persona-review-adopt").count(), 0, "无变化不提供覆盖草稿的采用按钮");
	await result.getByTestId("persona-review-dismiss").click();
	await page.unroute(reviewPath, unchangedRoute);

	const errorRoute = (route) => fulfill(route, { error: "测试模型暂时不可用，请稍后重试" }, 503);
	await page.route(reviewPath, errorRoute);
	await start.click();
	await profile.getByTestId("persona-review-error").getByText(/测试模型暂时不可用，请稍后重试/).waitFor();
	assert.equal(await profile.getByRole("alert").count(), 1, "整理失败只有一处错误提示");
	assert.equal(await persona.inputValue(), unsaved, "失败保留草稿");
	await page.unroute(reviewPath, errorRoute);

	let held = false, settled = false;
	const holdRoute = async (route) => {
		held = true;
		await new Promise((resolve) => { releaseReview = resolve; });
		await fulfill(route, { persona: "旧助理的迟到结果", changes: ["不应污染另一位助理"] }).catch(() => {});
		settled = true;
	};
	await page.route(reviewPath, holdRoute);
	await start.click();
	await wait(async () => held, "整理请求挂起");
	assert.equal(await start.isDisabled(), true, "整理中不能重复请求");
	assert.equal(await start.innerText(), "正在整理…");
	assert.equal(await profile.getByTestId("persona-review-error").count(), 0, "重试清掉旧错误");
	// 同一页面切助理，不依赖刷新卸载来隐藏迟到回包。
	const sidebar = page.getByTestId("sidebar-agent").filter({ hasText: b.name });
	if (!await sidebar.isVisible()) await page.getByRole("button", { name: "展开助理列表", exact: true }).click();
	await sidebar.click();
	await infoTab(page, "profile");
	await wait(async () => await persona.inputValue() === "另一位的人设", "切换到另一位助理");
	releaseReview(); releaseReview = undefined;
	await wait(async () => settled, "旧请求收尾");
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	assert.equal(await result.count(), 0, "迟到结果未显示在另一位助理资料中");
	assert.equal(await profile.getByTestId("persona-review-error").count(), 0, "旧请求错误未污染新助理");
	assert.equal(await persona.inputValue(), "另一位的人设");
	assert.equal(stored(b.id), "另一位的人设");
	assert.equal(stored(), reviewed.persona);
	assert.deepEqual(errors, []);
	console.log(`PASS 放弃、无变化、错误重试、加载防重复、切助理隔离；截图：${out}`);
} catch (e) {
	console.error(server.logs().slice(-3000));
	throw e;
} finally {
	releaseReview?.();
	await browser?.close();
	sqlite?.close();
	await server.stop();
	cleanupTempRun(run);
}
