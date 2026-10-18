/** 群成员改名/改头像后，群头「管理者」、成员条、@ 列表不刷新也跟着变。隔离临时服务/Mock。 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { infoTab, agentProfileSave } from "./fixtures/info-pane.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-room-rename-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); assert.ok(r.ok, `${method} ${path} ${r.status}`); return r.json(); };
const wait = async (fn, ms = 15000, what = "condition") => { const until = Date.now() + ms; while (Date.now() < until) { if (await fn()) return; await new Promise((r) => setTimeout(r, 80)); } throw new Error(`${what} timed out`); };
let browser;
try {
 await wait(async () => { try { return (await fetch(base + "/api/system")).ok; } catch { return false; } });
 await j("/api/settings", "PUT", { onboarded: true });
 const lin = await j("/api/agents", "POST", { name: "林导", model: { provider: "mock", id: "echo" } });
 const other = await j("/api/agents", "POST", { name: "编剧", model: { provider: "mock", id: "echo" } });
 const room = await j("/api/rooms", "POST", { name: "短剧组", memberIds: [lin.id, other.id], managerId: lin.id });
 browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
 const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(7000);
 const errors = []; page.on("pageerror", (e) => errors.push(e.message));
 await page.goto(`${base}/?room=${room.id}`);
 const members = page.getByTestId("room-members"); await members.waitFor();
 await page.getByText("管理者 林导").first().waitFor();
 // 通过成员资料页改名（真实保存路径），不刷新页面
 await members.locator('button[title^="林导"]').click();
 const pane = page.locator(".pa-pane-wrap");
 await infoTab(page, "profile");
 const name = pane.getByPlaceholder("给助理起个名字"); await name.waitFor();
 await name.fill("导演");
 await agentProfileSave(pane).click();
 await wait(async () => (await j("/api/agents")).find((a) => a.id === lin.id).name === "导演", 10000, "名字落库");
 await wait(async () => (await page.getByText("管理者 导演").count()) > 0, 10000, "群头管理者名字更新");
 assert.equal(await page.getByText("管理者 林导").count(), 0, "群头不再显示旧名字");
 await wait(async () => (await members.locator('button[title^="导演"]').count()) === 1, 10000, "成员条更新");
 assert.equal(await members.locator('button[title^="林导"]').count(), 0, "成员条不再有旧名字");
 // @ 列表
 await page.getByTestId("mention-btn").click();
 const list = page.getByTestId("mention-list"); await list.waitFor();
 assert.match(await list.innerText(), /导演/); assert.doesNotMatch(await list.innerText(), /林导/);
 await page.keyboard.press("Escape");
 // 第二次改名（同一面板、不刷新）仍即时生效
 await infoTab(page, "profile");
 await name.fill("总导演");
 await agentProfileSave(pane).click();
 await wait(async () => (await page.getByText("管理者 总导演").count()) > 0, 10000, "第二次改名群头更新");
 await wait(async () => (await members.locator('button[title^="总导演"]').count()) === 1, 10000, "第二次改名成员条更新");
 await page.getByTestId("mention-btn").click(); await list.waitFor();
 assert.match(await list.innerText(), /总导演/); assert.doesNotMatch(await list.innerText(), /林导|\n导演/);
 await page.keyboard.press("Escape");
 // 侧栏群聊条目（叠放头像）不留旧名字的默认头像
 const side = page.getByTestId("sidebar-room").filter({ hasText: "短剧组" }).first(); await side.waitFor();
 await wait(async () => !/林导/.test(await side.innerText()), 10000, "侧栏群条目不留旧名");
 // 头像同理：服务端改头像后成员条跟着变
 await j(`/api/agents/${other.id}`, "PATCH", { avatar: "🎬" });
 await wait(async () => /🎬/.test(await members.innerText()), 10000, "成员条头像更新");
 assert.deepEqual(errors, []);
 console.log("PASS room-member-rename: 改名/改头像后群头、成员条、@ 列表即时更新");
} finally {
 await browser?.close();
 await server.stop?.();
 cleanupTempRun(run);
}
