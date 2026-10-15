/**
 * 输入框文字草稿：按「助理 + 对话」分桶，切对话保留各自草稿、不回串、不丢失。
 *
 * 独立小 store（不改 store.ts / 不重构 composer 结构）：原来文字是 Composer 的局部 useState，
 * 切对话时同一实例继续渲染，会把上一个对话没发出的文字带到新对话。「从消息另开新对话」也会切对话
 * （并把被分支的正文放回新对话输入框），所以改成按对话分桶保存。键复用 replies.ts 的 replyDraftKey。
 */
import { create } from "zustand";

interface ComposerDraftsState {
	drafts: Record<string, string>;
	set: (key: string, text: string) => void;
}

export const useComposerDrafts = create<ComposerDraftsState>((set) => ({
	drafts: {},
	set: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: text } })),
}));

/** 非组件处使用。 */
export const getComposerDraft = (key: string) => useComposerDrafts.getState().drafts[key] ?? "";
export const setComposerDraft = (key: string, text: string) => useComposerDrafts.getState().set(key, text);
export const clearComposerDraft = (key: string) => useComposerDrafts.getState().set(key, "");
