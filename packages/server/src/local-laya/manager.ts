/**
 * 本地 Laya 一键安装 / 生命周期管理（纯逻辑 + 可注入依赖）。
 *
 * 职责边界：
 *  - 只管**我们自己的**独立数据目录、独立 venv、独立 checkpoint 缓存；不装到系统 Python、不强制 Docker/VM。
 *  - 安装/启动由产品层的显式按钮触发（`install()` / `start()`），**不借「完整权限」自动装任何硬件驱动**。
 *  - 安全不变量：只绑 127.0.0.1；运行时 token 只存在于进程内 + 子进程环境，绝不回显到 API / 日志 / 前端；
 *    只管理自己 spawn 的 pid，绝不 kill 任意用户进程；卸载只删 own 目录，且要显式确认。
 *
 * 测试：注入 fake deps，绝不真正下载 GB 依赖 / 起真实 Laya / 占 GPU。
 */
import type { NvidiaProbe, PlatformContext, PlatformProfile } from "./platform.ts";
import { availableParallelism } from "node:os";
import type { LayaCheckpoint, LayaSourceMeta } from "./manifest.ts";

export type LayaInstallState = "not_installed" | "installing" | "installed" | "failed";
export type LayaInstallPhase =
	| "idle"
	| "preflight"
	| "uv"
	| "venv"
	| "torch"
	| "laya"
	| "weights"
	| "verify"
	| "activate"
	| "rollback"
	| "done";
export type LayaRuntimeState = "stopped" | "starting" | "running" | "stopping" | "crashed";

export interface LayaHealth {
	ok: boolean;
	device: string | null;
	checkpointDevices: Record<string, string> | null;
	cpuFallbacks: { count: number; lastReason: string | null } | null;
	revisions: Record<string, string> | null;
	loaded: string[] | null;
}

export interface LayaPaths {
	/** 数据目录/local-laya */
	root: string;
	/** 当前生效的 venv（原子切换的 target） */
	env: string;
	/** 安装中的 staging venv */
	envStaging: string;
	/** 上一个可用 venv（回滚用） */
	envPrev: string;
	/** Python 运行时（uv 托管，不装系统 Python） */
	python: string;
	/** uv 缓存 */
	uvCache: string;
	/** HuggingFace 缓存（权重，断点续传） */
	hfHome: string;
	/** 运行日志 */
	logs: string;
	/** 我们自己的 pid 文件（含安装时随机 token，用于确认「这个 pid 是我们的」） */
	pidFile: string;
	/** 记录已安装的元数据（版本 / revision / 设备意图） */
	metaFile: string;
}

export interface LayaRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** 我们 spawn 的 sidecar 子进程的最小接口（便于测试 fake）。 */
export interface LayaChild {
	pid: number | undefined;
	kill(signal?: NodeJS.Signals): boolean;
	onExit(cb: (code: number | null) => void): void;
}

export interface LayaDeps {
	profile(ctx?: PlatformContext): PlatformProfile;
	nvidiaProbe(): Promise<NvidiaProbe>;
	ensureUv(): Promise<string>;
	uvPath(): string;
	pythonVersion(): string;
	run(cmd: string, args: string[], opts: { env: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; onOutput?: (line: string) => void }): Promise<LayaRunResult>;
	spawn(exe: string, args: string[], opts: { env: Record<string, string> }): LayaChild;
	/** 下某个 checkpoint（HF 缓存自带续传）；pythonPath = 本次安装 staging venv 的解释器 */
	downloadCheckpoint(cp: LayaCheckpoint, p: (received: number, total: number | null) => void, signal: AbortSignal, env: Record<string, string>, pythonPath: string): Promise<void>;
	findFreePort(): Promise<number>;
	health(port: number, token: string, signal?: AbortSignal): Promise<LayaHealth>;
	/** 原子 activate：staging → 生效 env（旧 env 保留为 envPrev 供回滚） */
	activate(paths: LayaPaths): Promise<void>;
	/** 安装失败/取消后的回滚：删 staging，恢复旧 env */
	rollback(paths: LayaPaths): Promise<void>;
	/** 只删 own 目录（canonical 校验在实现里做，不得 purge 用户文件） */
	uninstall(paths: LayaPaths): Promise<void>;
	randomToken(): string;
	paths(): LayaPaths;
	/** 注册/重注册 classifier provider（进程内注入 token；不落盘真实密钥） */
	registerClassifier(info: { provider: string; modelId: string; protocol: string; baseUrl: string; token: string }): void;
	unregisterClassifier(provider: string): void;
	/** 记录我们自己的 sidecar pid（只写 pid + token 摘要，不写 token 原文）；null 表示清掉 */
	recordPid(pid: number | null): void;
	now(): number;
	/** 已安装判定（真实实现看 env 目录 + meta） */
	isInstalled(): boolean;
	log(line: string): void;
}

