/**
 * pi-adapter —— 本项目中唯一直接 import Pi 运行时代码的模块。
 *
 * 规则：server 其余代码只能通过这里导出的函数/类型使用 Pi。
 * Pi 升级出现 API 变化时，只需要改这个目录（以及 packages/ext-* 里的扩展，它们只依赖 Pi 的 ExtensionAPI 类型）。
 */
import { learnFromError } from "./model-limits.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	createBashTool,
	createLocalBashOperations,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type BashOperations,
	type ExtensionAPI,
	type ExtensionFactory,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ClassifierAnswer, ClassifierContext, CredentialStore } from "@earendil-works/pi-ai";
// 官方公开子路径：原生 System One 传输实现（与内建 typesafe / openrouter classifier 同一实现）。
import { classify as systemOneClassify } from "@earendil-works/pi-ai/api/typesafe-system-one";
// 其它公开 classifier 协议实现（本地 llama-server / Cloudflare Workers AI）；自定义服务可显式声明用哪个。
import { classify as cloudflareSystemOneClassify } from "@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one";
import { classify as llamaCppClassify } from "@earendil-works/pi-ai/api/llama-cpp-classify";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import compat from "./compat.json" with { type: "json" };
import { BRAND } from "@pi-assistant/shared";

export { defineTool, Type };
export type { AgentSession, AgentSessionEvent, BashOperations, ExtensionAPI, ExtensionFactory, ToolDefinition, CredentialStore };
// classifier（System One / Jev）的官方类型：server 只经这里使用 Pi，业务侧按官方结构传参
// ClassifierQuestion / ClassifierResult 直接复用 Pi 的定义，不再自造一套。
export type { ClassifierAnswer, ClassifierContext, ClassifierQuestion, ClassifierResult } from "@earendil-works/pi-ai";

/**
 * 可由自定义服务声明的 classifier 协议（pi-ai 的公开 ClassifierApi）。
 * 只登记**公开子路径导出**的实现；不在这里的协议一律拒绝，不猜、不硬编码其它内部实现。
 */
// biome-ignore lint/suspicious/noExplicitAny: 各协议的 ClassifierFunction 泛型参数不同，这里只按协议名做查表
const CLASSIFIER_PROTOCOLS: Record<string, any> = {
	"typesafe-system-one": systemOneClassify,
	"cloudflare-workers-ai-system-one": cloudflareSystemOneClassify,
	"llama-cpp-classify": llamaCppClassify,
};
/** 协议 id 列表（给界面/接口展示，顺序即注册顺序）。 */
export const classifierProtocols = (): string[] => Object.keys(CLASSIFIER_PROTOCOLS);
export const isClassifierProtocol = (v: unknown): v is string => typeof v === "string" && Object.prototype.hasOwnProperty.call(CLASSIFIER_PROTOCOLS, v);

/** Pi 元数据里某个模型支持的思考档位（唯一能力来源：模型目录、界面下拉、clamp 都用这一份）。 */
const supportedThinkingLevels = (m: Model<Api>): string[] => getSupportedThinkingLevels(m);

/** 一个自定义服务声明的 classifier：协议 + 对端模型 id（只含公开元数据，不含 baseUrl / 凭据）。 */
export interface ClassifierDeclaration {
	protocol: string;
	modelId: string;
	name?: string;
	contextWindow?: number;
}

/** 注册 classifier 时一并带上的 chat 模型（来自持久化元数据，避免扩展层遮蔽 models.json 的更新）。 */
export interface ClassifierChatModel {
	id: string;
	name?: string;
	api: string;
	baseUrl?: string;
	input?: string[];
	cost?: unknown;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: unknown;
}

/** Pi 内置的“本机 bash”执行后端（给 ext-sandbox 在 Docker 偏好下切回主机时注入；扩展不直接依赖 Pi 运行时代码） */
export function localBashOperations(): BashOperations {
	return createLocalBashOperations();
}


export function piVersion(): string {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		return JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")).version as string;
	} catch {
		return "unknown";
	}
}

/** 版本兼容检查：返回已安装 Pi 版本与经过测试的版本范围（主版本号一致即认为兼容）。 */
export function checkPiCompat(): { version: string; testedWith: string; compatible: boolean; message: string } {
	const version = piVersion();
	const testedWith = compat.testedWith;
	const major = (v: string) => v.split(".")[0];
	const compatible = major(version) === major(testedWith);
	return {
		version,
		testedWith,
		compatible,
		message: compatible
			? `Pi ${version}（测试基线 ${testedWith}）`
			: `Pi ${version} 与测试基线 ${testedWith} 主版本不同，可能存在不兼容，请运行兼容性测试`,
	};
}

// ---------------------------------------------------------------- 模型与凭据

export interface ProviderInfo {
	id: string;
	name: string;
	apiKey?: { name: string };
	oauth?: { name: string; isSubscription: boolean; loginLabel?: string };
	modelCount: number;
	configured: boolean;
	source?: string;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	/** 这个模型支持的思考强度（Pi 的模型元数据；不支持推理时只有 "off"） */
	thinking: string[];
	/** Pi 的思考档位映射；自定义服务补全能力时参考（界面只用 thinking） */
	thinkingLevelMap?: Record<string, string | null>;
	/** Pi 的协议类型；自定义服务补全能力时优先同协议 */
	api?: string;
	input: string[];
	contextWindow?: number;
	maxTokens?: number;
}

/** classifier 模型的安全元数据（不含 baseUrl / headers / 凭据）。 */
export interface ClassifierModelInfo {
	provider: string;
	id: string;
	name: string;
	api: string;
	input: string[];
	contextWindow: number;
	/** 该 provider 是否已配置认证（只看状态，不暴露凭据内容） */
	configured: boolean;
}

/** 分类请求的受限参数：不允许调用方注入 apiKey / headers / fetch，鉴权一律交给 Pi 的 request-time 解析。 */
export interface ClassifierCallOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	temperature?: number;
}

