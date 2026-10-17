/**
 * 快速操作模型 · **真实 Laya 完整 benchmark**（隔离 daemon + 驱动自有隔离浏览器 + 生产 chooser）。
 *
 * 这个脚本是 `docs/design/fast-model-benchmark.md` §9.6 的落地：
 *  1. 先断言**本进程**是原生环境（HOME = OS 账户家目录、无 CFFIXED_USER_HOME、TMPDIR 不在合成根里）；
 *  2. 起一个**本次独占**的 CuaDriver 守护进程：独立 socket / data dir / 浏览器 profile root，
 *     用生产同一套原生 env（`nativeLaunchEnvForChild`）+ macOS LaunchServices 官方签名 `CuaDriver.app`；
 *     不共用、不停止生产 App 的守护进程；
 *  3. 用**生产同一套** `hostMcpCommand()`（自有启动器 + 环境全量替换）连它，
 *     经生产 `createInvokeBenchmarkDriver` 打开**驱动自有隔离浏览器**（`browser_prepare{isolated_new}`），
 *     真实走 list_windows → bind → navigate → snapshot pin → click，并把每一步的身份 / pin 记进证据；
 *  4. 接**真实本地 Laya**：用生产 `LocalLayaManager`（自有 data dir，权重来自本机已物化的受校验目录的 clonefile 副本）
 *     起一个本次独占 sidecar（自己的端口 + 自己的 token，不读生产 token / 生产 DB），
 *     经生产 `buildChooser()`（systemone → `models.classify`）与 `selectFastAction()` 跑完整 4 个 fixture 任务；
 *  5. 每题记：模型 decision / confidence / latency / fallback、派发动作、双证据（fixture 机器状态 + 独立 UI 观测）；
 *  6. `finally` 里按相反顺序清理：只关自己打开的浏览器 → 断 MCP → 停自有 daemon（先证明 socket 归属）→
 *     停自有 Laya → 用**生产 HTTP API** 把用户的 Laya 恢复到原来的运行状态（并复核）。
 *
 * 诚实边界：
 *  - 本脚本不评估“泛化能力”：只跑固定的 4 个 synthetic 任务；
 *  - 不把 fixture 结果当“机器性能结论”，不按阈值迎合通过（threshold / timeout 用生产默认，除非显式改并记录）；
 *  - 不读生产 token / 凭据 / 生产 DB；Laya 权重只用本机已物化目录的只读副本（clonefile，不写回原目录）；
 *  - 若系统权限弹窗 / 授权需要本人处理，脚本按失败停下并如实报告，不循环重试。
 *
 * 用法（显式手动运行；不进默认 npm test）：
 *   node --import tsx scripts/laya-benchmark-isolated-harness.mjs
 *   PIA_BENCH_KEEP=1                保留 scratch 目录（默认保留日志、删权重副本）
 *   PIA_BENCH_APP_API=http://127.0.0.1:8787   生产 App 的本机 API（用于停 / 恢复 Laya；仅回环）
 *   PIA_BENCH_TIMEOUT_MS=4000       快速模型单次决策超时（生产默认 4000）
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";

const exec = promisify(execFile);
const OWNER = "amv7oy7ejb00";
const APP_API = process.env.PIA_BENCH_APP_API ?? "http://127.0.0.1:8787";
const AGENT = process.env.PIA_BENCH_AGENT ?? "laya-bench-agent";
const TIMEOUT_MS = Number(process.env.PIA_BENCH_TIMEOUT_MS ?? 4000);
const KEEP = process.env.PIA_BENCH_KEEP === "1";
const WATCHDOG_MS = Number(process.env.PIA_BENCH_WATCHDOG_MS ?? 9 * 60_000);
const REAL_HOME = userInfo().homedir;
const PROD_DATA = join(REAL_HOME, "Library", "Application Support", "Pi Assistant");

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
	const marker = ".pia-laya-bench-owner";
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
const dataDir = join(root, "data");
const workspaceDir = join(root, "workspace");
const profileRoot = join(root, "browser-profile");
for (const d of [dataDir, workspaceDir, profileRoot, join(dataDir, "host-control")]) mkdirSync(d, { recursive: true });

// 隔离启动：数据目录 / 工作区 / 浏览器 profile 都是本次独占的；HOME 保持 OS 账户家目录（原生环境）。
process.env.PIA_DATA_DIR = dataDir;
process.env.PIA_WORKSPACE = workspaceDir;
process.env.PIA_OFFLINE = "1";

const within = (p, r) => {
	try {
		const rel = relative(resolve(r), resolve(p));
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	} catch {
		return false;
	}
};

/** 只读这三项（白名单）：HOME / CFFIXED_USER_HOME / TMPDIR 的存在与值，不打印其它环境变量。 */
function envWhitelist() {
	const tmp = process.env.TMPDIR ?? null;
	return {
		home: process.env.HOME ?? null,
		homeIsOsAccount: process.env.HOME === REAL_HOME,
		cffixedUserHomePresent: Object.prototype.hasOwnProperty.call(process.env, "CFFIXED_USER_HOME"),
		tmpdir: tmp,
		tmpdirUnderSyntheticRoot: tmp ? [root, dataDir].some((r) => within(tmp, r)) : false,
	};
}

