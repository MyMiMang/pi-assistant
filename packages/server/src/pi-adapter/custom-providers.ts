/**
 * 自定义模型服务（中转站 / 第三方 / 本地推理服务），完全走 Pi 自己的 models.json 机制：
 *  - 结构（name / api / baseUrl / headers / models）写入 Pi 的 models.json，由 Pi 解析与校验；
 *  - API Key 不写进 models.json，而是通过 Pi 的通用登录写进加密凭据存储（Pi 的凭据优先级高于 models.json 的 apiKey）；
 *  - 自定义请求头的值同样加密保存，models.json 里只写 `${PIA_H_xxx}`（Pi 原生的环境变量插值），
 *    启动时在本进程内注入；沙箱子进程会清掉所有 PIA_* 变量。
 * 支持的 API 类型来自 pi-ai 的 API 注册表，Pi 新增协议后自动可选。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getApiProviders } from "@earendil-works/pi-ai/compat";
import type { ClassifierChatModel, ClassifierDeclaration, PiModels } from "./index.ts";
import { isClassifierProtocol } from "./index.ts";
import type { ModelCapability } from "../model-registry.ts";
import { localModelHint } from "../local-models.ts";
import { modelDb } from "../model-db.ts";
import { detectLimits, knownReasoning, knownThinkingLevelMap, knownVision, type LimitsSource, providerHint, resolveLimits } from "./model-limits.ts";

export interface CustomModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	/** 自动识别的推理能力，刷新参数库时可以重算。 */
	reasoningAuto?: boolean;
	/** 思考档位映射：按模型名照搬 Pi 内置目录里同一个模型的元数据（含 xhigh / max），认不出来就不写 */
	thinkingLevelMap?: Record<string, string | null>;
	/** 上面映射的来源（`provider:id@api`，Pi 内置目录条目）；只作记录，不写进 Pi 的 models.json */
	thinkingLevelSource?: string;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	/** 上下文 / 输出长度从哪来：自动识别 / 已知模型 / 默认 / 用户填写（只存在我们的元数据里，不写进 Pi 的 models.json） */
	limitsSource?: LimitsSource;
	/** input 是按 models.dev 自动判断的（是否识图）；用户没填过 input 时每次按最新数据重算（只存在元数据里） */
	inputAuto?: boolean;
	/**
	 * 显式声明的能力（chat / vision / image / classifier）。留给统一注册表与“手动设能力”用；
	 * 不写就按 input 元数据推导。只存在我们的元数据里，不写进 Pi 的 models.json。
	 */
	capabilities?: ModelCapability[];
	/** 对端 `/models` 明确标注的操作类型（目前只有 classifier）。只存在元数据里，不写进 models.json。 */
	detectedType?: "classifier";
	/** 该模型作为 classifier 的协议：来自对端元数据（api / protocol 字段）或 Pi 官方目录同 id 匹配。 */
	classifierProtocol?: string;
}
export interface FetchedModel {
	id: string;
	reasoning?: boolean;
	contextWindow: number;
	maxTokens: number;
	limitsSource: LimitsSource;
	/** 对端 `/models` 明确标注为 classifier（可靠，不靠名字猜） */
	detectedType?: "classifier";
	/** 对端 `/models` 给出的 classifier 协议（可靠） */
	classifierProtocol?: string;
}
export interface CustomProviderMeta {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	headerNames: string[];
	noKey: boolean;
	models: CustomModel[];
	/** 该服务公开声明的 classifier（协议 + 模型 id）；只存元数据，凭据仍走 Pi 原 provider 的登录保存 */
	classifiers?: ClassifierDeclaration[];
	/** 保存 / 启动时按可靠来源自动识别的 classifier（对端元数据或 Pi 官方目录同 id）；与 classifiers 合并后注册 */
	discoveredClassifiers?: ClassifierDeclaration[];
	createdAt: number;
}
export interface CustomProviderInput {
	name: string;
	api: string;
	baseUrl: string;
	/** undefined/空 = 保持原 Key 不变 */
	apiKey?: string;
	noKey?: boolean;
	/** value 为 undefined 表示保持原值 */
	headers?: { name: string; value?: string }[];
	models: CustomModel[];
	/** 不传 = 保持原有 classifier 不变；传 [] 表示清空 */
	classifiers?: ClassifierDeclaration[];
}
export interface CustomStorage {
	loadMeta(): CustomProviderMeta[];
	saveMeta(list: CustomProviderMeta[]): void;
	loadHeaders(id: string): Record<string, string>;
	saveHeaders(id: string, h: Record<string, string> | null): void;
	readKey(id: string): Promise<string | undefined>;
	/** 快速操作模型引用的 classifier（按电脑 scope 各一份；只读/清空 provider + id，避免 pi-adapter 反向依赖业务模块） */
	loadFastReferences(): { storageKey: string; kind?: string; provider: string; id: string }[];
	saveFastReference(ref: { provider: string; id: string }, storageKey?: string): void;
}

