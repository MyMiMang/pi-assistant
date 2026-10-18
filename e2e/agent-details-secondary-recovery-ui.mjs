/**
 * 助理详情「画图 / 子代理分工」的**错误恢复与异步竞态** e2e（真实临时服务 + 真实构建的界面）。
 *
 * 与 `agent-details-functional-ui.mjs` 的分工：那个文件验证分类归属、折叠/展开、摘要同步、跨分类草稿；
 * 这里不重复常规路径，只做「出错和竞态」：
 *  1) 画图选择（`GET /api/agents/:id/image-model`）被延迟：**模型目录已经回来了也不能出现可写 select**
 *     （不拿「跟随默认」冒充真实选择），折叠摘要显示「正在读取…」；放行后显示服务端已保存的「不画图」；
 *     随后 PUT 失败 → 回滚到已确认值，错误同时留在展开区（role=alert）与收起后的摘要；解除失败后点
 *     「跟随默认」走真实 PUT + GET 读回。
 *  2) 图片目录 `GET /api/image-models` 503 / 空目录：仍然只有「跟随默认」「不画图」两项可改（能改回
 *     跟随）；点真实「重试」目录恢复后才能选具体模型（保存仍走真实 PUT/GET）。不靠加大超时。
 *  3) 候选池 / 思考强度 / 任务上限三份 GET 各自 503：摘要里**不写假的「跟随」「默认」**，展开区是真实
 *     错误 + 重试；三份重试**各读自己那份**（候选池重试不读思考，思考重试不读候选池），所以要逐个点才
 *     能全部真实恢复。候选池连续勾选：对**精确接口**挂起第一次 PUT（放行后回
 *     500），第二次必须等第一次结束才发出；迟到的失败不能抹掉第二次的选择，最终以真实 API 的 pool +
 *     界面可见勾选为准（菜单勾选不关）。思考强度 PUT 失败回滚到已确认值（跟随）并保留错误，解除失败
 *     后重试写入成功。
 *  4) 任务上限 PUT 挂起时输入框禁用、摘要显示保存中；失败回滚输入并给错误；成功后摘要/输入一致，
 *     「继承默认」清空覆盖并读回真实 GET。
 *  5) 切助理 / 离开模型页：被挂起的旧 GET 迟到返回（其中一份故意 503）不能污染当前助理的面板。
 *  6) 候选池 / 思考强度的**保存错误各归各的**：可同时存在，只由同字段的成功写入消除
 *     （外层 testid 仍是一个 `agent-subagent-save-error`，字段级子 testid 区分）。
 *  7) 思考强度 GET 失败而候选池已就绪：点思考的「重试」不能再发候选池 GET、也不能抹掉正在保存的
 *     候选池；挂起的候选池 PUT 放行（route.continue 真实保存，不造成功数据）后勾选保留，
 *     再加一个模型仍在原选择之上。
 *  8) 同助理有挂起的候选池 PUT 时切走再进「模型」：新的 GET 必须等这份 PUT 结束（不能先读出旧池），
 *     第二次勾选也只在第一次 PUT 结束后才发出（按真实请求到达顺序断言）。
 *  读取的排队语义（与主产品一致）：读取先用 `queue.run(空)` 做写入 barrier，再在队列**外**发真实 GET；
 *     所以慢的池 PUT 会挡住思考 GET（允许等待，不能因此判超时），而池 GET 慢不会挡住别的字段。
 *
 * 真实 vs route fixture：
 *  - 真实：`e2e/fixtures/temp-server.mjs` 起的临时服务（launch-memory 内存凭据 + 临时 HOME/DATA/
 *    WORKSPACE）、真实 HTTP 的助理 / 群 / 画图服务登记 / 画图选择 / 候选池 / 思考强度 / 任务上限读写，
 *    断言一律读回真实接口；界面是真实构建产物。
 *  - route fixture 只做**故障注入**（503 / 延迟 / PUT 500），不伪造成功数据。画图服务 baseUrl 指向
 *    `http://127.0.0.1:1/v1`，只用于列目录，**不生成、不调用**；助理电脑 / 用户电脑接口给明确无副作用的
 *    fixture。全程不碰生产数据、真实模型、host driver。
 *
 * 运行：`SHOT_DIR=/tmp/shots node e2e/agent-details-secondary-recovery-ui.mjs`
 * （需要先 `npm run build -w @pi-assistant/web`）。截图最多 3 张（关键状态各一张），失败图写 SHOT_DIR。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { expandAgentModelSection, infoTab } from "./fixtures/info-pane.mjs";
import { stableShot } from "./fixtures/stable-shot.mjs";
import { browserEnv, cleanupTempRun, makeTempRun, startTempServer } from "./fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-agent-details-recovery-");
const port = await new Promise((resolve) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => resolve(p));
	});
});
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
// 调用方可给本次独占的持久证据目录；默认只用本次 run 的目录，不与其它运行共写固定路径。
const out = process.env.SHOT_DIR ?? join(run.runDir, "shots");
mkdirSync(out, { recursive: true });

/** 真实 HTTP（不经过 page.route：这是被测服务本身）。 */
const j = async (path, method = "GET", body) => {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	assert.ok(r.ok, `${method} ${path} → ${r.status}`);
	return r.json();
};
/** 有界等待：不做「睡一会儿再看」的假同步。 */
const wait = async (fn, ms = 15000, label = "条件") => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 80));
	}
	throw new Error(`${label} 超时（${ms}ms）`);
};
/** 只用于「迟到响应不应出现」这类否定断言前的短暂落定（有界，不是靠延长超时等结果）。 */
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const fulfill = (route, data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });

