// 把文件拖到聊天框 = 点「上传」：单聊、群聊各拖一个文件，确认它出现在输入框附件里、能随消息发出。
// 桌面 App 里网页能收到拖放，靠的是主窗口关掉 Tauri 自带的拖放拦截（apps/tray/src-tauri/src/main.rs 的 disable_drag_drop_handler），这里只测网页这一侧。
// 用法：先 `npm run build -w @pi-assistant/web`，再 `node e2e/chat-file-drop.mjs`。临时数据 + Mock 模型。
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { artifactDir } from "./fixtures/artifacts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-chat-file-drop-");
const SHOTS = artifactDir("chat-file-drop");
const PORT = await new Promise((resolve) => { const sv = createServer().listen(0, "127.0.0.1", () => { const p = sv.address().port; sv.close(() => resolve(p)); }); });
const BASE = `http://127.0.0.1:${PORT}`;

let server, browser;
const waitFor = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
const j = async (path, method = "GET", body) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`); return data; };

/** 模拟从 Finder / 资源管理器拖一个文件进来：在输入框上依次触发 dragover → drop（事件冒泡到聊天区的拖放处理） */
async function dropFile(page, target, name, text) {
	const dt = await page.evaluateHandle(([n, t]) => { const d = new DataTransfer(); d.items.add(new File([t], n, { type: "text/plain" })); return d; }, [name, text]);
	await target.dispatchEvent("dragover", { dataTransfer: dt });
	await target.dispatchEvent("drop", { dataTransfer: dt });
}

try {
	server = startTempServer({ root: ROOT, port: PORT, run, log: (d) => process.stdout.write(String(d)) });
	await waitFor(async () => (await fetch(BASE + "/api/system")).ok);
	await j("/api/settings", "PUT", { onboarded: true });
	const a = await j("/api/agents", "POST", { name: "拖文件测试" });
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
	page.setDefaultTimeout(15_000);

	// 单聊：拖进来出现在附件栏，发出去后消息里带着这个文件
	await page.goto(`${BASE}/?agent=${a.id}`);
	const box = page.locator("[data-testid=main-conversation] .pa-composer textarea");
	await box.waitFor();
	await dropFile(page, box, "拖进来的笔记.txt", "单聊拖放内容");
	const chip = page.locator("[data-testid=main-conversation] [data-testid=attach-chip]");
	await chip.waitFor();
	assert.match((await chip.getAttribute("title")) ?? "", /拖进来的笔记\.txt/, "附件栏显示拖进来的文件名");
	await page.screenshot({ path: join(SHOTS, "01-single-dropped.png") });
	await box.fill("看看这个文件");
	await box.press("Enter");
	await waitFor(async () => {
		const r = await j(`/api/agents/${a.id}/messages`);
		return (Array.isArray(r) ? r : r.messages).some((m) => m.role === "user" && JSON.stringify(m).includes("拖进来的笔记.txt"));
	});
	console.log("✅ 单聊：文件拖到聊天框 = 点上传，随消息发出");

	// 群聊：同样拖进来出现在群输入框的附件栏
	const room = await j("/api/rooms", "POST", { name: "拖文件群", memberIds: [a.id], managerId: a.id });
	await page.goto(`${BASE}/?room=${room.id}`);
	const roomBox = page.locator("[data-testid=room-chat] .pa-composer textarea");
	await roomBox.waitFor();
	await dropFile(page, roomBox, "群里的清单.txt", "群聊拖放内容");
	const roomChip = page.locator("[data-testid=room-chat] [data-testid=attach-chip]");
	await roomChip.waitFor();
	assert.match((await roomChip.getAttribute("title")) ?? "", /群里的清单\.txt/);
	await page.screenshot({ path: join(SHOTS, "02-room-dropped.png") });
	console.log("✅ 群聊：文件拖到聊天框出现在附件栏");
	console.log("拖文件 e2e 通过");
} finally {
	await browser?.close().catch(() => {});
	await server?.stop().catch(() => {});
	cleanupTempRun(run);
}
