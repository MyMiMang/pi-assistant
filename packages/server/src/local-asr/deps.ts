/**
 * 本地 SenseVoice ASR 的**生产依赖实现**（真实文件系统 / 进程 / HTTP）。
 *
 * 与 `manager.ts` 分离：manager 是纯状态机（测试注入 fake），这里才碰真实系统。
 * 安全约束：
 *  - 只用我们自己的数据目录（`数据目录/local-asr`）；uv 用 pinned 版本；权重走**我们自己的目录**（不用共享 HF 缓存）；
 *  - sidecar 只绑 127.0.0.1；token 只注入子进程环境 + 进程内注册表，不写任何用户凭据文件；
 *  - 「用户自行导入」只从给定目录复制**清单内**的文件，canonical 校验 + 不读敏感目录。
 */
import { spawn as nodeSpawn, execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { config } from "../config.ts";
import { ensureUv as ensureUvPinned, uvPath as uvPinnedPath } from "../memory/hindsight/uv-bin.ts";
import { watchDir } from "../downloads.ts";
import { ASR_BIND_HOST, ASR_PROVIDER_ID, ASR_PYTHON_VERSION, SENSEVOICE_MODEL, type AsrWeightFile } from "./manifest.ts";
import { registerAsrEndpoint, unregisterAsrEndpoint } from "./adapter-registry.ts";
import { ASR_PROTOCOL } from "./adapter.ts";
import { serveScriptSource } from "./serve-script.ts";
import { verifyAsrWeights } from "./weights.ts";
import type { AsrChild, AsrDeps, AsrHealth, AsrPaths, AsrRunResult } from "./manager.ts";
import { senseVoicePlatform } from "./platform.ts";

/** 我们自己的数据根目录：`数据目录/local-asr`。 */
export function asrRoot(): string {
	return join(config.dataDir, "local-asr");
}

export function asrPaths(): AsrPaths {
	const root = asrRoot();
	const runtime = join(root, "runtime");
	return {
		root,
		env: join(runtime, "env"),
		envStaging: join(runtime, "env.new"),
		envPrev: join(runtime, "env.old"),
		python: join(root, "python"),
		uvCache: join(root, "uv-cache"),
		weights: join(root, "weights"),
		weightsStaging: join(root, "weights.new"),
		logs: join(root, "logs"),
		pidFile: join(runtime, "serve.pid"),
		metaFile: join(runtime, "meta.json"),
	};
}

/** 找空闲端口（listen 0 拿系统分配端口后释放）。 */
export async function findFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.unref();
		srv.on("error", rej);
		srv.listen(0, ASR_BIND_HOST, () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => res(port));
		});
	});
}

/** 读 sidecar `/health`（Bearer token）。解析失败按不可用处理。 */
export async function readHealth(port: number, token: string, signal?: AbortSignal): Promise<AsrHealth> {
	const res = await fetch(`http://${ASR_BIND_HOST}:${port}/health`, { headers: { authorization: `Bearer ${token}` }, signal: signal ?? AbortSignal.timeout(5000) });
	if (!res.ok) return { ok: false, device: null, loaded: null };
	const j = (await res.json()) as Record<string, unknown>;
	return {
		ok: j.status === "ok" || res.ok,
		device: typeof j.device === "string" ? j.device : "cpu",
		loaded: Array.isArray(j.loaded) ? (j.loaded as string[]) : null,
	};
}

// ------------------------------------------------------- 用户自行导入权重

/** 导入目录的 canonical 校验：绝对路径 + 真实目录 + 不在我们自己的根目录内 + 不是敏感目录。 */
export function assertSafeImportDir(srcDir: string, roots: { selfRoot?: string; home?: string } = {}): string {
	if (typeof srcDir !== "string" || !srcDir.trim()) throw new Error("导入目录为空");
	if (!srcDir.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(srcDir)) throw new Error("导入目录必须是绝对路径");
	const abs = resolve(srcDir);
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(abs);
	} catch {
		throw new Error("导入目录不存在");
	}
	if (st.isSymbolicLink()) throw new Error("导入目录不能是符号链接");
	if (!st.isDirectory()) throw new Error("导入路径不是目录");

	const selfRoot = resolve(roots.selfRoot ?? asrRoot());
	if (abs === selfRoot || abs.startsWith(selfRoot + sep)) throw new Error("不能从本地 ASR 自己的目录导入");

	const home = resolve(roots.home ?? homedir());
	const denied = [join(home, ".ssh"), join(home, ".gnupg"), join(home, "Library", "Keychains"), join(home, ".aws"), join(home, ".config", "gcloud"), "/System", "/etc", "/private/etc"];
	for (const d of denied) {
		const dd = resolve(d);
		if (abs === dd || abs.startsWith(dd + sep)) throw new Error("该目录属于敏感位置，拒绝导入");
	}
	return abs;
}

