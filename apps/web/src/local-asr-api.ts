/**
 * 本地语音「多模型目录」前端消费层（GET /api/local-models/asr/catalog）。
 *
 * 与 backendowner 的 `local-asr-multi-model`（packages/server/src/local-asr/*）按**同一 DTO** 对齐：
 *  - 只读 GET catalog（一次拿全硬件档位 / 推荐 / 体积 / 内存估算 / 许可 / 来源 / 安装态 / 运行态 / selected）；
 *  - 写操作按模型 id 路由到 `/api/local-models/asr/models/:id/*`；旧 `/sensevoice/*` 保留给存量导入。
 *  - 「安装并使用」由后端 `intent:"install_and_use"` 处理：装完且**选择自安装开始后未变**才写「用本地」来源
 *    （服务端 stale 防护）；前端只看 `selected`，不自己 late PUT。
 *
 * `normalizeLocalAsrCatalog` 是**对齐层**：字段名与后端一致时就是恒等映射，缺字段给安全缺省，
 * 结构不对 → ok=false（UI 明确说不可用）。**UI 不写死任何模型清单**——列出来的都由服务端返回。
 */
import { api } from "./api";

export type LocalAsrTier = "light" | "balanced" | "high" | "unknown";
export type LocalAsrModelTag = "light" | "balanced" | "high";
export type LocalAsrInstallState = "not_installed" | "installing" | "installed" | "failed";

export interface LocalAsrHardware {
	os: string;
	arch: string;
	cpuCores: number;
	/** os.totalmem()（字节），整机内存，用于算档位。 */
	memoryBytes: number;
	tier: LocalAsrTier;
	/** 中文一句话：档位怎么来的 + 「估算，未实测」。 */
	tierNote: string;
}

/** 共享运行环境（引擎 + venv/cache）；与每个模型的权重分开计。 */
export interface LocalAsrRuntimeEnvView {
	engine: string;
	version: string;
	python: string;
	depsBytes: number | null;
	depsNote: string;
	/** 共享运行环境下载量估算（所有模型共用、只下一次）；旧后端没给 = null */
	downloadBytes: number | null;
	/** 已就位（装过任一模型）→ 再装别的模型不再计它 */
	present: boolean;
}

export interface LocalAsrLicense {
	licenseName: string;
	termsVersion: string;
	decision: "cleared" | "unresolved" | "prohibited";
	/** 本地按需下载安装（用户自用）是否放行；安装按钮 / 下载面板看它，不看 decision。 */
	selfServe: boolean;
	redistribution: boolean;
	attribution: string;
	links: { modelCard: string; modelLicense: string; issue: string; engineLicense: string };
	restrictions: string[];
	reason: string;
	/** 是否需用户显式同意才可安装（上游没要求的为 false → 一键装）。 */
	agreementRequired: boolean;
	/** 安装时原样回传（= termsVersion），仅在 `agreementRequired` 时用。 */
	acceptValue: string;
}

export interface LocalAsrSourceView {
	project: string;
	repoUrl: string;
	weightsRepo: string;
	revision: string;
	weightsLicense: string;
	engineLicense: string;
	engineVersion: string;
	note: string;
	files: Array<{ path: string; size: number; sha256: string }>;
}

export interface LocalAsrInstallView {
	state: LocalAsrInstallState;
	/** 稳定枚举：preflight|uv|venv|engine|weights|verify|activate|rollback|done */
	phase: string | null;
	/** 后端给的中文阶段名（前端不自己映射）。 */
	phaseLabel: string | null;
	received: number;
	/** null = 总量未知 → 前端画不确定进度条。 */
	total: number | null;
	percent: number | null;
	error: string | null;
	/** epoch ms。 */
	installedAt: number | null;
	source: "download" | "import" | null;
	/** 与统一下载注册表同一个稳定 id（`asr:<modelId>`）；同一模型 = 同一个 job。 */
	jobId: string | null;
	/** 第几次安装尝试。 */
	attempt: number | null;
}

export interface LocalAsrRuntimeView {
	state: "stopped" | "starting" | "running" | "stopping" | "crashed" | "paused";
	pid: number | null;
	port: number | null;
	host: string;
	restarts: number;
	lastError: string | null;
	healthOk: boolean;
	loaded: boolean;
}

