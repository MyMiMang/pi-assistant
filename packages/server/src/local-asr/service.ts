/**
 * 本地 ASR 的**多模型协调器**：把「一次只运行一个 worker、多个权重共存」这件事收在一处。
 *
 * 职责：
 *  - 按 modelId 持有各模型的 `LocalAsrManager`（每个 manager 只管自己的权重目录，共享 runtime venv）；
 *  - 全局**串行安装**（同一个 uv venv，避免并发 `uv pip install` 互相污染）；
 *  - `select(modelId)`：切到某模型并把旧的 worker 停掉（**一次只跑一个**）；有录音租约 / 活跃推理时
 *    明确拒绝（409 语义），绝不把进行中的音频送给另一个模型；
 *  - `install(...intent)`：安装只负责装；只有 `intent === "install_and_use"` 且**选择自 install 开始后未变**
 *    才写「用本地」来源（stale intent 防后来 cloud 选择被迟到 job 覆盖）；
 *  - `catalog()`：一次返回硬件档位 / 推荐 / 每模型状态 + 许可 + 来源（UI 一次拿全）。
 *
 * 不 import 任何 voice 实现：来源读写经注入的 `AsrSelectionPort`（http.ts 装配，避免循环依赖）。
 */
import { ASR_CATALOG, asrModelSpec, catalogDefaultVoiceView, classifyAsrHardware, recommendAsrModelId, resolveCatalogDefaultVoice, type AsrModelSpec, type AsrTier } from "./catalog.ts";
import { ASR_MODEL_ID, ASR_PROVIDER_ID, SENSEVOICE_MODEL, SHERPA_ONNX_VERSION, ASR_PYTHON_VERSION } from "./manifest.ts";
import type { DefaultVoicePrepView } from "./default-voice-prep.ts";
import { licenseDisclosure, type LicenseDisclosure } from "./license.ts";
import type { AsrInstallPhase, AsrInstallSource, AsrInstallState, AsrRuntimeState, AsrStatus, LocalAsrManager } from "./manager.ts";
import type { AsrSourceMeta } from "./manifest.ts";

/** 来源读写端口（voice 模块实现；local-asr 不直接 import voice）。 */
export interface AsrSelectionPort {
	read(): { location: "cloud" | "local"; provider: string; model: string } | null;
	/** 持久化版本（每次写入递增）；用于跨客户端 CAS。 */
	version(): number;
	write(next: { location: "cloud" | "local"; provider: string; model: string } | null, opts?: { expectedVersion?: number }): void;
	/** `settings.voiceSource` key 是否存在（区分 unset 与显式 null）；不实现时保守按「已存在」处理（不自动准备）。 */
	present?(): boolean;
}

export interface AsrModelInstallOptions {
	source?: AsrInstallSource;
	acceptLicense?: string | null;
	importDir?: string;
	intent?: "install" | "install_and_use";
	signal?: AbortSignal;
}

export interface LocalAsrInstallView {
	state: AsrInstallState;
	phase: AsrInstallPhase | null;
	phaseLabel: string | null;
	received: number;
	total: number | null;
	percent: number | null;
	error: string | null;
	installedAt: number | null;
	source: AsrInstallSource | null;
	/** 与统一下载注册表同一个稳定 id（`asr:<modelId>`）；同一次安装 = 同一个 job。 */
	jobId: string | null;
	/** 第几次安装尝试（generation） */
	attempt: number | null;
}

export interface LocalAsrRuntimeView {
	state: AsrRuntimeState;
	pid: number | null;
	port: number | null;
	host: string;
	restarts: number;
	lastError: string | null;
	healthOk: boolean;
	loaded: boolean;
}

export interface LocalAsrModelView {
	id: string;
	provider: string;
	family: string;
	variant: string;
	name: string;
	nameEn: string;
	languages: string[];
	note: string;
	tier: AsrTier;
	tags: AsrTier[];
	recommended: boolean;
	recommendationReason: string;
	available: boolean;
	unavailableReason: string | null;
	weightsBytes: number;
	depsBytes: number | null;
	depsNote: string;
	suggestedMemoryBytes: number;
	memoryNote: string;
	capabilities: string[];
	multilingual: boolean;
	license: LicenseDisclosure;
	source: { source: AsrSourceMeta; model: { id: string; repo: string; revision: string; files: { path: string; size: number; sha256: string }[] } };
	installed: boolean;
	selected: boolean;
	running: boolean;
	install: LocalAsrInstallView;
	runtime: LocalAsrRuntimeView;
}