/** 中性分类结果：只含答案与用量，绝不带 headers / 凭据；errorMessage 已脱敏。 */
export interface ClassifierOutcome {
	provider: string;
	model: string;
	api: string;
	answers: Record<string, ClassifierAnswer>;
	/** 服务只报 token 数时给出；cost 缺失表示价格未知（不是 0，也不代表免费） */
	usage?: { input: number; output: number; totalTokens: number; cost?: number };
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	timestamp: number;
}

/**
 * 错误信息脱敏：provider 报错常把响应体原样带出（可能含请求头 / key）。
 * 这里统一抹掉 Bearer 凭据、key/token/secret 字段和超长疑似密钥串，再对外返回。
 */
function redactSecrets(text: string): string {
	return text
		.replace(/(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [已隐藏]")
		.replace(/(api[_-]?key|access[_-]?token|authorization|secret|token)["']?\s*[:=]\s*["']?[^\s"',;}]+/gi, "$1=[已隐藏]")
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[已隐藏]");
}

/** 只提取服务的可读错误字段；在落库/展示前脱敏，不把响应头或整份对象当错误显示。 */
export function modelErrorMessage(error: unknown, fallback = "模型请求失败，服务未提供具体原因"): string {
	const collect = (value: unknown, depth = 0): string[] => {
		if (depth > 3 || value == null) return [];
		if (typeof value === "string") return value.trim() ? [value.trim()] : [];
		if (typeof value !== "object" || Array.isArray(value)) return [];
		const e = value as { message?: unknown; errorMessage?: unknown; error?: unknown; code?: unknown; type?: unknown };
		return [e.code, e.type, e.message, e.errorMessage, e.error].flatMap((field) => collect(field, depth + 1));
	};
	const text = [...new Set(collect(error))].join(" · ");
	return redactSecrets(text || fallback).slice(0, 4000);
}

export type LoginPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };
export type LoginEvent =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
	| { type: "progress"; message: string };
export interface LoginInteraction {
	signal?: AbortSignal;
	prompt(p: LoginPrompt): Promise<string>;
	notify(e: LoginEvent): void;
}

export class PiModels {
	private constructor(readonly runtime: ModelRuntime) {}

	static async create(opts: { credentials: CredentialStore; modelsPath: string | null; allowNetwork?: boolean }) {
		const runtime = await ModelRuntime.create({
			credentials: opts.credentials,
			modelsPath: opts.modelsPath,
			allowModelNetwork: opts.allowNetwork ?? false,
			refreshOnCreate: opts.allowNetwork ?? false,
		});
		return new PiModels(runtime);
	}

	/** 完全由 Pi 的 provider 目录驱动：Pi 新增 provider 后这里自动出现。 */
	listProviders(): ProviderInfo[] {
		return this.runtime.getProviders().map((p) => {
			const status = this.runtime.getProviderAuthStatus(p.id) as { configured: boolean; source?: string };
			return {
				id: p.id,
				name: p.name,
				apiKey: p.auth.apiKey ? { name: p.auth.apiKey.name } : undefined,
				oauth: p.auth.oauth
					? { name: p.auth.oauth.name, isSubscription: !!p.auth.oauth.isSubscription, loginLabel: p.auth.oauth.loginLabel }
					: undefined,
				modelCount: this.runtime.getModels(p.id).length,
				configured: !!status?.configured,
				source: status?.source,
			};
		});
	}

