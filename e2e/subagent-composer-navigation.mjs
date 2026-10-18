/**
 * 子代理页面输入栏/切换入口回归（真实服务端 + 真实 React 构建 + Chromium）。
 *
 * 覆盖（对应本轮两项真实修复）：
 *  1) 思考强度控件在主会话同款位置：子代理输入栏工具栏内（`.pa-composer-bar`），header 里不再重复出现。
 *  2) 子代理页面 header 直接切换同一主会话（同 agent + 父对话）的其他子代理，不用先返回主会话：
 *     主会话 → 子代理 A → 直接切到子代理 B → 回主会话；列表含运行中与已结束，标出当前项。
 *  3) 切换保留各自草稿（A / B 不串），返回主会话草稿也不丢；晚到的旧请求不覆盖当前可见内容。
 *  4) 思考档位：保存后刷新仍在（显式档位），「跟随助理默认」= API thinking 为 null；菜单选项不超出该模型支持范围。
 *
 * 全程：临时 PIA_DATA_DIR / PIA_WORKSPACE / HOME，PIA_MOCK=1 + PIA_OFFLINE=1 + PIA_HOST_CONTROL_DRY_RUN=1，
 * 不连真实云 / 不付费 / 不开麦 / 不操作用户电脑 / 不碰用户 db / 凭据 / secrets。仅 Mock 模型，不真实派任务。
 *
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 本环境（16GB / 高负载）首次 tsx 冷启动可 >50s，故就绪等待放宽到 120s。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = "/tmp/pia-e2e-subagent-composer-navigation";
const WS = `${DATA}/workspace`;
const HOME = `${DATA}/home`;
const SHOTS = artifactDir("screenshots");
const PORT = await new Promise((resolve) => {
	const sv = createServer().listen(0, "127.0.0.1", () => {
		const p = sv.address().port;
		sv.close(() => resolve(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

let server, browser;
const waitFor = async (fn, ms = 120_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error("timeout");
};
const j = async (path, method = "GET", body) => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const data = await r.json();
	if (!r.ok) throw new Error(`${path} ${JSON.stringify(data)}`);
	return data;
};
const start = async () => {
	server = spawn(process.execPath, ["--import", "tsx", "packages/server/src/main.ts"], {
		cwd: ROOT,
		env: { ...process.env, PIA_DATA_DIR: DATA, PIA_WORKSPACE: WS, HOME, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_HOST_CONTROL_DRY_RUN: "1", PIA_PORT: String(PORT) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (d) => process.stdout.write(d));
	server.stderr.on("data", (d) => process.stdout.write(d));
	await waitFor(async () => (await fetch(BASE + "/api/system")).ok);
};
const stop = async () => {
	if (!server || server.exitCode !== null) return;
	const done = new Promise((r) => server.once("exit", r));
	server.kill("SIGTERM");
	await done;
};

try {
	await start();
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = await j("/api/agents", "POST", { name: "切页测试" });
	// 跟随主会话的推理模型：子代理档位应来自这个模型
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: "mock", id: "echo-think" } });

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, locale: "zh-CN" });
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (e) => console.error("pageerror", e));
	await page.goto(`${BASE}/?agent=${agent.id}`);

	const box = page.locator("[data-testid=main-conversation] textarea:visible:not(.pa-card textarea)");
	const say = async (text) => {
		await box.fill(text);
		await box.press("Enter");
	};
	const rows = () => j(`/api/subagents?agent=${agent.id}`);
	const launch = async (text) => {
		const n = (await rows()).length;
		await say(text);
		await waitFor(async () => (await rows()).length > n);
		return (await rows()).find((r) => r.task.includes(text.replace("派个子代理", ""))) ?? (await rows())[0];
	};
	const panel = page.locator('[data-testid="subagent-detail"]:visible');
	const childBox = () => panel.getByLabel("给子代理发消息");
	/** 主会话：从「子代理」入口打开某个任务详情 */
	const openFromMain = async (id) => {
		await page.getByTestId("subagent-tasks").click();
		await page.getByTestId("task-overview").waitFor();
		const row = page.locator(`[data-testid=subagent-row][data-id="${id}"]`);
		if (!(await row.isVisible().catch(() => false))) await page.getByTestId("task-finished").locator("summary").click();
		await row.click();
		await panel.waitFor();
	};
	/** 子代理页面内：直接用 header 的切换入口打开另一个子代理（不返回主会话） */
	const switchFromSubagent = async (id) => {
		await panel.getByTestId("subagent-switch").click();
		await page.getByTestId("task-overview-switch").waitFor();
		const row = page.locator(`[data-testid=subagent-row][data-id="${id}"]`);
		if (!(await row.isVisible().catch(() => false))) await page.getByTestId("task-overview-switch").locator("summary").click();
		await row.click();
		await panel.waitFor();
	};
	const titleOf = async () => (await panel.locator("header").first().textContent()) ?? "";

	// ---------------------------------------------------------------- 建两个子代理
	const a = await launch("派个子代理整理文件A");
	const b = await launch("派个子代理整理文件B");
	assert.notEqual(a.id, b.id, "两个子代理应是不同任务");

	// ---------------------------------------------------------------- 1) 打开 A：思考控件在输入栏、header 不重复
	await openFromMain(a.id);
	await waitFor(async () => /整理文件A/.test(await titleOf()));
	assert.equal(await panel.locator("header [data-testid=subagent-thinking]").count(), 0, "header 不该再有思考控件");
	assert.equal(await panel.locator(".pa-composer-bar [data-testid=subagent-thinking]").count(), 1, "思考控件应在输入栏工具栏内");
	assert.equal(await panel.getByTestId("subagent-switch").count(), 1, "header 应有子代理切换入口");
	await panel.getByTestId("subagent-thinking").click();
	const menu = page.getByTestId("subagent-thinking-menu");
	await menu.waitFor();
	const followVisible = (await menu.getByTestId("subagent-thinking-follow").count()) === 1;
	assert.ok(followVisible, "应有「跟随助理默认」项");
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "detached" });

	// ---------------------------------------------------------------- 4a) 档位不超出模型支持范围
	// 详情接口返回 { subagent, messages }：档位 / 模型字段在 subagent 里（与界面读 d.subagent 一致）
	const { subagent: detail } = await j(`/api/subagents/${a.id}`);
	const models = await j("/api/models");
	const entry = models.find((m) => m.provider === detail.model_provider && m.id === detail.model_id);
	assert.ok(entry, `子代理模型 ${detail.model_provider}/${detail.model_id} 应在 /api/models 中`);
	const supported = new Set(entry?.thinking ?? []);
	await panel.getByTestId("subagent-thinking").click();
	await menu.waitFor();
	const menuLevels = await menu.locator("button[data-testid]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")).filter((t) => t !== "subagent-thinking-follow"));
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "detached" });
	for (const t of menuLevels) {
		const lvl = t.replace("subagent-thinking-", "");
		assert.ok(supported.has(lvl), `菜单档位 ${lvl} 应属于模型支持范围 ${[...supported].join(",")}`);
	}

	// ---------------------------------------------------------------- 4b) 显式档位保存后刷新仍在
	const explicit = [...supported].find((l) => l !== "off") ?? [...supported][0];
	await panel.getByTestId("subagent-thinking").click();
	await menu.waitFor();
	await menu.getByTestId(`subagent-thinking-${explicit}`).click();
	await waitFor(async () => (await j(`/api/subagents/${a.id}`)).subagent.thinking === explicit);
	await page.reload();
	await openFromMain(a.id);
	await waitFor(async () => /整理文件A/.test(await titleOf()));
	assert.equal((await panel.getByTestId("subagent-thinking").innerText()).includes("跟随"), false, "刷新后应显示显式档位");
	// 改回跟随
	await panel.getByTestId("subagent-thinking").click();
	await menu.waitFor();
	await menu.getByTestId("subagent-thinking-follow").click();
	await waitFor(async () => (await j(`/api/subagents/${a.id}`)).subagent.thinking === null);

	// ---------------------------------------------------------------- 2) 直接切到 B，再回 A；3) 草稿不串
	await childBox().fill("A 的草稿");
	await switchFromSubagent(b.id);
	await waitFor(async () => /整理文件B/.test(await titleOf()));
	assert.equal(await childBox().inputValue(), "", "切到 B 不应带出 A 的草稿");
	assert.equal(await panel.locator("header [data-testid=subagent-thinking]").count(), 0, "切到 B 后思考控件仍在输入栏、header 仍无");
	assert.equal(await panel.locator(".pa-composer-bar [data-testid=subagent-thinking]").count(), 1);
	await childBox().fill("B 的草稿");
	// 晚到旧请求不覆盖：停在 B 一段时间，B 头部标题/草稿保持
	await page.waitForTimeout(1500);
	assert.match(await titleOf(), /整理文件B/, "B 页面不应被 A 的晚到响应覆盖");
	assert.equal(await childBox().inputValue(), "B 的草稿");
	// 切回 A：A 的草稿还在
	await switchFromSubagent(a.id);
	await waitFor(async () => /整理文件A/.test(await titleOf()));
	assert.equal(await childBox().inputValue(), "A 的草稿", "回到 A 应保留 A 的草稿");
	// 再切 B：B 的草稿也还在
	await switchFromSubagent(b.id);
	await waitFor(async () => /整理文件B/.test(await titleOf()));
	assert.equal(await childBox().inputValue(), "B 的草稿", "回到 B 应保留 B 的草稿");

	// ---------------------------------------------------------------- 切换列表：标当前 + 含已结束
	await panel.getByTestId("subagent-switch").click();
	await page.getByTestId("task-overview-switch").waitFor();
	const currentRow = page.locator(`[data-testid=subagent-row][data-id="${b.id}"]`);
	assert.equal(await currentRow.getAttribute("data-current"), "true", "列表应标出当前子代理");
	assert.ok((await page.getByTestId("subagent-row").count()) >= 2, "列表应含同一主会话的另一个子代理");
	await page.screenshot({ path: join(SHOTS, "100-subagent-switch-overview.png") });
	await page.keyboard.press("Escape");

	// ---------------------------------------------------------------- 回主会话：主会话草稿不丢
	// 子代理面板打开时主会话是 display:none（App.tsx 的 .pa-chat），不能直接往隐藏输入框写；
	// 所以先返回主会话写草稿，再进一次子代理、再返回，验证草稿跨子代理导航不丢。
	await panel.getByLabel("返回主会话").click();
	await waitFor(async () => (await panel.count()) === 0);
	await box.fill("主会话草稿");
	await openFromMain(a.id);
	await panel.waitFor();
	await panel.getByLabel("返回主会话").click();
	await waitFor(async () => (await panel.count()) === 0);
	assert.equal(await box.inputValue(), "主会话草稿", "回主会话应保留主会话草稿");

	// ---------------------------------------------------------------- 390 窄屏不溢出
	await page.setViewportSize({ width: 390, height: 844 });
	await openFromMain(a.id);
	await panel.waitFor();
	assert.equal(await panel.locator(".pa-composer-bar [data-testid=subagent-thinking]").count(), 1, "窄屏思考控件仍在输入栏");
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1), "390 不应横向溢出");
	await page.screenshot({ path: join(SHOTS, "101-subagent-composer-390.png") });
	await page.setViewportSize({ width: 1280, height: 860 });

	console.log("子代理输入栏思考控件 + 同主会话子代理直接切换 e2e 通过");
} finally {
	await browser?.close();
	await stop();
}