export interface LocalAsrCatalog {
	hardware: { os: string; arch: string; cpuCores: number; memoryBytes: number; tier: AsrTier | "unknown"; tierNote: string };
	runtime: { engine: string; version: string; python: string; depsBytes: number | null; depsNote: string };
	recommendedId: string | null;
	models: LocalAsrModelView[];
	notes: string[];
}

const PHASE_LABELS: Record<AsrInstallPhase, string> = {
	idle: "空闲",
	preflight: "检查环境与许可",
	uv: "准备运行环境（uv）",
	venv: "创建 Python 环境",
	engine: "安装推理引擎",
	weights: "下载 / 导入权重",
	verify: "校验权重",
	activate: "启用模型",
	rollback: "回滚",
	done: "完成",
};

/** 共享运行时的**估算**体积（sherpa-onnx wheels + venv/cache）；未在本机实测，仅用于「首次准备约 XXX MB」的粗略提示。 */
export const ASR_SHARED_RUNTIME_ESTIMATE_BYTES = 95_000_000;

/** 安装阶段中文名（界面 / 统一下载进度共用，避免多处映射漂移）。 */
export function asrPhaseLabel(phase: AsrInstallPhase): string {
	return PHASE_LABELS[phase] ?? phase;
}

interface Job {
	jobId: string;
	attempt: number;
	intent: "install" | "install_and_use";
	selectionAtStart: { location: "cloud" | "local"; provider: string; model: string } | null;
	/** 安装开始时的来源持久化版本（CAS：期间别的客户端改选则不覆盖） */
	selectionVersionAtStart: number;
	/** 安装开始时 `settings.voiceSource` key 是否存在（区分 unset 与显式 null；显式清空不自动采用） */
	selectionPresentAtStart: boolean;
	ctrl: AbortController;
}

export interface LocalAsrServiceDeps {
	/** 由 catalog spec 造 manager（生产用真实 deps，测试注入 fake）。 */
	createManager(spec: AsrModelSpec): LocalAsrManager;
	selection: AsrSelectionPort;
	/** 每次状态变化（bus 推送）。 */
	onChange?: (spec: AsrModelSpec, status: AsrStatus) => void;
	/** 硬件 metadata（生产从 node:os 读，测试注入）。 */
	hardware(): { os: string; arch: string; cpuCores: number; memoryBytes: number };
}

export class LocalAsrService {
	private deps: LocalAsrServiceDeps;
	private managers = new Map<string, LocalAsrManager>();
	private jobs = new Map<string, Job>();
	private attempt = new Map<string, number>();

	constructor(deps: LocalAsrServiceDeps) {
		this.deps = deps;
	}

	/** 由 http.ts 在装配时注入（避免 local-asr ↔ voice 循环依赖）。 */
	setSelectionPort(port: AsrSelectionPort): void {
		this.deps.selection = port;
	}

	specs(): AsrModelSpec[] {
		return ASR_CATALOG;
	}

	spec(id: string): AsrModelSpec | null {
		return asrModelSpec(id);
	}

	/** 取（必要时懒创建）某模型的 manager；未知模型 fail closed。 */
	managerFor(id: string): LocalAsrManager {
		const spec = asrModelSpec(id);
		if (!spec) throw new Error(`未知的本地 ASR 模型：${id}`);
		let m = this.managers.get(id);
		if (!m) {
			m = this.deps.createManager(spec);
			this.managers.set(id, m);
		}
		return m;
	}

	/** 兼容旧单例：SenseVoice manager。 */
	legacyManager(): LocalAsrManager {
		return this.managerFor(ASR_MODEL_ID);
	}

	/** 当前运行中的模型 manager（transcribe / lease 用）；未运行返回 null。 */
	runningManager(): { spec: AsrModelSpec; manager: LocalAsrManager } | null {
		for (const spec of ASR_CATALOG) {
			const m = this.managers.get(spec.id);
			if (!m) continue;
			const st = m.status();
			if (st.runtime.state === "running" || st.runtime.state === "starting") return { spec, manager: m };
		}
		return null;
	}

	selected(): { location: "cloud" | "local"; provider: string; model: string } | null {
		return this.deps.selection.read();
	}

	// ---------------------------------------------------------------- catalog