export interface LayaStatus {
	platform: PlatformProfile;
	install: { state: LayaInstallState; phase: LayaInstallPhase; received: number; total: number | null; error: string | null; installedAt: number | null };
	runtime: { state: LayaRuntimeState; pid: number | null; port: number | null; host: string };
	health: LayaHealth | null;
	registered: { provider: string; modelId: string; protocol: string } | null;
	source: LayaSourceMeta;
}

/** 注册到 Pi classifier 目录时用的稳定 provider id（不涉及用户自定义服务，不写真实凭据）。 */
export const LAYA_PROVIDER_ID = "local-laya";
export const LAYA_MODEL_ID = "multilingual";
export const LAYA_BIND_HOST = "127.0.0.1";

interface RuntimeState {
	state: LayaRuntimeState;
	pid: number | null;
	port: number | null;
	/** 只在本进程内存里，绝不进 status / 日志 */
	token: string | null;
	child: LayaChild | null;
	health: LayaHealth | null;
}

/**
 * 安装状态机。所有跨进程/磁盘动作都经 `deps`，因此可用 fake 做完整状态测试。
 * 并发：同一时刻只允许一次安装；`cancel()` 通过 AbortController 打断，失败时回滚 staging，**绝不动已生效的旧环境**。
 */
export class LocalLayaManager {
	private deps: LayaDeps;
	private installInfo: LayaStatus["install"] = { state: "not_installed", phase: "idle", received: 0, total: null, error: null, installedAt: null };
	private runtime: RuntimeState = { state: "stopped", pid: null, port: null, token: null, child: null, health: null };
	private abort: AbortController | null = null;
	private platform: PlatformProfile;
	private source: LayaSourceMeta;
	private onChange: () => void;

	constructor(deps: LayaDeps, source: LayaSourceMeta, onChange: () => void = () => {}) {
		this.deps = deps;
		this.source = source;
		this.onChange = onChange;
		this.platform = deps.profile();
		if (deps.isInstalled()) {
			this.installInfo = { state: "installed", phase: "done", received: 0, total: null, error: null, installedAt: deps.now() };
		}
	}

	/** 每次渲染时重算平台意图（用户可能在 preflight 里改 CUDA/XPU 选项）。 */
	refreshPlatform(ctx: PlatformContext = {}): PlatformProfile {
		this.platform = this.deps.profile(ctx);
		this.onChange();
		return this.platform;
	}

	status(): LayaStatus {
		return {
			platform: this.platform,
			install: { ...this.installInfo },
			runtime: { state: this.runtime.state, pid: this.runtime.pid, port: this.runtime.port, host: LAYA_BIND_HOST },
			health: this.runtime.health,
			registered: this.runtime.token ? { provider: LAYA_PROVIDER_ID, modelId: LAYA_MODEL_ID, protocol: "typesafe-system-one" } : null,
			source: this.source,
		};
	}

	private set(phase: LayaInstallPhase, extra: Partial<LayaStatus["install"]> = {}) {
		this.installInfo = { ...this.installInfo, phase, ...extra };
		this.onChange();
	}

	/** 取消进行中的安装（下载/校验）。取消后由 install() 的 finally 负责回滚 staging。 */
	cancel(): { ok: boolean } {
		if (this.installInfo.state !== "installing" || !this.abort) return { ok: false };
		this.abort.abort();
		this.onChange();
		return { ok: true };
	}

