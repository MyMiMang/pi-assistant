/** 建群→自有分组模型/强度→落库→成员概览及设置→加成员。隔离临时服务/Mock，不触达生产或服务商。 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
import { infoTab, expandAgentModelSection, agentProfileSave } from "./fixtures/info-pane.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-room-model-settings-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const out = process.env.SHOT_DIR ?? join(run.runDir, "shots"); mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path} ${r.status}`); return r.json(); };
const wait = async (fn, ms = 15000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await fn()) return; await new Promise((r) => setTimeout(r, 80)); } throw new Error("condition timed out"); };
let browser;
try {
 await wait(async () => { try { return (await fetch(base + "/api/system")).ok; } catch { return false; } });
 await j("/api/settings", "PUT", { onboarded: true });
 const host = await j("/api/agents", "POST", { name: "组队测试", model: { provider: "mock", id: "echo" } });
 const existing = await j("/api/agents", "POST", { name: "已有助理", model: { provider: "mock", id: "echo-think" }, thinking: "low" });
 const svc = await j("/api/models/custom", "POST", { name: "灯灯的中文中转（长服务名称）", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true, models: [{ id: "anthropic.claude-sonnet-5", name: "七档思考模型-超长名称确保边界正常", reasoning: true }, { id: "openai.gpt-5.4-mini", name: "子集档位模型", reasoning: true }] });
 await j("/api/models/default", "PUT", { provider: "mock", model: "echo-think", thinking: "medium" });
 browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(7000);
 const errors = []; page.on("pageerror", (e) => errors.push(e.message));
 await page.goto(`${base}/?agent=${host.id}`);
 await page.getByTestId("model-picker").waitFor();
 await j(`/api/agents/${host.id}/messages`, "POST", { text: "帮我组个团队做个活动" });
 const card = page.getByTestId("room-proposal").last(); await card.waitFor({ timeout: 20000 });
 const member = card.getByTestId("proposal-member").first();
 assert.equal(await card.locator("select").count(), 0, "提议全部使用自有选择组件");
 await member.getByTestId("pm-model").click();
 const menu = page.getByTestId("pm-model-menu"); await menu.waitFor();
 assert.equal(await menu.locator('[data-testid^="pm-model-group-"]').count(), 2, "按两个已配置服务分组");
 assert.match(await menu.innerText(), /灯灯的中文中转/);
 assert.match(await menu.getByTestId("pm-model-option").first().innerText(), /★/);
 await stableShot(page, menu, join(out, "01-proposal-grouped-models.png"));
 await page.getByTestId(`pm-model-group-${svc.id}`).click();
 await menu.locator(`[data-model="${svc.id}/anthropic.claude-sonnet-5"]`).click();
 await member.getByTestId("pm-thinking").click();
 const thought = page.getByTestId("pm-thinking-menu"); await thought.waitFor();
 assert.equal(await thought.locator(".pa-think-step").count(), 7, "以实际单模型目录给七档");
 await thought.getByRole("slider").press("End");
 await thought.waitFor({ state: "detached" });
 assert.match(await member.getByTestId("pm-thinking").innerText(), /最大/);
 // 切回只有子集的mock模型；明确显示max→high而不是假装max仍支持。
 await member.getByTestId("pm-model").click();
 await menu.getByTestId("pm-model-group-mock").click();
 await menu.locator('[data-model="mock/echo-think"]').click();
 assert.match(await member.getByTestId("pm-thinking").innerText(), /最大.*高/);
 await member.getByTestId("pm-thinking").click();
 await thought.getByRole("slider").waitFor();
 const supported = (await j("/api/models")).find((m) => m.provider === "mock" && m.id === "echo-think").thinking;
 assert.equal(await thought.locator(".pa-think-step").count(), supported.length);
 await stableShot(page, thought, join(out, "02-proposal-thinking-clamp.png"));
 await page.keyboard.press("Escape");
 await card.getByTestId("proposal-existing").click();
 await page.getByTestId(`proposal-existing-option-${existing.id}`).click();
 assert.equal(await card.getByTestId("proposal-member").count(), 3);
 await card.getByTestId("proposal-confirm").click();
 await page.getByTestId("room-title").waitFor();
 const room = (await j("/api/rooms")).find((r) => r.name === "新品发布小组"); assert.ok(room);
 let agents = await j("/api/agents"); const manager = agents.find((a) => a.id === room.managerId);
 assert.equal(manager.thinking, supported.at(-1)); assert.equal(manager.thinkingSetting, supported.at(-1));
 assert.equal(agents.find((a) => a.id === existing.id).thinkingSetting, "low", "加入已有助理不改它的强度");
 console.log("PASS proposal: themed components, grouped services, seven/subset levels, saved clamp, existing agent unchanged");
 // 点击成员默认概览只做摘要；模型/强度在「模型」页即时保存。
 await page.getByTestId("room-members").locator(`button[title^="${manager.name}"]`).click();
 const pane = page.locator(".pa-pane-wrap");
 /** 等模型目录真的给出档位再按滑块，避免把“加载中”为空当成不支持。 */
 const setThinking = async (key) => {
   await pane.getByTestId("agent-thinking").click();
   const slider = page.getByTestId("agent-thinking-menu").getByRole("slider");
   await slider.waitFor();
   await slider.press(key);
 };
 await infoTab(page, "overview");
 await pane.getByTestId("overview-model-settings").waitFor();
 assert.equal(await pane.getByTestId("agent-models-tab").count(), 0, "概览只做摘要，不直接铺开模型控件");
 await pane.getByTestId("overview-model-settings").click();
 await pane.getByTestId("agent-model-settings").waitFor();
 assert.equal(await pane.getByTestId("agent-model-settings").locator("select").count(), 0, "模型/强度选择不是原生 select");
 // 图片模型 / 子代理默认折在 native details 里；这里真的点开再验证入口保留。
 await expandAgentModelSection(page, "image");
 await expandAgentModelSection(page, "subagents");
 await pane.getByTestId("agent-image-model").waitFor();
 await pane.getByTestId("agent-subagent-model").waitFor();
 assert.ok(await pane.getByTestId("agent-image-model").isVisible(), "模型页仍管理图片模型");
 assert.ok(await pane.getByTestId("agent-subagent-model").isVisible(), "模型页仍管理子代理模型");
 await setThinking("Home");
 await wait(async () => (await j("/api/agents")).find((a) => a.id === manager.id).thinking === supported[0]);
 await stableShot(page, pane, join(out, "03-member-models-immediate.png"));
 await page.goto(`${base}/?room=${room.id}`); await page.getByTestId("room-members").locator(`button[title^="${manager.name}"]`).click();
 await infoTab(page, "overview");
 await pane.getByTestId("overview-model-settings").click();
 await pane.getByTestId("agent-model-settings").waitFor();
 await wait(async () => /关闭/.test(await pane.getByTestId("agent-thinking").innerText()));
 console.log("PASS created member: overview is a summary that navigates to models; strength saves immediately and survives reload");

 // 资料页：显式保存、跨一级 tab 保留草稿、保存失败保留草稿、仅资料保存不重发模型/强度/Fast。
 await infoTab(page, "profile");
 const profile = pane.getByTestId("agent-profile"); await profile.waitFor();
 assert.equal(await profile.getByTestId("agent-draft").count(), 0, "资料页不再有模型草稿区");
 assert.equal(await profile.getByTestId("agent-computer").count(), 0, "电脑设置不再混在资料页");
 const description = profile.getByPlaceholder("一句话介绍（显示在侧边栏和概览里）");
 const saveProfile = async () => { const btn = agentProfileSave(pane); await btn.waitFor(); await btn.click(); };
 const descriptionBefore = (await j("/api/agents")).find((a) => a.id === manager.id).description;
 await description.fill("资料草稿：跑活动");
 assert.equal((await j("/api/agents")).find((a) => a.id === manager.id).description, descriptionBefore, "资料保存前不落库");
 await infoTab(page, "models");
 assert.ok(await pane.isVisible(), "模型/资料切页不关闭信息面板");
 await pane.getByTestId("agent-model-settings").waitFor();
 await infoTab(page, "profile");
 assert.equal(await description.inputValue(), "资料草稿：跑活动", "跨一级 tab 保留未保存草稿");
 const failPatch = async (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "临时保存失败" }) });
 await page.route(`**/api/agents/${manager.id}`, failPatch);
 await saveProfile();
 await profile.getByText("临时保存失败", { exact: true }).waitFor();
 assert.equal((await j("/api/agents")).find((a) => a.id === manager.id).description, descriptionBefore, "保存失败不改库里的资料");
 assert.equal(await description.inputValue(), "资料草稿：跑活动", "保存失败保留草稿");
 await page.unroute(`**/api/agents/${manager.id}`, failPatch);
 await saveProfile();
 await wait(async () => (await j("/api/agents")).find((a) => a.id === manager.id).description === "资料草稿：跑活动");
 await stableShot(page, profile, join(out, "04-member-profile-save.png"));

 // 仅保存资料：不重发模型/强度/Fast（它们由模型页即时保存）。
 const profilePatches = [];
 const inspectPatch = async (route) => { if (route.request().method() === "PATCH") profilePatches.push(route.request().postDataJSON()); await route.continue(); };
 await page.route(`**/api/agents/${manager.id}`, inspectPatch);
 await saveProfile();
 await wait(() => profilePatches.length > 0);
 assert.equal("model" in profilePatches[0], false, "仅保存资料不覆盖模型");
 assert.equal("thinking" in profilePatches[0], false, "仅保存资料不覆盖强度");
 assert.equal("fast" in profilePatches[0], false, "仅保存资料不覆盖 Fast");
 await page.unroute(`**/api/agents/${manager.id}`, inspectPatch);
 console.log("PASS profile: draft kept across top-level tabs, explicit save, failure keeps draft, profile-only save leaves model/strength/Fast untouched");

 // 模型页 live 保存错误：失败可见、保留原值，并可清回跟随默认。
 await infoTab(page, "models");
 await wait(async () => /关闭/.test(await pane.getByTestId("agent-thinking").innerText()));
 await page.route(`**/api/agents/${manager.id}`, failPatch);
 await setThinking("End");
 await pane.getByTestId("model-save-error").waitFor();
 assert.match(await pane.getByTestId("model-save-error").innerText(), /保存失败.*临时保存失败/);
 assert.equal((await j("/api/agents")).find((a) => a.id === manager.id).thinkingSetting, supported[0]);
 await stableShot(page, pane, join(out, "07-member-save-error.png"));
 await page.unroute(`**/api/agents/${manager.id}`, failPatch);
 await setThinking("End");
 await wait(async () => (await j("/api/agents")).find((a) => a.id === manager.id).thinkingSetting === supported.at(-1));
 await pane.getByTestId("agent-thinking").click();
 await page.getByTestId("agent-thinking-follow").click();
 await wait(async () => (await j("/api/agents")).find((a) => a.id === manager.id).thinkingSetting === null);
 await wait(async () => /跟随/.test(await pane.getByTestId("agent-thinking").innerText()));
 console.log("PASS save failures: visible live error keeps stored value, retry persists, follow resets strength to default");

 // 管理者用mock执行加人卡片，再走确认加入。
 await pane.getByRole("button", { name: "关闭", exact: true }).first().click();
 await j(`/api/rooms/${room.id}/messages`, "POST", { text: "帮我加个成员" });
 const add = page.getByTestId("member-proposal").last(); await add.waitFor({ timeout: 20000 });
 await add.getByTestId("pm-model").click();
 await menu.getByTestId("pm-model-search").fill("echo-think");
 await menu.locator('[data-model="mock/echo-think"]').click();
 await add.getByTestId("pm-thinking").click();
 await thought.getByRole("slider").press("Home");
 await add.getByTestId("proposal-confirm").click();
 await wait(async () => (await j("/api/agents")).some((a) => a.room_id === room.id && a.name === "设计"));
 assert.equal((await j("/api/agents")).find((a) => a.room_id === room.id && a.name === "设计").thinkingSetting, supported[0]);
 console.log("PASS added member: grouped model and strength commit survive confirmation");
 // 390窄屏重新生成卡片，以实际DOM核对分组和强度弹层边界。
 await page.setViewportSize({ width: 390, height: 844 });
 await page.goto(`${base}/?agent=${host.id}`);
 await j(`/api/agents/${host.id}/messages`, "POST", { text: "帮我组个团队做个活动" });
 const mobile = page.getByTestId("room-proposal").filter({ has: page.getByTestId("proposal-confirm") }).last(); await mobile.waitFor({ timeout: 20000 });
 await mobile.getByTestId("pm-model").first().click(); await menu.waitFor();
 await stableShot(page, menu, join(out, "05-proposal-mobile-groups.png"));
 for (const target of [menu]) { const b = await target.boundingBox(); assert.ok(b && b.x >= 0 && b.y >= 0 && b.x + b.width <= 391 && b.y + b.height <= 845); }
 await page.keyboard.press("Escape");
 await mobile.getByTestId("pm-thinking").first().click(); await thought.waitFor();
 await stableShot(page, thought, join(out, "06-proposal-mobile-thinking.png"));
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
 console.log("PASS 390px: cards/menu/strength have visible content, no page overflow or JS errors");
 await page.keyboard.press("Escape");
 // 目录/默认读取异常不能冒充“不支持”或最低档；重试后恢复，选型不被清空。
 let defaultsFailed = true; let catalogFailed = true;
 const defaultsRoute = async (route) => defaultsFailed ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"defaults unavailable"}' }) : route.continue();
 const catalogRoute = async (route) => catalogFailed ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"catalog unavailable"}' }) : route.continue();
 await page.route("**/api/models/defaults", defaultsRoute);
 await page.route("**/api/models", catalogRoute);
 await page.reload();
 const retryCard = page.getByTestId("room-proposal").filter({ has: page.getByTestId("proposal-confirm") }).last();
 await retryCard.getByTestId("pm-thinking").first().click();
 await page.getByTestId("pm-thinking-error").waitFor();
 assert.equal(await thought.getByRole("slider").count(), 0, "未知默认不冒充最低档");
 defaultsFailed = false; catalogFailed = false;
 await page.getByTestId("pm-thinking-retry").click();
 await thought.getByRole("slider").waitFor();
 await page.keyboard.press("Escape");
 await page.unroute("**/api/models/defaults", defaultsRoute); await page.unroute("**/api/models", catalogRoute);
 // 真实不可调模型是固定一档off，显示说明而不是伪七档。
 await retryCard.getByTestId("pm-model").first().click();
 await menu.getByTestId("pm-model-search").fill("echo");
 await menu.locator('[data-model="mock/echo"]').click();
 await retryCard.getByTestId("pm-thinking").first().click();
 await page.getByTestId("pm-thinking-fixed").waitFor();
 assert.equal(await thought.getByRole("slider").count(), 0);
 assert.deepEqual(errors, []);
 console.log("PASS loading/error/retry: unknown defaults do not invent levels; retry restores real metadata; plain model has fixed off");
 // 关闭WS补偿：独立确认 PATCH 同步原始/有效档位，不改 Fast，迟到响应按序落库。
 const full = "anthropic.claude-sonnet-5", subset = "openai.gpt-5.4-mini";
 const isolated = await browser.newPage({ viewport: { width: 1280, height: 900 } }); isolated.setDefaultTimeout(7000);
 await isolated.routeWebSocket("**/ws*", () => {});
 await j(`/api/agents/${manager.id}`, "PATCH", { model: { provider: svc.id, id: full }, thinking: "max", fast: true });
 const directErrors = []; isolated.on("pageerror", (e) => directErrors.push(e.message));
 await isolated.goto(`${base}/?room=${room.id}`);
 await isolated.getByTestId("room-members").locator('button[title^="统筹"]').click();
 const directPane = isolated.locator(".pa-pane-wrap");
 const models = async () => { await infoTab(isolated, "models"); await directPane.getByTestId("agent-model-settings").waitFor(); };
 const chooseLive = async (id) => {
   await directPane.getByTestId("model-picker").click();
   await isolated.getByTestId("model-menu").waitFor();
   await isolated.getByTestId("model-search").fill(id);
   // 常用与服务分组可各列同一语义模型；点击其第一份，不把正常重复展示当strict locator失败。
   await isolated.locator(`[data-testid=model-option][data-model="${svc.id}/${id}"]`).first().click();
 };
 await models();
 await chooseLive(subset);
 await wait(async () => (await j("/api/agents")).find((a) => a.id === manager.id).model.id === subset);
 await wait(async () => /子集档位模型/.test(await directPane.getByTestId("model-picker").innerText()));
 await wait(async () => /最大.*高/.test(await directPane.getByTestId("agent-thinking").innerText()));
 const raw = (await j("/api/agents")).find((a) => a.id === manager.id);
 assert.equal(raw.thinkingSetting, "max", "存储的原始档位保持 max");
 assert.equal(raw.thinking, "high", "有效档位按模型目录降为 high");
 assert.equal(await isolated.getByTestId("agent-model-fast").getAttribute("aria-pressed"), "true", "Fast 已开启");
 await directPane.getByTestId("agent-thinking").click();
 await isolated.getByTestId("agent-thinking-follow").click();
 await wait(async () => (await j("/api/agents")).find((a) => a.id === manager.id).thinkingSetting === null);
 // 夹具全局默认是 medium；由 max 清回跟随后应显示「中」，不能沿用显式 max 降级时的 high。
 await wait(async () => /跟随.*中/.test(await directPane.getByTestId("agent-thinking").innerText()));
 const following = (await j("/api/agents")).find((a) => a.id === manager.id);
 assert.equal(following.thinking, "medium", "跟随使用夹具设置的默认中档");
 assert.equal(following.fast, true, "改强度/跟随不动 Fast");
 assert.equal(await isolated.getByTestId("agent-model-fast").getAttribute("aria-pressed"), "true", "Fast 按钮保持开启");
 await models();
 // A入口响应延迟时切换成员；重新进入同一助理再写B必须排队，最终UI与DB一致。
 let releaseFirst; const responseGate = new Promise((r) => { releaseFirst = r; });
 let seenFirst = false; let patchCount = 0;
 const delayed = async (route) => {
   if (route.request().method() !== "PATCH") return route.continue();
   patchCount++; const result = await route.fetch();
   if (patchCount === 1) { seenFirst = true; await responseGate; }
   await route.fulfill({ response: result });
 };
 await isolated.route(`**/api/agents/${manager.id}`, delayed);
 await chooseLive(full); await wait(() => seenFirst);
 await isolated.getByTestId("room-members").locator('button[title^="已有助理"]').click();
 await models();
 await wait(async () => /Mock 推理模型/.test(await directPane.getByTestId("model-picker").innerText()));
 await isolated.getByTestId("room-members").locator('button[title^="统筹"]').click();
 await models();
 await chooseLive(subset);
 assert.equal(patchCount, 1, "旧请求未确认前同一助理的下次写入排队");
 releaseFirst();
 await wait(async () => patchCount === 2 && (await j("/api/agents")).find((a) => a.id === manager.id).model.id === subset);
 await wait(async () => !await directPane.getByTestId("model-picker").isDisabled());
 await wait(async () => /子集档位模型/.test(await directPane.getByTestId("model-picker").innerText()));
 assert.equal((await j("/api/agents")).find((a) => a.id === manager.id).fast, true);
 assert.equal(await isolated.getByTestId("agent-model-fast").getAttribute("aria-pressed"), "true");
 assert.deepEqual(directErrors, []);
 await isolated.close();
 console.log("PASS without WS: raw/effective metadata synchronized, follow retained, Fast independent, late responses ordered across member switches");
} catch (e) {
 let i = 0;
 for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
   await page.screenshot({ path: join(out, i++ === 0 ? "fixture-failed.png" : `fixture-failed-page-${i}.png`) }).catch(() => {});
 }
 console.error(server.logs().split("\n").filter((l) => !/apiKey|bearer|token/i.test(l)).slice(-14).join("\n"));
 throw e;
}
finally { await browser?.close(); await server.stop(); cleanupTempRun(run); }
