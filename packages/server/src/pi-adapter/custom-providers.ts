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
import type { PiModels } from "./index.ts";
import { modelDb } from "../model-db.ts";
import { detectLimits, knownVision, type LimitsSource, providerHint, resolveLimits } from "./model-limits.ts";

export interface CustomModel {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	/** 上下文 / 输出长度从哪来：自动识别 / 已知模型 / 默认 / 用户填写（只存在我们的元数据里，不写进 Pi 的 models.json） */
	limitsSource?: LimitsSource;
	/** input 是按 models.dev 自动判断的（是否识图）；用户没填过 input 时每次按最新数据重算（只存在元数据里） */
	inputAuto?: boolean;
}
export interface FetchedModel {
	id: string;
	contextWindow: number;
	maxTokens: number;
	limitsSource: LimitsSource;
}
export interface CustomProviderMeta {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	headerNames: string[];
	noKey: boolean;
	models: CustomModel[];
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
}
export interface CustomStorage {
	loadMeta(): CustomProviderMeta[];
	saveMeta(list: CustomProviderMeta[]): void;
	loadHeaders(id: string): Record<string, string>;
	saveHeaders(id: string, h: Record<string, string> | null): void;
	readKey(id: string): Promise<string | undefined>;
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

		const meta: CustomProviderMeta = {
			id: pid,
			name: input.name.trim(),
			api: input.api,
			baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
			headerNames,
			noKey: !!input.noKey,
			models: input.models.map((m) => this.withLimits({ ...m, id: m.id.trim() }, undefined, input.baseUrl)),
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
		return true;
	}

	/** 补上上下文 / 输出长度（缺哪项补哪项；用户填过的不动） */
	withLimits(m: CustomModel, detected?: { contextWindow?: number; maxTokens?: number }, baseUrl?: string): CustomModel {
		// Pi 内置目录 + models.dev 模型参数库；排除自定义服务自己（否则会拿自己存过的旧值当“已知模型”）
		const own = new Set(this.store.loadMeta().map((x) => x.id));
		const l = resolveLimits(m, detected, [...this.models.listModels().filter((x) => !own.has(x.provider)), ...modelDb()], providerHint(baseUrl));
		const out: CustomModel = { ...m, contextWindow: l.contextWindow, maxTokens: l.maxTokens, limitsSource: l.source };
		// 是否识图：用户没指定 input 时按 models.dev 判断（支持图片的模型 Pi 才会把图片发过去）
		if (!m.input || m.inputAuto) {
			const v = knownVision(m.id, modelDb());
			if (v) Object.assign(out, { input: ["text", "image"], inputAuto: true });
			else (delete out.input, delete out.inputAuto);
		}
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
				const y = keep ? { ...this.withLimits(x, undefined, meta.baseUrl), contextWindow: x.contextWindow, maxTokens: x.maxTokens, limitsSource: x.limitsSource } : this.withLimits(x, undefined, meta.baseUrl);
				if (y.contextWindow !== x.contextWindow || y.maxTokens !== x.maxTokens || y.limitsSource !== x.limitsSource || String(y.input) !== String(x.input)) n++;
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
			const m = this.withLimits({ id }, detectLimits(raw), base);
			seen.set(id, { id, contextWindow: m.contextWindow!, maxTokens: m.maxTokens!, limitsSource: m.limitsSource! });
		}
		if (!seen.size) throw new Error("没有获取到模型，请手动填写");
		return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
	}
}

/** 写进 Pi models.json 的模型条目：去掉我们自己的字段和空值 */
function piModel(m: CustomModel) {
	const { limitsSource: _s, inputAuto: _a, ...rest } = m;
	return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== ""));
}
