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
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { config } from "../config.ts";
import { ensureUv as ensureUvPinned, uvPath as uvPinnedPath } from "../memory/hindsight/uv-bin.ts";
import { downloadFile } from "../downloads.ts";
import { ASR_BIND_HOST, ASR_PROVIDER_ID, ASR_PYTHON_VERSION, SENSEVOICE_MODEL, type AsrWeightFile } from "./manifest.ts";
import { registerAsrEndpoint, unregisterAsrEndpoint } from "./adapter-registry.ts";
import { ASR_PROTOCOL } from "./adapter.ts";
import { serveScriptSource } from "./serve-script.ts";
import { verifyAsrWeights } from "./weights.ts";
import type { AsrChild, AsrDeps, AsrHealth, AsrPaths, AsrRunResult } from "./manager.ts";
import { senseVoicePlatform } from "./platform.ts";
import { asrRunnerFamily } from "./runner.ts";

/** 我们自己的数据根目录：`数据目录/local-asr`。 */
export function asrRoot(): string {
	return join(config.dataDir, "local-asr");
}

/** 老布局的默认模型（历史安装落在 `root/weights`、`root/runtime/meta.json`，继续可读）。 */
export const LEGACY_ASR_MODEL_ID = SENSEVOICE_MODEL.id;

/**
 * Per-model 数据目录：**共享 runtime（venv / uv / python / logs）**，**隔离权重与元数据**。
 * 老 SenseVoice 沿用历史布局（`root/weights`、`runtime/meta.json`、`runtime/serve.py`），其余模型落到
 * `root/models/<modelId>/`，互不影响；卸载一个模型不碰共享 runtime 与其它模型权重。
 */
