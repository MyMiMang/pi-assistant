/**
 * 默认本地语音（开箱即用）**生产贯通**验证：真实 server（临时数据目录 / Mock / 离线）+ 真实构建 + Chromium。
 *
 * 覆盖用户要求的主链路（不真下载权重、不真识别、不碰真实数据 / 麦克风硬件）：
 *  1. 设置 › 语音：准备状态（真实百分比 / 阶段）→ 取消 → **只调窄接口**（不调通用 `/api/downloads/:id/cancel`）
 *     → 状态变 `cancelled` 且出现重试；重试 → 窄接口 → `preparing` → `ready`。
 *  2. 准备完成 + 来源自动采用默认 → 点麦克风走**原生流式**：创建会话带 modelId / agentId；append 串行且 seq 单调；
 *     tentative 只就地预览（**不写输入框**）；committed 进草稿；end 后 final 文本进草稿，**不自动发送**（无 POST messages）。
 *  3. 取消录音 → 调 `/cancel`，草稿不变。
 *  4. 重复帧（seq replay）当 ack：不重发音频、后续帧继续、最终文本正常。
 *  5. 来源在录音中被改选（409 asr_source_changed）→ 会话取消、提示原因、不把该段写进草稿。
 *  6. 迟到就绪（取消后才 create 返回）→ 前端 abort 迟到会话（调 cancel），不留租约。
 *  7. 已选云端来源 → **不走流式**（不创建会话），回落既有批量路径。
 *  8. 显式清空 + 已取消准备 → 点麦克风给「还没准备好」的可解释提示，不创建会话。
 *  9. 390 手机视口：设置页准备状态的取消 / 重试（窄接口）同样可用，不溢出。
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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "apps/web/dist");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const RUN_DIR = mkdtempSync(join(tmpdir(), "pia-e2e-default-voice-"));
const DATA = join(RUN_DIR, "data");
const WORKSPACE = join(RUN_DIR, "workspace");
const FAKE_HOME = join(RUN_DIR, "home");
mkdirSync(DATA, { recursive: true });
mkdirSync(FAKE_HOME, { recursive: true });

const DEF = "streaming-zipformer-bilingual-zh-en-int8";
const DEF_PROVIDER = "local-online-zipformer";
const CLOUD = { location: "cloud", provider: "openai", model: "whisper-1" };

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

/* ------------------------------- 可控的语音后端状态（路由层注入，不下载任何权重） ------------------------------- */
const state = {
	version: 1,
	source: null, // null | {location, provider, model}
	prep: { state: "preparing", percent: 40, phase: "weights", error: null },
	stream: { mode: "normal", creates: 0, appends: 0, ends: 0, cancels: 0, seqs: [], bytes: 0, aborted: 0 },
	calls: { cancelPrepare: 0, retryPrepare: 0, downloadsCancel: 0, downloadsStart: 0, messages: 0, transcriptions: 0 },
};
const prepView = () => ({
	defaultModelId: DEF,
	kind: state.source ? (state.source.model === DEF ? "default" : "user-chosen") : "unconfigured",
	label: state.source?.model === DEF ? "正在使用默认本地流式听写" : "还没选语音识别来源；默认提供本地流式听写",
	prep: {
		state: state.prep.state,
		jobId: `asr:${DEF}`,
		phase: state.prep.phase,
		phaseLabel: state.prep.phase === "weights" ? "下载权重" : null,
		received: state.prep.state === "preparing" ? Math.round((198_270_793 * (state.prep.percent ?? 0)) / 100) : null,
		total: state.prep.state === "preparing" ? 198_270_793 : null,
		percent: state.prep.state === "preparing" ? state.prep.percent : null,
		attempt: 1,
		startedAt: "2026-10-17T00:00:00.000Z",
		finishedAt: state.prep.state === "ready" ? "2026-10-17T00:02:00.000Z" : null,
		error: state.prep.error,
		errorCode: state.prep.error ? "asr_prepare_failed" : null,
		retryable: state.prep.state === "failed",
	},
	firstRunNeedsNetwork: true,
	approxBytes: 293_270_793,
	offlineAfterReady: true,
	requiresUserAction: false,
	micPermissionRequested: false,
	notes: ["首次使用需联网自动准备（权重 + 共享运行时），之后可离线使用；不随安装包分发该权重", "默认流式模型输出无标点；麦克风权限只在用户点麦克风时申请"],
});
const sourceView = () => ({
	source: state.source,
	version: state.version,
	options: [
		{
			location: "local",
			provider: DEF_PROVIDER,
			model: DEF,
			name: "本地流式听写（中英双语）",
			protocol: "asr-stream-v1",
			streaming: true,
			streamProtocol: "asr-stream-v1",
			availability: state.prep.state === "ready" ? "ready" : "not_installed",
			reason: state.prep.state === "ready" ? null : "本地语音识别未安装",
			selected: state.source?.model === DEF,
		},
		{
			location: "cloud",
			provider: CLOUD.provider,
			model: CLOUD.model,
			name: "云端 whisper-1",
			protocol: "openai-audio-transcriptions",
			streaming: false,
			streamProtocol: null,
			availability: "ready",
			reason: null,
			selected: state.source?.location === "cloud",
		},
	],
	defaultVoice: prepView(),
});

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

	await page.route("**/api/audio/asr/source", async (route) => {
		if (route.request().method() === "PUT") {
			const body = route.request().postDataJSON() ?? {};
			state.source = body.source ?? null;
			state.version += 1;
			return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sourceView()) });
		}
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sourceView()) });
	});
	await page.route("**/api/local-models/asr/default-voice/cancel", async (route) => {
		state.calls.cancelPrepare += 1;
		state.prep = { state: "cancelled", percent: null, phase: null, error: null };
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, reason: "已取消", defaultVoice: prepView() }) });
	});
	await page.route("**/api/local-models/asr/default-voice/retry", async (route) => {
		state.calls.retryPrepare += 1;
		state.prep = { state: "preparing", percent: 10, phase: "weights", error: null };
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, reason: "已重新开始", defaultVoice: prepView() }) });
	});
	await page.route("**/api/downloads/*/cancel", async (route) => {
		state.calls.downloadsCancel += 1;
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route("**/api/downloads/*/start", async (route) => {
		state.calls.downloadsStart += 1;
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route("**/api/downloads", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }));
	await page.route(`**/api/agents/${agent.id}/messages`, async (route) => {
		state.calls.messages += 1;
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route("**/api/audio/transcriptions", async (route) => {
		state.calls.transcriptions += 1;
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text: "云端结果", provider: "openai", model: "whisper-1", durationMs: 1 }) });
	});

	/* 流式会话：按 `state.stream.mode` 脚本化事件（真实 wire 形状：committed / tentative / final / endpoint） */
	const sessions = new Map();
	let sid = 0;
	await page.route("**/api/audio/asr/stream**", async (route) => {
		const req = route.request();
		const u = new URL(req.url());
		const parts = u.pathname.split("/").filter(Boolean); // api audio asr stream [id] [op]
		const op = parts[5];
		const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (req.method() === "POST" && !op) {
			state.stream.creates += 1;
			const body = req.postDataJSON() ?? {};
			if (state.stream.mode === "slowopen") await new Promise((r) => setTimeout(r, 1200));
			const id = `asr-stream-${++sid}`;
			sessions.set(id, { seq: 0, appends: 0, created: body });
			return json(200, {
				sessionId: id,
				modelId: DEF,
				provider: DEF_PROVIDER,
				sourceVersion: state.version,
				leaseId: `lease-${id}`,
				protocol: "asr-stream-v1",
				sampleRate: 16000,
				channels: 1,
				format: "s16le",
				maxChunkBytes: 32000,
				partialIntervalHintMs: [200, 400],
				maxSessionMs: 60000,
				idleTimeoutMs: 10000,
				nextSeq: 0,
				state: "ready",
			});
		}
		const s = sessions.get(parts[4]);
		if (!s) return json(404, { error: "asr_stream_unknown", message: "未知会话" });
		if (op === "append") {
			const seq = Number(req.headers()["x-asr-seq"]);
			const bytes = (req.postDataBuffer() ?? Buffer.alloc(0)).length;
			state.stream.appends += 1;
			state.stream.seqs.push(seq);
			state.stream.bytes += bytes;
			if (state.stream.mode === "replay" && state.stream.appends === 1) return json(409, { error: "asr_stream_seq_replay", message: "重复帧" });
			if (state.stream.mode === "sourcechange" && state.stream.appends === 1) return json(409, { error: "asr_source_changed", message: "语音识别来源已被改选，请重新开始录音" });
			s.appends += 1;
			s.seq = seq + 1;
			const events =
				s.appends === 1
					? [{ type: "tentative", text: state.stream.mode === "replay" ? "重复帧不" : "你好世界", segmentId: "0", seq }]
					: [
							{ type: "committed", text: state.stream.mode === "replay" ? "重复帧" : "你好", segmentId: "0", seq },
							{ type: "tentative", text: state.stream.mode === "replay" ? "" : "世界", segmentId: "0", seq },
						];
			return json(200, { seq, accepted: bytes, nextSeq: seq + 1, state: "listening", events, buffered: 0 });
		}
		if (op === "end") {
			state.stream.ends += 1;
			const text = state.stream.mode === "replay" ? "重复帧不重发" : "你好你好";
			return json(200, {
				sessionId: parts[4],
				state: "ended",
				modelId: DEF,
				sourceVersion: state.version,
				finals: [{ type: "final", text, segmentId: "0", seq: s.seq }],
			});
		}
		if (op === "cancel") {
			state.stream.cancels += 1;
			return json(200, { sessionId: parts[4], state: "cancelled" });
		}
		return json(200, { sessionId: parts[4], state: "listening", nextSeq: s.seq });
	});

	const openVoiceSettings = async () => {
		await page.locator('button[title="设置"]').first().click();
		await page.getByTestId("settings-dialog").waitFor();
		await page.locator('[data-tab="voice"]').click();
		await page.getByTestId("default-voice-prep").waitFor();
	};
	const closeSettings = async () => {
		await page.keyboard.press("Escape");
		await page.getByTestId("settings-dialog").waitFor({ state: "detached" });
	};
	const mic = () => page.getByTestId("voice-mic");
	const draft = () => page.locator("textarea").first().inputValue();

	const ensureDefaultReady = async () => {
		// 独立可跑：默认模型已准备 + 来源已由服务端 CAS 采用（不靠前端写）。
		state.prep = { state: "ready", percent: null, phase: null, error: null };
		state.source = { location: "local", provider: DEF_PROVIDER, model: DEF };
		state.version += 1;
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
	};

	await page.goto(BASE + "/");
	await waitFor(async () => (await page.getByTestId("voice-mic").count()) > 0, 20_000, "聊天输入栏");

	/* ---------------------------------------------------------------- A1 准备状态 / 取消 */
	await step("A1 准备中显示真实百分比 + 取消只调窄接口，状态转 cancelled", async () => {
		state.prep = { state: "preparing", percent: 40, phase: "weights", error: null };
		await openVoiceSettings();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "preparing", 10_000, "preparing 状态");
		const text = await page.getByTestId("default-voice-prep-progress").innerText();
		if (!/40%/.test(text)) throw new Error(`准备进度应显示 40%：${text}`);
		await page.getByTestId("default-voice-prep-cancel").click();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "cancelled", 10_000, "cancelled 状态");
		if (state.calls.cancelPrepare !== 1) throw new Error(`应调用窄取消接口 1 次，实际 ${state.calls.cancelPrepare}`);
		if (state.calls.downloadsCancel !== 0) throw new Error("不得借通用下载接口取消默认语音");
		if (!(await page.getByTestId("default-voice-prep-retry").count())) throw new Error("取消后应出现重试");
	});

	/* ---------------------------------------------------------------- A2 重试 → ready */
	await step("A2 重试只调窄接口 → preparing → ready，并如实写首次联网", async () => {
		// 独立可跑：先把后端置为「已取消」，刷新让准备面板出现重试按钮。
		state.prep = { state: "cancelled", percent: null, phase: null, error: null };
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		await openVoiceSettings();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "cancelled", 10_000, "cancelled 状态");
		await page.getByTestId("default-voice-prep-retry").click();
		if (state.calls.retryPrepare !== 1) throw new Error(`应调用窄重试接口 1 次，实际 ${state.calls.retryPrepare}`);
		if (state.calls.downloadsStart !== 0) throw new Error("不得借通用下载接口重试默认语音");
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "preparing", 10_000, "重试后 preparing");
		state.prep = { state: "ready", percent: null, phase: null, error: null };
		state.source = { location: "local", provider: DEF_PROVIDER, model: DEF }; // 服务端 install_and_use 的 CAS 采用结果
		state.version += 1;
		await page.getByTestId("default-voice-prep-state").locator("..").isVisible(); // 触发一次读
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		await openVoiceSettings();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "ready", 10_000, "ready 状态");
		const note = await page.getByTestId("default-voice-prep-note").innerText();
		if (!/联网/.test(note)) throw new Error(`首次联网必须如实写明：${note}`);
		if (/断网可用|离线可用/.test(note)) throw new Error(`不得声称首次断网可用：${note}`);
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
	await step("A10 显式清空来源 + 已取消准备：点麦克风给可解释提示，不创建会话", async () => {
		state.source = null;
		state.prep = { state: "cancelled", percent: null, phase: null, error: null };
		state.version += 1;
		await page.reload();
		await page.getByTestId("voice-mic").waitFor();
		const createsBefore = state.stream.creates;
		await mic().click();
		await waitFor(async () => /准备|选择/.test(await page.getByTestId("voice-status").innerText()), 10_000, "未配置提示");
		const status = await page.getByTestId("voice-status").innerText();
		if (!/准备|选择/.test(status)) throw new Error(`应给可解释提示：${status}`);
		if (state.stream.creates !== createsBefore) throw new Error("未配置 / 已取消准备时不得创建会话");
	});

	/* ---------------------------------------------------------------- A11 390 手机 */
	await step("A11 390 手机视口：准备状态取消 / 重试（窄接口）可用且不溢出", async () => {
		state.prep = { state: "preparing", percent: 55, phase: "weights", error: null };
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
		await page.getByTestId("default-voice-prep-retry").click();
		await waitFor(async () => (await page.getByTestId("default-voice-prep").getAttribute("data-state")) === "preparing", 10_000, "390 窄重试");
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