	listModels(providerId?: string): ModelInfo[] {
		return this.runtime.getModels(providerId).map((m) => ({
			provider: m.provider,
			id: m.id,
			name: m.name,
			reasoning: !!m.reasoning,
			thinking: supportedThinkingLevels(m),
			thinkingLevelMap: (m as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap,
			api: (m as { api?: string }).api,
			input: [...(m.input ?? [])],
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		}));
	}

	/** classifier（System One / Jev）模型目录：只列 classifier 类型，只含安全元数据。 */
	listClassifierModels(providerId?: string): ClassifierModelInfo[] {
		return this.runtime.getModelsOfType("classifier", providerId).map((m) => ({
			provider: m.provider,
			id: m.id,
			name: m.name,
			api: m.api,
			input: [...(m.input ?? [])],
			contextWindow: m.contextWindow,
			configured: this.runtime.hasConfiguredAuth(m.provider),
		}));
	}

	/**
	 * 受限分类请求：只按 provider/model 找 classifier 模型，鉴权由 Pi 的 request-time 解析完成
	 * （按 model.provider 绑定 baseURL/headers/key，不会串到别的 provider）。
	 * 返回中性结果：不返回 headers / key，错误信息已脱敏；SDK 契约上不抛异常。
	 */
	async classify(providerId: string, modelId: string, context: ClassifierContext, opts?: ClassifierCallOptions): Promise<ClassifierOutcome> {
		const model = this.runtime.getModelOfType("classifier", providerId, modelId);
		if (!model) return { provider: providerId, model: modelId, api: "", answers: {}, stopReason: "error", errorMessage: `找不到分类模型 ${providerId}/${modelId}`, timestamp: Date.now() };
		const res = await this.runtime.classify(model, context, opts ? { signal: opts.signal, timeoutMs: opts.timeoutMs, temperature: opts.temperature } : undefined);
		const out: ClassifierOutcome = { provider: res.provider, model: res.model, api: res.api, answers: res.answers, stopReason: res.stopReason, timestamp: res.timestamp };
		if (res.usage) {
			// 缺 cost 时保持 undefined（价格未知），绝不回落到 0 —— 否则会把「未知」当「免费」记账。
			const cost = res.usage.cost?.total;
			out.usage = { input: res.usage.input, output: res.usage.output, totalTokens: res.usage.totalTokens, ...(typeof cost === "number" && Number.isFinite(cost) ? { cost } : {}) };
		}
		if (res.errorMessage) out.errorMessage = redactSecrets(res.errorMessage);
		return out;
	}

	/** 把想要的思考强度收敛到模型支持的档位（Pi 的 clampThinkingLevel） */
	clampThinking(providerId: string, modelId: string, level: string): string {
		const m = this.runtime.getModel(providerId, modelId);
		return m ? clampThinkingLevel(m, level as ModelThinkingLevel) : "off";
	}

	/** 某个模型支持的思考档位（与模型目录同一份 Pi 元数据；模型不存在返回 []）。 */
	supportedThinking(providerId: string, modelId: string): string[] {
		const m = this.runtime.getModel(providerId, modelId);
		return m ? supportedThinkingLevels(m) : [];
	}

	getModel(providerId: string, modelId: string) {
		return this.runtime.getModel(providerId, modelId);
	}

	login(providerId: string, type: "api_key" | "oauth", interaction: LoginInteraction) {
		return this.runtime.login(providerId, type, interaction, { agentName: BRAND.name });
	}

	logout(providerId: string) {
		return this.runtime.logout(providerId);
	}

	/** 重新读取 Pi 的 models.json（自定义服务变更后调用），不访问网络。 */
	async reloadConfig() {
		await this.runtime.refresh({ allowNetwork: false });
	}

	async refresh() {
		try {
			await this.runtime.refresh();
		} catch {
			/* 离线时忽略 */
		}
	}

	/** 发一条极短的请求验证凭据与模型可用。 */
	async test(providerId: string, modelId: string): Promise<{ ok: boolean; message: string }> {
		const model = this.runtime.getModel(providerId, modelId);
		if (!model) return { ok: false, message: "找不到该模型" };
		try {
			const res = await this.runtime.completeSimple(
				model,
				{ messages: [{ role: "user", content: "Reply with: OK", timestamp: Date.now() }] },
				{ maxTokens: 16 },
			);
			if (res.stopReason === "error" || res.stopReason === "aborted") return { ok: false, message: res.errorMessage ?? "请求失败" };
			const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
			return { ok: true, message: text || "连接成功" };
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}

	/**
	 * 单次补全（不走 Agent 会话）：给本机 OpenAI 兼容网关等内部用途。
	 * 入参/出参是与 Pi 无关的中性结构，Pi 的消息格式只在这里出现。
	 */
	async complete(providerId: string, modelId: string, req: ChatRequest): Promise<ChatResult> {
		const model = this.runtime.getModel(providerId, modelId);
		if (!model) return { text: "", toolCalls: [], stopReason: "error", error: `找不到模型 ${providerId}/${modelId}`, usage: { input: 0, output: 0 } };
		const ts = Date.now();
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const messages = req.messages.map((m) => {
			if (m.role === "user") return { role: "user", content: m.images?.length ? [{ type: "text", text: m.text }, ...m.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))] : m.text, timestamp: ts };
			if (m.role === "assistant")
				return {
					role: "assistant",
					content: [...(m.text ? [{ type: "text", text: m.text }] : []), ...(m.toolCalls ?? []).map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments }))],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zero,
					stopReason: m.toolCalls?.length ? "toolUse" : "stop",
					timestamp: ts,
				};
			return { role: "toolResult", toolCallId: m.toolCallId, toolName: m.name, content: [{ type: "text", text: m.text }], isError: !!m.isError, timestamp: ts };
		});
		const maxTokens = Math.min(req.maxTokens ?? 4096, (model as { maxTokens?: number }).maxTokens ?? 32_000);
		try {
			const res = await this.runtime.completeSimple(
				model,
				{ systemPrompt: req.systemPrompt, messages, tools: req.tools?.map((t) => ({ name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } })) } as never,
				{ maxTokens, temperature: req.temperature, signal: req.signal },
			);
			const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			const toolCalls = res.content.filter((c) => c.type === "toolCall").map((c) => ({ id: (c as { id: string }).id, name: (c as { name: string }).name, arguments: (c as { arguments: Record<string, unknown> }).arguments ?? {} }));
			const stop = res.stopReason === "toolUse" ? "toolUse" : res.stopReason === "length" ? "length" : res.stopReason === "error" || res.stopReason === "aborted" ? "error" : "stop";
			return { text, toolCalls, stopReason: stop, error: stop === "error" ? (res.errorMessage ?? "请求失败") : undefined, usage: { input: res.usage?.input ?? 0, output: res.usage?.output ?? 0 } };
		} catch (e) {
			return { text: "", toolCalls: [], stopReason: "error", error: e instanceof Error ? e.message : String(e), usage: { input: 0, output: 0 } };
		}
	}

	/** 注册一个本地 provider（mock 模型用）。 */
	registerProvider(id: string, config: unknown) {
		this.runtime.registerProvider(id, config as never);
	}

	/**
	 * 给自定义 provider 注册一个或多个 classifier（协议 + 模型 id，最小公开入口）。
	 *
	 * SDK 真实限制（已用 fixture 验证）：models.json 只能定义 chat 模型，写 `type: "classifier"` 也会被当成 chat，
	 * 所以自定义 provider 的 classifier 只能经扩展 `registerProvider` 注册。这里：
	 *  - 把该 provider 现有 **chat** 模型原样带上（`getModelsOfType("chat")`，不会把上次注册的 classifier 再当 chat 混进来）；
	 *  - 按声明追加 classifier（协议来自公开白名单，模型 id 由调用方给）；
	 *  - 鉴权复用该 provider 已保存的凭据（Pi request-time 按 model.provider 解析），本方法不读 key、不传 key、不换 baseURL。
	 */
	registerClassifiers(providerId: string, classifiers: ClassifierDeclaration[], opts?: { baseUrl?: string; chatModels?: ClassifierChatModel[] }) {
		if (!classifiers.length) return;
		// chat 模型优先用调用方给的持久化元数据（扩展 provider 的 models 会整体替换 models.json 的模型列表，
		// 靠 runtime 读会拿到上一次注册时的旧列表，导致编辑后的模型/长度丢失）。
		const source: ClassifierChatModel[] = opts?.chatModels ?? [...(this.runtime.getModelsOfType("chat", providerId) as readonly ClassifierChatModel[])];
		const baseUrl = opts?.baseUrl ?? source[0]?.baseUrl;
		if (!baseUrl) throw new Error(`provider ${providerId} 没有 baseUrl，无法注册 classifier`);
		const models: unknown[] = source.map((m) => ({
			type: "chat" as const,
			id: m.id,
			name: m.name ?? m.id,
			api: m.api,
			baseUrl: m.baseUrl ?? baseUrl,
			input: [...(m.input ?? ["text"])],
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: !!m.reasoning,
			contextWindow: m.contextWindow ?? 128_000,
			maxTokens: m.maxTokens ?? 16_384,
			...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
		}));
		const apis: Record<string, unknown> = {};
		for (const c of classifiers) {
			const fn = CLASSIFIER_PROTOCOLS[c.protocol];
			if (!fn) throw new Error(`不支持的 classifier 协议：${c.protocol}`);
			apis[c.protocol] = { classify: fn };
			models.push({
				type: "classifier",
				id: c.modelId,
				name: c.name ?? c.modelId,
				api: c.protocol,
				baseUrl,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: c.contextWindow ?? 8192,
			});
		}
		this.runtime.registerProvider(providerId, {
			name: this.runtime.getProvider(providerId)?.name ?? providerId,
			baseUrl,
			classifiers: apis,
			models,
		} as never);
	}

	/** 兼容旧调用：等价于声明一个 `typesafe-system-one` classifier。 */
	registerSystemOneClassifier(providerId: string, modelId: string, opts?: { name?: string; baseUrl?: string; contextWindow?: number }) {
		this.registerClassifiers(providerId, [{ protocol: "typesafe-system-one", modelId, name: opts?.name, contextWindow: opts?.contextWindow }], { baseUrl: opts?.baseUrl });
	}

	/** 摘掉扩展注册的 provider 层，让 models.json（及 Pi 内置目录）重新生效。 */
	unregisterProvider(providerId: string) {
		this.runtime.unregisterProvider(providerId);
	}
	setRuntimeApiKey(id: string, key: string) {
		return this.runtime.setRuntimeApiKey(id, key);
	}
	/** 清掉进程内注入的运行时 key（本地 sidecar 停止 / 换 token 时用；不碰持久凭据）。 */
	removeRuntimeApiKey(id: string) {
		return this.runtime.removeRuntimeApiKey(id);
	}
}