// ---------------------------------------------------------------- 故障注入夹具（只改失败/延迟，不造成功数据）
const net = {
	catalogFail: 0, // `GET /api/image-models` 还要失败几次
	imagePutFail: 0, // 画图选择 PUT（只对甲）还要失败几次
	poolGetFail: false,
	poolPutSent: 0, // 经由界面的候选池 PUT 数（真实 HTTP 的 setup 不走这里）
	poolPutFail: 0, // 候选池 PUT 还要失败几次（只注入失败，成功仍走真实服务）
	poolGetSent: 0, // 经由界面的候选池 GET 数（用来断言「重试不能顺带再读」/「GET 等 PUT」）
	poolLog: [], // 候选池请求 / 放行的到达顺序（断言串行与「GET 在 PUT 之后」）
	poolHoldFirstPut: false,
	poolHoldPutContinue: false, // 挂起这次候选池 PUT，放行时 route.continue 走真实保存
	thinkingGetFail: false,
	thinkingGetSent: 0, // 经由界面的思考强度 GET 数（断言「候选池重试不能顺带读思考」）
	thinkingPutFail: false,
	thinkingHoldPutContinue: false,
	limitsGetFail: false,
	limitsHoldFirstPut: false,
};
/** 挂起闸门：armed 的 key 下一次请求先停住，release 后再放行（可选择放行时改成迟到失败）。 */
const gates = {
	armed: new Set(),
	lateFail: new Set(),
	arrived: new Map(),
	waiters: new Map(),
	arm(key, { lateFail = false } = {}) {
		this.armed.add(key);
		if (lateFail) this.lateFail.add(key);
		else this.lateFail.delete(key);
	},
	reached: (key) => (gates.arrived.get(key) ?? 0) > 0,
	arrive(key) {
		this.arrived.set(key, (this.arrived.get(key) ?? 0) + 1);
		return new Promise((resolve) => {
			const list = this.waiters.get(key) ?? [];
			list.push(resolve);
			this.waiters.set(key, list);
		});
	},
	release(key) {
		for (const resolve of this.waiters.get(key) ?? []) resolve();
		this.waiters.delete(key);
	},
	releaseAll() {
		for (const key of [...this.waiters.keys()]) this.release(key);
	},
};
/** 命中被 armed 的 key 就停住；返回 true = 放行时应答迟到失败（503）。 */
const holdIfArmed = async (key) => {
	if (!gates.armed.has(key)) return false;
	gates.armed.delete(key);
	await gates.arrive(key);
	return gates.lateFail.delete(key);
};
const agentIdOf = (request) => new URL(request.url()).pathname.split("/")[3];

