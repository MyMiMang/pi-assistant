/**
 * 外观 AI 创作的真实 UI 验证（真实 server + Mock 模型 + Playwright）。
 *
 * 覆盖：设置→外观「用AI设计主题」→ 输入要求 → AI 生成进入全应用临时预览（不写 localStorage）→
 * 继续修改 → 取消完整恢复 → 生成并保存 → 「我的主题」卡片 → 编辑/用AI改（同一 id 更新）→ 另存为新主题。
 * 入口只有「设置→外观」，没有 /主题设计 slash。
 *
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 运行：node e2e/theme-ai-ui.mjs
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
if (!existsSync(join(DIST, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DATA = "/tmp/pia-e2e-theme-ai";
const PORT = await new Promise((r) => {
	const s = createNetServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true });

const results = [];
const step = async (name, fn) => {
	try {
		await fn();
		results.push(["✅", name]);
		console.log("✅", name);
	} catch (e) {
		results.push(["❌", name, String(e).slice(0, 2000)]);
		console.log("❌", name, e);
	}
};

const server = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
	cwd: ROOT,
	env: { ...process.env, PIA_DATA_DIR: DATA, PIA_WORKSPACE: join(DATA, "workspace"), PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT), PIA_HOST_CONTROL_DRY_RUN: "1" },
	stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => !String(d).includes("ExperimentalWarning") && process.stdout.write(`[server!] ${d}`));
process.on("exit", () => server.kill("SIGKILL"));

async function waitFor(fn, ms = 60_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("timeout");
}

let browser;
try {
	await waitFor(async () => (await fetch(`${BASE}/api/system`)).ok);
	// 直接建一个助理（默认模型 = Mock），不走向导
	const agent = await (await fetch(`${BASE}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "主题测试" }) })).json();
	if (!agent?.id) throw new Error(`创建助理失败：${JSON.stringify(agent)}`);
	// 让这个助理“没有显式选过模型”（model=null）→ 跟随默认模型，正好验证 UI 的「默认模型 · xxx」。
	await fetch(`${BASE}/api/agents/${agent.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: null }) });

	browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", colorScheme: "light" });
	const page = await ctx.newPage();
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (e) => console.log("[页面错误]", String(e).slice(0, 300)));
	// 图片选择器的「?」说明气泡可能悬停展开并盖住生成/保存按钮：测试里让它不拦截鼠标（不改产品行为）。
	const killHelpOverlay = () => void page.addStyleTag({ content: '[data-testid="help-pop"]{pointer-events:none !important}' }).catch(() => {});
	page.on("load", killHelpOverlay);
	await killHelpOverlay();
	const dismissHelp = async () => {
		if (await page.locator('[data-testid="help-pop"]').count()) await page.keyboard.press("Escape");
		await page.mouse.move(2, 2);
	};
	mkdirSync(artifactDir("screenshots"), { recursive: true });

	await step("设置→外观有「用 AI 设计主题」入口，无 /主题设计 slash", async () => {
		await page.goto(`${BASE}/?settings=appearance`);
		await page.getByTestId("open-theme-designer").waitFor();
		const hasSlash = await page.evaluate(() => !!document.querySelector("[data-command='/主题设计']"));
		if (hasSlash) throw new Error("不应有 /主题设计 slash 入口");
	});

	await step("设计面板顶部有「使用模型」，默认跟随当前助理（明确「默认模型」），菜单复用现有模型菜单且不改助理主模型", async () => {
		await page.getByTestId("open-theme-designer").click();
		await page.getByTestId("theme-model-row").waitFor();
		const row = await page.getByTestId("theme-model-row").innerText();
		if (!row.includes("使用模型")) throw new Error(`面板顶部应显示「使用模型」：${row}`);
		const btn = await page.getByTestId("theme-model").innerText();
		if (!btn.includes("默认模型")) throw new Error(`助理未显式选模型时应明确显示「默认模型 · xxx」：${btn}`);
		if (!btn.includes("·")) throw new Error(`模型按钮应含「服务短名 · 模型名」：${btn}`);
		// 复用现有模型菜单（可搜索 + 有已配置模型选项）
		await page.getByTestId("theme-model").click();
		await page.getByTestId("theme-model-search").waitFor();
		const opts = await page.getByTestId("theme-model-option").count();
		if (opts < 1) throw new Error("模型菜单里应至少有一个已配置模型");
		await page.keyboard.press("Escape");
		await page.screenshot({ path: join(artifactDir("screenshots"), "16f-theme-ai-model.png") });
		await page.getByTestId("theme-cancel").click();
		await page.getByTestId("theme-designer").waitFor({ state: "detached" });
		const agents = await (await fetch(`${BASE}/api/agents`)).json();
		const a = agents.find((x) => x.id === agent.id);
		if (!a) throw new Error("助理列表读不到刚建的助理");
		if (a.model_provider || a.model_id) throw new Error("打开设计面板不能写回助理主模型");
	});

	await step("AI 生成 → 全应用临时预览，且不写 localStorage；继续修改仍预览；取消完整恢复", async () => {
		const before = await page.evaluate(() => document.documentElement.dataset.skin);
		await page.getByTestId("open-theme-designer").click();
		await page.getByTestId("theme-prompt").fill("奶油底色加淡紫点缀，圆角小一点");
		await dismissHelp();
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-apply").waitFor();
		const skin = await page.evaluate(() => document.documentElement.dataset.skin);
		if (!skin.startsWith("custom-")) throw new Error(`AI 生成后应进入预览：${skin}`);
		if ((await page.evaluate(() => localStorage.getItem("pia.skin"))) === skin) throw new Error("预览不应写 localStorage");
		await page.screenshot({ path: join(artifactDir("screenshots"), "16d-theme-ai-preview.png") });
		// 继续修改
		await dismissHelp();
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-apply").waitFor();
		// 取消恢复
		await page.getByTestId("theme-cancel").click();
		if ((await page.evaluate(() => document.documentElement.dataset.skin)) !== before) throw new Error("取消应恢复原主题");
		const count = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").length);
		if (count !== 0) throw new Error("取消后不应留下主题");
	});

	await step("AI 生成 → 应用并保存 → 出现「我的主题」卡片，刷新后仍在", async () => {
		await page.getByTestId("open-theme-designer").click();
		await page.getByTestId("theme-prompt").fill("薄荷清爽一点");
		await dismissHelp();
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-apply").waitFor();
		await page.getByTestId("theme-apply").click();
		await page.getByTestId("theme-designer").waitFor({ state: "detached" });
		const ids = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
		if (ids.length !== 1) throw new Error(`应保存 1 条：${JSON.stringify(ids)}`);
		await page.getByTestId(`edit-${ids[0]}`).waitFor();
		await page.reload();
		await page.getByTestId(`edit-${ids[0]}`).waitFor();
	});

	await step("编辑 / 用 AI 改：保存回同一 id（不新增），另存为新主题才新增", async () => {
		const ids0 = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
		await page.getByTestId(`edit-${ids0[0]}`).click();
		await page.getByTestId("theme-prompt").fill("再暖一点，奶油紫");
		await dismissHelp();
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-apply").waitFor();
		await page.getByTestId("theme-apply").click();
		await page.getByTestId("theme-designer").waitFor({ state: "detached" });
		const ids1 = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
		if (ids1.length !== 1 || ids1[0] !== ids0[0]) throw new Error(`继续改应更新同一 id：${JSON.stringify(ids1)}`);

		await page.getByTestId(`edit-${ids1[0]}`).click();
		await page.getByTestId("theme-save-as").waitFor({ timeout: 1000 }).catch(() => {});
		await page.getByTestId("theme-prompt").fill("再来一版");
		await dismissHelp();
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-save-as").waitFor();
		await page.getByTestId("theme-save-as").click();
		await page.getByTestId("theme-designer").waitFor({ state: "detached" });
		const ids2 = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
		if (ids2.length !== 2 || new Set(ids2).size !== 2) throw new Error(`另存应新增：${JSON.stringify(ids2)}`);
	});

	await step("390 宽度下设计面板可用、不横向溢出", async () => {
		await page.setViewportSize({ width: 390, height: 780 });
		await page.getByTestId("open-theme-designer").click();
		await page.getByTestId("theme-prompt").waitFor();
		if (!(await page.getByTestId("theme-model-row").isVisible())) throw new Error("390 下「使用模型」行应可见");
		const reopened = await page.getByTestId("theme-designer").innerText();
		if (reopened.includes("正在预览") || reopened.includes("已另存为新主题")) throw new Error("重新打开不能残留上一轮的生成/另存提示");
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		if (overflow > 2) throw new Error(`390 横向溢出 ${overflow}px`);
		await page.screenshot({ path: join(artifactDir("screenshots"), "16e-theme-ai-390.png") });
		// 模型行在 390 下显示实际模型（默认模型）
		const btn = await page.getByTestId("theme-model").innerText();
		await page.screenshot({ path: join(artifactDir("screenshots"), "16g-theme-ai-model-390.png") });
		if (!btn.trim()) throw new Error("390 下模型按钮应有模型名");
	});
} finally {
	await browser?.close().catch(() => {});
	server.kill("SIGTERM");
}

const failed = results.filter(([s]) => s === "❌");
console.log(`\n[theme-ai-ui] ${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
