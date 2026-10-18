/**
 * 有界冷启动诊断：一次临时服务启动（内存凭据 + Mock + 临时目录），只观测，不改产品。
 *
 * 约束：总预算 <= 90s；单次启动；fetch 每次 1s 超时；不打印 env；只收自己起的进程组；
 * 证据写到 evidence/agent-details-functional/startup-diagnostic.log。
 *
 * 用法（在 worktree 根）：
 *   PATH=/Users/dengdeng/.local/node-v24.19.0/bin:$PATH \
 *   node evidence/agent-details-functional/startup-diagnostic.mjs
 */
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempRun, startTempServer, stopTempServer, cleanupTempRun } from "../../e2e/fixtures/temp-server.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const evidenceDir = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(evidenceDir, { recursive: true });
const logPath = join(evidenceDir, "startup-diagnostic.log");
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const lines = [];
const say = (line) => {
	lines.push(`[${el()}] ${line}`);
	process.stderr.write(`[诊断 ${el()}] ${line}\n`);
};

const READY_DEADLINE_MS = 40_000; // 观测到 40s 就够判断，远小于总预算
const SAMPLE_AT_MS = 15_000;

const ps = (args) => {
	try {
		return execFileSync("/bin/ps", args, { encoding: "utf8" }).trim();
	} catch (e) {
		return `ps failed: ${e.message}`;
	}
};
const psGroup = (pgid) =>
	ps(["-ax", "-o", "pid=,ppid=,pgid=,state=,command="])
		.split("\n")
		.filter((l) => l.trim().split(/\s+/)[2] === String(pgid))
		.join("\n") || "(空)";
const sample = (pid, seconds, file) => {
	try {
		execFileSync("/usr/bin/sample", [String(pid), String(seconds), "-file", file], { stdio: "ignore" });
		return true;
	} catch (e) {
		appendFileSync(file, `sample failed: ${e.message}\n`);
		return false;
	}
};

let run = null;
let server = null;
let child = null;
let readyMs = null;
const startedAt = new Date().toISOString();

