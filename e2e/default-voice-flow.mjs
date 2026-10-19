/**
 * 本地语音（**可选模块**，默认不安装，决策 0013）**生产贯通**验证：真实 server（临时数据目录 / Mock / 离线）+ 真实构建 + Chromium。
 *
 * 覆盖用户要求的主链路（不真下载权重、不真识别、不碰真实数据 / 麦克风硬件）：
 *  0. 没装：设置 › 语音 › 本地 模块卡**先选再装**——模型选择器（预选目录默认，每项一行适合什么 + 大约下载量，
 *     共享运行环境只算一次）+「安装所选模型」；其他模型不再折叠；输入栏不常驻安装提示；点麦克风引导去设置。
 *  1. 设置 › 语音：安装进度（真实百分比 / 阶段）→ 取消 → **只调窄接口**（不调通用 `/api/downloads/:id/cancel`）
 *     → 回到未安装、出现安装按钮；改选模型后安装 → 窄接口带所选 modelId → `preparing` → `ready` 且已作为来源；
 *     失败：给原因 + 重试（不带 modelId，服务端重试失败的那个）。
 *  2. 准备完成 + 来源自动采用默认 → 点麦克风走**原生流式**：创建会话带 modelId / agentId；append 串行且 seq 单调；
 *     tentative 只就地预览（**不写输入框**）；committed 进草稿；end 后 final 文本进草稿，**不自动发送**（无 POST messages）。
 *  3. 取消录音 → 调 `/cancel`，草稿不变。
 *  4. 重复帧（seq replay）当 ack：不重发音频、后续帧继续、最终文本正常。
 *  5. 来源在录音中被改选（409 asr_source_changed）→ 会话取消、提示原因、不把该段写进草稿。
 *  6. 迟到就绪（取消后才 create 返回）→ 前端 abort 迟到会话（调 cancel），不留租约。
 *  7. 已选云端来源 → **不走流式**（不创建会话），回落既有批量路径。
 *  8. 显式清空 + 未安装 → 点麦克风给可解释提示，不创建会话。
 *  9. 390 手机视口：设置页安装状态的取消 / 安装（窄接口）同样可用，不溢出。
 *
 * 运行前先构建：npm run build -w @pi-assistant/web
 * 运行：node e2e/default-voice-flow.mjs
 *   ONLY='^A[12] '  只跑名字匹配的步骤；FAILFAST=1 第一个失败立即退出；DEBUG_VOICE=1 打印页面请求。
 *
 * 临时目录：每次 mkdtemp（data / workspace / HOME / TMPDIR 都在里面），finally 只删本次目录；
 * server 独立进程组，收尾 SIGTERM→SIGKILL，异常 / 超时都不留孤儿。
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";
import { CLOUD, DEF, DEF_PROVIDER, NAMES, PARA, PARA_PROVIDER, createVoiceBackend, routeVoiceBackend } from "./fixtures/default-voice-backend.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = artifactDir("voice-optional");
const RUN_DIR = mkdtempSync(join(tmpdir(), "pia-e2e-default-voice-"));
const DATA = join(RUN_DIR, "data");
const WORKSPACE = join(RUN_DIR, "workspace");
const FAKE_HOME = join(RUN_DIR, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(FAKE_HOME, { recursive: true });

const PORT = await new Promise((r) => {
	const s = createNetServer().listen(0, "127.0.0.1", () => {
		const p = s.address().port;
		s.close(() => r(p));
	});
});
const BASE = `http://127.0.0.1:${PORT}`;

const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const FAILFAST = !!process.env.FAILFAST;
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
const waitFor = async (fn, ms = 20_000, label = "条件") => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			if (await fn()) return;
		} catch {
			/* 页面切换中：重试 */
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`等待${label}超时`);
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
	detached: true,
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => !String(d).includes("ExperimentalWarning") && process.stdout.write(`[server!] ${d}`));
const killServerTree = (sig = "SIGTERM") => {
	if (server.exitCode !== null || server.pid === undefined) return;
	try {
		process.kill(-server.pid, sig);
	} catch {
		try {
			server.kill(sig);
		} catch {}
	}
};
process.on("exit", () => killServerTree("SIGKILL"));