	/**
	 * 一键安装：preflight → uv → staging venv → torch → laya → 权重 → 校验 → 原子 activate。
	 * 失败/取消：清理 staging，回滚到旧环境，state=failed 且 error 已脱敏；**不产生半安装的 ready**。
	 */
	async install(opts: { checkpoint?: LayaCheckpoint; ctx?: PlatformContext; signal?: AbortSignal } = {}): Promise<LayaStatus> {
		if (this.installInfo.state === "installing") throw new Error("安装已在进行中");
		const cp = opts.checkpoint;
		const signal = opts.signal ?? (this.abort = new AbortController()).signal;
		this.set("preflight", { state: "installing", error: null, received: 0, total: null });
		try {
			const profile = this.deps.profile(opts.ctx);
			this.platform = profile;
			if (profile.support === "unsupported") throw new Error(profile.reason);
			this.set("uv");
			await this.deps.ensureUv();
			const paths = this.deps.paths();
			const env = this.baseEnv(paths);
			this.set("venv");
			await this.step(signal, () => this.runOrThrow(this.deps.uvPath(), ["venv", "--python", this.deps.pythonVersion(), paths.envStaging], { env, signal }));
			this.set("torch");
			const pins = profile.pins;
			await this.step(signal, () =>
				this.runOrThrow(this.deps.uvPath(), ["pip", "install", "--python", this.envPython(paths.envStaging), "--torch-backend", torchBackendValue(profile), ...pins, `laya[serve]==${this.source.version}`], { env, signal }),
			);
			this.set("laya");
			if (cp) {
				this.set("weights");
				await this.deps.downloadCheckpoint(cp, (received, total) => this.set("weights", { received, total }), signal, env, this.envPython(paths.envStaging));
			}
			this.set("verify");
			await this.step(signal, () => this.runOrThrow(this.envPython(paths.envStaging), ["-c", "import laya"], { env, signal }));
			if (signal.aborted) throw new Error("已取消");
			this.set("activate");
			await this.deps.activate(paths);
			this.installInfo = { state: "installed", phase: "done", received: this.installInfo.received, total: this.installInfo.total, error: null, installedAt: this.deps.now() };
			this.onChange();
			return this.status();
		} catch (e) {
			const cancelled = signal.aborted;
			if (cancelled) this.set("idle");
			else this.set("rollback");
			await this.deps.rollback(this.deps.paths()).catch(() => {});
			this.installInfo = {
				state: cancelled ? "not_installed" : "failed",
				phase: cancelled ? "idle" : "rollback",
				received: 0,
				total: null,
				error: cancelled ? null : sanitizeError(e),
				installedAt: this.deps.isInstalled() ? this.installInfo.installedAt : null,
			};
			this.onChange();
			if (cancelled) throw new Error("已取消");
			throw e;
		} finally {
			this.abort = null;
		}
	}

	/** 启动 sidecar：随机空闲端口 + 每次新 token；只绑 127.0.0.1。 */
	async start(): Promise<LayaStatus> {
		if (this.installInfo.state !== "installed") throw new Error("还没安装完成");
		if (this.runtime.state === "running" || this.runtime.state === "starting") return this.status();
		const paths = this.deps.paths();
		this.runtime.state = "starting";
		this.onChange();
		const port = await this.deps.findFreePort();
		const token = this.deps.randomToken();
		const env = { ...this.baseEnv(paths), LAYA_HOST: LAYA_BIND_HOST, LAYA_PORT: String(port), LAYA_API_KEY: token, LAYA_JEV_STRICT: "1", LAYA_THREADS: this.cpuThreads(), LAYA_IDLE_UNLOAD_SECONDS: "300" };
		const child = this.deps.spawn(this.envBin(paths.env, "laya-serve"), [], { env });
		this.runtime = { state: "running", pid: child.pid ?? null, port, token, child, health: null };
		this.deps.recordPid(child.pid ?? null);
		this.deps.registerClassifier({ provider: LAYA_PROVIDER_ID, modelId: LAYA_MODEL_ID, protocol: "typesafe-system-one", baseUrl: `http://${LAYA_BIND_HOST}:${port}/v1/`, token });
		child.onExit((code) => {
			if (this.runtime.child !== child) return;
			this.deps.recordPid(null);
			this.runtime = { ...this.runtime, state: "crashed", pid: null, child: null, token: null };
			this.onChange();
		});
		this.onChange();
		// 自检：拿实际 device / cpu_fallbacks（失败不阻止启动，health=ok:false）
		try {
			this.runtime.health = await this.deps.health(port, token);
		} catch {
			this.runtime.health = { ok: false, device: null, checkpointDevices: null, cpuFallbacks: null, revisions: null, loaded: null };
		}
		this.onChange();
		return this.status();
	}

