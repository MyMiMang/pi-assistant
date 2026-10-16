/**
 * 「从消息另开会话分支」界面 e2e（真实 server + Mock 模型 + Chrome headless，临时数据目录）。
 * 运行：npm run build -w @pi-assistant/web && node e2e/session-fork-ui.mjs
 *
 * 要证：只有 user 消息有「另开新对话」按钮（助理消息没有）；引用按钮仍在每条消息上；
 * 点击后切到新对话、正文放回输入框（不自动发送）、历史是分支前缀；
 * 输入框草稿按对话分桶（切回去原文还在）；390 宽两个按钮不换行、右键菜单能触发分支。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createSecurityProbe, spawnMemoryServer, startupEvidence } from "./fixtures/safe-memory-server.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = await new Promise((r) => {
	const sv = createNetServer().listen(0, "127.0.0.1", () => {
		const p = sv.address().port;
		sv.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "pia-fork-ui-"));
const results = [];
const ok = (n) => (results.push(true), console.log("✔", n));
const bad = (n, e) => {
	results.push(false);
	console.error("✖", n, e?.message ?? e ?? "");
};
const step = async (name, fn) => {
	try {
		await fn();
		ok(name);
	} catch (e) {
		bad(name, e);
	}
};
const waitFor = async (fn, ms = 20_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return true;
		} catch {}
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
};

const probe = createSecurityProbe(DATA);
const { child: server, startupFile } = spawnMemoryServer({ repoRoot: ROOT, dataDir: DATA, port: PORT, probe, env: { PIA_HOST_CONTROL_DRY_RUN: "1" } });
server.stderr.on("data", (d) => process.env.FORK_UI_VERBOSE && process.stderr.write(d));

let browser;
let page;
try {
	if (!(await waitFor(async () => (await fetch(`${BASE}/api/system/public`).catch(() => null))?.ok, 30_000))) throw new Error("server 没起来");
	const agent = await (await fetch(`${BASE}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "分支 UI" }) })).json();

	browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", colorScheme: "light" });
	page = await ctx.newPage();
	page.setDefaultTimeout(15_000);
	await page.goto(BASE);
	const box = page.locator("main textarea:not(.pa-card textarea)");
	await box.waitFor();

	const send = async (text) => {
		await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
		await box.fill(text);
		await box.press("Enter");
		await page.waitForFunction(() => document.querySelector("main textarea:not(.pa-card textarea)")?.value === "", null, { timeout: 10_000 });
	};
	const settle = () => waitFor(async () => !(await page.locator("[data-testid=activity]").count()), 30_000);
	const userMsgs = () => page.locator(".pa-msg.user");
	const composer = () => page.locator("main textarea:not(.pa-card textarea)");
	const idle = () => waitFor(async () => !(await page.locator("header .pa-pulse").count()) && !(await page.locator("[data-testid=activity]").count()), 30_000);
	const clickFork = async (text) => {
		// Mock 刚回复完时 Pi 可能还没 settle，busy 保护会给 409；等空闲后重试（这就是真实用户看到的提示）
		for (let i = 0; i < 40; i++) {
			await idle();
			await userMsgs().filter({ hasText: text }).locator("[data-testid=fork-btn]").first().click();
			await page.locator("[data-testid=fork-notice]").waitFor();
			const notice = (await page.locator("[data-testid=fork-notice]").innerText()).trim();
			if (!/正在这一轮里工作/.test(notice)) return notice;
			await page.waitForTimeout(500);
		}
		throw new Error("一直 busy，没能另开分支");
	};

	await step("启动走测试入口：内存凭据被调用、0 次 security（不碰钥匙串）", async () => {
		const ev = await startupEvidence(startupFile, probe);
		if (!(ev.storeCalls > 0)) throw new Error(`内存凭据没被访问（storeCalls=${ev.storeCalls}）`);
		if (ev.securityCalls !== 0) throw new Error(`调用了系统 security ${ev.securityCalls} 次`);
	});

	// 建两轮真实对话（Mock）
	await step("发送两轮消息（Mock 回复完成）", async () => {
		await send("你好第一轮");
		await waitFor(() => page.locator(".pa-msg.bot .prose").count().then((n) => n > 0));
		await settle();
		await send("第二轮问题");
		await waitFor(() => page.locator(".pa-msg.bot .prose").count().then((n) => n > 1));
		await settle();
		if ((await userMsgs().count()) < 2) throw new Error("用户消息不足 2 条");
	});

	await step("只有用户消息有「另开新对话」，引用按钮每条都有", async () => {
		const n = await userMsgs().count();
		for (let i = 0; i < n; i++) {
			if (!(await userMsgs().nth(i).locator("[data-testid=fork-btn]").count())) throw new Error(`第 ${i} 条用户消息没有 fork 按钮`);
			if (!(await userMsgs().nth(i).locator("[data-testid=quote-btn]").count())) throw new Error(`第 ${i} 条用户消息没有引用按钮`);
		}
		const bots = page.locator(".pa-msg.bot");
		const bn = await bots.count();
		for (let i = 0; i < bn; i++) {
			if (await bots.nth(i).locator("[data-testid=fork-btn]").count()) throw new Error("助理消息不该有 fork 按钮");
			if (!(await bots.nth(i).locator("[data-testid=quote-btn]").first().count())) throw new Error("助理消息引用按钮丢失");
		}
	});

	let sourceTitle;
	await step("从第二条用户消息另开新对话：切到新对话 + 正文放回输入框（不自动发送）", async () => {
		await composer().fill("原对话草稿");
		const notice = await clickFork("第二轮问题");
		if (!/已从这条消息另开新对话/.test(notice)) throw new Error(`提示不对：${notice}`);
		await waitFor(async () => (await composer().inputValue()) === "第二轮问题");
		if ((await composer().inputValue()) !== "第二轮问题") throw new Error("被分支消息正文没放回输入框");
		// 新对话是前缀：有第一轮、没有第二轮
		await waitFor(() => page.locator(".pa-thread-body").getByText("你好第一轮").count().then((n) => n > 0));
		if (await page.locator(".pa-thread-body").getByText("第二轮问题").count()) throw new Error("被分支的消息不该出现在新对话历史里");
		sourceTitle = "你好第一轮";
	});

	await step("输入框草稿按对话分桶：切回原对话，原草稿还在", async () => {
		await page.locator("[data-testid=conv-menu]").click();
		await page.locator("div[role=menu] li").filter({ hasText: sourceTitle }).first().click();
		await waitFor(async () => (await composer().inputValue()) === "原对话草稿");
		if ((await composer().inputValue()) !== "原对话草稿") throw new Error("切回原对话没恢复原草稿");
	});

	await step("390 宽：两个按钮都在、不换行不超宽、右键菜单可触发分支", async () => {
		await page.setViewportSize({ width: 390, height: 844 });
		const u = userMsgs().last();
		await u.scrollIntoViewIfNeeded();
		const act = u.locator("[data-testid=msg-actions]");
		const qb = await u.locator("[data-testid=quote-btn]").boundingBox();
		const fb = await u.locator("[data-testid=fork-btn]").boundingBox();
		if (!qb || !fb) throw new Error("390 下按钮不可见");
		if (Math.abs(qb.y + qb.height / 2 - (fb.y + fb.height / 2)) > 6) throw new Error("两个按钮不在同一行");
		const aw = await act.boundingBox();
		if (!aw || aw.x + aw.width > 392) throw new Error("操作行超出屏幕");
		// 右键：命中气泡 → 出现菜单，含引用 + 分支两项
		await u.locator(".pa-bubble").first().click({ button: "right" });
		await page.locator("[data-testid=reply-menu]").waitFor();
		if (!(await page.locator("[data-testid=reply-menu-fork]").count())) throw new Error("右键菜单没有「另开新对话」");
		if (!(await page.locator("[data-testid=reply-menu-quote]").count())) throw new Error("右键菜单没有「引用」");
		await page.keyboard.press("Escape");
	});

	if (results.includes(false)) process.exitCode = 1;
} catch (e) {
	bad("e2e", e);
	process.exitCode = 1;
	if (page) await page.screenshot({ path: "/tmp/session-fork-ui-fail.png" }).catch(() => {});
} finally {
	await browser?.close().catch(() => {});
	server.kill("SIGTERM");
	await new Promise((r) => setTimeout(r, 300));
	server.kill("SIGKILL");
	rmSync(DATA, { recursive: true, force: true });
}
console.log(`界面 e2e：${results.filter(Boolean).length}/${results.length} 通过`);
