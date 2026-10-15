/**
 * Pi 的思考档位（`ModelThinkingLevel`）与「一组模型可用档位」的合并规则。
 *
 * 为什么放在 shared：界面（apps/web）和服务端（packages/server）都要用它，避免两边各写一份、
 * 出现「主会话有 xhigh、子代理下拉没有」这种不一致。Pi SDK 是唯一事实来源，这里只做映射与合并，
 * **不凭空发明档位**（xhigh / max 只保留 SDK 对某个模型明确给出的那些）。
 */

/** 与 Pi SDK 一致的档位顺序（off → max）；界面显示顺序也用它。 */
export const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVEL_ORDER)[number];

export const isThinkingLevel = (v: unknown): v is ThinkingLevel => typeof v === "string" && (THINKING_LEVEL_ORDER as readonly string[]).includes(v);

/**
 * 一组模型支持档位的**并集**，按 Pi 档位顺序去重。
 *
 * 用在「一个设置可能落到多个候选模型」的场景（尤其是子代理默认档位：候选池里最终用哪个模型是派活时按任务挑的）：
 * 只要有一个候选支持某档就保留它，**绝不取整池的最低共同集合**——那会把部分模型支持的 xhigh / max 裁掉，
 * 用户就会看到「档位不全」。
 *
 * 真正落到某个模型时，由服务端 `clampThinkingLevel` 按该模型收敛；不支持就合法降级并在界面说明原因，
 * 而不是在这里提前把用户的选择吞掉。
 */
export function thinkingLevelsUnion(perModel: readonly (readonly string[] | undefined | null)[]): ThinkingLevel[] {
	const set = new Set<string>();
	for (const levels of perModel) for (const l of levels ?? []) if (isThinkingLevel(l)) set.add(l);
	return THINKING_LEVEL_ORDER.filter((l) => set.has(l));
}

/** 带档位元数据的模型（界面用 ModelEntry、服务端用模型目录条目都能结构化匹配）。 */
export interface ThinkingCapableModel {
	provider: string;
	id: string;
	/** Pi 对**这一个模型**给出的可用档位（`getSupportedThinkingLevels`） */
	thinking?: readonly string[] | null;
}

/**
 * 选中的一组模型（`refs`）在目录 `all` 里支持档位的并集。
 * `refs` 只有一个模型时就是该模型的档位；空 `refs`（模型还没选中）返回空数组。
 * 子代理默认档位用候选池的全部模型作为 `refs`，因此保留任何候选支持的档位（含 xhigh / max）。
 */
export function thinkingLevelsFor(all: readonly ThinkingCapableModel[], refs: readonly { provider: string; id: string }[]): ThinkingLevel[] {
	const byKey = new Map(all.map((m) => [`${m.provider}/${m.id}`, m.thinking]));
	return thinkingLevelsUnion(refs.map((r) => byKey.get(`${r.provider}/${r.id}`)));
}