export interface LocalAsrModelView {
	/** 稳定 id：安装路由参数，也是 voiceSource.model（和 per-model 权重目录名）。 */
	id: string;
	/** voiceSource.provider（`local-paraformer` / `local-whisper` / `local-sensevoice`）。 */
	provider: string;
	family: string;
	variant: string;
	name: string;
	nameEn: string;
	languages: string[];
	note: string;
	/** 一句大白话：适合什么场景（旧后端没给 = 空串） */
	suits: string;
	tier: LocalAsrTier;
	tags: LocalAsrModelTag[];
	recommended: boolean;
	recommendationReason: string;
	available: boolean;
	unavailableReason: string | null;
	weightsBytes: number;
	depsBytes: number | null;
	depsNote: string;
	suggestedMemoryBytes: number;
	memoryNote: string;
	/** 能力标签（标点 / 时间戳 / 多语…）；语种以 languages 为准。真实模型事实，不杜撰。 */
	capabilities: string[];
	multilingual: boolean;
	license: LocalAsrLicense;
	source: LocalAsrSourceView;
	installed: boolean;
	/** 服务端算出的「当前来源就是它」。装完自动使用 / 手动使用都以它为准。 */
	selected: boolean;
	running: boolean;
	install: LocalAsrInstallView;
	runtime: LocalAsrRuntimeView;
	/** 下载组件注册表里的 stable id（= install.jobId，`asr:<modelId>`），用于合并统一下载进度。 */
	downloadId: string;
}

export interface LocalAsrCatalogView {
	/** adapter 是否拿到可用结构（false = 后端没给 catalog / 结构不对，UI 明确说不可用）。 */
	ok: boolean;
	hardware: LocalAsrHardware;
	runtime: LocalAsrRuntimeEnvView;
	recommendedId: string | null;
	models: LocalAsrModelView[];
	notes: string[];
}

const pick = <T,>(o: Record<string, unknown>, keys: string[], fallback: T): T => {
	for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k] as T;
	return fallback;
};
const asString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asBool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
const asNum = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const asNumOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const asStrArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export const emptyRuntimeView = (): LocalAsrRuntimeView => ({ state: "stopped", pid: null, port: null, host: "127.0.0.1", restarts: 0, lastError: null, healthOk: false, loaded: false });
export const emptyInstallView = (): LocalAsrInstallView => ({ state: "not_installed", phase: null, phaseLabel: null, received: 0, total: null, percent: null, error: null, installedAt: null, source: null, jobId: null, attempt: null });
export const emptyHardware = (): LocalAsrHardware => ({ os: "unknown", arch: "unknown", cpuCores: 0, memoryBytes: 0, tier: "unknown", tierNote: "未读到本机硬件档位（估算，未实测）" });
const emptyRuntimeEnv = (): LocalAsrRuntimeEnvView => ({ engine: "sherpa-onnx", version: "", python: "", depsBytes: null, depsNote: "", downloadBytes: null, present: false });
const emptyLicense = (): LocalAsrLicense => ({ licenseName: "", termsVersion: "", decision: "unresolved", selfServe: false, redistribution: false, attribution: "", links: { modelCard: "", modelLicense: "", issue: "", engineLicense: "" }, restrictions: [], reason: "", agreementRequired: false, acceptValue: "" });
const emptySourceView = (): LocalAsrSourceView => ({ project: "", repoUrl: "", weightsRepo: "", revision: "", weightsLicense: "", engineLicense: "", engineVersion: "", note: "", files: [] });

function normalizeInstall(raw: unknown): LocalAsrInstallView {
	const o = (raw ?? {}) as Record<string, unknown>;
	const state = asString(o.state, "not_installed") as LocalAsrInstallState;
	const total = asNumOrNull(pick(o, ["total", "totalBytes", "total_bytes"], null));
	const received = asNum(pick(o, ["received", "receivedBytes", "received_bytes"], 0));
	const percent = asNumOrNull(o.percent);
	const source = pick<string | null>(o, ["source"], null);
	return {
		state: ["not_installed", "installing", "installed", "failed"].includes(state) ? state : "not_installed",
		phase: (pick(o, ["phase"], null) as string | null) ?? null,
		phaseLabel: (pick(o, ["phaseLabel", "phase_label"], null) as string | null) ?? null,
		received,
		total,
		percent: percent ?? (total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null),
		error: (pick(o, ["error"], null) as string | null) ?? null,
		installedAt: asNumOrNull(pick(o, ["installedAt", "installed_at"], null)),
		source: source === "download" || source === "import" ? source : null,
		jobId: (pick(o, ["jobId", "job_id"], null) as string | null) ?? null,
		attempt: asNumOrNull(pick(o, ["attempt"], null)),
	};
}

function normalizeRuntime(raw: unknown): LocalAsrRuntimeView {
	if (!raw || typeof raw !== "object") return emptyRuntimeView();
	const o = raw as Record<string, unknown>;
	const state = asString(o.state, "stopped") as LocalAsrRuntimeView["state"];
	return {
		state: ["stopped", "starting", "running", "stopping", "crashed", "paused"].includes(state) ? state : "stopped",
		pid: asNumOrNull(o.pid),
		port: asNumOrNull(o.port),
		host: asString(o.host, "127.0.0.1"),
		restarts: asNum(o.restarts, 0),
		lastError: (o.lastError as string | null) ?? null,
		healthOk: asBool(o.healthOk, false),
		loaded: asBool(o.loaded, false),
	};
}