/** 只复制清单内的文件到 staging；源文件必须是普通文件（不是符号链接），大小必须与清单一致。 */
export function copyManifestFiles(srcDir: string, destDir: string, files: AsrWeightFile[], signal?: AbortSignal): { copied: number; bytes: number } {
	mkdirSync(destDir, { recursive: true });
	let copied = 0;
	let bytes = 0;
	for (const f of files) {
		if (signal?.aborted) throw new Error("已取消");
		const rel = String(f.path).replace(/\\/g, "/");
		if (!rel || rel.startsWith("/") || rel.split("/").some((s) => s === "" || s === "." || s === "..")) throw new Error(`清单路径不安全：${f.path}`);
		const src = join(srcDir, rel);
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(src);
		} catch {
			throw new Error(`导入目录缺少文件：${rel}`);
		}
		if (st.isSymbolicLink()) throw new Error(`导入文件不能是符号链接：${rel}`);
		if (!st.isFile()) throw new Error(`导入项不是普通文件：${rel}`);
		if (st.size !== f.size) throw new Error(`导入文件大小不符：${rel}（期望 ${f.size}，实际 ${st.size}）`);
		const dest = join(destDir, rel);
		mkdirSync(join(dest, ".."), { recursive: true });
		copyFileSync(src, dest);
		copied += 1;
		bytes += f.size;
	}
	return { copied, bytes };
}

// ------------------------------------------------------------- 真实依赖

function execFileQuiet(cmd: string, args: string[], timeoutMs: number): Promise<AsrRunResult> {
	return new Promise((res) => {
		execFile(cmd, args, { timeout: timeoutMs, env: { PATH: process.env.PATH ?? "" } }, (err, stdout, stderr) => {
			res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
		});
	});
}

/** 物理核数：优先 sysctl / /proc，拿不到返回 null（调用方退回逻辑核/2）。 */
export function detectPhysicalCores(): number | null {
	try {
		if (process.platform === "darwin") {
			const out = execFileSync("sysctl", ["-n", "hw.physicalcpu"], { timeout: 3000 });
			const n = Number(String(out).trim());
			return Number.isFinite(n) && n > 0 ? n : null;
		}
		if (process.platform === "linux") {
			const txt = readFileSync("/proc/cpuinfo", "utf8");
			const ids = new Set<string>();
			for (const line of txt.split("\n")) {
				const m = /^physical id\s*:\s*(\d+)/.exec(line);
				const c = /^cpu cores\s*:\s*(\d+)/.exec(line);
				if (m && c) ids.add(`${m[1]}:${c[1]}`);
			}
			return ids.size > 0 ? ids.size : null;
		}
	} catch {
		/* 拿不到就 null */
	}
	return null;
}

