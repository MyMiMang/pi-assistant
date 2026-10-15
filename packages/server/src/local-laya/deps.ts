/**
 * 本地 Laya 的**生产依赖实现**（真实文件系统 / 进程 / HTTP）。
 *
 * 与 `manager.ts` 分离：manager 是纯状态机（测试注入 fake），这里才碰真实系统。
 * 安全约束：只用我们自己的数据目录；uv 用 pinned 版本；权重走 HF 缓存（自带续传）；
 * sidecar 只绑 127.0.0.1；token 只注入子进程环境 + Pi 进程内 runtime key，不写任何用户凭据文件。
 */
import { spawn as nodeSpawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { config } from "../config.ts";
import { ensureUv as ensureUvPinned, uvPath as uvPinnedPath } from "../memory/hindsight/uv-bin.ts";
import { watchDir } from "../downloads.ts";
import { models } from "../models.ts";
import { PYTHON_VERSION } from "./manifest.ts";
import { checkpointFiles } from "./checkpoint-files.ts";
import { hfSnapshotDir } from "./hf-metadata.ts";
import { verifyCheckpointFiles } from "./verify.ts";
import { platformProfile, type NvidiaProbe, type PlatformContext } from "./platform.ts";
import { LAYA_BIND_HOST, LAYA_MODEL_ID, LAYA_PROVIDER_ID, type LayaChild, type LayaDeps, type LayaHealth, type LayaPaths, type LayaRunResult } from "./manager.ts";

/** 我们自己的数据根目录：`数据目录/local-laya`（与用户文件、系统 Python 完全隔离）。 */
export function layaRoot(): string {
	return join(config.dataDir, "local-laya");
}

export function layaPaths(): LayaPaths {
	const root = layaRoot();
	const runtime = join(root, "runtime");
	return {
		root,
		env: join(runtime, "env"),
		envStaging: join(runtime, "env.new"),
		envPrev: join(runtime, "env.old"),
		python: join(root, "python"),
		uvCache: join(root, "uv-cache"),
		hfHome: join(root, "hf"),
		logs: join(root, "logs"),
		pidFile: join(runtime, "serve.pid"),
		metaFile: join(runtime, "meta.json"),
	};
}

/** 只检驱动，不自动安装系统驱动。拿不到就按「没有」处理，绝不假装支持 CUDA。 */
export async function probeNvidia(): Promise<NvidiaProbe> {
	const out = await execFileQuiet("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"], 8000);
	if (out.code !== 0) return { available: false, driver: null, cuda: null };
	const driver = out.stdout.split(/\r?\n/)[0]?.trim() || null;
	// CUDA 版本从 nvidia-smi 头部读；拿不到就 null（不猜）
	const full = await execFileQuiet("nvidia-smi", [], 8000);
	const cuda = full.stdout.match(/CUDA Version:\s*([\d.]+)/)?.[1] ?? null;
	return { available: !!driver, driver, cuda };
}

function execFileQuiet(cmd: string, args: string[], timeoutMs: number): Promise<LayaRunResult> {
	return new Promise((res) => {
		execFile(cmd, args, { timeout: timeoutMs, env: { PATH: process.env.PATH ?? "" } }, (err, stdout, stderr) => {
			res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/** 找一个空闲端口（listen 0 拿系统分配端口后立刻释放），降低撞口风险。 */
export async function findFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", rej);
		srv.listen(0, LAYA_BIND_HOST, () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => res(port));
		});
	});
}

