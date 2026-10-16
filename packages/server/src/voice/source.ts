/**
 * 语音识别「显式来源」（voiceSource）：读写 + 严格解析 + 归一化视图（**纯逻辑，不 import 服务实现**）。
 *
 * 设计（用户已确认）：
 *  - 单一全局用户偏好，存 `settings.voiceSource = { location, provider, model } | null`；旧库没有该 key = 未配置；
 *  - 不凭 `client` 当前值自动挑源；未配置就是未配置（`null`），绝不静默回落到第一个云端（不静默计费）；
 *  - 只做加法：不删 / 不改写旧的 `asrProviders` 声明与本地安装数据；
 *  - 存储值被删 / 失效时，**不改写存的值**，而是在视图里标 `deleted` + 原因，让用户重新选。
 */
import { getSetting, setSetting } from "../db.ts";
import type { AsrSource, AsrSourceOption, AsrSourceView } from "./contract.ts";

/** 存储 key（settings 表 key-value，非新表）。 */
export const VOICE_SOURCE_KEY = "voiceSource";

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 宽松解析已存值 / 任意输入：形状不对一律当 `null`（未配置），不抛错、不猜。 */
export function normalizeAsrSource(v: unknown): AsrSource | null {
	if (!isPlainObject(v)) return null;
	const { location, provider, model } = v;
	if (location !== "cloud" && location !== "local") return null;
	if (typeof provider !== "string" || !provider.trim() || typeof model !== "string" || !model.trim()) return null;
	return { location, provider: provider.trim(), model: model.trim() };
}

/** 当前显式来源；`null` = 未配置。只读、无副作用。 */
export const readVoiceSource = (): AsrSource | null => normalizeAsrSource(getSetting<unknown>(VOICE_SOURCE_KEY, null));

/** 写入显式来源；`null` = 清空（未配置）。调用方负责校验 provider / model 是否已知可选。 */
export function writeVoiceSource(next: AsrSource | null): void {
	setSetting(VOICE_SOURCE_KEY, next ? { location: next.location, provider: next.provider, model: next.model } : null);
}

/** PUT body 的固定形状：只认 `{ source: null | { location, provider, model } }`。 */
const SOURCE_KEYS = ["location", "provider", "model"] as const;

/** 严格解析 PUT body：未知属性、缺字段、类型不对都拒绝（返回中文原因，路由层落 400 且不写库）。 */
export function parseAsrSourceBody(body: unknown): { ok: true; source: AsrSource | null } | { ok: false; reason: string } {
	if (!isPlainObject(body)) return { ok: false, reason: "请求体必须是 JSON 对象 { source: ... }" };
	const extra = Object.keys(body).filter((k) => k !== "source");
	if (extra.length) return { ok: false, reason: `不认识的字段：${extra.join("、")}` };
	if (!("source" in body)) return { ok: false, reason: "缺少 source 字段（清空请传 source: null）" };
	if (body.source === null) return { ok: true, source: null };
	if (!isPlainObject(body.source)) return { ok: false, reason: "source 必须是 null 或对象" };
	const extraSource = Object.keys(body.source).filter((k) => !(SOURCE_KEYS as readonly string[]).includes(k));
	if (extraSource.length) return { ok: false, reason: `source 里有不认识的字段：${extraSource.join("、")}` };
	const source = normalizeAsrSource(body.source);
	if (!source) return { ok: false, reason: "source 需要 location（cloud|local）、provider、model（非空字符串）" };
	return { ok: true, source };
}

/** 两个来源是否完全相同（location + provider + model）。 */
export const sameAsrSource = (a: AsrSource | null, b: AsrSource | null): boolean => !!a && !!b && a.location === b.location && a.provider === b.provider && a.model === b.model;

/**
 * 把候选列表与当前 source 对齐（`selected` 只在这里算，避免各处漂移）：
 * 存的值已不在候选里（provider 被删 / 声明被移除）时，补一条 `deleted` 的显式条目 + 原因，
 * 让 UI 明确知道「选的那个没了」，而不是显示成空选或悄悄改存的值。
 */
export function withSelected(source: AsrSource | null, options: AsrSourceOption[]): AsrSourceView {
	const marked = options.map((o) => ({ ...o, selected: sameAsrSource(source, { location: o.location, provider: o.provider, model: o.model }) }));
	if (source && !marked.some((o) => o.selected)) {
		marked.push({
			location: source.location,
			provider: source.provider,
			model: source.model,
			name: `${source.provider} / ${source.model}`,
			protocol: "",
			availability: "deleted",
			reason: "当前选择的语音模型已删除或不再可用，请重新选择",
			selected: true,
		});
	}
	return { source, options: marked };
}