export function asrPaths(modelId?: string): AsrPaths {
	const root = asrRoot();
	const runtime = join(root, "runtime");
	const shared = {
		root,
		env: join(runtime, "env"),
		envStaging: join(runtime, "env.new"),
		envPrev: join(runtime, "env.old"),
		python: join(root, "python"),
		uvCache: join(root, "uv-cache"),
		logs: join(root, "logs"),
		// 一次只跑一个 worker，pid 文件共享
		pidFile: join(runtime, "serve.pid"),
	};
	if (!modelId || modelId === LEGACY_ASR_MODEL_ID) {
		return {
			...shared,
			weights: join(root, "weights"),
			weightsStaging: join(root, "weights.new"),
			metaFile: join(runtime, "meta.json"),
			serve: join(runtime, "serve.py"),
		};
	}
	const dir = join(root, "models", modelId);
	return {
		...shared,
		weights: join(dir, "weights"),
		weightsStaging: join(dir, "weights.new"),
		metaFile: join(dir, "meta.json"),
		serve: join(runtime, `serve-${modelId}.py`),
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
	if (!res.ok) return { ok: false, device: null, loaded: null, modelId: null };
	const j = (await res.json()) as Record<string, unknown>;
	return {
		ok: j.status === "ok" || res.ok,
		device: typeof j.device === "string" ? j.device : "cpu",
		loaded: Array.isArray(j.loaded) ? (j.loaded as string[]) : null,
		modelId: typeof j.modelId === "string" ? j.modelId : null,
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

// ------------------------------------------------------- 固定清单 → HF 直链

/** HF 仓库名：只接受 `org/name` 形态（来自受信 catalog，绝不接受客户端 URL / 绝对路径）。 */
const HF_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** HF revision：只接受 40 位十六进制提交号（分支 / tag / 任意字符串一律拒绝）。 */
const HF_REVISION_RE = /^[a-f0-9]{40}$/;

/**
 * 把固定清单里的一项拼成 HuggingFace `resolve` 直链。repo / revision / 路径都来自受信 catalog，
 * 这里逐段 `encodeURIComponent`（不整串编码，避免把 `/` 也编码掉），并严格拒绝越界路径与非法 revision。
 */
export function hfResolveUrl(endpoint: string, repo: string, revision: string, filePath: string): string {
	if (!HF_REPO_RE.test(repo)) throw new Error(`权重仓库名不合法（只接受 org/name）：${repo}`);
	if (!HF_REVISION_RE.test(revision)) throw new Error(`权重 revision 必须是 40 位十六进制提交号：${revision}`);
	const rel = String(filePath).replace(/\\/g, "/");
	if (!rel || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel) || rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
		throw new Error(`权重文件路径不合法：${filePath}`);
	}
	const base = endpoint.replace(/\/+$/, "");
	const repoSeg = repo.split("/").map(encodeURIComponent).join("/");
	const fileSeg = rel.split("/").map(encodeURIComponent).join("/");
	return `${base}/${repoSeg}/resolve/${revision}/${fileSeg}`;
}

/** venv 内的解释器路径（与 manager 的 envPython 口径一致）。 */
function envPythonOf(env: string): string {
	return process.platform === "win32" ? join(env, "Scripts", "python.exe") : join(env, "bin", "python");
}

/** 引擎依赖内容的摘要：只作为「共享 runtime 是否还是同一套引擎」的标记，不是权重校验。 */
function requirementsSha256(requirements: string): string {
	return createHash("sha256").update(requirements, "utf8").digest("hex");
}

/** 共享 runtime 的引擎标记文件（`runtime/engine.json`）。 */
function engineMarkerFile(root: string): string {
	return join(root, "runtime", "engine.json");
}

/** 生产依赖的可注入点（只给测试 / 镜像用，不改默认行为）。 */
export interface AsrDepsOverrides {
	/** 注入 fetch（测试用本地 HTTP fixture / 镜像代理）；默认全局 fetch。 */
	fetchImpl?: typeof fetch;
	/** HuggingFace 端点（镜像）；默认 `HF_ENDPOINT` 环境变量或 `https://huggingface.co`。 */
	hfEndpoint?: string;
}

export function createAsrDeps(overrides: AsrDepsOverrides = {}): AsrDeps {
	const fetchImpl = overrides.fetchImpl ?? fetch;
	const hfEndpoint = overrides.hfEndpoint ?? process.env.HF_ENDPOINT ?? "https://huggingface.co";
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
		installEngine: async (pythonPath, requirements, opts) => {
			const paths = asrPaths();
			mkdirSync(paths.root, { recursive: true });
			// requirements 只有公开包名 / 版本 / SHA256，不含凭据；留档便于审计。
			const reqFile = join(paths.root, "engine-requirements.txt");
			writeFileSync(reqFile, requirements);
			const r = await new Promise<AsrRunResult>((res, rej) => {
				const child = execFile(
					uvPinnedPath(),
					["pip", "install", "--python", pythonPath, "--require-hashes", "-r", reqFile],
					{ env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv, timeout: 30 * 60_000, signal: opts.signal, maxBuffer: 32 * 1024 * 1024 },
					(err, stdout, stderr) => res({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
				);
				child.on("error", rej);
			});
			if (r.code !== 0) throw new Error(`引擎安装失败（wheel 校验不通过或下载失败）：${r.stderr.slice(0, 300)}`);
		},
		spawnServe: (exe, args, opts) => spawnServe(exe, args, opts.env),
		/**
		 * 按固定清单从**所选模型的** HF 仓库 / revision 逐文件流式下载到该模型的 staging 目录。
		 * 复用统一下载器的 `downloadFile`（Range 续传 / `.part` / 摘要校验 / 原子改名 / 已有缓存跳过），
		 * 不再经 Python `huggingface_hub`（不额外依赖、不跟随仓库里的 allow_patterns 语义、也不写共享 HF 缓存）。
		 * repo / revision / 文件路径全部来自受信 catalog；多文件进度按已完成字节累加。
		 */
		downloadWeights: async (files, p, signal, env, pythonPath, opts) => {
			void env;
			void pythonPath;
			const paths = asrPaths(opts.modelId);
			mkdirSync(paths.weightsStaging, { recursive: true });
			const total = files.reduce((n, f) => n + f.size, 0);
			let done = 0;
			for (const f of files) {
				if (signal.aborted) throw new Error("已取消");
				const rel = String(f.path).replace(/\\/g, "/");
				const dest = join(paths.weightsStaging, ...rel.split("/"));
				await downloadFile(
					{ urls: [hfResolveUrl(hfEndpoint, opts.repo, opts.revision, f.path)], dest, algo: "sha256", digest: f.sha256, size: f.size },
					{ bytes: (got) => p(Math.min(total, done + got), total), detail: () => {} },
					{ fetchImpl, signal },
				);
				done += f.size;
				p(Math.min(total, done), total);
			}
		},
		verifyWeights: async (files, signal, opts) => {
			if (signal.aborted) throw new Error("已取消");
			const paths = asrPaths(opts?.modelId);
			const res = await verifyAsrWeights(paths.weightsStaging, files, { signal, assertManifest: opts?.assertManifest });
			if (!res.ok) throw new Error(`权重校验未通过：${res.problems.slice(0, 3).join("；")}`);
		},
		importWeights: async (sourceDir, files, signal, modelId) => {
			const safe = assertSafeImportDir(sourceDir);
			return copyManifestFiles(safe, asrPaths(modelId).weightsStaging, files, signal);
		},
		/** 共享 runtime 已装同一套引擎（依赖摘要一致 + 解释器在 + 真能 `import sherpa_onnx`）才复用。 */
		engineReady: async (paths, requirements) => {
			try {
				if (!existsSync(paths.env) || !existsSync(envPythonOf(paths.env))) return false;
				const rec = JSON.parse(readFileSync(engineMarkerFile(paths.root), "utf8")) as { requirementsSha256?: string; python?: string };
				if (rec.requirementsSha256 !== requirementsSha256(requirements)) return false;
				if (rec.python !== ASR_PYTHON_VERSION) return false;
			} catch {
				return false;
			}
			const res = await execFileQuiet(envPythonOf(paths.env), ["-c", "import sherpa_onnx"], 60_000);
			return res.code === 0;
		},
		findFreePort,
		health: readHealth,
		randomToken: () => randomBytes(32).toString("hex"),
		paths: (modelId?: string) => asrPaths(modelId),
		registerAsr: (info) => {
			registerAsrEndpoint({
				provider: info.provider,
				modelId: info.modelId,
				protocol: info.protocol,
				baseUrl: info.baseUrl,
				token: info.token,
				sampleRate: info.sampleRate,
				languages: info.languages ?? [],
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
		isInstalled: (modelId?: string) => {
			const p = asrPaths(modelId);
			return existsSync(p.env) && existsSync(p.weights) && existsSync(p.metaFile);
		},
		log: (line) => appendLog(asrPaths(), line),
		activate: async (paths, meta) => {
			mkdirSync(join(paths.root, "runtime"), { recursive: true });
			// 权重：staging → weights（旧目录保留为备份，成功后删）
			const weightsPrev = `${paths.weights}.old`;
			if (existsSync(weightsPrev)) rmSync(weightsPrev, { recursive: true, force: true });
			if (existsSync(paths.weights)) renameSync(paths.weights, weightsPrev);
			renameSync(paths.weightsStaging, paths.weights);
			// venv：staging → env。复用共享引擎时本次不重建 staging（engineReady），这里跳过切换，
			// 否则会把已生效的共享 venv 换成一个不存在的目录（并连带影响其它模型）。
			if (existsSync(paths.envStaging)) {
				if (existsSync(paths.envPrev)) rmSync(paths.envPrev, { recursive: true, force: true });
				if (existsSync(paths.env)) renameSync(paths.env, paths.envPrev);
				renameSync(paths.envStaging, paths.env);
			}
			// 引擎标记：记录共享 venv 对应的依赖摘要，供下次安装安全复用（不是权重校验）。
			writeFileSync(engineMarkerFile(paths.root), JSON.stringify({ requirementsSha256: requirementsSha256(meta.engineRequirements), python: ASR_PYTHON_VERSION, engineVersion: meta.engineVersion, installedAt: Date.now() }, null, 2));
			writeFileSync(paths.metaFile, JSON.stringify({ installedAt: Date.now(), ...meta }, null, 2));
			const family = asrRunnerFamily(meta.runner);
			writeFileSync(paths.serve ?? join(paths.root, "serve.py"), family.serveScript({ roles: meta.fileRoles, sampleRate: meta.sampleRate, maxAudioBytes: meta.maxAudioBytes }));
			rmSync(weightsPrev, { recursive: true, force: true });
		},
		rollback: async (paths) => {
			rmSync(paths.envStaging, { recursive: true, force: true });
			rmSync(paths.weightsStaging, { recursive: true, force: true });
			if (!existsSync(paths.env) && existsSync(paths.envPrev)) renameSync(paths.envPrev, paths.env);
			const weightsPrev = `${paths.weights}.old`;
			if (!existsSync(paths.weights) && existsSync(weightsPrev)) renameSync(weightsPrev, paths.weights);
		},
		uninstall: async (paths, modelId) => {
			const expected = resolve(asrRoot());
			if (resolve(paths.root) !== expected) throw new Error("卸载路径不在本地 ASR 目录下，已拒绝");
			// 只删该模型的权重 / staging / 元数据 / 专属 serve 脚本；共享 runtime（venv / uv / python）
			// 与其它模型的权重一律保留（用户要求：卸载 model 不卸 shared runtime / 其它 weights）。
			rmSync(paths.weights, { recursive: true, force: true });
			rmSync(paths.weightsStaging, { recursive: true, force: true });
			rmSync(`${paths.weights}.old`, { recursive: true, force: true });
			rmSync(paths.metaFile, { force: true });
			rmSync(paths.serve ?? join(paths.root, "serve.py"), { force: true });
			if (modelId && modelId !== LEGACY_ASR_MODEL_ID) {
				const dir = resolve(join(asrRoot(), "models", modelId));
				if (dir.startsWith(expected + sep)) {
					try {
						if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
					} catch {
						/* 目录已不在 */
					}
				}
			}
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