const hostEnv = envWhitelist();
report.env = { platform: process.platform, arch: process.arch, node: process.version, realHome: REAL_HOME, host: hostEnv, scratchRoot: root };
log("host env（白名单）", JSON.stringify(hostEnv));
if (!hostEnv.homeIsOsAccount || hostEnv.cffixedUserHomePresent || hostEnv.tmpdirUnderSyntheticRoot) {
	fail("本进程不是原生环境（HOME/CFFIXED_USER_HOME/TMPDIR 不在预期状态），按设计不启动 daemon / 浏览器");
	writeReportAndExit(2);
}

// ---------------------------------------------------------------- 生产模块（config 已在上面用隔离 data dir 初始化）

const { nativeLaunchEnvForChild, nativeLaunchEnvProblems, osAccountHome } = await import("../packages/server/src/native-launch-env.ts");
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

// scratch data dir 里没有 bin / local-laya 运行时：用显式软链指到本机**官方签名**驱动与本机已物化的 Laya 运行时。
//  - bin：只读使用（官方 CuaDriver.app；`cuaPaths()` 仍按 config.dataDir 解析，所以软链让它拿到同一个 App）；
//  - local-laya/runtime/env：只读使用（生产 venv 的 laya-serve）；
//  - local-laya/runtime/weights：**clonefile 副本**（Laya 可能改写目录里的 tokenizer 配置，副本保证不写回原目录）。
const prodBin = join(PROD_DATA, "bin");
const prodLaya = join(PROD_DATA, "local-laya", "runtime");
const scratchBin = join(dataDir, "bin");
const scratchLayaRuntime = join(dataDir, "local-laya", "runtime");
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

async function stopOwnDaemon() {
	if (state.daemonStopped || !state.socket) return;
	state.daemonStopped = true;
	const env = nativeLaunchEnvForChild({ CUA_DRIVER_TELEMETRY: "0" }, { syntheticRoots: [config.dataDir] }).env;
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
	log("生产 Laya 恢复", JSON.stringify(out));
}

async function cleanup() {
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
		state.layaStopped = true;
		await state.laya.stop().catch((e) => (report.cleanup.layaStopError = String(e?.message ?? e).slice(0, 200)));
	}
	if (state.server) state.server.close();
	await restoreProductionLaya();
	if (!KEEP) rmSync(join(scratchLayaRuntime, "weights"), { recursive: true, force: true });
	report.finishedAt = new Date().toISOString();
	writeReportAndExit(state.exitCode);
}

function writeReportAndExit(code) {
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
	// 清理本身也可能卡住（例如恢复生产 Laya 的 HTTP 调用）：第二次到点就强制落盘退出，不无限挂。
	if (state.finished) {
		report.watchdog.forced = true;
		fail("清理阶段再次超时，强制结束");
		writeReportAndExit(4);
	}
	fail(`整体超时（${Math.round(WATCHDOG_MS / 1000)}s）：中止并清理`);
	state.aborted = true;
	state.exitCode = 3;
	void cleanup();
}, WATCHDOG_MS);
watchdog.unref?.();

