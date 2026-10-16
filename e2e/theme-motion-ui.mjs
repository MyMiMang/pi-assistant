/**
 * 主题动效 DIY 的真实 DOM 验证（真实 server + Playwright，AI 用假 API 响应注入 motion）。
 *
 * 为什么用假 AI 响应：现有 Mock 模型产出的主题不含 motion，无法覆盖动效生产路径；这里在**网络层**
 * 拦截 `/api/themes/draft` 返回带 motion 的合法 manifest（前端 ThemeDesigner / 预览事务 / 持久化都是真的）。
 * 服务端对 motion 的真实校验已由 packages/server/test/theme-ai.test.ts 覆盖（真实 Pi 会话 + theme_draft 工具）。
 *
 * 覆盖：AI 生成带 motion → 全应用临时预览 → 真实 computed style（含通用控件消费）→
 * 手动微调只改一个字段不 reset 其它 → 应用并保存 → 刷新恢复 → 继续 AI 改 → 取消完整恢复 →
 * 另存为新主题 motion 不丢 → 导出 / 导入 motion 不丢 → 旧无 motion 主题兼容 → reduce 静态遵守 →
 * 390 宽度动效字段不横向溢出。
 *
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 运行：node e2e/theme-motion-ui.mjs
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
if (!existsSync(join(DIST, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DATA = "/tmp/pia-e2e-theme-motion";
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

/* ---------------------------- 假 AI：合法 manifest（带 motion） ---------------------------- */
const tokens = (bg, fg, acc) => ({
	"--bg": bg,
	"--side": bg,
	"--panel": bg,
	"--card": bg,
	"--fg": fg,
	"--mut": fg,
	"--mut2": fg,
	"--line": bg,
	"--line-strong": bg,
	"--hover": bg,
	"--active": bg,
	"--user-bg": bg,
	"--user-fg": fg,
	"--acc": acc,
	"--acc-fg": bg,
	"--acc-soft": "rgba(0,0,0,.12)",
	"--ok": "#5f8a5a",
	"--warn": "#c08a2c",
	"--z-light": "#ffffff",
	"--z-dark": "#1b1b22",
});
const modes = (warm) =>
	warm
		? { light: tokens("#f7f3ea", "#2a251f", "#8fd3c1"), dark: tokens("#141218", "#f3eee6", "#c3b6f0") }
		: { light: tokens("#f2f7f5", "#1f2a27", "#4fb39a"), dark: tokens("#0f1614", "#e6f2ee", "#63d0b3") };

/** 第一版：自定义 cubic-bezier（不在下拉选项里）+ steps + scale 1.5 + glow strong。 */
const MOTION_V1 = { duration: ".3s", durationFast: "120ms", easeOut: "cubic-bezier(.22,1,.36,1)", scale: 1.5, glow: "strong", style: "steps" };
/** 继续修改：换时长 + 换缓动枚举，验证迭代。 */
const MOTION_V2 = { duration: ".5s", easeOut: "spring-soft", scale: 1.2, glow: "subtle", style: "smooth" };

