/**
 * 思考强度七档滑块 + AI DIY 动效的**生产贯通**验证（真实 server + 真实构建 + Chromium；AI 用假 API 响应注入）。
 *
 * 两条贯通路径：
 *  A) 端到端滑块：七档 / 子集 / 默认 off / 跟随 / snap 提交 / pointerup 才写 / pointercancel·blur·Esc 不写 /
 *     点同一档不关弹层也不多发请求 / 键盘逐档 / 390 宽四主题不溢出。
 *  B) DIY 动效 → 滑块：AI 生成带 motion 的主题 → 预览里真实 CSS 生效 → 保存刷新后
 *     `--mo-style=steps` 真的走 data 属性分支（手柄 transition none、预览动效 steps(3,end)、时长 × --mo-scale）；
 *     reduce 下组件不播预览（无 pa-think-pulse）；**主题实时切换 steps↔smooth 不需要重挂组件、焦点保持**；
 *     preview 取消完整还原。
 *
 * 另含 C）默认思考强度保存的「最后一次为准」：迟到的失败(A) 不覆盖用户后一次选择(B)、
 *     最新一次失败回落到服务端真值、关设置（卸载）后在飞响应不落地。
 *
 * 全是真实 server（临时 PIA_DATA_DIR + PIA_MOCK + PIA_OFFLINE，不碰钥匙串 / 真实 Key / 真实库 / 付费模型）+
 * 真实 React 构建 + 真实 CSS 引擎；AI 草稿用 `page.route` 注入合法 manifest（服务端 motion 校验另有单测）。
 *
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 运行：node e2e/thinking-slider-ui.mjs
 *   ONLY='^A[12] '    只跑名字匹配的步骤（探路 / 冒烟用，避免第一步挂掉还要把整串跑完）
 *   FAILFAST=1        第一个失败立即退出（配合 ONLY 用）
 *   DEBUG_SLIDER=1    打印页面请求 / 点击目标 / 模态状态（定位夹具问题时用）
 * 临时目录：每次 mkdtemp（data / workspace / HOME / TMPDIR 都在里面），finally 只删本次目录；
 * server 用独立进程组启动，收尾按组 SIGTERM→SIGKILL，异常/超时不留孤儿。
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { closeModelPanel } from "./model-menu-flow.mjs";
import { nativeLaunchBrowserEnv } from "./fixtures/native-launch-env.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// 本次运行独占的临时目录（mkdtemp 归属本次 PID 前缀；结束时只删这一个）：
// DATA / WORKSPACE / HOME / TMPDIR 全在里面，绝不碰用户真实数据目录、HOME 或别人的临时目录
const RUN_DIR = mkdtempSync(join(tmpdir(), "pia-e2e-thinking-slider-"));
const DATA = join(RUN_DIR, "data");
const WORKSPACE = join(RUN_DIR, "workspace");
const FAKE_HOME = join(RUN_DIR, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(FAKE_HOME, { recursive: true });
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LABEL = { off: "关闭", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" };
/** 真实 Pi 目录里七档全支持的模型（自定义中转同名映射）/ 只支持 low..max 的子集模型 */
const MAIN = "anthropic.claude-sonnet-5";
const SUBSET = "gpt-6.1-sol";

