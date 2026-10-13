/**
 * 模型能力档案 + 建群时给角色挑模型（DESIGN §「组队选模型」）。
 *  - 硬能力来自 models.dev 快照（识图 / 推理 / 工具调用 / 上下文 / 价格）+ Pi 自己的模型元数据；
 *  - “擅长什么”是一份手工整理的标签表（按模型系列匹配，依据各家官方文档、LMArena、Artificial Analysis 的公开排名，季度更新），
 *    用户可以在 设置 › 模型 › 模型擅长 里按模型改（存在 settings.modelStrengths，覆盖默认）；
 *  - 打分：必须的能力不满足直接排除 → 想要的能力命中加分 → 按价格扣分（管理者扣得少）→ 默认模型同分优先；没有合格的就用默认模型并说明。
 * 纯函数（scoreModels / defaultStrengths / priceTier）不依赖数据库，方便单测。
 */
export const STRENGTHS = ["coding", "reasoning", "writing_zh", "writing", "vision", "long_context", "tool_use", "cheap", "fast"] as const;
export type Strength = (typeof STRENGTHS)[number];
export const STRENGTH_LABEL: Record<Strength, string> = {
	coding: "写代码",
	reasoning: "推理",
	writing_zh: "中文写作",
	writing: "写作",
	vision: "看图",
	long_context: "长文档",
	tool_use: "用工具",
	cheap: "便宜",
	fast: "快",
};

/** 按模型系列的默认擅长标签（越具体越靠前，命中第一条；cheap/fast/vision/long_context/tool_use 另由硬数据补） */
const FAMILY: [RegExp, Strength[]][] = [
	[/claude.*(opus|sonnet)/, ["coding", "reasoning", "writing", "tool_use"]],
	[/claude.*haiku/, ["coding", "tool_use", "fast"]],
	[/gpt-?5.*(mini|nano)/, ["coding", "fast"]],
	[/gpt-?5.*codex|codex/, ["coding", "tool_use"]],
	[/gpt-?5/, ["coding", "reasoning", "writing", "tool_use"]],
	[/gpt-?4\.1|gpt-?4o/, ["writing", "tool_use"]],
	[/\bo[134]\b|o[34]-mini/, ["reasoning", "coding"]],
	[/gemini.*(flash|lite)/, ["fast", "long_context"]],
	[/gemini/, ["reasoning", "coding", "long_context"]],
	[/grok.*(fast|mini)/, ["fast", "coding"]],
	[/grok/, ["reasoning", "coding"]],
	[/deepseek.*(r1|reasoner)/, ["reasoning", "writing_zh"]],
	[/deepseek.*flash/, ["writing_zh", "coding", "fast"]],
	[/deepseek/, ["coding", "reasoning", "writing_zh", "tool_use"]],
	[/qwen.*coder/, ["coding", "tool_use"]],
	[/qwen.*(vl|omni)/, ["writing_zh"]],
	[/qwen.*(turbo|flash)/, ["writing_zh", "fast"]],
	[/qwen/, ["writing_zh", "reasoning", "coding"]],
	[/kimi|moonshot/, ["writing_zh", "coding", "tool_use", "long_context"]],
	[/glm/, ["writing_zh", "coding", "tool_use"]],
	[/minimax|abab/, ["writing_zh", "long_context", "tool_use"]],
	[/doubao.*(lite|flash)/, ["writing_zh", "fast"]],
	[/doubao|seed/, ["writing_zh", "reasoning"]],
	[/hunyuan|ernie/, ["writing_zh"]],
	[/mimo/, ["writing_zh", "reasoning"]],
	[/llama|mistral|gemma/, ["fast"]],
];

export interface ModelFacts {
	provider: string;
	id: string;
	name?: string;
	vision?: boolean;
	reasoning?: boolean;
	toolCall?: boolean;
	contextWindow?: number;
	/** 美元 / 百万 token；查不到为 undefined */
	price?: { input: number; output: number };
}
export interface ModelProfile extends ModelFacts {
	tags: Strength[];
	tier: PriceTier;
	userEdited: boolean;
}
export type PriceTier = "free" | "cheap" | "mid" | "pricey" | "unknown";
export const TIER_LABEL: Record<PriceTier, string> = { free: "免费", cheap: "¥", mid: "¥¥", pricey: "¥¥¥", unknown: "价格未知" };

const norm = (id: string) => id.toLowerCase().split("/").pop()!.replace(/:.*$/, "");

/** 综合单价（按 输入:输出 ≈ 3:1 的典型助理用法），美元 / 百万 token */
export const blended = (p?: { input: number; output: number }) => (p ? (p.input * 3 + p.output) / 4 : undefined);
export function priceTier(p?: { input: number; output: number }): PriceTier {
	const b = blended(p);
	if (b === undefined) return "unknown";
	if (b === 0) return "free";
	if (b < 1) return "cheap";
	if (b < 5) return "mid";
	return "pricey";
}

export function defaultStrengths(f: ModelFacts): Strength[] {
	const n = norm(f.id);
	const tags = new Set<Strength>(FAMILY.find(([re]) => re.test(n))?.[1] ?? []);
	if (f.vision) tags.add("vision");
	if (f.reasoning) tags.add("reasoning");
	if ((f.contextWindow ?? 0) >= 500_000) tags.add("long_context");
	if (f.toolCall && !tags.has("tool_use") && /claude|gpt|gemini|deepseek|kimi|glm|qwen/.test(n)) tags.add("tool_use");
	const t = priceTier(f.price);
	if (t === "free" || t === "cheap") tags.add("cheap");
	if (/flash|mini|nano|lite|turbo|haiku|fast/.test(n)) tags.add("fast");
	return STRENGTHS.filter((s) => tags.has(s));
}

