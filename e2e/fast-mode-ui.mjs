/**
 * 请求级 Fast（`service_tier: priority`）的**真实界面交互**验证（只跑这一个脚本，不跑全量 e2e）。
 *
 * 覆盖（对应 docs/design/fast-mode-contract.md §7，之前只有纯函数 / 静态 DOM 测试，这里补真 DOM）：
 *  1) 紧凑层里的闪电是真按钮：aria-pressed / 能力不可用时 aria-disabled 仍可聚焦看原因；
 *  2) 悬停约 450ms 出说明（不是 native title）；**说明开着时按 Esc 只关说明，紧凑层菜单还在**；
 *  3) 点一下真的 PATCH `{fast:true}` → aria-pressed 跟手 → 刷新后仍在（服务端持久化）；
 *  4) 保存失败：只回滚 fast（界面回到原状态）+ 给原因，不假装成功；
 *  5) 失败回滚重读 `GET /api/agents` 被延迟时，切走再回来点新值：旧回滚**不能**覆盖最新点击（5f7987f 代次复查）；
 *     同一入口保存中会挡重复点击，所以用「切换助理再回来」得到新的入口实例（同一助理共用一份 LatestWrite）；
 *  6) 键盘打开（Enter）焦点落在模型名；Shift+Tab 到 Fast；Esc 关闭后焦点不留在已移除的弹层里；
 *  7) 390 宽：紧凑层不横向溢出、不出屏；
 *  8) 两层：点模型名进目录（搜索 / 返回不改值 / 选完回紧凑层并更新头部），目录层不重复滑块与 Fast；
 *  9) 子代理对话面板：闪电跟随所属助理 / 独立开关 / 失败回滚 / 1 秒轮询不覆盖保存中 / 恢复跟随；
 *     档位按子代理实际注册模型（七档模型 vs 子集模型）给出；
 * 10) 协议不支持（mock 的 faux 协议）：灯仍显示但 aria-disabled，点击不发请求，说明里写清原因。
 *
 * 截图统一走 `e2e/fixtures/stable-shot.mjs`：等弹层可见 + 有限动画播完 + computed opacity/visibility + 连续几帧几何稳定，
 * **不禁用动画**（动画期间的 opacity:0 / 半透明不能被掩盖）。
 *
 * 不碰真实数据 / 真实 Key / 付费模型：每次 mkdtemp 的 RUN_DIR（DATA / WORKSPACE / HOME / TMPDIR 全在里面），
 * 服务走 `packages/server/test/launch-memory.ts`（公开注入点 = 内存凭据，不构造走 OS 钥匙串的生产后端），
 * `PIA_MOCK=1` + `PIA_OFFLINE=1`，模型渠道指向 127.0.0.1:1（连不通也不会发真实请求）。
 *
 * 浏览器是**原生进程**：统一走 `e2e/fixtures/native-launch-env.mjs` 的 `nativeLaunchBrowserEnv()`
 * （真实 HOME / 真实 TMPDIR；服务进程那份临时目录不受影响）。helper 来自 laya 树 `4b2c5ea`，已复制进本树。
 * 运行：`node e2e/fast-mode-ui.mjs`（先 `npm run build -w @pi-assistant/web`）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";
import { seedSubagent } from "./fixtures/seed-subagent.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";

const { chromium } = await import("playwright-core");
const ROOT = fileURLToPath(new URL("..", import.meta.url));
// 本次运行独占的临时目录；finally 只删这一个（KEEP=1 可保留看现场）
const run = makeTempRun("pia-e2e-fast-mode-");
const OUT = process.env.SHOT_DIR ?? join(run.runDir, "shots");
mkdirSync(OUT, { recursive: true });
const PORT = await new Promise((r) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;
const srv = startTempServer({ root: ROOT, port: PORT, run });
const j = async (path, method = "GET", body) => {
	const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const t = await r.text();
	if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${t}`);
	return t ? JSON.parse(t) : null;
};
const waitFor = async (fn, ms = 20_000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("timeout");
};
let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};
let browser;
const stop = async () => {
	try {
		if (browser) await browser.close();
	} catch {}
	// 有界收尾：整组 SIGTERM，5s 不退再 SIGKILL
	await srv.stop();
};

try {
	await waitFor(async () => (await fetch(`${BASE}/api/system`)).ok);
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = await j("/api/agents", "POST", { name: "Fast 交互验证" });
	// 第二个助理只用于「保存中途切走再回来」得到新的入口实例（同一助理共用一份 LatestWrite）
	const other = await j("/api/agents", "POST", { name: "Fast 切换助理" });
	// 真实 Pi 目录里的七档推理模型（自定义中转同名映射）+ 只支持部分档位的子集模型；只连 127.0.0.1:1
	const MAIN = "anthropic.claude-sonnet-5";
	const SUBSET = "gpt-6.1-sol";
	const relay = await j("/api/models/custom", "POST", {
		name: "本地假中转",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		noKey: true,
		models: [
			{ id: MAIN, reasoning: true },
			{ id: SUBSET, reasoning: true },
		],
	});
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: relay.id, id: MAIN } });
	const catalog = await j("/api/models");
	const fullModel = catalog.find((m) => m.provider === relay.id && m.id === MAIN);
	if (fullModel?.thinking?.length !== 7) throw new Error(`目录里 ${MAIN} 应支持七档：${JSON.stringify(fullModel?.thinking)}`);
	const subsetModel = catalog.find((m) => m.provider === relay.id && m.id === SUBSET);
	const subsetLevels = subsetModel?.thinking ?? [];
	if (!subsetLevels.length || subsetLevels.length >= 7) throw new Error(`目录里 ${SUBSET} 应是部分档位：${JSON.stringify(subsetLevels)}`);
	// 子代理 UI 需要已存在的子代理：只往本次临时数据目录种真实表记录，不派发真实子代理 / 模型请求
	const conversationId = (await j(`/api/agents/${agent.id}/conversations`)).current;
	const subFollow = "sa-fast-follow";
	const subSubset = "sa-fast-subset";
	seedSubagent(run, { id: subFollow, agentId: agent.id, conversationId, provider: relay.id, modelId: MAIN, task: "Fast 跟随验证" });
	seedSubagent(run, { id: subSubset, agentId: agent.id, conversationId, provider: relay.id, modelId: SUBSET, task: "Fast 子集验证" });

	// 原生 Chromium 用 helper 给的那份环境（真实 HOME / 真实 TMPDIR）；服务进程那份临时目录不受影响
	const browserEnvironment = browserEnv(run);
	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"], env: browserEnvironment });
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
	const page = await ctx.newPage();
	page.setDefaultTimeout(20_000);
	const patches = [];
	const modelPatches = [];
	const subPatches = [];
	page.on("request", (r) => {
		if (r.method() === "PATCH" && /\/api\/agents\/[^/]+$/.test(r.url())) {
			try {
				const body = r.postDataJSON();
				if ("fast" in body) patches.push(body);
				if ("model" in body) modelPatches.push(body);
			} catch {}
		}
		if (r.method() === "PATCH" && /\/api\/subagents\/[^/]+$/.test(r.url())) {
			try {
				subPatches.push(r.postDataJSON());
			} catch {}
		}
	});
	const fastBtn = () => page.getByTestId("thinking-fast");
	const compact = () => page.getByTestId("model-picker-compact");
	const openCompact = async () => {
		if (!(await compact().count())) await page.getByTestId("model-picker").click();
		await compact().waitFor();
	};
	const closeAll = async () => {
		for (let i = 0; i < 3; i++) {
			if (!(await compact().count())) return;
			await page.keyboard.press("Escape");
			await page.waitForTimeout(80);
		}
	};
	const switchAgent = async (name) => {
		await page.getByTestId("sidebar-agent").filter({ hasText: name }).first().click();
		await page.getByTestId("model-picker").waitFor();
	};
	await page.goto(`${BASE}/?agent=${agent.id}`);
	await page.getByTestId("model-picker").waitFor();

	// ---------------- 1) 紧凑层里的闪电是真按钮
	console.log("\n[1] 紧凑层：Fast 是真按钮，可请求（requestable）时不 aria-disabled");
	await openCompact();
	await fastBtn().waitFor();
	// 首次加载时模型能力还没回来（加载中不冒充「不支持」）；等目录落地再断言文案
	await waitFor(async () => /已关：不附加任何参数/.test((await fastBtn().getAttribute("aria-label")) ?? ""));
	check("闪电出现在紧凑层（第一层就能切，不用先进目录）", true);
	check("aria-pressed=false（默认关）", (await fastBtn().getAttribute("aria-pressed")) === "false");
	check("requestable-unverified 不禁用（仍可显式请求）", (await fastBtn().getAttribute("aria-disabled")) === null);
	const label = await fastBtn().getAttribute("aria-label");
	check("aria-label 说明「已关：不附加任何参数」", /已关：不附加任何参数/.test(label ?? ""), label);
	check("没有 native disabled（aria-disabled 不挡 focus / 说明）", (await fastBtn().getAttribute("disabled")) === null);
	check("真实七档模型：紧凑层是七档粗轨", (await compact().locator(".pa-think-step").count()) === 7);
	check("滑块是实心无字圆钮（与七档轨共存）", (await compact().locator(".pa-think-handle").count()) === 1 && (await compact().locator(".pa-think-handle").innerText()).trim() === "");
	await stableShot(page, compact(), join(OUT, "00-fast-off.png"));

	// ---------------- 2) 悬停说明 + Esc 只关说明
	console.log("\n[2] 悬停约 450ms 出说明；Esc 只关说明，不误关紧凑层");
	await fastBtn().hover();
	await page.waitForTimeout(250);
	check("悬停 250ms 还没出（不是一点就弹）", (await page.getByTestId("hover-tip").count()) === 0);
	await page.getByTestId("hover-tip").waitFor({ timeout: 3000 }).catch(() => {});
	check("悬停后出说明气泡", (await page.getByTestId("hover-tip").count()) === 1);
	check("说明里写清从下次请求起持续生效直到更改", /从下一次请求起持续生效，直到你更改设置/.test((await page.getByTestId("hover-tip").innerText().catch(() => "")) ?? ""));
	check("说明里写明可能增加费用（不承诺通用倍率）", /可能增加用量 \/ 费用/.test((await page.getByTestId("hover-tip").innerText().catch(() => "")) ?? ""));
	// 说明气泡还在的时候拍（旧图拍在 Esc 之后，名字叫 tip 但画面里没有 tip）
	await stableShot(page, page.getByTestId("hover-tip"), join(OUT, "01-fast-tip.png"));
	await page.keyboard.press("Escape");
	await page.waitForTimeout(120);
	check("Esc 关掉说明气泡", (await page.getByTestId("hover-tip").count()) === 0);
	check("Esc 没有顺手关掉紧凑层（菜单还在）", (await compact().count()) === 1);

	// ---------------- 3) 真实保存 + 刷新后仍在
	console.log("\n[3] 点一下真的保存：PATCH {fast:true}、aria-pressed 跟手、刷新后仍在");
	patches.length = 0;
	await fastBtn().click();
	await waitFor(() => patches.length === 1);
	check("只发一次 PATCH，且 body 只有 fast 字段", patches.length === 1 && Object.keys(patches[0]).join(",") === "fast", JSON.stringify(patches));
	await waitFor(async () => (await fastBtn().getAttribute("aria-pressed")) === "true");
	check("aria-pressed=true（保存成功后跟手）", true);
	check("服务端已落库", (await j("/api/agents")).find((x) => x.id === agent.id)?.fast === true);
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	await openCompact();
	check("刷新后仍是开（不是只存在界面里）", (await fastBtn().getAttribute("aria-pressed")) === "true");
	await stableShot(page, compact(), join(OUT, "02-fast-on.png"));

	// ---------------- 4) 保存失败：只回滚 fast + 给原因
	console.log("\n[4] 保存失败：回滚到原状态、不假装成功，并说明原因");
	await page.route(`**/api/agents/${agent.id}`, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"模拟保存失败"}' }) : route.continue()));
	await fastBtn().click();
	await waitFor(async () => (await fastBtn().getAttribute("aria-pressed")) === "true");
	check("失败后回到开（原状态），没有留下假的关", true);
	await fastBtn().focus();
	await page.getByTestId("hover-tip").waitFor();
	check("说明里给出「保存失败，已恢复原状态」", /保存失败，已恢复原状态/.test((await page.getByTestId("hover-tip").innerText()) ?? ""));
	await stableShot(page, page.getByTestId("hover-tip"), join(OUT, "03-fast-save-failed.png"));
	await page.unroute(`**/api/agents/${agent.id}`);
	await page.keyboard.press("Escape");
	await closeAll();

	// ---------------- 5) 失败回滚重读 GET 被延迟时的新点击（5f7987f）
	// 同一入口保存中会挡重复点击（pending），所以用「切到另一个助理再回来」得到同一助理的新入口实例：
	// 它们共用 patchAgentFast 里按 agentId 的一份 LatestWrite / SerialWriteQueue。
	// 目标：旧失败在延迟 GET 完成后**不能**把界面改成服务端真值，覆盖用户随后点的新值。
	console.log("\n[5] 失败回滚的延迟 GET 期间切走再回来点新值：旧回滚不盖掉最新意图");
	let failNextFastPatch = true;
	let getStarted = false;
	let getDone = false;
	await page.route(`**/api/agents/${agent.id}`, async (route) => {
		if (route.request().method() !== "PATCH") return route.continue();
		if (failNextFastPatch) {
			failNextFastPatch = false;
			return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"模拟保存失败"}' });
		}
		// 新写入本来排在同一助理的串行队列里；延迟响应，给「旧回滚是否覆盖新乐观值」留出观察窗口
		await new Promise((r) => setTimeout(r, 1500));
		return route.continue();
	});
	await page.route("**/api/agents", async (route) => {
		if (route.request().method() !== "GET" || getStarted) return route.continue();
		getStarted = true;
		// 真实延迟：等待期间用户可以继续点（这次读的还是服务端真值）
		await new Promise((r) => setTimeout(r, 1500));
		const resp = await route.fetch();
		getDone = true;
		return route.fulfill({ response: resp });
	});
	await openCompact();
	patches.length = 0;
	await fastBtn().click(); // 开 → 关（乐观），这次 PATCH 500
	await waitFor(() => getStarted, 5000);
	check("失败后确实重新 GET 服务端真值（本次被延迟）", getStarted);
	await switchAgent("Fast 切换助理");
	await switchAgent("Fast 交互验证");
	await openCompact();
	await fastBtn().click(); // 新入口实例：关 → 开（乐观）
	await switchAgent("Fast 切换助理");
	await switchAgent("Fast 交互验证");
	await openCompact();
	await fastBtn().click(); // 再一个新的入口实例：开 → 关（最新意图）
	await waitFor(() => getDone, 8000);
	await page.waitForTimeout(200);
	// 旧回滚已生效（若有 bug 会在这里把界面改回开）；新 PATCH 还被延迟，窗口内界面必须是最后一次点击的关
	const samples = [];
	for (let i = 0; i < 8; i++) {
		samples.push(await fastBtn().getAttribute("aria-pressed"));
		await page.waitForTimeout(100);
	}
	check("延迟 GET 完成后界面仍是最后一次点击的关（旧回滚没有覆盖）", samples.every((v) => v === "false"), JSON.stringify(samples));
	await waitFor(async () => (await j("/api/agents")).find((x) => x.id === agent.id)?.fast === false, 10_000);
	check("最终服务端也是最后一次点击的关", true);
	check("最终界面仍是关", (await fastBtn().getAttribute("aria-pressed")) === "false");
	check("三次点击都发出了 fast PATCH（一次失败 + 两次排队）", patches.length === 3, JSON.stringify(patches));
	await page.unroute(`**/api/agents/${agent.id}`);
	await page.unroute("**/api/agents");
	await closeAll();

	// ---------------- 6) 键盘：Enter 打开焦点落在模型名；Shift+Tab 到 Fast；Esc 不留在已移除的弹层
	console.log("\n[6] 键盘：Enter 打开焦点进紧凑层（模型名）；Shift+Tab 到 Fast；Esc 关闭后焦点不留在弹层");
	await page.getByTestId("model-picker").focus();
	await page.keyboard.press("Enter");
	await compact().waitFor();
	const focusedInPanel = await page.evaluate(() => !!document.activeElement?.closest('[data-testid="model-picker-compact"]'));
	check("键盘打开后焦点在紧凑层内", focusedInPanel, await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 120)));
	check("焦点落在模型名（可继续按 Enter 进目录）", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "thinking-model"));
	// Fast 在 DOM 里位于模型名之前（左上角），所以从模型名 Shift+Tab 过去
	await page.keyboard.press("Shift+Tab");
	const onFast = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "thinking-fast");
	check("Shift+Tab 能从模型名移到 Fast（键盘可达）", onFast);
	await page.keyboard.press("Escape"); // 先关说明（focus 会立即显示）
	await page.keyboard.press("Escape");
	await waitFor(async () => (await compact().count()) === 0);
	check("Esc 关闭后焦点不留在已移除的弹层里", await page.evaluate(() => !document.activeElement?.closest('[data-testid="model-picker-compact"]')));

	// ---------------- 7) 390 宽
	console.log("\n[7] 390 宽：紧凑层不出屏、不横向溢出");
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(300);
	await openCompact();
	const box = await stableShot(page, compact(), join(OUT, "04-fast-390.png"));
	check("紧凑层在屏幕内", !!box && box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box));
	check("390 紧凑层完整在视口内（不上下溢出）", box.y >= -0.5 && box.y + box.height <= 844 + 0.5, JSON.stringify(box));
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
	check("整页无横向溢出", overflow <= 1, `${overflow}`);
	await closeAll();

	// ---------------- 8) 两层：点模型名进目录，搜索 / 返回 / 选完回紧凑层
	console.log("\n[8] 两层：点模型名进目录；搜索、返回不改值；选完回紧凑层并更新头部");
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.waitForTimeout(200);
	modelPatches.length = 0;
	await openCompact();
	await page.getByTestId("thinking-model").click();
	await page.getByTestId("model-menu").waitFor();
	check("点模型名进入完整目录", true);
	check("目录层不再重复强度滑块 / Fast（只选模型）", (await page.getByTestId("thinking-fast").count()) === 0 && (await page.getByTestId("thinking-body").count()) === 0);
	await page.getByTestId("model-search").fill("sol");
	await page.waitForTimeout(150);
	check("搜索过滤到目标模型", (await page.getByTestId("model-option").count()) === 1 && ((await page.getByTestId("model-option").first().getAttribute("data-model")) ?? "").includes(SUBSET));
	await stableShot(page, page.getByTestId("model-menu"), join(OUT, "05-model-directory.png"));
	await page.getByTestId("model-back").click();
	await compact().waitFor();
	check("返回只退一层，紧凑层还在", true);
	check(`返回不改模型（仍是 ${MAIN}）`, new RegExp(MAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(await page.getByTestId("thinking-model").innerText()));
	check("只是返回没有发模型 PATCH", modelPatches.length === 0, JSON.stringify(modelPatches));
	await page.getByTestId("thinking-model").click();
	await page.getByTestId("model-menu").waitFor();
	await page.getByTestId("model-search").fill("sol");
	await page.getByTestId("model-option").first().click();
	await compact().waitFor();
	await waitFor(async () => new RegExp(SUBSET.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(await page.getByTestId("thinking-model").innerText()));
	check("选完自动回紧凑层并更新头部为新模型", true);
	check("选择真的 PATCH 了模型", modelPatches.length === 1 && JSON.stringify(modelPatches[0].model).includes(SUBSET), JSON.stringify(modelPatches));
	check("服务端模型已更新", (await j("/api/agents")).find((x) => x.id === agent.id)?.model?.id === SUBSET);
	check("切到子集模型后滑块档位按已注册目录（不是永远七档）", (await compact().locator(".pa-think-step").count()) === subsetLevels.length, JSON.stringify(subsetLevels));
	await stableShot(page, compact(), join(OUT, "06-model-selected.png"));
	await closeAll();

	// ---------------- 9) 子代理真实 UI：跟随 / 独立覆盖 / 失败回滚 / 轮询不覆盖 / 恢复跟随 / 档位按已注册模型
	console.log("\n[9] 子代理对话面板：Fast 跟随所属助理、独立开关与失败回滚、1s 轮询不覆盖、恢复跟随、档位按已注册模型");
	await j(`/api/agents/${agent.id}`, "PATCH", { fast: true });
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	const detail = () => page.locator('[data-testid="subagent-detail"]:visible');
	const openTask = async (text) => {
		await page.getByTestId("subagent-tasks").waitFor();
		await page.getByTestId("subagent-tasks").click();
		await page.getByTestId("task-overview").waitFor();
		const details = page.getByTestId("task-finished");
		if (await details.count()) {
			if (!(await details.evaluate((el) => el.open))) await details.locator("summary").click();
		}
		await page.getByTestId("subagent-row").filter({ hasText: text }).first().click();
		// 已打开的子代理 tab 会保留在 DOM（display:none），这里只取当前可见的那个
		await detail().waitFor();
		await detail().getByTestId("subagent-thinking").waitFor();
	};
	const openSubThinking = async () => {
		await detail().getByTestId("subagent-thinking").click();
		await page.getByTestId("subagent-thinking-menu").waitFor();
		const fast = page.getByTestId("subagent-thinking-fast");
		await waitFor(async () => /已开|已关/.test((await fast.getAttribute("aria-label")) ?? ""), 10_000);
		return fast;
	};
	await openTask("跟随验证");
	let sfast = await openSubThinking();
	check("子代理 Fast 默认跟随所属助理：助理开 → 灯亮", (await sfast.getAttribute("aria-pressed")) === "true", await sfast.getAttribute("aria-label"));
	check("跟随态不显示「恢复跟随助理」（没有多余覆盖提示）", (await page.getByTestId("fast-follow-note").count()) === 0);
	check("子代理菜单是七档轨（模型真实支持七档）", (await page.getByTestId("subagent-thinking-menu").locator(".pa-think-step").count()) === 7);
	await stableShot(page, page.getByTestId("subagent-thinking-menu"), join(OUT, "08-subagent-fast-follow.png"));

	// 独立关：只 PATCH 这个子代理的 fast，不碰思考强度
	subPatches.length = 0;
	await sfast.click();
	await waitFor(() => subPatches.length === 1);
	check("独立关：PATCH body 只有 fast=false", subPatches.length === 1 && subPatches[0].fast === false && !("thinking" in subPatches[0]), JSON.stringify(subPatches));
	await waitFor(async () => (await sfast.getAttribute("aria-pressed")) === "false");
	check("独立关已落库（服务端 fast=0）", (await j(`/api/subagents/${subFollow}`)).subagent.fast === 0);
	check("出现「恢复跟随助理」（独立覆盖可撤回）", (await page.getByTestId("fast-follow-note").count()) === 1);
	// 说明有悬停延时，不能在它尚未打开时按 Esc（那会按契约关闭菜单）。
	await page.getByTestId("hover-tip").waitFor();
	await page.keyboard.press("Escape"); // 只关说明，菜单还在
	await stableShot(page, page.getByTestId("subagent-thinking-menu"), join(OUT, "09-subagent-fast-override.png"));

	// 保存失败：回滚到独立关 + 原因，不假装成功
	await page.route(`**/api/subagents/${subFollow}`, (route) => (route.request().method() === "PATCH" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"模拟子代理保存失败"}' }) : route.continue()));
	await sfast.click();
	await waitFor(async () => (await sfast.getAttribute("aria-pressed")) === "false", 5000);
	check("子代理保存失败：回滚到独立关（没有假装开）", true);
	await waitFor(async () => (await sfast.getAttribute("aria-busy")) === null, 5000);
	// 点击本身已让按钮获得焦点；先 blur 再 focus 才能重新触发 focus 说明（focus 已在按钮上是 no-op）
	await sfast.evaluate((el) => el.blur());
	await sfast.focus();
	await page.getByTestId("hover-tip").waitFor();
	check("失败原因：「保存失败，已恢复原状态」", /保存失败，已恢复原状态/.test((await page.getByTestId("hover-tip").innerText()) ?? ""));
	await page.keyboard.press("Escape");
	await page.unroute(`**/api/subagents/${subFollow}`);

	// 1 秒轮询不能把保存中的开关盖回旧值
	await page.route(`**/api/subagents/${subFollow}`, async (route) => {
		if (route.request().method() !== "PATCH") return route.continue();
		await new Promise((r) => setTimeout(r, 1600));
		return route.continue();
	});
	await sfast.click(); // 独立关 → 独立开（乐观）
	await page.waitForTimeout(1400); // 跨过至少一次 1s 轮询
	check("1s 轮询没有把保存中的「开」盖回旧值", (await sfast.getAttribute("aria-pressed")) === "true");
	await waitFor(async () => (await j(`/api/subagents/${subFollow}`)).subagent.fast === 1, 8000);
	check("延迟保存完成后服务端 fast=1，界面仍为开", (await sfast.getAttribute("aria-pressed")) === "true");
	await page.unroute(`**/api/subagents/${subFollow}`);

	// 恢复跟随：fast=null，灯回到跟随所属助理（开）
	subPatches.length = 0;
	// 只关可能还开着的说明气泡；若 Esc 把菜单也关了（焦点不在气泡上时 Esc 会关菜单），重新打开再点
	if (await page.getByTestId("hover-tip").count()) await page.keyboard.press("Escape");
	if (!(await page.getByTestId("subagent-thinking-menu").count())) await detail().getByTestId("subagent-thinking").click();
	await page.getByTestId("subagent-thinking-menu").waitFor();
	await page.getByTestId("fast-follow-note").getByRole("button", { name: "恢复跟随助理" }).click();
	await waitFor(async () => (await j(`/api/subagents/${subFollow}`)).subagent.fast === null, 5000);
	check("恢复跟随发的是 PATCH fast=null", subPatches.some((b) => b.fast === null), JSON.stringify(subPatches));
	await waitFor(async () => (await sfast.getAttribute("aria-pressed")) === "true");
	check("恢复后跟随所属助理（助理开 → 灯亮）", true);
	check("恢复后「恢复跟随助理」消失", (await page.getByTestId("fast-follow-note").count()) === 0);

	// 档位按子代理实际注册模型：七档模型的子代理 vs 子集模型的子代理
	await detail().getByLabel("返回主会话").click();
	await page.getByTestId("model-picker").waitFor();
	await openTask("子集验证");
	sfast = await openSubThinking();
	const stepCount = await page.getByTestId("subagent-thinking-menu").locator(".pa-think-step").count();
	check(`子集模型档位数与已注册目录一致（${stepCount} 档）`, stepCount === subsetLevels.length, JSON.stringify(subsetLevels));
	check("子集模型不是无条件七档", stepCount < 7, `${stepCount}`);
	check("子集模型上 Fast 仍独立可用（不被档位限制）", (await sfast.getAttribute("aria-disabled")) === null);
	await stableShot(page, page.getByTestId("subagent-thinking-menu"), join(OUT, "10-subagent-subset-levels.png"));
	const pickLevel = subsetLevels.includes("max") ? "max" : subsetLevels[subsetLevels.length - 1];
	subPatches.length = 0;
	await page.getByTestId(`subagent-thinking-${pickLevel}`).click();
	await waitFor(async () => (await j(`/api/subagents/${subSubset}`)).subagent.thinking === pickLevel, 5000);
	check(`选中「${pickLevel}」按该模型已注册档位落库`, true);
	await j(`/api/agents/${agent.id}`, "PATCH", { fast: false });

	// ---------------- 10) 协议不支持：可聚焦看原因，点击不发请求
	console.log("\n[10] 协议不支持（mock 的 faux 协议）：灯仍显示但 aria-disabled，点击不发请求");
	await j(`/api/agents/${agent.id}`, "PATCH", { model: { provider: "mock", id: "echo" } });
	await page.reload();
	await page.getByTestId("model-picker").waitFor();
	await openCompact();
	// 目录可能还在加载：加载中不冒充「不支持」，等能力判定落地
	await waitFor(async () => (await fastBtn().getAttribute("aria-disabled")) === "true", 10_000);
	patches.length = 0;
	const disabledLabel = await fastBtn().getAttribute("aria-label");
	check("不可用用 aria-disabled（仍能聚焦看原因）", (await fastBtn().getAttribute("aria-disabled")) === "true");
	check("没有 native disabled（Playwright 的 isDisabled 会把 aria-disabled 也算不可用，这里看真实属性）", (await fastBtn().getAttribute("disabled")) === null);
	await fastBtn().focus();
	check("不可用时仍能聚焦（看原因）", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "thinking-fast"));
	check("说明写清「不可用：当前接口暂未接入 Fast」", /不可用：当前接口暂未接入 Fast/.test(disabledLabel ?? ""), disabledLabel);
	// Playwright 的 actionability 会把 aria-disabled 当不可点；真实指针点击仍会进 onClick（内部 return），所以 force 模拟真实点击
	await fastBtn().click({ force: true });
	await page.waitForTimeout(300);
	check("点击不产生 PATCH（不假装能开）", patches.length === 0, JSON.stringify(patches));
	await stableShot(page, compact(), join(OUT, "07-fast-unsupported.png"));

	console.log(failed ? `\n❌ ${failed} 项失败` : "\n✅ 全部通过");
} catch (e) {
	failed++;
	console.error("❌ 脚本异常：", e);
	console.error(srv.logs().slice(-3000));
} finally {
	await stop();
	cleanupTempRun(run);
}
process.exit(failed ? 1 : 0);
