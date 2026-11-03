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

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * 内置「更多模型」清单：claude `/model` 菜单只有几个别名，这里补上具体版本（`claude --model` 接受完整模型 ID）。
 * 来源：Anthropic 官方模型列表，开发时手动维护，不自动更新。
 */
export const CLAUDE_EXTRA_MODELS: readonly { id: string; label: string }[] = [
	{ id: "claude-opus-5-5", label: "Opus 5.5" },
	{ id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
	{ id: "claude-fable-5-1", label: "Fable 5.1" },
	{ id: "claude-haiku-5-5", label: "Haiku 5.5" },
	{ id: "claude-opus-5", label: "Opus 5" },
	{ id: "claude-sonnet-5", label: "Sonnet 5" },
	{ id: "claude-fable-5", label: "Fable 5" },
	{ id: "claude-opus-4-8", label: "Opus 4.8" },
	{ id: "claude-opus-4-7", label: "Opus 4.7" },
	{ id: "claude-opus-4-6", label: "Opus 4.6" },
	{ id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

/** 自定义模型 ID 校验：非空、无空白、≤100 字符、只含 `[A-Za-z0-9._\-\[\]:/]`。返回错误说明，合法返回 null。 */
export function validateClaudeModelId(raw: unknown): string | null {
	const id = typeof raw === "string" ? raw : "";
	if (!id.trim()) return "模型 ID 不能为空";
	if (/\s/.test(id)) return "模型 ID 不能含空格";
	if (id.length > 100) return "模型 ID 太长（最多 100 个字符）";
	if (!/^[A-Za-z0-9._\-[\]:/]+$/.test(id)) return "模型 ID 只能含字母、数字和 . _ - [ ] : /";
	return null;
}

function extraInfo(id: string, label: string, efforts: string[]): ClaudeModelInfo {
	return { id, name: `${PREFIX}${label}`, reasoning: efforts.length > 0, efforts, contextWindow: 200_000 };
}

/**
 * 模型列表 = claude 问到的别名（在前）+ 内置清单 + 用户自定义 ID，按 id 去重（先到先得）。
 * 清单项的思考档位沿用别名里同家族（id 含 opus / sonnet / haiku / fable）的档位，没有同家族别名就给全档；haiku 4.5 无档位。
 * 自定义 ID 按 id 含 haiku 与否判断。
 */
export function mergeClaudeModels(aliases: readonly ClaudeModelInfo[], custom: readonly string[] = []): ClaudeModelInfo[] {
	const familyEfforts = (id: string): string[] => {
		const fam = ["opus", "sonnet", "haiku", "fable"].find((f) => id.includes(f));
		const alias = aliases.find((a) => a.id === fam);
		return alias ? alias.efforts : ALL_EFFORTS;
	};
	const out: ClaudeModelInfo[] = [...aliases];
	const seen = new Set(out.map((m) => m.id));
	const add = (m: ClaudeModelInfo) => {
		if (!seen.has(m.id)) (seen.add(m.id), out.push(m));
	};
	for (const x of CLAUDE_EXTRA_MODELS) add(extraInfo(x.id, x.label, x.id === "claude-haiku-4-5" ? [] : [...familyEfforts(x.id)]));
	for (const id of custom) if (!validateClaudeModelId(id)) add(extraInfo(id, id, /haiku/i.test(id) ? [] : [...ALL_EFFORTS]));
	return out;
}
