/**
 * 定向验证（不跑全量 e2e，不用真实模型）：
 *  1) 导航：助理 header 最顶、没有顶部子代理 tabs 条、「主会话」紧邻「子代理」入口；
 *  2) 聊天里不再渲染子代理指令大卡；
 *  3) 任务概览：短标题（前端有界摘要，不含整段 prompt）+ 状态 badge + 执行者；运行/排队优先，已结束折叠；
 *  4) 任务详情：默认不摊全文，「查看任务说明」折叠展开；Steps 汇总「N 个步骤 · M 成功 · K 失败」+ 失败步骤点名；
 *  5) 待发送附件：paste → 72px 缩略图 → 点开 ImageViewer → 移除 → 发送；非图片仍是文件 chip；390 不溢出。
 * 运行前先构建：npm run build -w @pi-assistant/web
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = new URL("..", import.meta.url);
const { fileURLToPath } = await import("node:url");
const REPO = fileURLToPath(ROOT);
const OUT = "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/evidence/task-ui";
const DATA = "/tmp/pia-verify-task-ui";
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = readFileSync(join(REPO, "apps", "web", "public", "icon-192.png")).toString("base64");
const LONG_TASK = "（后台子代理任务）用户明确要求检查并补齐文档维护规则与真实记录：计划需求要记录、每次做完更新做了什么/验证/剩余，不可代码很多文档滞后。 workspace /Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/pi-assistant-release 最新发布 beta19 基线（先核实 git 状态不要 reset/pull 影响活跃模型 UI 代理 sa_mv8cz0m7jljag3）。";
/** 只出现在长任务后半段的独特片段：短标题里绝不该出现 */
const TAIL_MARK = "先核实 git 状态不要 reset/pull";
rmSync(DATA, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let server, browser;
const waitFor = async (fn, ms = 25_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`); return data; };
const start = async () => { server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], { cwd: REPO, env: { ...process.env, PIA_DATA_DIR: DATA, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] }); server.stdout.on("data", (d) => process.stdout.write(d)); server.stderr.on("data", (d) => process.stderr.write(d)); await waitFor(async () => (await fetch(BASE + "/api/system")).ok); };
const stop = async () => { if (!server || server.exitCode !== null) return; const done = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await done; };
let failed = 0;
const check = (name, cond, detail = "") => { if (cond) console.log(`  ✅ ${name}`); else { failed++; console.error(`  ❌ ${name} ${detail}`); } };

const now = Date.now();
let RUNNING, QUEUED, DONE, DETAIL_MSGS;
const mk = (o) => ({ agent_id: AGENT_ID, conversation_id: CONV_ID, model_provider: "mock", model_id: "mock-1", model_reason: "跟随主会话模型", last_activity_at: now, error_reason: null, result_summary: null, ...o });
let AGENT_ID = "";
let CONV_ID = "";

try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "任务 UI 验证" });
	AGENT_ID = a.id;
	CONV_ID = (await j(`/api/agents/${a.id}/conversations`)).current ?? "";
	assert.ok(CONV_ID, "需要拿到助理的当前对话 id");
	RUNNING = mk({ id: "sub-run-1", task: LONG_TASK, status: "running", last_activity_at: now - 6000 });
	QUEUED = mk({ id: "sub-queued-1", task: "排队等空位的任务：整理下载目录里最近 30 天的截图并生成清单", status: "queued" });
	DONE = mk({ id: "sub-done-1", task: "跟进 beta.16 打包与发布", status: "done", last_activity_at: now - 3 * 3600_000 });
	DETAIL_MSGS = [
		{ id: "m1", agent_id: AGENT_ID, task_id: null, role: "tool", content: "", meta: { toolName: "bash", args: { command: "npm test" }, result: "1 failing" }, status: "error", created_at: now - 9000, updated_at: now - 8000 },
		{ id: "m2", agent_id: AGENT_ID, task_id: null, role: "assistant", content: "这一步命令失败了，我换个方式继续。", meta: {}, status: "done", created_at: now - 7000, updated_at: now - 6000 },
	];
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (e) => { console.error("pageerror:", e); failed++; });
	let uploads = 0;
	page.on("request", (r) => { if (r.method() === "POST" && /\/(agents|rooms)\/[^/]+\/upload$/.test(new URL(r.url()).pathname)) uploads++; });

	await page.route((u) => u.pathname === "/api/subagents", (r) => r.fulfill({ json: [RUNNING, QUEUED, DONE] }));
	await page.route((u) => u.pathname === "/api/subagents/sub-run-1", (r) => r.fulfill({ json: { subagent: RUNNING, messages: DETAIL_MSGS } }));
	await page.route((u) => u.pathname === "/api/subagents/sub-queued-1", (r) => r.fulfill({ json: { subagent: QUEUED, messages: [] } }));
	await page.route((u) => u.pathname === "/api/subagents/sub-done-1", (r) => r.fulfill({ json: { subagent: DONE, messages: DETAIL_MSGS } }));
	await page.goto(`${BASE}/?agent=${a.id}`);
	await page.locator("[data-testid=main-conversation] .pa-composer").waitFor();
	await page.waitForTimeout(700);

	// ---------------- 1) 导航结构
	console.log("\n[1] 导航：header 最顶 / 无 tabs 条 / 主会话紧邻子代理");
	check("顶部子代理 tabs 卡片条已移除", (await page.getByTestId("subagent-tabs").count()) === 0);
	check("聊天里不再渲染子代理指令大卡", (await page.getByTestId("subagent-card").count()) === 0);
	const top = await page.evaluate(() => { const main = document.querySelector("main.pa-chat"); const first = main?.firstElementChild; return { hasHeader: !!first?.querySelector("header.pa-chat-head"), isConversation: first?.getAttribute("data-testid") === "main-conversation" }; });
	check("助理身份 header 在最顶（主区域第一个元素就是会话，会话里第一个是 header）", top.hasHeader && top.isConversation, JSON.stringify(top));
	const adjacent = await page.evaluate(() => document.querySelector("[data-testid=subagent-main]")?.nextElementSibling?.getAttribute("data-testid") ?? null);
	check("「主会话」紧邻「子代理」入口", adjacent === "subagent-tasks", String(adjacent));
	check("「子代理」入口显示运行中的数量", ((await page.getByTestId("subagent-tasks").textContent()) ?? "").includes("2"), (await page.getByTestId("subagent-tasks").textContent()) ?? "");
	await page.screenshot({ path: join(OUT, "01-nav-1280.png") });

	// ---------------- 2) 任务概览
	console.log("\n[2] 任务概览：短标题 / 状态 / 执行者 / 运行排队优先");
	await page.getByTestId("subagent-tasks").click();
	const modal = page.getByTestId("task-overview");
	await modal.waitFor();
	check("弹窗标题是「任务」", ((await modal.locator("div").first().textContent()) ?? "").includes("任务"));
	const rows = modal.locator('[data-testid=subagent-row]:visible');
	check("进行中 + 排队 在前（2 条可见）", (await rows.count()) === 2, String(await rows.count()));
	const firstRow = (await rows.first().textContent()) ?? "";
	check("第一行是运行中的任务且带状态 badge", firstRow.includes("运行中"), firstRow);
	check("短标题不含整段 prompt（截断到 1-2 行）", !firstRow.includes(TAIL_MARK), firstRow.slice(0, 80));
	check("短标题长度有界（<=46 字）", firstRow.replace(/运行中|排队中|子代理 ·.*/g, "").trim().length <= 46, String(firstRow.length));
	check("行里带执行者说明", firstRow.includes("子代理 · "), firstRow);
	check("已结束任务默认折叠（可见行只有 2 条）", (await modal.locator('[data-testid=subagent-row]:visible').count()) === 2);
	await modal.getByTestId("task-finished").locator("summary").click();
	await modal.getByText("跟进 beta.16 打包与发布").waitFor();
	check("展开后能看到已完成任务", (await modal.getByText("跟进 beta.16 打包与发布").count()) > 0);
	const m390 = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: innerWidth, modal: (() => { const el = document.querySelector(".pa-modal"); return el ? el.scrollWidth - el.clientWidth : 0; })() }));
	check("概览弹窗无横向溢出", m390.doc <= m390.vw && m390.modal <= 1, JSON.stringify(m390));
	await page.screenshot({ path: join(OUT, "02-task-overview.png") });

	// ---------------- 3) 详情：默认不摊全文 + Steps 失败汇总
	console.log("\n[3] 任务详情：默认折叠全文 / 折叠展开 / Steps 失败汇总");
	const runRow = rows.first();
	await runRow.focus();
	await page.keyboard.press("Enter");
	const detail = page.locator('[data-testid="subagent-detail"]:visible');
	await detail.waitFor();
	check("键盘 Enter 能打开详情", await detail.isVisible());
	const headTxt = (await detail.locator("header").first().textContent()) ?? "";
	check("详情头部用「任务：短标题」", headTxt.includes("任务：") && !headTxt.includes(TAIL_MARK), headTxt.slice(0, 60));
	const note = detail.getByTestId("task-instructions");
	await note.waitFor();
	const noteBody = note.locator("p");
	check("全文默认折叠（看不到原文）", !(await noteBody.isVisible()));
	await note.locator("summary").click();
	await noteBody.waitFor();
	const body = (await noteBody.textContent()) ?? "";
	check("展开后能看到完整指令（含长路径）", body.includes("/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/pi-assistant-release"), body.slice(0, 60));
	const pre = await noteBody.evaluate((el) => getComputedStyle(el).whiteSpace);
	check("全文按段落换行显示（pre-wrap）", pre === "pre-wrap", pre);
	const over = await noteBody.evaluate((el) => el.scrollWidth - el.clientWidth);
	check("长路径不横向溢出", over <= 1, String(over));
	const steps = (await detail.getByTestId("steps").first().textContent()) ?? "";
	check("Steps 汇总显示成功/失败个数", /\d+ 个步骤 · \d+ 成功 · \d+ 失败/.test(steps), steps);
	check("Steps 点名失败步骤，且说明任务继续", steps.includes("运行命令失败（这一步失败，任务继续）"), steps);
	check("详情有停止按钮", (await detail.getByTestId("subagent-stop").count()) === 1);
	await page.screenshot({ path: join(OUT, "03-task-detail.png") });
	await detail.getByLabel("返回主会话").click();
	await page.waitForTimeout(300);
	check("返回主会话可用", (await page.locator('[data-testid="subagent-detail"]:visible').count()) === 0);
	// 已经结束、没有任何在跑的任务：失败步骤不能无依据地说「任务继续」
	await page.getByTestId("subagent-tasks").click();
	await page.getByTestId("task-overview").getByTestId("task-finished").locator("summary").click();
	await page.getByTestId("task-overview").getByText("跟进 beta.16 打包与发布").click();
	const doneDetail = page.locator('[data-testid="subagent-detail"]:visible');
	await doneDetail.waitFor();
	const doneSteps = (await doneDetail.getByTestId("steps").first().textContent()) ?? "";
	check("任务已结束时只说「运行命令失败」，不声称任务继续", doneSteps.includes("运行命令失败") && !doneSteps.includes("任务继续"), doneSteps);
	await doneDetail.getByLabel("返回主会话").click();
	await page.waitForTimeout(300);

	// ---------------- 4) 待发送附件：缩略图 / 查看器 / 移除 / 发送
	console.log("\n[4] 待发送图片：缩略图 → 查看器 → 移除 → 发送");
	const box = page.locator("[data-testid=main-conversation] .pa-composer textarea");
	const paste = async (name) => {
		await page.evaluate(
			({ b64, n }) => {
				const el = document.querySelector("[data-testid=main-conversation] .pa-composer textarea");
				const bin = atob(b64);
				const arr = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
				const dt = new DataTransfer();
				dt.items.add(new File([arr], n, { type: "image/png" }));
				el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
			},
			{ b64: PNG, n: name },
		);
	};
	await paste("粘贴的图片-验证.png");
	const thumb = page.getByTestId("attach-thumb");
	await thumb.first().waitFor();
	await waitFor(async () => !(await page.locator("[data-testid=attach-tray] .animate-spin").count()));
	const tb = await thumb.first().boundingBox();
	check("缩略图约 72px", tb && Math.abs(tb.width - 72) <= 2 && Math.abs(tb.height - 72) <= 2, JSON.stringify(tb));
	check("缩略图是真图（有像素）", await thumb.first().locator("img").evaluate((el) => el.naturalWidth > 0));
	check("图片只上传一次（预览不重复上传）", uploads === 1, `uploads=${uploads}`);
	await thumb.first().click();
	await page.getByTestId("image-viewer").waitFor();
	check("点缩略图打开全屏查看器", await page.getByTestId("image-viewer").isVisible());
	await page.keyboard.press("Escape");
	await page.getByTestId("image-viewer").waitFor({ state: "detached" });
	await page.getByTestId("attach-remove").first().click();
	check("移除后附件条清空", (await page.getByTestId("attach-thumb").count()) === 0);
	// 非图片仍是文件 chip
	await page.locator("[data-testid=main-conversation] input[type=file]").setInputFiles({ name: "长名字长名字长名字的说明文档.txt", mimeType: "text/plain", buffer: Buffer.from("附件缩略图验证") });
	await page.getByTestId("attach-chip").first().waitFor();
	check("非图片保留文件 chip", (await page.locator('[data-testid=attach-chip][data-kind=file]').count()) === 1);
	await page.getByTestId("attach-remove").first().click();
	// 再粘一张并发送
	await paste("粘贴的图片-发送.png");
	await thumb.first().waitFor();
	await waitFor(async () => !(await page.locator("[data-testid=attach-tray] .animate-spin").count()));
	await page.locator("[data-testid=main-conversation] button[aria-label=发送]").click();
	await page.locator("[data-testid=main-conversation] [data-testid=image-attachment] img").first().waitFor({ timeout: 30_000 });
	check("发送后附件出现在消息里", (await page.locator("[data-testid=main-conversation] [data-testid=image-attachment]").count()) >= 1);
	await page.screenshot({ path: join(OUT, "04-attachment-sent.png") });

	// ---------------- 5) 390：任务概览 + 附件条不溢出
	console.log("\n[5] 390 窄屏：无横向溢出");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(400);
	await paste("粘贴的图片-390.png");
	await thumb.first().waitFor();
	await waitFor(async () => !(await page.locator("[data-testid=attach-tray] .animate-spin").count()));
	const m = await page.evaluate(() => { const tray = document.querySelector("[data-testid=attach-tray]"); return { doc: document.documentElement.scrollWidth, vw: innerWidth, tray: tray ? tray.scrollWidth - tray.clientWidth : 0 }; });
	check("390：附件条与页面不横向溢出", m.doc <= m.vw && m.tray <= 1, JSON.stringify(m));
	await page.screenshot({ path: join(OUT, "05-390-composer.png") });
	await page.getByTestId("subagent-tasks").click();
	await page.getByTestId("task-overview").waitFor();
	const m2 = await page.evaluate(() => { const el = document.querySelector(".pa-modal"); const scroller = el?.querySelector(".overflow-y-auto"); return { doc: document.documentElement.scrollWidth, vw: innerWidth, modal: el ? el.scrollWidth - el.clientWidth : 0, overflowY: scroller ? getComputedStyle(scroller).overflowY : "none" }; });
	check("390：任务概览不横向溢出，内容超出时可纵向滚动", m2.doc <= m2.vw && m2.modal <= 1 && m2.overflowY === "auto", JSON.stringify(m2));
	await page.screenshot({ path: join(OUT, "06-390-overview.png") });
	await page.keyboard.press("Escape");
} catch (e) {
	console.error("异常：", e);
	failed++;
} finally {
	await browser?.close();
	await stop();
}
assert.equal(failed, 0, `${failed} 项未通过`);
console.log("\n全部通过 ✅  截图：", OUT);