function normalizeLicense(raw: unknown): LocalAsrLicense {
	if (!raw || typeof raw !== "object") return emptyLicense();
	const o = raw as Record<string, unknown>;
	const links = (o.links ?? {}) as Record<string, unknown>;
	const decision = asString(o.decision, "unresolved");
	return {
		licenseName: asString(pick(o, ["licenseName", "license_name", "name"], "")),
		termsVersion: asString(pick(o, ["termsVersion", "terms_version"], "")),
		decision: ["cleared", "unresolved", "prohibited"].includes(decision) ? (decision as LocalAsrLicense["decision"]) : "unresolved",
		// 本地自用下载放行是**独立维度**（后端 `selfServe`）；缺失时保守地按「非 prohibited」兼容旧后端。
		selfServe: asBool(pick(o, ["selfServe", "self_serve"], decision !== "prohibited"), decision !== "prohibited"),
		redistribution: asBool(o.redistribution, false),
		attribution: asString(o.attribution, ""),
		links: { modelCard: asString(links.modelCard), modelLicense: asString(links.modelLicense), issue: asString(links.issue), engineLicense: asString(links.engineLicense) },
		restrictions: asStrArray(o.restrictions),
		reason: asString(o.reason, ""),
		// 上游没要求点击同意的不要强制（后端显式给；缺失时默认 false）。
		agreementRequired: asBool(pick(o, ["agreementRequired", "agreement_required"], false), false),
		acceptValue: asString(pick(o, ["acceptValue", "accept_value"], ""), ""),
	};
}

/** 后端 `source` 是 `{ source: AsrSourceMeta, model: {revision, files} }`；兼容扁平写法。 */
function normalizeSourceView(raw: unknown): LocalAsrSourceView {
	if (!raw || typeof raw !== "object") return emptySourceView();
	const o = raw as Record<string, unknown>;
	const inner = (o.source && typeof o.source === "object" ? (o.source as Record<string, unknown>) : o) as Record<string, unknown>;
	const model = (o.model && typeof o.model === "object" ? (o.model as Record<string, unknown>) : {}) as Record<string, unknown>;
	const files = Array.isArray(model.files) ? model.files : Array.isArray(inner.files) ? inner.files : [];
	return {
		project: asString(inner.project, ""),
		repoUrl: asString(inner.repoUrl, ""),
		weightsRepo: asString(pick(inner, ["weightsRepo", "weights_repo"], "")),
		revision: asString(pick(model, ["revision"], pick(inner, ["weightsRevision", "revision"], ""))),
		weightsLicense: asString(pick(inner, ["weightsLicense", "weights_license"], "")),
		engineLicense: asString(pick(inner, ["engineLicense", "engine_license"], "")),
		engineVersion: asString(pick(inner, ["engineVersion", "engine_version"], "")),
		note: asString(inner.note, ""),
		files: files as LocalAsrSourceView["files"],
	};
}

export function normalizeLocalAsrModel(raw: unknown): LocalAsrModelView | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const id = asString(o.id, "");
	if (!id) return null;
	const tags = asStrArray(o.tags).filter((t): t is LocalAsrModelTag => t === "light" || t === "balanced" || t === "high");
	const tierRaw = asString(o.tier, tags[0] ?? "unknown") as LocalAsrTier;
	const install = normalizeInstall(o.install);
	return {
		id,
		provider: asString(pick(o, ["provider"], "local-asr"), "local-asr"),
		family: asString(o.family, ""),
		variant: asString(o.variant, ""),
		name: asString(o.name, id),
		nameEn: asString(pick(o, ["nameEn", "name_en"], "")),
		languages: asStrArray(o.languages),
		note: asString(o.note, ""),
		suits: asString(o.suits, ""),
		tier: ["light", "balanced", "high", "unknown"].includes(tierRaw) ? tierRaw : "unknown",
		tags: tags.length > 0 ? tags : (["light", "balanced", "high"] as string[]).includes(tierRaw) ? [tierRaw as LocalAsrModelTag] : [],
		recommended: asBool(o.recommended, false),
		recommendationReason: asString(pick(o, ["recommendationReason", "recommendation_reason"], "")),
		available: asBool(o.available, true),
		unavailableReason: (pick(o, ["unavailableReason", "unavailable_reason"], null) as string | null) ?? null,
		weightsBytes: asNum(pick(o, ["weightsBytes", "weights_bytes"], 0)),
		depsBytes: asNumOrNull(pick(o, ["depsBytes", "deps_bytes"], null)),
		depsNote: asString(pick(o, ["depsNote", "deps_note"], "")),
		suggestedMemoryBytes: asNum(pick(o, ["suggestedMemoryBytes", "suggested_memory_bytes"], 0)),
		memoryNote: asString(pick(o, ["memoryNote", "memory_note"], "")),
		capabilities: asStrArray(o.capabilities),
		multilingual: asBool(o.multilingual, false),
		license: normalizeLicense(o.license),
		source: normalizeSourceView(o.source),
		installed: asBool(o.installed, install.state === "installed"),
		selected: asBool(o.selected, false),
		running: asBool(o.running, false),
		install,
		runtime: normalizeRuntime(o.runtime),
		downloadId: asString(pick(o, ["downloadId", "download_id"], install.jobId ?? `asr:${id}`), `asr:${id}`),
	};
}