const PORT = await new Promise((r) => {
	const s = createNetServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
rmSync(DATA, { recursive: true, force: true });

const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null; // 只跑匹配的步骤（bootstrap 探路用）
const FAILFAST = !!process.env.FAILFAST; // 探路时第一步失败就退出，不把后面的分钟都耗掉
const results = [];
const step = async (name, fn) => {
	if (ONLY && !ONLY.test(name)) return;
	try {
		await fn();
		results.push(["✅", name]);
		console.log("✅", name);
	} catch (e) {
		results.push(["❌", name, String(e).slice(0, 2000)]);
		console.log("❌", name, String(e).slice(0, 2000));
		if (FAILFAST) throw e;
	}
};
const waitFor = async (fn, ms = 30_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 120));
	}
	throw new Error("timeout");
};
const j = async (path, method = "GET", body) => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(data)}`);
	return data;
};

const server = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
	cwd: ROOT,
	env: { ...process.env, HOME: FAKE_HOME, TMPDIR: RUN_DIR, PIA_DATA_DIR: DATA, PIA_WORKSPACE: WORKSPACE, PIA_MOCK: "1", PIA_OFFLINE: "1", PIA_PORT: String(PORT), PIA_HOST_CONTROL_DRY_RUN: "1" },
	stdio: ["ignore", "pipe", "pipe"],
	detached: true, // 自己一个进程组：超时/异常时整组收掉，不留孤儿 tsx/server
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => !String(d).includes("ExperimentalWarning") && process.stdout.write(`[server!] ${d}`));
const killServerTree = (sig = "SIGTERM") => {
	if (server.exitCode !== null || server.pid === undefined) return;
	try { process.kill(-server.pid, sig); } catch { try { server.kill(sig); } catch {} }
};
process.on("exit", () => killServerTree("SIGKILL"));

/* -------- DIY 主题（与 AI 引擎同 schema；直接种进 localStorage = 应用真实的持久化读入路径） -------- */
const tokens = (bg, fg, acc) => ({
	"--bg": bg, "--side": bg, "--panel": bg, "--card": bg, "--fg": fg, "--mut": fg, "--mut2": fg, "--line": bg, "--line-strong": bg, "--hover": bg, "--active": bg,
	"--user-bg": bg, "--user-fg": fg, "--acc": acc, "--acc-fg": bg, "--acc-soft": "rgba(0,0,0,.12)", "--ok": "#5f8a5a", "--warn": "#c08a2c", "--z-light": "#ffffff", "--z-dark": "#1b1b22",
});
const modes = (warm) =>
	warm
		? { light: tokens("#f7f3ea", "#2a251f", "#8fd3c1"), dark: tokens("#141218", "#f3eee6", "#c3b6f0") }
		: { light: tokens("#f2f7f5", "#1f2a27", "#4fb39a"), dark: tokens("#0f1614", "#e6f2ee", "#63d0b3") };
const STEPS_ID = "e2e-slider-steps";
const SMOOTH_ID = "e2e-slider-smooth";
const manifestFor = (id, name, motion) => ({
	manifestVersion: 1, id, name, author: "e2e", basedOn: "noir", modes: modes(true),
	decor: { texture: "none", corner: "round", shadow: "soft", background: "flat" }, motion,
	createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});
/** steps 主题：--mo-style=steps + 倍率 1.2（保存后滑块走 steps 分支、预览时长 ×1.2）。 */
const MANIFEST_STEPS = manifestFor(STEPS_ID, "E2E 离散", { style: "steps", scale: 1.2, glow: "strong", duration: ".3s", easeOut: "cubic-bezier(.22,1,.36,1)" });
/** smooth 主题：切过去时 --mo-style=smooth（组件必须**不重挂**就切回连续过渡）。 */
const MANIFEST_SMOOTH = manifestFor(SMOOTH_ID, "E2E 顺滑", { style: "smooth", scale: 1.4, glow: "subtle" });
/** 假 AI 第一次给 steps（预览），继续修改给 smooth。 */
const MANIFEST_AI_V1 = manifestFor("e2e-ai-motion", "E2E AI 动效", { style: "steps", scale: 1.2, glow: "strong", duration: ".3s" });
const MANIFEST_AI_V2 = manifestFor("e2e-ai-motion", "E2E AI 动效", { style: "smooth", scale: 1.4, glow: "subtle" });

let browser;
try {
	await waitFor(async () => (await fetch(`${BASE}/api/system`)).ok);
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = await j("/api/agents", "POST", { name: "滑块测试" });
	// 真实 Pi 目录：glm-5.2 七档全有；my-private-model 只到 high；plain-noreason 非推理（只有 off）
	const prov = await j("/api/models/custom", "POST", {
		name: "滑块中转", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true,
		models: [{ id: MAIN, reasoning: true }, { id: SUBSET, reasoning: true }, { id: "my-private-model", reasoning: true }, { id: "plain-noreason", reasoning: false }],
	});
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: prov.id, id: MAIN } });
	await j("/api/models/default", "PUT", { provider: prov.id, model: MAIN, thinking: "low" });

	const catalog = await j("/api/models");
	const full = catalog.find((m) => m.provider === prov.id && m.id === MAIN);
	if (full?.thinking?.length !== 7) throw new Error(`目录里 ${MAIN} 应支持七档：${JSON.stringify(full?.thinking)}`);
	const agentBefore = (await j("/api/agents")).find((a) => a.id === agent.id);

	// 原生 Chrome 必须拿真实 HOME / TMPDIR（服务进程那份临时目录不能传下去）；父进程若是合成环境也不会漏
	browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"], env: nativeLaunchBrowserEnv({ syntheticRoots: [RUN_DIR] }) });
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", colorScheme: "dark" });
	// 种子：两个 DIY 主题进 localStorage（应用启动会用真实 installCustomThemes 读入并注入 CSS）
	await ctx.addInitScript(([steps, smooth]) => {
		if (!localStorage.getItem("pia.customThemes")) {
			localStorage.setItem("pia.customThemes", JSON.stringify([steps, smooth]));
			localStorage.setItem("pia.theme", "dark");
			localStorage.setItem("pia.skin", "custom-" + steps.id);
			localStorage.setItem("pia.accent", "");
		}
	}, [MANIFEST_STEPS, MANIFEST_SMOOTH]);
	let page = await ctx.newPage();
	page.setDefaultTimeout(20_000);
	const pageErrors = []; // 真正的 JS 异常（断言用）
	const consoleErrors = []; // 控制台错误（含本夹具故意模拟的 500，仅诊断用）
	const attachErrorLog = (p) => {
		p.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
		p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`console: ${m.text().slice(0, 200)}`); if (process.env.DEBUG_SLIDER && m.text().startsWith("DBG:")) console.log(m.text()); });
		if (process.env.DEBUG_SLIDER) {
			p.on("request", (r) => r.method() !== "GET" && console.log(`[page req] ${r.method()} ${r.url().replace(BASE, "")} ${r.postData() ?? ""}`));
			const poll = setInterval(async () => {
				try {
					const s = await p.evaluate(() => ({ d: !!document.querySelector('[data-testid="settings-dialog"]'), chip: !!document.querySelector('[data-testid="default-model-picker"]'), act: document.activeElement?.className?.slice(0, 40) ?? "", url: location.pathname + location.search }));
					console.log(`[dbg] ${JSON.stringify(s)}`);
				} catch {}
			}, 700);
			p.on("close", () => clearInterval(poll));
		}
	};
	attachErrorLog(page);

	await page.route("**/api/themes/draft", async (route) => {
		const req = route.request().postDataJSON();
		const prev = req?.previousManifest;
		const manifest = prev?.motion?.style === "steps" ? MANIFEST_AI_V2 : MANIFEST_AI_V1;
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, turnId: req?.turnId ?? "t1", manifest, text: "已生成。", warnings: [] }) });
	});

	/* ------------------------------ 滑块辅助 ------------------------------ */
	// 两层弹层后，滑块在**紧凑层**（点开模型芯片的第一层）；完整目录只选模型，不再放滑块
	const COMPACT = "model-picker-compact";
	const popover = (menuTestid) => page.locator(`[data-testid="${menuTestid ?? COMPACT}"] [data-testid="thinking-body"]`);
	const openComposerMenu = async () => {
		// 弹层（placement=up）会盖住输入栏芯片，开着的时候真实点击点不到：先合法关掉再打开
		await closeModelPanel(page);
		await page.getByTestId("model-picker").click();
		await page.getByTestId(COMPACT).waitFor();
		await popover().waitFor();
		return popover();
	};
	/** 读当前已提交档位下标 */
	const nowIndex = async () => Number(await popover().locator(".pa-think-handle").getAttribute("aria-valuenow"));
	/** 拖到指定下标：按下先落在当前档（不触发新预览），再移到目标档（触发该档预览），不松手 */
	const dragTo = async (target) => {
		const root = popover();
		const box = await root.locator(".pa-think-track-inner").boundingBox();
		const now = Number(await root.locator(".pa-think-handle").getAttribute("aria-valuenow"));
		await page.mouse.move(box.x + box.width * (now / 6), box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * (target / 6), box.y + box.height / 2, { steps: 4 });
		return box;
	};
	const stepsOf = (root) => root.locator(".pa-think-step");
	const moStyleOf = (root) => root.evaluate((el) => el.getAttribute("data-pa-mo-style"));
	const handleStyle = (root) => root.locator(".pa-think-handle").evaluate((el) => { const s = getComputedStyle(el); return { transitionDuration: s.transitionDuration, transitionProperty: s.transitionProperty }; });
	/** 记录发给某个助理的 PATCH 请求（判断「有没有真的写」） */
	let patches = [];
	page.on("request", (r) => {
		if (r.method() === "PATCH" && r.url().includes("/api/agents/")) {
			try { patches.push(r.postDataJSON()); } catch { patches.push({}); }
		}
	});
	const resetPatches = () => { patches = []; };

	/* ================================ A) 滑块端到端 ================================ */
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.getByTestId("model-picker").waitFor();

	await step("A1 七档全量：弹层里 7 个刻度、档位顺序 = Pi 顺序、aria 正确", async () => {
		const root = await openComposerMenu();
		const n = await stepsOf(root).count();
		if (n !== 7) throw new Error(`应有 7 个刻度：${n}`);
		const ids = await stepsOf(root).evaluateAll((els) => els.map((e) => e.getAttribute("data-testid").replace("thinking-", "")));
		if (JSON.stringify(ids) !== JSON.stringify(LEVELS)) throw new Error(`档位顺序不对：${JSON.stringify(ids)}`);
		const aria = await root.locator(".pa-think-handle").evaluate((el) => ({ now: el.getAttribute("aria-valuenow"), text: el.getAttribute("aria-valuetext"), max: el.getAttribute("aria-valuemax"), role: el.getAttribute("role") }));
		if (aria.role !== "slider" || aria.max !== "6") throw new Error(`aria 不对：${JSON.stringify(aria)}`);
		for (const l of LEVELS) if (!(await root.locator(`[data-testid="thinking-${l}"]`).count())) throw new Error(`缺档位按钮 ${l}`);
		// 最终视觉去掉了「一排 7 个小标签」：档位中文名改由每个刻度的 aria-label / title 承载
		const tips = await stepsOf(root).evaluateAll((els) => els.map((e) => ({ label: e.getAttribute("aria-label"), title: e.getAttribute("title") || "" })));
		if (JSON.stringify(tips.map((t) => t.label)) !== JSON.stringify(LEVELS.map((l) => LABEL[l]))) throw new Error(`刻度中文名不对：${JSON.stringify(tips)}`);
		for (const t of tips) if (!t.title) throw new Error(`刻度应有中文 tooltip：${JSON.stringify(t)}`);
		if (await root.locator(".pa-think-labels").count()) throw new Error("不该再挤一排 7 个小标签");
		// 初始档位必须来自服务端真值（没有本地假默认）：未显式设过 → 最低支持档 off
		const wantNow = agentBefore.thinking ? LEVELS.indexOf(agentBefore.thinking) : 0;
		if (Number(aria.now) !== wantNow) throw new Error(`初始档位应来自服务端真值（${agentBefore.thinking ?? "null"}→${wantNow}）：${aria.now}`);
		// 主模型菜单同样要“完整头部”（旧实现在这里只有一行「思考强度」小标题，没有当前档 / 模型名）：
		// 当前档中文 + 实际选中模型名；外层不再重复一行小标题
		const head = await page.getByTestId("model-thinking").evaluate((el) => ({
			heads: el.querySelectorAll(".pa-think-head").length,
			cur: el.querySelector(".pa-think-cur")?.textContent ?? "",
			model: el.querySelector(".pa-think-model")?.textContent ?? "",
			rows: el.children.length,
			first: el.firstElementChild?.className ?? "",
		}));
		if (head.heads !== 1) throw new Error(`模型菜单里应有且只有一个滑块头部：${JSON.stringify(head)}`);
		if (head.cur !== LABEL[LEVELS[wantNow]]) throw new Error(`头部应显示当前档中文「${LABEL[LEVELS[wantNow]]}」：${JSON.stringify(head)}`);
		if (head.model !== MAIN) throw new Error(`头部应显示实际选中的模型名「${MAIN}」（不是写死的示例名）：${JSON.stringify(head)}`);
		if (head.rows !== 1 || !head.first.includes("pa-think")) throw new Error(`不该再有外层「思考强度」小标题（与头部重复）：${JSON.stringify(head)}`);
	});

	await step("A1b 视觉：粗胶囊轨道 + 实心圆钮（无档位文字），min/max 不越出轨道", async () => {
		const root = await openComposerMenu();
		// 这里是输入栏的模型菜单（宽度由菜单自己定），独立思考弹层的 320–360 宽度在 thinking-slider-visual.mjs 验
		const pw = (await page.getByTestId(COMPACT).boundingBox()).width;
		if (pw < 240 || pw > 380) throw new Error(`模型菜单宽度异常：${pw}`);
		const rail = await root.locator(".pa-think-rail").boundingBox();
		if (!(rail.height >= 32 && rail.height <= 42)) throw new Error(`轨道高度应在 32–42：${rail.height}`);
		const trackBox = await root.locator(".pa-think-track").boundingBox();
		if (trackBox.height < 44) throw new Error(`轨道命中区应 ≥44：${trackBox.height}`);
		const shape = await root.locator(".pa-think-handle").evaluate((el) => {
			const s = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			return { w: r.width, h: r.height, bg: s.backgroundColor, radius: s.borderRadius, text: el.textContent.trim() };
		});
		if (!(shape.w >= 40 && shape.w <= 48 && shape.h >= 40 && shape.h <= 48)) throw new Error(`滑钮应在 40–48：${JSON.stringify(shape)}`);
		if (shape.text) throw new Error(`滑钮里不该有档位文字：${shape.text}`);
		if (shape.bg === "rgba(0, 0, 0, 0)" || shape.bg === "transparent") throw new Error(`滑钮应是实心高对比：${shape.bg}`);
		// 拖到最左 / 最右量边界（不松手 = 不提交），再 Esc 取消
		resetPatches();
		for (const [pos, name] of [[0, "off"], [1, "max"]]) {
			const inner = await root.locator(".pa-think-track-inner").boundingBox();
			const y = inner.y + inner.height / 2;
			await page.mouse.move(inner.x + inner.width * 0.5, y);
			await page.mouse.down();
			await page.mouse.move(inner.x + inner.width * pos, y, { steps: 3 });
			await page.waitForTimeout(100);
			const hb = await root.locator(".pa-think-handle").boundingBox();
			if (hb.x < inner.x - 1 || hb.x + hb.width > inner.x + inner.width + 1) throw new Error(`${name} 档滑钮越出轨道：${JSON.stringify({ hb, inner })}`);
			// 拖动预览态：头部与 aria-valuetext 都要是正在预览的档，不能还停在已提交档
			const draggingHead = await root.locator(".pa-think-cur").textContent();
			const draggingVt = await root.locator(".pa-think-handle").getAttribute("aria-valuetext");
			if (draggingHead !== LABEL[name]) throw new Error(`${name}：拖动未松手时头部应显示预览档「${LABEL[name]}」：${draggingHead}`);
			if (draggingVt !== `思考强度：${LABEL[name]}`) throw new Error(`${name}：aria-valuetext 应与头部一致：${draggingVt}`);
			if (patches.length) throw new Error(`拖动未松手时不应写库：${JSON.stringify(patches)}`);
			await page.keyboard.press("Escape");
			await page.mouse.up();
			await page.getByTestId(COMPACT).waitFor({ state: "detached" });
			await openComposerMenu();
		}
		// 取消后后端真值没变（max 只是预览，没被持久化）
		const afterDrag = (await j("/api/agents")).find((a) => a.id === agent.id)?.thinking ?? null;
		if (afterDrag !== (agentBefore.thinking ?? null)) throw new Error(`取消拖动后 thinking 被改了：${JSON.stringify({ before: agentBefore.thinking ?? null, afterDrag })}`);
		await page.keyboard.press("Escape");
	});

	await step("A2 键盘逐档提交（End/ArrowLeft/Home）每次只写一次；提交后弹层按原行为关闭；Esc 后焦点回芯片", async () => {
		/** 打开弹层 → 聚焦手柄 → 按一个键 → 等这次提交落地（提交即关弹层，是既有行为） */
		const keyCommit = async (key) => {
			await openComposerMenu();
			const root = popover();
			await root.locator(".pa-think-handle").focus();
			resetPatches();
			await page.keyboard.press(key);
			await waitFor(() => patches.length === 1);
			await page.getByTestId(COMPACT).waitFor({ state: "detached" });
			return patches[0].thinking;
		};
		if ((await keyCommit("End")) !== "max") throw new Error("End 应提交 max");
		if ((await keyCommit("ArrowLeft")) !== "xhigh") throw new Error("ArrowLeft 应提交 xhigh");
		if ((await keyCommit("Home")) !== "off") throw new Error("Home 应提交 off");
		await waitFor(async () => (await j("/api/agents")).find((a) => a.id === agent.id)?.thinking === "off");
		// 键盘打开（Enter）→ 焦点进菜单（模型菜单里是搜索框；ThinkingButton 那种无搜索框的弹层才直接落手柄）；
		// 手柄本身可被键盘聚焦并逐档提交（上面 keyCommit 已证），Esc 只关弹层、焦点回芯片
		await page.getByTestId("model-picker").focus();
		await page.keyboard.press("Enter");
		await page.getByTestId(COMPACT).waitFor();
		const inMenu = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="model-picker-compact"]'));
		if (!inMenu) throw new Error(`键盘打开后焦点应在弹层内：${await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120))}`);
		await page.keyboard.press("Escape");
		await page.getByTestId(COMPACT).waitFor({ state: "detached" });
		// 模型菜单（ModelPickerButton）的 Esc 只关弹层，不主动搬焦点（「Esc 后焦点回芯片」是 ThinkingButton 的行为，由子代理夹具覆盖）
		const stuck = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="model-picker-compact"]'));
		if (stuck) throw new Error("Esc 关闭后焦点不应还留在已移除的弹层里");
	});

	await step("A3 点同一档：不关弹层、也不多发请求（D 语义，与注释/设计稿一致）", async () => {
		await openComposerMenu();
		const root = popover();
		const now = await root.locator(".pa-think-handle").getAttribute("aria-valuenow");
		const same = LEVELS[Number(now)];
		resetPatches();
		await root.locator(`[data-testid="thinking-${same}"]`).click();
		await page.waitForTimeout(400);
		if (!(await page.getByTestId(COMPACT).count())) throw new Error("点同一档不应关弹层");
		if (patches.length) throw new Error(`点同一档不应写请求：${JSON.stringify(patches)}`);
	});

	await step("A4 拖动：拖动中不写，pointerup 才写一次（snap 到最近档）", async () => {
		await openComposerMenu();
		const root = popover();
		const box = await root.locator(".pa-think-track-inner").boundingBox();
		const now = Number(await root.locator(".pa-think-handle").getAttribute("aria-valuenow"));
		const target = now === 6 ? 0 : 6; // 终点与当前不同（同档不写是另一条规则，A3 已覆盖）
		resetPatches();
		await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 5 });
		await page.waitForTimeout(250);
		if (patches.length) throw new Error(`拖动中不应写：${JSON.stringify(patches)}`);
		await page.mouse.move(box.x + box.width * (target === 0 ? 0.02 : 0.98), box.y + box.height / 2, { steps: 3 });
		await page.mouse.up();
		await waitFor(() => patches.length === 1);
		if (patches[0].thinking !== LEVELS[target]) throw new Error(`pointerup 应提交 snap 后的 ${LEVELS[target]}：${JSON.stringify(patches)}`);
		await page.getByTestId(COMPACT).waitFor({ state: "detached" });
	});

	await step("A5 拖动后窗口失焦 / Esc：都不写，且回到已提交档", async () => {
		await openComposerMenu();
		const root = popover();
		const track = root.locator(".pa-think-track-inner");
		const box = await track.boundingBox();
		const before = await root.locator(".pa-think-handle").getAttribute("aria-valuenow");
		resetPatches();
		await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2, { steps: 3 });
		await page.evaluate(() => window.dispatchEvent(new Event("blur"))); // 窗口失焦 → cancelDrag
		await page.waitForTimeout(200);
		const during = await root.locator(".pa-think-handle").getAttribute("aria-valuenow");
		await page.mouse.up();
		await page.waitForTimeout(300);
		if (patches.length) throw new Error(`失焦取消不应写：${JSON.stringify(patches)}`);
		if (during !== before) throw new Error(`失焦后手柄应回到已提交档：${before} → ${during}`);
		// Esc 关闭不写
		resetPatches();
		await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 3 });
		await page.keyboard.press("Escape");
		await page.mouse.up();
		await page.waitForTimeout(300);
		if (patches.length) throw new Error(`Esc 取消不应写：${JSON.stringify(patches)}`);
		if (await page.getByTestId(COMPACT).count()) throw new Error("Esc 应关闭弹层");
	});

	await step("A6 子集：切到只支持 low..max 的模型 → 刻度只剩支持的档（不凭空补，也不吞）", async () => {
		await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: prov.id, id: SUBSET } });
		await page.reload();
		await page.getByTestId("model-picker").waitFor();
		const root = await openComposerMenu();
		const ids = await stepsOf(root).evaluateAll((els) => els.map((e) => e.getAttribute("data-testid").replace("thinking-", "")));
		const want = catalog.find((m) => m.provider === prov.id && m.id === SUBSET).thinking;
		if (JSON.stringify(ids) !== JSON.stringify(want)) throw new Error(`子集应等于目录：${JSON.stringify({ ids, want })}`);
		if (ids.includes("off") || ids.includes("minimal")) throw new Error(`该模型不支持 off/minimal，不该补：${JSON.stringify(ids)}`);
	});

	const setModel = async (id) => {
		await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: prov.id, id } });
		await page.reload();
		await page.getByTestId("model-picker").waitFor();
	};

	await step("A7 非推理模型（只有 off）：紧凑层不画滑块、如实说明；目录层不重复强度块", async () => {
		await setModel("plain-noreason");
		// 紧凑层仍打开（要能看 Fast / 换模型），只是不画滑块
		await page.getByTestId("model-picker").click();
		await page.getByTestId(COMPACT).waitFor();
		if (await page.locator('[data-testid="model-picker-compact"] .pa-think-handle').count()) throw new Error("单档 / 非推理不应画滑块");
		if (!(await page.getByTestId("thinking-unsupported").count())) throw new Error("应如实说明这个模型不支持调整思考强度");
		// 目录层只选模型：同一套强度 / Fast 不再重复
		await page.getByTestId(COMPACT).getByTestId("thinking-model").click();
		await page.getByTestId("model-menu").waitFor();
		if (await page.locator('[data-testid="model-menu"] [data-testid="thinking-body"]').count()) throw new Error("目录层不应再重复滑块");
		if (await page.locator('[data-testid="model-menu"] [data-testid="thinking-fast"]').count()) throw new Error("目录层不应再重复 Fast");
		await page.keyboard.press("Escape");
		await page.getByTestId(COMPACT).waitFor();
	});

	await step("A8 跟随语义只出现在子代理（助理级）：主会话没有「跟随」reset 项", async () => {
		await setModel(MAIN);
		const root = await openComposerMenu();
		if (await root.locator('[data-testid="thinking-follow"]').count()) throw new Error("主会话不该有「跟随」条");
		await page.keyboard.press("Escape");
	});

	await step("A9 390 宽 × 四主题（noir/glass/warm/pixel）：弹层不横向溢出；pixel 走 steps 分支", async () => {
		await page.setViewportSize({ width: 390, height: 780 });
		for (const skin of ["noir", "glass", "warm", "pixel"]) {
			await page.goto(`${BASE}/?agent=${agent.id}&settings=appearance`);
			await page.getByTestId("settings-dialog").waitFor();
			await page.locator(`[data-theme-id="${skin}"]`).click();
			await page.keyboard.press("Escape");
			await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
			await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.skin)) === skin);
			await openComposerMenu();
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
			if (overflow > 2) throw new Error(`${skin} 390 溢出 ${overflow}px`);
			const root = popover();
			const mo = await moStyleOf(root);
			if (skin === "pixel") {
				if (mo !== "steps") throw new Error(`pixel 应走 steps 分支：${mo}`);
			} else if (mo === "steps") throw new Error(`${skin} 不该有 steps 分支：${mo}`);
			await page.keyboard.press("Escape");
		}
		await page.setViewportSize({ width: 1280, height: 900 });
	});

	/* ================================ B) DIY 动效 → 滑块 ================================ */
	await step("B1 保存的 DIY 主题（steps, scale 1.2）：滑块走真实 steps 分支 + 拖动预览动效 steps(3,end) + 时长 ×1.2", async () => {
		// 切到已种下的 steps DIY 主题（真实外观设置路径）
		await page.goto(`${BASE}/?agent=${agent.id}&settings=appearance`);
		await page.getByTestId("settings-dialog").waitFor();
		await page.locator(`[data-theme-id="custom-${STEPS_ID}"]`).click();
		await page.keyboard.press("Escape");
		await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
		await openComposerMenu();
		const root = popover();
		if ((await moStyleOf(root)) !== "steps") throw new Error("DIY steps 主题应映射成 data-pa-mo-style=steps");
		const hs = await handleStyle(root);
		if (hs.transitionDuration !== "0s") throw new Error(`steps 分支手柄 transition 应为 none(0s)：${JSON.stringify(hs)}`);
		if ((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--mo-scale").trim())) !== "1.2") throw new Error("DIY 主题的 --mo-scale 应为 1.2");
		// 预览动效只在拖动 / 切换过程中可见（一提交就关弹层，所以不能用键盘提交后去读）；
		// 目标档必须与当前不同（拖回同一档本来就不写，这是另一条已覆盖的规则）
		const PREVIEW_MS = { 3: 480, 6: 700 };
		const target = (await nowIndex()) === 3 ? 6 : 3;
		await dragTo(target);
		await root.locator(".pa-think-pulse").waitFor();
		const level = await root.locator(".pa-think-handle").getAttribute("aria-valuetext");
		const star = await root.locator(".pa-think-pulse .pa-think-star").first().evaluate((el) => { const s = getComputedStyle(el); return { timing: s.animationTimingFunction, dur: s.animationDuration, name: s.animationName }; });
		await page.mouse.up();
		if (!star.timing.includes("steps(3")) throw new Error(`steps 主题下预览动效应是 steps(3,end)：${JSON.stringify({ level, star })}`);
		if (star.name === "none") throw new Error(`应有动画名：${JSON.stringify(star)}`);
		if (!String(level).includes(LABEL[LEVELS[target]])) throw new Error(`拖到第 ${target} 档应是「${LABEL[LEVELS[target]]}」：${level}`);
		const wantMs = PREVIEW_MS[target] * 1.2;
		const gotMs = Number.parseFloat(star.dur) * (/ms$/.test(star.dur) ? 1 : 1000);
		if (Math.abs(gotMs - wantMs) > 5) throw new Error(`${LEVELS[target]} 档预览时长应 = ${PREVIEW_MS[target]}ms × --mo-scale 1.2 = ${wantMs}ms，实际 ${star.dur}`);
		await page.getByTestId(COMPACT).waitFor({ state: "detached" });
	});

	await step("B2 reduce：拖动预览完全不播（无 pa-think-pulse）、过渡被 CSS 关掉，提交仍可达", async () => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await openComposerMenu();
		const root = popover();
		if ((await handleStyle(root)).transitionDuration !== "0s") throw new Error("reduce 应关掉手柄过渡");
		resetPatches();
		const target = (await nowIndex()) === 0 ? 3 : 0; // 必须换到别的档，提交才发生（证明 reduce 下档位仍可达）
		await dragTo(target);
		await page.waitForTimeout(350);
		if (await root.locator(".pa-think-pulse").count()) throw new Error("reduce 下不应用预览动效（不应出现 pa-think-pulse）");
		await page.mouse.up();
		await waitFor(() => patches.length === 1);
		await page.getByTestId(COMPACT).waitFor({ state: "detached" });
		await page.emulateMedia({ reducedMotion: "no-preference" });
	});

	await step("B3 主题实时切换 steps↔smooth：不重挂组件、焦点保持、computed 真的变（A 修复的核心）", async () => {
		if (await page.getByTestId(COMPACT).count()) await page.keyboard.press("Escape");
		// 真实打开主题设计面板（AI 草稿假响应：第一版 steps）
		await page.goto(`${BASE}/?agent=${agent.id}&settings=appearance`);
		await page.getByTestId("settings-dialog").waitFor();
		await page.locator(`[data-theme-id="custom-${STEPS_ID}"]`).click();
		await page.getByTestId("open-theme-designer").click();
		await page.getByTestId("theme-prompt").fill("离散一点");
		await page.getByTestId("theme-generate").click();
		await page.getByTestId("theme-apply").waitFor();
		if ((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--mo-style").trim())) !== "steps") throw new Error("预览应是 steps");
		// 弹层用真实 chip 的自身 click 打开（不经鼠标命中：设计面板是模态，挡住了芯片）；之后不再有任何 mousedown
		await page.evaluate(() => document.querySelector('[data-testid="model-picker"]').click());
		const root = popover();
		await root.waitFor();
		if ((await moStyleOf(root)) !== "steps") throw new Error("预览 steps 应先映射到滑块");
		const marked = await root.evaluate((el) => { el.dataset.e2eMark = "same-node"; return el.dataset.e2eMark; });
		await root.locator(".pa-think-handle").focus();
		const before = await handleStyle(root);
		if (before.transitionDuration !== "0s") throw new Error(`steps 下应无过渡：${JSON.stringify(before)}`);
		// 真实 onChange（主题设计面板的「动效微调」下拉）→ revisePreview：同一 custom id 只改 <style> 文本
		await page.getByTestId("theme-motion").evaluate((el) => (el.open = true));
		const changed = await page.evaluate(() => {
			const sel = document.querySelector('[data-testid="theme-motion-style"]');
			sel.value = "smooth";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
			return sel.value;
		});
		if (changed !== "smooth") throw new Error("下拉没切到 smooth");
		await waitFor(async () => (await moStyleOf(popover())) === "smooth");
		const after = popover();
		if ((await after.evaluate((el) => el.dataset.e2eMark)) !== "same-node" || marked !== "same-node") throw new Error("切主题后滑块被重挂了（DOM 标记丢失）");
		if (!(await page.getByTestId(COMPACT).count())) throw new Error("切主题把弹层关掉了（不该有 mousedown）");
		const focused = await page.evaluate(() => document.activeElement?.className || "");
		if (!String(focused).includes("pa-think-handle")) throw new Error(`切主题不应丢焦点：${focused}`);
		const hs = await handleStyle(after);
		if (hs.transitionDuration === "0s") throw new Error(`smooth 下应恢复过渡：${JSON.stringify(hs)}`);
		// 再切回 steps：仍然同节点
		await page.evaluate(() => {
			const sel = document.querySelector('[data-testid="theme-motion-style"]');
			sel.value = "steps";
			sel.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await waitFor(async () => (await moStyleOf(popover())) === "steps");
		const back = popover();
		if ((await back.evaluate((el) => el.dataset.e2eMark)) !== "same-node") throw new Error("切回 steps 重挂了");
	});

	await step("B4 preview 取消：完整还原外观、不留临时样式，滑块回到原主题分支（重新打开即为真值）", async () => {
		// 真实用户点「取消」时鼠标事件本身就会关掉弹层（弹层在模态之上，会挡住按钮）——先关弹层再点取消
		await page.keyboard.press("Escape");
		await page.getByTestId(COMPACT).waitFor({ state: "detached" });
		await page.getByTestId("theme-cancel").click();
		await page.getByTestId("theme-designer").waitFor({ state: "detached" });
		if (await page.locator("#pa-theme-preview").count()) throw new Error("取消后不应残留临时预览 <style>");
		await waitFor(async () => (await page.evaluate(() => document.documentElement.dataset.skin)) === `custom-${STEPS_ID}`);
		// 弹层已被合法关掉；设置模态还开着（外观页），先关掉它再点输入栏芯片
		if (await page.getByTestId(COMPACT).count()) await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");
		await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
		await openComposerMenu();
		const root = popover();
		if ((await moStyleOf(root)) !== "steps") throw new Error(`取消后应回到原主题 steps：${await moStyleOf(root)}`);
		await page.keyboard.press("Escape");
	});

	/* ================================ C) 保存的「最后一次为准」 ================================ */
	// C 只在设置 › 模型服务里操作，不依赖聊天页；换一个干净标签页（同一浏览器环境，仍带用户登录/本地设置）
	await page.close();
	page = await ctx.newPage();
	page.setDefaultTimeout(20_000);
	attachErrorLog(page);
	if (process.env.DEBUG_SLIDER) await page.addInitScript(() => {
		const log = (e) => console.log("DBG:" + e.type + " " + (e.target?.getAttribute?.("data-testid") || e.target?.tagName || "?") + (e.key ? ` key=${e.key}` : "") + ` trusted=${e.isTrusted}` + " | " + String(e.target?.className || "").slice(0, 60) + " act=" + String(document.activeElement?.className || "").slice(0, 30));
		for (const t of ["mousedown", "pointerdown", "click", "keydown"]) document.addEventListener(t, log, true);
	});
	/** 设置 › 模型服务里的默认模型选择器（失败时把内容与页面错误一起报出来，便于定位） */
	const defaultChip = () => page.getByTestId("default-model-picker").first();
	const defaultMenu = () => page.locator('[data-testid="default-model-menu"] [data-testid="thinking-body"]');
	/** 进入设置 → 切到「模型服务」→ 点开默认模型选择器 */
	const openDefaultModelMenu = async (fresh) => {
		if (fresh) {
			await page.goto(`${BASE}/?agent=${agent.id}`);
			await page.getByTestId("model-picker").waitFor();
			// 真实入口：侧边栏「设置」→「模型服务」标签（等模态进入动画结束，避免误点遮罩把模态关掉）
			await page.locator('button[aria-label="设置"]').click();
			await page.getByTestId("settings-dialog").waitFor();
			await page.waitForTimeout(300);
			await page.locator('[data-testid="settings-nav"] button[data-tab="models"]').click();
			await page.waitForTimeout(150);
		} else {
			if (await page.getByTestId("default-model-menu").count()) {
				await page.keyboard.press("Escape");
				await page.getByTestId("default-model-menu").waitFor({ state: "detached" });
			}
			if (!(await page.getByTestId("settings-dialog").count())) {
				await page.locator('button[aria-label="设置"]').click();
				await page.getByTestId("settings-dialog").waitFor();
				await page.waitForTimeout(300);
				await page.locator('[data-testid="settings-nav"] button[data-tab="models"]').click();
				await page.waitForTimeout(150);
			}
		}
		try {
			await defaultChip().click({ timeout: 10_000 });
			await page.getByTestId("default-model-menu").waitFor({ timeout: 10_000 });
			await defaultMenu().waitFor({ timeout: 10_000 });
		} catch (e) {
			const content = await page.getByTestId("settings-content").innerText().catch(() => "<无 settings-content>");
			const body = (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, "|").slice(0, 220);
			const counts = await page.evaluate(() => ({ dialog: !!document.querySelector('[data-testid="settings-dialog"]'), nav: !!document.querySelector('[data-testid="settings-nav"]'), defaultModel: !!document.querySelector('[data-testid="default-model"]'), url: location.href.replace(location.origin, "") }));
			throw new Error(`打不开默认模型选择器（${String(e).split("\n")[0]}）：content=${content.slice(0, 120)} | dom=${JSON.stringify(counts)} | body=${body} | 异常：${pageErrors.join(" | ") || "无"} | 控制台：${consoleErrors.slice(-2).join(" | ") || "无"}`);
		}
		return defaultMenu();
	};

	await step("C1 迟到的失败(A) 不覆盖用户后一次选择(B)；服务端真值是 B", async () => {
		await page.unroute("**/api/models/default");
		let n = 0;
		await page.route("**/api/models/default", async (route) => {
			const req = route.request();
			if (process.env.DEBUG_SLIDER) console.log(`[route] ${req.method()} ${req.url().replace(BASE, "")} ${req.postData() ?? ""}`);
			if (req.method() !== "PUT" || req.postDataJSON()?.thinking === undefined) return route.continue();
			n += 1;
			if (n === 1) {
				await new Promise((r) => setTimeout(r, 1500)); // A 的响应迟到
				return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟失败" }) });
			}
			return route.continue();
		});
		await j("/api/models/default", "PUT", { thinking: "low" }); // 已知的服务端值
		const menu = await openDefaultModelMenu(true);
		// A = medium（必失败、迟到）
		await menu.locator(".pa-think-handle").focus();
		await page.keyboard.press("ArrowRight");
		await waitFor(() => n === 1);
		// 提交后弹层已按原行为关闭（所以这里不按 Escape：那会关掉设置模态）
		// B = max（后发、成功）——不能等 A 回来
		await (await openDefaultModelMenu(false)).locator(".pa-think-handle").focus();
		await page.keyboard.press("End");
		await page.waitForTimeout(1900); // 等 A 的迟到 500 到达
		const chip = await page.getByTestId("default-model-picker").innerText();
		if (!chip.includes("最大")) throw new Error(`迟到的失败不应把 B(max) 回滚掉：${chip}`);
		const srv = await j("/api/models/defaults");
		if (srv.thinking !== "max") throw new Error(`服务端真值应是 max：${srv.thinking}`);
	});

	await step("C2 最新一次失败：回落到服务端确认值并回读真值（不留假值）", async () => {
		await page.unroute("**/api/models/default");
		let n = 0;
		await page.route("**/api/models/default", async (route) => {
			const req = route.request();
			if (req.method() !== "PUT" || req.postDataJSON()?.thinking === undefined) return route.continue();
			n += 1;
			if (n === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟失败" }) });
			return route.continue();
		});
		await (await openDefaultModelMenu(false)).locator(".pa-think-handle").focus();
		await page.keyboard.press("Home"); // off，会失败（提交即关弹层）
		await waitFor(async () => (await page.getByTestId("default-model-picker").innerText()).includes("最大"), 8000);
		const chip = await page.getByTestId("default-model-picker").innerText();
		if (!chip.includes("最大")) throw new Error(`失败应回落到服务端确认值 max：${chip}`);
		const srv = await j("/api/models/defaults");
		if (srv.thinking !== "max") throw new Error(`服务端不该被这次失败改动：${srv.thinking}`);
	});

	await step("C3 卸载（关设置）时在飞响应不落地、不串别的助理，重开对齐服务端真值", async () => {
		await page.unroute("**/api/models/default");
		let n = 0;
		await page.route("**/api/models/default", async (route) => {
			const req = route.request();
			if (req.method() !== "PUT" || req.postDataJSON()?.thinking === undefined) return route.continue();
			n += 1;
			if (n === 1) {
				await new Promise((r) => setTimeout(r, 1200));
				return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟失败" }) });
			}
			return route.continue();
		});
		await (await openDefaultModelMenu(false)).locator(".pa-think-handle").focus();
		await page.keyboard.press("Home"); // 失败且迟到（提交即关弹层）
		await page.keyboard.press("Escape"); // 关设置（卸载 DefaultModelPicker）
		await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
		await page.waitForTimeout(1600);
		if (pageErrors.length) throw new Error(`卸载后有页面错误：${pageErrors.join(" | ")}`);
		await page.locator('button[aria-label="设置"]').click();
		await page.getByTestId("settings-dialog").waitFor();
		await page.waitForTimeout(300);
		await page.locator('[data-testid="settings-nav"] button[data-tab="models"]').click();
		await defaultChip().waitFor();
		const chip = await defaultChip().innerText();
		if (!chip.includes("最大")) throw new Error(`重开后应对齐服务端真值 max：${chip}`);
		// 助理自己的思考强度没被这次默认值写入串到
		const ag = (await j("/api/agents")).find((a) => a.id === agent.id);
		if (!LEVELS.includes(ag.thinking)) throw new Error(`助理 thinking 应保持合法档位：${ag.thinking}`);
	});

	await step("C4 助理滑块与默认设置互不串：改默认思考强度不改助理，改助理不改默认", async () => {
		await page.unroute("**/api/models/default");
		const before = (await j("/api/agents")).find((a) => a.id === agent.id).thinking;
		await (await openDefaultModelMenu(false)).locator(".pa-think-handle").focus();
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.press("Escape"); // 只关设置模态（弹层已被提交关掉）
		await waitFor(async () => (await j("/api/models/defaults")).thinking !== "max");
		const after = (await j("/api/agents")).find((a) => a.id === agent.id).thinking;
		if (after !== before) throw new Error(`改默认不该动助理 thinking：${before} → ${after}`);
	});

	console.log("\n[thinking-slider-ui]", `${results.filter(([s]) => s === "✅").length}/${results.length} 通过`);
} finally {
	await browser?.close().catch(() => {});
	if (server.exitCode === null) {
		const done = new Promise((r) => server.once("exit", r));
		killServerTree("SIGTERM");
		await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
		if (server.exitCode === null) killServerTree("SIGKILL");
	}
	// 只删本次 mkdtemp 出来的目录（含 data / workspace / home / tmp）
	if (RUN_DIR.startsWith(join(tmpdir(), "pia-e2e-thinking-slider-"))) rmSync(RUN_DIR, { recursive: true, force: true });
}
const failed = results.filter(([s]) => s === "❌");
if (failed.length) console.log(failed.map(([, n, e]) => `- ${n}: ${e}`).join("\n"));
process.exitCode = failed.length ? 1 : 0;
