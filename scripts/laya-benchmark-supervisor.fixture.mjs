/**
 * supervisor 测试用的假 worker（**不碰真实 daemon / Laya / 模型 / 浏览器**）。
 *
 * 只做三件事：走真实握手、按模式发 checkpoint、拉起「命令行里带本次 socket / scratch 根」的假进程，
 * 好让 supervisor 的归属证明与恢复路径被真实执行到。由 laya-benchmark-supervisor.test.mjs 通过
 * `-- node scripts/laya-benchmark-supervisor.fixture.mjs` 启动。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { acceptSupervisorHandshake } from "./laya-benchmark-supervisor-handshake.mjs";

const hs = await acceptSupervisorHandshake();
if (!hs) {
	console.error("fixture: 没有 supervisor 握手（拒绝直接运行）");
	process.exit(9);
}
const mode = process.env.FAKE_MODE ?? "complete";
const root = process.env.PIA_BENCH_DIR;
const apiBase = process.env.FAKE_API_BASE;
const sock = join(root, "fake-daemon.sock");

// 假 daemon：命令行带本次唯一 socket，supervisor 只能靠这条命令证明归属。
const daemon = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--socket", sock], { stdio: "ignore" });
hs.send({ type: "baseline", prodLayaRunning: mode !== "baseline-stopped" });
hs.send({ type: "daemon", socket: sock, pid: daemon.pid });

if (mode === "complete") {
	// 正常路径：worker 自己停 daemon、自己恢复生产 Laya，然后正常退出。
	daemon.kill("SIGTERM");
	await new Promise((r) => daemon.on("exit", r));
	hs.send({ type: "daemon_stopped", socket: sock });
	hs.send({ type: "laya", pid: null });
	hs.send({ type: "laya_stopped" });
	hs.send({ type: "prod_laya_stopped" });
	await fetch(`${apiBase}/api/local-models/laya/start`, { method: "POST" }).catch(() => {});
	hs.send({ type: "prod_restored", ok: true });
	hs.send({ type: "done", exitCode: 0 });
	process.exit(0);
}

// 超时路径：假 Laya 放独立进程组并忽略 SIGTERM —— 组杀收不掉它，
// 只有 supervisor 的「ps 命令行含本次 scratch 根 → SIGKILL」恢复路径能收掉。
const laya = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", join(root, "laya-runtime")], { stdio: "ignore", detached: true });
laya.unref();
hs.send({ type: "prod_laya_stopped" });
hs.send({ type: "laya", pid: laya.pid });
setInterval(() => {}, 1000); // 永不退出