export function buildProfile(f: ModelFacts, overrides: Record<string, Strength[]> = {}): ModelProfile {
	const key = `${f.provider}/${f.id}`;
	const o = overrides[key];
	return { ...f, tags: o ? STRENGTHS.filter((s) => o.includes(s)) : defaultStrengths(f), tier: priceTier(f.price), userEdited: !!o };
}

// ---------------------------------------------------------------- 角色需求 → 打分
export interface RoleNeeds {
	/** 想要的能力（命中加分） */
	needs: Strength[];
	/** 管理者 / 协调：更看重推理、对价格不那么敏感 */
	manager?: boolean;
}
/** 必须满足的硬能力：要看图就必须能识图；所有群成员都要能调用工具（模型不支持工具调用时直接排除，未知不排除） */
const HARD: Strength[] = ["vision"];

/** 角色说明里的关键词 → 能力（管理者没写 needs 时兜底） */
const KEYWORDS: [RegExp, Strength][] = [
	[/代码|编程|开发|程序|前端|后端|脚本|code|dev|engineer|bug|测试/i, "coding"],
	[/分析|推理|规划|策略|数学|架构|审核|评审|决策|研究/i, "reasoning"],
	[/文案|写作|撰写|编辑|翻译|中文|公众号|小红书|润色|故事/i, "writing_zh"],
	[/图片|看图|识图|截图|设计稿|视觉|海报|image|vision/i, "vision"],
	[/长文档|论文|报告|资料|整理|总结|summar/i, "long_context"],
	[/搜索|浏览|网页|爬|操作|执行|自动化/i, "tool_use"],
	[/便宜|省钱|简单|杂事|批量/i, "cheap"],
];
export function inferNeeds(text: string): Strength[] {
	const out = new Set<Strength>();
	for (const [re, s] of KEYWORDS) if (re.test(text)) out.add(s);
	return [...out];
}

export interface Ranked {
	provider: string;
	id: string;
	score: number;
	tier: PriceTier;
	tags: Strength[];
	/** 一句话理由（中文） */
	reason: string;
	/** 被硬条件排除的（下拉里仍可选，排在最后） */
	excluded?: string;
}

export function scoreModels(role: RoleNeeds, profiles: ModelProfile[], def?: { provider: string; id: string } | null): Ranked[] {
	const needs = [...new Set(role.needs)].filter((s) => (STRENGTHS as readonly string[]).includes(s));
	const out = profiles.map((p): Ranked => {
		const isDef = !!def && def.provider === p.provider && def.id === p.id;
		const miss = HARD.filter((h) => needs.includes(h) && !p.tags.includes(h));
		let excluded = miss.length ? `不能${miss.map((m) => STRENGTH_LABEL[m]).join("、")}` : undefined;
		if (!excluded && p.toolCall === false) excluded = "不支持调用工具";
		const hit = needs.filter((s) => p.tags.includes(s));
		let score = hit.length * 10;
		if (role.manager && p.tags.includes("reasoning")) score += 4;
		if (p.reasoning && needs.includes("reasoning")) score += 2;
		// 价格：没要求“便宜”时只轻扣；要求便宜时按档位明显扣分；管理者扣一半
		const b = blended(p.price);
		const wantCheap = needs.includes("cheap");
		const k = (wantCheap ? 3 : 1) * (role.manager ? 0.5 : 1);
		if (b !== undefined) score -= Math.min(8, Math.log2(1 + b)) * k;
		else score -= 1.5 * k; // 价格未知：小扣
		if (isDef) score += 1.5;
		if (excluded) score -= 1000;
		const good = hit.filter((s) => s !== "cheap").map((s) => STRENGTH_LABEL[s]);
		const parts = [
			good.length ? `擅长${good.join("、")}` : needs.length ? "没有特别对口的强项" : "通用",
			TIER_LABEL[p.tier] === "价格未知" ? "价格未知" : p.tier === "free" ? "免费" : `价格${{ cheap: "便宜", mid: "中等", pricey: "较贵" }[p.tier as "cheap"]}`,
		];
		if (isDef) parts.push("你的默认模型");
		return { provider: p.provider, id: p.id, score: Math.round(score * 10) / 10, tier: p.tier, tags: p.tags, reason: excluded ? `${excluded}，不适合这个角色` : parts.join("，"), excluded };
	});
	return out.sort((a, b) => b.score - a.score || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
}

/** 选第一名；全被排除时退回默认模型并说明 */
export function pickModel(role: RoleNeeds, profiles: ModelProfile[], def?: { provider: string; id: string } | null): { model: { provider: string; id: string } | null; reason: string } {
	const r = scoreModels(role, profiles, def);
	const top = r[0];
	if (top && !top.excluded) return { model: { provider: top.provider, id: top.id }, reason: top.reason };
	if (def) return { model: def, reason: profiles.length ? "没有完全符合要求的模型，先用默认模型" : "默认模型" };
	return { model: null, reason: "还没有配置模型" };
}
