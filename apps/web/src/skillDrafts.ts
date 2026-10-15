/**
 * 本次选用技能的 draft 存储：按「助理 + 对话」分桶（复用引用草稿的键规则），切换对话不串。
 * 只存 canonical skill id（`来源/名称`）；发送时由服务端按分配表重新校验，客户端不存路径 / 正文。
 */
import { create } from "zustand";

interface SkillDraftsState {
	drafts: Record<string, string[]>;
	set: (key: string, ids: string[]) => void;
	clear: (key: string) => void;
}

export const useSkillDrafts = create<SkillDraftsState>((set) => ({
	drafts: {},
	set: (key, ids) => set((s) => ({ drafts: { ...s.drafts, [key]: ids } })),
	clear: (key) => set((s) => ({ drafts: { ...s.drafts, [key]: [] } })),
}));

export const getSkillDraft = (key: string) => useSkillDrafts.getState().drafts[key] ?? EMPTY_SKILLS;

/** 稳定的空数组：给 hook selector 用，避免每次返回新数组导致 useSyncExternalStore 无限重渲染。 */
export const EMPTY_SKILLS: string[] = [];
export const setSkillDraft = (key: string, ids: string[]) => useSkillDrafts.getState().set(key, ids);
export const clearSkillDraft = (key: string) => useSkillDrafts.getState().clear(key);

/** canonical id（`来源/名称`）→ 展示用技能名。 */
export const skillNameOf = (id: string) => id.slice(id.indexOf("/") + 1);
