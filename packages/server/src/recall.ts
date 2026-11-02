/** 撤回一条还没送达的用户消息（单聊插话 / 群消息）。设计：docs/design/recall-pending-message.md */
import { runtimes } from "./agent-runtime/agent-runtime.ts";
import { getMessage, markRecalled } from "./messages.ts";
import { recallRoomMessage } from "./rooms/recall.ts";

export type RecallResult = { ok: true; text: string } | { ok: false; status: 404 | 409; error: string };

export function recallUserMessage(messageId: string): RecallResult {
	const m = getMessage(messageId);
	if (!m) return { ok: false, status: 404, error: "消息不存在" };
	if (m.role === "system" && m.meta.recalled) return { ok: true, text: String(m.meta.recalledText ?? "") }; // 幂等
	if (m.role !== "user") return { ok: false, status: 409, error: "只能撤回自己发的消息" };
	const refuse = { ok: false, status: 409, error: "助理已经读到这条了，不能撤回" } as const;
	if (m.room_id) {
		if (!recallRoomMessage(m.room_id, messageId)) return refuse;
	} else if (!m.conversation_id || !runtimes.get(m.conversation_id)?.recallSteering(messageId)) return refuse;
	markRecalled(messageId);
	return { ok: true, text: m.content };
}