export function createAsrDeps(): AsrDeps {
	return {
		profile: () => senseVoicePlatform(process.platform, process.arch),
		physicalCores: detectPhysicalCores,
		logicalCores: () => {
			try {
				const n = cpus().length;
				return typeof n === "number" && n > 0 ? n : null;
			} catch {
				return null;
			}
		},
		ensureUv: () => ensureUvPinned(),
		uvPath: () => uvPinnedPath(),
		pythonVersion: () => ASR_PYTHON_VERSION,
		run: (cmd, args, opts) =>
			new Promise<AsrRunResult>((res, rej) => {
				const child = execFile(
					cmd,
					args,
					{ env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv, timeout: opts.timeoutMs ?? 30 * 60_000, signal: opts.signal, maxBuffer: 32 * 1024 * 1024 },
					(err, stdout, stderr) => res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
				);
				child.on("error", rej);
			}),
		spawnServe: (exe, args, opts) => spawnServe(exe, args, opts.env),
		downloadWeights: async (files, p, signal, env, pythonPath) => {
			const paths = asrPaths();
			mkdirSync(paths.weightsStaging, { recursive: true });
			const allow = files.map((f) => f.path);
			const total = files.reduce((n, f) => n + f.size, 0);
			// 只按固定清单取文件（allow_patterns）；下到我们自己的 staging 目录（真实文件，不用共享 HF 缓存符号链接）。
			const script =
				"import sys; from huggingface_hub import snapshot_download; snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], allow_patterns=sys.argv[3].split(','), local_dir=sys.argv[4])";
			await watchDir([paths.weightsStaging], { bytes: (r, t) => p(r, t), detail: () => {} }, total, () =>
				new Promise<void>((res, rej) => {
					const child = execFile(
						pythonPath,
						["-c", script, SENSEVOICE_MODEL.repo, SENSEVOICE_MODEL.revision, allow.join(","), paths.weightsStaging],
						{ env: { ...process.env, ...env } as NodeJS.ProcessEnv, signal, timeout: 60 * 60_000 },
						(err, _o, stderr) => (err ? rej(new Error(String(stderr || err.message).slice(0, 300))) : res()),
					);
					child.on("error", rej);
				}),
			);
		},
		verifyWeights: async (files, signal) => {
			if (signal.aborted) throw new Error("已取消");
			const res = await verifyAsrWeights(asrPaths().weightsStaging, files, { signal });
			if (!res.ok) throw new Error(`权重校验未通过：${res.problems.slice(0, 3).join("；")}`);
		},
		importWeights: async (sourceDir, files, signal) => {
			const safe = assertSafeImportDir(sourceDir);
			return copyManifestFiles(safe, asrPaths().weightsStaging, files, signal);
		},
		findFreePort,
		health: readHealth,
		randomToken: () => randomBytes(32).toString("hex"),
		paths: asrPaths,
		registerAsr: (info) => {
			registerAsrEndpoint({
				provider: info.provider,
				modelId: info.modelId,
				protocol: info.protocol,
				baseUrl: info.baseUrl,
				token: info.token,
				sampleRate: info.sampleRate,
				languages: [],
			});
		},
		unregisterAsr: (provider) => unregisterAsrEndpoint(provider),
		recordPid: (pid) => {
			const paths = asrPaths();
			try {
				mkdirSync(join(paths.root, "runtime"), { recursive: true });
				if (pid == null) rmSync(paths.pidFile, { force: true });
				else writeFileSync(paths.pidFile, JSON.stringify({ pid, startedAt: Date.now() }));
			} catch {
				/* pid 记录失败不影响运行 */
			}
		},
		now: () => Date.now(),
		setTimer: (fn, ms) => {
			const t = setTimeout(fn, ms);
			t.unref?.();
			return { cancel: () => clearTimeout(t) };
		},
		isInstalled: () => existsSync(asrPaths().env) && existsSync(asrPaths().weights) && existsSync(asrPaths().metaFile),
		log: (line) => appendLog(asrPaths(), line),
		activate: async (paths, meta) => {
			mkdirSync(join(paths.root, "runtime"), { recursive: true });
			// 权重：staging → weights（旧目录保留为备份，成功后删）
			const weightsPrev = `${paths.weights}.old`;
			if (existsSync(weightsPrev)) rmSync(weightsPrev, { recursive: true, force: true });
			if (existsSync(paths.weights)) renameSync(paths.weights, weightsPrev);
			renameSync(paths.weightsStaging, paths.weights);
			// venv：staging → env
			if (existsSync(paths.envPrev)) rmSync(paths.envPrev, { recursive: true, force: true });
			if (existsSync(paths.env)) renameSync(paths.env, paths.envPrev);
			renameSync(paths.envStaging, paths.env);
			writeFileSync(paths.metaFile, JSON.stringify({ installedAt: Date.now(), ...meta }, null, 2));
			writeFileSync(join(paths.root, "serve.py"), serveScriptSource());
			rmSync(weightsPrev, { recursive: true, force: true });
		},
		rollback: async (paths) => {
			rmSync(paths.envStaging, { recursive: true, force: true });
			rmSync(paths.weightsStaging, { recursive: true, force: true });
			if (!existsSync(paths.env) && existsSync(paths.envPrev)) renameSync(paths.envPrev, paths.env);
			const weightsPrev = `${paths.weights}.old`;
			if (!existsSync(paths.weights) && existsSync(weightsPrev)) renameSync(weightsPrev, paths.weights);
		},
		uninstall: async (paths) => {
			const expected = resolve(asrRoot());
			if (resolve(paths.root) !== expected) throw new Error("卸载路径不在本地 ASR 目录下，已拒绝");
			if (existsSync(paths.root)) rmSync(paths.root, { recursive: true, force: true });
		},
	};
}

function appendLog(paths: AsrPaths, line: string) {
	try {
		mkdirSync(paths.logs, { recursive: true });
		writeFileSync(join(paths.logs, "asr.log"), `${new Date().toISOString()} ${line.replace(/\b[a-f0-9]{32,}\b/gi, "***")}\n`, { flag: "a" });
	} catch {
		/* 日志失败不影响主流程 */
	}
}

/** spawn 我们自己的 sidecar（只绑 127.0.0.1，日志写 own 目录，已脱敏）。 */
function spawnServe(exe: string, args: string[], env: Record<string, string>): AsrChild {
	mkdirSync(join(asrRoot(), "logs"), { recursive: true });
	const logFile = join(asrRoot(), "logs", "serve.log");
	const child = nodeSpawn(exe, args, { env: { ...process.env, ...env, ASR_ROOT: asrRoot() } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
	const write = (b: Buffer) => {
		try {
			if (statSync(logFile).size > 5_000_000) writeFileSync(logFile, "");
			writeFileSync(logFile, b.toString().replace(/\b[a-f0-9]{32,}\b/gi, "***"), { flag: "a" });
		} catch {
			/* 忽略 */
		}
	};
	child.stdout?.on("data", write);
	child.stderr?.on("data", write);
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

/** 读最近 N 行 sidecar 日志（已脱敏，供界面「查看日志」）。 */
export function readAsrLogs(maxLines = 200): string[] {
	try {
		const p = join(asrRoot(), "logs", "serve.log");
		if (!existsSync(p)) return [];
		return readFileSync(p, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.slice(-Math.max(1, Math.min(2000, maxLines)));
	} catch {
		return [];
	}
}

export { ASR_BIND_HOST, ASR_PROVIDER_ID, ASR_PROTOCOL };