	private installView(spec: AsrModelSpec): LocalAsrInstallView {
		const st = this.managerFor(spec.id).status();
		const job = this.jobs.get(spec.id);
		const pct = st.install.total && st.install.total > 0 ? Math.min(100, Math.floor((st.install.received / st.install.total) * 100)) : null;
		return {
			state: st.install.state,
			phase: st.install.state === "installing" || st.install.state === "failed" ? st.install.phase : null,
			phaseLabel: st.install.state === "installing" ? asrPhaseLabel(st.install.phase) : null,
			received: st.install.received,
			total: st.install.total,
			percent: pct,
			error: st.install.error,
			installedAt: st.install.installedAt,
			source: st.install.source,
			jobId: st.install.state === "installing" || job ? (job?.jobId ?? `asr:${spec.id}`) : null,
			attempt: job?.attempt ?? this.attempt.get(spec.id) ?? null,
		};
	}

	private runtimeView(spec: AsrModelSpec): LocalAsrRuntimeView {
		const st = this.managerFor(spec.id).status();
		return {
			state: st.runtime.state,
			pid: st.runtime.pid,
			port: st.runtime.port,
			host: st.runtime.host,
			restarts: st.runtime.restarts,
			lastError: st.runtime.lastError,
			healthOk: !!st.health?.ok,
			loaded: (st.health?.loaded?.length ?? 0) > 0,
		};
	}

