/**
 * 自定义服务里每个模型的上下文长度 / 最大输出：
 *  1) 自动识别：模型列表接口返回的字段（OpenRouter context_length、vLLM max_model_len、one-api/new-api、Gemini inputTokenLimit、Anthropic max_input_tokens…）
 *  2) 已知模型：按模型名匹配 Pi 内置的模型元数据，再退到常见国产 / 海外模型表
 *     ——Pi 内置目录 + models.dev 模型参数库（model-db.ts），同一服务商优先
 *  3) 默认：256K 上下文、128K 输出（界面标“默认”，可以改）；请求被拒时自动下调并记为“自动学习”
 * 用户手动改过的标记为 user，之后不再覆盖。
 */
export type LimitsSource = "detected" | "known" | "default" | "user" | "learned";
export interface Limits {
	contextWindow: number;
	maxTokens: number;
	source: LimitsSource;
}
/** 查不到时的默认：256K 上下文、128K 输出（服务端嫌大会报错，我们按报错自动下调并记住，见 learnFromError） */
export const DEFAULT_LIMITS = { contextWindow: 262_144, maxTokens: 131_072 };

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
export const normId = (id: string) =>
	id
		.toLowerCase()
		.trim()
		.split("/")
		.pop()!
		.replace(/:.*$/, "")
		.replace(/@.*$/, "")
		.replace(/^(models\/)?/, "")
		.replace(/(\d)p(\d)/g, "$1.$2") // fireworks：v4p1 → v4.1
		.replace(/[_\s]+/g, "-")
		.replace(/-(free|online|beta)$/, "");
/** 再去掉日期 / 快照后缀（-0731、-2025-01-01、-latest），只用于同一个模型不同快照之间匹配 */
export const baseId = (n: string) => n.replace(/(-(\d{4}(-\d{2}){0,2}|\d{6,8}|latest|preview|v\d+(:\d+)?))+$/, "");

/** 模型厂商自己的服务优先（同一模型在不同托管商的上限不一样，以官方为准） */
const OFFICIAL = ["deepseek", "zai", "zhipu", "moonshotai", "moonshot", "kimi-coding", "alibaba", "qwen", "minimax", "openai", "anthropic", "google", "xai", "mistral"];

type Builtin = { id: string; provider?: string; api?: string; contextWindow?: number; maxTokens?: number; vision?: boolean; imageOutput?: boolean; reasoning?: boolean; toolCall?: boolean; cost?: (number | null)[]; thinkingLevelMap?: Record<string, string | null> };
/** 模型参数库条目（同 Builtin，maxTokens 为 0 表示未知） */
export type DbEntry = Builtin;
/** models.dev 精简数据 → 条目列表 */
export function indexModelDb(providers: Record<string, Record<string, (number | (number | null)[])[]>>): DbEntry[] {
	const out: DbEntry[] = [];
	for (const [provider, ms] of Object.entries(providers))
		for (const [id, [c, o, f, cost]] of Object.entries(ms)) {
			const v = typeof f === "number" ? f : 0;
			out.push({ provider, id, contextWindow: c as number, maxTokens: (o as number) || undefined, ...(v & 1 ? { vision: true } : {}), ...(v & 2 ? { reasoning: true } : {}), ...(v & 8 ? { imageOutput: true } : {}), ...(v & 4 ? { toolCall: true } : {}), ...(Array.isArray(cost) ? { cost } : {}) });
		}
	return out;
}

/** 按模型名查是否支持识图（models.dev 的 modalities.input）：同一模型任一托管商标了图片就算；查不到返回 undefined */
export function knownVision(id: string, db: DbEntry[]): boolean | undefined {
	return knownCapability(id, db, "vision");
}
export function knownReasoning(id: string, db: DbEntry[]): boolean | undefined {
	return knownCapability(id, db, "reasoning");
}
export function knownImageOutput(id: string, db: DbEntry[]): boolean | undefined {
	return knownCapability(id, db, "imageOutput");
}
function knownCapability(id: string, db: DbEntry[], key: "vision" | "reasoning" | "imageOutput") {
	const n = normId(id);
	let hits = db.filter((m) => normId(m.id) === n);
	if (!hits.length) hits = db.filter((m) => baseId(normId(m.id)) === baseId(n));
	if (!hits.length) return undefined;
	const off = hits.filter((m) => m.provider && OFFICIAL.includes(m.provider));
	const base = off.length ? off : hits;
	return base.filter((m) => m[key]).length * 2 > base.length;
}
/**
 * 思考档位映射（Pi 的 thinkingLevelMap）：自定义服务里的模型名若和 Pi 内置目录里的同一个模型一致，
 * 就照搬 Pi 自己的元数据，让「支持的档位」和真实 API 一致（含 xhigh / max）。
 * 匹配规则和 knownCapability 一致：同名优先、其次忽略日期快照；多个托管商给的不一样时，
 * 优先同协议（自定义服务用的 api），其次官方服务——都认不出来就返回 undefined，绝不凭空补档位。
 */
