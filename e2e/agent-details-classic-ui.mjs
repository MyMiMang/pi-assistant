/**
 * 助理详情（classic）视觉 + 关键功能 e2e：整 App、八个分类、460/340/280/390 四种面板宽度、
 * glass / warm / noir / pixel 四主题明暗，以及一份本地 DIY 主题（含减少动效）。
 *
 * 与 `agent-details-functional-ui.mjs` 的分工：那个文件已经覆盖了分类归属、保存失败恢复、技能/扩展、
 * 跨分类摘要同步等业务回归，这里**不重复**它们，只做视觉与真实数据闭环：
 *  1. 真实临时服务（内存凭据 + Mock 模型）里建普通助理、群 + 群专属助理（真实 API），
 *     数据都带长名字 / 长简介 / 长文件名，用来验证换行与不横溢；
 *  2. 记忆、定时任务走**真实 HTTP**（同库编辑保留 id；跨作用域按后端迁移 id 且不产生重复；作用域标签；
 *     「待核验」筛选在只有已核验条目时为空）；文件上传走真实 multipart，助理交付方向的
 *     分组用**精确 route 的只读 fixture**（服务端没有 HTTP 交付接口），预览/下载仍打真实 `/api/files/:id`；
 *  3. 后台任务只有列表 GET、没有创建接口，用精确 route 的无执行 fixture 展示 运行中/已完成/失败，
 *     **不启动任何模型任务**；电脑权限 / 暂停 / 全局设置走 host-control fixture，点暂停只记录并保存
 *     fixture 状态，不触发真实 driver；
 *  4. 视觉检查一律读真实 DOM bounds：整页无横向滚动、280 宽下面板内任何可见
 *     button/input/select/textarea/h2 都不横溢、当前页内容真实可见；截图只截可见部分，
 *     **不声称没滚到的内容看过**；
 *  5. 每个宽度 / 主题组合都重新载入整 App（走真实 store + localStorage，不直接改 dataset / CSS），
 *     八个分类逐个切换；四主题明暗 × 460/280 全部跑，截图只留精选。
 *
 * 运行：`SHOT_DIR=/tmp/shots node e2e/agent-details-classic-ui.mjs`（需要先 `npm run build -w apps/web`）。
 * 不碰生产数据 / 真实模型 / 用户电脑驱动；约 1–2 分钟。
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { makeTempRun, startTempServer, browserEnv, cleanupTempRun } from "./fixtures/temp-server.mjs";
import { waitStable, stableShot } from "./fixtures/stable-shot.mjs";
import { agentProfileSave, openAgentModelPop } from "./fixtures/info-pane.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = makeTempRun("pia-agent-details-classic-");
const port = await new Promise((resolve) => {
	const s = createServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => resolve(p));
	});
});
const base = `http://127.0.0.1:${port}`;
const server = startTempServer({ root, port, run });
const out = process.env.SHOT_DIR ?? join(run.runDir, "shots");
mkdirSync(out, { recursive: true });

const json = async (path, method = "GET", body) => {
	const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	assert.ok(r.ok, `${method} ${path} → ${r.status}`);
	return r.json();
};
const waitFor = async (fn, ms = 30000, label = "条件") => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 80));
	}
	throw new Error(`${label} 超时（${ms}ms）`);
};
/** 真实 multipart 上传（和界面上的 upload() 同一个接口）。 */
const upload = async (agentId, name, bytes, type) => {
	const fd = new FormData();
	fd.append("file", new Blob([bytes], { type }), name);
	const r = await fetch(`${base}/api/agents/${agentId}/upload`, { method: "POST", body: fd });
	assert.ok(r.ok, `上传 ${name} → ${r.status}`);
	return r.json();
};

// 八个分类与各自的根节点（和 InfoPane 的 TABS 一一对应）。
const TABS = [
	["overview", "agent-overview"],
	["models", "agent-models-tab"],
	["profile", "agent-profile"],
	["capabilities", "agent-capabilities-tab"],
	["tasks", "agent-tasks-tab"],
	["memory", "memory-tab"],
	["files", "agent-files"],
	["computer", "agent-computer-tab"],
];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const DOC_LONG = "2026-10-18 发布前核对清单（包含全部渠道与长文件名换行检查）.md";
const DOC_OUT = "交付：发布核对结论（长文件名也要能换行显示）.md";
const PNG_IN = "你上传的封面草图.png";
const PNG_OUT = "助理交付的封面成图.png";

/** 一份合法的最小 DIY 主题（20 个必需颜色 token + 动效），直接写 localStorage，不写生产主题、不调模型。 */
const DIY_ID = "11111111-2222-3333-4444-555555555555";
const DIY_SKIN = `custom-${DIY_ID}`;
const tokens = (bg, fg, acc) => ({
	"--bg": bg, "--side": bg, "--panel": bg, "--card": bg, "--fg": fg, "--mut": fg, "--mut2": fg,
	"--line": bg, "--line-strong": bg, "--hover": bg, "--active": bg, "--user-bg": bg, "--user-fg": fg,
	"--acc": acc, "--acc-fg": bg, "--acc-soft": "rgba(0,0,0,.1)", "--ok": "#00aa00", "--warn": "#aa0000",
	"--z-light": "#ffffff", "--z-dark": "#000000",
});
const DIY = {
	manifestVersion: 1,
	id: DIY_ID,
	name: "验收奶油紫",
	modes: { light: tokens("#f7f3ea", "#2a251f", "#8fd3c1"), dark: tokens("#141218", "#f3eee6", "#c3b6f0") },
	motion: { durationFast: "0.12s", duration: "0.25s", durationSlow: "0.4s", easeOut: "ease-out", scale: 1, glow: "subtle", style: "smooth" },
	createdAt: "2026-10-18T00:00:00.000Z",
	updatedAt: "2026-10-18T00:00:00.000Z",
};

