#!/usr/bin/env node
/**
 * Laya benchmark 的**外部监护进程**（supervisor）：独立于 worker 存在，负责超时、收尾和恢复。
 *
 * 解决的问题：harness 自己的清理只在进程内（finally / 到点 abort / uncaught），worker 被 SIGKILL / OOM
 * 时「本次独占 daemon 还在跑」「生产 Laya 被停着」都不受保证。supervisor 是另一个进程，worker 死了它还活着。
 *
 * 用法：
 *   node scripts/laya-benchmark-supervisor.mjs --timeout-ms=540000 -- node --import tsx scripts/laya-benchmark-isolated-harness.mjs
 *
 * 职责（全部有界，不碰系统设置 / launchd / 权限 / 生产 daemon）：
 *  1. 建本次 scratch 根（owner marker + `supervisor-state.json`），只记录非敏感字段
 *     （socket / pid / baseline 布尔 / 回环 API base；**不记 token、不记 env**）；
 *  2. 通过 fd 3/4 与 worker 握手（见 laya-benchmark-supervisor-handshake.mjs），worker 每建一个资源就 checkpoint，
 *     supervisor 立刻原子落盘；
 *  3. 到点 / 收到信号 / worker 退出后：先杀 worker 进程组（含它拉起的子进程），再独立核验：
 *     - 本次 daemon：只按**命令行里的唯一 socket** 重新 `pgrep` 证明归属，再 SIGTERM→SIGKILL，绝不按历史 pid 盲杀；
 *     - 本次自有 Laya：只在 `ps` 命令行包含本次 scratch 根时证明归属并终止；
 *     - 恢复生产 Laya：仅当 baseline 是 running、且我们确实停过它、且自有 daemon / Laya 都已证明停干净，
 *       才走生产回环 API `POST /api/local-models/laya/start`（≤200s 有界）并复核 health；否则明确 cleanup failure，
 *       不热第二个模型；baseline 本来是 stopped 就绝不启动。
 *
 * 退出码：worker 的退出码；超时 124；清理失败在 0 的基础上抬到 1。
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OWNER = "amv7oy7ejb00";
const MARKER = ".pia-laya-bench-owner";
const args = process.argv.slice(2);
const sep = args.indexOf("--");
if (sep < 0 || sep === args.length - 1) {
	console.error("用法：node scripts/laya-benchmark-supervisor.mjs [--timeout-ms=N] [--api-base=URL] -- <worker 命令...>");
	process.exit(2);
}
const opt = (name, dflt) => {
	const hit = args.slice(0, sep).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};
const TIMEOUT_MS = Math.max(1_000, Number(opt("timeout-ms", 9 * 60_000)) || 9 * 60_000);
const API_BASE = opt("api-base", "http://127.0.0.1:8787").replace(/\/$/, "");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API_BASE)) {
	console.error(`拒绝非回环 API base：${API_BASE}`);
	process.exit(2);
}
const workerCmd = args.slice(sep + 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = new Date().toISOString();
const root = join("/tmp", `pia-lb-${OWNER}-${Date.now().toString(36)}`);
mkdirSync(root, { recursive: true });
writeFileSync(join(root, MARKER), `${OWNER}\n`);
const statePath = join(root, "supervisor-state.json");
const state = {
	schema: "laya-bench-supervisor/1",
	owner: OWNER,
	root,
	apiBase: API_BASE,
	startedAt,
	updatedAt: startedAt,
	phase: "starting",
	workerPid: null,
	socket: null,
	daemonPid: null,
	baselineProdLayaRunning: null,
	ownLayaPid: null,
	prodLayaStopped: false,
	daemonStopped: false,
	layaStopped: false,
	prodRestored: false,
	workerReportedExit: null,
	timeout: null,
	cleanup: null,
};
function save(patch = {}) {
	Object.assign(state, patch, { updatedAt: new Date().toISOString() });
	const tmp = `${statePath}.tmp`;
	writeFileSync(tmp, JSON.stringify(state, null, 2));
	renameSync(tmp, statePath);
}
save();

/** 只按「命令行里带本次唯一 socket」找进程（fresh 查询，不用历史 pid）。 */
function pidsForSocket(socket) {
	try {
		return execFileSync("pgrep", ["-f", "--", `--socket ${socket}`], { encoding: "utf8" })
			.split(/\s+/)
			.filter(Boolean)
			.map(Number);
	} catch {
		return [];
	}
}
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/** 只在 `ps` 命令行包含本次 scratch 根时证明「这个 pid 是本次 worker 拉起的」。 */
function ownedByThisRun(pid) {
	try {
		return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(root);
	} catch {
		return false;
	}
}
function signal(pid, sig) {
	try {
		process.kill(pid, sig);
	} catch {
		/* 已退出 */
	}
}
function killGroup(pid, sig) {
	try {
		process.kill(-pid, sig);
	} catch {
		/* 已退出 */
	}
}

