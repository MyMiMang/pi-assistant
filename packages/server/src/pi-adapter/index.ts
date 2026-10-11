/**
 * pi-adapter —— 本项目中唯一直接 import Pi 运行时代码的模块。
 *
 * 规则：server 其余代码只能通过这里导出的函数/类型使用 Pi。
 * Pi 升级出现 API 变化时，只需要改这个目录（以及 packages/ext-* 里的扩展，它们只依赖 Pi 的 ExtensionAPI 类型）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	createBashTool,
	createMcpExtension,
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
import type { CredentialStore } from "@earendil-works/pi-ai";
import compat from "./compat.json" with { type: "json" };
import { BRAND } from "@pi-assistant/shared";

export { defineTool, Type };
export type { AgentSession, AgentSessionEvent, BashOperations, ExtensionAPI, ExtensionFactory, ToolDefinition, CredentialStore };


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
	input: string[];
	contextWindow?: number;
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
			input: [...(m.input ?? [])],
			contextWindow: m.contextWindow,
		}));
	}

	getModel(providerId: string, modelId: string) {
		return this.runtime.getModel(providerId, modelId);
	}

	login(providerId: string, type: "api_key" | "oauth", interaction: LoginInteraction) {
		return this.runtime.login(providerId, type, interaction as never, { agentName: BRAND.name });
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
				{ messages: [{ role: "user", content: "Reply with: OK", timestamp: Date.now() }] } as never,
				{ maxTokens: 16 } as never,
			);
			if (res.stopReason === "error" || res.stopReason === "aborted") return { ok: false, message: res.errorMessage ?? "请求失败" };
			const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
			return { ok: true, message: text || "连接成功" };
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : String(e) };
		}
	}

	/** 注册一个本地 provider（mock 模型用）。 */
	registerProvider(id: string, config: unknown) {
		this.runtime.registerProvider(id, config as never);
	}
	setRuntimeApiKey(id: string, key: string) {
		return this.runtime.setRuntimeApiKey(id, key);
	}
}

// ---------------------------------------------------------------- 会话

export interface CreateSessionOptions {
	models: PiModels;
	cwd: string;
	agentDir: string;
	sessionDir: string;
	/** 已存在的会话文件：恢复；否则 continueRecent=true 时续上最近的会话，否则新建。 */
	sessionFile?: string;
	continueRecent?: boolean;
	model: { provider: string; id: string };
	systemPromptAppend: string[];
	extensions: { name: string; factory: ExtensionFactory }[];
	skillPaths?: string[];
}

export async function createPiSession(o: CreateSessionOptions): Promise<AgentSession> {
	const model = o.models.getModel(o.model.provider, o.model.id);
	if (!model) throw new Error(`模型不存在：${o.model.provider}/${o.model.id}`);
	const resourceLoader = new DefaultResourceLoader({
		cwd: o.cwd,
		agentDir: o.agentDir,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		noSkills: !o.skillPaths?.length,
		additionalSkillPaths: o.skillPaths,
		appendSystemPrompt: [o.systemPromptAppend.join("\n\n")],
		// Pi 自带的 MCP 扩展（SDK 会话默认不加载）：ext-computer 等通过 pi.registerMcpServer 注册服务器
		extensionFactories: [{ name: "pi-mcp", factory: createMcpExtension({ startupWaitMs: 8000 }) }, ...o.extensions.map((e) => ({ name: e.name, factory: e.factory }))],
	});
	await resourceLoader.reload();
	const sessionManager = o.sessionFile
		? SessionManager.open(o.sessionFile, o.sessionDir, o.cwd)
		: o.continueRecent
			? SessionManager.continueRecent(o.cwd, o.sessionDir)
			: SessionManager.create(o.cwd, o.sessionDir);
	const { session } = await createAgentSession({
		cwd: o.cwd,
		agentDir: o.agentDir,
		modelRuntime: o.models.runtime,
		model,
		thinkingLevel: "off",
		resourceLoader,
		sessionManager,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } } as never),
		tools: ["+grep", "+find", "+ls"],
	});
	// 触发 session_start：MCP 扩展在此时连接服务器（如 cua-driver）
	await session.bindExtensions({ onError: (e) => console.warn("[ext]", (e as { error?: unknown }).error ?? e) });
	return session;
}