/** 规范化 classifier 声明：去空白、去空项、去重，只留公开字段。 */
export const MODEL_CAPABILITIES: readonly ModelCapability[] = ["chat", "vision", "image", "classifier", "asr"];

/** 从服务端 /models 返回的条目里读可靠的输入模态（是否识图）；读不到返回 undefined（不猜）。 */
export function detectInput(raw: Record<string, unknown>): ("text" | "image")[] | undefined {
	const direct = raw.input ?? (raw.capabilities as { input?: unknown } | undefined)?.input;
	if (Array.isArray(direct)) {
		const arr = direct.filter((x): x is "text" | "image" => x === "text" || x === "image");
		if (arr.length) return arr.includes("image") ? ["text", "image"] : ["text"];
	}
	const mods = (raw.modalities as { input?: unknown } | undefined)?.input ?? (raw.architecture as { input_modalities?: unknown } | undefined)?.input_modalities;
	if (Array.isArray(mods) && mods.length) return mods.includes("image") ? ["text", "image"] : ["text"];
	return undefined;
}

/** 用户显式声明 + 自动识别的有效 classifier（同一模型 id 以显式声明为准）。 */
export function effectiveClassifiers(meta: Pick<CustomProviderMeta, "classifiers" | "discoveredClassifiers">): ClassifierDeclaration[] {
	const declared = normalizeClassifiers(meta.classifiers);
	const declaredIds = new Set(declared.map((c) => c.modelId));
	return [...declared, ...normalizeClassifiers(meta.discoveredClassifiers).filter((c) => !declaredIds.has(c.modelId))];
}

/** 从服务端 `/models` 单条元数据里读可靠的 classifier 信息；读不到返回 {}（绝不按名字猜）。 */
export function detectClassifierMetadata(raw: Record<string, unknown>): { detectedType?: "classifier"; classifierProtocol?: string } {
	let detectedType: "classifier" | undefined;
	for (const k of ["type", "model_type", "modelType", "kind"] as const) if (raw[k] === "classifier") detectedType = "classifier";
	const proto = raw.api ?? raw.protocol ?? raw.protocol_type ?? raw.classifier_protocol;
	const classifierProtocol = isClassifierProtocol(proto) ? proto : undefined;
	if (classifierProtocol) detectedType = "classifier";
	const caps = raw.capabilities;
	if (Array.isArray(caps) && caps.includes("classifier")) detectedType = "classifier";
	else if (caps && typeof caps === "object" && ((caps as { type?: unknown }).type === "classifier" || (caps as { classifier?: unknown }).classifier === true)) detectedType = "classifier";
	return { ...(detectedType ? { detectedType } : {}), ...(classifierProtocol ? { classifierProtocol } : {}) };
}