let browser;
let page;
let checks = 0;
try {
	await waitFor(async () => {
		if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error("临时服务在就绪前退出");
		try {
			return (await fetch(base + "/api/system", { signal: AbortSignal.timeout(1000) })).ok;
		} catch {
			return false;
		}
	}, 30000, "临时服务就绪");
	await json("/api/settings", "PUT", { onboarded: true, skillSuggestEnabled: false });

	// ---- 真实数据：模型目录（长名字）、普通助理、群、群专属助理 ------------------------------
	const svc = await json("/api/models/custom", "POST", {
		name: "我的中文模型服务（很长的名字也要正常换行）",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		noKey: true,
		models: [{ id: "anthropic.claude-sonnet-5", name: "七档推理模型（长名称检查）", reasoning: true }],
	});
	const agent = await json("/api/agents", "POST", {
		name: "林导 · 负责整体交付的群成员",
		description: "统筹项目、整体体验、任务归属与最终交付；成员简介再长也不能挤出面板，也不能盖住分类。",
		persona: "原始人设",
		model: { provider: svc.id, id: "anthropic.claude-sonnet-5" },
		thinking: "medium",
	});
	const mate = await json("/api/agents", "POST", { name: "墨白", model: { provider: "mock", id: "echo-think" }, thinking: "low" });
	const room = await json("/api/rooms", "POST", { name: "苏折竹AI短剧团队（第二季长名字）", memberIds: [agent.id, mate.id], managerId: agent.id });
	// 群专属助理：真实接口（只在群成员里出现），用来验证群信息框和同一套分类结构。
	const group = await json("/api/rooms/builtin-manager", "POST", { roomId: room.id });
	assert.equal(group.scope, "room", "群专属助理应由真实接口创建");

	// ---- 记忆：真实 HTTP 种子（共享事实 / 助理日志 / 对话便签） -------------------------------
	const conv = await json(`/api/agents/${agent.id}/conversations`, "POST", { title: "记忆与文件核验" });
	const convs = await json(`/api/agents/${agent.id}/conversations`);
	assert.equal(convs.current, conv.id, "种子对话就是界面当前对话（否则对话级便签不会显示）");
	await json(`/api/agents/${agent.id}/memory`, "POST", { text: "我叫邓邓，喜欢简洁的回答；这条是共享事实。", kind: "fact", scope: "user" });
	await json(`/api/agents/${agent.id}/memory`, "POST", { text: "2026-10-18 核验记录：详情页按功能分类后，记忆页要保留新增、编辑、作用域显示与待核验筛选。", kind: "experience", scope: "agent" });
	await json(`/api/agents/${agent.id}/memory`, "POST", { text: "这条便签只对当前对话有效：下次打开记忆页时它应仍然可见。", kind: "note", scope: "conversation", conversationId: conv.id });
	// 说明：没有现成的「草稿」HTTP 接口（草稿只能由子代理/后台写入），所以不伪造 draft、也不假晋升；
	// 下面的「待核验」检查只验证筛选按钮在全是已核验条目时确实筛空。
	const memoryCount = (await json(`/api/agents/${agent.id}/memory`)).items.length;
	assert.equal(memoryCount, 3);

	// ---- 文件：真实上传（两个上传方向 + 两个交付方向，交付方向稍后用只读 fixture 分组） ----------
	await upload(agent.id, DOC_LONG, Buffer.from("# 发布前核对\n\n- 渠道\n- 长文件名换行\n"), "text/markdown");
	await upload(agent.id, PNG_IN, PNG, "image/png");
	await upload(agent.id, DOC_OUT, Buffer.from("# 结论\n\n全部渠道通过。\n"), "text/markdown");
	await upload(agent.id, PNG_OUT, PNG, "image/png");

	// ---- 定时任务：真实接口建一条，不执行 -----------------------------------------------------
	const routine = await json(`/api/agents/${agent.id}/routines`, "POST", { name: "每天早上 8 点整理待办", prompt: "整理今天的待办，按优先级排好，发到聊天里。", trigger: "cron", cron: "0 8 * * *" });
	assert.ok(routine.id);

	browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, env: browserEnv(run) });
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "zh-CN", colorScheme: "light", acceptDownloads: true });
	page = await ctx.newPage();
	page.setDefaultTimeout(15000);
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message));

	const pane = page.locator(".pa-pane-wrap");
	const selectTab = async (key, barId = "info-tabs") => {
		const bar = page.getByTestId(barId);
		await bar.waitFor();
		const direct = bar.locator(`[role=tab][data-itab="${key}"]`);
		if (await direct.count()) await direct.first().click();
		else {
			await page.getByTestId(`${barId}-more`).click();
			await page.getByTestId(`${barId}-menu`).locator(`[role=menuitem][data-itab="${key}"]`).first().click();
		}
		await waitFor(async () => (await bar.locator(`[role=tab][data-itab="${key}"][aria-selected="true"]`).count()) > 0, 5000, `切到分类 ${key}`);
	};
	/** 整页不许横向滚动；面板内任何可见控件都不许横向越出面板。 */
	const layoutCheck = async (label) => {
		const sizes = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, w: innerWidth }));
		assert.ok(sizes.doc <= sizes.w + 1, `${label}：整页横向溢出 ${sizes.doc - sizes.w}px`);
		assert.ok(sizes.body <= sizes.w + 1, `${label}：body 横向溢出 ${sizes.body - sizes.w}px`);
		const vp = page.viewportSize();
		const box = await pane.boundingBox();
		assert.ok(box && box.width > 100 && box.height > 100, `${label}：信息面板没有真实尺寸 ${JSON.stringify(box)}`);
		assert.ok(box.x >= -1 && box.x + box.width <= vp.width + 1, `${label}：信息面板越出视口 ${JSON.stringify(box)}`);
		const offenders = await pane.locator("button:visible,input:visible,select:visible,textarea:visible,h2:visible").evaluateAll((els) => {
			const wrap = document.querySelector(".pa-pane-wrap").getBoundingClientRect();
			return els
				.filter((el) => {
					const r = el.getBoundingClientRect();
					return r.width > 0 && r.height > 0 && (r.left < wrap.left - 2 || r.right > wrap.right + 2);
				})
				.map((el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `#${el.dataset.testid}` : ""}「${(el.textContent ?? "").trim().slice(0, 24)}」`);
		});
		assert.deepEqual(offenders, [], `${label}：可见控件横向溢出面板 ${JSON.stringify(offenders)}`);
		checks++;
	};
	/** 当前分类的内容真的在面板可视区里、有尺寸、有文字（不靠隐藏元素的 isVisible 糊弄）。 */
	const contentCheck = async (label, rootTestId) => {
		const el = page.getByTestId(rootTestId).first();
		await el.waitFor({ state: "visible" });
		const info = await el.evaluate((node) => {
			const r = node.getBoundingClientRect();
			const wrap = document.querySelector(".pa-pane-wrap").getBoundingClientRect();
			return { w: r.width, h: r.height, visibleH: Math.min(r.bottom, wrap.bottom) - Math.max(r.top, wrap.top), text: (node.innerText ?? "").trim().length };
		});
		assert.ok(info.w > 40 && info.h > 8, `${label}：内容区没有真实尺寸 ${JSON.stringify(info)}`);
		assert.ok(info.visibleH > 8, `${label}：内容不在面板可视区 ${JSON.stringify(info)}`);
		assert.ok(info.text > 0, `${label}：内容为空`);
	};
	const paneShot = async (name) => {
		await waitStable(page, pane);
		await pane.screenshot({ path: join(out, name) });
	};
	const appShot = async (name) => stableShot(page, pane, join(out, name));
	const setPrefs = async (prefs) => {
		await page.evaluate((v) => {
			for (const [k, val] of Object.entries(v)) localStorage.setItem(k, val);
		}, prefs);
	};
	const prefsFor = (skin, mode, paneW) => ({
		"pia.skin": skin,
		"pia.theme": mode,
		"pia.layout": JSON.stringify({ sideW: 264, sideCollapsed: true, info: true, paneW }),
	});
	const gotoAgent = async (id = agent.id) => {
		await page.goto(`${base}/?agent=${id}`);
		await pane.waitFor({ state: "visible" });
		await page.getByTestId("info-tabs").waitFor();
		await page.getByTestId("thread-empty").waitFor();
	};
	const allTabs = async (label, opts = {}) => {
		for (const [key, rootId] of TABS) {
			await selectTab(key);
			// 先等内容真的挂上，再量面板内控件的真实 bounds（避免量到还没渲染的空页）。
			await contentCheck(`${label}/${key}`, rootId);
			await layoutCheck(`${label}/${key}`);
			const shot = opts.shot?.(key);
			if (shot) await paneShot(shot);
		}
	};
	const withinPane = (loc) =>
		loc.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const p = document.querySelector(".pa-pane-wrap").getBoundingClientRect();
			return r.width > 0 && r.height > 0 && r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
		});

	// ---- fixture：只替换没有真实接口 / 不能真跑的部分，其余继续打真实服务 ------------------------
	let paused = false;
	const pauseCalls = [];
	const host = {
		settings: { enabled: true, agents: "all", apps: [], tiers: {}, defaultTier: "bounded", workspaceFiles: false },
		status: { enabled: true, tiers: {}, paused: false, daemon: { state: "on", detail: "" }, platform: "darwin", installed: true, version: "fixture" },
		tiers: { [agent.id]: "trusted" },
		manifest: "",
		manifestHash: "fixture",
		permissions: null,
	};
	const fulfill = (route, data, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
	await page.route("**/api/host-control", (r) => fulfill(r, { ...host, status: { ...host.status, paused } }));
	await page.route("**/api/host-control/pause", async (r) => {
		const body = r.request().postDataJSON();
		pauseCalls.push(body);
		paused = body?.paused === true;
		return fulfill(r, { ok: true });
	});
	await page.route("**/api/agents/*/desktop*", (r) => fulfill(r, { enabled: false, available: false, installed: false, state: "none", paused: false, reason: "测试不启用助理电脑", install: { phase: "idle", progress: 0 } }));
	await page.route("**/api/agents/*/desktop/**", (r) => fulfill(r, { enabled: false, available: false, installed: false, state: "none", paused: false, reason: "测试不启用助理电脑", install: { phase: "idle", progress: 0 } }));
	await page.route("**/api/agents/*/computer", (r) => fulfill(r, { separate: false, hasData: false, desktop: { enabled: false, state: "none" } }));
	// 后台任务只有 GET，没有创建接口：用只读 fixture 展示三种状态，绝不启动模型任务。
	const tasksFixture = [
		{ id: "t-run", title: "整理本周会议纪要并核对到人", instructions: "整理本周会议纪要并核对到人", status: "running", created_at: Date.now() - 120000 },
		{ id: "t-done", title: "核对发布清单的全部渠道", instructions: "核对发布清单的全部渠道", status: "done", created_at: Date.now() - 7200000, finished_at: Date.now() - 3600000 },
		{ id: "t-fail", title: "抓取官网价格并对比（上游超时）", instructions: "抓取官网价格并对比", status: "failed", created_at: Date.now() - 86400000, finished_at: Date.now() - 80000000 },
	];
	await page.route(`**/api/agents/${agent.id}/tasks`, (r) => fulfill(r, tasksFixture));
	// 助理交付方向没有 HTTP 接口：精确 route 文件列表，只把两个真实上传标成「助理交付」；
	// 预览 / 下载仍然打真实 /api/files/:id（fileId 都是真实上传得到的）。
	const realFiles = await json(`/api/agents/${agent.id}/files`);
	const pick = (name) => {
		const f = realFiles.find((x) => x.name === name);
		assert.ok(f, `上传文件应在真实列表里：${name}`);
		return f;
	};
	await page.route(`**/api/agents/${agent.id}/files`, (r) =>
		fulfill(r, [
			{ ...pick(DOC_LONG), direction: "in" },
			{ ...pick(PNG_IN), direction: "in" },
			{ ...pick(DOC_OUT), direction: "out" },
			{ ...pick(PNG_OUT), direction: "out" },
		]),
	);

	// ---- 1. 460 宽：整 App 的概览 / 模型 + 八个分类的面板截图 -------------------------------
	await page.goto(base);
	await setPrefs(prefsFor("glass", "light", 460));
	await gotoAgent();
	await page.getByTestId("agent-overview").waitFor();
	await waitFor(async () => /信任/.test(await page.getByTestId("agent-overview").innerText()), 10000, "概览读到电脑权限档位");
	await appShot("01-overview-460-full.png");
	await selectTab("models");
	await pane.getByTestId("agent-model-settings").waitFor();
	await (await openAgentModelPop(page)).getByTestId("thinking-fast").waitFor();
	await page.keyboard.press("Escape");
	await page.getByTestId("agent-image-details").waitFor({ state: "attached" });
	await page.getByTestId("agent-subagent-details").waitFor({ state: "attached" });
	await appShot("02-models-460-full.png");
	console.log("PASS 460：整 App 概览 / 模型截图；主模型、思考强度、Fast、画图与子代理摘要都在");

	// 每个分类一张面板截图（只截面板可见部分）。
	for (const [key] of TABS) {
		await selectTab(key);
		await contentCheck(`460/${key}`, TABS.find(([k]) => k === key)[1]);
		await layoutCheck(`460/${key}`);
		await paneShot(`03-${key}-460-pane.png`);
	}

	// ---- 2. 资料：滚到顶部 / 底部，固定保存按钮都要在面板内 --------------------------------
	await selectTab("profile");
	const profile = page.getByTestId("agent-profile");
	await profile.waitFor();
	const saveBtn = agentProfileSave(pane);
	const profileBody = profile.locator(".pa-profile-body");
	await profileBody.waitFor();
	assert.ok(await withinPane(saveBtn), "资料在顶部时保存按钮可见");
	const scrolled = await profileBody.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
		return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
	});
	assert.ok(scrolled.max > 0 && scrolled.top >= scrolled.max - 2, `资料正文能滚到末尾：${JSON.stringify(scrolled)}`);
	assert.ok(await withinPane(saveBtn), "资料滚到末尾时保存按钮仍可见（固定 footer）");
	await profileBody.evaluate((el) => {
		el.scrollTop = 0;
	});
	assert.ok(await withinPane(saveBtn), "资料回到顶部时保存按钮仍可见");
	console.log("PASS 资料：滚顶 / 滚底保存按钮都在面板内（可见部分之外的内容不声称已看过）");

	// ---- 3. 记忆：同作用域编辑保留 id；跨库迁移按响应 id 核对无重复；待核验筛选 --------
	await selectTab("memory");
	const memoryTab = page.getByTestId("memory-tab");
	await memoryTab.waitFor();
	await memoryTab.getByText("我叫邓邓", { exact: false }).waitFor();
	assert.match(await memoryTab.locator(".pa-memory-item").filter({ hasText: "我叫邓邓" }).innerText(), /共享·关于你/);
	assert.match(await memoryTab.locator(".pa-memory-item").filter({ hasText: "2026-10-18 核验记录" }).innerText(), /仅此助理/);
	assert.match(await memoryTab.locator(".pa-memory-item").filter({ hasText: "这条便签只对当前对话有效" }).innerText(), /仅当前对话/);
	const addedText = "界面新增：周五前整理完发布清单";
	const editedText = "界面编辑后：发布清单改为周四前完成";
	await memoryTab.getByRole("button", { name: "添加记忆", exact: true }).click();
	const memoryArea = memoryTab.locator("textarea");
	await memoryArea.fill(addedText);
	await page.getByTestId("memory-kind").click();
	await page.getByTestId("memory-kind-option-fact").click();
	await page.getByTestId("memory-scope").click();
	await page.getByTestId("memory-scope-option-agent").click();
	await memoryTab.getByRole("button", { name: "保存", exact: true }).click();
	await memoryTab.getByText(addedText, { exact: true }).waitFor();
	const items = async () => (await json(`/api/agents/${agent.id}/memory`)).items;
	const added = (await items()).find((m) => m.text === addedText);
	assert.ok(added, "界面新增应通过真实 HTTP 落到记忆库");
	assert.equal(added.scope, "agent");
	const countAfterAdd = (await items()).length;
	assert.equal(countAfterAdd, memoryCount + 1);
	// 先在同一助理库改文本/类型，id 与条数不变。跨共享库时后端会迁移 id，另行核对。
	await page.getByTestId(`memory-edit-${added.id}`).click();
	await memoryArea.fill(editedText);
	await page.getByTestId("memory-kind").click();
	await page.getByTestId("memory-kind-option-experience").click();
	await memoryTab.getByRole("button", { name: "保存", exact: true }).click();
	await waitFor(async () => (await items()).some((m) => m.id === added.id && m.text === editedText), 10000, "记忆编辑落库");
	const after = await items();
	assert.equal(after.length, countAfterAdd, "编辑不能新增条目");
	const same = after.filter((m) => m.id === added.id);
	assert.equal(same.length, 1, "编辑后仍只有这一条");
	assert.equal(same[0].kind, "experience");
	assert.equal(same[0].scope, "agent");
	assert.equal(after.filter((m) => m.text === addedText).length, 0, "旧文本不能残留成第二条");
	await page.getByTestId(`memory-edit-${added.id}`).click();
	await page.getByTestId("memory-scope").click();
	await page.getByTestId("memory-scope-option-user").click();
	const migratedResponse = page.waitForResponse((r) => r.url().endsWith(`/memory/${added.id}`) && r.request().method() === "PATCH");
	await memoryTab.getByRole("button", { name: "保存", exact: true }).click();
	const migration = await migratedResponse;
	assert.equal(migration.status(), 200);
	const { id: migratedId } = await migration.json();
	assert.ok(migratedId, "迁移响应提供实际记忆 id");
	await waitFor(async () => (await items()).some((m) => m.id === migratedId && m.scope === "user"), 10000, "记忆迁移落库");
	const moved = await items();
	assert.equal(moved.length, countAfterAdd, "跨库迁移不能增加条数");
	assert.equal(moved.filter((m) => m.text === editedText).length, 1, "迁移后只有一条新内容");
	if (migratedId !== added.id) assert.equal(moved.some((m) => m.id === added.id), false, "旧库记录已移除");
	const editedItem = memoryTab.locator(".pa-memory-item").filter({ hasText: editedText });
	await editedItem.waitFor();
	const editedLabel = await editedItem.innerText();
	assert.match(editedLabel, /共享·关于你/);
	assert.match(editedLabel, /日志/);
	// 「待核验」只筛 status=draft；本脚本没有草稿种子（没有现成 API），所以应为空。
	await memoryTab.getByRole("button", { name: "待核验", exact: true }).click();
	await waitFor(async () => (await memoryTab.locator(".pa-memory-item").count()) === 0, 5000, "待核验筛掉已核验条目");
	await memoryTab.getByRole("button", { name: "待核验", exact: true }).click();
	await waitFor(async () => (await memoryTab.locator(".pa-memory-item").count()) > 0, 5000, "取消待核验筛选");
	await paneShot("04-memory-edited-460-pane.png");
	console.log("PASS 记忆：同库编辑保留 id、跨库按响应 id 迁移无重复；共享/助理/对话作用域标签；待核验筛选按 status");

	// ---- 4. 文件：上传/交付分组、长文件名换行、预览弹窗与真实下载 --------------------------
	await selectTab("files");
	const filesTab = page.getByTestId("agent-files");
	await filesTab.getByText(/你上传 · 2 个/).waitFor();
	await filesTab.getByText(/助理交付 · 2 个/).waitFor();
	// 取文件名所在的 span（不是外层按钮），否则量到的是整行宽度。
	const longName = filesTab.getByTestId("info-file-open").first().locator("span span").first();
	await longName.waitFor();
	assert.equal((await longName.innerText()).trim(), DOC_LONG);
	const wrapInfo = await longName.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, h: el.getBoundingClientRect().height }));
	assert.ok(wrapInfo.scroll <= wrapInfo.client + 1, `长文件名不横溢：${JSON.stringify(wrapInfo)}`);
	assert.ok(wrapInfo.h > 20, `长文件名应换行成多行：${JSON.stringify(wrapInfo)}`);
	await waitFor(async () => filesTab.locator("img").evaluateAll((imgs) => imgs.some((i) => i.complete && i.naturalWidth > 0)), 10000, "上传图片真实加载");
	await filesTab.getByTestId("info-file-open").first().click();
	const previewName = page.getByTestId("file-preview-name");
	await previewName.waitFor();
	assert.match(await previewName.innerText(), /核对清单/);
	await page.getByTestId("file-preview-close").click();
	await previewName.waitFor({ state: "hidden" });
	const [download] = await Promise.all([page.waitForEvent("download"), filesTab.getByTestId("info-file-download").first().click()]);
	assert.equal(download.suggestedFilename(), DOC_LONG, "下载用真实文件名");
	await download.delete().catch(() => {});
	console.log("PASS 文件：真实上传 + 交付分组（只读 fixture）；长名换行、真实预览弹窗与下载");

	// ---- 5. 任务：三种状态（只读 fixture）与三个二级分类可达 --------------------------------
	await selectTab("tasks");
	await page.getByTestId("routines-tab").waitFor(); // 默认先看定时任务
	await page.getByTestId("agent-quiet-hours").waitFor();
	await selectTab("background", "agent-task-tabs");
	const background = page.getByTestId("agent-background-tasks");
	await background.waitFor();
	assert.equal(await page.getByTestId("agent-quiet-hours").count(), 0, "执行记录页不显示免打扰");
	const taskText = await background.innerText();
	for (const label of ["运行中", "已完成", "失败"]) assert.match(taskText, new RegExp(label), `后台任务应显示 ${label}`);
	await selectTab("routines", "agent-task-tabs");
	await page.getByTestId("routines-tab").waitFor();
	await page.getByTestId("routine-item").filter({ hasText: "每天早上 8 点整理待办" }).waitFor();
	await selectTab("proactive", "agent-task-tabs");
	await page.getByTestId("proactive-tab").waitFor();
	await page.getByTestId("agent-quiet-hours").waitFor(); // 免打扰只有一份，两个子页共用
	await selectTab("background", "agent-task-tabs");
	await background.waitFor();
	console.log("PASS 任务：执行记录（运行中/已完成/失败）、定时任务、主动跟进都可达（未启动任何模型任务）");

	// ---- 6. 电脑：真实档位 / 暂停 / 全局设置（fixture 保存，不触发 driver） ------------------
	await selectTab("computer");
	const hostTier = page.getByTestId("agent-host-tier");
	await hostTier.waitFor();
	await hostTier.getByText("操作你的电脑", { exact: true }).waitFor();
	// 完整设置页以选中外观标识档位；「（当前）」只属于输入框的 compact 菜单。
	await waitFor(async () => /日常操作不问/.test(await hostTier.innerText()), 5000, "已读取信任档位");
	const trusted = hostTier.getByTestId("tier-trusted");
	assert.equal(await trusted.innerText(), "信任");
	const selectedAppearance = await trusted.evaluate((el) => getComputedStyle(el).backgroundColor);
	const idleAppearance = await hostTier.getByTestId("tier-bounded").evaluate((el) => getComputedStyle(el).backgroundColor);
	assert.notEqual(selectedAppearance, idleAppearance, "信任档位应有可见的选中状态");
	await page.getByText("全局电脑设置", { exact: true }).waitFor();
	await page.getByTestId("agent-host-pause").click();
	await waitFor(async () => pauseCalls.length === 1, 10000, "暂停请求");
	assert.deepEqual(pauseCalls[0], { paused: true });
	await page.getByText("已暂停操作你的电脑", { exact: true }).waitFor();
	await page.getByTestId("agent-host-pause").click();
	await waitFor(async () => pauseCalls.length === 2, 10000, "继续请求");
	assert.deepEqual(pauseCalls[1], { paused: false });
	await page.getByText("一键暂停", { exact: true }).waitFor();
	console.log("PASS 电脑：信任档位选中、全局设置入口、暂停/继续只走 fixture 并核对请求体");

	// ---- 7. 群专属助理：同一个面板结构 + 群信息框 -----------------------------------------
	await page.goto(`${base}/?room=${room.id}`);
	await page.getByTestId("room-members").locator(`button[title^="${group.name}"]`).click();
	await pane.waitFor({ state: "visible" });
	const actions = page.getByTestId("room-agent-actions");
	await actions.getByText(/群专属助理/).waitFor();
	assert.match(await actions.innerText(), new RegExp(room.name.slice(0, 8)));
	await selectTab("overview");
	await contentCheck("group/overview", "agent-overview");
	await layoutCheck("group/overview");
	await paneShot("05-group-agent-460-pane.png");
	// 长群简介让页头实际滚动，关闭键仍固定在可点的位置。
	await json(`/api/agents/${group.id}`, "PATCH", { description: "这是很长的群成员简介，用来确认页头滚动后关闭按钮仍能直接操作。".repeat(7).slice(0, 200) });
	await page.setViewportSize({ width: 390, height: 600 });
	await setPrefs(prefsFor("glass", "light", 280));
	await page.goto(`${base}/?room=${room.id}`);
	await page.getByTestId("room-members").locator(`button[title^="${group.name}"]`).click();
	await pane.getByTestId("room-agent-actions").waitFor();
	const headScroll = await pane.locator(".pa-info-head").evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollHeight - el.clientHeight; });
	assert.ok(headScroll > 0, "长群简介确实让页头可以滚动");
	const close = pane.getByRole("button", { name: "关闭", exact: true });
	assert.equal(await close.evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); }), true, "页头滚动后关闭键仍可直接点击");
	await close.click();
	await pane.waitFor({ state: "hidden" });
	console.log("PASS 群专属助理：同一套分类结构 + 群信息框；长简介页头滚动仍可关闭（真实接口创建）");

	// ---- 8. 340 / 280 面板宽：存 localStorage 后 reload，280 逐页严格检查 --------------------
	await page.setViewportSize({ width: 1440, height: 960 });
	await setPrefs(prefsFor("glass", "light", 340));
	await gotoAgent();
	let box = await pane.boundingBox();
	assert.ok(box && Math.abs(box.width - 340) <= 1, `reload 后面板宽应为 340：${box?.width}`);
	await contentCheck("340/overview", "agent-overview");
	await layoutCheck("340/overview");
	await setPrefs(prefsFor("glass", "light", 280));
	await gotoAgent();
	box = await pane.boundingBox();
	assert.ok(box && Math.abs(box.width - 280) <= 1, `reload 后面板宽应为 280：${box?.width}`);
	await allTabs("280", { shot: (key) => (key === "overview" ? "06-narrow-280-overview-pane.png" : null) });
	console.log("PASS 340/280：面板宽来自存储并 reload 生效；280 下八页控件不横溢、整页无横向滚动");

	// 键盘：Home / End 在单行分类里移动焦点；「更多」Enter/↓ 开菜单、Esc 关闭并回到「更多」。
	const bar = page.getByTestId("info-tabs");
	await bar.locator("[role=tab]").first().focus();
	await page.keyboard.press("End");
	const focused = await page.evaluate(() => ({ testid: document.activeElement?.dataset.testid ?? null, more: document.activeElement?.dataset.more !== undefined }));
	if (await page.getByTestId("info-tabs-more").count()) assert.equal(focused.more, true, "End 应把焦点移到「更多」");
	else assert.equal(focused.testid, null, "没有「更多」时 End 落在最后一个分类上");
	await bar.locator("[role=tab]").first().focus();
	await page.keyboard.press("Home");
	assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "tab", "Home 回到第一个分类");
	if (await page.getByTestId("info-tabs-more").count()) {
		await page.getByTestId("info-tabs-more").focus();
		await page.keyboard.press("ArrowDown");
		await page.getByTestId("info-tabs-menu").waitFor();
		await page.keyboard.press("Escape");
		await page.getByTestId("info-tabs-menu").waitFor({ state: "hidden" });
		assert.equal(await page.getByTestId("info-tabs-more").evaluate((el) => el === document.activeElement), true, "Esc 关闭后焦点回到「更多」");
	}
	console.log("PASS 键盘：单行分类 Home/End、更多菜单 ArrowDown/Esc 焦点回收");

	// ---- 9. 390 手机：覆盖式面板同样八页可用 ----------------------------------------------
	await page.setViewportSize({ width: 390, height: 844 });
	await setPrefs(prefsFor("glass", "light", 340));
	await gotoAgent();
	await allTabs("390", { shot: (key) => (key === "overview" ? "07-mobile-390-overview-pane.png" : null) });
	const overlayPaint = await pane.locator(".pa-info").evaluate((el) => { const s = getComputedStyle(el); return { image: s.backgroundImage, color: s.backgroundColor }; });
	assert.match(overlayPaint.image, /linear-gradient/, "覆盖式面板在主题底色上合成材质，避免透出聊天文字");
	assert.doesNotMatch(overlayPaint.color, /(?:rgba\([^)]*,\s*0\)|transparent)/, "覆盖式面板保留不透明主题底色");
	console.log("PASS 390：手机覆盖式面板八页内容可见、无横向滚动，主题底色阻隔底层聊天文字");
	await page.setViewportSize({ width: 1440, height: 960 });

	// ---- 10. 四主题 × 明暗 × 460/280：八页逐个检查（截图只留精选） -------------------------
	const themeShots = new Set(["glass:dark:460", "warm:light:460", "noir:dark:280", "pixel:light:280"]);
	for (const skin of ["glass", "warm", "noir", "pixel"]) {
		for (const mode of ["light", "dark"]) {
			for (const width of [460, 280]) {
				await setPrefs(prefsFor(skin, mode, width));
				await gotoAgent();
				const applied = await page.evaluate(() => [document.documentElement.dataset.skin, document.documentElement.dataset.mode]);
				assert.deepEqual(applied, [skin, mode], `${skin}/${mode}：主题没有应用到 DOM`);
				for (const [key, rootId] of TABS) {
					await selectTab(key);
					await contentCheck(`${skin}/${mode}/${width}/${key}`, rootId);
					await layoutCheck(`${skin}/${mode}/${width}/${key}`);
				}
				if (themeShots.has(`${skin}:${mode}:${width}`)) await paneShot(`08-theme-${skin}-${mode}-${width}-pane.png`);
			}
		}
	}
	console.log("PASS 主题矩阵：glass/warm/noir/pixel × 明暗 × 460/280 × 八页，无横溢、内容可见（截图只留 4 张）");

	// ---- 11. DIY 主题：manifest → 注入 style → 真实 token；减少动效下过渡为 0 ----------------
	await setPrefs({ ...prefsFor(DIY_SKIN, "light", 460), "pia.customThemes": JSON.stringify([DIY]) });
	await gotoAgent();
	const themeState = await page.evaluate(() => {
		const de = document.documentElement;
		const cs = getComputedStyle(de);
		const style = document.getElementById("pa-custom-themes");
		return {
			skin: de.dataset.skin,
			mode: de.dataset.mode,
			bg: cs.getPropertyValue("--bg").trim(),
			acc: cs.getPropertyValue("--acc").trim(),
			dur: cs.getPropertyValue("--pa-dur").trim(),
			scale: cs.getPropertyValue("--mo-scale").trim(),
			css: style ? style.textContent.includes('[data-skin="custom-') : false,
		};
	});
	assert.equal(themeState.skin, DIY_SKIN, "DIY skin 必须来自真实主题表");
	assert.equal(themeState.mode, "light");
	assert.equal(themeState.bg, "#f7f3ea", `DIY --bg 应生效：${themeState.bg}`);
	assert.equal(themeState.acc, "#8fd3c1", `DIY --acc 应生效：${themeState.acc}`);
	assert.equal(themeState.dur, "0.25s", `DIY 动效 token 应生效：${themeState.dur}`);
	assert.equal(themeState.scale, "1");
	assert.equal(themeState.css, true, "DIY CSS 应由 #pa-custom-themes 注入");
	await selectTab("models");
	await pane.getByTestId("agent-model-settings").waitFor();
	await contentCheck("diy/460/models", "agent-models-tab");
	await layoutCheck("diy/460/models");
	// 模型页复用输入框的模型按钮（.pa-chip），它的过渡时长同样取主题动效 token。
	const MODEL_BTN = "[data-testid=agent-models-tab] [data-testid=model-picker]";
	const normalMotion = await page.evaluate((sel) => {
		const sw = document.querySelector(sel);
		return sw ? getComputedStyle(sw).transitionDuration : null;
	}, MODEL_BTN);
	assert.ok(normalMotion?.split(",").every((v) => v.trim() === "0.25s"), `非减少动效时按钮过渡取 DIY 时长：${normalMotion}`);
	await page.emulateMedia({ reducedMotion: "reduce" });
	const reducedMotion = await page.evaluate((sel) => {
		const sw = document.querySelector(sel);
		const cs = getComputedStyle(document.documentElement);
		return {
			dur: cs.getPropertyValue("--pa-dur").trim(),
			scale: cs.getPropertyValue("--mo-scale").trim(),
			sw: sw ? getComputedStyle(sw).transitionDuration : null,
		};
	}, MODEL_BTN);
	assert.equal(reducedMotion.dur, "0s", `减少动效时 DIY 主题也不能绕开：${reducedMotion.dur}`);
	assert.equal(reducedMotion.scale, "0");
	assert.ok(reducedMotion.sw?.split(",").every((v) => v.trim() === "0s"), `减少动效下按钮过渡应为 0：${reducedMotion.sw}`);
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await paneShot("09-diy-light-460-pane.png");
	console.log("PASS DIY：manifest 编译注入 + 主模型/Fast 可用 + 减少动效过渡为 0");

	// 批准稿的近黑整窗参考；仍走真实主题/宽度偏好，等待聊天与摘要读取完再截图。
	await setPrefs(prefsFor("noir", "dark", 460));
	await gotoAgent();
	await selectTab("overview");
	await waitFor(async () => /信任/.test(await page.getByTestId("agent-overview").innerText()), 10000, "近黑概览摘要读取完成");
	await appShot("10-noir-dark-overview-full.png");
	await selectTab("models");
	const finalLimits = await json(`/api/agents/${agent.id}/subagents/settings`);
	await waitFor(async () => (await pane.getByTestId("agent-subagent-details").innerText()).includes(`同时 ${finalLimits.settings.maxConcurrent} 个`), 10000, "近黑模型摘要读取完成");
	await appShot("11-noir-dark-models-full.png");

	assert.deepEqual(errors, [], `页面不能有 JS 异常：${errors.join(" | ")}`);
	console.log(`\n完成：${checks} 组布局检查通过；截图目录 ${out}`);
} catch (e) {
	await page?.screenshot({ path: join(out, "fixture-failed.png") }).catch(() => {});
	console.error(server.logs().split("\n").filter((l) => !/apikey|bearer|token/i.test(l)).slice(-12).join("\n"));
	throw e;
} finally {
	await browser?.close();
	await server.stop();
	cleanupTempRun(run);
}