function manifestFor(id, motion) {
	return {
		manifestVersion: 1,
		id,
		name: "动效测试",
		author: "AI 生成",
		basedOn: "noir",
		modes: modes(true),
		decor: { texture: "none", corner: "round", shadow: "soft", background: "flat" },
		motion,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

const readStyle = (page) =>
	page.evaluate(() => {
		const s = getComputedStyle(document.documentElement);
		return {
			skin: document.documentElement.dataset.skin || "",
			dur: s.getPropertyValue("--pa-dur").trim(),
			durFast: s.getPropertyValue("--pa-dur-fast").trim(),
			scale: s.getPropertyValue("--mo-scale").trim(),
			glow: s.getPropertyValue("--mo-glow").trim(),
			style: s.getPropertyValue("--mo-style").trim(),
			ease: s.getPropertyValue("--mo-ease").trim(),
			easeOut: s.getPropertyValue("--pa-ease-out").trim(),
		};
	});

let browser;
try {
	await waitFor(async () => (await fetch(`${BASE}/api/system`)).ok);
	const agent = await (await fetch(`${BASE}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "动效测试" }) })).json();
	if (!agent?.id) throw new Error(`创建助理失败：${JSON.stringify(agent)}`);
	await fetch(`${BASE}/api/agents/${agent.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: null }) });

	browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", colorScheme: "light" });
	const page = await ctx.newPage();
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (e) => console.log("[页面错误]", String(e).slice(0, 300)));

	// 假 AI：按请求里的 previousManifest 决定 id 与 motion（第一次 v1，继续修改 v2）。
	await page.route("**/api/themes/draft", async (route) => {
		const req = route.request().postDataJSON();
		const prev = req?.previousManifest;
		const id = prev?.id ?? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
		const motion = prev?.motion ? MOTION_V2 : MOTION_V1;
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ ok: true, turnId: req?.turnId ?? "t1", manifest: manifestFor(id, motion), text: "动效已生成。", warnings: [] }),
		});
	});

	const dismissHelp = async () => {
		if (await page.locator('[data-testid="help-pop"]').count()) await page.keyboard.press("Escape");
		await page.mouse.move(2, 2);
	};
	mkdirSync(join(ROOT, "docs/screenshots"), { recursive: true });
	await page.goto(`${BASE}/?settings=appearance`);
	await page.getByTestId("open-theme-designer").waitFor();
	const baseSkin = await page.evaluate(() => document.documentElement.dataset.skin || "");

	await step("AI 生成带 motion → 临时预览，computed style 真实生效（含 --mo-ease 别名）", async () => {
		await page.getByTestId("open-theme-designer").click();
		await page.getByTestId("theme-prompt").fill("动效轻快一点，圆角小");
		await dismissHelp();
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-apply").waitFor();
		const st = await readStyle(page);
		if (!st.skin.startsWith("custom-")) throw new Error(`应进入预览：${JSON.stringify(st)}`);
		if (st.dur !== ".3s") throw new Error(`--pa-dur 应为 .3s：${st.dur}`);
		if (st.durFast !== "120ms") throw new Error(`--pa-dur-fast 应为 120ms：${st.durFast}`);
		if (st.scale !== "1.5") throw new Error(`--mo-scale 应为 1.5：${st.scale}`);
		if (st.glow !== "1.6") throw new Error(`--mo-glow 应为 1.6：${st.glow}`);
		if (st.style !== "steps") throw new Error(`--mo-style 应为 steps：${st.style}`);
		if (st.ease !== "cubic-bezier(.22,1,.36,1)") throw new Error(`--mo-ease 应等于自定义缓出：${st.ease}`);
		if (st.ease !== st.easeOut) throw new Error(`--mo-ease 应等于 --pa-ease-out：${st.ease} vs ${st.easeOut}`);
		if ((await page.evaluate(() => localStorage.getItem("pia.skin"))) === st.skin) throw new Error("预览不应写 localStorage");
	});

	await step("通用控件真实消费：.pa-btn 的 transition-duration 随主题时长变化", async () => {
		const d = await page.evaluate(() => {
			for (const el of document.querySelectorAll("*") ) {
				const td = getComputedStyle(el).transitionDuration;
				if (td && td.includes("0.3s")) return { tag: el.tagName, cls: el.className, td };
			}
			return null;
		});
		if (!d) throw new Error("页面上没有控件消费到主题的 0.3s 时长（--pa-dur 未生效）");
		console.log("   ↳ 消费元素:", JSON.stringify(d).slice(0, 160));
	});

	await step("手动微调：只改倍率，自定义 cubic-bezier 缓出不被无声 reset 为默认", async () => {
		await page.getByTestId("theme-motion").evaluate((el) => (el.open = true));
		const before = await page.evaluate(() => document.documentElement.dataset.skin);
		await page.getByTestId("theme-motion-scale").selectOption("1.2");
		await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--mo-scale").trim() === "1.2");
		const st = await readStyle(page);
		if (st.ease !== "cubic-bezier(.22,1,.36,1)") throw new Error(`改倍率不应动缓出：${st.ease}`);
		if (st.style !== "steps") throw new Error(`改倍率不应动风格：${st.style}`);
		if ((await page.evaluate(() => document.documentElement.dataset.skin)) !== before) throw new Error("微调不应换 skin id");
		// 自定义缓出在 select 里不应显示成「默认」而误导（值非空即必须能看出来）
		const shown = await page.getByTestId("theme-motion-ease-out").inputValue();
		if (!shown) throw new Error("自定义 cubic-bezier 时「通用缓出」下拉不应显示为空 / 默认");
	});

	await step("应用并保存 → localStorage 持久化 motion → 刷新恢复 computed style", async () => {
		await page.getByTestId("theme-apply").click();
		await page.getByTestId("theme-designer").waitFor({ state: "detached" });
		const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]"));
		if (saved.length !== 1) throw new Error(`应保存 1 条：${saved.length}`);
		if (saved[0].motion?.style !== "steps" || saved[0].motion?.scale !== 1.2) throw new Error(`保存的 motion 不对：${JSON.stringify(saved[0].motion)}`);
		const skin = await page.evaluate(() => document.documentElement.dataset.skin);
		await page.reload();
		await waitFor(async () => (await readStyle(page)).skin === skin);
		const st = await readStyle(page);
		if (st.scale !== "1.2" || st.style !== "steps" || st.ease !== "cubic-bezier(.22,1,.36,1)") throw new Error(`刷新后 motion 丢了：${JSON.stringify(st)}`);
	});

	await step("继续 AI 改 → 取消完整恢复原外观、不留主题、不残留预览样式", async () => {
		const countBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").length);
		const skinBefore = await page.evaluate(() => document.documentElement.dataset.skin);
		const idsEdit = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
		await page.getByTestId(`edit-${idsEdit[0]}`).click();
		await page.getByTestId("theme-prompt").fill("再快一点");
		await dismissHelp();
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-apply").waitFor();
		const mid = await readStyle(page);
		if (mid.dur !== ".5s") throw new Error(`继续修改应换成 v2 时长 .5s：${mid.dur}`);
		await page.getByTestId("theme-cancel").click();
		await page.getByTestId("theme-designer").waitFor({ state: "detached" });
		const after = await readStyle(page);
		if (after.skin !== skinBefore) throw new Error(`取消应恢复原 skin：${after.skin} vs ${skinBefore}`);
		if (after.dur !== ".3s" || after.scale !== "1.2") throw new Error(`取消应恢复已保存的 motion：${JSON.stringify(after)}`);
		const countAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").length);
		if (countAfter !== countBefore) throw new Error(`取消不应改主题条数：${countBefore} → ${countAfter}`);
		if (await page.locator("#pa-theme-preview").count()) throw new Error("取消后不应残留临时预览 <style>");
	});

	await step("另存为新主题 → 新 id，motion 一起复制", async () => {
		const ids0 = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
		await page.getByTestId(`edit-${ids0[0]}`).click();
		await page.getByTestId("theme-prompt").fill("再来一版，慢一点");
		await dismissHelp();
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-save-as").waitFor();
		await page.getByTestId("theme-save-as").click();
		await page.getByTestId("theme-designer").waitFor({ state: "detached" });
		const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]"));
		if (saved.length !== 2) throw new Error(`另存应新增：${saved.length}`);
		const copy = saved.find((m) => m.id !== ids0[0]);
		if (copy?.motion?.easeOut !== "spring-soft" || copy?.motion?.style !== "smooth" || copy?.motion?.duration !== ".5s") throw new Error(`副本 motion 丢了：${JSON.stringify(copy?.motion)}`);
	});

	await step("导出 JSON 含 motion；导入旧无 motion 主题 → 合法并补内置默认", async () => {
		// 导出当前（另存后自动切到副本，再打开编辑它）
		const ids = await page.evaluate(() => JSON.parse(localStorage.getItem("pia.customThemes") || "[]").map((m) => m.id));
		await page.getByTestId(`edit-${ids[0]}`).click();
		await page.getByTestId("theme-export").waitFor();
		const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("theme-export").click()]);
		const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
		if (exported.motion?.style !== "steps" || exported.motion?.easeOut !== "cubic-bezier(.22,1,.36,1)") throw new Error(`导出丢了 motion：${JSON.stringify(exported.motion)}`);
		// 导入一份旧 v1（无 motion）
		const legacy = manifestFor("legacy-no-motion-1", undefined);
		delete legacy.motion;
		legacy.name = "旧主题";
		const f = join(DATA, "legacy.json");
		writeFileSync(f, JSON.stringify(legacy));
		await page.getByTestId("theme-import-input").setInputFiles(f);
		await page.waitForFunction(() => document.documentElement.dataset.skin === "custom-legacy-no-motion-1");
		const st = await readStyle(page);
		if (st.dur !== ".18s" || st.scale !== "1" || st.style !== "smooth") throw new Error(`旧主题应补内置默认：${JSON.stringify(st)}`);
		await page.getByTestId("theme-cancel").click();
		await page.getByTestId("theme-designer").waitFor({ state: "detached" });
	});

	await step("系统「减弱动效」：reduce 下静态把时长置零、倍率置 0", async () => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		const st = await readStyle(page);
		if (st.dur !== "0s" || st.durFast !== "0s" || st.scale !== "0") throw new Error(`reduce 未生效：${JSON.stringify(st)}`);
		await page.emulateMedia({ reducedMotion: "no-preference" });
		const back = await readStyle(page);
		if (back.dur !== ".3s" && back.dur !== ".5s") throw new Error(`恢复后时长应还原：${back.dur}`);
	});

	await step("390 宽度：动效微调字段不横向溢出", async () => {
		await page.setViewportSize({ width: 390, height: 780 });
		await page.getByTestId("open-theme-designer").click();
		await page.getByTestId("theme-prompt").waitFor();
		await dismissHelp();
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-apply").waitFor();
		await page.getByTestId("theme-motion").evaluate((el) => (el.open = true));
		await page.getByTestId("theme-motion-style").waitFor();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		if (overflow > 2) throw new Error(`390 横向溢出 ${overflow}px`);
		// 截图前把动效字段滚到可见处，并把鼠标移开以免「?」气泡挡住
		await page.getByTestId("theme-motion-style").scrollIntoViewIfNeeded();
		await page.mouse.move(2, 2);
		await page.waitForTimeout(250);
		await page.screenshot({ path: join(ROOT, "docs/screenshots/17-theme-motion-390.png") });
	});
} finally {
	await browser?.close().catch(() => {});
	server.kill("SIGTERM");
}

const failed = results.filter(([s]) => s === "❌");
console.log(`\n[theme-motion-ui] ${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
