/**
 * 快速执行者（`computer_quick_steps`）的服务端设置：开 / 关、用哪个决策模型、能不能带截图。
 *
 * 模型目录**复用** Pi 的 classifier 目录（`models.listClassifierModels()`，和 设置 › 模型 页同一个来源），
 * 只列已配好凭据的；这里不另写一份列模型的逻辑。设计见 docs/design/fast-executor-impl.md §6。
 */
import { getSetting, setSetting } from "./db.ts";
import { models } from "./models.ts";
import type { QuickStepsConfig } from "@pi-assistant/ext-computer";

export interface FastExecutorSettings {
	enabled: boolean;
	/** 用户指定的决策模型；都为 null = 自动挑 */
	provider: string | null;
	id: string | null;
	/** 允许把截图一起发给决策模型 */
	images: boolean;
}
/** 一个可选的决策模型（只含安全元数据，不含凭据） */
export interface ClassifierChoice {
	provider: string;
	id: string;
	name: string;
	image: boolean;
}

const KEY = "fastExecutor";
const DEFAULTS: FastExecutorSettings = { enabled: true, provider: null, id: null, images: true };
const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** 设置（缺字段按默认值补齐，旧数据 / 手改过的值也不会让界面炸） */
export function fastExecutorSettings(): FastExecutorSettings {
	const s = getSetting<Partial<FastExecutorSettings>>(KEY, {});
	return { enabled: s.enabled !== false, provider: nonEmpty(s.provider), id: nonEmpty(s.id), images: s.images !== false };
}

/** 已配置凭据的分类模型（和 设置 › 模型 的 classifier 目录同源） */
export function availableClassifiers(): ClassifierChoice[] {
	return models
		.listClassifierModels()
		.filter((m) => m.configured)
		.map((m) => ({ provider: m.provider, id: m.id, name: m.name || m.id, image: (m.input ?? []).includes("image") }));
}

/**
 * 这次执行用哪个决策模型：关掉 → null；设了且在可用列表里 → 用它；否则自动挑第一个 Jev，没有就第一个；
 * 一个可用的都没有 → null（不提供这个工具）。
 */
export function fastExecutorFor(): QuickStepsConfig | null {
	const s = fastExecutorSettings();
	if (!s.enabled) return null;
	const list = availableClassifiers();
	if (!list.length) return null;
	const chosen = s.provider && s.id ? list.find((m) => m.provider === s.provider && m.id === s.id) : undefined;
	const pick = chosen ?? list.find((m) => m.id.toLowerCase().includes("jev")) ?? list[0]!;
	return { provider: pick.provider, id: pick.id, images: s.images };
}

/** 保存设置（校验类型；选了一个现在不可用的模型就报错，不静默改成自动） */
export function saveFastExecutorSettings(p: Partial<FastExecutorSettings>): FastExecutorSettings {
	const cur = fastExecutorSettings();
	const provider = p.provider === undefined ? cur.provider : nonEmpty(p.provider);
	const id = p.id === undefined ? cur.id : nonEmpty(p.id);
	if (!!provider !== !!id) throw new Error("决策模型要同时给出 provider 和 id（都留空 = 自动）");
	if (provider && id && !availableClassifiers().some((m) => m.provider === provider && m.id === id)) throw new Error("这个决策模型现在不可用（没配凭据或已删除）");
	const next: FastExecutorSettings = { enabled: typeof p.enabled === "boolean" ? p.enabled : cur.enabled, provider, id, images: typeof p.images === "boolean" ? p.images : cur.images };
	setSetting(KEY, next);
	return next;
}
