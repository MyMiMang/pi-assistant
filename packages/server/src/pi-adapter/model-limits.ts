/**
 * 自定义服务里每个模型的上下文长度 / 最大输出：
 *  1) 自动识别：模型列表接口返回的字段（OpenRouter context_length、vLLM max_model_len、one-api/new-api、Gemini inputTokenLimit、Anthropic max_input_tokens…）
 *  2) 已知模型：按模型名匹配 Pi 内置的模型元数据，再退到常见国产 / 海外模型表
 *  3) 默认：128K 上下文、8K 输出（保守值，界面标“默认”，可以改）
 * 用户手动改过的标记为 user，之后不再覆盖。
 */
export type LimitsSource = "detected" | "known" | "default" | "user";
export interface Limits {
	contextWindow: number;
	maxTokens: number;
	source: LimitsSource;
}
export const DEFAULT_LIMITS = { contextWindow: 128_000, maxTokens: 8_192 };

const num = (v: unknown) => {
	const n = typeof v === "string" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
};
const pick = (o: Record<string, unknown> | undefined, keys: string[]) => {
	if (!o) return undefined;
	for (const k of keys) {
		const v = num(o[k]);
		if (v) return v;
	}
	return undefined;
};
const CTX_KEYS = ["context_length", "context_window", "max_model_len", "max_context_length", "max_context_tokens", "contextWindow", "context_size", "inputTokenLimit", "max_input_tokens", "max_sequence_length"];
const OUT_KEYS = ["max_output_tokens", "max_completion_tokens", "outputTokenLimit", "max_output_length", "maxTokens", "max_tokens"];

/** 从模型列表接口的单个条目里读上下文 / 输出（纯函数） */
export function detectLimits(raw: Record<string, unknown>): { contextWindow?: number; maxTokens?: number } {
	const top = raw.top_provider as Record<string, unknown> | undefined;
	const meta = (raw.meta ?? raw.metadata ?? raw.limits) as Record<string, unknown> | undefined;
	const contextWindow = pick(raw, CTX_KEYS) ?? pick(top, CTX_KEYS) ?? pick(meta, CTX_KEYS);
	let maxTokens = pick(raw, OUT_KEYS) ?? pick(top, OUT_KEYS) ?? pick(meta, OUT_KEYS);
	// 有的中转把 max_tokens 填成上下文长度：输出不可能大于等于上下文
	if (maxTokens && contextWindow && maxTokens >= contextWindow) maxTokens = undefined;
	return { contextWindow, maxTokens };
}

/** 常见模型（Pi 内置目录里找不到时用；按顺序匹配，越具体越靠前） */
const TABLE: [RegExp, number, number][] = [
	[/deepseek.*(r1|reasoner)/, 128_000, 32_768],
	[/deepseek/, 128_000, 8_192],
	[/qwen.*(long|turbo)/, 1_000_000, 8_192],
	[/qwen3?.*(max|plus|coder|235b|480b)/, 256_000, 32_768],
	[/qwen/, 128_000, 8_192],
	[/glm-?4\.[5-9]|glm-?[5-9]/, 128_000, 32_768],
	[/glm/, 128_000, 8_192],
	[/kimi.*k2|moonshot.*k2/, 256_000, 32_768],
	[/kimi|moonshot/, 128_000, 8_192],
	[/doubao.*(1\.5|1-5|seed)/, 256_000, 16_384],
	[/doubao/, 128_000, 8_192],
	[/minimax|abab/, 1_000_000, 16_384],
	[/ernie/, 128_000, 8_192],
	[/hunyuan/, 256_000, 8_192],
	[/yi-/, 200_000, 8_192],
	[/gpt-?5/, 400_000, 128_000],
	[/gpt-?4\.1/, 1_000_000, 32_768],
	[/gpt-?4o|gpt-?4-turbo/, 128_000, 16_384],
	[/o[134](-mini)?\b/, 200_000, 100_000],
	[/claude.*(opus|sonnet|haiku)/, 200_000, 32_000],
	[/claude/, 200_000, 8_192],
	[/gemini/, 1_000_000, 65_536],
	[/grok/, 256_000, 32_768],
	[/llama-?3\.[1-9]|llama-?4/, 128_000, 8_192],
	[/mistral|mixtral/, 128_000, 8_192],
];

/** 统一模型名：小写，去掉厂商前缀（deepseek-ai/、openrouter 风格的 vendor/）和日期 / 量化后缀 */
export const normId = (id: string) => id.toLowerCase().split("/").pop()!.replace(/:.*$/, "");

/** 已知模型：先按 id 精确 / 去前缀匹配 Pi 内置目录，再查常见模型表 */
export function knownLimits(id: string, builtin: { id: string; contextWindow?: number; maxTokens?: number }[]): { contextWindow: number; maxTokens: number } | null {
	const n = normId(id);
	const hit = builtin.find((m) => m.contextWindow && normId(m.id) === n) ?? builtin.find((m) => m.contextWindow && n.length >= 6 && (normId(m.id).startsWith(n) || n.startsWith(normId(m.id))));
	if (hit?.contextWindow) return { contextWindow: hit.contextWindow, maxTokens: hit.maxTokens && hit.maxTokens < hit.contextWindow ? hit.maxTokens : Math.min(DEFAULT_LIMITS.maxTokens, hit.contextWindow) };
	for (const [re, c, o] of TABLE) if (re.test(n)) return { contextWindow: c, maxTokens: o };
	return null;
}

/** 综合：用户填的 > 接口识别 > 已知模型 > 默认；只缺一项时另一项按同一顺序补 */
export function resolveLimits(
	m: { id: string; contextWindow?: number; maxTokens?: number; limitsSource?: LimitsSource },
	detected: { contextWindow?: number; maxTokens?: number } | undefined,
	builtin: { id: string; contextWindow?: number; maxTokens?: number }[],
): Limits {
	if (m.limitsSource === "user" && m.contextWindow && m.maxTokens) return { contextWindow: m.contextWindow, maxTokens: m.maxTokens, source: "user" };
	if (m.contextWindow && m.maxTokens && m.limitsSource) return { contextWindow: m.contextWindow, maxTokens: m.maxTokens, source: m.limitsSource };
	const known = knownLimits(m.id, builtin);
	const ctx = m.contextWindow ?? detected?.contextWindow ?? known?.contextWindow ?? DEFAULT_LIMITS.contextWindow;
	let out = m.maxTokens ?? detected?.maxTokens ?? known?.maxTokens ?? DEFAULT_LIMITS.maxTokens;
	if (out >= ctx) out = Math.min(DEFAULT_LIMITS.maxTokens, Math.floor(ctx / 4));
	const source: LimitsSource = m.contextWindow ? "user" : detected?.contextWindow ? "detected" : known ? "known" : "default";
	return { contextWindow: ctx, maxTokens: out, source };
}
