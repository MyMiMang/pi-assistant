#!/usr/bin/env node
/**
 * **状态：未运行（2026-10-18 用户取消专项实验）——只做过 `node --check`，一次都没执行；保留作证据，不得当产品能力、不得被 `packages/` / `apps/` import。**
 * v19s 隔离加载实验的**外部监护进程**（supervisor）。
 *
 * 为什么需要另一个进程：worker 被 SIGKILL / OOM / 卡死时，「自有 sidecar 还在占着第二个模型」「生产 Laya 被停着」
 * 都不能由 worker 自己保证。supervisor 独立存在，负责硬超时、杀 worker 整个进程组、独立核验残留，
 * 并且**只在确实是我们停过生产 Laya**（worker-state.json 里 prodStopped=true 且未 restored）时，
 * 才走生产回环 API `POST /api/local-models/laya/start` 恢复并 fresh GET 复核。
 *
 * 归属证明：sidecar 由 worker `spawn`（非 detached），因此它的 pgid == worker pid。
 * 收尾只对**这个进程组**发信号，并按 `ps` 复核 pgid 内不再有 `laya-serve`；绝不按历史 pid / port 盲杀。
 *
 * 不读凭据、不写产品目录、不碰系统设置 / 权限 / launchd；只记录非敏感字段。
 *
 * 用法：
 *   node scripts/laya-browser-v19s-supervisor.mjs --timeout-ms=1200000 -- \
 *     node --import tsx scripts/laya-browser-v19s-experiment.mjs
 *   PIA_V19S_ROOT=<隔离实验根>       与 worker 一致
 *   PIA_BENCH_APP_API=http://127.0.0.1:8787
 *
 * 退出码：worker 的退出码；超时 124；收尾失败在 0 的基础上抬到 1。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
if (sep < 0 || sep === args.length - 1) {
	console.error("用法：node scripts/laya-browser-v19s-supervisor.mjs [--timeout-ms=N] [--api-base=URL] -- <worker 命令...>");
	process.exit(2);
}
const opt = (name, dflt) => {
	const hit = args.slice(0, sep).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : dflt;
};
const TIMEOUT_MS = Math.max(5_000, Number(opt("timeout-ms", 20 * 60_000)) || 20 * 60_000);
const API_BASE = opt("api-base", process.env.PIA_BENCH_APP_API ?? "http://127.0.0.1:8787").replace(/\/$/, "");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API_BASE)) {
	console.error(`拒绝非回环 API base：${API_BASE}`);
	process.exit(2);
}
const ROOT = process.env.PIA_V19S_ROOT || "/Users/dengdeng/Library/Application Support/Pi Assistant/workspace/amv7oy7ejb00/laya-browser-v19s-exp";
const workerCmd = args.slice(sep + 1);
mkdirSync(ROOT, { recursive: true });
const workerStatePath = join(ROOT, "worker-state.json");
const statePath = join(ROOT, "supervisor-state.json");
const startedAt = new Date().toISOString();
const state = { schema: "laya-browser-v19s-supervisor/1", root: ROOT, apiBase: API_BASE, startedAt, updatedAt: startedAt, phase: "starting", workerPid: null, timeout: null, workerExit: null, cleanup: null };
const save = (patch = {}) => {
	Object.assign(state, patch, { updatedAt: new Date().toISOString() });
	writeFileSync(statePath, JSON.stringify(state, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const workerState = () => {
	try {
		return JSON.parse(readFileSync(workerStatePath, "utf8"));
	} catch {
		return {};
	}
};

async function api(pathname, method = "GET", timeoutMs = 15_000) {
	const res = await fetch(`${API_BASE}${pathname}`, { method, signal: AbortSignal.timeout(timeoutMs) });
	const text = await res.text();
	try {
		return { status: res.status, body: JSON.parse(text) };
	} catch {
		return { status: res.status, body: { raw: text.slice(0, 200) } };
	}
}

/** 该进程组里还活着的 pid（按 ps 实读，不按记忆）。 */
function groupPids(pgid) {
	try {
		const out = execFileSync("ps", ["-eo", "pid=,pgid=,command="], { encoding: "utf8" });
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.map((l) => {
				const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/);
				return m ? { pid: Number(m[1]), pgid: Number(m[2]), command: m[3] } : null;
			})
			.filter((p) => p && p.pgid === pgid);
	} catch {
		return [];
	}
}

function killGroup(pgid, sig) {
	try {
		process.kill(-pgid, sig);
	} catch {
		/* 组已空 */
	}
}