/** 把后端 catalog 归一成 UI 用的结构；结构不对就 ok=false（不假装可用）。 */
export function normalizeLocalAsrCatalog(raw: unknown): LocalAsrCatalogView {
	const o = (raw ?? {}) as Record<string, unknown>;
	const hw = (o.hardware ?? {}) as Record<string, unknown>;
	const rt = (o.runtime ?? {}) as Record<string, unknown>;
	const models = Array.isArray(o.models) ? (o.models.map(normalizeLocalAsrModel).filter((m): m is LocalAsrModelView => !!m)) : [];
	const tier = asString(hw.tier, "unknown") as LocalAsrTier;
	const ok = Array.isArray(o.models);
	return {
		ok,
		hardware: ok
			? {
					os: asString(hw.os, "unknown"),
					arch: asString(hw.arch, "unknown"),
					cpuCores: asNum(pick(hw, ["cpuCores", "cpu_cores"], 0)),
					memoryBytes: asNum(pick(hw, ["memoryBytes", "memory_bytes"], 0)),
					tier: ["light", "balanced", "high", "unknown"].includes(tier) ? tier : "unknown",
					tierNote: asString(pick(hw, ["tierNote", "tier_note"], "")),
				}
			: emptyHardware(),
		runtime: ok
			? { engine: asString(rt.engine, "sherpa-onnx"), version: asString(rt.version, ""), python: asString(rt.python, ""), depsBytes: asNumOrNull(pick(rt, ["depsBytes", "deps_bytes"], null)), depsNote: asString(pick(rt, ["depsNote", "deps_note"], "")), downloadBytes: asNumOrNull(pick(rt, ["downloadBytes", "download_bytes"], null)), present: asBool(rt.present, false) }
			: emptyRuntimeEnv(),
		recommendedId: (pick(o, ["recommendedId", "recommended_id"], null) as string | null) ?? null,
		models,
		notes: asStrArray(o.notes),
	};
}

/** catalog 不可用时的空结构（UI 显示「不可用」而不是空白/崩溃）。 */
export function emptyLocalAsrCatalog(): LocalAsrCatalogView {
	return { ok: false, hardware: emptyHardware(), runtime: emptyRuntimeEnv(), recommendedId: null, models: [], notes: [] };
}

export async function getLocalAsrCatalog(): Promise<LocalAsrCatalogView> {
	return normalizeLocalAsrCatalog(await api("/api/local-models/asr/catalog"));
}

export interface LocalAsrInstallRequest {
	acceptLicense?: string;
	source?: "download" | "import";
	importDir?: string;
	/** `install_and_use`：装完且选择自开始后未变才写「用本地」来源（服务端 stale 防护）。 */
	intent?: "install" | "install_and_use";
}
export interface LocalAsrActionResponse {
	ok: boolean;
	error?: string;
	message?: string;
	install?: unknown;
}

const post = (id: string, action: string, json?: unknown) => api<LocalAsrActionResponse>(`/api/local-models/asr/models/${encodeURIComponent(id)}/${action}`, { method: "POST", json });

export const installLocalAsrModel = (id: string, body: LocalAsrInstallRequest) => post(id, "install", body);
export const cancelLocalAsrModel = (id: string) => post(id, "cancel");
export const selectLocalAsrModel = (id: string) => post(id, "select");
export const startLocalAsrModel = (id: string) => post(id, "start");
export const stopLocalAsrModel = (id: string) => post(id, "stop");
export const updateLocalAsrModel = (id: string) => post(id, "update");
export const deleteLocalAsrModel = (id: string) => api<LocalAsrActionResponse>(`/api/local-models/asr/models/${encodeURIComponent(id)}`, { method: "DELETE", json: { confirm: true } });

/** 单模型 status（catalog 的子集），轮询用；字段结构同 catalog 里的 model。 */
export async function getLocalAsrModelStatus(id: string): Promise<LocalAsrModelView | null> {
	return normalizeLocalAsrModel(await api(`/api/local-models/asr/models/${encodeURIComponent(id)}/status`));
}