	catalog(): LocalAsrCatalog {
		const hw = this.deps.hardware();
		const cls = classifyAsrHardware(hw.memoryBytes, hw.cpuCores);
		const recommendedId = recommendAsrModelId(cls.tier);
		const sel = this.deps.selection.read();
		const models: LocalAsrModelView[] = [];
		for (const spec of ASR_CATALOG) {
			const st = this.managerFor(spec.id).status();
			const platformSupported = spec.platforms.length === 0 || spec.platforms.includes(st.platform.key);
			const recommended = spec.id === recommendedId;
			models.push({
				id: spec.id,
				provider: spec.provider,
				family: spec.family,
				variant: spec.variant,
				name: spec.name,
				nameEn: spec.nameEn,
				languages: [...spec.manifest.languages],
				note: spec.note,
				tier: spec.tier,
				tags: [spec.tier],
				recommended,
				recommendationReason: recommended ? recommendationReason(spec, cls.tier) : "",
				available: platformSupported && spec.license.selfServe && spec.license.decision !== "prohibited",
				unavailableReason: !platformSupported ? (st.platform.reason ?? "当前平台不支持") : !spec.license.selfServe || spec.license.decision === "prohibited" ? spec.license.reason : null,
				weightsBytes: spec.manifest.bytes,
				depsBytes: spec.runtimeDeps.bytes,
				depsNote: spec.runtimeDeps.note,
				suggestedMemoryBytes: spec.recommend.ramMB * 1024 * 1024,
				memoryNote: `模型进程内存估算（非实测）；整机内存建议见硬件档位`,
				capabilities: [...spec.capabilities],
				multilingual: spec.multilingual,
				license: licenseDisclosure(spec.license),
				source: {
					source: spec.source,
					model: { id: spec.manifest.id, repo: spec.manifest.repo, revision: spec.manifest.revision, files: spec.manifest.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })) },
				},
				installed: st.install.state === "installed",
				selected: !!sel && sel.location === "local" && sel.provider === spec.provider && sel.model === spec.id,
				running: st.runtime.state === "running" || st.runtime.state === "starting",
				install: this.installView(spec),
				runtime: this.runtimeView(spec),
			});
		}
		return {
			hardware: { os: hw.os, arch: hw.arch, cpuCores: hw.cpuCores, memoryBytes: hw.memoryBytes, tier: cls.tier, tierNote: cls.note },
			runtime: { engine: "sherpa-onnx", version: SHERPA_ONNX_VERSION, python: ASR_PYTHON_VERSION, depsBytes: null, depsNote: "共享运行环境（引擎 + venv/cache）估算约 0.2GB；未在本机实测" },
			recommendedId,
			models,
			notes: [
				"内存 / 档位均为估算，未在本机跑 benchmark；用户可选比建议更大的档位（装不下会明确报磁盘不足）",
				"一次只运行一个本地语音模型；切换时先停旧 worker",
				"只绑 127.0.0.1；音频只在内存里，不落盘",
			],
		};
	}

	// ---------------------------------------------------------------- install

	/** 同步预检（路由用它决定 HTTP 状态码）。 */
	precheckInstall(id: string, opts: AsrModelInstallOptions): { ok: true } | { ok: false; error: string } {
		const spec = asrModelSpec(id);
		if (!spec) return { ok: false, error: `未知的本地 ASR 模型：${id}` };
		if (this.anyInstalling()) return { ok: false, error: "另一个模型的安装正在进行中，请先等待或取消" };
		return this.managerFor(id).precheck({ source: opts.source ?? "download", acceptLicense: opts.acceptLicense, importDir: opts.importDir });
	}

	/** 全局串行安装：同一 uv venv 不能并发 pip。 */
	private anyInstalling(): boolean {
		for (const id of this.managers.keys()) {
			if (this.jobs.has(id)) return true;
		}
		return false;
	}

	async install(id: string, opts: AsrModelInstallOptions = {}): Promise<AsrStatus> {
		const spec = asrModelSpec(id);
		if (!spec) throw new Error(`未知的本地 ASR 模型：${id}`);
		const pre = this.precheckInstall(id, opts);
		if (!pre.ok) throw new Error(pre.error);
		const m = this.managerFor(id);
		const attempt = (this.attempt.get(id) ?? 0) + 1;
		this.attempt.set(id, attempt);
		const ctrl = new AbortController();
		const job: Job = {
			jobId: `asr:${id}`,
			attempt,
			intent: opts.intent === "install_and_use" ? "install_and_use" : "install",
			selectionAtStart: this.deps.selection.read(),
			selectionVersionAtStart: this.deps.selection.version(),
			// 区分「从未设置（unset）」与「显式清空（null）」：只有安装前后都**unset**才自动采用默认。
			selectionPresentAtStart: this.deps.selection.present?.() ?? true,
			ctrl,
		};
		this.jobs.set(id, job);
		try {
			const st = await m.install({ source: opts.source ?? "download", acceptLicense: opts.acceptLicense, importDir: opts.importDir, signal: ctrl.signal });
			// stale 防护：只有「安装并使用」且选择自开始后未变化才写「用本地」来源；
			// CAS 用 expectedVersion 防 ABA / 跨客户端覆盖（别的页面后来改选 cloud 则这里失败，不覆盖）。
			// 显式清空（key 存在且为 null）绝不自动改：安装前后都必须 unset。
			const presentNow = this.deps.selection.present?.() ?? true;
			if (job.intent === "install_and_use" && !job.selectionPresentAtStart && !presentNow && sameSelection(this.deps.selection.read(), job.selectionAtStart)) {
				try {
					this.deps.selection.write({ location: "local", provider: spec.provider, model: spec.id }, { expectedVersion: job.selectionVersionAtStart });
				} catch {
					/* 另一个页面 / 客户端已改选来源：保持用户后来的选择，不覆盖（UI 提示「已装但未切来源」） */
				}
			}
			return st;
		} finally {
			this.jobs.delete(id);
			this.deps.onChange?.(spec, m.status());
		}
	}

	cancel(id: string): { ok: boolean } {
		const job = this.jobs.get(id);
		if (!job) return { ok: false };
		job.ctrl.abort();
		return this.managerFor(id).cancel();
	}

	/** 切到某模型（并停掉其它 worker）。忙（有租约 / 活跃推理）时明确拒绝。 */
	async select(id: string): Promise<AsrStatus> {
		const spec = asrModelSpec(id);
		if (!spec) throw new Error(`未知的本地 ASR 模型：${id}`);
		const target = this.managerFor(id);
		const tst = target.status();
		if (tst.install.state !== "installed") throw new Error("该模型还没安装完成");
		for (const other of ASR_CATALOG) {
			if (other.id === id) continue;
			const om = this.managers.get(other.id);
			if (!om) continue;
			const ost = om.status();
			if (ost.idle.leases > 0 || ost.idle.active > 0) throw new Error("正在录音或有未完成请求，暂不能切换模型");
			if (ost.runtime.state === "running" || ost.runtime.state === "starting") await om.stop("switch");
		}
		this.deps.selection.write({ location: "local", provider: spec.provider, model: spec.id });
		await target.start().catch(() => {});
		this.deps.onChange?.(spec, target.status());
		return target.status();
	}

	async uninstall(id: string, confirm: boolean): Promise<AsrStatus> {
		const spec = asrModelSpec(id);
		if (!spec) throw new Error(`未知的本地 ASR 模型：${id}`);
		// 卸载正在用的（持有租约）模型要明确拒绝。
		const m = this.managerFor(id);
		const st = m.status();
		if (st.idle.leases > 0 || st.idle.active > 0) throw new Error("正在录音或有未完成请求，暂不能卸载该模型");
		const out = await m.uninstall(confirm);
		this.deps.onChange?.(spec, out);
		return out;
	}

	// ------------------------------------------------------- 默认本地语音（可选模块：用户显式安装）

	/** 目录解析出的默认本地语音 modelId（fail closed，不猜）。 */
	defaultVoiceModelId(): string | null {
		const r = resolveCatalogDefaultVoice();
		return r.ok ? r.id : null;
	}

	/**
	 * 默认本地语音的状态视图（契约 §1.1 的 `defaultVoice` 块）。
	 * **不下载 / 不启动 worker**；只读安装状态，供 `GET /api/audio/asr/source` 一次带出。
	 */
	defaultVoicePrepView(): DefaultVoicePrepView {
		const defaultModelId = this.defaultVoiceModelId();
		const view = catalogDefaultVoiceView(this.deps.selection.read());
		const spec = defaultModelId ? asrModelSpec(defaultModelId) : null;
		const install = spec ? this.installView(spec) : null;
		const state: DefaultVoicePrepView["prep"]["state"] = !defaultModelId
			? "not_applicable"
			: install?.state === "installed"
				? "ready"
				: install?.state === "installing"
					? "preparing"
					: install?.state === "failed"
						? "failed"
						: "not_prepared";
		const finishedAt = install?.installedAt != null ? new Date(install.installedAt).toISOString() : null;
		const approxBytes = spec ? spec.manifest.bytes + ASR_SHARED_RUNTIME_ESTIMATE_BYTES : null;
		const mb = approxBytes ? Math.round(approxBytes / 1024 / 1024) : "?";
		return {
			defaultModelId,
			kind: view.kind,
			label: view.label,
			prep: {
				state,
				jobId: install?.jobId ?? (defaultModelId ? `asr:${defaultModelId}` : null),
				phase: install?.phase ?? null,
				phaseLabel: install?.phaseLabel ?? null,
				received: install?.received ?? null,
				total: install?.total ?? null,
				percent: install?.percent ?? null,
				attempt: install?.attempt ?? null,
				startedAt: null,
				finishedAt,
				error: install?.error ?? null,
				errorCode: install?.error ? "asr_prepare_failed" : null,
				retryable: state === "failed",
			},
			// 可选模块：不随安装包分发，安装时需联网；装好后可离线。
			firstRunNeedsNetwork: true,
			approxBytes,
			offlineAfterReady: true,
			requiresUserAction: true,
			micPermissionRequested: false,
			notes: [
				"可选模块：默认不安装，不随安装包分发；在 设置 › 语音 点「安装」才会下载",
				`安装量估算约 ${mb} MB（运行环境 + 默认模型，估算非实测），装好后可离线使用`,
				"默认流式模型输出无标点；麦克风权限只在用户点麦克风时申请",
			],
		};
	}

	/** 取消默认本地语音的安装（窄接口：只动**目录里唯一的默认模型**，不接任意 modelId / downloadId）。 */
	cancelDefaultVoicePrepare(): { ok: boolean; reason: string } {
		const id = this.defaultVoiceModelId();
		if (!id) return { ok: false, reason: "目录里没有默认本地语音模型" };
		const ok = this.cancel(id).ok;
		return { ok, reason: ok ? "已取消安装本地语音" : "本地语音没有在安装" };
	}

	/**
	 * 用户显式安装默认本地语音（窄接口：固定默认模型 + 统一安装 job + 统一进度；首次安装与失败重试共用）。
	 * 采用仍走 `install_and_use` 的 CAS：**不**覆盖用户已选来源。
	 */
	installDefaultVoice(): { started: boolean; reason: string } {
		const id = this.defaultVoiceModelId();
		if (!id) return { started: false, reason: "目录里没有默认本地语音模型" };
		const st = this.managerFor(id).status();
		if (st.install.state === "installing") return { started: false, reason: "本地语音正在安装中" };
		if (st.install.state === "installed") return { started: false, reason: "本地语音已安装" };
		if (this.anyInstalling()) return { started: false, reason: "已有安装正在进行中，请先等待或取消" };
		void this.install(id, { intent: "install_and_use" }).catch(() => {});
		return { started: true, reason: "已开始安装本地语音" };
	}
}

function recommendationReason(spec: AsrModelSpec, tier: AsrTier | "unknown"): string {
	if (tier === "unknown") return `拿不到整机内存，按最保守估计推荐 ${spec.name}（估算，未实测）`;
	return `按当前整机内存档位（${tier}）推荐 ${spec.name}（估算，未实测；可自行选择更大档位）`;
}

function sameSelection(a: { provider: string; model: string; location: string } | null, b: { provider: string; model: string; location: string } | null): boolean {
	if (!a || !b) return a === b;
	return a.location === b.location && a.provider === b.provider && a.model === b.model;
}

export { ASR_PROVIDER_ID, SENSEVOICE_MODEL };