export function normalizeClassifiers(list: ClassifierDeclaration[] | undefined): ClassifierDeclaration[] {
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const out: ClassifierDeclaration[] = [];
	for (const c of list) {
		const protocol = typeof c?.protocol === "string" ? c.protocol.trim() : "";
		const modelId = typeof c?.modelId === "string" ? c.modelId.trim() : "";
		if (!protocol || !modelId || seen.has(`${protocol}/${modelId}`)) continue;
		seen.add(`${protocol}/${modelId}`);
		out.push({ protocol, modelId, ...(c.name?.trim() ? { name: c.name.trim() } : {}), ...(typeof c.contextWindow === "number" ? { contextWindow: c.contextWindow } : {}) });
	}
	return out;
}

/** 常用协议的友好名称；其余直接显示 Pi 的 API id。 */
const API_LABELS: Record<string, string> = {
	"openai-completions": "OpenAI 兼容（Chat Completions）—— 大多数中转站 / Ollama / vLLM",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic 兼容（Messages）",
	"google-generative-ai": "Google Gemini 兼容",
	"mistral-conversations": "Mistral",
	"azure-openai-responses": "Azure OpenAI",
	"bedrock-converse-stream": "Amazon Bedrock",
	"google-vertex": "Google Vertex AI",
};
const HIDDEN_APIS = new Set(["openai-codex-responses", "pi-messages"]); // 需要专用登录，不适合手填

export function supportedApis(): { id: string; label: string }[] {
	const ids = getApiProviders().map((a) => (a as { api: string }).api).filter((a) => !HIDDEN_APIS.has(a));
	const order = Object.keys(API_LABELS);
	return [...new Set(ids)]
		.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
		.map((id) => ({ id, label: API_LABELS[id] ?? id }));
}

const envName = (id: string, i: number) => `PIA_H_${createHash("sha256").update(id).digest("hex").slice(0, 10).toUpperCase()}_${i}`;
export function slugId(name: string, taken: Set<string>): string {
	// 中文等非拉丁名字转不出 slug：用名字的哈希，保证不同名字的自定义服务 id 不同（以前都会变成 custom-provider 互相覆盖）
	const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	const base = `custom-${slug || createHash("sha256").update(name.trim()).digest("hex").slice(0, 8)}`;
	let id = base;
	for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
	return id;
}

export class CustomProviders {
	/** 本进程内注册过扩展 layer 的 provider（classifier 被清空时需要摘掉）。 */
	private extended = new Set<string>();

	constructor(
		private models: PiModels,
		private modelsPath: string,
		private store: CustomStorage,
	) {}

	list(): (CustomProviderMeta & { configured: boolean })[] {
		const status = new Map(this.models.listProviders().map((p) => [p.id, p.configured]));
		return this.store.loadMeta().map((m) => ({ ...m, configured: m.noKey || !!status.get(m.id) }));
	}
	isCustom(id: string) {
		return this.store.loadMeta().some((m) => m.id === id);
	}

	/** 手动设置某个自定义模型的能力（只改我们的元数据，不写进 Pi 的 models.json）。 */
	setModelCapabilities(id: string, modelId: string, capabilities: ModelCapability[]): CustomProviderMeta {
		const metas = this.store.loadMeta();
		const meta = metas.find((m) => m.id === id);
		if (!meta) throw new Error("自定义服务不存在");
		if (!meta.models.some((m) => m.id === modelId)) throw new Error("模型不存在");
		const next: CustomProviderMeta = { ...meta, models: meta.models.map((m) => (m.id === modelId ? { ...m, capabilities } : m)) };
		next.discoveredClassifiers = this.discoverClassifiers(next);
		this.store.saveMeta(metas.map((m) => (m.id === id ? next : m)));
		// 用户显式把模型标为 classifier 时，只要协议可确定就同步注册进 Pi（否则保持未确认，不伪造可调用）。
		this.reapplyClassifiers();
		return next;
	}