export function knownThinkingLevelMap(id: string, builtin: Builtin[], api?: string): Record<string, string | null> | undefined {
	const withMap = builtin.filter((m) => m.thinkingLevelMap && Object.keys(m.thinkingLevelMap).length);
	const n = normId(id);
	let hits = withMap.filter((m) => normId(m.id) === n);
	if (!hits.length) hits = withMap.filter((m) => baseId(normId(m.id)) === baseId(n));
	if (!hits.length) return undefined;
	const official = (list: Builtin[]) => list.filter((m) => m.provider && OFFICIAL.includes(m.provider));
	const sameApi = api ? hits.filter((m) => m.api === api) : [];
	const pick = official(sameApi)[0] ?? sameApi[0] ?? official(hits)[0] ?? hits[0];
	return pick ? { ...pick.thinkingLevelMap } : undefined;
}
/** 从 Base URL 猜服务商（api.deepseek.com → deepseek，open.bigmodel.cn → zhipuai…），用于“同服务商优先” */
export function providerHint(baseUrl?: string): string[] {
	if (!baseUrl) return [];
	let host = "";
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return [];
	}
	const map: [RegExp, string[]][] = [
		[/deepseek/, ["deepseek"]],
		[/bigmodel|zhipu/, ["zhipuai", "zai"]],
		[/z\.ai$/, ["zai"]],
		[/moonshot|kimi/, ["moonshotai-cn", "moonshotai"]],
		[/dashscope|aliyun|alibaba/, ["alibaba-cn", "alibaba"]],
		[/minimax/, ["minimax-cn", "minimax"]],
		[/volces|volcengine|ark\./, ["volcengine"]],
		[/siliconflow/, ["siliconflow-cn", "siliconflow"]],
		[/openrouter/, ["openrouter"]],
		[/openai\.com$/, ["openai"]],
		[/anthropic/, ["anthropic"]],
		[/googleapis|google/, ["google"]],
		[/x\.ai$/, ["xai"]],
		[/groq/, ["groq"]],
		[/together/, ["togetherai", "together"]],
		[/fireworks/, ["fireworks-ai", "fireworks"]],
		[/mistral/, ["mistral"]],
	];
	return map.find(([re]) => re.test(host))?.[1] ?? [];
}

/**
 * 已知模型：只按“同一个模型”匹配 Pi 内置目录（名称完全相同，或只差日期快照后缀），
 * 不做前缀模糊匹配——否则 glm-5.3-flash 会套用 glm-5.3 的上限、v4-flash 会套用 v4-pro 的。
 * 多个托管商都有时：官方服务优先，否则取最常见的上下文、各家输出的中位数。
 */