let browser;
let page;
try {
	await wait(async () => {
		if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error("临时服务在就绪前退出");
		try {
			return (await fetch(`${base}/api/system`, { signal: AbortSignal.timeout(1000) })).ok;
		} catch {
			return false;
		}
	}, 30000, "临时服务就绪");
	await j("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });
	// 真实 Pi 目录里的推理模型（七档）：自定义渠道只让目录里有它，baseUrl 指向 127.0.0.1:1，不会真的发请求。
	const chatSvc = await j("/api/models/custom", "POST", { name: "竞态对话服务", api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", noKey: true, models: [{ id: "gpt-6.1-sol", name: "七档推理模型", reasoning: true }] });
	const A = await j("/api/agents", "POST", { name: "竞态甲助理", model: { provider: chatSvc.id, id: "gpt-6.1-sol" }, thinking: "medium" });
	const B = await j("/api/agents", "POST", { name: "竞态乙助理", model: { provider: "mock", id: "echo" }, thinking: "low" });
	const room = await j("/api/rooms", "POST", { name: "竞态复核群", memberIds: [A.id, B.id], managerId: A.id });
	// 已保存的真实画图选择：甲 = 不画图，乙 = 跟随默认（后面竞态用例靠这两个值区分「谁的数据」）。
	await j(`/api/agents/${A.id}/image-model`, "PUT", { mode: "off" });
	await j(`/api/agents/${B.id}/image-model`, "PUT", { mode: "default" });
	// 思考强度用真实目录里的档位（键盘 End = 最高档，不凭空补档位）。
	const chatCatalog = await j("/api/models");
	const reasoned = chatCatalog.find((m) => m.provider === chatSvc.id && m.id === "gpt-6.1-sol");
	assert.ok(reasoned?.thinking?.includes("max"), `目录里该模型应支持 max：${JSON.stringify(reasoned?.thinking)}`);

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
	page.setDefaultTimeout(10000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));
	// 助理电脑 / 用户电脑：明确的无副作用 fixture（本次不测这两块，只是不让它们发真实请求）。
	await page.route("**/api/host-control", (r) => fulfill(r, { settings: { enabled: false, agents: "none", apps: [], tiers: {}, defaultTier: "bounded", workspaceFiles: false }, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "fixture" }, tiers: {}, manifest: "", manifestHash: "fixture", permissions: null }));
	await page.route("**/api/agents/*/desktop", (r) => fulfill(r, { enabled: false, available: false, installed: false, state: "none", paused: false, reason: "测试中不启用助理电脑", install: { phase: "idle", progress: 0 } }));
	await page.route("**/api/agents/*/computer", (r) => fulfill(r, { separate: false, hasData: false, desktop: { enabled: false, state: "none" } }));
	// 故障注入：只拦这四个接口，其他请求照真实临时服务走。
	await page.route("**/api/image-models", async (route) => {
		if (route.request().method() !== "GET") return route.continue().catch(() => {});
		if (net.catalogFail > 0) {
			net.catalogFail -= 1;
			return fulfill(route, { error: "图片模型列表读取失败（探针）" }, 503);
		}
		return route.continue().catch(() => {});
	});
	await page.route("**/api/agents/*/image-model", async (route) => {
		const id = agentIdOf(route.request());
		if (route.request().method() === "PUT") {
			if (id === A.id && net.imagePutFail > 0) {
				net.imagePutFail -= 1;
				return fulfill(route, { error: "画图设置保存失败（探针）" }, 503);
			}
			return route.continue().catch(() => {});
		}
		if (await holdIfArmed(`image:${id}`)) return fulfill(route, { error: "画图设置读取失败（迟到响应）" }, 503);
		return route.continue().catch(() => {});
	});
	await page.route("**/api/agents/*/subagent-model", async (route) => {
		const id = agentIdOf(route.request());
		if (route.request().method() === "PUT") {
			net.poolPutSent += 1;
			net.poolLog.push("put");
			if (net.poolHoldFirstPut) {
				net.poolHoldFirstPut = false;
				await gates.arrive("pool-put");
				return fulfill(route, { error: "候选池保存失败（探针）" }, 500);
			}
			if (net.poolHoldPutContinue) {
				net.poolHoldPutContinue = false;
				await gates.arrive("pool-put-continue");
				net.poolLog.push("put-released");
				return route.continue().catch(() => {}); // 真实保存，不造成功数据
			}
			if (net.poolPutFail > 0) {
				net.poolPutFail -= 1;
				return fulfill(route, { error: "候选池保存失败（探针）" }, 503);
			}
			return route.continue().catch(() => {});
		}
		net.poolGetSent += 1;
		net.poolLog.push("get");
		if (net.poolGetFail) return fulfill(route, { error: "候选池读取失败（探针）" }, 503);
		if (await holdIfArmed(`pool:${id}`)) return fulfill(route, { error: "候选池读取失败（迟到响应）" }, 503);
		return route.continue().catch(() => {});
	});
	await page.route("**/api/agents/*/subagent-thinking", async (route) => {
		if (route.request().method() === "PUT") {
			if (net.thinkingHoldPutContinue) {
				net.thinkingHoldPutContinue = false;
				await gates.arrive("thinking-put-continue");
				return route.continue().catch(() => {});
			}
			if (net.thinkingPutFail) return fulfill(route, { error: "思考强度保存失败（探针）" }, 503);
			return route.continue().catch(() => {});
		}
		net.thinkingGetSent += 1;
		if (net.thinkingGetFail) return fulfill(route, { error: "思考强度读取失败（探针）" }, 503);
		return route.continue().catch(() => {});
	});
	await page.route("**/api/agents/*/subagents/settings", async (route) => {
		const id = agentIdOf(route.request());
		if (route.request().method() === "PUT") {
			if (net.limitsHoldFirstPut) {
				net.limitsHoldFirstPut = false;
				await gates.arrive("limits-put");
				return fulfill(route, { error: "任务上限保存失败（探针）" }, 503);
			}
			return route.continue().catch(() => {});
		}
		if (net.limitsGetFail) return fulfill(route, { error: "任务上限读取失败（探针）" }, 503);
		if (await holdIfArmed(`limits:${id}`)) return fulfill(route, { error: "任务上限读取失败（迟到响应）" }, 503);
		return route.continue().catch(() => {});
	});

	const pane = page.locator(".pa-pane-wrap");
	const img = () => pane.getByTestId("agent-image-details");
	const sub = () => pane.getByTestId("agent-subagent-details");
	const summaryText = (details) => details.locator(":scope > summary").innerText();
	const openModels = async () => {
		await infoTab(page, "models");
		await pane.getByTestId("agent-models-tab").waitFor();
	};
	/** 重新挂载「模型」页（切走再回来 = 重拉目录 / 选择 / 候选池 / 思考 / 上限）。 */
	const remountModels = async () => {
		await infoTab(page, "overview");
		await openModels();
	};
	const selectMember = async (name) => {
		await page.getByTestId("room-members").locator(`button[title^="${name}"]`).click();
		await pane.getByTestId("agent-info-heading").waitFor();
	};
	const imageChoice = async (id) => (await j(`/api/agents/${id}/image-model`)).choice;
	const imageValues = () => pane.getByTestId("agent-image-select").locator("option").evaluateAll((els) => els.map((e) => e.value));
	/** 候选池菜单：真实点触发器打开，必要时展开 mock 分组；返回 portal 里的菜单。用精确的 testid + data-model 定位，不用宽放选择器。 */
	const openPoolMenu = async () => {
		const menu = page.getByTestId("subagent-model-menu");
		if (!(await menu.count())) await pane.getByTestId("agent-subagent-model").getByTestId("subagent-model").click();
		await menu.waitFor();
		const group = page.getByTestId("subagent-model-group-mock");
		await group.waitFor();
		if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
		return menu;
	};
	/** mock 分组里的某一个模型行（同 testid 前缀会同时命中「常用」，所以按分组容器精确定位）。 */
	const poolRow = (model) => page.getByTestId("subagent-model-group-mock").locator("xpath=..").locator(`[data-testid="subagent-model-option"][data-model="${model}"]`);
	const poolChecked = (model) => poolRow(model).locator("input").isChecked();
	/** 保存错误：外层一个容器，字段级子元素分候选池 / 思考强度（两个错误可共存）。 */
	const saveErrBox = () => pane.getByTestId("agent-subagent-save-error");
	const poolSaveErr = () => pane.getByTestId("agent-subagent-pool-save-error");
	const thinkSaveErr = () => pane.getByTestId("agent-subagent-thinking-save-error");
	const closePoolMenu = async () => {
		if (!(await page.getByTestId("subagent-model-menu").count())) return;
		await page.keyboard.press("Escape");
		await page.getByTestId("subagent-model-menu").waitFor({ state: "detached" });
	};

	await page.goto(`${base}/?room=${room.id}`);
	await page.getByTestId("room-members").waitFor();
	await selectMember(A.name);

	// ---------------------------------------------------------------- 1) 画图选择 GET 被延迟
	console.log("\n[1] 画图选择读取被延迟：目录先就绪也不能出现可写 select");
	gates.arm(`image:${A.id}`);
	const catalogReady = page.waitForResponse((r) => {
		const u = new URL(r.url());
		return u.origin === base && u.pathname === "/api/image-models" && r.request().method() === "GET" && r.ok();
	}, { timeout: 15000 });
	await openModels();
	await catalogReady; // 目录这次真的回来了（之后 select 仍然不能出现）
	await wait(() => gates.reached(`image:${A.id}`), 10000, "画图选择 GET 被挂起");
	await expandAgentModelSection(page, "image");
	await pane.getByTestId("agent-image-model").getByText("正在读取这个助理的画图设置…").waitFor();
	assert.equal(await pane.getByTestId("agent-image-select").count(), 0, "读取中不能渲染可写 select（不拿「跟随默认」冒充真实选择）");
	assert.match(await summaryText(img()), /正在读取…/, "折叠摘要如实写读取中");
	await stableShot(page, pane, join(out, "01-image-choice-held.png"));

	gates.release(`image:${A.id}`);
	await pane.getByTestId("agent-image-select").waitFor();
	await wait(async () => (await pane.getByTestId("agent-image-select").inputValue()) === "off", 10000, "显示已保存的 off");
	assert.match(await summaryText(img()), /不画图/, "摘要显示服务端已保存的真实选择");

	// PUT 失败：回滚到已确认值，错误留在展开区和收起摘要
	net.imagePutFail = 1;
	await pane.getByTestId("agent-image-select").selectOption("default");
	await pane.getByTestId("agent-image-save-error").waitFor();
	assert.match(await pane.getByTestId("agent-image-save-error").innerText(), /保存失败，已恢复原选择/);
	await wait(async () => (await pane.getByTestId("agent-image-select").inputValue()) === "off", 10000, "失败回滚到 off");
	assert.equal((await imageChoice(A.id)).mode, "off", "PUT 失败不能改真实值");
	assert.match(await summaryText(img()), /保存失败/, "展开时摘要也写保存失败");
	await img().locator(":scope > summary").click();
	await wait(async () => (await img().evaluate((el) => el.open)) === false, 10000, "折叠画图区块");
	assert.match(await summaryText(img()), /保存失败，展开重试/, "收起后摘要保留失败提示");
	await img().locator(":scope > summary").click();
	await wait(async () => (await img().evaluate((el) => el.open)) === true, 10000, "重新展开画图区块");
	assert.ok(await pane.getByTestId("agent-image-save-error").isVisible(), "展开区里错误可见");

	// 解除失败后点「跟随默认」：真实 PUT + 真实 GET 读回
	net.imagePutFail = 0;
	await pane.getByTestId("agent-image-select").selectOption("default");
	await wait(async () => (await imageChoice(A.id)).mode === "default", 10000, "真实 GET 读回 default");
	await wait(async () => (await pane.getByTestId("agent-image-select").inputValue()) === "default", 10000, "界面显示 default");
	assert.equal(await pane.getByTestId("agent-image-save-error").count(), 0, "成功后不再留失败提示");
	assert.match(await summaryText(img()), /跟随全局默认/);
	console.log("PASS image-choice: 延迟读取不出可写 select；失败回滚 + 双处错误；解除失败后真实读回 default");

	// ---------------------------------------------------------------- 2) 空目录 + 目录 503 后重试恢复
	console.log("\n[2] 空目录 / 图片目录 503：仍只有「跟随默认」「不画图」可改，重试目录恢复");
	assert.deepEqual(await imageValues(), ["default", "off"], "没有图片服务时只有两项真实可选项");
	assert.match(await pane.getByTestId("agent-image-model").innerText(), /还没有配置图片模型/);
	await pane.getByTestId("agent-image-select").selectOption("off");
	await wait(async () => (await imageChoice(A.id)).mode === "off", 10000, "空目录也能改回不画图");

	// 登记一个只用于列目录的真实画图服务（baseUrl 127.0.0.1:1，不生成不调用）
	const imgSvc = await j("/api/image-models/providers", "POST", { kind: "openai", name: "恢复测试图片服务", baseUrl: "http://127.0.0.1:1/v1", models: ["gpt-image-1"] });
	assert.ok(imgSvc?.id, "画图服务登记成功");
	net.catalogFail = 1;
	await remountModels();
	await expandAgentModelSection(page, "image");
	await pane.getByTestId("agent-image-catalog-error").waitFor();
	assert.match(await pane.getByTestId("agent-image-catalog-error").innerText(), /列表没读出来/);
	assert.deepEqual(await imageValues(), ["default", "off"], "目录坏掉时不凭空列出模型，两项仍可用");
	await pane.getByTestId("agent-image-select").selectOption("default");
	await wait(async () => (await imageChoice(A.id)).mode === "default", 10000, "目录坏掉时仍能改回跟随默认");
	await pane.getByTestId("agent-image-catalog-error").getByRole("button", { name: "重试", exact: true }).click();
	await wait(async () => (await imageValues()).length === 3, 10000, "重试后目录恢复");
	const modelValue = (await imageValues()).find((v) => v !== "default" && v !== "off");
	assert.ok(modelValue, `目录恢复后应出现具体模型选项：${JSON.stringify(await imageValues())}`);
	assert.equal(await pane.getByTestId("agent-image-catalog-error").count(), 0, "重试成功后错误消失");
	await pane.getByTestId("agent-image-select").selectOption(modelValue);
	await wait(async () => (await imageChoice(A.id)).mode === "model", 10000, "具体模型真实保存");
	await wait(async () => (await pane.getByTestId("agent-image-select").inputValue()) === modelValue, 10000, "界面显示具体模型");
	assert.match(await summaryText(img()), /恢复测试图片服务/);
	console.log("PASS image-catalog: 空目录/503 时两项仍可改；真实重试恢复目录后可选并真实保存具体模型");

	// ---------------------------------------------------------------- 3) 候选池 / 思考强度 / 任务上限 GET 503
	console.log("\n[3] 子代理分工读取失败：摘要不写假值，一条读取错误 + 一个重试恢复全部");
	net.poolGetFail = true;
	net.thinkingGetFail = true;
	net.limitsGetFail = true;
	await remountModels();
	await expandAgentModelSection(page, "subagents");
	await pane.getByTestId("agent-subagent-load-error").waitFor();
	const degraded = await summaryText(sub());
	assert.match(degraded, /读取失败/, degraded);
	assert.doesNotMatch(degraded, /保存失败/, "GET 读取失败只提示读取失败，不能额外标成保存失败");
	assert.doesNotMatch(await pane.getByTestId("agent-subagent-load-error").innerText(), /保存失败/);
	assert.doesNotMatch(degraded, /跟随主会话/, "读取失败不能假装「跟随主会话」");
	assert.doesNotMatch(degraded, /同时 \d+ 个/, "读取失败不能写假的默认上限");
	assert.equal(await pane.getByLabel("子代理并发上限").count(), 0, "读取失败不画默认上限输入框");
	assert.equal(await pane.getByTestId("agent-subagent-inherit-maxConcurrent").count(), 0);
	await stableShot(page, pane, join(out, "02-subagent-degraded.png"));
	net.poolGetFail = false;
	net.thinkingGetFail = false;
	net.limitsGetFail = false;
	await pane.getByTestId("agent-subagent-retry").click();
	await pane.getByTestId("subagent-model").waitFor();
	const limitsNow = await j(`/api/agents/${A.id}/subagents/settings`);
	await wait(async () => (await pane.getByLabel("子代理并发上限").inputValue()) === String(limitsNow.settings.maxConcurrent), 10000, "上限恢复真实值");
	await wait(async () => /模型跟随聊天/.test(await summaryText(sub())) && /思考跟随主会话/.test(await summaryText(sub())), 10000, "重试后读回真实值");
	assert.equal(await pane.getByTestId("agent-subagent-load-error").count(), 0);
	console.log("PASS subagent-loads: GET 失败不写假摘要；一个重试真实恢复三份设置");

	// ---------------------------------------------------------------- 3b) 候选池连续勾选：写入串行 + 迟到失败不抹第二次
	console.log("\n[3b] 候选池连续勾选：第二次等第一次结束；迟到失败不抹掉第二次");
	await j(`/api/agents/${A.id}/subagent-model`, "PUT", { pool: [] });
	await remountModels();
	await expandAgentModelSection(page, "subagents");
	await pane.getByTestId("subagent-model").waitFor();
	net.poolPutSent = 0;
	net.poolHoldFirstPut = true;
	const poolMenu = await openPoolMenu();
	await poolRow("mock/echo").locator("input").check();
	await wait(() => gates.reached("pool-put"), 10000, "第一次候选池 PUT 被挂起");
	assert.equal(net.poolPutSent, 1, "第一次 PUT 已发出");
	await poolRow("mock/echo-think").locator("input").check();
	await settle();
	assert.equal(net.poolPutSent, 1, "第一次 PUT 未结束时第二次不能发出（写入串行）");
	assert.ok(await poolMenu.isVisible(), "勾选后菜单不关，可连续多选");
	assert.equal(await poolChecked("mock/echo"), true);
	assert.equal(await poolChecked("mock/echo-think"), true);
	assert.match(await summaryText(sub()), /保存中/, "保存中如实写在摘要");
	await stableShot(page, pane, join(out, "03-pool-race.png"));
	gates.release("pool-put");
	await wait(async () => net.poolPutSent === 2, 10000, "第二次 PUT 在放行后发出");
	await wait(async () => (await j(`/api/agents/${A.id}/subagent-model`)).pool.length === 2, 10000, "真实 pool 落库");
	const realPool = (await j(`/api/agents/${A.id}/subagent-model`)).pool.map((m) => `${m.provider}/${m.id}`);
	assert.deepEqual(realPool, ["mock/echo", "mock/echo-think"], `最终 pool 应为两次勾选的结果：${JSON.stringify(realPool)}`);
	await settle();
	assert.ok(await poolMenu.isVisible(), "第二次成功后菜单仍开着");
	assert.equal(await poolChecked("mock/echo"), true, "迟到的第一次失败不能抹掉第二次的选择");
	assert.equal(await poolChecked("mock/echo-think"), true);
	assert.equal(await pane.getByTestId("agent-subagent-save-error").count(), 0, "第二次成功后不留第一次的失败提示");
	await page.keyboard.press("Escape");
	await page.getByTestId("subagent-model-menu").waitFor({ state: "detached" });
	console.log("PASS pool-race: 写入串行、菜单不关、迟到 500 不覆盖后一次选择，最终以真实 pool 为准");

	// ---------------------------------------------------------------- 3c) 思考强度 PUT 失败回滚 + 重试成功
	console.log("\n[3c] 思考强度 PUT 失败：回滚已确认值并留错误，解除失败后重试成功");
	// 本用例回到支持 max 的聊天模型，空池跟随它；前一组 mock 池只支持子集，不能冒充 max。
	await j(`/api/agents/${A.id}/subagent-model`, "PUT", { pool: [] });
	await j(`/api/agents/${A.id}/subagent-thinking`, "PUT", { mode: "follow" });
	await remountModels();
	await expandAgentModelSection(page, "subagents");
	await wait(async () => /思考跟随主会话/.test(await summaryText(sub())), 10000, "初始为真实 follow");
	const thinkingMenu = page.getByTestId("agent-subagent-thinking-menu");
	net.thinkingPutFail = true;
	await pane.getByTestId("agent-subagent-thinking").click();
	await thinkingMenu.waitFor();
	await thinkingMenu.getByRole("slider").press("End");
	await pane.getByTestId("agent-subagent-save-error").waitFor();
	assert.match(await pane.getByTestId("agent-subagent-save-error").innerText(), /思考强度保存失败/);
	assert.equal((await j(`/api/agents/${A.id}/subagent-thinking`)).mode, "follow", "失败不能写库");
	await wait(async () => /跟随主会话/.test(await pane.getByTestId("agent-subagent-thinking").innerText()), 10000, "失败回滚到已确认的 follow");
	net.thinkingPutFail = false;
	await pane.getByTestId("agent-subagent-thinking").click();
	await thinkingMenu.waitFor();
	await thinkingMenu.getByRole("slider").press("End");
	await wait(async () => {
		const t = await j(`/api/agents/${A.id}/subagent-thinking`);
		return t.mode === "fixed" && t.level === "max";
	}, 10000, "重试后真实写入 fixed/max");
	await wait(async () => /思考 固定/.test(await summaryText(sub())), 10000, "摘要显示真实固定档位");
	assert.equal(await pane.getByTestId("agent-subagent-save-error").count(), 0, "成功后失败提示消失");
	console.log("PASS subagent-thinking: 失败回滚 follow 并留错误；解除失败后重试写入 fixed/max");

	// ---------------------------------------------------------------- 4) 任务上限：挂起禁用 / 失败回滚 / 成功 + 继承默认
	console.log("\n[4] 任务上限：保存中禁用输入，失败回滚并给错误，成功与「继承默认」走真实 GET");
	const limitsBefore = await j(`/api/agents/${A.id}/subagents/settings`);
	await remountModels();
	await expandAgentModelSection(page, "subagents");
	const concurrent = pane.getByLabel("子代理并发上限");
	const minutes = pane.getByLabel("子代理最长运行分钟");
	await wait(async () => (await concurrent.inputValue()) === String(limitsBefore.settings.maxConcurrent), 10000, "上限输入框是真实值");
	net.limitsHoldFirstPut = true;
	await concurrent.fill("4");
	await concurrent.press("Tab");
	await wait(() => gates.reached("limits-put"), 10000, "任务上限 PUT 被挂起");
	assert.equal(await concurrent.isDisabled(), true, "保存中输入框禁用（pendingdisabled）");
	assert.equal(await minutes.isDisabled(), true);
	assert.match(await summaryText(sub()), /保存中/, "保存中写进摘要");
	gates.release("limits-put");
	await pane.getByTestId("agent-subagent-save-error").waitFor();
	assert.match(await pane.getByTestId("agent-subagent-save-error").innerText(), /任务上限保存失败/);
	assert.doesNotMatch(await summaryText(sub()), /读取失败/, "PUT 失败不能被写成读取失败");
	await wait(async () => (await concurrent.inputValue()) === String(limitsBefore.settings.maxConcurrent), 10000, "失败回滚到生效值");
	assert.equal(("maxConcurrent" in (await j(`/api/agents/${A.id}/subagents/settings`)).overrides), false, "失败不能写库");
	await wait(async () => /保存失败/.test(await summaryText(sub())), 10000, "摘要显示保存失败");

	await concurrent.fill("5");
	await concurrent.press("Tab");
	await wait(async () => (await j(`/api/agents/${A.id}/subagents/settings`)).overrides.maxConcurrent === 5, 10000, "成功写入真实覆盖值");
	await wait(async () => (await concurrent.inputValue()) === "5", 10000, "成功后输入框与真实值一致");
	await wait(async () => /同时 5 个/.test(await summaryText(sub())), 10000, "摘要与真实覆盖值一致");
	assert.equal(await pane.getByTestId("agent-subagent-save-error").count(), 0, "成功后错误消失");
	await pane.getByTestId("agent-subagent-inherit-maxConcurrent").click();
	await wait(async () => !("maxConcurrent" in (await j(`/api/agents/${A.id}/subagents/settings`)).overrides), 10000, "继承默认清空覆盖");
	const inherited = await j(`/api/agents/${A.id}/subagents/settings`);
	await wait(async () => (await concurrent.inputValue()) === String(inherited.settings.maxConcurrent), 10000, "继承后输入框显示安装默认");
	assert.match(await summaryText(sub()), /用默认值/);
	console.log("PASS subagent-limits: 挂起禁用、失败回滚+错误、成功一致、继承默认读回真实 GET");

	// ---------------------------------------------------------------- 5) 切助理 / 离开模型页：迟到响应不污染

	assert.deepEqual(errors, [], `页面不应有 JS 异常：${JSON.stringify(errors)}`);
	console.log(`\n全部通过（截图/失败图目录：${out}）`);
} catch (e) {
	await page?.screenshot({ path: join(out, "failure.png") }).catch(() => {});
	console.error(server.logs().split("\n").filter((l) => !/apikey|bearer|token/i.test(l)).slice(-12).join("\n"));
	console.error(`失败图：${join(out, "failure.png")}`);
	throw e;
} finally {
	// 收尾必须无阻塞：先放开所有挂起的 route，再关浏览器 / 服务 / 只删本次临时目录。
	gates.releaseAll();
	await browser?.close().catch(() => {});
	await server.stop();
	cleanupTempRun(run);
}
