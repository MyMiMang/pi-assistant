/**
 * 本地 SenseVoice ASR 的生命周期管理（纯状态机 + 可注入依赖，可单测）。
 *
 * 职责边界（与 local-laya 一致，复用同一套骨架思路）：
 *  - 只管**我们自己的**独立数据目录 / 独立 venv / 独立权重目录；不装系统 Python、不动用户文件、不装驱动。
 *  - 安装 / 启动由**显式按钮**触发；**许可门槛不通过就不安装**（见 license.ts）。
 *  - 安全不变量：只绑 127.0.0.1；token 只在进程内 + 子进程环境，绝不回显 API / 日志 / 前端；
 *    只 kill 自己 spawn 的 pid；卸载只删 own 目录且需显式确认。
 *  - 资源策略（用户要求）：**按需加载**，不录音时默认短 idle TTL（默认 90s，可配 0=立即释放）；
 *    idle 截止时间从「最后一次推理结束 / 录音租约释放」起算；**正在推理或有排队请求时绝不 kill**；
 *    新请求重置截止时间；卸载只释放进程与 CPU/RAM，**保留磁盘权重**。
 *
 * 测试：注入 fake deps（含可驱动的时钟），绝不真正下载 GB 权重 / 起真实 sidecar。
 */
import type { AsrPlatformProfile } from "./platform.ts";
import { capThreads } from "./platform.ts";
import type { AsrLicenseMeta, AsrModelManifest, AsrSourceMeta, AsrWeightFile } from "./manifest.ts";
import { ASR_BIND_HOST, ASR_DEFAULT_IDLE_SECONDS, ASR_MAX_AUDIO_BYTES, ASR_MAX_IDLE_SECONDS, ASR_MIN_IDLE_SECONDS, sherpaRequirements } from "./manifest.ts";
import type { PinnedFile } from "../managed-weights/verify.ts";
import { importGate, installGate, licenseDisclosure, type LicenseDisclosure } from "./license.ts";
import { asrRunnerFamily, runnerRolesOf } from "./runner.ts";

export type AsrInstallState = "not_installed" | "installing" | "installed" | "failed";
export type AsrInstallPhase = "idle" | "preflight" | "uv" | "venv" | "engine" | "weights" | "verify" | "activate" | "rollback" | "done";
export type AsrRuntimeState = "stopped" | "starting" | "running" | "stopping" | "crashed" | "paused";
/** 安装来源：官方源下载 / 用户自行导入 */
export type AsrInstallSource = "download" | "import";

export interface AsrHealth {
	ok: boolean;
	/** 实测设备（只可能是 cpu） */
	device: string | null;
	/** 已加载模型 id 列表 */
	loaded: string[] | null;
	/** sidecar 实际加载的模型 id（证明选对模型；旧脚本 / 未注册时为 null） */
	modelId?: string | null;
}

export interface AsrPaths {
	root: string;
	env: string;
	envStaging: string;
	envPrev: string;
	python: string;
	uvCache: string;
	/** 权重目录（**我们自己的**，非 HF 共享缓存） */
	weights: string;
	weightsStaging: string;
	logs: string;
	pidFile: string;
	metaFile: string;
	/** 生成的 sidecar 脚本路径（per-model）；旧测试可省略（回退 `root/serve.py`） */
	serve?: string;
}

export interface AsrRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface AsrChild {
	pid: number | undefined;
	kill(signal?: NodeJS.Signals): boolean;
	onExit(cb: (code: number | null) => void): void;
}

/** 可注入的定时器句柄（测试用假时钟）。 */
export interface AsrTimer {
	cancel(): void;
}

