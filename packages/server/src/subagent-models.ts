/** 帮手（子代理）的模型候选池、思考强度与 Fast 设置：从 subagents.ts 拆出（纯设置读写，不碰运行中的帮手）。 */
import { db, getSetting, setSetting } from "./db.ts";
import { configuredModels } from "./rooms/model-pick.ts";
import { isRecoverableModelError } from "./model-errors.ts";
import { isThinkingLevel, models } from "./models.ts";
import type { AgentSubagentChoice, AgentSubagentPool, ModelRef, SubagentThinking } from "./subagents.ts";

export const modelKey = (m: ModelRef) => `${m.provider}/${m.id}`;
/**
 * 池内 fallback 决策（纯函数，便于单测）：只有明确可恢复的模型故障才换，且只换还没试过的候选。
 * 工具 / 命令失败、权限拒绝、未知错误都不是模型故障 → 返回 null（不换模型）。用尽候选也返回 null。
 */
export function planFallback(candidates: ModelRef[], tried: Iterable<string>, error?: string | null): ModelRef | null {
	if (!isRecoverableModelError(error)) return null;
	const t = new Set(tried);
	return candidates.find((m) => !t.has(modelKey(m))) ?? null;
}
export const asRefs = (x: unknown): ModelRef[] =>
	Array.isArray(x)
		? x.flatMap((m) => (m && typeof m === "object" && "provider" in m && "id" in m ? [{ provider: String((m as ModelRef).provider), id: String((m as ModelRef).id) }] : []))
		: [];
/** 把库里的旧格式 / 新格式统一读成候选池：新格式 `{pool}`；旧「固定一个模型」= 单项池；旧「跟随」= 空池。 */
export function normalizeAgentPool(v: unknown): ModelRef[] {
	if (!v || typeof v !== "object") return [];
	const o = v as { pool?: unknown; mode?: string; model?: unknown };
	if (Array.isArray(o.pool)) return asRefs(o.pool);
	if (o.mode === "fixed") return asRefs([o.model]);
	return [];
}
export const agentSubagentPool = (id: string): ModelRef[] => normalizeAgentPool(getSetting<unknown>(`subagentModel:${id}`, null));
export function requireModel(m: ModelRef | undefined) {
	if (!m || !configuredModels().some((x) => x.provider === m.provider && x.id === m.id)) throw new Error("模型尚未配置");
	return { provider: m.provider, id: m.id };
}
/** 只保留当前仍然配置着的模型（服务被删 / 模型下线后，池里的悬空项不参与挑选与 fallback）。 */
export const livePool = (pool: ModelRef[]): ModelRef[] => pool.filter((m) => configuredModels().some((x) => x.provider === m.provider && x.id === m.id)).map((m) => ({ provider: m.provider, id: m.id }));
/** 保存助理的候选池；空池 = 跟随主会话当前模型。 */
export function saveAgentSubagentPool(id: string, input: { pool?: ModelRef[] }): AgentSubagentPool {
	const pool = (input?.pool ?? []).map(requireModel);
	const c: AgentSubagentPool = { pool };
	setSetting(`subagentModel:${id}`, c);
	return c;
}
/** @deprecated 兼容旧客户端：旧的 follow/fixed 形状转成候选池。 */
export function saveAgentSubagentChoice(id: string, choice: AgentSubagentChoice) {
	return saveAgentSubagentPool(id, { pool: choice?.mode === "fixed" && choice.model ? [choice.model] : [] });
}
/** 这个助理的子代理默认思考强度（默认跟随主会话） */
export const agentSubagentThinking = (id: string): SubagentThinking => getSetting<SubagentThinking>(`subagentThinking:${id}`, { mode: "follow" });
export function saveAgentSubagentThinking(id: string, input: SubagentThinking): SubagentThinking {
	if (input?.mode !== "follow" && input?.mode !== "fixed") throw new Error("思考强度方式不对");
	if (input.mode === "fixed" && !isThinkingLevel(input.level)) throw new Error("思考强度不对");
	const c: SubagentThinking = input.mode === "fixed" ? { mode: "fixed", level: input.level } : { mode: "follow" };
	setSetting(`subagentThinking:${id}`, c);
	return c;
}
/**
 * 子代理实际用的思考强度：单个子代理覆盖 > 助理默认（fixed 档位 / 跟随主会话）> 传入的 mainThinking（runtime 的 a.thinking ?? 全局默认），
 * 最后一律按实际使用的模型收敛（clampThinkingLevel），不支持推理的模型不会得到 xhigh/max。
 */
export function resolveSubagentThinking(agentId: string, model: ModelRef, mainThinking: string, override?: string | null): string {
	const setting = agentSubagentThinking(agentId);
	const wanted = override ?? (setting.mode === "fixed" ? setting.level : mainThinking);
	return models.clampThinking(model.provider, model.id, wanted);
}
/** 助理级请求级 Fast（agents.fast 0/1）；主会话 / 群成员 / 后台任务 / 定时任务都用它。 */
export function agentFast(agentId: string): boolean {
	const row = db.prepare("SELECT fast FROM agents WHERE id = ?").get(agentId) as { fast?: number | null } | undefined;
	return row?.fast === 1;
}
/**
 * 子代理实际用的 Fast：单个子代理覆盖（1/0）> 所属助理的 fast；默认跟随，不另立「助理级子代理默认」设置页。
 * 与思考强度同构，但**不共用字段**：改 Fast 不会动 thinking，反之亦然。
 */
export function resolveSubagentFast(agentId: string, override?: number | null): boolean {
	if (override === 1 || override === 0) return override === 1;
	return agentFast(agentId);
}