export type ChatMessage =
	| { role: "user"; text: string; images?: { data: string; mimeType: string }[] }
	| { role: "assistant"; text: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }
	| { role: "tool"; toolCallId: string; name: string; text: string; isError?: boolean };
export interface ChatRequest {
	systemPrompt?: string;
	messages: ChatMessage[];
	tools?: { name: string; description?: string; parameters?: Record<string, unknown> }[];
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
}
export interface ChatResult {
	text: string;
	toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
	stopReason: "stop" | "length" | "toolUse" | "error";
	error?: string;
	usage: { input: number; output: number };
}

// ---------------------------------------------------------------- 会话

export interface CreateSessionOptions {
	models: PiModels;
	cwd: string;
	agentDir: string;
	sessionDir: string;
	/** 已存在的会话文件：恢复；否则 continueRecent=true 时续上最近的会话，否则新建。 */
	sessionFile?: string;
	/** 新建会话时的父会话文件（Pi 会话头 parentSession）：从消息另开分支且分支点在首条消息之前时用。 */
	parentSession?: string;
	continueRecent?: boolean;
	model: { provider: string; id: string };
	/** 思考强度（已按模型收敛） */
	thinking?: string;
	systemPromptAppend: string[];
	extensions: { name: string; factory: ExtensionFactory }[];
	skillPaths?: string[];
	/**
	 * 技能选集：只保留返回 true 的技能（在路径白名单之后再次过滤）。
	 * 由调用方给出「该助理启用了哪些技能」；不传则保持旧的「路径内全部加载」行为（低层测试 / 诊断用）。
	 * 生产路径（runtime 的助理 / 后台任务 / 子代理）都会显式传入，默认不启用任何技能。
	 */
	skillFilter?: (skill: { name: string; filePath: string }) => boolean;
	/** 我们自己配置的 MCP 服务器（不读 mcp.json） */
	mcpServers?: { name: string; config: Record<string, unknown> }[];
	mcpLogPath?: string;
	/** MCP 服务需要 OAuth 登录时：打开授权页 */
	onMcpAuthUrl?: (url: string) => void;
	/** 已安装的 Pi 扩展包目录（按 Pi 的包发现规则加载其中的扩展/技能） */
	packagePaths?: string[];
	/**
	 * 工具允许清单（不含 `+`/`-` 前缀；传了就只启用匹配的工具）。
	 * 受限专用会话（如主题设计）用它把会话收敛到**唯一**业务工具，不继承 bash / 主机 / 桌面 / 邮箱等全工具集。
	 * 不传 = 现有默认（内建 read/write/edit/bash + grep/find/ls 与扩展工具）。
	 */
	tools?: string[];
	/** 在 `tools` 之后再禁用的工具名 / 通配（Pi 的 excludeTools 语义）。 */
	excludeTools?: string[];
	/** 直接注册的自定义工具（Pi 的 customTools）。 */
	customTools?: ToolDefinition[];
	/**
	 * 不加载 Pi 自带的 MCP / codemode / tool-search 扩展（受限专用会话用）。
	 * 这些扩展会连接 MCP 服务器、并把别的工具经 codemode 间接暴露出去；主题设计不需要。
	 */
	minimalExtensions?: boolean;
	/** 用内存会话（不落盘、不碰任何用户会话文件）。受限专用会话用，避免污染助理对话历史。 */
	inMemorySession?: boolean;
}

/** 服务端拒绝 max_tokens / 上下文后学到的上限：由 models.ts 接到自定义服务存储（只对自定义服务生效） */
let limitsLearner: ((provider: string, model: string, l: { contextWindow?: number; maxTokens?: number }) => Promise<boolean>) | null = null;
export function setLimitsLearner(fn: typeof limitsLearner) {
	limitsLearner = fn;
}