	/**
	 * Pi 内置目录里的 classifier 模型 id → 协议（排除本项目注册的自定义 / 本地 provider，避免自污染）；
	 * 同名模型在不同内置 provider 指向不同协议时视为歧义，丢弃（fail-closed，不猜）。
	 */
	canonicalClassifierProtocols(): Map<string, string> {
		const own = new Set(this.store.loadMeta().map((m) => m.id));
		const seen = new Map<string, string | null>();
		for (const p of this.models.listProviders()) {
			if (own.has(p.id) || localModelHint(p.id)) continue;
			for (const m of this.models.listClassifierModels(p.id)) {
				const cur = seen.get(m.id);
				if (cur === undefined) seen.set(m.id, m.api);
				else if (cur !== m.api) seen.set(m.id, null);
			}
		}
		const out = new Map<string, string>();
		for (const [id, proto] of seen) if (proto) out.set(id, proto);
		return out;
	}

	/**
	 * 按**可靠来源**自动识别一个服务的 classifier，不靠名字或付费探测：
	 *  - 对端 `/models` 明确给出 type/api/capabilities=classifier（`detectedType` / `classifierProtocol`）；
	 *  - 用户把模型显式标为 classifier 能力；
	 *  - 模型 id 与 Pi 官方目录里的 canonical classifier **完全相同**（协议一并取自官方目录）。
	 * 协议无法确定的一律不产出（宁可不注册，也不向未知端点乱发可调用请求）。
	 */
	discoverClassifiers(meta: Pick<CustomProviderMeta, "models" | "classifiers">): ClassifierDeclaration[] {
		const canonical = this.canonicalClassifierProtocols();
		const declaredIds = new Set(normalizeClassifiers(meta.classifiers).map((c) => c.modelId));
		const out: ClassifierDeclaration[] = [];
		for (const m of meta.models) {
			if (declaredIds.has(m.id)) continue; // 用户显式声明优先
			const explicitProto = isClassifierProtocol(m.classifierProtocol) ? m.classifierProtocol : undefined;
			// 用户显式改过能力且不含 classifier（无其他可靠信号）→ 尊重用户纠正，不做 canonical 自动识别。
			if (m.capabilities?.length && !m.capabilities.includes("classifier") && !explicitProto && m.detectedType !== "classifier") continue;
			const canonicalProto = canonical.get(m.id);
			const protocol = explicitProto ?? canonicalProto;
			// 官方目录里的协议本层未必有公开实现（如 openai-decisions）：不支持就不注册，fail-closed。
			if (!protocol || !isClassifierProtocol(protocol)) continue;
			const explicit = m.detectedType === "classifier" || !!explicitProto || (m.capabilities ?? []).includes("classifier");
			if (!canonicalProto && !explicit) continue;
			out.push({ protocol, modelId: m.id, ...(m.name ? { name: m.name } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) });
		}
		return out;
	}

	/** 启动时把加密保存的请求头值注入本进程环境变量，供 models.json 插值。 */
	applyEnv() {
		// 迁移：旧版本写入的 ${HUHAO_H_…} 插值改为 ${PIA_H_…}
		if (existsSync(this.modelsPath)) {
			const raw = readFileSync(this.modelsPath, "utf8");
			if (raw.includes("${HUHAO_H_")) writeFileSync(this.modelsPath, raw.replaceAll("${HUHAO_H_", "${PIA_H_"), { mode: 0o600 });
		}
		for (const m of this.store.loadMeta()) {
			const h = this.store.loadHeaders(m.id);
			m.headerNames.forEach((name, i) => {
				if (h[name] !== undefined) process.env[envName(m.id, i)] = h[name];
			});
		}
	}