let child = null;
let timer = null;
let finished = false;
let timedOut = false;

async function recover(reason) {
	const cleanup = { reason, daemon: null, laya: null, restore: null, failures: [] };
	// 1) 本次独占 daemon：按 socket 重新查，SIGTERM → 等待 → SIGKILL，再查一次。
	if (state.socket) {
		const found = pidsForSocket(state.socket);
		for (const pid of found) signal(pid, "SIGTERM");
		await sleep(found.length ? 800 : 0);
		let left = pidsForSocket(state.socket);
		if (left.length) {
			for (const pid of left) signal(pid, "SIGKILL");
			await sleep(500);
			left = pidsForSocket(state.socket);
		}
		cleanup.daemon = { socket: state.socket, found, leftoverPids: left, stopped: left.length === 0 };
		if (!cleanup.daemon.stopped) cleanup.failures.push("本次 daemon 无法证明已停");
	} else {
		cleanup.daemon = { socket: null, stopped: true };
	}
	// 2) 本次自有 Laya：worker 已确认停就信 checkpoint，否则只在能证明归属时终止。
	if (state.layaStopped) {
		cleanup.laya = { pid: state.ownLayaPid, stopped: true, source: "worker-checkpoint" };
	} else if (state.ownLayaPid && alive(state.ownLayaPid)) {
		if (!ownedByThisRun(state.ownLayaPid)) {
			cleanup.laya = { pid: state.ownLayaPid, stopped: false, source: "ownership-unproven" };
			cleanup.failures.push("自有 Laya 存活但无法证明归属，未杀");
		} else {
			signal(state.ownLayaPid, "SIGTERM");
			await sleep(800);
			if (alive(state.ownLayaPid)) {
				signal(state.ownLayaPid, "SIGKILL");
				await sleep(500);
			}
			cleanup.laya = { pid: state.ownLayaPid, stopped: !alive(state.ownLayaPid), source: "proven-command-line" };
			if (!cleanup.laya.stopped) cleanup.failures.push("自有 Laya 杀不掉");
		}
	} else {
		cleanup.laya = { pid: state.ownLayaPid, stopped: true, source: state.ownLayaPid ? "already-dead" : "never-started" };
	}
	// 3) 恢复生产 Laya：必须「baseline running + 确实停过 + 自有资源全停」才做；否则明确失败，不热第二个模型。
	const needRestore = state.baselineProdLayaRunning === true && state.prodLayaStopped === true && state.prodRestored !== true;
	if (!needRestore) {
		cleanup.restore = { skipped: state.baselineProdLayaRunning === true ? "没有暂停过生产 Laya 或已恢复" : "baseline 不是 running，不擅自启动" };
	} else if (!cleanup.daemon.stopped || !cleanup.laya.stopped) {
		cleanup.restore = { skipped: "自有 daemon / Laya 未证明停干净，拒绝恢复第二个热模型" };
		cleanup.failures.push("生产 Laya 未恢复（自有资源未清）");
	} else {
		cleanup.restore = await restoreProductionLaya();
		if (!cleanup.restore.ok) cleanup.failures.push("生产 Laya 恢复失败");
	}
	cleanup.ok = cleanup.failures.length === 0;
	save({ phase: "cleanup", cleanup, daemonStopped: cleanup.daemon.stopped, layaStopped: cleanup.laya.stopped, prodRestored: cleanup.restore?.ok ?? state.prodRestored });
	return cleanup;
}