/**
 * 输出上限太大被拒（很多中转会对超过真实上限的 max_tokens 直接报 400）：
 * 从报错学到上限 → 改掉会话里的模型对象并写回存储 → 让 Pi 的自动重试再发一次。
 * 上下文超长且报错给了真实长度：只记下来（Pi 自己会整理上下文后重试）。
 */
export function installLimitLearning(session: AgentSession) {
	const s = session as unknown as { _isRetryableError: (m: { stopReason?: string; errorMessage?: string; provider?: string; model?: string }) => boolean; model?: { provider: string; id: string; contextWindow?: number; maxTokens?: number } };
	const orig = s._isRetryableError?.bind(session);
	if (!orig) return;
	// Pi 对同一条失败消息会问不止一次（agent_end 时和收尾时），结果按消息缓存，避免连降两级
	const seen = new WeakMap<object, boolean>();
	s._isRetryableError = (msg) => {
		if (msg && seen.has(msg)) return seen.get(msg)!;
		let r: boolean | undefined;
		if (msg?.stopReason === "error" && limitsLearner) {
			const model = s.model;
			const l = model && msg.provider === model.provider && msg.model === model.id ? learnFromError(msg.errorMessage, model) : null;
			if (model && l) {
				if (l.maxTokens) model.maxTokens = l.maxTokens;
				if (l.contextWindow) model.contextWindow = l.contextWindow;
				void limitsLearner(model.provider, model.id, { contextWindow: l.contextWindow, maxTokens: l.maxTokens }).catch(() => {});
				if (l.retry) r = true;
			}
		}
		r ??= orig(msg);
		if (msg) seen.set(msg, r);
		return r;
	};
}

export async function createPiSession(o: CreateSessionOptions): Promise<AgentSession> {
	const model = o.models.getModel(o.model.provider, o.model.id);
	if (!model) throw new Error(`模型不存在：${o.model.provider}/${o.model.id}`);
	// 隔离：只加载我们自己的扩展（内联 factory）和我们自己目录里的技能，
	// 绝不读取用户自己装的 Pi（~/.pi/agent、~/.agents/skills、项目 .pi/.agents 等）
	const allowedSkillRoots = [...(o.skillPaths ?? []), ...(o.packagePaths ?? []), o.agentDir].map((p) => resolve(p));
	const inside = (p: string) => allowedSkillRoots.some((r) => {
		const rel = relative(r, resolve(p));
		return !rel.startsWith("..") && !isAbsolute(rel);
	});
	const skillFilter = o.skillFilter;
	const resourceLoader = new DefaultResourceLoader({
		cwd: o.cwd,
		agentDir: o.agentDir,
		noExtensions: true,
		skillsOverride: (base) => ({
			skills: base.skills.filter((s) => {
				const filePath = (s as { filePath: string }).filePath;
				if (!inside(filePath)) return false;
				return skillFilter ? skillFilter({ name: s.name, filePath }) : true;
			}),
			diagnostics: base.diagnostics,
		}),
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		noSkills: !o.skillPaths?.length && !o.packagePaths?.length,
		additionalSkillPaths: o.skillPaths,
		additionalExtensionPaths: o.packagePaths,
		appendSystemPrompt: [o.systemPromptAppend.join("\n\n")],
		// Pi 自带的 MCP 扩展（SDK 会话默认不加载）：ext-computer 等通过 pi.registerMcpServer 注册服务器
		// 配置来源只有我们自己（loadConfig），不读 ~/.pi/agent/mcp.json 或项目 .pi/mcp.json；/mcp 的修改不落盘。
		extensionFactories: [
			...(o.minimalExtensions
				? []
				: [
						{
							name: "pi-mcp",
							factory: createMcpExtension({
								startupWaitMs: 8000,
								loadConfig: () => ({ servers: (o.mcpServers ?? []).map((s) => ({ name: s.name, config: s.config as never, source: "pi-assistant", scope: "global" as const })), errors: [], autoEnableCodemode: true }),
								updateConfig: () => {},
								logPath: o.mcpLogPath,
								openUrl: o.onMcpAuthUrl,
							}),
						},
						{ name: "pi-codemode", factory: createCodemodeExtension({ models: false }) },
						{ name: "pi-tool-search", factory: createToolSearchExtension() },
					]),
			...o.extensions.map((e) => ({ name: e.name, factory: e.factory })),
		],
	});
	await resourceLoader.reload();
	const sessionManager = o.inMemorySession
		? SessionManager.inMemory(o.cwd)
		: o.sessionFile
			? SessionManager.open(o.sessionFile, o.sessionDir, o.cwd)
			: o.continueRecent
				? SessionManager.continueRecent(o.cwd, o.sessionDir)
				: SessionManager.create(o.cwd, o.sessionDir, o.parentSession ? { parentSession: o.parentSession } : undefined);
	const { session } = await createAgentSession({
		cwd: o.cwd,
		agentDir: o.agentDir,
		modelRuntime: o.models.runtime,
		model,
		thinkingLevel: (o.thinking ?? "off") as ModelThinkingLevel,
		resourceLoader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 5 } }),
		tools: o.tools ?? ["+grep", "+find", "+ls"],
		...(o.excludeTools?.length ? { excludeTools: o.excludeTools } : {}),
		...(o.customTools?.length ? { customTools: o.customTools } : {}),
	});
	installLimitLearning(session);
	// 触发 session_start：MCP 扩展在此时连接服务器（如 cua-driver）
	await session.bindExtensions({ onError: (e) => console.warn("[ext]", (e as { error?: unknown }).error ?? e) });
	return session;
}