export interface AsrDeps {
	profile(): AsrPlatformProfile;
	physicalCores(): number | null;
	logicalCores(): number | null;
	ensureUv(): Promise<string>;
	uvPath(): string;
	pythonVersion(): string;
	/** 按固定摘要安装引擎 wheel（`--require-hashes`）；平台无摘要时调用方已拒绝，这里不接受未校验的安装。 */
	installEngine(pythonPath: string, requirements: string, opts: { env: Record<string, string>; signal?: AbortSignal }): Promise<void>;
	/**
	 * 共享 runtime 里是否已装好**同一套**引擎（依赖摘要一致 + 解释器在 + 能 `import sherpa_onnx`），
	 * 可以安全复用而不用重建 venv / 重下 ~200MB wheel。不实现（或返回 false）则每次都重建，行为保守。
	 */
	engineReady?(paths: AsrPaths, requirements: string): Promise<boolean>;
	run(cmd: string, args: string[], opts: { env: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }): Promise<AsrRunResult>;
	spawnServe(exe: string, args: string[], opts: { env: Record<string, string> }): AsrChild;
	/** 从**官方源**按固定清单下载权重（清单外文件一律不取）；`pythonPath` = staging venv 解释器 */
	downloadWeights(files: AsrWeightFile[], p: (received: number, total: number | null) => void, signal: AbortSignal, env: Record<string, string>, pythonPath: string, opts: { repo: string; revision: string; modelId: string }): Promise<void>;
	/** 下载完成后按固定清单校验（大小 + SHA256 + 路径安全 + 运行族规则），不通过绝不 activate */
	verifyWeights(files: AsrWeightFile[], signal: AbortSignal, opts?: { assertManifest?: (files: PinnedFile[]) => string[]; modelId?: string }): Promise<void>;
	/** 用户自行导入：canonical 校验 + 只从给定目录复制清单内文件到 staging（不读敏感文件） */
	importWeights(sourceDir: string, files: AsrWeightFile[], signal: AbortSignal, modelId?: string): Promise<{ copied: number; bytes: number }>;
	findFreePort(): Promise<number>;
	health(port: number, token: string, signal?: AbortSignal): Promise<AsrHealth>;
	activate(paths: AsrPaths, meta: { source: AsrInstallSource; engineVersion: string; revision: string; modelId: string; runner: string; fileRoles: Record<string, string>; sampleRate: number; maxAudioBytes: number; engineRequirements: string }): Promise<void>;
	rollback(paths: AsrPaths): Promise<void>;
	uninstall(paths: AsrPaths, modelId?: string): Promise<void>;
	randomToken(): string;
	paths(modelId?: string): AsrPaths;
		registerAsr(info: { provider: string; modelId: string; protocol: string; baseUrl: string; token: string; sampleRate: number; languages?: string[] }): void;
	unregisterAsr(provider: string): void;
	recordPid(pid: number | null): void;
	now(): number;
	setTimer(fn: () => void, ms: number): AsrTimer;
	isInstalled(modelId?: string): boolean;
	log(line: string): void;
}

export interface AsrStatus {
	platform: AsrPlatformProfile;
	license: LicenseDisclosure;
	install: { state: AsrInstallState; phase: AsrInstallPhase; received: number; total: number | null; error: string | null; installedAt: number | null; source: AsrInstallSource | null };
	runtime: { state: AsrRuntimeState; pid: number | null; port: number | null; host: string; restarts: number; lastError: string | null };
	health: AsrHealth | null;
	configured: boolean;
	registered: { provider: string; modelId: string; protocol: string } | null;
	idle: { seconds: number; lastActiveAt: number | null; active: number; leases: number; unloads: number; paused: boolean };
	source: AsrSourceMeta;
	model: { id: string; bytes: number; sampleRate: number; channels: number; languages: string[]; punctuation: boolean; threadCap: number };
	/** 明确的边界声明（界面「?」显示）：未在本机实测，不给性能承诺 */
	notes: string[];
}

export interface AsrRegisterIds {
	provider: string;
	modelId: string;
	protocol: string;
}

/** 安装请求参数。 */
export interface AsrInstallOptions {
	source: AsrInstallSource;
	acceptLicense?: string | null;
	/** source=import 时的用户目录（canonical 校验在 deps 内做） */
	importDir?: string;
	signal?: AbortSignal;
}

