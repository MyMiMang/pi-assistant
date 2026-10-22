/**
 * e2e 的**临时服务端**统一入口：临时 RUN_DIR / DATA / WORKSPACE / HOME / TMPDIR + 内存凭据 + 有界收尾。
 *
 * 为什么要有这一层：浏览器 e2e 要起真实服务，但绝不能碰用户真实数据目录、HOME、钥匙串或别人的临时目录。
 * 以前的脚本各写一份 `spawn(main.ts)`：有的直接 `src/main.ts`（会构造走 OS 钥匙串的生产凭据后端），
 * 有的写错 `PIA_WORKSPACE_DIR`（真实变量是 `PIA_WORKSPACE`），有的用固定 `/tmp/pia-e2e-*`。
 * 现在统一成：
 *  1) 每次 `makeTempRun()` 新建一个 mkdtemp 目录，DATA / WORKSPACE / HOME 都在里面；
 *  2) 服务走 `packages/server/test/launch-memory.ts`（公开注入点 = 内存凭据，不构造生产后端），
 *     env 一定是 **临时 HOME + 临时 TMPDIR + 临时 DATA + 临时 WORKSPACE**，且在任何 import 之前由子进程拿到；
 *  3) 收尾 `stop()`：先整组 SIGTERM，限时等不到再 SIGKILL（不留孤儿 tsx / server）；`cleanup()` 只删本次目录。
 *
 * 浏览器（原生 Chrome）**不要**用这里的 `serverEnv()`：它必须走 `nativeLaunchBrowserEnv()`
 * （真实 HOME / 真实 TMPDIR），否则 Chrome 会拿合成家目录。`browserEnv(run)` 就是那层包装。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { nativeLaunchBrowserEnv } from "./native-launch-env.mjs";

/** 本次运行独占的临时目录（前缀 + mkdtemp 归属本次进程）；只删它自己。 */
export function makeTempRun(prefix) {
	const runDir = mkdtempSync(join(tmpdir(), prefix));
	const run = {
		prefix,
		runDir,
		data: join(runDir, "data"),
		workspace: join(runDir, "workspace"),
		home: join(runDir, "home"),
	};
	for (const dir of [run.data, run.workspace, run.home]) mkdirSync(dir, { recursive: true });
	return run;
}

/**
 * 真实模型服务商的凭据环境变量（*_API_KEY / *_TOKEN、ANTHROPIC_* / AWS_* / AZURE_* / GOOGLE_* 等）。
 * 临时服务不继承：Pi 会把设了这些变量的服务商算作「已配置」，模型分组数就跟着开发机变
 * （room-member-model-settings-ui 的「按两个已配置服务分组」就这样挂过），也不能有误碰真实付费模型的可能。
 */
const CREDENTIAL_ENV = /(_API_KEY|_TOKEN|_SECRET_ACCESS_KEY)$|^(ANTHROPIC|AWS|AZURE|GOOGLE|GCLOUD)_/;
export const withoutCredentials = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !CREDENTIAL_ENV.test(k)));

/** 给**服务进程**的 env：临时 HOME / TMPDIR / DATA / WORKSPACE（浏览器不要用这份）。 */
export function serverEnv(run, extra = {}) {
	return {
		...withoutCredentials(process.env),
		HOME: run.home,
		TMPDIR: run.runDir,
		PIA_DATA_DIR: run.data,
		PIA_WORKSPACE: run.workspace,
		PIA_MOCK: "1",
		PIA_OFFLINE: "1",
		...extra,
	};
}

/** 给**原生浏览器**的 env：真实 HOME / 真实 TMPDIR；合成根里的临时目录变量一律剥离。 */
export const browserEnv = (run) => nativeLaunchBrowserEnv({ syntheticRoots: [run.runDir] });

/** 活着（没退出、也没被信号收掉）。 */
const alive = (child) => !!child && child.exitCode === null && child.signalCode === null;

/** 按进程组收（脚本用 `detached: true` 起了独立进程组）；收不到再退回单进程。 */
function killTree(child, signal) {
	if (!child || child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {}
	}
}

// 脚本被 Ctrl-C / 异常打断时也不留孤儿：退出时对还活着的子进程组补 SIGKILL（正常 stop 后会先从集合移除）
const live = new Set();
process.on("exit", () => {
	for (const child of live) killTree(child, "SIGKILL");
});
// 父运行器超时一般先发 SIGTERM；显式退出才能触发上面的同步兜底。
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
	process.once(signal, () => process.exit(code));
}

/**
 * 启动真实服务（`test/launch-memory.ts`，内存凭据 + Mock + 临时目录）。
 * @returns {{ child: import("node:child_process").ChildProcess, logs: () => string, stop: () => Promise<void> }}
 */
export function startTempServer({ root, port, run, extra = {}, log } = {}) {
	const child = spawn(process.execPath, ["--import", "tsx", "packages/server/test/launch-memory.ts"], {
		cwd: root,
		env: serverEnv(run, { PIA_PORT: String(port), ...extra }),
		stdio: ["ignore", "pipe", "pipe"],
		detached: true, // 独立进程组：收尾时整组收，超时 / 异常都不留孤儿
	});
	let logs = "";
	const collect = (d) => {
		logs += d;
		if (log) log(String(d));
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	live.add(child);
	child.once("exit", () => live.delete(child));
	return { child, logs: () => logs, stop: () => stopTempServer(child) };
}

/** 有界收尾：SIGTERM → 等 `timeoutMs`（默认 5s）→ 还活着就 SIGKILL。返回时进程已不再运行（或已无法收）。 */
export async function stopTempServer(child, timeoutMs = 5000) {
	if (!alive(child)) return;
	const done = new Promise((resolve) => child.once("exit", resolve));
	killTree(child, "SIGTERM");
	await Promise.race([done, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
	if (!alive(child)) return;
	killTree(child, "SIGKILL");
	await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 1000))]);
}

/** 只删 `makeTempRun()` 建的那个目录（前缀 + 直属 tmpdir 双校验），不碰调用方给的其它路径。 */
export function cleanupTempRun(run) {
	if (!run?.runDir || process.env.KEEP) return;
	const root = join(tmpdir(), run.prefix);
	if (!run.runDir.startsWith(root) || !basename(run.runDir).startsWith(run.prefix)) return;
	rmSync(run.runDir, { recursive: true, force: true });
}
