/**
 * 本机命令行渠道的注册样板和报错文字（claude / codex / agy 共用）。
 * 渠道不需要密钥：给个占位让 Pi 把渠道算作可用，登录状态由设置卡片的检测负责；用量 cost 一律 0（订阅不显示钱）。
 */
import type { PiModels } from "../index.ts";
import { modelDb } from "../../model-db.ts";
import { matchingModels, resolveLimits, type DbEntry } from "../model-limits.ts";

/** 本机命令行渠道的 provider id（新增一家在这里登记）：用量不按名字去价格库里「猜价」（订阅用户看 API 标价会被误导，且 gpt-* 会撞上官方同名模型） */
import { NATIVE_ACP_AGENTS } from "@pi-assistant/shared";
export const CLI_PROVIDER_IDS: readonly string[] = ["claude-code", "codex", "antigravity", "opencode-cli", ...NATIVE_ACP_AGENTS.map(a => a.provider)];

export interface CliModelSpec {
	id: string;
	name: string;
	/** 支持思考强度（`thinkingLevelMap` 决定能选哪几档） */
	reasoning: boolean;
	/** Pi 档位 → 命令行工具的值；不支持的档位给 null */
	thinkingLevelMap?: Record<string, string | null>;
	image: boolean;
	contextWindow: number;
	maxTokens: number;
}

export interface CliProviderSpec {
	/** Pi 的 provider id，如 `claude-code` */
	id: string;
	/** 模型服务页里显示的名字，如 `Claude Code（本机）` */
	name: string;
	/** Pi 的 `api` 字段：自定义流式实现的名字 */
	api: string;
	baseUrl: string;
	streamSimple: (...args: never[]) => unknown;
	models: CliModelSpec[];
}

/** 仅用目录中同一个模型的元数据；未知模型保留渠道预算，不采用 API 模型的默认值或家族猜测。 */
export function cliModelLimits(model: CliModelSpec, catalog: DbEntry[]): Pick<CliModelSpec, "contextWindow" | "maxTokens"> {
	const hits = matchingModels(model.id, catalog.filter((m) => m.contextWindow && m.contextWindow > 0));
	if (!hits.length) return { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
	const { contextWindow, maxTokens } = resolveLimits({ id: model.id }, undefined, hits);
	return { contextWindow, maxTokens };
}

/** 把一个本机命令行渠道（含它的 streamSimple 和模型）注册进 Pi；再调一次就是刷新模型列表。 */
export async function registerCliProvider(models: PiModels, spec: CliProviderSpec): Promise<void> {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	// 刷新 / 多渠道注册时不把 CLI 的旧预算当成目录事实，Pi 内置目录在 models.dev 前面。
	const catalog = [...models.listModels().filter((m) => m.provider !== spec.id && !CLI_PROVIDER_IDS.includes(m.provider)), ...modelDb()];
	models.registerProvider(spec.id, {
		name: spec.name,
		baseUrl: spec.baseUrl,
		api: spec.api,
		streamSimple: spec.streamSimple,
		models: spec.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: spec.api,
			baseUrl: spec.baseUrl,
			reasoning: m.reasoning,
			...(m.reasoning && m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
			input: m.image ? ["text", "image"] : ["text"],
			cost,
			...cliModelLimits(m, catalog),
		})),
	});
	await models.setRuntimeApiKey(spec.id, "local");
}

/** 命令行工具（codex / claude）的思考强度 → Pi 的 `thinkingLevelMap`（不支持的档位给 null，minimal 没有对应档位） */
export function thinkingMapOf(efforts: readonly string[]): Record<string, string | null> {
	const pick = (e: string) => (efforts.includes(e) ? e : null);
	return { minimal: null, low: pick("low"), medium: pick("medium"), high: pick("high"), xhigh: pick("xhigh"), max: pick("max") };
}

export interface CliErrorStyle {
	/** `Claude Code` */
	label: string;
	/** 用户该在终端里运行的登录命令，如 `claude auth login` */
	loginCommand: string;
	loginHint?: string;
	/** 匹配「没登录」的原文 */
	notLoggedIn: RegExp;
	/** 匹配「认证失败 / 登录过期」的原文（可选） */
	authFailed?: RegExp;
}

/** 工具自己已经按退避重试过还报额度不足：Pi 不再整轮重试（每轮要等工具重试一两分钟），直接告诉用户。 */
const QUOTA = /RESOURCE_EXHAUSTED|insufficient[\s_-]*quota|check quota|quota (?:exceeded|exhausted)|usage limit|额度(?:不足|用完|已用尽)/i;
export const CLI_QUOTA_HINT = "额度用完了";
export const isCliQuotaError = (message?: string): boolean => !!message?.includes(CLI_QUOTA_HINT);

/** 命令行工具报错 → 中文说明，带上原文 */
export function describeCliError(style: CliErrorStyle, text: string): string {
	const raw = text.trim() || "（没有错误内容）";
	if (style.notLoggedIn.test(raw)) return style.loginHint ? `${style.label} 未登录，${style.loginHint}。原文：${raw}` : `本机 ${style.label} 未登录，请在终端运行 ${style.loginCommand}。原文：${raw}`;
	if (style.authFailed?.test(raw)) return `${style.label} 认证失败，请在终端运行 ${style.loginCommand} 重新登录。原文：${raw}`;
	if (QUOTA.test(raw)) return `${style.label} 的${CLI_QUOTA_HINT}（服务方返回额度不足），可以换个模型，或等额度恢复后再试。原文：${raw}`;
	return `${style.label} 出错：${raw}`;
}
