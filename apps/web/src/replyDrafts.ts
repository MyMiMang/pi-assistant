/**
 * 引用 draft 存储：按「助理 + 对话 / 群 / 子代理」分桶，切换目标不串引用。
 *
 * 独立小 store（不改 store.ts / 不重构 composer），键见 replies.ts 的 replyDraftKey。
 * 只存展示用的 ReplyRef，不存 HTML / 附件本体；发送成功由调用方 clear。
 */
import { create } from "zustand";
import type { ReplyRef } from "./replies";

interface ReplyDraftsState {
	drafts: Record<string, ReplyRef | null>;
	set: (key: string, ref: ReplyRef | null) => void;
	clear: (key: string) => void;
}

export const useReplyDrafts = create<ReplyDraftsState>((set) => ({
	drafts: {},
	set: (key, ref) => set((s) => ({ drafts: { ...s.drafts, [key]: ref } })),
	clear: (key) => set((s) => ({ drafts: { ...s.drafts, [key]: null } })),
}));

/** 取某个键当前的引用（组件里用 hook 订阅，非组件处用 get）。 */
export const getReplyDraft = (key: string) => useReplyDrafts.getState().drafts[key] ?? null;
export const setReplyDraft = (key: string, ref: ReplyRef | null) => useReplyDrafts.getState().set(key, ref);
export const clearReplyDraft = (key: string) => useReplyDrafts.getState().clear(key);