/** 生产 API 恢复：总时长 ≤200s（POST 180s + 轮询 20s），只走回环。 */
async function restoreProductionLaya() {
	const out = { ok: false, attempts: [] };
	try {
		const res = await fetch(`${API_BASE}/api/local-models/laya/start`, { method: "POST", signal: AbortSignal.timeout(180_000) });
		out.attempts.push({ start: res.status });
	} catch (e) {
		out.attempts.push({ startError: String(e?.message ?? e).slice(0, 200) });
	}
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${API_BASE}/api/local-models/laya/status`, { signal: AbortSignal.timeout(5_000) });
			const body = await res.json();
			out.status = { state: body?.runtime?.state ?? null, health: body?.health?.ok ?? null };
			if (body?.runtime?.state === "running" && body?.health?.ok) {
				out.ok = true;
				break;
			}
		} catch (e) {
			out.status = { error: String(e?.message ?? e).slice(0, 200) };
		}
		await sleep(500);
	}
	return out;
}

async function finish(code, reason) {
	if (finished) return;
	finished = true;
	if (timer) clearTimeout(timer);
	// worker 可能还活着（信号 / 异常路径）：先收掉它的整个进程组。
	if (child?.pid) {
		killGroup(child.pid, "SIGTERM");
		await sleep(800);
		killGroup(child.pid, "SIGKILL"); // 无条件补一刀：组里可能还有忽略 SIGTERM 的子进程
	}
	const cleanup = await recover(reason);
	const exitCode = timedOut ? 124 : code === 0 && !cleanup.ok ? 1 : code || (cleanup.ok ? 0 : 1);
	save({ phase: "finished", exitCode });
	console.log(`[laya-benchmark-supervisor] 结束：exit=${exitCode} reason=${reason} root=${root} cleanup=${JSON.stringify(cleanup.failures)}`);
	process.exit(exitCode);
}

// ---------------------------------------------------------------- 启动 worker + 握手
const token = randomBytes(24).toString("hex");
child = spawn(workerCmd[0], workerCmd.slice(1), {
	stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"],
	detached: true, // 自成进程组，便于有界收掉它和它拉起的 daemon / Laya
	env: { ...process.env, PIA_BENCH_DIR: root },
});
state.workerPid = child.pid;
save({ phase: "handshaking" });
// worker 启动失败（如 tsx / 文件不存在）时管道会立刻断开：别让 EPIPE 变成未捕获异常。
child.stdio[3].on("error", () => {});
child.stdio[4].on("error", () => {});
try {
	child.stdio[4].write(`${JSON.stringify({ token, supervisorPid: process.pid })}\n`);
} catch {
	/* 下面靠 exit/error 事件收尾 */
}

let buf = "";
let handshook = false;
child.stdio[3].setEncoding("utf8");
child.stdio[3].on("data", (chunk) => {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		if (msg.type === "ack") {
			if (msg.token === token && msg.pid === child.pid) {
				handshook = true;
				save({ phase: "running" });
				timer = setTimeout(() => {
					timedOut = true;
					save({ phase: "timeout", timeout: { budgetMs: TIMEOUT_MS, at: new Date().toISOString() } });
					void finish(124, "timeout");
				}, TIMEOUT_MS);
			}
			continue;
		}
		if (!handshook) continue; // 握手前不接受任何 checkpoint
		if (msg.type === "baseline") save({ baselineProdLayaRunning: msg.prodLayaRunning === true });
		else if (msg.type === "daemon") save({ socket: typeof msg.socket === "string" ? msg.socket : null, daemonPid: msg.pid ?? null });
		else if (msg.type === "daemon_stopped") save({ daemonStopped: true });
		else if (msg.type === "prod_laya_stopped") save({ prodLayaStopped: true });
		else if (msg.type === "laya") save({ ownLayaPid: msg.pid ?? null });
		else if (msg.type === "laya_stopped") save({ layaStopped: true });
		else if (msg.type === "prod_restored") save({ prodRestored: msg.ok === true });
		else if (msg.type === "done") save({ workerReportedExit: msg.exitCode ?? null });
	}
});
child.on("error", (e) => {
	console.error(`[laya-benchmark-supervisor] worker 启动失败：${e.message}`);
	void finish(1, "spawn-error");
});
child.on("exit", (code, sig) => {
	if (!handshook) {
		console.error("[laya-benchmark-supervisor] worker 没有完成握手就退出（拒绝把它当成正常运行）");
		void finish(1, "no-handshake");
		return;
	}
	void finish(code ?? (sig ? 1 : 0), "worker-exit");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		save({ phase: `signal-${sig}` });
		void finish(130, `signal-${sig}`);
	});
}