/** 供沙箱扩展覆盖内置 bash 工具（参考 Pi 官方 gondolin 示例）。 */
export function makeBashTool(
	cwd: string,
	opts: { operations?: BashOperations; spawnHook?: (c: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => { command: string; cwd: string; env: NodeJS.ProcessEnv } },
) {
	return createBashTool(cwd, { operations: opts.operations, spawnHook: opts.spawnHook, exposeSessionEnvironment: false });
}

/** 会话实际加载的技能与扩展（用于隔离测试与诊断） */
export function loadedResources(session: AgentSession) {
	const rl = session.resourceLoader;
	return {
		skills: rl.getSkills().skills.map((s) => ({ name: s.name, path: (s as { filePath: string }).filePath })),
		extensions: rl.getExtensions().extensions.map((e) => (e as { path?: string }).path ?? ""),
	};
}

export function sessionFileOf(session: AgentSession): string | undefined {
	return session.sessionManager.getSessionFile();
}

// ---------------------------------------------------------------- 会话分支（fork）

/** 一个可分支的锚点：app 消息对应的 Pi entry 及其分支点（该 entry 的父 entry）。 */
export interface ForkPoint {
	entryId: string;
	/** 分支点：新会话覆盖到这条 entry 为止（不包含锚点消息本身） */
	parentId: string | null;
	role: string;
	/** 锚点 user 消息的正文（官方 `fork(entryId)` 的 `selectedText`，放回新对话输入框，不自动发送） */
	text: string;
}

/**
 * 只读源会话文件，把某个 entry id 解析成分支锚点；文件/entry 不存在返回 null（调用方 fail-closed）。
 * 语义与官方 `getUserMessagesForForking()` + `fork(entryId)` 对齐：锚点是 user 消息，分支点是它的 parentId。
 */
export function resolveForkPoint(sessionFile: string, entryId: string): ForkPoint | null {
	if (!existsSync(sessionFile)) return null;
	let sm: SessionManager;
	try {
		sm = SessionManager.open(sessionFile);
	} catch {
		return null;
	}
	const entry = sm.getEntry(entryId) as { type?: string; id?: string; parentId?: string | null; message?: unknown } | undefined;
	if (!entry || entry.type !== "message" || !entry.message) return null;
	const role = String((entry.message as { role?: string }).role ?? "");
	return { entryId, parentId: entry.parentId ?? null, role, text: role === "user" ? messageText(entry.message) : "" };
}

export interface ForkBranch {
	/** 新会话文件；null = 分支点在首条消息之前：按官方语义只记父关系，首条消息落盘时才写文件 */
	sessionFile: string | null;
	/** 分支路径上 message entry 的 id，用于把新会话前缀投影成 app 消息行 */
	entryIds: string[];
	/** 新会话的父会话文件（Pi 会话头 parentSession） */
	parentSession: string;
}

/**
 * 用 Pi 公开 API 从源会话另开一条分支：`SessionManager.createBranchedSession(leafId)` 只读源文件、
 * 另写一个新会话文件（头带 `parentSession`），内容是根到 `parentLeafId` 这一条路径。
 * 不碰 AgentSession、不调用模型、不重放工具。
 */
export function forkSessionAt(sourceFile: string, parentLeafId: string | null, opts: { cwd: string; sessionDir: string }): ForkBranch {
	if (!existsSync(sourceFile)) throw new Error("源会话文件不存在");
	if (!parentLeafId) return { sessionFile: null, entryIds: [], parentSession: sourceFile };
	const sm = SessionManager.open(sourceFile, opts.sessionDir, opts.cwd);
	if (!sm.getEntry(parentLeafId)) throw new Error("分支点不在源会话里");
	const entryIds = sm.getBranch(parentLeafId).flatMap((e) => (e.type === "message" ? [e.id] : []));
	const file = sm.createBranchedSession(parentLeafId);
	if (!file) throw new Error("无法创建分支会话");
	return { sessionFile: file, entryIds, parentSession: sourceFile };
}

/**
 * 只读一个落库会话文件的原始消息（含被 context_edit 略去、但仍在原始历史里的失败轮次）。
 * 用于自动续跑前的副作用核验：不建会话、不碰模型 / 凭据，读不到返回 null。
 * 消息形状即公开的 Pi `AgentMessage`（message-types.md）。
 */
export function readSessionFileMessages(file: string): unknown[] | null {
	try {
		// 文件不在（被清理 / 路径失效）时 SessionManager.open 会给出空分支，不能据此当作「没有未配平的调用」：
		// 核验的前提是读得到真实历史，读不到一律返回 null，由调用方按不安全处理。
		if (!existsSync(file)) return null;
		const sm = SessionManager.open(file);
		return sm.getBranch().flatMap((e) => (e.type === "message" ? [e.message] : []));
	} catch {
		return null;
	}
}

/** 当前会话（含原始历史）的消息，供续跑前核验副作用。 */
export function branchMessagesOf(session: AgentSession): unknown[] {
	return session.sessionManager.getBranch().flatMap((e) => (e.type === "message" ? [e.message] : []));
}

export function lastAssistantText(session: AgentSession): string {
	return session.getLastAssistantText() ?? "";
}

/** prompt()正常resolve不代表服务成功；从公开messages检查最终模型结果，不能把失败标成后台任务完成。 */
export function lastAssistantError(session: AgentSession): string | undefined {
	const message = [...session.messages].reverse().find((m) => m.role === "assistant");
	if (!message || message.role !== "assistant") return "这次未收到回复，服务未提供具体原因";
	if (message.stopReason === "aborted") return undefined;
	if (message.stopReason === "error" || message.errorMessage) return modelErrorMessage(message.errorMessage);
	if (!message.content.some((b) => b.type === "toolCall" || (b.type === "text" && b.text.trim()) || (b.type === "thinking" && b.thinking.trim()))) return "这次未收到回复，服务未提供具体原因";
	return undefined;
}

/** 从 Pi 的 AgentMessage 中取纯文本。 */
export function messageText(message: unknown): string {
	const m = message as { content?: unknown };
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) return m.content.map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("");
	return "";
}

// ---------------------------------------------------------------- 归一化的会话操作与事件（server 只使用这些）