/** 推理租约：adapter 用 beginInference() 拿到，end() 时释放（必须 finally 调用）。 */
export interface InferenceLease {
	signal: AbortSignal;
	end(): void;
}

const MAX_BACKOFF_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 5;
/** 启动后等 sidecar 把模型 load 完的预算（大模型可达数十秒；子进程退出会提前返回）。 */
const HEALTH_LOAD_BUDGET_MS = 90_000;

interface RuntimeState {
	state: AsrRuntimeState;
	pid: number | null;
	port: number | null;
	token: string | null;
	child: AsrChild | null;
	health: AsrHealth | null;
	restarts: number;
	lastError: string | null;
	/** 连续启动失败次数（用于有界退避；成功启动清零） */
	failures: number;
	/** 退避截止时间（now 之前不允许再 start） */
	nextStartAt: number;
}

export class LocalAsrManager {
	private deps: AsrDeps;
	private source: AsrSourceMeta;
	private license: AsrLicenseMeta;
	private model: AsrModelManifest;
	private ids: AsrRegisterIds;
	private onChange: () => void;
	private platform: AsrPlatformProfile;
	private installInfo: AsrStatus["install"];
	private runtime: RuntimeState;
	private abort: AbortController | null = null;
	private threadCap: number;

	// ---- 空闲 / 并发状态 ----
	private idleSeconds: number;
	private lastActiveAt: number | null = null;
	private active = 0;
	private leases = 0;
	private idleTimer: AsrTimer | null = null;
	private activeControllers = new Set<AbortController>();
	private unloads = 0;
	private paused = false;

	constructor(
		deps: AsrDeps,
		cfg: { source: AsrSourceMeta; license: AsrLicenseMeta; model: AsrModelManifest; ids: AsrRegisterIds; idleSeconds?: number },
		onChange: () => void = () => {},
	) {
		this.deps = deps;
		this.source = cfg.source;
		this.license = cfg.license;
		this.model = cfg.model;
		this.ids = cfg.ids;
		this.onChange = onChange;
		this.idleSeconds = clampIdle(cfg.idleSeconds ?? ASR_DEFAULT_IDLE_SECONDS);
		this.platform = deps.profile();
		this.threadCap = capThreads(deps.physicalCores(), { logicalCores: deps.logicalCores() });
		this.installInfo = deps.isInstalled(cfg.model.id)
			? { state: "installed", phase: "done", received: 0, total: null, error: null, installedAt: deps.now(), source: null }
			: { state: "not_installed", phase: "idle", received: 0, total: null, error: null, installedAt: null, source: null };
		this.runtime = { state: "stopped", pid: null, port: null, token: null, child: null, health: null, restarts: 0, lastError: null, failures: 0, nextStartAt: 0 };
	}

	/** 该模型的数据目录（per-model 权重 / 共享 runtime）。 */
	modelId(): string {
		return this.model.id;
	}

	// ---------------------------------------------------------------- status

	status(): AsrStatus {
		return {
			platform: this.platform,
			license: licenseDisclosure(this.license),
			install: { ...this.installInfo },
			runtime: {
				state: this.runtime.state,
				pid: this.runtime.pid,
				port: this.runtime.port,
				host: ASR_BIND_HOST,
				restarts: this.runtime.restarts,
				lastError: this.runtime.lastError,
			},
			health: this.runtime.health,
			configured: this.installInfo.state === "installed",
			registered: this.runtime.token ? { provider: this.ids.provider, modelId: this.ids.modelId, protocol: this.ids.protocol } : null,
			idle: { seconds: this.idleSeconds, lastActiveAt: this.lastActiveAt, active: this.active, leases: this.leases, unloads: this.unloads, paused: this.paused },
			source: this.source,
			model: {
				id: this.model.id,
				bytes: this.model.bytes,
				sampleRate: this.model.sampleRate,
				channels: this.model.channels,
				languages: [...this.model.languages],
				punctuation: this.model.punctuation,
				threadCap: this.threadCap,
			},
			notes: [
				"本机未实测：冷启动 / RTF / 峰值内存均无本机数据，不给性能承诺",
				"CPU 推理；未启用 MPS / CoreML（上游未证 SenseVoice 的 GPU 加速）",
				"卸载只释放进程与 CPU/RAM，磁盘权重保留",
			],
		};
	}

