/**
 * 用户在模型菜单里选过哪些模型：按频次 + 最近选择排序，给输入栏的「常用」置顶用。
 * 只存 provider/id 的计数和时间，不存任何凭据；存在 settings 表里（跟着数据目录走，电脑和手机共用）。
 */
import { getSetting, setSetting } from "./db.ts";

export interface ModelPick {
	count: number;
	at: number;
}
export type ModelPicks = Record<string, ModelPick>;

const KEY = "modelPicks";
/** 最多留这么多个模型的选择记录，超出按最近选择淘汰，避免设置项无限增长 */
export const MAX_PICKS = 80;

export function getModelPicks(): ModelPicks {
	const v = getSetting<ModelPicks>(KEY, {});
	return v && typeof v === "object" ? v : {};
}

/** 记一次选择（用户在菜单里点了某个模型）：频次 +1，更新时间。 */
export function recordModelPick(provider?: string | null, id?: string | null, at = Date.now()): ModelPicks {
	if (!provider || !id) return getModelPicks();
	const picks: ModelPicks = { ...getModelPicks() };
	const key = `${provider}/${id}`;
	const cur = picks[key];
	picks[key] = { count: (cur?.count ?? 0) + 1, at };
	const keys = Object.keys(picks);
	if (keys.length > MAX_PICKS) for (const k of keys.sort((a, b) => picks[a].at - picks[b].at).slice(0, keys.length - MAX_PICKS)) delete picks[k];
	setSetting(KEY, picks);
	return picks;
}

/**
 * 常用排序策略（明确、可解释）：**总选择次数多的在前；次数相同看最近一次选择**。
 * 没有按时间衰减，所以长期常用的模型会稳定置顶；超过 MAX_PICKS 的冷门模型会被淘汰出记录。
 */
export function rankModelPicks(picks: ModelPicks, limit = 5): string[] {
	return Object.entries(picks)
		.sort((a, b) => b[1].count - a[1].count || b[1].at - a[1].at)
		.slice(0, limit)
		.map(([k]) => k);
}
