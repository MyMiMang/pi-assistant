/** 真loopback SSE → Pi → 消息持久化 → 构建UI；服务错误由程序展示，不调用模型来解释。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
const root = fileURLToPath(new URL("..", import.meta.url)), run = makeTempRun("pia-model-error-");
const out = process.env.SHOT_DIR ?? join(root, "evidence/beta32-errors"); mkdirSync(out, { recursive: true });
const cases = [
 { key: "quota", error: { type: "usage_limit_reached", message: "You have hit your ChatGPT usage limit. Try again later." }, match: /额度已用完/ },
 { key: "rate_limit", error: { code: "rate_limit_exceeded", message: "429 Too many requests" }, match: /限流/ },
 { key: "auth", error: { code: "invalid_api_key", message: "401 authentication failed" }, match: /鉴权失败/ },
 { key: "timeout", error: { message: "Request timed out." }, match: /超时/ },
 { key: "unknown", error: { message: "fixture provider returned an unknown failure" }, match: /fixture provider/ },
 { key: "unknown", empty: true, match: /未收到回复.*未提供具体原因/ },
];
let index = 0;
const relay = createServer(async (req, res) => {
 let raw = "";
 for await (const chunk of req) raw += chunk;
 const c = cases[Number(String(JSON.parse(raw).model).split("-").at(-1))];
 index++;
 res.writeHead(200, { "content-type": "text/event-stream" });
 if (!c?.empty) { res.end(`data: ${JSON.stringify({ error: c?.error ?? { message: "unexpected fixture request" } })}\n\n`); return; }
 res.end(`data: ${JSON.stringify({ id: "empty-fixture", object: "chat.completion.chunk", model: "error-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
const relayPort = await new Promise(r => relay.listen(0, "127.0.0.1", () => r(relay.address().port)));
const reserve = createServer(); const port = await new Promise(r => reserve.listen(0, "127.0.0.1", () => { const p = reserve.address().port; reserve.close(() => r(p)); }));
const base = `http://127.0.0.1:${port}`, server = startTempServer({ root, port, run }); let browser;
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path}: ${r.status}`); return r.json(); };
const wait = async (fn, label, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(`timeout: ${label}`); };
try {
 await wait(async () => (await fetch(base + "/api/system/public")).ok, "server", 30000); await j("/api/settings", "PUT", { onboarded: true });
 const service = await j("/api/models/custom", "POST", { name: "服务错误回归", api: "openai-completions", baseUrl: `http://127.0.0.1:${relayPort}/v1`, noKey: true, models: cases.map((_, n) => ({ id: `error-fixture-${n}`, reasoning: false })) });
 const agent = await j("/api/agents", "POST", { name: "错误原因验证", model: { provider: service.id, id: "error-fixture-0" } });
 browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
 const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); const errors = []; page.on("pageerror", e => errors.push(e.message));
 await page.goto(`${base}/?agent=${agent.id}`); await page.getByTestId("model-picker").waitFor();
 const msgs = () => j(`/api/agents/${agent.id}/messages?limit=50`);
 for (let n = 0; n < cases.length; n++) {
  await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: service.id, id: `error-fixture-${n}` } });
  const prior = new Set((await msgs()).map(m => m.id));
  await j(`/api/agents/${agent.id}/messages`, "POST", { text: `第${n + 1}轮错误回归` });
  await wait(async () => (await msgs()).some(m => !prior.has(m.id) && m.role === "assistant" && m.status === "error"), `persisted error ${n}`);
  // 临时限流/超时保留Pi原有重试。此用例在首个错误落库后用公开停止入口取消backoff，专验可见报错与停止。
  if (cases[n].key === "rate_limit" || cases[n].key === "timeout") await j(`/api/agents/${agent.id}/abort`, "POST");
  await wait(async () => (await j("/api/agents")).find(a => a.id === agent.id)?.status === "idle", `idle after error ${n}`);
  await page.reload(); await page.getByTestId("model-picker").waitFor();
  const stored = (await msgs()).filter(m => !prior.has(m.id) && m.role === "assistant" && m.status === "error").at(-1);
  const err = page.locator(`[data-mid="${stored.id}"]`).getByTestId("msg-error"); await err.waitFor();
  assert.equal(await err.getAttribute("data-kind"), cases[n].key); assert.match(await err.innerText(), cases[n].match);
  if (n === 0) {
   assert.doesNotMatch(await err.innerText(), /重发/);
   await err.getByTestId("msg-error-detail").locator("summary").click();
   assert.match(await err.innerText(), /ChatGPT usage limit/);
   await stableShot(page, err, join(out, "01-quota-desktop.png"));
   await page.setViewportSize({ width: 390, height: 844 }); await err.scrollIntoViewIfNeeded();
   await stableShot(page, err, join(out, "02-quota-390.png"));
   const b = await err.boundingBox(); assert.ok(b && b.x >= -1 && b.x + b.width <= 391);
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
   await page.setViewportSize({ width: 1280, height: 900 });
  }
 }
 assert.equal(index, cases.length, "仅6请求；quota无重试/无额外模型解释；rate和timeout首错后明确取消原有backoff");
 assert.deepEqual(errors, []);
 console.log("PASS 服务错误真链6轮：额度/临时限流/鉴权/超时/未知/空最终 → error落库、刷新仍可见；额度详情可展开，390不越界；6请求，quota不重试，临时限流/超时按公开停止取消既有backoff后idle");
} catch (error) {
 console.error("fixture diagnostics", { requests: index, serverExit: server.child.exitCode, signal: server.child.signalCode });
 console.error(server.logs().slice(-6000));
 throw error;
} finally {
 await browser?.close().catch(() => {}); await server.stop(); relay.closeAllConnections(); await new Promise(r => relay.close(r)); cleanupTempRun(run);
}