export type AgentEvent =
	| { type: "assistant_start" }
	| { type: "text_delta"; delta: string }
	/** 模型原生的思考 / 推理内容（reasoning） */
	| { type: "thinking_delta"; delta: string }
	| {
			type: "assistant_end";
			text: string;
			error?: string;
			aborted?: boolean;
			hasToolCalls?: boolean;
			provider?: string;
			model?: string;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number };
	  }
	| { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
	| { type: "tool_end"; id: string; name: string; isError: boolean; resultText: string }
	| { type: "settled"; aborted: boolean }
	/** 一条用户消息真正进入了模型上下文（插话在下一个工具边界送达时触发） */
	| { type: "user_start"; text: string }
	/**
	 * 一条消息写进 Pi 会话文件后，它对应的 entry id（app 消息 ↔ Pi entry 的可信映射，用于「从消息另开会话分支」）。
	 * 监听器先于 Pi 的持久化触发，所以这里在持久化之后的微任务里，用公开 `SessionManager.getEntries()`
	 * 按**消息对象身份**（`entry.message === message`）反查 entry id；role 可能是 user / assistant / toolResult。
	 */
	| { type: "entry_id"; entryId: string; role: string; toolCallId?: string }
	| { type: "compaction_start"; reason: string }
	| { type: "compaction_end"; reason: string; ok: boolean; aborted: boolean; error?: string; tokensBefore?: number; summary?: string };

/**
 * 把刚持久化的消息解析成 Pi entry id：用公开 `SessionManager.getEntries()` 按**消息对象身份**匹配
 * （`entry.message === message`）。Pi 的 `appendMessage(event.message)` 存的就是同一个对象，所以即使
 * 多条 message_end 落在同一个 tick（并行工具结果 / 连发同文本 user / steer），也各归各的 entry——
 * 不读 leaf、不按文本或下标猜（读 leaf 会把同 tick 的几条都指到最后一个 entry）。
 * 会话已释放 / 找不到（例如 leaf 被切走）返回 null，调用方跳过映射，绝不落一个错的 id。
 */
function entryIdOfMessage(session: AgentSession, message: unknown): string | null {
	try {
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}
	} catch {
		/* 会话已释放 */
	}
	return null;
}

export function subscribeSession(session: AgentSession, fn: (e: AgentEvent) => void): () => void {
	return session.subscribe((e: AgentSessionEvent) => {
		const ev = e as { type: string; [k: string]: any };
		if ((ev as { parentToolCallId?: string }).parentToolCallId) return; // 嵌套调用不单独显示
		switch (ev.type) {
			case "message_start":
				if (ev.message?.role === "assistant") fn({ type: "assistant_start" });
				else if (ev.message?.role === "user") fn({ type: "user_start", text: messageText(ev.message) });
				break;
			case "message_update":
				if (ev.assistantMessageEvent?.type === "text_delta") fn({ type: "text_delta", delta: ev.assistantMessageEvent.delta });
				else if (ev.assistantMessageEvent?.type === "thinking_delta") fn({ type: "thinking_delta", delta: ev.assistantMessageEvent.delta });
				break;
			case "message_end": {
				const persisted = ev.message as { role?: string; toolCallId?: string } | undefined;
				if (persisted?.role === "user" || persisted?.role === "assistant" || persisted?.role === "toolResult") {
					const role = persisted.role;
					const message = persisted;
					// Pi 在把这条消息 appendMessage 到 SessionManager 之前就通知了监听器；append 紧随其后且中间没有 await，
					// 所以在微任务里按消息对象身份反查 entry id，同 tick 的多条也不会互相顶替。
					queueMicrotask(() => {
						const entryId = entryIdOfMessage(session, message);
						if (entryId) fn({ type: "entry_id", entryId, role, toolCallId: persisted.toolCallId });
					});
				}
				if (ev.message?.role === "assistant") {
					const m = ev.message;
					fn({
						type: "assistant_end",
						text: messageText(m),
						error: m.stopReason === "aborted" ? undefined : m.stopReason === "error" || m.errorMessage ? modelErrorMessage(m.errorMessage) : undefined,
						aborted: m.stopReason === "aborted",
						hasToolCalls: Array.isArray(m.content) && m.content.some((b: { type?: string }) => b.type === "toolCall"),
						provider: m.provider,
						model: m.model,
						usage: m.usage ? { input: m.usage.input ?? 0, output: m.usage.output ?? 0, cacheRead: m.usage.cacheRead ?? 0, cacheWrite: m.usage.cacheWrite ?? 0, reasoning: m.usage.reasoning ?? 0, cost: m.usage.cost?.total ?? 0 } : undefined,
					});
				}
				break;
			}
			case "tool_execution_start":
				fn({ type: "tool_start", id: ev.toolCallId, name: ev.toolName, args: ev.args ?? {} });
				break;
			case "tool_execution_end": {
				const r = ev.result as { content?: { type: string; text?: string }[] } | undefined;
				const resultText = Array.isArray(r?.content) ? r!.content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n") : String(r ?? "");
				fn({ type: "tool_end", id: ev.toolCallId, name: ev.toolName, isError: !!ev.isError, resultText });
				break;
			}
			case "agent_settled":
				fn({ type: "settled", aborted: !!ev.aborted });
				break;
			case "compaction_start":
				fn({ type: "compaction_start", reason: ev.reason });
				break;
			case "compaction_end":
				fn({ type: "compaction_end", reason: ev.reason, ok: !!ev.result && !ev.aborted, aborted: !!ev.aborted, error: ev.errorMessage, tokensBefore: ev.result?.tokensBefore, summary: ev.result?.summary });
				break;
		}
	});
}

/** 插话前缀：让模型知道这是它工作途中用户新发来的消息 */
export const INTERJECTION_PREFIX = "（你工作时用户发来的新消息）";
/**
 * 发送用户输入。会话空闲：开始新一轮。
 * 会话正在运行：用 Pi 的 steer 插话——在当前这批工具调用结束、下一次请求模型之前送达，
 * 模型能马上读到（而不是等整轮做完才看到，followUp 的旧行为）。
 */