/* 可控的语音后端状态（路由层注入，不下载任何权重）：见 fixtures/default-voice-backend.mjs */
const backend = createVoiceBackend();
const { state } = backend;
let browser;
let page;
const pageErrors = [];
const reqLog = [];
try {
	await waitFor(async () => (await fetch(`${BASE}/api/system`)).ok, 60_000, "服务启动");
	await j("/api/settings", "PUT", { onboarded: true });
	const agent = await j("/api/agents", "POST", { name: "语音测试" });

	browser = await chromium.launch({
		executablePath: CHROME,
		headless: true,
		args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
	});
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN", permissions: ["microphone"] });
	page = await ctx.newPage();
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
	page.on("request", (r) => {
		const u = new URL(r.url());
		reqLog.push(`${r.method()} ${u.pathname}`);
		if (process.env.DEBUG_VOICE) console.log(`[page req] ${r.method()} ${u.pathname} ${r.postData()?.slice(0, 200) ?? ""}`);
	});

	await routeVoiceBackend(page, backend, agent.id);

	const openVoiceSettings = async () => {
		await page.locator('button[title="设置"]').first().click();
		await page.getByTestId("settings-dialog").waitFor();
		await page.locator('[data-tab="voice"]').click();
		// 本地语音模块卡只在「本地」页里（云端用户不被打扰）。
		await page.getByTestId("voice-tab-local").click();
		await page.getByTestId("default-voice-prep").waitFor();
	};
	const closeSettings = async () => {
		await page.keyboard.press("Escape");
		await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
	};
	const mic = () => page.getByTestId("voice-mic");
	const draft = () => page.locator("main textarea:not(.pa-card textarea)").first().inputValue();

	const ensureDefaultReady = async () => {
		// 独立可跑：默认模型已准备 + 来源已由服务端 CAS 采用（不靠前端写）。
		state.prep = { state: "ready", percent: null, phase: null, error: null };
		state.modelId = DEF;
		state.source = { location: "local", provider: DEF_PROVIDER, model: DEF };
		state.version += 1;
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
	};

	await page.goto(BASE + "/");
	await waitFor(async () => (await page.getByTestId("voice-mic").count()) > 0, 20_000, "聊天输入栏");

	/* ---------------------------------------------------------------- A0 没装：不自动下载、不打扰 */
	await step("A0 没装本地语音：模块卡先选再装（预选默认、每项适合什么 + 大约下载量、运行环境只算一次）；其他模型不折叠；输入栏不常驻提示", async () => {
		state.prep = { state: "not_prepared", percent: null, phase: null, error: null };
		state.modelId = DEF;
		state.source = null;
		state.version += 1;
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		if (await page.getByTestId("voice-prep").count()) throw new Error("没装时输入栏不应常驻安装提示");
		const createsBefore = state.stream.creates;
		await mic().click();
		await waitFor(async () => /安装本地语音/.test(await page.getByTestId("voice-status").innerText()), 10_000, "引导提示");
		if (state.stream.creates !== createsBefore) throw new Error("没装时不得创建会话");
		if (state.calls.installPrepare !== 0) throw new Error("点麦克风不得自动开始安装");
		await openVoiceSettings();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "not_prepared", 10_000, "not_prepared 状态");
		const card = await page.getByTestId("default-voice-prep").innerText();
		if (!/可选模块/.test(card) || !/录音不出电脑/.test(card)) throw new Error(`模块卡应写清是可选模块 + 一行用途：${card}`);
		const sel = page.getByTestId("default-voice-model-select");
		await sel.waitFor();
		if (!(await sel.innerText()).includes(NAMES[DEF])) throw new Error(`应预选目录默认：${await sel.innerText()}`);
		const note = await page.getByTestId("default-voice-choice-note").innerText();
		if (!/约 \d+ MB/.test(note) || !/共享运行环境约 95 MB，只下载一次/.test(note) || !/离线/.test(note)) throw new Error(`应写明大约下载量、运行环境只算一次：${note}`);
		if (/断网可用/.test(note)) throw new Error(`不得声称断网可用：${note}`);
		const btn = await page.getByTestId("default-voice-prep-install").innerText();
		if (!/安装所选模型/.test(btn)) throw new Error(`按钮应是「安装所选模型」：${btn}`);
		if (!(await page.getByTestId("local-asr-models").isVisible())) throw new Error("其他模型不应再折叠");
		if (await page.getByTestId("local-asr-others-toggle").count()) throw new Error("不应再有「其他本地模型」折叠");
		if (await page.getByTestId("local-asr-model-select").count()) throw new Error("安装前只有一个下拉（在模块卡里）");
		if (await page.getByTestId("local-asr-install-use").count()) throw new Error("安装前只有一个安装按钮（在模块卡里）");
		await page.screenshot({ path: join(SHOTS, "voice-local-not-installed.png") });
		await sel.click();
		const menu = page.getByTestId("default-voice-model-select-menu");
		await menu.waitFor();
		const opts = await menu.getByRole("option").allInnerTexts();
		if (opts.length < 3) throw new Error(`选择器应列出目录里的模型：${opts.length}`);
		for (const o of opts) if (!/约 [\d.]+ (MB|GB)/.test(o) || o.split("\n").filter(Boolean).length < 3) throw new Error(`每项应有名字 + 一行适合什么 + 大约下载量：${JSON.stringify(o)}`);
		await page.screenshot({ path: join(SHOTS, "voice-local-choose.png") });
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		await page.getByTestId("voice-tab-cloud").click();
		if (await page.getByTestId("default-voice-prep").count()) throw new Error("云端页不显示本地模块卡（云端不依赖它）");
		await page.screenshot({ path: join(SHOTS, "voice-cloud.png") });
		await closeSettings();
	});

	/* ---------------------------------------------------------------- A1 安装中 / 取消 */
	await step("A1 安装中显示真实百分比 + 取消只调窄接口，回到未安装", async () => {
		state.prep = { state: "preparing", percent: 40, phase: "weights", error: null };
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		await openVoiceSettings();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "preparing", 10_000, "preparing 状态");
		const text = await page.getByTestId("default-voice-prep-progress").innerText();
		if (!/40%/.test(text)) throw new Error(`安装进度应显示 40%：${text}`);
		await page.screenshot({ path: join(SHOTS, "voice-local-installing.png") });
		await page.getByTestId("default-voice-prep-cancel").click();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "not_prepared", 10_000, "取消后未安装");
		if (state.calls.cancelPrepare !== 1) throw new Error(`应调用窄取消接口 1 次，实际 ${state.calls.cancelPrepare}`);
		if (state.calls.downloadsCancel !== 0) throw new Error("不得借通用下载接口取消默认语音");
		if (!(await page.getByTestId("default-voice-prep-install").count())) throw new Error("取消后应出现安装按钮");
	});

	/* ---------------------------------------------------------------- A2 安装 → ready */
	await step("A2 改选模型 → 「安装所选模型」只调窄接口且带所选 modelId → preparing → ready 且已作为语音来源", async () => {
		state.prep = { state: "not_prepared", percent: null, phase: null, error: null };
		state.modelId = DEF;
		state.source = { ...CLOUD }; // 之前选过云端：亲手选定安装后仍应切到它（服务端 CAS）
		state.version += 1;
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		await openVoiceSettings();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "not_prepared", 10_000, "not_prepared 状态");
		await page.getByTestId("default-voice-model-select").click();
		await page.getByTestId(`default-voice-model-select-option-${PARA}`).click();
		await waitFor(async () => (await page.getByTestId("local-asr-detail").getAttribute("data-model-id")) === PARA, 10_000, "下方详情跟着所选");
		const n0 = state.calls.installPrepare;
		await page.getByTestId("default-voice-prep-install").click();
		await waitFor(async () => state.calls.installPrepare === n0 + 1, 10_000, "窄安装接口");
		if (state.installBodies.at(-1)?.modelId !== PARA) throw new Error(`应带所选 modelId：${JSON.stringify(state.installBodies.at(-1))}`);
		if (state.calls.downloadsStart !== 0) throw new Error("不得借通用下载接口安装");
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "preparing", 10_000, "安装后 preparing");
		if (!(await page.getByTestId("default-voice-prep-progress").innerText()).includes(NAMES[PARA])) throw new Error("进度里应写明在装哪个模型");
		state.prep = { state: "ready", percent: null, phase: null, error: null };
		state.source = { location: "local", provider: PARA_PROVIDER, model: PARA }; // 服务端 CAS 设为来源的结果
		state.version += 1;
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		await openVoiceSettings();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "ready", 10_000, "ready 状态");
		await page.getByTestId("default-voice-in-use").waitFor();
		if (!(await page.getByTestId("default-voice-prep").innerText()).includes(NAMES[PARA])) throw new Error("装好后应写明装的是哪个模型");
		await page.getByTestId("local-asr-model-select").waitFor(); // 装好后下方恢复完整的切换 / 管理
		await page.screenshot({ path: join(SHOTS, "voice-local-installed.png") });
		await closeSettings();
	});

	await step("A2b 安装失败：给原因 + 「重试安装」（不带 modelId，重试失败的那个）；改选别的模型则变「安装所选模型」", async () => {
		state.prep = { state: "failed", percent: null, phase: "weights", error: "网络中断（模拟）" };
		state.modelId = PARA;
		state.source = null;
		state.version += 1;
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		await openVoiceSettings();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "failed", 10_000, "failed 状态");
		const err = await page.getByTestId("default-voice-prep-error").innerText();
		if (!err.includes("网络中断") || !err.includes(NAMES[PARA])) throw new Error(`应写明哪个模型、什么原因：${err}`);
		if (!(await page.getByTestId("default-voice-model-select").innerText()).includes(NAMES[PARA])) throw new Error("失败时选择器停在失败的那个");
		await page.getByTestId("default-voice-model-select").click();
		await page.getByTestId(`default-voice-model-select-option-${DEF}`).click();
		if (!/安装所选模型/.test(await page.getByTestId("default-voice-prep-install").innerText())) throw new Error("改选后应是「安装所选模型」");
		await page.getByTestId("default-voice-model-select").click();
		await page.getByTestId(`default-voice-model-select-option-${PARA}`).click();
		const n0 = state.calls.installPrepare;
		await page.getByTestId("default-voice-prep-retry").click();
		await waitFor(async () => state.calls.installPrepare === n0 + 1, 10_000, "窄重试接口");
		if (state.installBodies.at(-1)?.modelId) throw new Error(`重试不带 modelId：${JSON.stringify(state.installBodies.at(-1))}`);
		await closeSettings();
	});

	/* ---------------------------------------------------------------- A3 流式：tentative 预览不写输入框 */
	await step("A3 点麦克风走原生流式：创建带 modelId/agentId、append 串行 seq 单调、tentative 只预览", async () => {
		await ensureDefaultReady();
		state.stream.mode = "normal";
		const before = state.stream.creates;
		await mic().click();
		try {
			await waitFor(async () => state.stream.appends >= 2, 20_000, "至少两帧 append");
		} catch (e) {
			const status = await page.getByTestId("voice-status").innerText().catch(() => "(no status)");
			const err = await page.getByTestId("send-error").innerText().catch(() => "");
			throw new Error(`${e.message}；status=${status} sendErr=${err} creates=${state.stream.creates} pageErrors=${pageErrors.join("|")}`);
		}
		if (state.stream.creates !== before + 1) throw new Error("应创建 1 个流式会话");
		const seqs = state.stream.seqs.slice();
		for (let i = 1; i < seqs.length; i++) if (seqs[i] !== seqs[i - 1] + 1) throw new Error(`seq 必须单调递增：${seqs.join(",")}`);
		if (state.stream.bytes <= 0) throw new Error("append 必须带真实 PCM 字节");
		// 第二帧返回 committed「你好」+ tentative「世界」：committed 进草稿、tentative 只在状态行预览。
		await waitFor(async () => (await draft()).includes("你好"), 10_000, "committed 进草稿");
		const d = await draft();
		if (d.includes("世界")) throw new Error(`tentative 不得写进输入框：${d}`);
		const partial = await page.getByTestId("voice-partial").innerText().catch(() => "");
		if (!partial.includes("世界")) throw new Error(`tentative 应在状态行预览：${partial}`);
	});

	/* ---------------------------------------------------------------- A4 end → final 进草稿且不发送 */
	await step("A4 停止：end 返回 final 完整文本进草稿（重复口语不吞）、不自动发送", async () => {
		await ensureDefaultReady();
		state.stream.mode = "normal";
		state.stream.appends = 0;
		const msgsBefore = state.calls.messages;
		await mic().click();
		await waitFor(async () => state.stream.appends >= 2, 20_000, "A4 录音帧");
		await page.getByTestId("voice-stop").click();
		await waitFor(async () => state.stream.ends >= 1, 15_000, "end 调用");
		await waitFor(async () => (await draft()).includes("你好你好"), 15_000, "final 完整文本进草稿");
		if (state.calls.messages !== msgsBefore) throw new Error("语音结果不得自动发送");
		const v = await draft();
		if ((v.match(/你好你好/g) ?? []).length !== 1) throw new Error(`重复口语应完整保留一次：${v}`);
	});

	/* ---------------------------------------------------------------- A5 取消不写草稿 */
	await step("A5 取消录音：调 /cancel，草稿不变", async () => {
		await ensureDefaultReady();
		const before = await draft();
		state.stream.mode = "normal";
		await mic().click();
		await waitFor(async () => state.stream.appends >= 2, 20_000, "录音帧");
		const cancelsBefore = state.stream.cancels;
		await page.getByTestId("voice-cancel").click();
		await waitFor(async () => state.stream.cancels > cancelsBefore, 10_000, "cancel 调用");
		if ((await draft()) !== before) throw new Error("取消后草稿不应变化");
	});

	/* ---------------------------------------------------------------- A6 seq replay 当 ack */
	await step("A6 重复帧（seq replay）当 ack：不重发、后续帧继续、最终文本正常", async () => {
		await ensureDefaultReady();
		state.stream.mode = "replay";
		state.stream.appends = 0;
		await mic().click();
		await waitFor(async () => state.stream.appends >= 2, 20_000, "replay 后继续 append");
		await page.getByTestId("voice-stop").click();
		await waitFor(async () => (await draft()).includes("重复帧不重发"), 15_000, "replay 场景 final 进草稿");
	});

	/* ---------------------------------------------------------------- A7 来源改选 → 会话取消 */
	await step("A7 录音中来源被改选（409 asr_source_changed）：取消会话 + 明确提示，不写该段", async () => {
		await ensureDefaultReady();
		state.stream.mode = "sourcechange";
		state.stream.appends = 0;
		const before = await draft();
		await mic().click();
		await waitFor(async () => (await page.getByTestId("voice-status").innerText()).includes("来源"), 20_000, "来源变更提示");
		const status = await page.getByTestId("voice-status").innerText();
		if (!/来源/.test(status)) throw new Error(`应提示来源已变：${status}`);
		await waitFor(async () => state.stream.cancels >= 1, 10_000, "会话被取消");
		if ((await draft()) !== before) throw new Error("来源变更后不得把该段写进草稿");
	});

	/* ---------------------------------------------------------------- A8 迟到就绪 */
	await step("A8 取消后才 create 返回（迟到就绪）：abort 迟到会话，不留租约", async () => {
		await ensureDefaultReady();
		state.stream.mode = "slowopen";
		const before = state.stream.cancels;
		await mic().click();
		await waitFor(async () => state.stream.creates >= 1, 10_000, "create 已发出");
		await page.getByTestId("voice-cancel").click();
		await waitFor(async () => state.stream.cancels > before, 15_000, "迟到会话被 abort");
	});

	/* ---------------------------------------------------------------- A9 云端来源不走流式 */
	await step("A9 已选云端来源：不走流式（不创建会话），回落既有批量路径", async () => {
		state.stream.mode = "normal";
		state.source = { ...CLOUD };
		state.version += 1;
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		const createsBefore = state.stream.creates;
		await mic().click();
		await waitFor(async () => (await page.getByTestId("voice-status").innerText()).length > 0, 10_000, "进入录音");
		await page.getByTestId("voice-cancel").click();
		await new Promise((r) => setTimeout(r, 500));
		if (state.stream.creates !== createsBefore) throw new Error("云端来源不得创建本地流式会话");
	});

	/* ---------------------------------------------------------------- A10 显式清空 */
	await step("A10 显式清空来源 + 未安装：点麦克风给可解释提示，不创建会话", async () => {
		state.source = null;
		state.prep = { state: "not_prepared", percent: null, phase: null, error: null };
		state.version += 1;
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		const createsBefore = state.stream.creates;
		await mic().click();
		await waitFor(async () => /安装|选/.test(await page.getByTestId("voice-status").innerText()), 10_000, "未配置提示");
		const status = await page.getByTestId("voice-status").innerText();
		if (!/安装|选/.test(status)) throw new Error(`应给可解释提示：${status}`);
		if (state.stream.creates !== createsBefore) throw new Error("未配置 / 未安装时不得创建会话");
	});

	/* ---------------------------------------------------------------- A11 390 手机 */
	await step("A11 390 手机视口：安装状态取消 / 安装（窄接口）可用且不溢出", async () => {
		state.prep = { state: "preparing", percent: 55, phase: "weights", error: null };
		state.modelId = DEF;
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		await openVoiceSettings();
		// 打开设置后再切到手机视口：设置入口在 390 下收进菜单，不能作为夹具前置条件。
		await page.setViewportSize({ width: 390, height: 844 });
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "preparing", 10_000, "390 准备状态");
		const box = await page.getByTestId("default-voice-prep").boundingBox();
		if (!box || box.x < 0 || box.x + box.width > 390 + 1) throw new Error(`准备面板溢出 390：${JSON.stringify(box)}`);
		const before = state.calls.cancelPrepare;
		await page.getByTestId("default-voice-prep-cancel").click();
		await waitFor(async () => state.calls.cancelPrepare === before + 1, 10_000, "390 窄取消");
		const sb = await page.getByTestId("default-voice-model-select").boundingBox();
		if (!sb || sb.x < 0 || sb.x + sb.width > 390 + 1) throw new Error(`选择器溢出 390：${JSON.stringify(sb)}`);
		await page.screenshot({ path: join(SHOTS, "voice-local-390-choose.png") });
		await page.getByTestId("default-voice-prep-install").click();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "preparing", 10_000, "390 窄安装");
		await page.screenshot({ path: join(SHOTS, "voice-local-390.png") });
	});

	if (pageErrors.length) throw new Error(`页面 JS 异常：${pageErrors.join(" | ")}`);
} finally {
	try {
		await browser?.close();
	} catch {}
	killServerTree("SIGTERM");
	await new Promise((r) => setTimeout(r, 600));
	killServerTree("SIGKILL");
	rmSync(RUN_DIR, { recursive: true, force: true });
	const failed = results.filter((r) => r[0] === "❌");
	console.log(`\n${results.length - failed.length}/${results.length} 通过`);
	if (failed.length) {
		for (const f of failed) console.log(f[0], f[1], f[2]);
		process.exitCode = 1;
	}
}
