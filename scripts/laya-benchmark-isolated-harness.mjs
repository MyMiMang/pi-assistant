/**
 * 快速操作模型 · **真实 Laya 完整 benchmark**（隔离 daemon + 驱动自有隔离浏览器 + 生产 chooser）。
 *
 * 这个脚本是 `docs/design/fast-model-benchmark.md` §9.6 的落地：
 *  1. 先把**本进程（服务侧）**切到合成隔离：HOME / TMPDIR / PIA_DATA_DIR / PIA_WORKSPACE 全在本次 scratch 根内
 *     （内存凭据 + 临时数据目录，不碰用户真实数据目录 / 钥匙串），并做白名单自检；
 *  2. 起一个**本次独占**的 CuaDriver 守护进程：独立 socket / data dir / 浏览器 profile root，
 *     原生边界单独算——从**显式 clone 的 base env** 经生产 `nativeLaunchEnv()` 得到 OS 账户语义的环境
 *     （HOME = OS 账户家目录、剥掉 CFFIXED_USER_HOME 与合成 TMPDIR），再经 LaunchServices 打开官方签名 `CuaDriver.app`；
 *     不共用、不停止生产 App 的守护进程；
 *  3. 用**生产同一套** `hostMcpCommand()`（自有启动器 + 环境全量替换）连它，
 *     经生产 `createInvokeBenchmarkDriver` 打开**驱动自有隔离浏览器**（`browser_prepare{isolated_new}`），
 *     真实走 list_windows → bind → navigate → snapshot pin → click，并把每一步的身份 / pin 记进证据；
 *  4. 接**真实本地 Laya**：用生产 `LocalLayaManager`（自有 data dir，权重来自本机已物化的受校验目录的 clonefile 副本）
 *     起一个本次独占 sidecar（自己的端口 + 自己的 token，不读生产 token / 生产 DB），
 *     经生产 `buildChooser()`（systemone → `models.classify`）与 `selectFastAction()` 跑完整 4 个 fixture 任务；
 *  5. 每题记：模型 decision / confidence / latency / fallback、派发动作、双证据（fixture 机器状态 + 独立 UI 观测）；
 *  6. 按相反顺序清理：只关自己打开的浏览器 → 断 MCP → 停自有 daemon（先证明 socket 归属）→
 *     停自有 Laya → 用**生产 HTTP API** 把用户的 Laya 恢复到原来的运行状态（并复核）。
 *
 * 当前状态（2026-10-17 主审后，**只能经 supervisor 运行**）：
 *  - 隔离缺陷已改：服务进程改回**临时 HOME**，所有第三方 / 服务模块（hono / pi-mcp / TS 生产件）都在 env 设置之后
 *    动态 import；原生边界只从 `cloneNativeBaseEnv(process.env)` 快照计算，不要求本进程是原生 HOME。
 *    **这份改动没有在真实 daemon / 浏览器上跑过**（主审要求不再起 Chrome / driver）。
 *  - 清理有进程内兜底（到点 abort + finally + unhandledRejection/uncaughtException + SIGINT/SIGTERM），
 *    但进程被 SIGKILL / OOM 时只能靠**外部 supervisor**：`scripts/laya-benchmark-supervisor.mjs`
 *    负责超时、杀 worker 进程组、按 socket / 命令行证明归属收掉本次资源、再恢复生产 Laya。
 *  - 入口 **fail-closed**：必须由 supervisor 通过 fd 3/4 握手启动；直接 `node` 运行（或只设
 *    `PIA_BENCH_HARNESS_ENABLE=1`）一律拒绝——环境变量挡不住任何人。
 *
 * 诚实边界：
 *  - 本脚本不评估“泛化能力”：只跑固定的 4 个 synthetic 任务；
 *  - 不把 fixture 结果当“机器性能结论”，不按阈值迎合通过（threshold / timeout 用生产默认，除非显式改并记录）；
 *  - 不读生产 token / 凭据 / 生产 DB；Laya 权重只用本机已物化目录的只读副本（clonefile，不写回原目录）；
 *  - 若系统权限弹窗 / 授权需要本人处理，脚本按失败停下并如实报告，不循环重试。
 *
 * 用法（不进默认 npm test；必须经 supervisor）：
 *   node scripts/laya-benchmark-supervisor.mjs --timeout-ms=720000 -- \
 *     node --import tsx scripts/laya-benchmark-isolated-harness.mjs
 *   PIA_BENCH_KEEP=1                保留 scratch 目录（默认保留日志、删权重副本）
 *   PIA_BENCH_APP_API=http://127.0.0.1:8787   生产 App 的本机 API（用于停 / 恢复 Laya；仅回环）
 *   PIA_BENCH_TIMEOUT_MS=4000       快速模型单次决策超时（生产默认 4000）
 *   PIA_BENCH_HANDOFF=1             可选：不跑旧 4 题，跑**真实主模型接管**入口（见 scripts/laya-benchmark-handoff.mjs）
 *     配合 12 分钟外部强超时：
 *     PIA_BENCH_HANDOFF=1 node scripts/laya-benchmark-supervisor.mjs --timeout-ms=720000 -- \
 *       node --import tsx scripts/laya-benchmark-isolated-harness.mjs
 *     就绪后读本次 scratch 根的 handoff.json（origin / fixture / task / handler 文本 / 临时 nonce），
 *     主模型用固定命令 observe / click / pointer / next / finish 自己接管，最后 finish 触发原清理 + 恢复生产 Laya。
 */
// 只静态 import node 内置模块：hono / pi-mcp / TS 生产件**必须**在下面 env 设置之后动态 import
// （静态 import 会被提升到模块体之前求值，那时 HOME / PIA_DATA_DIR 还是调用方的）。
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { acceptSupervisorHandshake } from "./laya-benchmark-supervisor-handshake.mjs";
import {
	SYNTHETIC_ROOT_MARKER,
	cloneNativeBaseEnv,
	envWhitelist,
	planScratchDirs,
	serviceIsolationEnv,
	serviceIsolationProblems,
} from "./laya-benchmark-harness-env.mjs";

const exec = promisify(execFile);
const OWNER = "amv7oy7ejb00";
const APP_API = process.env.PIA_BENCH_APP_API ?? "http://127.0.0.1:8787";
const AGENT = process.env.PIA_BENCH_AGENT ?? "laya-bench-agent";
const TIMEOUT_MS = Number(process.env.PIA_BENCH_TIMEOUT_MS ?? 4000);
const KEEP = process.env.PIA_BENCH_KEEP === "1";
// handoff 模式要等主模型自己操作：进程内兜底放宽到 11 分钟，让 supervisor 的 12 分钟强超时成为外层硬边界。
const HANDOFF_MODE = process.env.PIA_BENCH_HANDOFF === "1";
const WATCHDOG_MS = Number(process.env.PIA_BENCH_WATCHDOG_MS ?? (HANDOFF_MODE ? 11 * 60_000 : 9 * 60_000));
const REAL_HOME = userInfo().homedir;
const PROD_DATA = join(REAL_HOME, "Library", "Application Support", "Pi Assistant");

