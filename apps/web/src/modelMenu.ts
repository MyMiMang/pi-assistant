/**
 * 模型选择菜单的分组规则（纯函数，单独成模块便于单测；不依赖 React / DOM）。
 *
 * 关键约定 —— 「常用」是快捷入口，不是把目录搬家：
 * - 「常用」只是把用户常选的模型在菜单顶部**再列一份**；它**不会**把条目从原渠道分组里移走。
 *   所以一个模型可以同时在「常用」和自己的原渠道各出现 1 行（快捷入口 + 目录）。
 * - 去重只做在**同一个分组内**：同一个 provider 里 canonical key（provider + 模型 id）相同的
 *   条目只留 1 行；**跨分组不合并** —— 两个渠道都有同名模型 id 就是两个独立条目。
 * - 搜索时不显示「常用」（避免同一屏里搜索命中和常用重复），只按分组过滤。
 * - id 只作为 key 的一半：`gpt-6.1-sol` 这种同 id 不同渠道的模型互不影响，也不会只按 id 命中。
 */
export interface MenuModel {
	provider: string;
	id: string;
}
export interface MenuPick {
	count: number;
	at: number;
}
export type MenuPicks = Record<string, MenuPick>;

/** canonical key：provider + 模型 id（不能只按 id，同名模型跨渠道是两条） */
export const pickKey = (m: MenuModel) => `${m.provider}/${m.id}`;

/** 常用排序：选择次数多的在前，次数相同看最近一次选择（服务端记录，见 server/src/model-picks.ts） */
export function rankPicks(picks: MenuPicks, limit = 5): string[] {
	return Object.entries(picks)
		.sort((a, b) => b[1].count - a[1].count || b[1].at - a[1].at)
		.slice(0, limit)
		.map(([k]) => k);
}

/** 搜索过滤：模型名 / id / 服务 id / 服务名都能命中；空搜索返回全部（保持传入顺序） */
export function searchModels<M extends MenuModel>(models: M[], query: string, nameOf: (provider: string) => string): M[] {
	const k = query.trim().toLowerCase();
	if (!k) return models;
	return models.filter((m) => `${(m as { name?: string }).name ?? ""} ${m.id} ${m.provider} ${nameOf(m.provider)}`.toLowerCase().includes(k));
}

/**
 * 「常用」区：只在没搜索时出现，最多 limit 个，按 canonical key 从模型列表里取回原条目
 * （拿回的是列表里那一条，所以已选状态 / 思考档位 / 可用性都跟原渠道同一份数据）。
 * 注意：调用方**不要**把这些 key 从分组里再过滤掉。
 */
export function frequentModels<M extends MenuModel>(models: M[], picks: MenuPicks | undefined, query: string, limit = 5): M[] {
	if (query.trim()) return [];
	return rankPicks(picks ?? {}, limit)
		.map((key) => models.find((m) => pickKey(m) === key))
		.filter((m): m is M => !!m);
}

/** 分组内按 canonical key 去重：同一渠道里同一个模型只留 1 行（跨渠道/跨分组不动） */
export function dedupeGroup<M extends MenuModel>(models: M[]): M[] {
	const seen = new Set<string>();
	return models.filter((m) => {
		const k = pickKey(m);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

export interface ModelGroup<M extends MenuModel> {
	provider: string;
	name: string;
	models: M[];
}

/**
 * 按服务（provider）分组：组内先按 canonical key 去重。
 * first = 当前选中模型所在的服务，排到最前面（其余按服务名排）。
 */
export function groupModelsByProvider<M extends MenuModel>(models: M[], nameOf: (provider: string) => string, first?: string): ModelGroup<M>[] {
	const by = new Map<string, M[]>();
	for (const m of models) by.set(m.provider, [...(by.get(m.provider) ?? []), m]);
	return [...by.entries()]
		.sort((a, b) => Number(b[0] === first) - Number(a[0] === first) || nameOf(a[0]).localeCompare(nameOf(b[0]), "zh"))
		.map(([provider, ms]) => ({ provider, name: nameOf(provider), models: dedupeGroup(ms) }));
}


/**
 * 输入栏模型弹层的两层状态（纯函数，便于单测；不依赖 React / DOM）。
 *
 * - 默认打开紧凑层：只放当前强度 / 模型名 / Fast 闪电 / 滑块，不铺搜索框和完整目录；
 * - 点模型名 → 完整目录（搜索 / 服务分组 / 常用照旧）；
 * - 返回 / 选完模型 → 回到紧凑层，且**不改**模型 / 思考 / Fast（选模型由调用方 onPick 负责）；
 * - Esc 在目录里只退一层（回紧凑层），在紧凑层才关闭整个弹层；关闭后状态复位。
 * - 不做 compact 的入口（例如默认模型设置页）保持原来的「直接打开完整目录」。
 */
export type PickerLayer = "compact" | "list";
export type PickerPanelEvent = "open" | "openList" | "back" | "pick" | "close" | "escape";
export interface PickerPanelState {
	open: boolean;
	layer: PickerLayer;
	/** 返回 / 选完模型后把焦点放回模型名（键盘不丢位置） */
	focusModel: boolean;
}

export function pickerPanelNext(state: PickerPanelState, event: PickerPanelEvent, compact: boolean): PickerPanelState {
	switch (event) {
		case "open":
			return { open: true, layer: compact ? "compact" : "list", focusModel: false };
		case "openList":
			return { ...state, open: true, layer: "list", focusModel: false };
		case "back":
			return { open: true, layer: compact ? "compact" : "list", focusModel: compact };
		case "pick":
			return compact ? { open: true, layer: "compact", focusModel: true } : { open: false, layer: "list", focusModel: false };
		case "close":
			return { open: false, layer: "compact", focusModel: false };
		case "escape":
			if (compact && state.layer === "list") return { open: true, layer: "compact", focusModel: true };
			return { open: false, layer: "compact", focusModel: false };
	}
}