try {
	// 0) 前置事实：node、cwd、node_modules 解析（不改任何东西）
	say(`node=${process.version} execPath=${process.execPath}`);
	say(`root=${root}`);
	try {
		say(`node_modules → ${execFileSync("/usr/bin/readlink", [join(root, "node_modules")], { encoding: "utf8" }).trim()}`);
	} catch { say("node_modules 不是符号链接（或读不到）"); }
	for (const pkg of ["@pi-assistant/shared", "@pi-assistant/ext-skills", "tsx"]) {
		try {
			say(`resolve ${pkg} → ${import.meta.resolve(pkg).replace(root, "<root>")}`);
		} catch (e) { say(`resolve ${pkg} 失败: ${e.message}`); }
	}
	// tsx 也会按真实路径（跟随符号链接）解析，记录它实际带来的 workspace 包位置
	say(`dist/index.html 存在: ${existsSync(join(root, "apps/web/dist/index.html"))}`);

	// 1) 一次性临时运行目录（本次进程独占）
	run = makeTempRun("pia-startup-diag-");
	say(`runDir=${run.runDir} (exists=${existsSync(run.runDir)})`);

	// 2) 随机端口，只 bind 127.0.0.1 一次探测
	const port = await new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const p = s.address().port;
			s.close(() => resolve(p));
		});
	});
	say(`port=${port}`);

	// 3) 启动（唯一一次）——日志带相对时间戳，看出卡在哪一段
	const tStart = Date.now();
	server = startTempServer({
		root,
		port,
		run,
		log: (chunk) => {
			for (const raw of String(chunk).split("\n")) {
				const line = raw.trimEnd();
				if (!line) continue;
				lines.push(`[+${((Date.now() - tStart) / 1000).toFixed(2)}s] ${line}`);
			}
		},
	});
	child = server.child;
	const pid = child.pid;
	say(`child.pid=${pid} ppid=${process.pid} spawned=${child.spawnfile}`);
	say(`child 运行态: ${ps(["-o", "pid=,ppid=,pgid=,state=,etime=,command=", "-p", String(pid)])}`);

	// 4) 每次 fetch 1s 超时；记录第一次成功的时间
	const base = `http://127.0.0.1:${port}`;
	const probe = async () => {
		try {
			const r = await fetch(`${base}/api/system`, { signal: AbortSignal.timeout(1000) });
			if (r.ok) { await r.json().catch(() => null); return "ok"; }
			return `status:${r.status}`;
		} catch (e) {
			return `err:${e.name}`;
		}
	};
	let sampled = false;
	let lastResult = "none";
	const deadline = tStart + READY_DEADLINE_MS;
	while (Date.now() < deadline) {
		const sinceStart = Date.now() - tStart;
		if (!sampled && sinceStart >= SAMPLE_AT_MS && !child.exitCode) {
			sampled = true;
			say(`>>> ${Math.round(sinceStart / 1000)}s 仍未确认 ready，开始只读采样 pid ${pid}`);
			say(`child 运行态: ${ps(["-o", "pid=,ppid=,pgid=,state=,%cpu=,etime=,command=", "-p", String(pid)])}`);
			say(`进程组 ${pid} 成员:\n${psGroup(pid)}`);
			sample(pid, 2, join(evidenceDir, "sample-15s.txt"));
			say("采样已写入 sample-15s.txt");
		}
		lastResult = await probe();
		if (lastResult === "ok") {
			readyMs = Date.now() - tStart;
			say(`READY /api/system ok，用时 ${readyMs}ms`);
			break;
		}
		if (child.exitCode !== null) {
			say(`child 已退出 code=${child.exitCode} signal=${child.signalCode}，没有 ready`);
			break;
		}
		await new Promise((r) => setTimeout(r, 250));
	}

	if (readyMs === null) {
		say(`NOT READY，最后探测结果=${lastResult}，已用 ${Date.now() - tStart}ms`);
		say(`child 运行态: ${ps(["-o", "pid=,ppid=,pgid=,state=,%cpu=,etime=,command=", "-p", String(pid)])}`);
		say(`进程组 ${pid} 成员:\n${psGroup(pid)}`);
		if (!child.exitCode) {
			sample(pid, 3, join(evidenceDir, "sample-timeout.txt"));
			say("超时采样已写入 sample-timeout.txt");
		}
		// 只读打开句柄，判断是否在等文件/网络
		try {
			const fds = execFileSync("/usr/sbin/lsof", ["-n", "-P", "-p", String(pid)], { encoding: "utf8" });
			const interesting = fds.split("\n").filter((l) => /TCP|\.json|\.db|node_modules|\.ts$/.test(l)).slice(0, 40);
			appendFileSync(join(evidenceDir, "lsof-timeout.txt"), interesting.join("\n") + "\n");
			say(`lsof 摘要（${interesting.length} 行）已写入 lsof-timeout.txt`);
		} catch (e) {
			say(`lsof 不可用: ${e.message}`);
		}
	}

	// 5) 收尾：整组 SIGTERM → 限时 SIGKILL（只针对本次 pid）
	say("stop 本次进程组…");
	await stopTempServer(child, 5000);
	const stillAlive = (() => {
		try { return ps(["-o", "pid=", "-p", String(pid)]) !== ""; } catch { return false; }
	})();
	say(`stop 后 pid ${pid} 仍存在: ${stillAlive}`);
} catch (e) {
	say(`诊断异常: ${e.stack || e.message}`);
} finally {
	try {
		if (server) await server.stop(); // 异常分支也收拢本次进程组；正常分支幂等
		if (run) {
			const runDir = run.runDir;
			cleanupTempRun(run);
			say(`cleanupTempRun 后 runDir 存在: ${existsSync(runDir)} (${runDir})`);
		}
	} catch (e) {
		say(`cleanup 异常: ${e.message}`);
	}
	const finishedAt = new Date().toISOString();
	const header = [
		"# 临时服务冷启动诊断（一次性、有界）",
		`# worktree: ${root}`,
		`# startedAt: ${startedAt}  finishedAt: ${finishedAt}  wall=${((Date.now() - t0) / 1000).toFixed(2)}s`,
		"",
	].join("\n");
	writeFileSync(logPath, header + lines.join("\n") + "\n");
	process.stdout.write(`\n证据: ${logPath}\n`);
	process.exit(0);
}