	/** 停止 sidecar：只 kill 我们自己 spawn 的 child，绝不动任意 pid。 */
	async stop(): Promise<LayaStatus> {
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
		this.deps.unregisterClassifier(LAYA_PROVIDER_ID);
		this.deps.recordPid(null);
		this.runtime = { state: "stopped", pid: null, port: null, token: null, child: null, health: null };
		this.onChange();
		return this.status();
	}

	/** 更新：重跑安装到 staging 并原子切换（失败回滚旧环境）。 */
	async update(opts: { ctx?: PlatformContext } = {}): Promise<LayaStatus> {
		return this.install({ checkpoint: undefined, ctx: opts.ctx });
	}

	/**
	 * 卸载：需显式确认。运行中先停；只删 own 目录（canonical 校验在 deps.uninstall 内），不 purge 用户文件。
	 */
	async uninstall(confirm: boolean): Promise<LayaStatus> {
		if (!confirm) throw new Error("卸载需要显式确认");
		if (this.runtime.state !== "stopped") await this.stop();
		await this.deps.uninstall(this.deps.paths());
		this.installInfo = { state: "not_installed", phase: "idle", received: 0, total: null, error: null, installedAt: null };
		this.platform = this.deps.profile();
		this.onChange();
		return this.status();
	}

	private async step(signal: AbortSignal, fn: () => Promise<unknown>) {
		if (signal.aborted) throw new Error("已取消");
		await fn();
	}
	/** 跑一条必须成功的命令，非 0 退出码当失败（错误已脱敏），避免半成品被当成装好。 */
	private async runOrThrow(cmd: string, args: string[], opts: { env: Record<string, string>; signal?: AbortSignal }): Promise<void> {
		const res = await this.deps.run(cmd, args, opts);
		if (res.code !== 0) throw new Error(sanitizeError(res.stderr || `命令失败（退出码 ${res.code}）：${args.join(" ")}`));
	}
	private baseEnv(paths: LayaPaths): Record<string, string> {
		return {
			HOME: paths.root,
			UV_CACHE_DIR: paths.uvCache,
			UV_PYTHON_INSTALL_DIR: paths.python,
			HF_HOME: paths.hfHome,
			PYTHONNOUSERSITE: "1",
			PIP_DISABLE_PIP_VERSION_CHECK: "1",
			// 清掉外部会干扰的变量
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
	/** CPU 上最大的性能开关：线程数取可用并行度（Laya 要求 ≤ 物理核数；拿不到按 4）。 */
	private cpuThreads(): string {
		try {
			const n = availableParallelism();
			return String(Math.max(1, Math.min(64, n)));
		} catch {
			return "4";
		}
	}
}

/** torch 后端值：default → auto（macOS arm64 用 pypi 默认轮子）。 */
function torchBackendValue(p: PlatformProfile): string {
	return p.torchBackend === "default" ? "auto" : p.torchBackend;
}

/** 错误脱敏：去掉可能的 token（Bearer …）与超长内容，绝不把密钥写进状态 / 日志。 */
export function sanitizeError(e: unknown): string {
	const raw = e instanceof Error ? e.message : String(e);
	const noToken = raw.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer ***").replace(/\b[a-f0-9]{32,}\b/gi, "***");
	return noToken.slice(0, 400);
}