	private readFile(): { providers?: Record<string, unknown>; [k: string]: unknown } {
		if (!existsSync(this.modelsPath)) return { providers: {} };
		try {
			return JSON.parse(readFileSync(this.modelsPath, "utf8"));
		} catch {
			return { providers: {} };
		}
	}
	private writeFile(cfg: object) {
		const tmp = `${this.modelsPath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.modelsPath);
	}

	validate(input: CustomProviderInput): string | null {
		if (!input.name?.trim()) return "请填写名称";
		if (!supportedApis().some((a) => a.id === input.api)) return "不支持的 API 类型";
		try {
			const u = new URL(input.baseUrl);
			if (!/^https?:$/.test(u.protocol)) return "Base URL 必须以 http:// 或 https:// 开头";
		} catch {
			return "Base URL 格式不正确";
		}
		if (!input.models?.length) return "至少添加一个模型（可点“自动获取”）";
		const ids = input.models.map((m) => m.id.trim());
		if (ids.some((x) => !x)) return "模型 ID 不能为空";
		if (new Set(ids).size !== ids.length) return "模型 ID 重复";
		for (const h of input.headers ?? []) if (!/^[A-Za-z0-9-]+$/.test(h.name)) return `请求头名称不合法：${h.name}`;
		for (const m of input.models) for (const cap of m.capabilities ?? []) if (!MODEL_CAPABILITIES.includes(cap)) return `不支持的模型能力：${cap}`;
		for (const c of input.classifiers ?? []) {
			if (!isClassifierProtocol(c.protocol)) return `不支持的 classifier 协议：${c.protocol}`;
			if (!c.modelId?.trim()) return "classifier 模型 ID 不能为空";
		}
		const cids = (input.classifiers ?? []).map((c) => `${c.protocol}/${c.modelId.trim()}`);
		if (new Set(cids).size !== cids.length) return "classifier（协议 + 模型 ID）重复";
		return null;
	}

	async save(id: string | null, input: CustomProviderInput): Promise<CustomProviderMeta> {
		const err = this.validate(input);
		if (err) throw new Error(err);
		const metas = this.store.loadMeta();
		const builtin = new Set(this.models.listProviders().map((p) => p.id));
		const existing = id ? metas.find((m) => m.id === id) : undefined;
		if (id && !existing) throw new Error("自定义服务不存在");
		const pid = existing?.id ?? slugId(input.name, new Set([...builtin, ...metas.map((m) => m.id)]));

		// 请求头：新值覆盖，undefined 保留旧值
		const oldHeaders = existing ? this.store.loadHeaders(pid) : {};
		const headers: Record<string, string> = {};
		for (const h of input.headers ?? []) {
			const v = h.value ?? oldHeaders[h.name];
			if (v !== undefined) headers[h.name] = v;
		}
		const headerNames = Object.keys(headers);
		this.store.saveHeaders(pid, headerNames.length ? headers : null);
		headerNames.forEach((name, i) => (process.env[envName(pid, i)] = headers[name]));

		const models = input.models.map((m) => this.withLimits({ ...m, id: m.id.trim() }, undefined, input.baseUrl, input.api));
		const declared = normalizeClassifiers(input.classifiers === undefined ? existing?.classifiers : input.classifiers);
		const meta: CustomProviderMeta = {
			id: pid,
			name: input.name.trim(),
			api: input.api,
			baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
			headerNames,
			noKey: !!input.noKey,
			models,
			// 不传就保留原有 classifier（与 Key / 请求头一致的“留空不改”语义）；传 [] 清空。
			classifiers: declared,
			// 可靠来源自动识别的 classifier（对端元数据 / 官方同 id）；与 classifiers 合并后注册。
			discoveredClassifiers: this.discoverClassifiers({ models, classifiers: declared }),
			createdAt: existing?.createdAt ?? Date.now(),
		};
		// 写入 Pi 的 models.json（保留用户手写的其它 provider）
		const cfg = this.readFile();
		cfg.providers = { ...(cfg.providers ?? {}) };
		cfg.providers[pid] = {
			name: meta.name,
			baseUrl: meta.baseUrl,
			api: meta.api,
			...(meta.noKey ? { apiKey: "not-needed" } : {}),
			...(headerNames.length ? { headers: Object.fromEntries(headerNames.map((n, i) => [n, `\${${envName(pid, i)}}`])) } : {}),
			models: meta.models.map(piModel),
		};
		this.writeFile(cfg);
		this.store.saveMeta([...metas.filter((m) => m.id !== pid), meta]);
		await this.models.reloadConfig();
		// Pi 的 refresh 与上一次注册触发的后台刷新可能竞态，刚写入的 provider 偶尔还没进目录；
		// 登录前确认一次，避免「保存自定义服务偶发 Unknown provider」。
		if (!this.models.listProviders().some((p) => p.id === pid)) await this.models.reloadConfig();
		// reload 会用 models.json 重组 provider，扩展层里的 chat/classifier 要按最新元数据重建。
		this.reapplyClassifiers();

		// API Key 走 Pi 的通用登录 → 写入加密凭据存储
		if (meta.noKey) await this.models.logout(pid).catch(() => {});
		else if (input.apiKey?.trim()) {
			const key = input.apiKey.trim();
			await this.models.login(pid, "api_key", {
				prompt: async (p) => (p.type === "select" ? (p.options[0]?.id ?? "") : key),
				notify: () => {},
			});
		}
		return meta;
	}

	async remove(id: string) {
		const metas = this.store.loadMeta();
		if (!metas.some((m) => m.id === id)) return false;
		const cfg = this.readFile();
		if (cfg.providers) delete cfg.providers[id];
		this.writeFile(cfg);
		this.store.saveMeta(metas.filter((m) => m.id !== id));
		this.store.saveHeaders(id, null);
		await this.models.logout(id).catch(() => {});
		await this.models.reloadConfig();
		// 服务已从元数据移除：reapply 会摘掉它的扩展层并清悬空的快速操作引用。
		this.reapplyClassifiers();
		return true;
	}

	/**
	 * 启动 / reload 后按保存的公开元数据重新注册 classifier。
	 * 凭据仍由 Pi 按原 provider 解析（request-time），本方法不读 key、不换 baseURL。
	 * chat 模型同时从元数据重建（扩展层会整体替换 models.json 的模型列表）。
	 */
	reapplyClassifiers() {
		const want = new Set<string>();
		for (const meta of this.store.loadMeta()) {
			const classifiers = effectiveClassifiers(meta);
			if (!classifiers.length) continue;
			want.add(meta.id);
			try {
				this.models.registerClassifiers(meta.id, classifiers, { baseUrl: meta.baseUrl, chatModels: meta.models.map((m) => chatModelFromMeta(meta, m)) });
			} catch (e) {
				console.error(`[models] 重新注册 ${meta.id} 的 classifier 失败`, e);
			}
		}
		// classifier 被清空的服务要摘掉扩展层，否则扩展会一直遮蔽 models.json 里的模型更新。
		for (const id of this.extended) if (!want.has(id)) this.models.unregisterProvider(id);
		this.extended = want;
		this.reconcileFastReference();
	}

	/** 快速操作模型引用的 classifier 已不存在（服务被编辑 / classifier 被移除）时清掉引用，不留悬空（每台电脑 scope 各清各的）。 */
	private reconcileFastReference() {
		for (const s of this.store.loadFastReferences()) {
			if (!s || s.kind !== "systemone" || !s.provider || !s.id) continue;
			if (this.models.listClassifierModels(s.provider).some((m) => m.id === s.id)) continue;
			// 本地服务（如 local-laya）可能只是暂时停止（stop 会把它从 classifier 目录摘掉），
			// 只要它仍是已知的已安装本地服务，就保留引用，不自动清掉 / 不删模型，只算「暂不可调用」。
			if (localModelHint(s.provider)) continue;
			this.store.saveFastReference({ provider: "", id: "" }, s.storageKey);
		}
	}

	/** 补上上下文 / 输出长度（缺哪项补哪项；用户填过的不动） */
	withLimits(m: CustomModel, detected?: { contextWindow?: number; maxTokens?: number }, baseUrl?: string, api?: string): CustomModel {
		// Pi 内置目录 + models.dev 模型参数库；排除自定义服务自己（否则会拿自己存过的旧值当“已知模型”）
		const own = new Set(this.store.loadMeta().map((x) => x.id));
		const builtin = [...this.models.listModels().filter((x) => !own.has(x.provider)), ...modelDb()];
		const l = resolveLimits(m, detected, builtin, providerHint(baseUrl));
		const out: CustomModel = { ...m, contextWindow: l.contextWindow, maxTokens: l.maxTokens, limitsSource: l.source };
		// 是否识图：用户没指定 input 时按 models.dev 判断（支持图片的模型 Pi 才会把图片发过去）
		if (!m.input || m.inputAuto) {
			const v = knownVision(m.id, modelDb());
			if (v) Object.assign(out, { input: ["text", "image"], inputAuto: true });
			else (delete out.input, delete out.inputAuto);
		}
		if (m.reasoning === undefined || m.reasoningAuto) {
			const reasoning = knownReasoning(m.id, modelDb()) ?? knownReasoning(m.id, this.models.listModels().filter((x) => !own.has(x.provider)));
			if (reasoning !== undefined) Object.assign(out, { reasoning, reasoningAuto: true });
		}
		// 思考档位：照搬 Pi 内置目录里同一个模型的 thinkingLevelMap（含 xhigh / max），让界面、切换与请求参数一致；
		// 认不出来（模型名不标准 / 目录里没有）或候选映射有歧义就不写，保持 Pi 的默认档位，不凭空补；
		// 同时记录来源，如实标明这是 Pi 目录元数据、不是对中转站真实支持的断言。
		const known = out.reasoning ? knownThinkingLevelMap(m.id, builtin, api) : undefined;
		if (known) Object.assign(out, { thinkingLevelMap: known.map, thinkingLevelSource: known.source });
		else (delete out.thinkingLevelMap, delete out.thinkingLevelSource);
		return out;
	}

	/** 请求被拒后学到的真实上限（自动学习）：写回并重载，之后的请求按它发；手动填过的不动 */
	async learnLimits(providerId: string, modelId: string, l: { contextWindow?: number; maxTokens?: number }) {
		const metas = this.store.loadMeta();
		const meta = metas.find((x) => x.id === providerId);
		const m = meta?.models.find((x) => x.id === modelId);
		if (!meta || !m || m.limitsSource === "user") return false;
		Object.assign(m, { contextWindow: l.contextWindow ?? m.contextWindow, maxTokens: l.maxTokens ?? m.maxTokens, limitsSource: "learned" as const });
		const cfg = this.readFile();
		const p = cfg.providers?.[meta.id];
		if (p) (p as { models?: unknown }).models = meta.models.map(piModel);
		this.store.saveMeta(metas);
		this.writeFile(cfg);
		await this.models.reloadConfig();
		return true;
	}

	/** 启动时补齐缺失的上下文 / 输出长度，并按最新规则重算“已知 / 默认”的值，有变化才写回 models.json（Pi 的上下文用量和自动压缩靠它） */
	async backfillLimits() {
		const metas = this.store.loadMeta();
		let n = 0;
		const next = metas.map((meta) => {
			const models = meta.models.map((x) => {
				const keep = x.contextWindow && x.maxTokens && (x.limitsSource === "user" || x.limitsSource === "detected" || x.limitsSource === "learned");
				const y = keep ? { ...this.withLimits(x, undefined, meta.baseUrl, meta.api), contextWindow: x.contextWindow, maxTokens: x.maxTokens, limitsSource: x.limitsSource } : this.withLimits(x, undefined, meta.baseUrl, meta.api);
				if (y.contextWindow !== x.contextWindow || y.maxTokens !== x.maxTokens || y.limitsSource !== x.limitsSource || String(y.input) !== String(x.input) || y.reasoning !== x.reasoning || JSON.stringify(y.thinkingLevelMap ?? null) !== JSON.stringify(x.thinkingLevelMap ?? null) || (y.thinkingLevelSource ?? null) !== (x.thinkingLevelSource ?? null)) n++;
				return y;
			});
			return { ...meta, models };
		});
		if (!n) return 0;
		const cfg = this.readFile();
		for (const meta of next) {
			const p = cfg.providers?.[meta.id];
			if (p) (p as { models?: unknown }).models = meta.models.map(piModel);
		}
		this.store.saveMeta(next);
		this.writeFile(cfg);
		await this.models.reloadConfig();
		return n;
	}

	/** 通过服务的模型列表接口自动获取模型（OpenAI / Anthropic / Gemini 风格），顺带识别上下文 / 输出长度。 */
	async fetchModels(o: { id?: string; api: string; baseUrl: string; apiKey?: string; headers?: { name: string; value?: string }[] }): Promise<FetchedModel[]> {
		const base = o.baseUrl.trim().replace(/\/+$/, "");
		const key = o.apiKey?.trim() || (o.id ? await this.store.readKey(o.id) : undefined) || "";
		const old = o.id ? this.store.loadHeaders(o.id) : {};
		const h: Record<string, string> = {};
		for (const x of o.headers ?? []) {
			const v = x.value ?? old[x.name];
			if (v !== undefined) h[x.name] = v;
		}
		let url = `${base}/models`;
		if (o.api === "anthropic-messages") {
			url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
			if (key) h["x-api-key"] = key;
			h["anthropic-version"] ??= "2023-06-01";
		} else if (o.api.startsWith("google")) {
			if (key) h["x-goog-api-key"] = key;
		} else if (key) h.authorization = `Bearer ${key}`;
		const res = await fetch(url, { headers: h, signal: AbortSignal.timeout(15_000) });
		const text = await res.text();
		if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`);
		let j: { data?: Record<string, unknown>[]; models?: Record<string, unknown>[] };
		try {
			j = JSON.parse(text);
		} catch {
			throw new Error("返回的不是 JSON，可能不支持模型列表接口，请手动填写");
		}
		const seen = new Map<string, FetchedModel>();
		for (const raw of j.data ?? j.models ?? []) {
			const id = String(raw.id ?? raw.name ?? "").replace(/^models\//, "");
			if (!id || seen.has(id)) continue;
			const input = detectInput(raw);
			const cls = detectClassifierMetadata(raw);
			const m = this.withLimits(
				{ id, ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}), ...(input ? { input } : {}), ...cls },
				detectLimits(raw),
				base,
				o.api,
			);
			seen.set(id, { id, ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}), contextWindow: m.contextWindow!, maxTokens: m.maxTokens!, limitsSource: m.limitsSource!, ...(m.detectedType ? { detectedType: m.detectedType } : {}), ...(m.classifierProtocol ? { classifierProtocol: m.classifierProtocol } : {}) });
		}
		if (!seen.size) throw new Error("没有获取到模型，请手动填写");
		return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
	}
}

/** 把持久化元数据里的 chat 模型映射成注册 classifier 时要一并重建的模型。 */
function chatModelFromMeta(meta: CustomProviderMeta, m: CustomModel): ClassifierChatModel {
	return { id: m.id, name: m.name, api: meta.api, baseUrl: meta.baseUrl, input: m.input, reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens, thinkingLevelMap: m.thinkingLevelMap };
}

/** 写进 Pi models.json 的模型条目：去掉我们自己的字段和空值 */
function piModel(m: CustomModel) {
	const { limitsSource: _s, inputAuto: _a, reasoningAuto: _r, thinkingLevelSource: _t, capabilities: _c, detectedType: _d, classifierProtocol: _p, ...rest } = m;
	return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== ""));
}
