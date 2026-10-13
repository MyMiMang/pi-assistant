/** 建群 / 加成员时按角色给群专属助理挑模型（只从用户已配置的模型里挑）。打分逻辑见 model-profile.ts */
import { getSetting } from "../db.ts";
import { modelDb } from "../model-db.ts";
import { buildProfile, inferNeeds, type ModelProfile, pickModel, type Ranked, type RoleNeeds, scoreModels, STRENGTHS, type Strength } from "../model-profile.ts";
import { defaultModel, models } from "../models.ts";
import { knownVision, normId } from "../pi-adapter/model-limits.ts";
import { resolvePrice } from "../usage/index.ts";

export const getStrengthOverrides = () => getSetting<Record<string, Strength[]>>("modelStrengths", {});

export function configuredModels() {
	if (!models) return [];
	const ok = new Set(models.listProviders().filter((p) => p.configured).map((p) => p.id));
	return models.listModels().filter((m) => ok.has(m.provider));
}

export function modelProfiles(): ModelProfile[] {
	const db = modelDb();
	const overrides = getStrengthOverrides();
	return configuredModels().map((m) => {
		const mm = m as unknown as { provider: string; id: string; name?: string; input?: string[]; reasoning?: boolean; contextWindow?: number };
		// mock（本地测试）不按名字去 models.dev 找，避免撞上别家同名模型
		const hit = mm.provider === "mock" ? undefined : db.find((x) => x.provider === mm.provider && x.id === mm.id) ?? db.find((x) => normId(x.id) === normId(mm.id));
		const p = resolvePrice(mm.provider, mm.id).price;
		return buildProfile(
			{
				provider: mm.provider,
				id: mm.id,
				name: mm.name,
				vision: !!mm.input?.includes("image") || (mm.provider !== "mock" && knownVision(mm.id, db) === true),
				reasoning: !!mm.reasoning || !!hit?.reasoning,
				toolCall: hit ? !!hit.toolCall : undefined,
				contextWindow: mm.contextWindow || hit?.contextWindow,
				price: p ? { input: p.input, output: p.output } : undefined,
			},
			overrides,
		);
	});
}

export const cleanNeeds = (v: unknown): Strength[] => (Array.isArray(v) ? v.map(String).filter((s): s is Strength => (STRENGTHS as readonly string[]).includes(s)) : []);
/** 角色需求：管理者给的 needs + 从角色 / 人设里认出来的关键词 */
export function roleNeeds(m: { needs?: unknown; role?: string; persona?: string }, manager = false): RoleNeeds {
	const needs = new Set([...cleanNeeds(m.needs), ...inferNeeds(`${m.role ?? ""}\n${(m.persona ?? "").slice(0, 400)}`)]);
	return { needs: [...needs], manager };
}

export function rankModels(role: RoleNeeds, profiles = modelProfiles()): Ranked[] {
	return scoreModels(role, profiles, defaultModel());
}
export function pickFor(role: RoleNeeds, profiles = modelProfiles()) {
	return pickModel(role, profiles, defaultModel());
}