export function promptSession(session: AgentSession, text: string, images?: { type: "image"; data: string; mimeType: string }[], leading?: string): Promise<void> {
	const img = images?.length ? { images } : {};
	// leading 放在最前面（如 Pi 原生 `/skill:name`），保证 Pi 的 skill 命令展开能命中；插话前缀随后
	const cmd = leading ? `${leading} ` : "";
	if (session.isStreaming) return session.prompt(`${cmd}${INTERJECTION_PREFIX}\n${text}`, { streamingBehavior: "steer", ...img });
	return session.prompt(`${cmd}${text}`, img);
}
/** 停止时清掉还没送达的插话 / 排队消息，免得停下后又被它们重新启动 */
export function clearQueued(s: AgentSession) {
	try {
		(s as unknown as { clearQueue?: () => unknown }).clearQueue?.();
	} catch {
		/* 旧版 SDK 没有 */
	}
}
export const isSessionBusy = (s: AgentSession) => s.isStreaming;
/** 手动“整理上下文”：让 Pi 把较早的对话压缩成摘要（Pi 原生 compaction）。 */
export async function compactSession(s: AgentSession, instructions?: string) {
	const r = await s.compact(instructions);
	return { tokensBefore: (r as { tokensBefore?: number }).tokensBefore, summary: (r as { summary?: string }).summary };
}

/** 本次要用的技能（canonical id + 库存里解析出的名字 / SKILL.md 路径）。服务端已按分配表校验。 */
export interface SkillInvocationInput {
	id: string;
	name: string;
	filePath: string;
}

/**
 * 本次选中的技能 → Pi **原生** `/skill:name` 命令，交给 Pi 自己读 SKILL.md 并拼进本轮输入。
 *
 * - 只接受这个会话**已加载**的技能（= 已分配给该助理且通过 `skillFilter`）；找不到就抛错（fail closed）。
 * - 不读技能正文、不自拼技能块、不写 system prompt，也不接受客户端路径 / 正文。
 * - 第一版一次只支持一个：Pi 原生只展开开头一个 `/skill:` 命令，多个会被当成上一条的参数。
 */
export function skillCommand(session: AgentSession, skills: SkillInvocationInput[]): string | undefined {
	if (!skills.length) return undefined;
	if (skills.length > 1) throw new Error("一次只能选一个技能");
	const want = skills[0];
	const loaded = session.resourceLoader.getSkills().skills as unknown as { name: string; filePath: string }[];
	const s = loaded.find((x) => x.filePath === want.filePath) ?? loaded.find((x) => x.name === want.name);
	if (!s) throw new Error(`技能未加载：${want.name}`);
	return `/skill:${s.name}`;
}
/** 当前上下文用量（用于界面提示“对话较长”） */
export function contextUsage(s: AgentSession): { tokens: number | null; contextWindow: number | null } {
	const u = (s as unknown as { getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined }).getContextUsage?.();
	return { tokens: u?.tokens ?? null, contextWindow: u?.contextWindow ?? s.model?.contextWindow ?? null };
}
/** 输入框旁的上下文圆环：当前上下文占用 + 本会话累计 token / 费用（Pi getSessionStats） */
export function sessionStats(s: AgentSession) {
	const ctx = contextUsage(s);
	const st = (s as unknown as { getSessionStats?: () => { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number; userMessages: number; assistantMessages: number; toolCalls: number } }).getSessionStats?.();
	return {
		...ctx,
		percent: ctx.tokens != null && ctx.contextWindow ? Math.min(100, Math.round((ctx.tokens / ctx.contextWindow) * 1000) / 10) : null,
		model: s.model ? { provider: s.model.provider, id: s.model.id, name: s.model.name } : null,
		session: st ? { tokens: st.tokens, cost: st.cost, userMessages: st.userMessages, assistantMessages: st.assistantMessages, toolCalls: st.toolCalls } : null,
	};
}
export const abortSession = (s: AgentSession) => (clearQueued(s), s.abort());
/** 结束会话：先发 session_shutdown（让 MCP 等扩展关闭子进程/连接），再释放 */
export async function disposeSession(s: AgentSession) {
	try {
		const runner = s.extensionRunner;
		if (runner?.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
	} catch {
		/* 关闭时的扩展错误不影响释放 */
	}
	s.dispose();
}
/** 往上下文注入一条不显示给用户的信息（例如后台任务结果），在下一轮对话时生效。 */
/** 发一条模型可见、聊天里不显示的消息并立刻开始一轮（忙时排在当前轮之后） */
export function triggerHidden(session: AgentSession, customType: string, text: string) {
	return session.sendCustomMessage({ customType, content: text, display: false }, { triggerTurn: true, deliverAs: session.isStreaming ? "followUp" : undefined });
}

export function injectContext(session: AgentSession, customType: string, text: string) {
	return session.sendCustomMessage({ customType, content: text, display: false }, { deliverAs: "nextTurn" });
}

/** 在已有会话上切换模型 / 思考强度（不重建会话，历史保留）。返回是否有变化 */
export async function applyModelSettings(session: AgentSession, models: PiModels, model: { provider: string; id: string }, thinking: string): Promise<boolean> {
	let changed = false;
	const cur = session.model as { provider?: string; id?: string } | undefined;
	if (cur?.provider !== model.provider || cur?.id !== model.id) {
		const m = models.getModel(model.provider, model.id);
		if (!m) throw new Error(`模型不存在：${model.provider}/${model.id}`);
		await session.setModel(m);
		changed = true;
	}
	const level = models.clampThinking(model.provider, model.id, thinking);
	if (session.thinkingLevel !== level) {
		session.setThinkingLevel(level as ModelThinkingLevel);
		changed = true;
	}
	return changed;
}

// 请求级 Fast（OpenAI service_tier）：纯函数 + 公开 hook 组合，见 fast-mode.ts
export { attachFastMode, classifyObservedTier, fastCapability, FAST_APIS, FAST_SERVICE_TIER, FAST_UNSUPPORTED_REASON, fastMetaOf, observedFastTier, planFastRequest, reportedFastTier } from "./fast-mode.ts";
export type { FastCapability, FastCapabilityInfo, FastPlan, FastRequestStatus, FastSnapshot, FastTracker } from "./fast-mode.ts";