// ---------------------------------------------------------------- 入口门禁（必须由 supervisor 启动）
// 外部监护在 scripts/laya-benchmark-supervisor.mjs：它用 fd 3/4 与 worker 握手（一次性随机 token，只在内存管道里）。
// 直接 node 运行没有父进程管道证明 → 拒绝启动；不再用 PIA_BENCH_HARNESS_ENABLE=1 这种任何进程都能设的开关。
const guard = await acceptSupervisorHandshake();
if (!guard) {
	console.error(
		[
			"[laya-benchmark] 拒绝直接运行：必须由外部 supervisor 启动（超时 / 独立清理 / 生产 Laya 恢复都靠它）。",
			"  node scripts/laya-benchmark-supervisor.mjs --timeout-ms=720000 -- node --import tsx scripts/laya-benchmark-isolated-harness.mjs",
			"本次没有启动任何进程。",
		].join("\n"),
	);
	process.exit(3);
}
const notify = (msg) => guard.send(msg);

const startedAt = new Date();
const logLines = [];
const log = (...a) => {
	const line = `${new Date().toISOString().slice(11, 19)} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
	logLines.push(line);
	console.log(line);
};
const report = { schema: "laya-benchmark-real/1", startedAt: startedAt.toISOString(), env: {}, isolation: {}, laya: {}, model: {}, tasks: [], summary: {}, cleanup: {}, failures: [] };
const fail = (msg) => {
	report.failures.push(String(msg));
	console.error("[bench] FAIL:", msg);
};

// ---------------------------------------------------------------- scratch 根（owner guard，和 laya-real-smoke 同一套）

function ownedRoot() {
	const marker = SYNTHETIC_ROOT_MARKER;
	const explicit = process.env.PIA_BENCH_DIR;
	const root = explicit ? resolve(explicit) : join("/tmp", `pia-lb-${OWNER}-${Date.now().toString(36)}`);
	if (explicit) {
		if (!existsSync(root) || !existsSync(join(root, marker)) || readFileSync(join(root, marker), "utf8").trim() !== OWNER) throw new Error(`拒绝使用未标记的 PIA_BENCH_DIR：${root}`);
		return root;
	}
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, marker), `${OWNER}\n`);
	return root;
}

const root = ownedRoot();
const dirs = planScratchDirs(root);
const { home: tempHome, tmp: tempTmp, dataDir, workspaceDir, profileRoot } = dirs;
for (const d of [dataDir, workspaceDir, profileRoot, tempHome, tempTmp, join(dataDir, "host-control")]) mkdirSync(d, { recursive: true });

// 隔离启动（服务侧）：HOME / TMPDIR / 数据目录 / 工作区**全部**落在本次 scratch 根内（合成 HOME → 内存凭据 + 临时数据），
// 任何服务模块（含 hono / pi-mcp / TS 生产件）都在这一行之后才 import。
// 原生边界不靠本进程 HOME：下面单独从 clone 的 base env 经 `nativeLaunchEnv()` 计算。
Object.assign(process.env, serviceIsolationEnv({ baseEnv: process.env, dirs }));

const serviceEnv = envWhitelist(process.env, { root, realHome: REAL_HOME });
report.env = { platform: process.platform, arch: process.arch, node: process.version, realHome: REAL_HOME, scratchRoot: root, service: serviceEnv };
log("服务进程 env（白名单）", JSON.stringify(serviceEnv));
const serviceProblems = serviceIsolationProblems(process.env, { root, realHome: REAL_HOME });
if (serviceProblems.length) {
	fail(`服务进程不在合成隔离环境里：${serviceProblems.join("；")}`);
	writeReportAndExit(2);
}

// ---------------------------------------------------------------- 生产模块（env 已切到合成隔离，且都在此之后动态 import）

const { nativeLaunchEnv, nativeLaunchEnvProblems, osAccountHome } = await import("../packages/server/src/native-launch-env.ts");
const { config } = await import("../packages/server/src/config.ts");
const hostControl = await import("../packages/server/src/host-control.ts");
const modelsMod = await import("../packages/server/src/models.ts");
const { memoryCredentialStore } = await import("../packages/server/test/in-memory-credentials.ts");
await modelsMod.initModels(memoryCredentialStore());
const models = modelsMod.models;

// 本次测试自己的 host 设置：让生产 `hostMcpCommand()` 指向**本次独占**的 unrestricted socket。
hostControl.saveHostSettings({ enabled: true, agents: "all", tiers: { [AGENT]: "full" }, defaultTier: "full", fullAck: { [AGENT]: Date.now() } });

const { LAYA_PROVIDER_ID, LAYA_MODEL_ID, LAYA_SOURCE } = await import("../packages/server/src/local-laya/index.ts");
const { LocalLayaManager } = await import("../packages/server/src/local-laya/manager.ts");
const { createLayaDeps, tokenDigest } = await import("../packages/server/src/local-laya/deps.ts");
const { createInvokeBenchmarkDriver } = await import("../packages/server/src/fast-computer/benchmark-driver.ts");
const { createCuaTrialRunner } = await import("../packages/server/src/fast-computer/benchmark-cua.ts");
const { BenchmarkFixtureStateStore, benchmarkFixtureTasks } = await import("../packages/server/src/fast-computer/benchmark-fixture.ts");
const { mountFastComputerRoutes } = await import("../packages/server/src/fast-computer/routes.ts");
const { clickCandidatesFromBrowserRefs, buildChooser } = await import("../packages/server/src/fast-computer/tool.ts");
const { selectFastAction } = await import("../packages/server/src/fast-computer/index.ts");
const { benchmarkToolGuard } = await import("../packages/server/src/fast-computer/benchmark-guard.ts");
// 第三方依赖也在 env 设置之后才求值（旧版是静态 import，会在合成 HOME / PIA_DATA_DIR 生效前就执行）。
const { Hono } = await import("hono");
const { serve } = await import("@hono/node-server");
const { McpClient, StdioTransport } = await import("@earendil-works/pi-mcp");

// scratch data dir 里没有 bin / local-laya 运行时：用显式软链指到本机**官方签名**驱动与本机已物化的 Laya 运行时。
//  - bin：只读使用（官方 CuaDriver.app；`cuaPaths()` 仍按 config.dataDir 解析，所以软链让它拿到同一个 App）；
//  - local-laya/runtime/env：只读使用（生产 venv 的 laya-serve）；
//  - local-laya/runtime/weights：**clonefile 副本**（Laya 可能改写目录里的 tokenizer 配置，副本保证不写回原目录）。
const prodBin = join(PROD_DATA, "bin");
const prodLaya = join(PROD_DATA, "local-laya", "runtime");
const scratchBin = join(dataDir, "bin");
const scratchLayaRuntime = join(dataDir, "local-laya", "runtime");
// 这一段会 throw（找不到本机驱动 / 运行时 / 权重，或 clonefile 失败）：此时还没启动任何进程，
// 但要落一份可读的失败证据，而不是一个裸的 unhandled rejection 退出。
try {
	if (!existsSync(prodBin)) throw new Error(`找不到本机已安装的 CuaDriver：${prodBin}`);
	if (!existsSync(join(prodLaya, "env", "bin", "laya-serve"))) throw new Error(`找不到本机已安装的 Laya 运行时：${join(prodLaya, "env")}`);
	if (!existsSync(join(prodLaya, "weights", "rl_agent_config.json"))) throw new Error(`找不到本机已物化的 Laya 权重：${join(prodLaya, "weights")}`);
	symlinkSync(prodBin, scratchBin);
	mkdirSync(scratchLayaRuntime, { recursive: true });
	symlinkSync(join(prodLaya, "env"), join(scratchLayaRuntime, "env"));
	await exec("cp", ["-c", "-R", join(prodLaya, "weights"), join(scratchLayaRuntime, "weights")]).catch(async () => {
		// 文件系统不支持 clonefile 时退回普通复制（仍然是只读源，不写回生产目录）。
		await exec("cp", ["-R", join(prodLaya, "weights"), join(scratchLayaRuntime, "weights")]);
	});
	writeFileSync(join(scratchLayaRuntime, "meta.json"), JSON.stringify({ installedAt: Date.now(), note: "isolated benchmark runtime (weights cloned from materialized dir)" }, null, 2));
} catch (e) {
	fail(`准备本次 Laya 运行时失败（未启动任何进程）：${e instanceof Error ? e.message : String(e)}`);
	writeReportAndExit(2);
}

const cuaPaths = hostControl.cuaPaths();
report.isolation.cuaBinary = { exe: cuaPaths.exe, app: cuaPaths.app, exists: existsSync(cuaPaths.exe) };
log("cua binary", JSON.stringify(report.isolation.cuaBinary));

// ---------------------------------------------------------------- 生产 App 的本机 API（仅回环；不读 token / DB）

async function appApi(path, init = {}) {
	const res = await fetch(`${APP_API}${path}`, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20_000) });
	const text = await res.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text.slice(0, 300) };
	}
	return { ok: res.ok, status: res.status, body };
}

const layaStatus = async () => (await appApi("/api/local-models/laya/status")).body;
const layaSummary = (st) => ({
	runtime: st?.runtime ? { state: st.runtime.state, pid: st.runtime.pid, port: st.runtime.port } : null,
	health: st?.health ? { ok: st.health.ok, device: st.health.device, loaded: st.health.loaded } : null,
	registered: st?.registered ?? null,
});

// ---------------------------------------------------------------- 状态 / 清理（幂等；watchdog 也会调用）

const state = { daemonPid: null, socket: null, exe: null, browserClosed: false, mcpClosed: false, daemonStopped: false, laya: null, layaStopped: false, prodRestored: null, aborted: false, exitCode: 0, finished: false };
// 单次到点定时器句柄（在 writeReportAndExit 里清掉；声明在这里避免前面的失败分支碰上 TDZ）。
let watchdogTimer = null;

// 进程内兜底：任何未捕获异常 / 未处理的 Promise 拒绝（例如 client.connect、serve、中间步骤 throw）
// 都走同一条幂等清理，不再留下「自有 daemon 在跑 / 生产 Laya 停着」的裸退出。
// 注意：进程内兜底不覆盖 SIGKILL / OOM；那种情况由外部 supervisor 按 checkpoint 收尾（见文件头）。
const fatal = (label, e) => {
	fail(`${label}：${e instanceof Error ? e.message : String(e)}`);
	state.aborted = true;
	state.exitCode = 5;
	// 清理已经开始过就不再重入（幂等）：直接落盘退出，避免第二次抛在清理里又逃逸。
	if (state.finished) {
		writeReportAndExit(5);
		return;
	}
	void cleanup();
};
process.on("uncaughtException", (e) => fatal("未捕获异常", e));
process.on("unhandledRejection", (e) => fatal("未处理的 Promise 拒绝", e));
// supervisor 发来的停止信号：走同一条清理（停自有资源 + 恢复生产 Laya），不是裸退出。
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		fail(`收到 ${sig}，中止并清理`);
		state.aborted = true;
		state.exitCode = 130;
		void cleanup();
	});
}

async function stopOwnDaemon() {
	if (state.daemonStopped || !state.socket) return;
	state.daemonStopped = true;
	const env = nativeLaunchEnv({
		baseEnv: cloneNativeBaseEnv(process.env),
		realHome: osAccountHome(),
		syntheticRoots: [root, dataDir, workspaceDir, tempHome, tempTmp],
		extra: { CUA_DRIVER_TELEMETRY: "0" },
	}).env;
	try {
		await exec(state.exe, ["stop", "--socket", state.socket], { timeout: 8000, env });
	} catch (e) {
		report.cleanup.daemonStopError = String(e?.message ?? e).slice(0, 200);
	}
	// 只按「命令行里带本次唯一 socket」证明归属，再决定是否兜底 kill；绝不按历史 pid 盲杀。
	await new Promise((r) => setTimeout(r, 500));
	let owned = [];
	try {
		const { stdout } = await exec("pgrep", ["-f", "--", `--socket ${state.socket}`]);
		owned = stdout.split(/\s+/).filter(Boolean).map(Number);
	} catch {
		owned = [];
	}
	if (owned.length) {
		report.cleanup.daemonKilled = owned;
		for (const pid of owned) {
			try {
				process.kill(pid, "SIGTERM");
			} catch {
				/* 已退出 */
			}
		}
		await new Promise((r) => setTimeout(r, 800));
	}
	report.cleanup.daemonStopped = true;
	report.cleanup.daemonLeftoverPids = owned.filter((pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	});
	report.cleanup.socketExistsAfterStop = existsSync(state.socket);
	notify({ type: "daemon_stopped", socket: state.socket, leftoverPids: report.cleanup.daemonLeftoverPids });
	log("自有 daemon 已停", JSON.stringify(report.cleanup));
}

async function restoreProductionLaya() {
	if (!report.laya.baseline?.runtime?.state || report.laya.baseline.runtime.state !== "running") {
		report.cleanup.productionRestore = { skipped: "baseline 不是 running" };
		return;
	}
	const out = { attempts: [] };
	for (let i = 0; i < 2; i++) {
		const r = await appApi("/api/local-models/laya/start", { method: "POST", timeoutMs: 200_000 }).catch((e) => ({ ok: false, status: 0, body: { error: String(e?.message ?? e) } }));
		out.attempts.push({ ok: r.ok, status: r.status, error: r.body?.error ?? null, status_summary: layaSummary(r.body?.status) });
		const st = await layaStatus().catch(() => null);
		if (st?.runtime?.state === "running" && st?.health?.ok) {
			out.restored = layaSummary(st);
			break;
		}
	}
	if (!out.restored) out.failed = true;
	report.cleanup.productionRestore = out;
	report.laya.restored = out.restored ?? null;
	notify({ type: "prod_restored", ok: !!out.restored });
	log("生产 Laya 恢复", JSON.stringify(out));
}

async function cleanup() {
	// 浏览器：拿到 handle 时 close() 走 driver 的 releasePrepared（kill 前用 list_windows 复核归属）；
	// prepare 之后、拿到 handle 之前就失败时，driver 自己的 catch 已经调过同一条 releasePrepared
	// （2026-10-17 读源码确认：packages/server/src/fast-computer/benchmark-driver.ts 的 openDriverBrowser catch）。
	// 两者都是**进程内**保证；进程直接死亡同样不覆盖（见文件头）。
	if (state.finished) return;
	state.finished = true;
	if (state.browser && !state.browserClosed) {
		state.browserClosed = true;
		await state.browser.close().catch((e) => (report.cleanup.browserCloseError = String(e?.message ?? e).slice(0, 200)));
	}
	if (state.client && !state.mcpClosed) {
		state.mcpClosed = true;
		await state.client.close?.().catch(() => {});
	}
	await stopOwnDaemon();
	if (state.laya && !state.layaStopped) {
		try {
			await state.laya.stop();
			state.layaStopped = true;
			notify({ type: "laya_stopped" });
		} catch (e) {
			report.cleanup.layaStopError = String(e?.message ?? e).slice(0, 200);
		}
	}
	if (state.server) state.server.close();
	// 未证明自有模型已停止时交外部 supervisor 杀组并核验，再恢复生产模型，避免双热。
	if (!state.laya || state.layaStopped) await restoreProductionLaya();
	if (!KEEP) rmSync(join(scratchLayaRuntime, "weights"), { recursive: true, force: true });
	report.finishedAt = new Date().toISOString();
	writeReportAndExit(state.exitCode);
}

function writeReportAndExit(code) {
	if (watchdogTimer) clearTimeout(watchdogTimer);
	notify({ type: "done", exitCode: code });
	const dir = resolve("evidence/laya-benchmark-real");
	mkdirSync(dir, { recursive: true });
	const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
	writeFileSync(join(dir, `report-${stamp}.json`), JSON.stringify(report, null, 2));
	writeFileSync(join(dir, `run-${stamp}.log`), `${logLines.join("\n")}\n`);
	console.log("\n===== REPORT =====");
	console.log(JSON.stringify(report, null, 2));
	console.log(`\n证据：evidence/laya-benchmark-real/report-${stamp}.json`);
	process.exit(code);
}

const watchdog = setTimeout(() => {
	report.watchdog = { firedAt: new Date().toISOString(), budgetMs: WATCHDOG_MS };
	// 单次到点：只中止 + 走进程内清理。清理自己卡住时**没有**“第二次到点”可用（setTimeout 只触发一次），
	// 也不靠它保命——进程被杀 / 清理卡死时，外部清理不在本脚本保证范围内（未实现外部 watchdog）。
	fail(`整体超时（${Math.round(WATCHDOG_MS / 1000)}s）：中止并清理`);
	state.aborted = true;
	state.exitCode = 3;
	void cleanup();
}, WATCHDOG_MS);
// 不 unref：让到点定时器在空闲时也真能触发一次（清理仍假设进程活着）。
watchdogTimer = watchdog;

// ---------------------------------------------------------------- 1) 本次独占 daemon（生产 env + LaunchServices 官方 App）

const socketPath = join(dataDir, "host-control", "cua-open.sock");
// macOS 的 unix socket 路径上限约 104 字节；超了 daemon 直接 bind 失败（症状：20s 内不就绪）。
if (socketPath.length > 100) {
	fail(`本次 socket 路径太长（${socketPath.length} > 100），daemon 无法 bind：${socketPath}`);
	writeReportAndExit(2);
}
state.socket = socketPath;
state.exe = cuaPaths.exe;
// 先只登记 socket 再启动：worker 在 daemon 启动过程中被杀时，supervisor 仍能按唯一 socket 找到并收掉它。
notify({ type: "daemon", socket: socketPath, pid: null });
const nativeBaseEnv = cloneNativeBaseEnv(process.env);
const nativeRoots = [root, dataDir, workspaceDir, tempHome, tempTmp];
// 原生边界：只用上面这份**显式 clone** 的 base env + OS 账户家目录，和本进程的 HOME 无关。
const daemonEnv = nativeLaunchEnv({
	baseEnv: nativeBaseEnv,
	realHome: osAccountHome(),
	syntheticRoots: nativeRoots,
	extra: { CUA_DRIVER_TELEMETRY: "0", CUA_DRIVER_DISABLE_RUN_SCRIPT: "1", CUA_DRIVER_BROWSER_PROFILE_ROOT: profileRoot },
});
const problems = nativeLaunchEnvProblems(daemonEnv.env, { realHome: daemonEnv.realHome, syntheticRoots: nativeRoots });
const daemonEnvCheck = envWhitelist(daemonEnv.env, { root, realHome: REAL_HOME });
report.env.daemon = {
	...daemonEnvCheck,
	strippedKeys: daemonEnv.stripped,
	diverged: daemonEnv.diverged,
	problems,
	// 边界（如实）：这是**本进程算出来、交给启动器的 env 输入配置**；没有读取 daemon / Chrome 子进程的实际环境，
	// 能证明“按这份配置启动且 daemon 起来了 / 链路真的打开过”，不能证明“子进程最终环境 ≡ 这份”。
	evidenceScope: "input-config-not-actual-child-process-env",
};
log("daemon env（白名单；输入配置，不是子进程实际环境）", JSON.stringify(report.env.daemon));
if (problems.length) {
	fail(`给 daemon 的原生环境自检未通过：${problems.join("；")}`);
	await cleanup();
}

const serveArgs = ["serve", "--socket", socketPath, "--permission-mode", "unrestricted", "--dangerously-bypass-approvals", "--no-permissions-gate"];
try {
	if (existsSync(socketPath)) rmSync(socketPath, { force: true });
	await exec("open", ["-n", "-g", "-a", cuaPaths.app, ...(daemonEnv.env.HOME ? ["--env", `HOME=${daemonEnv.env.HOME}`] : []), "--args", ...serveArgs], { env: daemonEnv.env, timeout: 15_000 });
	let statusText = "";
	let ready = false;
	for (let i = 0; i < 80; i++) {
		try {
			const r = await exec(cuaPaths.exe, ["status", "--socket", socketPath], { timeout: 3000, env: daemonEnv.env });
			statusText = `${r.stdout}`.trim().slice(0, 400);
			ready = true;
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	if (!ready) throw new Error("本次独占的 CuaDriver 没有在 20 秒内就绪（不循环重试）");
	let pids = [];
	try {
		const { stdout } = await exec("pgrep", ["-f", "--", `--socket ${socketPath}`]);
		pids = stdout.split(/\s+/).filter(Boolean).map(Number);
	} catch {
		/* 没有匹配 */
	}
	// 只认「命令行里带本次唯一 socket」的进程；生产 daemon 用的是生产 socket，不可能命中。
	const prodSockets = [join(PROD_DATA, "host-control", "cua-open.sock"), join(PROD_DATA, "host-control", "cua-bounded.sock")];
	if (pids.length !== 1) throw new Error(`无法证明本次 daemon 唯一归属（匹配到 ${pids.length} 个进程）`);
	if (prodSockets.includes(socketPath)) throw new Error("内部错误：本次 socket 与生产 socket 相同");
	state.daemonPid = pids[0];
	report.isolation.daemon = { socket: socketPath, pid: state.daemonPid, status: statusText, serveArgs, envProfileRoot: profileRoot };
	log("自有 daemon 就绪", JSON.stringify({ pid: state.daemonPid, socket: socketPath, status: statusText }));
	notify({ type: "daemon", socket: socketPath, pid: state.daemonPid });
} catch (e) {
	fail(`启动本次独占 daemon 失败：${e instanceof Error ? e.message : String(e)}`);
	await cleanup();
}

// ---------------------------------------------------------------- 2) 生产同一套 hostMcpCommand（启动器 + 全量替换）连它

const mcpCmd = hostControl.hostMcpCommand(AGENT);
if (!mcpCmd.args.some((a) => a.includes(socketPath))) {
	fail("生产 hostMcpCommand() 没有指向本次独占 socket（按设计中止）");
	await cleanup();
}
const client = new McpClient({ name: "pia-laya-bench-isolated", version: "1.0.0", requestTimeoutMs: 60_000 });
state.client = client;
try {
	await client.connect(new StdioTransport({ command: mcpCmd.command, args: mcpCmd.args, env: mcpCmd.env, inheritEnv: mcpCmd.inheritEnv, stderr: "pipe", onStderr: () => {} }));
} catch (e) {
	fail(`连接本次独占 daemon 的 MCP 失败：${e instanceof Error ? e.message : String(e)}`);
	state.exitCode = 2;
	await cleanup();
}
report.env.mcp = { commandIsLauncher: /mcp-env-launcher\.mjs$/.test(mcpCmd.args[0] ?? ""), socketMatchesOwnDaemon: true, inheritEnv: mcpCmd.inheritEnv, envReplaced: mcpCmd.envReplaced, strippedKeys: mcpCmd.stripped };
log("MCP 已连接（生产启动器）", JSON.stringify(report.env.mcp));

const invoke = async (_prefix, tool, args) => {
	try {
		const r = await client.callTool(tool, args);
		const text = (r.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
		return { isError: !!r.isError, structuredContent: r.structuredContent, contentText: text };
	} catch (e) {
		return { isError: true, contentText: e instanceof Error ? e.message : String(e) };
	}
};

const tools = (await client.listTools().catch(() => [])).map((t) => t.name);
report.isolation.daemon.tools = tools;
for (const need of ["browser_prepare", "browser_navigate", "get_browser_state", "browser_click", "browser_pointer", "list_windows", "kill_app"]) {
	if (!tools.includes(need)) {
		fail(`本次 daemon 缺少基准所需工具：${need}`);
		await cleanup();
	}
}

// ---------------------------------------------------------------- 3) fixture 窄网关（真实 HTTP，仅 127.0.0.1）

const store = new BenchmarkFixtureStateStore();
const app = new Hono();
mountFastComputerRoutes(app, {
	host: { availability: () => ({ cuaReady: true, modelReady: true, fixtureReady: true, reasons: [] }), start: async () => { throw new Error("harness 不走 host.start"); } },
	store,
});
let server;
try {
	server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
} catch (e) {
	fail(`fixture 网关起不来：${e instanceof Error ? e.message : String(e)}`);
	await cleanup();
}
state.server = server;
await new Promise((r) => setTimeout(r, 80));
const port = server.address()?.port;
if (!port) {
	fail("fixture 网关没起来");
	await cleanup();
}
report.isolation.fixture = { origin: `http://127.0.0.1:${port}`, tasks: benchmarkFixtureTasks().map((t) => t.id) };

const driver = createInvokeBenchmarkDriver({
	target: () => ({ prefix: "hostpc" }),
	invoke,
	fixtureUrl: (path) => `http://127.0.0.1:${port}${path}`,
	windowKindOf: () => "driver-isolated-browser",
	capable: () => ({ ok: true }),
	guard: ({ prefix, tool }) => benchmarkToolGuard({ prefix, tool, paused: false, tier: "full" }),
});

// ---------------------------------------------------------------- 4) 真实 Laya：先经生产 API 停原模型（16GB 不热两个），再起本次独占 runtime

const baseline = await layaStatus().catch((e) => ({ error: String(e?.message ?? e) }));
report.laya.baseline = layaSummary(baseline);
report.laya.baselineRaw = baseline?.error ? { error: baseline.error } : { install: baseline?.install?.state, configured: baseline?.configured };
log("生产 Laya baseline", JSON.stringify(report.laya.baseline));
notify({ type: "baseline", prodLayaRunning: baseline?.runtime?.state === "running", apiBase: APP_API });
if (baseline?.runtime?.state !== "running") {
	fail(`生产 Laya 不是 running（baseline=${JSON.stringify(report.laya.baseline)}），按设计不继续（无法证明“停原模型再恢复”）`);
	await cleanup();
}

// 在 HTTP 请求前登记恢复责任，覆盖服务已停而 worker 尚未收到响应就退出的窗口。
notify({ type: "prod_laya_stop_requested" });
const stopped = await appApi("/api/local-models/laya/stop", { method: "POST" }).catch((e) => ({ ok: false, body: { error: String(e?.message ?? e) } }));
report.laya.stopped = { ok: stopped.ok, status: layaSummary(stopped.body?.status) };
log("已用生产 API 停原 Laya", JSON.stringify(report.laya.stopped));
{
	let after = await layaStatus().catch(() => null);
	for (let i = 0; i < 40 && after?.runtime?.state === "running"; i++) {
		await new Promise((r) => setTimeout(r, 250));
		after = await layaStatus().catch(() => null);
	}
	report.laya.stopped.after = layaSummary(after);
	if (after?.runtime?.state === "running") {
		fail("生产 Laya 没有停下（不会同时热两个模型），中止");
		await cleanup();
	}
	notify({ type: "prod_laya_stopped" });
}

const manager = new LocalLayaManager(createLayaDeps(), LAYA_SOURCE);
state.laya = manager;
try {
	const st = await manager.start();
	const ownToken = manager.runtime?.token ?? null;
	report.laya.own = { ...layaSummary(st), tokenDigest: ownToken ? tokenDigest(ownToken) : null };
	if (st?.runtime?.state !== "running" || !st?.health?.ok) throw new Error(`本次 Laya runtime 没起来（${JSON.stringify(layaSummary(st))}）`);
	log("本次独占 Laya 已起", JSON.stringify({ pid: st.runtime.pid, port: st.runtime.port, health: layaSummary(st).health, tokenDigest: report.laya.own.tokenDigest }));
	notify({ type: "laya", pid: st.runtime.pid, port: st.runtime.port });
} catch (e) {
	fail(`启动本次独占 Laya 失败：${e instanceof Error ? e.message : String(e)}`);
	await cleanup();
}

// ---------------------------------------------------------------- 5) 生产 chooser（buildChooser → systemone → models.classify）

const settings = { enabled: true, kind: "systemone", provider: LAYA_PROVIDER_ID, id: LAYA_MODEL_ID, baseUrl: "https://api.typesafe.ai", model: "jev-latest", threshold: 0.6, timeoutMs: TIMEOUT_MS };
const chooser = buildChooser(settings);
if (!chooser) {
	fail("生产 buildChooser() 返回 null（快速模型选择器不可用）");
	await cleanup();
}
report.model = {
	provider: LAYA_PROVIDER_ID,
	model: LAYA_MODEL_ID,
	kind: settings.kind,
	threshold: settings.threshold,
	timeoutMs: settings.timeoutMs,
	chooser: "production buildChooser(settings) + selectFastAction()",
	// 与生产 benchmark-host 唯一的差别：熔断作用域按任务分开（否则前几条 fallback 会把后面几条直接熔断成 circuit_open，扭曲每题结论）。
	circuitKeyScope: "per-task",
	// 诊断开关：fallback 时额外记录「生产 chooser 本来想选谁」（只记录、不执行、不计入决策）。
	rawChooserDiagnostic: process.env.PIA_BENCH_RAW === "1",
};

// ---------------------------------------------------------------- 6) 打开驱动自有隔离浏览器（真实 prepare → list_windows → bind → navigate → snapshot pin）

const fixtureId = `bench-${Math.random().toString(36).slice(2, 8)}`;
const nonce = Math.random().toString(36).slice(2, 12);
const token = Math.random().toString(36).slice(2, 26);
store.arm(fixtureId, nonce, token);
let opened;
try {
	opened = await driver.openFixtureWindow({ url: `/api/fast-computer/benchmark/fixture/${fixtureId}?nonce=${nonce}`, fixtureId, nonce, target: "hostpc" });
	state.browser = opened;
	const h = opened.handle;
	report.isolation.browser = { pid: h.pid, windowId: h.windowId, targetId: h.targetId, tabId: h.tabId, windowToken: h.windowToken, url: h.url };
	log("隔离浏览器已打开 / 绑定 / pin", JSON.stringify(report.isolation.browser));
} catch (e) {
	fail(`打开 / 绑定驱动自有隔离浏览器失败：${e instanceof Error ? e.message : String(e)}`);
	await cleanup();
}

const handle = opened.handle;
const browserTarget = handle.targetId && handle.tabId ? { target_id: handle.targetId, tab_id: handle.tabId } : null;
if (!browserTarget) {
	fail("隔离浏览器没有拿到 target_id/tab_id（fail-closed）");
	await cleanup();
}
const prefixTool = "mcp__hostpc__";
const window = { prefix: "hostpc", pid: handle.pid, windowId: handle.windowId, windowToken: handle.windowToken, fixtureId };
const collect = (structured) => clickCandidatesFromBrowserRefs(prefixTool, browserTarget, structured);
const fixtureUrl = `http://127.0.0.1:${port}/api/fast-computer/benchmark/fixture/${fixtureId}?nonce=${nonce}`;

/** 每个任务开始前回到 fixture 根（同一 tab 重新导航；GET 幂等，状态由 store.reset 清空）。 */
async function gotoFixture() {
	const nav = await invoke("hostpc", "browser_navigate", { ...browserTarget, url: fixtureUrl });
	if (nav.isError) throw new Error(`重新导航 fixture 失败：${String(nav.contentText ?? "").slice(0, 200)}`);
}

/** 取独立 UI 证据：页面上 role=status 的可见文本（不含模型自评）。 */
async function uiEvidence() {
	const observed = await driver.observe(handle);
	if ("error" in observed) return { ok: false, error: observed.error };
	const els = observed.structured?.elements ?? [];
	const statuses = els.filter((e) => /status/i.test(String(e.role ?? ""))).map((e) => ({ role: e.role, label: e.label ?? null }));
	return { ok: true, statuses };
}

function runnerFor(taskLog) {
	return createCuaTrialRunner(window, {
		readWindow: () => driver.readWindow(handle),
		observe: () => driver.observe(handle),
		collectCandidates: collect,
		choose: async (goal, candidates, signal) => {
			taskLog.candidates = candidates.map((c) => c.label);
			const t0 = Date.now();
			const result = await selectFastAction({ key: `hostpc:${handle.pid}:${handle.windowId}:${taskLog.id}`, goal, candidates, chooser, settings, signal });
			taskLog.latencyMs = Date.now() - t0;
			taskLog.decision = result.kind;
			if (result.kind === "selected") {
				taskLog.selected = { id: result.candidate.id, label: result.candidate.label };
				taskLog.confidence = result.confidence ?? null;
				// 阈值比较值（概率按 Jev 公式换算）与选项概率分开记：Laya 的 `confidence` 是归一化熵，
				// 两者不是一个量；记下来才能在**一次**运行里分清“熵低”还是“概率低”。
				taskLog.decisionConfidence = result.decisionConfidence ?? null;
				taskLog.probability = result.probabilities?.[result.candidate.id] ?? null;
				taskLog.uncalibrated = result.uncalibrated;
				taskLog.model = result.model ?? null;
			} else if (result.kind === "fallback") {
				taskLog.fallbackReason = result.reason;
				taskLog.fallbackDetail = result.detail ?? null;
				// 诊断（**不是**生产决策路径）：被阈值 / 熔断拦下时，再问一次同一个生产 chooser 它本来想选谁，
				// 只记录不执行。这样才能分清“选错了”还是“选对但没信心”。
				if (process.env.PIA_BENCH_RAW === "1" && !signal.aborted) {
					try {
						const raw = await chooser.choose({ goal, captureId: `diag-${taskLog.id}`, candidates: candidates.map((c) => ({ id: c.id, label: c.label })) }, signal);
						taskLog.rawChooser =
							raw.kind === "selected"
								? { kind: "selected", candidateId: raw.candidateId, label: candidates.find((c) => c.id === raw.candidateId)?.label ?? null, confidence: raw.confidence ?? null, decisionConfidence: raw.decisionConfidence ?? null, probability: raw.probabilities?.[raw.candidateId] ?? null }
								: { kind: raw.kind, reason: raw.reason ?? raw.error ?? null };
					} catch (e) {
						taskLog.rawChooser = { kind: "error", reason: e instanceof Error ? e.message : String(e) };
					}
				}
			}
			return result;
		},
		execute: (tool, args, signal) => driver.execute(handle, tool, args, signal),
		afterSelect: async (t, _selected, signal) => {
			const want = t.expect?.machine?.selected;
			if (typeof want !== "string" || !want) return;
			const observed = await driver.observe(handle);
			if ("error" in observed) return;
			const option = collect(observed.structured).find((c) => c.label.includes(want));
			if (option) await driver.execute(handle, option.tool, option.args, signal);
		},
		readMachineState: async () => store.getEvidence(fixtureId, nonce),
	});
}

// ---------------------------------------------------------------- 6.5) 可选：真实主模型接管（PIA_BENCH_HANDOFF=1）
// 不重跑旧 4 题：用**真实注册的** fastComputerExtension handler 跑一个真实 task 拿返回文本，
// 再起一个仅 127.0.0.1 的小控制面，让主模型自己 observe / 挑 ref / 点（不选目标、不给坐标、不执行 JS）。
// 同一个 MCP client、同一个 fixture、同一个自有 Laya；不新接 MCP / daemon，不建大框架。
async function runHandoffMode() {
	const { fastComputerExtension } = await import("../packages/server/src/fast-computer/tool.ts");
	const { saveFastComputerSettings, fastComputerSettings } = await import("../packages/server/src/fast-computer/index.ts");
	const { parseBrowserSnapshotView, browserSnapshotAsWindow } = await import("../packages/server/src/fast-computer/browser-snapshot.ts");
	const handoffMod = await import("./laya-benchmark-handoff.mjs");

	// 快速设置只写本次 scratch 数据目录；scope 与 handler 里的 `scopeOfPrefix("mcp__hostpc__")` 一致。
	saveFastComputerSettings({ enabled: true, ...settings }, "hostpc");
	const scoped = fastComputerSettings("hostpc");
	report.handoff = { settings: { enabled: scoped.enabled, kind: scoped.kind, provider: scoped.provider, id: scoped.id, threshold: scoped.threshold, timeoutMs: scoped.timeoutMs, scope: "hostpc" }, chooser: "production buildChooser(默认，不 fake)", tasks: [] };

	// 真实注册 handler：pi.registerTool 只做 stub 取 definition（不跑 pi 运行时）。
	const ext = fastComputerExtension({ agentId: AGENT });
	let definition = null;
	ext.factory({ registerTool: (d) => { definition = d; } });
	if (!definition?.execute) {
		fail("拿不到 fast_pick_action 的真实 definition（注册失败）");
		return;
	}
	const ctxTools = tools.map((n) => ({ name: `mcp__hostpc__${n}` }));
	const ctx = {
		tools: ctxTools,
		executeTool: async (name, args) => {
			const m = /^mcp__(hostpc|computer)__(.+)$/.exec(String(name));
			if (!m) return { isError: true, result: { content: [{ type: "text", text: `未知工具：${name}` }] } };
			const r = await invoke(m[1], m[2], args);
			return { isError: r.isError, result: { structuredContent: r.structuredContent, content: [{ type: "text", text: r.contentText ?? "" }] } };
		},
	};

	const handoffTasks = benchmarkFixtureTasks().filter((t) => handoffMod.HANDOFF_TASK_IDS.includes(t.id));
	const expectedOf = (task) => {
		const ui = task.expect?.ui ?? {};
		const out = {};
		if (typeof ui.role === "string") out.role = ui.role;
		if (typeof ui.label_contains === "string") out.label_contains = ui.label_contains;
		return Object.keys(out).length ? out : undefined;
	};

	const readSnapshot = async () => {
		const r = await invoke("hostpc", "get_browser_state", { target_id: handle.targetId, tab_id: handle.tabId, snapshot_format: "semantic_v2", ...(handle.session ? { session: handle.session } : {}) });
		if (r.isError) throw new Error(`读取页面快照失败：${String(r.contentText ?? "").slice(0, 300)}`);
		const view = parseBrowserSnapshotView(r.structuredContent);
		if (!view.ok) throw new Error(`页面快照不可用：${view.reason ?? "fail-closed"}`);
		if ((view.targetId && view.targetId !== handle.targetId) || (view.tabId && view.tabId !== handle.tabId)) throw new Error("快照报回的 target / tab 与本次 fixture 不一致，拒绝继续");
		const win = browserSnapshotAsWindow(r.structuredContent);
		return { elements: win.elements ?? [], url: view.url, token: view.token };
	};

	const entries = [];
	let current = null;
	const newEntry = (task) => {
		const e = { task: task.id, title: task.title, goal: task.goal, startedAt: Date.now(), commands: [], handlerText: null, handlerKind: null, handlerWallMs: null };
		entries.push(e);
		return e;
	};
	const finishEntry = async (e, task) => {
		if (!e || e.finished) return e;
		e.finished = true;
		e.wallMs = Date.now() - e.startedAt;
		const ev = store.getEvidence(fixtureId, nonce);
		e.machine = { state: ev.state, updatedAt: ev.updatedAt };
		e.ui = await uiEvidence().catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
		e.expected = task?.expect ?? null;
		return e;
	};

	let handlerRuns = 0;
	const runHandlerFor = async (task) => {
		if (handlerRuns >= handoffMod.MAX_HANDLER_RUNS) throw new Error(`真实 handler 最多跑 ${handoffMod.MAX_HANDLER_RUNS} 次（本次已跑 ${handlerRuns}）`);
		handlerRuns++;
		store.reset(fixtureId, nonce);
		await gotoFixture();
		const t0 = Date.now();
		const out = await definition.execute(`handoff-${task.id}`, { goal: task.goal, pid: handle.pid, window_id: handle.windowId, prefix: "hostpc", browser: { target_id: handle.targetId, tab_id: handle.tabId }, ...(expectedOf(task) ? { expected: expectedOf(task) } : {}) }, undefined, () => {}, ctx);
		const text = (out?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
		const kind = /快速路径跳过/.test(text) ? "fallback" : /快速模型选了/.test(text) ? "selected" : "other";
		return { text, wallMs: Date.now() - t0, kind };
	};

	let controlServer = null;
	let finishResolve;
	const finished = new Promise((r) => (finishResolve = r));
	let currentTask = handoffTasks.find((t) => t.id === "pick-submit") ?? handoffTasks[0];
	current = newEntry(currentTask);
	try {
		const first = await runHandlerFor(currentTask);
		current.handlerText = first.text;
		current.handlerKind = first.kind;
		current.handlerWallMs = first.wallMs;
		report.handoff.handlerRuns = handlerRuns;
		log(`真实 handler（${currentTask.id}）kind=${first.kind} ${first.wallMs}ms`);
	} catch (e) {
		fail(`真实 handler 跑失败：${e instanceof Error ? e.message : String(e)}`);
		return;
	}

	const control = handoffMod.createHandoffControl({
		fixtureUrl,
		fixtureId,
		nonce,
		invoke,
		handle,
		readSnapshot,
		readMachine: async () => store.getEvidence(fixtureId, nonce),
		taskOf: () => currentTask,
		log,
		onCommand: (entry) => current?.commands.push(entry),
		onNext: async (taskId, runFast) => {
			const task = handoffTasks.find((t) => t.id === taskId);
			if (!task) throw new Error(`未知任务：${taskId}`);
			await finishEntry(current, currentTask);
			currentTask = task;
			current = newEntry(task);
			store.reset(fixtureId, nonce);
			await gotoFixture();
			if (runFast) {
				const r = await runHandlerFor(task);
				current.handlerText = r.text;
				current.handlerKind = r.kind;
				current.handlerWallMs = r.wallMs;
				report.handoff.handlerRuns = handlerRuns;
			}
		},
		onFinish: () => finishResolve(),
	});
	const listening = await control.listen();
	controlServer = listening.server;
	const origin = listening.origin;
	report.handoff.control = { origin, path: "/command", nonceHeader: "x-pia-bench-nonce", methods: ["observe", "click", "pointer", "next", "finish"], loopbackOnly: true, bodyLimitBytes: 4096 };

	// ready 文件：只写本次 scratch 根（不含 fixture store token；nonce 是本次内存态随机值，不是凭据）。
	const ready = {
		schema: "laya-benchmark-handoff/1",
		origin,
		path: "/command",
		nonceHeader: "x-pia-bench-nonce",
		controlNonce: nonce,
		nonceNote: "ephemeral in-memory nonce for this run (not a credential / not a real key)",
		fixture: { id: fixtureId, url: fixtureUrl, targetId: handle.targetId, tabId: handle.tabId, pid: handle.pid, windowId: handle.windowId, session: handle.session ?? null },
		task: { id: currentTask.id, goal: currentTask.goal, expected: currentTask.expect ?? null, allowed: handoffMod.HANDOFF_TASK_IDS },
		handler: { kind: current.handlerKind, text: current.handlerText, wallMs: current.handlerWallMs },
		startedAt: new Date().toISOString(),
	};
	writeFileSync(join(root, "handoff.json"), JSON.stringify(ready, null, 2));
	console.log("\n===== HANDOFF READY =====");
	console.log(JSON.stringify(ready, null, 2));
	log("handoff 控制面就绪", JSON.stringify({ origin, task: currentTask.id, handlerKind: current.handlerKind }));
	notify({ type: "handoff_ready", origin, task: currentTask.id });

	await finished;
	if (controlServer) controlServer.close();
	await finishEntry(current, currentTask);
	report.handoff.tasks = handoffMod.summarizeHandoff(entries);
	report.handoff.finishedAt = new Date().toISOString();
	const tookOver = entries.filter((e) => e.handlerKind === "fallback" && (e.commands ?? []).some((c) => c.op === "click" && c.ok));
	report.handoff.summary = {
		entries: entries.length,
		handlerRuns,
		fallbacks: entries.filter((e) => e.handlerKind === "fallback").length,
		selectedByFast: entries.filter((e) => e.handlerKind === "selected").length,
		mainTakeoverClicked: tookOver.map((e) => e.task),
		tasks: entries.map((e) => ({ task: e.task, handlerKind: e.handlerKind, commands: (e.commands ?? []).length, wallMs: e.wallMs ?? null, machine: e.machine?.state ?? null })),
	};
	state.exitCode = 0;
}

/** 读本次 scope 的快速设置（只读回显用，避免与 handler 内部 scope 解析不一致）。 */
async function runTask(task, { scored }) {
	const entry = { id: task.id, title: task.title, scored };
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), Math.max(task.timeoutMs ?? 12_000, 30_000));
	try {
		store.reset(fixtureId, nonce);
		await gotoFixture();
		const t0 = Date.now();
		const metrics = await runnerFor(entry)(task, { signal: ac.signal });
		entry.wallMs = Date.now() - t0;
		Object.assign(entry, metrics);
		const evidence = store.getEvidence(fixtureId, nonce);
		entry.machine = { state: evidence.state, updatedAt: evidence.updatedAt };
		entry.ui = await uiEvidence();
	} catch (e) {
		entry.error = e instanceof Error ? e.message : String(e);
		entry.correctness = "unknown";
	} finally {
		clearTimeout(timer);
	}
	if (scored) report.tasks.push(entry);
	else report.warmup = entry;
	log(`task ${task.id}${scored ? "" : "（预热，不计分）"} → ${entry.correctness} decision=${entry.decision ?? "-"} conf=${entry.confidence ?? "-"} gate=${entry.decisionConfidence ?? "-"} p=${entry.probability ?? "-"} latency=${entry.latencyMs ?? "-"}ms actions=${entry.actions ?? "-"} ${entry.error ? `err=${entry.error}` : ""}`);
	return entry;
}