export function knownLimits(id: string, builtin: Builtin[], prefer: string[] = []): { contextWindow: number; maxTokens: number } | null {
	const n = normId(id);
	const ok = builtin.filter((m) => m.contextWindow);
	let hits = ok.filter((m) => normId(m.id) === n);
	if (!hits.length) hits = ok.filter((m) => baseId(normId(m.id)) === baseId(n));
	if (hits.length) {
		const outOk = (m: Builtin) => (m.maxTokens && m.maxTokens < m.contextWindow! ? m.maxTokens : undefined);
		const off = [...prefer, ...OFFICIAL].map((p) => hits.find((m) => m.provider === p && m.contextWindow)).find(Boolean);
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
	for (const [re, c, o] of TABLE)
		if (re.test(n)) {
			// 名字里写明了上下文（moonshot-v1-32k、doubao-1-5-pro-32k）就以名字为准
			const k = Number(n.match(/-(\d{1,4})k(?:-|$)/)?.[1]);
			const ctx = k >= 4 ? k * 1024 : c;
			return { contextWindow: ctx, maxTokens: Math.min(o, Math.floor(ctx / 4)) };
		}
	return null;
}

/** 综合：用户填的 > 接口识别 > 已知模型 > 默认；只缺一项时另一项按同一顺序补 */
export function resolveLimits(
	m: { id: string; contextWindow?: number; maxTokens?: number; limitsSource?: LimitsSource },
	detected: { contextWindow?: number; maxTokens?: number } | undefined,
	builtin: Builtin[],
	prefer: string[] = [],
): Limits {
	if ((m.limitsSource === "user" || m.limitsSource === "learned") && m.contextWindow && m.maxTokens) return { contextWindow: m.contextWindow, maxTokens: m.maxTokens, source: m.limitsSource };
	// 接口识别的值只在获取时拿得到，保留；“已知 / 默认”每次按最新规则重算（规则修正后旧值会自动更新）
	if (m.contextWindow && m.maxTokens && m.limitsSource === "detected") return { contextWindow: m.contextWindow, maxTokens: m.maxTokens, source: m.limitsSource };
	const known = knownLimits(m.id, builtin, prefer);
	const stale = m.limitsSource === "known" || m.limitsSource === "default";
	if (stale) m = { id: m.id };
	const ctx = m.contextWindow ?? detected?.contextWindow ?? known?.contextWindow ?? DEFAULT_LIMITS.contextWindow;
	let out = m.maxTokens ?? detected?.maxTokens ?? known?.maxTokens ?? DEFAULT_LIMITS.maxTokens;
	if (out >= ctx) out = Math.min(DEFAULT_LIMITS.maxTokens, Math.floor(ctx / 4));
	const source: LimitsSource = m.contextWindow ? "user" : detected?.contextWindow ? "detected" : known ? "known" : "default";
	return { contextWindow: ctx, maxTokens: out, source };
}

/**
 * 请求被服务端拒绝时从报错里学上限：
 *  - 输出太大（max_tokens too large / valid range [1, 8192] / at most N / N, which is the maximum…）：
 *    报错里有允许值就用它，没有就逐级下调 128K → 64K → 32K → 16K → 8K；返回 retry=true 让会话自动重试
 *  - 上下文超长且报错给出了真实上下文长度（maximum context length is N）：记下来，由 Pi 的自动整理处理
 * 认不出来返回 null。
 */
export function learnFromError(msg: string | undefined, cur: { contextWindow?: number; maxTokens?: number }): { contextWindow?: number; maxTokens?: number; retry: boolean } | null {
	if (!msg) return null;
	const t = msg.replace(/,(?=\d{3})/g, "");
	const n = (re: RegExp) => {
		const m = t.match(re);
		return m ? Number(m[1]) : undefined;
	};
	const ctxLimit = n(/maximum context length is (\d+)/i) ?? n(/context (?:length|window)(?: limit)? (?:is|of) (\d+)/i);
	const inputTok = n(/(?:request has|messages resulted in|you requested) (\d+) (?:input )?tokens/i);
	const outErr = /(max_(?:completion_|output_)?tokens|max_new_tokens|maxOutputTokens|output tokens?|completion tokens?)/i.test(t) && /(too large|exceed|range|at most|maximum|less than|greater than|must be|<=|>|invalid|not supported|limit)/i.test(t);
	if (outErr && !/rate.?limit|per minute|quota|tpm|rpm/i.test(t)) {
		let allowed =
			n(/range of max_\w*tokens is \[\s*\d+\s*,\s*(\d+)\s*\]/i) ??
			n(/\[\s*1\s*,\s*(\d+)\s*\]/) ??
			n(/at most (\d+)/i) ??
			n(/(\d+),? which is the maximum/i) ??
			n(/less than or equal to (\d+)/i) ??
			n(/<=\s*(\d+)/) ??
			n(/maximum (?:allowed )?(?:value |number of (?:output |completion )?tokens )?(?:is |of )?(\d+)/i) ??
			n(/supports? (?:up to |at most )?(\d+) (?:output |completion )?tokens/i);
		if (!allowed && ctxLimit && inputTok && ctxLimit > inputTok) allowed = ctxLimit - inputTok;
		const curOut = cur.maxTokens ?? DEFAULT_LIMITS.maxTokens;
		if (!allowed || allowed >= curOut) allowed = [131_072, 65_536, 32_768, 16_384, 8_192].find((x) => x < curOut);
		if (!allowed || allowed < 256) return null;
		const ctx = ctxLimit && ctxLimit < (cur.contextWindow ?? Infinity) ? ctxLimit : undefined;
		return { maxTokens: allowed, contextWindow: ctx, retry: true };
	}
	if (ctxLimit && cur.contextWindow && ctxLimit < cur.contextWindow && /context|too long|too many tokens|exceed/i.test(t)) return { contextWindow: ctxLimit, retry: false };
	return null;
}
