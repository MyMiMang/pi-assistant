/** 助理/群员功能分类：真实临时HTTP保存，原生电脑接口只用明确fixture，不碰生产/付费模型。 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-agent-details-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const out = process.env.SHOT_DIR ?? join(run.runDir, "shots"); mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path} ${r.status}`); return r.json(); };
const wait = async (fn, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 80)); } throw new Error("condition timed out"); };
const expectKeys = ["overview", "models", "profile", "capabilities", "tasks", "memory", "files", "computer"];
let browser;
try {
 await wait(async () => { if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error("临时服务在就绪前退出"); try { return (await fetch(base + "/api/system", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } });
 await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
 const svc = await j("/api/models/custom", "POST", { name: "我的中文模型服务（很长的名字也要正常换行）", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true, models: [{ id: "anthropic.claude-sonnet-5", name: "七档推理模型（长名称检查）", reasoning: true }] });
 const a = await j("/api/agents", "POST", { name: "林导 · 负责整体交付的群成员", description: "统筹项目、整体体验、任务归属与最终交付，成员简介再长也不能挤出面板。", persona: "原始人设", model: { provider: svc.id, id: "anthropic.claude-sonnet-5" }, thinking: "medium" });
 const b = await j("/api/agents", "POST", { name: "墨白", model: { provider: "mock", id: "echo-think" }, thinking: "low" });
 const room = await j("/api/rooms", "POST", { name: "苏折竹AI短剧团队", memberIds: [a.id, b.id], managerId: a.id });
 browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(8000);
 const errors = []; page.on("pageerror", (e) => errors.push(e.message));
 let failHost = false, failSkills = false, failExtensions = false;
 const host = { settings: { enabled: false, agents: "all", apps: [], tiers: {}, defaultTier: "bounded", workspaceFiles: false }, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "fixture" }, tiers: {}, manifest: "", manifestHash: "fixture", permissions: null };
 const fulfill = (route, data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
 await page.route("**/api/host-control", (r) => fulfill(r, failHost ? { error: "电脑状态读取失败" } : host, failHost ? 503 : 200));
 await page.route("**/api/agents/*/desktop", (r) => fulfill(r, { enabled: false, available: false, installed: false, state: "none", paused: false, reason: "测试中不启用助理电脑", install: { phase: "idle", progress: 0 } }));
 await page.route("**/api/agents/*/computer", (r) => fulfill(r, { separate: false, hasData: false, desktop: { enabled: false, state: "none" } }));
 await page.route("**/api/mcp", (r) => failExtensions ? fulfill(r, { error: "扩展目录读取失败" }, 503) : r.continue());
 await page.route("**/api/skills", (r) => failSkills ? fulfill(r, { error: "技能目录读取失败" }, 503) : r.continue());
 const pane = page.locator(".pa-pane-wrap");
 const select = async (key, barId = "info-tabs") => {
  await page.getByTestId(barId).waitFor();
  const direct = page.getByTestId(barId).locator(`[role=tab][data-itab="${key}"]`);
  if (await direct.count()) await direct.click();
  else { await page.getByTestId(`${barId}-more`).click(); await page.getByTestId(`${barId}-menu`).locator(`[data-itab="${key}"]`).click(); }
 };
 const current = async () => (await j("/api/agents")).find((x) => x.id === a.id);
 const layout = async () => {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "页面无横向溢出");
  const bounds = await pane.boundingBox(); assert.ok(bounds && bounds.width > 240 && bounds.x >= 0 && bounds.x + bounds.width <= (await page.viewportSize()).width + 1);
  const outside = await pane.locator('button:visible,input:visible,textarea:visible,select:visible,h2:visible').evaluateAll((els) => els.filter((el) => { const r = el.getBoundingClientRect(), p = el.closest('.pa-pane-wrap').getBoundingClientRect(); return r.width > 0 && (r.left < p.left - 2 || r.right > p.right + 2); }).map((e) => e.getAttribute('data-testid') || e.textContent));
  assert.deepEqual(outside, [], "可见控件都在面板内");
 };
 await page.goto(`${base}/?room=${room.id}`);
 await page.getByTestId("room-members").locator(`button[title^="${a.name}"]`).click();
 await pane.getByTestId("overview-model-settings").waitFor();
 assert.equal(await pane.getByTestId("agent-model-settings").count(), 0, "概览只有摘要，未重复挂模型控件");
 await stableShot(page, pane, join(out, "01-overview-desktop.png"));
 await pane.getByTestId("overview-model-settings").click();
 await pane.getByTestId("agent-thinking").waitFor();
 assert.equal(await pane.getByTestId("agent-draft").count(), 0, "详情无第二份模型草稿");
 await pane.getByTestId("agent-thinking").click();
 const thinking = page.getByTestId("agent-thinking-menu"); await thinking.getByRole("slider").waitFor();
 assert.equal(await thinking.locator(".pa-think-step").count(), 7);
 await thinking.getByRole("slider").press("End");
 await wait(async () => (await current()).thinkingSetting === "max");
 await pane.getByTestId("agent-model-fast").click();
 await wait(async () => (await current()).fast === true);
 assert.equal((await current()).thinkingSetting, "max", "Fast不改强度");
 await pane.getByTestId('agent-info-heading').click();
 await stableShot(page, pane, join(out, "02-models-desktop.png"));
 console.log("PASS group: overview directs to models; separate model/thinking/Fast; seven real levels; independent persistence");
 await select("profile");
 const profile = pane.getByTestId("agent-profile"); const persona = profile.locator("textarea");
 await persona.fill("这是还没保存的人设草稿；切换功能分类必须保留。");
 await select("models"); await pane.getByTestId("agent-thinking").click();
 await thinking.getByRole("slider").press("Home"); await wait(async () => (await current()).thinkingSetting === "off");
 await select("profile"); assert.match(await persona.inputValue(), /还没保存的人设草稿/);
 const patches = []; let reject = true;
 const profileRoute = async (route) => { if (route.request().method() !== "PATCH") return route.continue(); const body = route.request().postDataJSON(); patches.push(body); if (reject) return fulfill(route, { error: "资料保存失败，请重试" }, 503); return route.continue(); };
 await page.route(`**/api/agents/${a.id}`, profileRoute);
 await profile.getByRole("button", { name: "保存", exact: true }).click();
 await profile.getByText("资料保存失败，请重试", { exact: true }).waitFor();
 assert.match(await persona.inputValue(), /还没保存的人设草稿/);
 reject = false; await profile.getByRole("button", { name: "保存", exact: true }).click();
 await wait(async () => /还没保存/.test((await current()).persona));
 for (const patch of patches) for (const field of ["model", "thinking", "fast"]) assert.equal(field in patch, false, `资料不写${field}`);
 assert.equal((await current()).thinkingSetting, "off"); assert.equal((await current()).fast, true);
 await page.unroute(`**/api/agents/${a.id}`, profileRoute);
 await stableShot(page, pane, join(out, "03-profile-draft.png"));
 console.log("PASS profile: draft survives category switch and failure; explicit save preserves model/thinking/Fast");
 await select("capabilities"); await pane.getByTestId("agent-skills").waitFor(); await pane.getByTestId("agent-extensions").waitFor();
 await select("models");
 await pane.getByTestId("agent-image-model").waitFor(); await pane.getByTestId("agent-subagent-model").waitFor();
 assert.equal(await pane.getByTestId("agent-skills").count(), 0); assert.equal(await pane.getByTestId("agent-host-tier").count(), 0);
 await select("tasks"); await pane.getByTestId("agent-background-tasks").waitFor();
 await select("routines", "agent-task-tabs"); await pane.getByTestId("routines-tab").waitFor();
 await select("proactive", "agent-task-tabs"); await pane.getByTestId("proactive-tab").waitFor();
 await select("memory"); await pane.getByTestId("memory-tab").waitFor();
 await select("files"); await pane.getByText("还没有文件。", { exact: true }).waitFor();
 await select("computer"); await pane.getByTestId("agent-host-tier").waitFor(); await pane.getByText("操作你的电脑", { exact: true }).waitFor();
 assert.match(await pane.innerText(), /工作区/);
 console.log("PASS classification: models/profile/capabilities/tasks/memory/files/computer all reachable, old functions retained");
 failHost = true; await select("models"); await select("computer");
 await pane.getByText("电脑状态读取失败", { exact: false }).waitFor(); failHost = false; await pane.getByTestId("agent-host-tier").getByRole("button", { name: "重试", exact: true }).click();
 await pane.getByText("操作你的电脑", { exact: true }).waitFor();
 failSkills = true; failExtensions = true; await select("capabilities");
 await pane.getByTestId("agent-skills").getByText(/技能目录读取失败/).waitFor();
 await pane.getByTestId("agent-extensions").getByText(/扩展目录读取失败/).waitFor();
 failSkills = false; failExtensions = false;
 await pane.getByTestId("agent-skills").getByRole("button", { name: "重试", exact: true }).click();
 await pane.getByTestId("agent-extensions").getByRole("button", { name: "重试", exact: true }).click();
 await pane.getByTestId("agent-skills-count").waitFor();
 const rejectSkills = (route) => route.request().method() === "PUT" ? fulfill(route, { error: "技能保存失败探针" }, 503) : route.continue();
 await page.route(`**/api/agents/${a.id}/skills`, rejectSkills);
 const skill = pane.getByTestId("agent-skills").getByRole("checkbox").first(); const wasEnabled = await skill.isChecked();
 await skill.click();
 await pane.getByTestId("agent-skills").getByText(/技能保存失败探针/).waitFor();
 await wait(async () => (await skill.isChecked()) === wasEnabled);
 assert.match(await pane.getByTestId("agent-skills").innerText(), /技能保存失败探针/, "读回成功不会吞掉保存失败");
 await page.unroute(`**/api/agents/${a.id}/skills`, rejectSkills);
 await stableShot(page, pane, join(out, "04-capabilities.png"));
 console.log("PASS empty/loading/error: skill/extension/host errors recover on retry; failed skill save rolls back while error remains visible");
 // 同样面板走单聊，技能/主动快捷跳转仍直接到对应分类。
 await page.goto(`${base}/?agent=${a.id}`);
 const infoButton = page.getByRole("button", { name: "信息面板", exact: true });
 await infoButton.waitFor(); // 系统/助理快照先就绪，才判断持久化的面板是否已开。
 if (!await pane.isVisible()) await infoButton.click();
 await select("models"); await pane.getByTestId("agent-thinking").waitFor();
 await wait(async () => /关闭/.test(await pane.getByTestId("agent-thinking").innerText()));
 await pane.getByRole("button", { name: "关闭", exact: true }).first().click();
 await page.getByTestId("skill-picker").click(); await page.getByTestId("skill-empty-goto").click();
 await pane.getByTestId("agent-skills").waitFor();
 assert.equal(await page.getByTestId("info-tabs").locator('[data-itab=capabilities]').getAttribute('aria-selected'), 'true');
 await pane.getByRole("button", { name: "关闭", exact: true }).first().click();
 await page.getByTestId("proactive-picker").click(); await page.getByTestId("proactive-menu").getByRole("button", { name: "更多设置", exact: true }).click();
 await pane.getByTestId("proactive-tab").waitFor();
 console.log("PASS direct chat: same persisted member setting; skill/proactive shortcuts reach their functional categories");
 for (const [skin, mode, width] of [["noir", "dark", 390], ["noir", "light", 390], ["pixel", "dark", 390], ["pixel", "light", 1440]]) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await page.evaluate(({ skin, mode }) => { localStorage.setItem('pia.skin', skin); localStorage.setItem('pia.theme', mode); localStorage.setItem('pia.layout', JSON.stringify({ sideCollapsed: true, info: false, paneW: 340 })); }, { skin, mode });
  await page.goto(`${base}/?room=${room.id}`); await page.getByTestId("room-members").locator(`button[title^="${a.name}"]`).click();
  await pane.getByTestId('overview-model-settings').click();
  await wait(async () => /关闭/.test(await pane.getByTestId('agent-thinking').innerText()));
  assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.skin, document.documentElement.dataset.mode]), [skin, mode]);
  await layout(); await stableShot(page, pane, join(out, `05-models-${skin}-${mode}-${width}.png`));
  await select('profile'); await layout();
  for (const key of expectKeys) { await select(key); await layout(); }
  if (width === 1440) {
   await page.getByRole('separator', { name: '调整信息面板宽度' }).focus();
   for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');
   await wait(async () => Math.abs((await pane.boundingBox()).width - 280) <= 1);
   for (const key of expectKeys) { await select(key); await layout(); }
   await stableShot(page, pane, join(out, '06-narrow-pane-280.png'));
  }
  const bar = page.getByTestId('info-tabs'); await bar.locator('[role=tab]').first().focus(); await page.keyboard.press('End');
  assert.equal(await bar.locator(':focus').count(), 1, '标签键盘End可达');
  if (await page.getByTestId('info-tabs-more').count()) { await page.getByTestId('info-tabs-more').focus(); await page.keyboard.press('ArrowDown'); await page.getByTestId('info-tabs-menu').waitFor(); await page.keyboard.press('Escape'); assert.equal(await page.getByTestId('info-tabs-more').evaluate(e => e === document.activeElement), true); }
 }
 assert.deepEqual(errors, []);
 console.log('PASS desktop/390: four skin/mode combinations, eight categories + more menu/keyboard, no overflow or JS errors');
} catch (e) { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(out, 'fixture-failed.png') }).catch(() => {}); console.error(server.logs().split('\n').filter(l => !/apikey|bearer|token/i.test(l)).slice(-12).join('\n')); throw e; }
finally { await browser?.close(); await server.stop(); cleanupTempRun(run); }
