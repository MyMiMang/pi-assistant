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

/** 常见模型（Pi 内置目录里找不到时用；按顺序匹配，越具体越靠前；输出长度取保守值） */
const TABLE: [RegExp, number, number][] = [
	[/deepseek-?v4/, 1_000_000, 32_768],
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

/** 统一模型名：小写，去掉厂商前缀（deepseek-ai/、openrouter 风格的 vendor/）和 :free 之类的后缀 */
export const normId = (id: string) => id.toLowerCase().split("/").pop()!.replace(/:.*$/, "");
/** 再去掉日期 / 快照后缀（-0731、-2025-01-01、-latest），只用于同一个模型不同快照之间匹配 */
const baseId = (n: string) => n.replace(/-(\d{4}(-\d{2}){0,2}|\d{6,8}|latest)$/, "");

/** 模型厂商自己的服务优先（同一模型在不同托管商的上限不一样，以官方为准） */
const OFFICIAL = ["deepseek", "zai", "zhipu", "moonshotai", "moonshot", "kimi-coding", "alibaba", "qwen", "minimax", "openai", "anthropic", "google", "xai", "mistral"];

type Builtin = { id: string; provider?: string; contextWindow?: number; maxTokens?: number };

/**
 * 已知模型：只按“同一个模型”匹配 Pi 内置目录（名称完全相同，或只差日期快照后缀），
 * 不做前缀模糊匹配——否则 glm-5.3-flash 会套用 glm-5.3 的上限、v4-flash 会套用 v4-pro 的。
 * 多个托管商都有时：官方服务优先，否则取最常见的上下文、各家输出的中位数。
 */
export function knownLimits(id: string, builtin: Builtin[]): { contextWindow: number; maxTokens: number } | null {
	const n = normId(id);
	const ok = builtin.filter((m) => m.contextWindow);
	let hits = ok.filter((m) => normId(m.id) === n);
	if (!hits.length) hits = ok.filter((m) => baseId(normId(m.id)) === baseId(n));
	if (hits.length) {
		const outOk = (m: Builtin) => (m.maxTokens && m.maxTokens < m.contextWindow! ? m.maxTokens : undefined);
		const off = OFFICIAL.map((p) => hits.find((m) => m.provider === p)).find(Boolean);
		let ctx: number;
		let outs: number[];
		if (off) {
			ctx = off.contextWindow!;
			outs = [outOk(off)].filter((x): x is number => !!x);
			// 官方把输出写成和上下文一样大（表示“不单独限制”）时，参考其他托管商
			if (!outs.length) outs = hits.map(outOk).filter((x): x is number => !!x && x < ctx).sort((a, b) => a - b);
		} else {
			const count = new Map<number, number>();
			for (const m of hits) count.set(m.contextWindow!, (count.get(m.contextWindow!) ?? 0) + 1);
			ctx = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
			outs = hits.filter((m) => m.contextWindow === ctx).map(outOk).filter((x): x is number => !!x).sort((a, b) => a - b);
		}
		const out = outs.length ? outs[Math.floor((outs.length - 1) / 2)] : Math.min(DEFAULT_LIMITS.maxTokens, Math.floor(ctx / 4));
		return { contextWindow: ctx, maxTokens: out };
	}
	for (const [re, c, o] of TABLE) if (re.test(n)) return { contextWindow: c, maxTokens: o };
	return null;
}

/** 综合：用户填的 > 接口识别 > 已知模型 > 默认；只缺一项时另一项按同一顺序补 */
export function resolveLimits(
	m: { id: string; contextWindow?: number; maxTokens?: number; limitsSource?: LimitsSource },
	detected: { contextWindow?: number; maxTokens?: number } | undefined,
	builtin: Builtin[],
): Limits {
	if (m.limitsSource === "user" && m.contextWindow && m.maxTokens) return { contextWindow: m.contextWindow, maxTokens: m.maxTokens, source: "user" };
	// 接口识别的值只在获取时拿得到，保留；“已知 / 默认”每次按最新规则重算（规则修正后旧值会自动更新）
	if (m.contextWindow && m.maxTokens && m.limitsSource === "detected") return { contextWindow: m.contextWindow, maxTokens: m.maxTokens, source: m.limitsSource };
	const known = knownLimits(m.id, builtin);
	const stale = m.limitsSource === "known" || m.limitsSource === "default";
	if (stale) m = { id: m.id };
	const ctx = m.contextWindow ?? detected?.contextWindow ?? known?.contextWindow ?? DEFAULT_LIMITS.contextWindow;
	let out = m.maxTokens ?? detected?.maxTokens ?? known?.maxTokens ?? DEFAULT_LIMITS.maxTokens;
	if (out >= ctx) out = Math.min(DEFAULT_LIMITS.maxTokens, Math.floor(ctx / 4));
	const source: LimitsSource = m.contextWindow ? "user" : detected?.contextWindow ? "detected" : known ? "known" : "default";
	return { contextWindow: ctx, maxTokens: out, source };
}