/** 供沙箱扩展覆盖内置 bash 工具（参考 Pi 官方 gondolin 示例）。 */
export function makeBashTool(
	cwd: string,
	opts: { operations?: BashOperations; spawnHook?: (c: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => { command: string; cwd: string; env: NodeJS.ProcessEnv } },
) {
	return createBashTool(cwd, { operations: opts.operations, spawnHook: opts.spawnHook as never, exposeSessionEnvironment: false });
}

export function sessionFileOf(session: AgentSession): string | undefined {
	return session.sessionManager.getSessionFile();
}

export function lastAssistantText(session: AgentSession): string {
	return session.getLastAssistantText() ?? "";
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
	| {
			type: "assistant_end";
			text: string;
			error?: string;
			provider?: string;
			model?: string;
			usage?: { input: number; output: number; cost: number };
	  }
	| { type: "tool_start"; id: string; name: string; args: Record<string, unknown> }
	| { type: "tool_end"; id: string; name: string; isError: boolean; resultText: string }
	| { type: "settled"; aborted: boolean }
	| { type: "compaction_start"; reason: string }
	| { type: "compaction_end"; reason: string; ok: boolean; aborted: boolean; error?: string; tokensBefore?: number; summary?: string };

export function subscribeSession(session: AgentSession, fn: (e: AgentEvent) => void): () => void {
	return session.subscribe((e: AgentSessionEvent) => {
		const ev = e as { type: string; [k: string]: any };
		if ((ev as { parentToolCallId?: string }).parentToolCallId) return; // 嵌套调用不单独显示
		switch (ev.type) {
			case "message_start":
				if (ev.message?.role === "assistant") fn({ type: "assistant_start" });
				break;
			case "message_update":
				if (ev.assistantMessageEvent?.type === "text_delta") fn({ type: "text_delta", delta: ev.assistantMessageEvent.delta });
				break;
			case "message_end":
				if (ev.message?.role === "assistant") {
					const m = ev.message;
					fn({
						type: "assistant_end",
						text: messageText(m),
						error: m.stopReason === "error" ? (m.errorMessage ?? "模型请求失败") : undefined,
						provider: m.provider,
						model: m.model,
						usage: m.usage ? { input: m.usage.input ?? 0, output: m.usage.output ?? 0, cost: m.usage.cost?.total ?? 0 } : undefined,
					});
				}
				break;
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

/** 发送用户输入；会话正在运行时排在当前工作之后（followUp）。 */
export function promptSession(session: AgentSession, text: string): Promise<void> {
	return session.isStreaming ? session.prompt(text, { streamingBehavior: "followUp" }) : session.prompt(text);
}
export const isSessionBusy = (s: AgentSession) => s.isStreaming;
/** 手动“整理上下文”：让 Pi 把较早的对话压缩成摘要（Pi 原生 compaction）。 */
export async function compactSession(s: AgentSession, instructions?: string) {
	const r = await s.compact(instructions);
	return { tokensBefore: (r as { tokensBefore?: number }).tokensBefore, summary: (r as { summary?: string }).summary };
}
/** 当前上下文用量（用于界面提示“对话较长”） */
export function contextUsage(s: AgentSession): { tokens: number | null; contextWindow: number | null } {
	const u = (s as unknown as { getContextUsage?: () => { tokens?: number | null; contextWindow?: number } | undefined }).getContextUsage?.();
	return { tokens: u?.tokens ?? null, contextWindow: u?.contextWindow ?? s.model?.contextWindow ?? null };
}
export const abortSession = (s: AgentSession) => s.abort();
export const disposeSession = (s: AgentSession) => s.dispose();
/** 往上下文注入一条不显示给用户的信息（例如后台任务结果），在下一轮对话时生效。 */
export function injectContext(session: AgentSession, customType: string, text: string) {
	return session.sendCustomMessage({ customType, content: text, display: false }, { deliverAs: "nextTurn" });
}
