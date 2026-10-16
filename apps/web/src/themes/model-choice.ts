/**
 * 主题设计面板的「使用模型」纯逻辑（不依赖 React / DOM，便于单测）。
 *
 * 只作用于这一次主题草稿：面板顶部显示**实际会用**的模型（服务短名 + 模型友好名），
 * 打开默认跟随当前助理（助理没显式选就是默认模型，明确标「默认模型 · xxx」）；
 * 直接复用现有模型菜单（`./ModelPicker` 的 `ModelPickerButton`）与 canonical key 规则，
 * **不新建 picker、不下拉原生 select、不改助理主模型 / 模型池 / 全局默认**。
 *
 * 参考图：带图时菜单只给**支持视觉**的聊天模型；当前模型不支持看图则不许生成，
 * 但**保留已选图片**（不自动丢），提示换模型或去掉图片。
 */
import { pickKey, type MenuModel } from "../modelMenu";

export interface ThemeModelRef {
	provider: string;
	id: string;
}

/** `/api/models` 里一条已配置聊天模型（provider + id canonical；input 含 image 才算能看图）。 */
export interface ThemeModelEntry extends MenuModel {
	name: string;
	providerName?: string;
	input?: string[];
}

export interface ThemeModelOption extends ThemeModelEntry {
	providerName: string;
	/** 是否支持视觉（以 Pi 公开模型元数据 input 为准）。 */
	vision: boolean;
}

/** 默认模型的来路。 */
export type ThemeModelSource = "agent" | "default" | "none";

export interface ThemeModelChoice {
	/** 全部已配置聊天模型（统一转成展示选项）。 */
	options: ThemeModelOption[];
	/** 按「是否带参考图」过滤后的菜单列表：带图只给支持视觉的。 */
	menuOptions: ThemeModelOption[];
	/** 打开面板时默认跟随的模型。 */
	initial: ThemeModelRef | null;
	/** initial 的来源：助理显式选择 / 默认模型 / 没有可用模型。 */
	source: ThemeModelSource;
}

/** 以 Pi 公开模型元数据判断能不能看图（自定义服务由后端按 models.dev 补 input）。 */
export const isVisionModel = (m: { input?: string[] } | null | undefined): boolean => !!m?.input?.includes("image");

export function toThemeOption(m: ThemeModelEntry, providers: { id: string; name: string }[]): ThemeModelOption {
	return {
		provider: m.provider,
		id: m.id,
		name: m.name || m.id,
		providerName: m.providerName ?? providers.find((p) => p.id === m.provider)?.name ?? m.provider,
		input: m.input,
		vision: isVisionModel(m),
	};
}

/** 按钮 / 列表里的模型文案：服务短名 · 模型友好名（跟菜单里同一份数据，不按 id 猜服务）。 */
export function themeModelLabel(m: { providerName?: string; provider: string; name?: string; id: string }): string {
	return `${m.providerName ?? m.provider} · ${m.name ?? m.id}`;
}

/**
 * 打开面板时的默认跟随：助理有解析到的模型就用它；
 * 助理没显式选过（`agentExplicit=false`）时来源记 `default`，UI 明确显示「默认模型 · xxx」。
 */
export function buildThemeModelChoice(args: {
	models: ThemeModelEntry[];
	providers: { id: string; name: string }[];
	agentModel: ThemeModelRef | null;
	agentExplicit: boolean;
	hasImages: boolean;
}): ThemeModelChoice {
	const options = args.models.map((m) => toThemeOption(m, args.providers));
	const initial: ThemeModelRef | null = args.agentModel ? { provider: args.agentModel.provider, id: args.agentModel.id } : null;
	const source: ThemeModelSource = !initial ? "none" : args.agentExplicit ? "agent" : "default";
	const menuOptions = args.hasImages ? options.filter((o) => o.vision) : options;
	return { options, menuOptions, initial, source };
}

/** 某个 ref 的视觉能力：true/false；不在已配置列表里返回 null（无法确认，带图时按不支持处理）。 */
export function refVisionStatus(ref: ThemeModelRef | null, options: ThemeModelOption[]): boolean | null {
	if (!ref) return null;
	const o = options.find((x) => pickKey(x) === pickKey(ref));
	return o ? o.vision : null;
}

/** 模型按钮上的文字；跟当前菜单数据保持一致（没匹配到就用 provider/id，绝不用别的模型的友好名）。 */
export function themeModelButtonText(ref: ThemeModelRef | null, options: ThemeModelOption[], opts: { defaultPrefix?: boolean } = {}): string {
	if (!ref) return "未选择模型";
	const o = options.find((x) => pickKey(x) === pickKey(ref));
	const base = o ? themeModelLabel(o) : `${ref.provider} · ${ref.id}`;
	return opts.defaultPrefix ? `默认模型 · ${base}` : base;
}