async function verifyProdRestored() {
	const r = await api("/api/local-models/laya/status");
	const st = r.body ?? {};
	const ok = st.runtime?.state === "running" && st.health?.ok === true && st.health?.device === "mps" && (st.health?.loaded ?? []).includes("multilingual");
	return { ok, runtime: st.runtime ?? null, health: st.health ?? null };
}

async function cleanup(reason) {
	const ws = workerState();
	const cleanup = { reason, workerGroupKilled: false, residual: [], prodRestored: null, failures: [] };
	// 1) 杀 worker 进程组（worker 是组长，sidecar 同组）
	if (state.workerPid) {
		killGroup(state.workerPid, "SIGTERM");
		const deadline = Date.now() + 8_000;
		while (Date.now() < deadline && groupPids(state.workerPid).length) await sleep(250);
		if (groupPids(state.workerPid).length) {
			killGroup(state.workerPid, "SIGKILL");
			await sleep(1500);
		}
		cleanup.workerGroupKilled = true;
	}
	// 2) 独立复核：进程组内不得再有 laya-serve
	const left = state.workerPid ? groupPids(state.workerPid) : [];
	cleanup.residual = left.map((p) => ({ pid: p.pid, command: p.command.slice(0, 160) }));
	if (left.some((p) => /laya-serve/.test(p.command))) {
		for (const p of left) if (/laya-serve/.test(p.command)) killGroup(p.pid, "SIGKILL");
		await sleep(1000);
		const again = groupPids(state.workerPid).filter((p) => /laya-serve/.test(p.command));
		cleanup.residual = again.map((p) => ({ pid: p.pid, command: p.command.slice(0, 160) }));
		if (again.length) cleanup.failures.push(`自有 sidecar 未退出：${again.map((p) => p.pid).join(",")}`);
	}
	// 3) 只在我们确实停过生产 Laya、且 worker 没恢复时，才恢复它
	if (ws.prodStopped && !ws.prodRestored) {
		const r = await api("/api/local-models/laya/start", "POST", 240_000);
		let last = null;
		const deadline = Date.now() + 240_000;
		for (;;) {
			last = await verifyProdRestored();
			if (last.ok || Date.now() > deadline) break;
			await sleep(1000);
		}
		cleanup.prodRestored = { httpStatus: r.status, ...last };
		if (!last.ok) cleanup.failures.push("生产 Laya 恢复后复核未通过（running/health.ok/mps/multilingual）");
	} else {
		const now = await verifyProdRestored();
		cleanup.prodRestored = { ...now, action: ws.prodStopped ? "worker_already_restored" : "not_stopped_by_us" };
		if (ws.prodBaselineRunning === true && !now.ok) cleanup.failures.push("基线是 running，但收尾时生产 Laya 不健康");
	}
	cleanup.ok = cleanup.failures.length === 0;
	save({ phase: "finished", cleanup });
	return cleanup;
}

const child = spawn(workerCmd[0], workerCmd.slice(1), { cwd: process.cwd(), env: process.env, stdio: "inherit", detached: true });
state.workerPid = child.pid ?? null;
save({ phase: "running" });
console.error(`[supervisor] worker pid=${child.pid} timeout=${TIMEOUT_MS}ms root=${ROOT}`);

let exitCode = null;
let timedOut = false;
const timer = setTimeout(() => {
	timedOut = true;
	console.error("[supervisor] 硬超时，开始收尾");
	void finish(124);
}, TIMEOUT_MS);

let finishing = false;
async function finish(code) {
	if (finishing) return;
	finishing = true;
	clearTimeout(timer);
	const cleanupRes = await cleanup(timedOut ? "timeout" : "worker_exit");
	const final = cleanupRes.ok ? code : code === 0 ? 1 : code;
	save({ phase: "finished", workerExit: code, timeout: timedOut ? { ms: TIMEOUT_MS } : null, cleanup: cleanupRes });
	console.error(`[supervisor] 收尾 ok=${cleanupRes.ok} failures=${JSON.stringify(cleanupRes.failures)} exit=${final}`);
	process.exit(final);
}

child.on("exit", (code, signal) => {
	exitCode = code ?? (signal ? 1 : 0);
	console.error(`[supervisor] worker 退出 code=${code} signal=${signal}`);
	void finish(exitCode);
});
child.on("error", (e) => {
	console.error(`[supervisor] worker 启动失败：${e.message}`);
	exitCode = 1;
	void finish(1);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void finish(1));