/** 读 sidecar `/health`（带 Bearer token 拿详细字段）；解析失败就当不可用。 */
export async function readHealth(port: number, token: string, signal?: AbortSignal): Promise<LayaHealth> {
	const res = await fetch(`http://${LAYA_BIND_HOST}:${port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: signal ?? AbortSignal.timeout(5000) });
	if (!res.ok) return { ok: false, device: null, checkpointDevices: null, cpuFallbacks: null, revisions: null, loaded: null };
	const j = (await res.json()) as Record<string, unknown>;
	const cf = j.cpu_fallbacks as { count?: number; last_reason?: string | null } | undefined;
	return {
		ok: j.status === "ok" || res.ok,
		device: typeof j.device === "string" ? j.device : null,
		checkpointDevices: (j.checkpoint_devices as Record<string, string> | undefined) ?? null,
		cpuFallbacks: cf ? { count: Number(cf.count ?? 0), lastReason: cf.last_reason ?? null } : null,
		revisions: (j.revisions as Record<string, string> | undefined) ?? null,
		loaded: Array.isArray(j.loaded) ? (j.loaded as string[]) : null,
	};
}

/** 把 manager 的错误日志写进我们自己的日志文件（已脱敏）。 */
function appendLog(paths: LayaPaths, line: string) {
	try {
		mkdirSync(paths.logs, { recursive: true });
		writeFileSync(join(paths.logs, "laya.log"), `${new Date().toISOString()} ${line.replace(/\b[a-f0-9]{32,}\b/gi, "***")}\n`, { flag: "a" });
	} catch {
		/* 日志失败不影响主流程 */
	}
}

export function createLayaDeps(): LayaDeps {
	return {
		profile: (ctx?: PlatformContext) => platformProfile(process.platform, process.arch, ctx),
		nvidiaProbe: probeNvidia,
		ensureUv: () => ensureUvPinned(),
		uvPath: () => uvPinnedPath(),
		pythonVersion: () => PYTHON_VERSION,
		run: (cmd, args, opts) =>
			new Promise<LayaRunResult>((res, rej) => {
				const child = execFile(
					cmd,
					args,
					{ env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv, timeout: opts.timeoutMs ?? 30 * 60_000, signal: opts.signal, maxBuffer: 32 * 1024 * 1024 },
					(err, stdout, stderr) => {
						const code = err ? ((err as { code?: number }).code ?? 1) : 0;
						res({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
					},
				);
				child.on("error", rej);
			}),
		spawn: (exe, args, opts) => spawnServe(exe, args, opts.env),
			downloadCheckpoint: async (cp, p, signal, env, pythonPath) => {
			const paths = layaPaths();
			mkdirSync(paths.hfHome, { recursive: true });
			const py = pythonPath;
			// 只按固定清单取文件（allow_patterns），不下 repo 里的多余脚本；snapshot_download 自带续传（取消后 partial 保留可恢复）。
			const allow = checkpointFiles(cp.id).map((f) => f.path);
			const script =
				"import sys; from huggingface_hub import snapshot_download; snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], allow_patterns=sys.argv[3].split(',') if sys.argv[3] else None, local_files_only=False)";
			await watchDir([paths.hfHome], { bytes: (r, t) => p(r, t), detail: () => {} }, cp.bytes, () =>
				new Promise<void>((res, rej) => {
					const child = execFile(py, ["-c", script, cp.repo, cp.revision, allow.join(",")], { env: { ...process.env, ...env } as NodeJS.ProcessEnv, signal, timeout: 60 * 60_000 }, (err, _o, stderr) => (err ? rej(new Error(String(stderr || err.message).slice(0, 300))) : res()));
					child.on("error", rej);
				}),
			);
		},
		verifyCheckpoint: async (cp, signal) => {
			if (signal.aborted) throw new Error("已取消");
			const files = checkpointFiles(cp.id);
			if (!files.length) throw new Error(`没有 ${cp.id} 的固定文件清单，拒绝在未校验下激活`);
			const dir = hfSnapshotDir(layaPaths().hfHome, cp.repo, cp.revision);
			const res = await verifyCheckpointFiles(dir, files);
			if (!res.ok) throw new Error(`权重校验未通过：${res.problems.slice(0, 3).join("；")}`);
		},
		findFreePort,
		health: readHealth,
		randomToken: () => randomBytes(32).toString("hex"),
		paths: layaPaths,
		registerClassifier: (info) => {
			models.registerClassifiers(LAYA_PROVIDER_ID, [{ protocol: "typesafe-system-one", modelId: LAYA_MODEL_ID, name: "本地 Laya · multilingual", contextWindow: 8192 }], { baseUrl: info.baseUrl, chatModels: [] });
			void models.setRuntimeApiKey(LAYA_PROVIDER_ID, info.token);
		},
		unregisterClassifier: (provider) => {
			try {
				models.unregisterProvider(provider);
			} catch {
				/* 未注册过 */
			}
			void models.removeRuntimeApiKey(provider).catch(() => {});
		},
		recordPid: (pid) => {
			const paths = layaPaths();
			try {
				mkdirSync(join(paths.root, "runtime"), { recursive: true });
				if (pid == null) rmSync(paths.pidFile, { force: true });
				else writeFileSync(paths.pidFile, JSON.stringify({ pid, startedAt: Date.now() }));
			} catch {
				/* pid 记录失败不影响运行 */
			}
		},
		now: () => Date.now(),
		isInstalled: () => existsSync(layaPaths().env) && existsSync(layaPaths().metaFile),
		log: (line) => appendLog(layaPaths(), line),
		activate: async (paths) => {
			// 原子切换：旧 env → env.old，staging → env；写 meta。失败不留半成品。
			mkdirSync(join(paths.root, "runtime"), { recursive: true });
			if (existsSync(paths.envPrev)) rmSync(paths.envPrev, { recursive: true, force: true });
			if (existsSync(paths.env)) renameSync(paths.env, paths.envPrev);
			renameSync(paths.envStaging, paths.env);
			const cfg = join(paths.env, "pyvenv.cfg");
			writeFileSync(paths.metaFile, JSON.stringify({ installedAt: Date.now(), version: existsSync(cfg) ? readFileSync(cfg, "utf8").slice(0, 200) : "" }, null, 2));
		},
		rollback: async (paths) => {
			rmSync(paths.envStaging, { recursive: true, force: true });
			if (!existsSync(paths.env) && existsSync(paths.envPrev)) renameSync(paths.envPrev, paths.env);
		},
		uninstall: async (paths) => {
			// canonical 校验：只允许删我们自己的 root，绝不误删用户文件
			const expected = resolve(layaRoot());
			if (resolve(paths.root) !== expected) throw new Error("卸载路径不在本地 Laya 目录下，已拒绝");
			if (existsSync(paths.root)) rmSync(paths.root, { recursive: true, force: true });
		},
	};
}

/** spawn 我们自己的 sidecar（只绑 127.0.0.1，日志写 own 目录）。 */
function spawnServe(exe: string, args: string[], env: Record<string, string>): LayaChild {
	mkdirSync(join(layaRoot(), "logs"), { recursive: true });
	const logFile = join(layaRoot(), "logs", "serve.log");
	const child = nodeSpawn(exe, args, { env: { ...process.env, ...env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
	const out = () => {
		const s = statSync(logFile).size;
		if (s > 5_000_000) writeFileSync(logFile, "");
	};
	child.stdout?.on("data", (b: Buffer) => {
		out();
		writeFileSync(logFile, b.toString().replace(/\b[a-f0-9]{32,}\b/gi, "***"), { flag: "a" });
	});
	child.stderr?.on("data", (b: Buffer) => {
		out();
		writeFileSync(logFile, b.toString().replace(/\b[a-f0-9]{32,}\b/gi, "***"), { flag: "a" });
	});
	const exits: ((code: number | null) => void)[] = [];
	child.on("exit", (code) => {
		for (const cb of exits) cb(code);
	});
	return {
		pid: child.pid,
		kill: (signal?: NodeJS.Signals) => child.kill(signal),
		onExit: (cb) => exits.push(cb),
	};
}

/** 供测试 / 调试：token 摘要（不暴露原文）。 */
export function tokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/** 读最近 N 行 sidecar 日志（已脱敏，供界面「查看日志」）。 */
export function readLayaLogs(maxLines = 200): string[] {
	try {
		const p = join(layaRoot(), "logs", "serve.log");
		if (!existsSync(p)) return [];
		return readFileSync(p, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.slice(-Math.max(1, Math.min(2000, maxLines)));
	} catch {
		return [];
	}
}
