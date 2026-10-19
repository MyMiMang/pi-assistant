/**
 * 群里的帮手（决策 0014 第 5 步，真实服务 / 真实 PiMock / 真实构建页面）：
 *  1) 编剧在群里派帮手：帮手自动带上角色范围（代表谁、职责、不归它管的角色、不直接找成员 / 协调者）；
 *  2) 帮手再派一层（继承同样的范围、带完成标准），下一层结果交回上一层整合，不唤醒主会话；
 *  3) 可见性：群消息里没有帮手的工具步骤；用户在群的「子代理」概览里能看到每个帮手（含下一层）并打开完整详情；
 *     设置默认 owner（派它的助理 + 用户）。
 * 全程临时 DATA/WORKSPACE/HOME/TMPDIR + 内存凭据 + loopback Mock，不碰生产库 / 凭据 / 付费模型。
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
const run = makeTempRun("pia-group-helpers-");
const port = await new Promise((resolve) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run, log: process.env.GH_DEBUG ? (d) => process.stdout.write(d) : undefined });
const out = process.env.SHOT_DIR ?? artifactDir("screenshots");
mkdirSync(out, { recursive: true });
const j = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let d = {}; try { d = JSON.parse(t); } catch {} if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${t.slice(0, 300)}`); return d; };
const wait = async (fn, ms = 30000, label = "condition") => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`${label} timed out`); };
let browser;
try {
	await wait(async () => (await fetch(base + "/api/system")).ok, 30000, "server");
	await j("/api/settings", "PUT", { onboarded: true });
	await j("/api/models/default", "PUT", { provider: "mock", model: "echo" }).catch(() => {});
	const mk = (name, persona) => j("/api/agents", "POST", { name, persona, model: { provider: "mock", id: "echo" } });
	const director = await mk("组长", "你在群里的角色：导演\n统筹分工、核验成片");
	const writer = await mk("小编", "你在群里的角色：编剧\n负责写剧本和台词");
	const artist = await mk("小美", "你在群里的角色：美术\n负责画分镜图");
	const room = await j("/api/rooms", "POST", { name: "短片组", memberIds: [director.id, writer.id, artist.id], managerId: director.id });
	assert.equal((await j("/api/settings/group-helper-detail")).value, "owner", "默认：完整详情只有派它的助理和用户能看");

	console.log("[1] 编剧派帮手：自动带角色范围；帮手再派一层，结果交回上一层");
	await j(`/api/rooms/${room.id}/messages`, "POST", { text: "@小编 派个子代理分两块写剧本" });
	const helpers = () => j(`/api/subagents?agent=${writer.id}&room=${room.id}`);
	let top, kid;
	await wait(async () => {
		const hs = await helpers();
		top = hs.find((h) => !h.parent_subagent_id);
		kid = hs.find((h) => h.parent_subagent_id === top?.id);
		return top?.status === "done" && kid?.status === "done";
	}, 60000, "两层帮手都完成");
	assert.match(top.scope, /代表群「短片组」里的 小编（角色：编剧）/);
	assert.match(top.scope, /负责写剧本和台词/);
	assert.match(top.scope, /小美（美术）/);
	assert.match(top.scope, /组长（协调者）/);
	assert.match(top.scope, /不要直接联系群里的其他成员或协调者/);
	assert.equal(kid.scope, top.scope, "下一层继承同样的范围");
	assert.match(kid.context, /完成标准：三场台词格式统一/);
	assert.match(top.result_summary, /整合了下一层帮手的结果/, "上一层收到下一层结果并整合");
	const topDetail = await j(`/api/subagents/${top.id}`);
	assert.ok(topDetail.messages.some((m) => m.role === "tool" && m.meta?.toolName === "spawn_subagent"), "上一层的步骤里有派下一层");
	const kidDetail = await j(`/api/subagents/${kid.id}`);
	assert.ok(kidDetail.messages.some((m) => m.role === "tool" && m.meta?.toolName === "bash"), "下一层的命令在它自己的详情里");

	console.log("[2] 群里只有概况：没有帮手的工具步骤和命令输出");
	const roomMsgs = await j(`/api/rooms/${room.id}/messages`);
	assert.ok(!roomMsgs.some((m) => m.subagent_id), "帮手消息不进群");
	assert.ok(!roomMsgs.some((m) => /第二块完成：台词格式统一/.test(String(m.content ?? "")) && m.role === "tool"), "命令输出不进群");

	console.log("[3] 用户在群的概览里看到每个帮手（含下一层），能打开完整详情");
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
	page.setDefaultTimeout(10000);
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(e.message));
	await page.goto(`${base}/?room=${room.id}`);
	await page.getByTestId("room-chat").waitFor();
	await page.getByTestId("subagent-tasks").click();
	await page.getByTestId("task-overview").waitFor();
	const finished = page.getByTestId("task-finished");
	if (await finished.count()) await finished.locator("summary").click();
	const kidRow = page.locator(`[data-testid=subagent-row][data-id="${kid.id}"]`);
	await kidRow.waitFor();
	assert.match(await kidRow.innerText(), /下一层帮手/);
	await stableShot(page, page.getByTestId("task-overview"), join(out, "group-helpers-overview.png"));
	await page.locator(`[data-testid=subagent-row][data-id="${top.id}"]`).click();
	const detail = page.locator('[data-testid="subagent-detail"]:visible');
	await detail.waitFor();
	await detail.getByText(/整合了下一层帮手的结果/).first().waitFor();
	await stableShot(page, detail, join(out, "group-helpers-detail.png"));
	assert.deepEqual(pageErrors, []);
	console.log("PASS group-helpers: 角色范围自动带上、最多一层且继承范围、下一层结果交回上一层、群里只有概况、用户能开完整详情");
} finally {
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
