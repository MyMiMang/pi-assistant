/**
 * 撤回还没送达的消息（docs/design/recall-pending-message.md）的前端适配层。
 * 单聊：助理忙时发的插话还显示「等当前这一步做完送达」（meta.delivery=queued）；
 * 群里：消息上带 meta.recallable（没有成员读到，服务端维护）。已送达的不出现撤回；真点了被拒（刚好被读到）服务端回 409。
 */
import { ApiError, api } from "./api";
import { getComposerDraft, setComposerDraft } from "./composerDrafts";
import type { Message } from "./types";

export function canRecall(m: Pick<Message, "role" | "meta" | "room_id">): boolean {
	if (m.role !== "user" || m.meta.delivery === "delivered") return false;
	return m.meta.delivery === "queued" || (!!m.room_id && !!m.meta.recallable);
}

export function recallMessage(messageId: string): Promise<{ ok: true; text: string }> {
	return api(`/api/messages/${encodeURIComponent(messageId)}/recall`, { method: "POST" });
}

export function recallErrorMessage(e: unknown): string {
	return e instanceof ApiError && e.message ? e.message : "撤回失败，稍后再试";
}

/** 重新编辑：把原文放回输入框（输入框里已有字就接在后面，不覆盖） */
export const reeditDraft = (current: string, text: string) => (current.trim() ? `${current}\n${text}` : text);

/** 底部一条几秒后消失的小提示（撤回被拒时用；单聊和群聊共用，不占聊天组件的状态） */
function flashNotice(text: string) {
	if (typeof document === "undefined") return;
	const el = document.createElement("div");
	el.setAttribute("role", "status");
	el.dataset.testid = "recall-notice";
	el.textContent = text;
	el.style.cssText = "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483000;max-width:min(92vw,420px);padding:8px 14px;border-radius:12px;font-size:13px;background:var(--card,#1f1f22);color:var(--fg,#eee);border:1px solid var(--line,#3a3a40);box-shadow:0 10px 30px rgba(0,0,0,.28)";
	document.body.appendChild(el);
	window.setTimeout(() => el.remove(), 3500);
}

/** 撤回 / 重新编辑两个动作（draftKey = 这个输入框的草稿桶）；成功后服务端广播，这条自己变成灰字提示 */
export function recallActions(draftKey: string) {
	return {
		onRecall: async (m: Message) => {
			if (!canRecall(m)) return;
			try {
				await recallMessage(m.id);
			} catch (e) {
				flashNotice(recallErrorMessage(e));
			}
		},
		onReedit: (text: string) => setComposerDraft(draftKey, reeditDraft(getComposerDraft(draftKey), text)),
	};
}
