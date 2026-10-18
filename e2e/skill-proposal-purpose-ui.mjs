/** 真实Pi Mock→自动候选→同会话用途总结→提问卡→用户同意→查重保存；隔离、无付费模型。 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-skill-purpose-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`, server = startTempServer({ root, port, run });
const out = process.env.SHOT_DIR ?? join(root, "evidence/beta32-skill-purpose"); mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path} ${r.status}`); return r.json(); };
const wait = async (fn, ms = 20000) => { const until = Date.now() + ms; while (Date.now() < until) { if (await fn()) return; await new Promise((r) => setTimeout(r, 80)); } throw new Error("condition timed out"); };
let browser;
try {
 await wait(async () => { try { return (await fetch(base + "/api/system")).ok; } catch { return false; } });
 await j("/api/settings", "PUT", { onboarded: true });
 const a = await j("/api/agents", "POST", { name: "技能用途验证", model: { provider: "mock", id: "echo" } });
 browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
 const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(8000);
 const errors = []; page.on("pageerror", (e) => errors.push(e.message));
 await page.goto(`${base}/?agent=${a.id}`); await page.getByTestId("model-picker").waitFor();
 await j(`/api/agents/${a.id}/messages`, "POST", { text: "帮我做一下月度汇总" });
 const card = page.locator(".pa-question").filter({ hasText: "月度数据汇总" }).last();
 await card.waitFor({ timeout: 20000 });
 const text = await card.innerText();
 assert.match(text, /做什么：汇总各月销售额，找出最高月份并统计记录数/);
 assert.match(text, /什么时候用：下次整理每月销售数据时/);
 assert.match(text, /能给你：销售合计、最高月份和记录数的摘要/);
 assert.doesNotMatch(text, /步骤比较多|经常提|读文件|写文件|运行命令/);
 assert.equal((await j("/api/skills")).filter((s) => s.name === "monthly-summary").length, 0, "没有点同意之前不创建");
 const geometry = async () => card.evaluate((el) => {
   const b = el.getBoundingClientRect(), title = el.querySelector("b");
   return { x: b.x, right: b.right, width: innerWidth, overflow: el.scrollWidth > el.clientWidth + 1, preline: getComputedStyle(title).whiteSpace === "pre-line", h: title.getBoundingClientRect().height, font: parseFloat(getComputedStyle(title).lineHeight) };
 });
 let g = await geometry(); assert.equal(g.overflow, false); assert.ok(g.preline && g.h > g.font * 3);
 await wait(async () => (await j("/api/agents")).find((x) => x.id === a.id).status === "idle");
 assert.ok(!(await j(`/api/agents/${a.id}/messages?limit=100`)).some(m => m.role === "assistant" && m.status === "error"), "正常等待用途卡不能误报空回复故障");
 assert.equal(await page.getByTestId("msg-error").count(), 0);
 await stableShot(page, card, join(out, "01-skill-purpose-desktop.png"));
 await page.setViewportSize({ width: 390, height: 844 }); await card.scrollIntoViewIfNeeded();
 g = await geometry(); assert.ok(g.x >= 0 && g.right <= g.width + 1 && !g.overflow);
 await stableShot(page, card, join(out, "02-skill-purpose-mobile.png"));
 await wait(async () => (await j("/api/agents")).find((x) => x.id === a.id).status === "idle");
 assert.equal((await j("/api/skills")).filter((s) => s.name === "monthly-summary").length, 0);
 console.log("PASS automatic skill proposal: concrete purpose/use/output before consent, desktop/mobile boundaries, unanswered card leaves agent idle");
 await card.getByRole("button", { name: "做成技能", exact: true }).click();
 await wait(async () => (await j("/api/skills")).some((s) => s.name === "monthly-summary"));
 const saved = await j("/api/skills/monthly-summary"); assert.match(saved.body, /合计/);
 await wait(async () => (await j(`/api/agents/${a.id}/messages?limit=100`)).some((m) => m.role === "assistant" && /存好了/.test(m.content)));
 const msgs = await j(`/api/agents/${a.id}/messages?limit=100`);
 const calls = msgs.filter((m) => m.role === "tool").map((m) => m.meta.toolName);
 assert.ok(calls.indexOf("skill_propose") >= 0 && calls.indexOf("skill_propose") < calls.indexOf("skill_search") && calls.indexOf("skill_search") < calls.indexOf("skill_save"));
 assert.equal(msgs.filter((m) => m.meta?.kind === "approval" && m.meta?.toolName === "skill_save").length, 0, "同意后没有第二次新建确认");
 assert.ok(!msgs.some((m) => m.role === "assistant" && /内部步骤|suggestionId/.test(m.content)), "不泄露内部指令");
 assert.deepEqual(errors, []);
 console.log("PASS consent chain: same Pi session proposes, idle while awaiting user, accepted continuation searches before save, persisted skill, no second create prompt");
 // 保存后卡片保留已回答状态，助理恢复空闲。
 await wait(async () => (await j("/api/agents")).find((x) => x.id === a.id).status === "idle");
 assert.ok((await card.innerText()).includes("已回答"));
} catch (e) { console.error(server.logs().split("\n").filter((l) => !/apiKey|bearer|token/i.test(l)).slice(-14).join("\n")); throw e; }
finally { await browser?.close(); await server.stop(); cleanupTempRun(run); }