	/** 平台意图刷新（用户切换设置时）。 */
	refreshPlatform(): AsrPlatformProfile {
		this.platform = this.deps.profile();
		this.threadCap = capThreads(this.deps.physicalCores(), { logicalCores: this.deps.logicalCores() });
		this.onChange();
		return this.platform;
	}

	/** 空闲 TTL 设置（0 = 每次推理后立即释放）。 */
	setIdleSeconds(seconds: number): number {
		this.idleSeconds = clampIdle(seconds);
		this.rescheduleIdle();
		this.onChange();
		return this.idleSeconds;
	}

	private set(phase: AsrInstallPhase, extra: Partial<AsrStatus["install"]> = {}) {
		this.installInfo = { ...this.installInfo, phase, ...extra };
		this.onChange();
	}

	// --------------------------------------------------------------- install

	/**
	 * 同步预检：许可门槛 + 平台 + 导入参数 + 是否已在安装中。
	 * 供路由在**返回 400 之前**判断（异步 install() 的抛错会变成 rejected promise，不能用来选 HTTP 状态码）。
	 */
	precheck(opts: AsrInstallOptions): { ok: true } | { ok: false; error: string } {
		if (this.installInfo.state === "installing") return { ok: false, error: "安装已在进行中" };
		const gate = opts.source === "import" ? importGate(this.license) : installGate(this.license, opts.acceptLicense);
		if (!gate.allowed) return { ok: false, error: gate.reason ?? "许可门槛未通过" };
		if (opts.source === "import" && !opts.importDir) return { ok: false, error: "导入需要提供权重目录" };
		if (this.platform.support === "unsupported") return { ok: false, error: this.platform.reason };
		// 运行族必须已实现，且 fileRoles 齐全（fail closed，绝不用未实现的 runner 冒充）
		try {
			const family = asrRunnerFamily(this.model.runner ?? "sensevoice");
			const roles = runnerRolesOf(this.model, family);
			if (!roles.ok) return { ok: false, error: roles.reason };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		return { ok: true };
	}

	/**
	 * 安装：许可门槛 → uv → staging venv → 引擎 → 权重（下载或导入）→ 校验 → 原子 activate。
	 * 失败 / 取消：清理 staging，回滚旧环境，state=failed 且 error 已脱敏；**不产生半安装 ready**。
	 */
	async install(opts: AsrInstallOptions): Promise<AsrStatus> {
		const pre = this.precheck(opts);
		if (!pre.ok) throw new Error(pre.error);
		// 外部 signal（网 / 服务协调器）与本地 cancel 都汇到 self；manager.cancel() 才能取消外部受控的安装。
		const self = new AbortController();
		this.abort = self;
		const ext = opts.signal;
		if (ext) {
			if (ext.aborted) self.abort();
			else ext.addEventListener("abort", () => self.abort(), { once: true });
		}
		const signal = self.signal;
		this.set("preflight", { state: "installing", error: null, received: 0, total: null, source: opts.source });
		try {
			this.set("uv");
			await this.deps.ensureUv();
			const paths = this.deps.paths(this.model.id);
			const env = this.baseEnv(paths);
			// 只装 pinned 版本，且必须带官方 wheel SHA256（--require-hashes）；无固定摘要的平台 fail closed，不暗装。
			const req = sherpaRequirements(this.platform.key);
			if (!req.ok) throw new Error(req.reason);
			// 共享 runtime：引擎已装同一套且能加载就复用，不每次重下 ~200MB；不可复用才重建 staging venv。
			const reuseEngine = (await this.deps.engineReady?.(paths, req.content)) ?? false;
			if (!reuseEngine) {
				this.set("venv");
				await this.step(signal, () => this.runOrThrow(this.deps.uvPath(), ["venv", "--python", this.deps.pythonVersion(), paths.envStaging], { env, signal }));
				this.set("engine");
				await this.step(signal, () => this.deps.installEngine(this.envPython(paths.envStaging), req.content, { env, signal }));
			}
			this.set("weights");
			if (opts.source === "import") {
				const res = await this.deps.importWeights(String(opts.importDir), this.model.files, signal, this.model.id);
				this.set("weights", { received: res.bytes, total: this.model.bytes });
			} else {
				await this.deps.downloadWeights(
					this.model.files,
					(received, total) => this.set("weights", { received, total }),
					signal,
					env,
					this.envPython(paths.envStaging),
					{ repo: this.model.repo, revision: this.model.revision, modelId: this.model.id },
				);
			}
			this.set("verify");
			const runner = asrRunnerFamily(this.model.runner ?? "sensevoice");
			await this.step(signal, () => this.deps.verifyWeights(this.model.files, signal, { assertManifest: runner.assertWeights, modelId: this.model.id }));
			if (signal.aborted) throw new Error("已取消");
			this.set("activate");
			await this.deps.activate(paths, {
				source: opts.source,
				engineVersion: this.source.engineVersion,
				revision: this.model.revision,
				modelId: this.model.id,
				runner: this.model.runner ?? "sensevoice",
				fileRoles: this.model.fileRoles ?? {},
				sampleRate: this.model.sampleRate,
				maxAudioBytes: ASR_MAX_AUDIO_BYTES,
				engineRequirements: req.content,
			});
			this.installInfo = { state: "installed", phase: "done", received: this.installInfo.received, total: this.installInfo.total, error: null, installedAt: this.deps.now(), source: opts.source };
			this.onChange();
			return this.status();
		} catch (e) {
			const cancelled = signal.aborted;
			await this.deps.rollback(this.deps.paths(this.model.id)).catch(() => {});
			this.installInfo = {
				state: cancelled ? "not_installed" : "failed",
				phase: cancelled ? "idle" : "rollback",
				received: 0,
				total: null,
				error: cancelled ? null : sanitizeError(e),
				installedAt: this.deps.isInstalled() ? this.installInfo.installedAt : null,
				source: null,
			};
			this.onChange();
			if (cancelled) throw new Error("已取消");
			throw e;
		} finally {
			this.abort = null;
		}
	}

	/** 取消进行中的安装 / 下载（取消后由 install() 的 catch 负责回滚）。 */
	cancel(): { ok: boolean } {
		if (this.installInfo.state !== "installing" || !this.abort) return { ok: false };
		this.abort.abort();
		this.onChange();
		return { ok: true };
	}

	/** 更新：重跑安装到 staging 并原子切换（失败回滚旧环境）。 */
	async update(opts: { acceptLicense?: string | null } = {}): Promise<AsrStatus> {
		return this.install({ source: "download", acceptLicense: opts.acceptLicense });
	}

	/**
	 * 卸载：需显式确认。运行中先停；只删 own 目录（canonical 校验在 deps.uninstall 内）。
	 */
	async uninstall(confirm: boolean): Promise<AsrStatus> {
		if (!confirm) throw new Error("卸载需要显式确认");
		if (this.runtime.state !== "stopped") await this.stop();
		await this.deps.uninstall(this.deps.paths(this.model.id), this.model.id);
		this.installInfo = { state: "not_installed", phase: "idle", received: 0, total: null, error: null, installedAt: null, source: null };
		this.platform = this.deps.profile();
		this.onChange();
		return this.status();
	}

	// --------------------------------------------------------------- runtime

	/** 启动 sidecar：随机空闲端口 + 每次新 token；只绑 127.0.0.1；失败按有界退避，不无限重启。 */
	async start(opts: { force?: boolean } = {}): Promise<AsrStatus> {
		if (this.installInfo.state !== "installed") throw new Error("还没安装完成");
		if (this.paused && !opts.force) throw new Error("已暂停（自动重启已停止），请先恢复");
		if (this.runtime.state === "running" || this.runtime.state === "starting") return this.status();
		if (!opts.force && this.runtime.failures >= MAX_CONSECUTIVE_FAILURES) {
			this.paused = true;
			this.runtime.state = "paused";
			this.runtime.lastError = "连续启动失败次数过多，已暂停自动重启";
			this.onChange();
			throw new Error("连续启动失败次数过多，已暂停自动重启（请手动恢复）");
		}
		if (!opts.force && this.deps.now() < this.runtime.nextStartAt) {
			const waitMs = this.runtime.nextStartAt - this.deps.now();
			throw new Error(`启动退避中，请 ${Math.ceil(waitMs / 1000)} 秒后再试`);
		}
		const paths = this.deps.paths(this.model.id);
		this.runtime.state = "starting";
		this.onChange();
		try {
			const port = await this.deps.findFreePort();
			const token = this.deps.randomToken();
			const env = { ...this.baseEnv(paths), ASR_HOST: ASR_BIND_HOST, ASR_PORT: String(port), ASR_TOKEN: token, ASR_THREADS: String(this.threadCap), ASR_IDLE_SECONDS: String(this.idleSeconds), ASR_WEIGHTS: paths.weights, ASR_MODEL_ID: this.model.id };
			const child = this.deps.spawnServe(this.envBin(paths.env, "python"), [this.entryScript(paths)], { env });
			this.runtime = { ...this.runtime, state: "running", pid: child.pid ?? null, port, token, child, health: null, lastError: null, failures: 0, nextStartAt: 0 };
			this.deps.recordPid(child.pid ?? null);
			this.deps.registerAsr({
				provider: this.ids.provider,
				modelId: this.ids.modelId,
				protocol: this.ids.protocol,
				baseUrl: `http://${ASR_BIND_HOST}:${port}/v1/`,
				token,
				sampleRate: this.model.sampleRate,
				languages: [...this.model.languages],
			});
			child.onExit((code) => {
				if (this.runtime.child !== child) return;
				// sidecar 意外退出必须撤销注册，否则注册表里会留一个指向死端口的本地服务。
				this.deps.unregisterAsr(this.ids.provider);
				this.deps.recordPid(null);
				this.runtime = { ...this.runtime, state: "crashed", pid: null, child: null, token: null, health: null, lastError: `sidecar 退出（code ${code ?? "null"}）` };
				this.onChange();
			});
			this.runtime.health = await this.probeHealth(port, token, child);
			if (!this.runtime.health.ok) {
				this.runtime.failures += 1;
				this.runtime.restarts += 1;
				this.runtime.nextStartAt = this.deps.now() + backoffMs(this.runtime.failures);
				if (this.runtime.failures >= MAX_CONSECUTIVE_FAILURES) {
					this.paused = true;
					this.runtime.state = "paused";
					this.runtime.lastError = "连续启动失败次数过多，已暂停自动重启";
				}
			}
			// 启动成功就开始计时（TTL>0 时）；TTL=0 不在启动时就释放，而是等一次推理 / 录音结束后再释放。
			this.lastActiveAt = this.deps.now();
			this.rescheduleIdle();
			this.onChange();
			return this.status();
		} catch (e) {
			this.runtime.failures += 1;
			this.runtime.restarts += 1;
			this.runtime.state = "crashed";
			this.runtime.lastError = sanitizeError(e);
			this.runtime.nextStartAt = this.deps.now() + backoffMs(this.runtime.failures);
			if (this.runtime.failures >= MAX_CONSECUTIVE_FAILURES) {
				this.paused = true;
				this.runtime.state = "paused";
				this.runtime.lastError = "连续启动失败次数过多，已暂停自动重启";
			}
			this.onChange();
			throw e;
		}
	}

	/**
	 * 停止 / 释放：abort 进行中的推理（明确的 stop-active-abort），kill 只 kill 自己的 child，
	 * **保留磁盘权重**。`reason` 只用于日志与状态，不影响行为。
	 */
	async stop(reason = "manual"): Promise<AsrStatus> {
		this.cancelIdle();
		this.abortActive();
		const child = this.runtime.child;
		if (child) {
			this.runtime.state = "stopping";
			this.onChange();
			try {
				child.kill("SIGTERM");
			} catch {
				/* 已退出 */
			}
		}
		this.deps.unregisterAsr(this.ids.provider);
		this.deps.recordPid(null);
		this.runtime = { ...this.runtime, state: this.paused ? "paused" : "stopped", pid: null, port: null, token: null, child: null, health: null };
		this.deps.log(`asr stop（${reason}）`);
		this.onChange();
		return this.status();
	}

	/** 暂停：停止 + 不再自动重启（用户可 resume）。 */
	async pause(): Promise<AsrStatus> {
		this.paused = true;
		if (this.runtime.state !== "stopped" && this.runtime.state !== "paused") await this.stop("pause");
		else this.runtime.state = "paused";
		this.onChange();
		return this.status();
	}

	/** 恢复：清掉退避与失败计数。 */
	async resume(): Promise<AsrStatus> {
		this.paused = false;
		this.runtime.failures = 0;
		this.runtime.nextStartAt = 0;
		if (this.runtime.state === "paused") this.runtime.state = "stopped";
		this.onChange();
		return this.status();
	}

	/**
	 * 启动后 /health 要等模型真正 load 完（大模型可能几十秒）——按**截止时间**轮询，
	 * 子进程一退出就提前返回，不用固定重试次数把「加载慢」误判成「不健康」。
	 */
	private async probeHealth(port: number, token: string, child: AsrChild, budgetMs = HEALTH_LOAD_BUDGET_MS): Promise<AsrHealth> {
		let last: AsrHealth = { ok: false, device: null, loaded: null };
		const deadline = this.deps.now() + budgetMs;
		for (;;) {
			try {
				last = await this.deps.health(port, token);
				if (last.ok) return last;
			} catch {
				/* 还没起来：继续等 */
			}
			if (this.runtime.child !== child) return last; // sidecar 已退出，没有可等的
			if (this.deps.now() >= deadline) return last;
			await new Promise<void>((resolve) => this.deps.setTimer(() => resolve(), 250));
		}
	}

	// ---------------------------------------------------- inference / idle

	/**
	 * 开始一次推理（adapter 调）。返回的 `end()` 必须 finally 调用。
	 * 新请求会重置 idle 截止时间；有活跃推理时 idle 定时器不会触发卸载。
	 */
	beginInference(): InferenceLease {
		if (this.runtime.state !== "running") throw new Error("本地 ASR 未运行");
		this.active += 1;
		this.cancelIdle();
		const ctrl = new AbortController();
		this.activeControllers.add(ctrl);
		let ended = false;
		return {
			signal: ctrl.signal,
			end: () => {
				if (ended) return;
				ended = true;
				this.activeControllers.delete(ctrl);
				this.active = Math.max(0, this.active - 1);
				this.noteActive();
			},
		};
	}

	/** 录音租约（用户按麦到松开 / 上传结束）。持有期间绝不卸载模型。 */
	acquireRecording(): { release(): void } {
		this.leases += 1;
		this.cancelIdle();
		this.onChange();
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.leases = Math.max(0, this.leases - 1);
				this.noteActive();
				this.onChange();
			},
		};
	}

	/** 记录一次活动并重排 idle 定时器。TTL=0 时，等这次活动结束就立即释放（启动时不触发）。 */
	noteActive(): void {
		this.lastActiveAt = this.deps.now();
		if (this.idleSeconds <= 0) {
			if (this.active === 0 && this.leases === 0 && this.runtime.state === "running") void this.unloadNow().catch(() => {});
			return;
		}
		this.rescheduleIdle();
	}

	/** 中止进行中的推理（stop / 卸载时调用），不改变状态机。 */
	abortActive(): void {
		for (const c of this.activeControllers) {
			try {
				c.abort();
			} catch {
				/* 已中止 */
			}
		}
		this.activeControllers.clear();
	}

	/** 立即释放（用户点「立即释放」或 idleSeconds=0）。保留磁盘权重。 */
	async unloadNow(): Promise<AsrStatus> {
		if (this.active > 0 || this.leases > 0) throw new Error("正在录音或有未完成请求，暂不释放");
		this.unloads += 1;
		return this.stop("idle-unload");
	}

	private rescheduleIdle() {
		this.cancelIdle();
		if (this.idleSeconds <= 0) return; // TTL=0：只在活动结束时立即释放（见 noteActive）
		if (this.active > 0 || this.leases > 0) return; // 忙时不排定时器
		this.idleTimer = this.deps.setTimer(() => this.idleCheck(), this.idleSeconds * 1000);
	}

	private idleCheck() {
		this.idleTimer = null;
		// 正在推理 / 有排队（active）或正在录音（leases）→ 绝不 kill；等结束后 noteActive 重排。
		if (this.active > 0 || this.leases > 0) return;
		if (this.runtime.state !== "running") return;
		const since = this.lastActiveAt == null ? Number.POSITIVE_INFINITY : this.deps.now() - this.lastActiveAt;
		if (since >= this.idleSeconds * 1000) {
			this.unloads += 1;
			void this.stop("idle-unload").catch(() => {});
		} else {
			this.idleTimer = this.deps.setTimer(() => this.idleCheck(), Math.max(50, this.idleSeconds * 1000 - since));
		}
	}

	private cancelIdle() {
		if (this.idleTimer) {
			try {
				this.idleTimer.cancel();
			} catch {
				/* 已取消 */
			}
			this.idleTimer = null;
		}
	}

	// ---------------------------------------------------------------- helpers

	private async step(signal: AbortSignal, fn: () => Promise<unknown>) {
		if (signal.aborted) throw new Error("已取消");
		await fn();
	}
	private async runOrThrow(cmd: string, args: string[], opts: { env: Record<string, string>; signal?: AbortSignal }): Promise<void> {
		const res = await this.deps.run(cmd, args, opts);
		if (res.code !== 0) throw new Error(sanitizeError(res.stderr || `命令失败（退出码 ${res.code}）：${args.join(" ")}`));
	}
	private baseEnv(paths: AsrPaths): Record<string, string> {
		return {
			HOME: paths.root,
			UV_CACHE_DIR: paths.uvCache,
			UV_PYTHON_INSTALL_DIR: paths.python,
			PYTHONNOUSERSITE: "1",
			PIP_DISABLE_PIP_VERSION_CHECK: "1",
			PYTHONPATH: "",
			VIRTUAL_ENV: "",
		};
	}
	private envPython(env: string): string {
		return this.envBin(env, process.platform === "win32" ? "python.exe" : "python");
	}
	private envBin(env: string, name: string): string {
		return process.platform === "win32" ? `${env}\\Scripts\\${name}` : `${env}/bin/${name}`;
	}
	private entryScript(paths: AsrPaths): string {
		return paths.serve ?? `${paths.root}/serve.py`;
	}
}

function clampIdle(n: number): number {
	if (!Number.isFinite(n)) return ASR_DEFAULT_IDLE_SECONDS;
	return Math.max(ASR_MIN_IDLE_SECONDS, Math.min(ASR_MAX_IDLE_SECONDS, Math.floor(n)));
}

/** 有界指数退避：1s、2s、4s… 封顶 30s。 */
export function backoffMs(failures: number): number {
	const n = Math.max(1, failures);
	return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (n - 1));
}

/** 错误脱敏：去掉可能的 token（Bearer …）与长十六进制串，绝不把密钥写进状态 / 日志。 */
export function sanitizeError(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	const noToken = raw.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***").replace(/\b[a-f0-9]{32,}\b/gi, "***");
	return noToken.slice(0, 400);
}
