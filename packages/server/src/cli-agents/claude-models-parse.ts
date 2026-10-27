/**
 * Claude Code 模型列表：把 `initialize` 回包里的 `models` 转成 Pi 模型信息（纯函数，便于单测）。
 * 方案：docs/design/cli-models.md §4.2。只取 `models`，回包里的 `account` 等字段一概不读。
 */

export interface ClaudeModelInfo {
	/** Pi 模型 id = claude `/model` 菜单里的 `value`，原样传给 `--model` */
	id: string;
	/** 已带 `Claude Code · ` 前缀 */
	name: string;
	/** 支持思考强度 */
	reasoning: boolean;
	/** 支持的思考强度档位（`supportsEffort` 为假时为空） */
	efforts: string[];
	contextWindow: number;
}

const PREFIX = "Claude Code · ";
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** 一行 `control_response` 里的原始 `models` 数组；两种嵌套都兼容，取不到返回 null。 */
export function extractModels(line: unknown): unknown[] | null {
	const outer = (line as { response?: { response?: { models?: unknown }; models?: unknown } } | null)?.response;
	const models = outer?.response?.models ?? outer?.models;
	return Array.isArray(models) ? models : null;
}

/** 单个模型的显示名（不含前缀、不处理重名） */
function baseName(value: string, displayName: string, description: string): string {
	if (value === "default") return "默认";
	const custom = /^Custom .+ model$/i.test(description); // 别名被用户的中转 / 自定义映射过，displayName 不再是官方名
	const name = custom ? `${cap(value)}（${displayName || value}）` : displayName || value;
	return value.includes("[1m]") ? `${name} · 1M 上下文` : name;
}

/** `models` 数组 → Pi 模型信息；没有可用条目返回空数组。重名的在后面补 `（value）`。 */
export function parseClaudeModels(raw: unknown[] | null): ClaudeModelInfo[] {
	const out: ClaudeModelInfo[] = [];
	const seen = new Set<string>();
	for (const item of raw ?? []) {
		const m = item as Record<string, unknown> | null;
		const value = str(m?.value);
		if (!m || !value || seen.has(value)) continue;
		seen.add(value);
		const efforts = m.supportsEffort === true && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e): e is string => typeof e === "string") : [];
		out.push({
			id: value,
			name: PREFIX + baseName(value, str(m.displayName), str(m.description)),
			reasoning: m.supportsEffort === true,
			efforts,
			contextWindow: value.includes("[1m]") ? 1_000_000 : 200_000,
		});
	}
	const count = new Map<string, number>();
	for (const m of out) count.set(m.name, (count.get(m.name) ?? 0) + 1);
	return out.map((m) => ((count.get(m.name) ?? 0) > 1 ? { ...m, name: `${m.name}（${m.id}）` } : m));
}

/** 问不到列表时退回的三个别名：保证已经选了 opus / sonnet / haiku 的助理照常能用。haiku 不支持思考强度。 */
export const CLAUDE_FALLBACK_MODELS: readonly ClaudeModelInfo[] = [
	{ id: "opus", name: `${PREFIX}Opus`, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 200_000 },
	{ id: "sonnet", name: `${PREFIX}Sonnet`, reasoning: true, efforts: ["low", "medium", "high", "xhigh", "max"], contextWindow: 200_000 },
	{ id: "haiku", name: `${PREFIX}Haiku`, reasoning: false, efforts: [], contextWindow: 200_000 },
];