// ---------------------------------------------------------------- 1) 本次独占 daemon（生产 env + LaunchServices 官方 App）

const socketPath = join(dataDir, "host-control", "cua-open.sock");
// macOS 的 unix socket 路径上限约 104 字节；超了 daemon 直接 bind 失败（症状：20s 内不就绪）。
if (socketPath.length > 100) {
	fail(`本次 socket 路径太长（${socketPath.length} > 100），daemon 无法 bind：${socketPath}`);
	writeReportAndExit(2);
}
state.socket = socketPath;
state.exe = cuaPaths.exe;
const daemonEnv = nativeLaunchEnvForChild({ CUA_DRIVER_TELEMETRY: "0", CUA_DRIVER_DISABLE_RUN_SCRIPT: "1", CUA_DRIVER_BROWSER_PROFILE_ROOT: profileRoot }, { syntheticRoots: [dataDir] });
const problems = nativeLaunchEnvProblems(daemonEnv.env, { realHome: daemonEnv.realHome, syntheticRoots: [dataDir] });
const daemonEnvCheck = envWhitelistFrom(daemonEnv.env);
report.env.daemon = { homeIsOsAccount: daemonEnvCheck.homeIsOsAccount, cffixedUserHomePresent: daemonEnvCheck.cffixedUserHomePresent, tmpdirUnderSyntheticRoot: daemonEnvCheck.tmpdirUnderSyntheticRoot, strippedKeys: daemonEnv.stripped, diverged: daemonEnv.diverged, problems };
log("daemon env（白名单）", JSON.stringify(report.env.daemon));
if (problems.length) {
	fail(`给 daemon 的原生环境自检未通过：${problems.join("；")}`);
	await cleanup();
}

function envWhitelistFrom(env) {
	const tmp = env.TMPDIR ?? null;
	return {
		home: env.HOME ?? null,
		homeIsOsAccount: env.HOME === REAL_HOME,
		cffixedUserHomePresent: Object.prototype.hasOwnProperty.call(env, "CFFIXED_USER_HOME"),
		tmpdir: tmp,
		tmpdirUnderSyntheticRoot: tmp ? [root, dataDir].some((r) => within(tmp, r)) : false,
	};
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
await client.connect(new StdioTransport({ command: mcpCmd.command, args: mcpCmd.args, env: mcpCmd.env, inheritEnv: mcpCmd.inheritEnv, stderr: "pipe", onStderr: () => {} }));
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
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
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
if (baseline?.runtime?.state !== "running") {
	fail(`生产 Laya 不是 running（baseline=${JSON.stringify(report.laya.baseline)}），按设计不继续（无法证明“停原模型再恢复”）`);
	await cleanup();
}

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
}

const manager = new LocalLayaManager(createLayaDeps(), LAYA_SOURCE);
state.laya = manager;
try {
	const st = await manager.start();
	const ownToken = manager.runtime?.token ?? null;
	report.laya.own = { ...layaSummary(st), tokenDigest: ownToken ? tokenDigest(ownToken) : null };
	if (st?.runtime?.state !== "running" || !st?.health?.ok) throw new Error(`本次 Laya runtime 没起来（${JSON.stringify(layaSummary(st))}）`);
	log("本次独占 Laya 已起", JSON.stringify({ pid: st.runtime.pid, port: st.runtime.port, health: layaSummary(st).health, tokenDigest: report.laya.own.tokenDigest }));
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
								? { kind: "selected", candidateId: raw.candidateId, label: candidates.find((c) => c.id === raw.candidateId)?.label ?? null, confidence: raw.confidence ?? null }
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
	log(`task ${task.id}${scored ? "" : "（预热，不计分）"} → ${entry.correctness} decision=${entry.decision ?? "-"} conf=${entry.confidence ?? "-"} latency=${entry.latencyMs ?? "-"}ms actions=${entry.actions ?? "-"} ${entry.error ? `err=${entry.error}` : ""}`);
	return entry;
}

const tasks = benchmarkFixtureTasks();
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