const tasks = benchmarkFixtureTasks();
if (HANDOFF_MODE) {
	await runHandoffMode();
	await cleanup();
}
// 与生产 `startBenchmark` 一致的预热语义：先跑 1 条不计分，避免把冷启动当模型质量。
await runTask(tasks[0], { scored: false });
for (const task of tasks) {
	if (state.aborted) break;
	await runTask(task, { scored: true });
}

const scored = report.tasks;
const lat = scored.map((t) => t.latencyMs).filter((n) => typeof n === "number").sort((a, b) => a - b);
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.max(0, Math.ceil((p / 100) * lat.length) - 1))] : null);
report.summary = {
	total: tasks.length,
	completed: scored.length,
	correct: scored.filter((t) => t.correctness === "correct").length,
	successRatio: scored.length ? Number((scored.filter((t) => t.correctness === "correct").length / scored.length).toFixed(3)) : null,
	fallbacks: scored.filter((t) => t.decision === "fallback").length,
	fallbackReasons: scored.filter((t) => t.decision === "fallback").map((t) => t.fallbackReason),
	abstains: scored.filter((t) => t.abstain).length,
	timeouts: scored.filter((t) => /timeout/i.test(String(t.fallbackReason ?? t.error ?? ""))).length,
	p50Ms: pct(50),
	p95Ms: pct(95),
	latenciesMs: lat,
};
log("summary", JSON.stringify(report.summary));

store.disarm(fixtureId, nonce);
state.exitCode = report.summary.correct === tasks.length && scored.length === tasks.length ? 0 : 1;
await cleanup();
