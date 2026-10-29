/**
 * 本机命令行渠道的注册样板和报错文字（claude / codex / agy 共用）。
 * 渠道不需要密钥：给个占位让 Pi 把渠道算作可用，登录状态由设置卡片的检测负责；用量 cost 一律 0（订阅不显示钱）。
 */
import type { PiModels } from "../index.ts";

/** 本机命令行渠道的 provider id（新增一家在这里登记）：用量不按名字去价格库里「猜价」（订阅用户看 API 标价会被误导，且 gpt-* 会撞上官方同名模型） */
export const CLI_PROVIDER_IDS: readonly string[] = ["claude-code", "codex", "antigravity", "opencode-cli"];

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

/** 把一个本机命令行渠道（含它的 streamSimple 和模型）注册进 Pi；再调一次就是刷新模型列表。 */
export async function registerCliProvider(models: PiModels, spec: CliProviderSpec): Promise<void> {
	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
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
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
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
	/** 匹配「没登录」的原文 */
	notLoggedIn: RegExp;
	/** 匹配「认证失败 / 登录过期」的原文（可选） */
	authFailed?: RegExp;
}

/** 命令行工具报错 → 中文说明，带上原文 */
export function describeCliError(style: CliErrorStyle, text: string): string {
	const raw = text.trim() || "（没有错误内容）";
	if (style.notLoggedIn.test(raw)) return `本机 ${style.label} 未登录，请在终端运行 ${style.loginCommand}。原文：${raw}`;
	if (style.authFailed?.test(raw)) return `${style.label} 认证失败，请在终端运行 ${style.loginCommand} 重新登录。原文：${raw}`;
	return `${style.label} 出错：${raw}`;
}
