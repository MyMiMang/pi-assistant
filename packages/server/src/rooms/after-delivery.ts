/**
 * 群项目交付之后（决策 0022 第 2、3 步，docs/design/context-growth.md）：
 *  - 记忆：用户本人在这个项目期间的原话 + 交付摘要，用可信来源写进管理者的长期记忆一次（群聊每轮写入按安全分层只是草稿）。
 *  - 整理：群空闲、没有别的进行中 / 待确认项目时，把成员的群会话用 Pi 自带的整理上下文各整理一次（原始记录留在会话文件里）。
 *    整理期间群里的下一轮先等它做完（scheduler 调 tidyingOf），不和整理同时跑。
 */
import { db } from "../db.ts";
import { memory } from "../memory/index.ts";
import { runtime } from "../runtime.ts";
import { deliveryMemory, TIDY_MIN_TOKENS, tidyInstructions } from "./logic.ts";
import { projectsOf } from "./projects.ts";
import { getRoom, memberConversation, membersOf } from "./store.ts";

const pending = new Set<string>();
const tidying = new Map<string, Promise<void>>();

/** 交付成功后调：写记忆（不阻塞交付），并记下这个群待整理 */
export function afterDelivery(roomId: string, p: { id: string; title: string }, managerId: string, card: { summary: string; files: string[]; notDone: string }) {
	pending.add(roomId);
	const since = (db.prepare("SELECT MAX(ended_at) AS t FROM room_projects WHERE room_id = ? AND status = 'done' AND id != ?").get(roomId, p.id) as { t: number | null }).t ?? 0;
	const said = (db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'user' AND created_at > ? ORDER BY rowid").all(roomId, since) as { content: string }[]).map((r) => r.content);
	const m = deliveryMemory({ room: getRoom(roomId)?.name ?? "群聊", title: p.title, said, ...card });
	if (m) void memory.retainTurn(managerId, memberConversation(roomId, managerId), { ...m, actor: "user" }).catch((e) => console.warn(`[room] 交付记忆写入失败：${e instanceof Error ? e.message : e}`));
}

/** 会话上一次调用读入了多少 token（取最近一条带用量的助理消息） */
function lastContextTokens(conversationId: string) {
	const u = (db.prepare("SELECT json_extract(meta, '$.usage') AS u FROM messages WHERE conversation_id = ? AND role = 'assistant' AND json_extract(meta, '$.usage') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(conversationId) as { u: string | null } | undefined)?.u;
	if (!u) return 0;
	const x = JSON.parse(u) as { input?: number; cacheRead?: number; cacheWrite?: number };
	return (x.input ?? 0) + (x.cacheRead ?? 0) + (x.cacheWrite ?? 0);
}

/** 管理者回合结束后调：有待整理的交付、群里没有排队的回合、没有别的进行中 / 待确认项目 → 开始整理 */
export function maybeTidy(roomId: string, o: { idle: boolean; openProjects: number }) {
	if (!pending.has(roomId) || !o.idle || o.openProjects > 0 || tidying.has(roomId)) return;
	pending.delete(roomId);
	// 等这一轮的会话彻底空下来再整理
	const job = new Promise<void>((r) => setTimeout(r, 0)).then(() => tidyRoom(roomId)).finally(() => tidying.delete(roomId));
	tidying.set(roomId, job);
}

async function tidyRoom(roomId: string) {
	const said = (db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 40").all(roomId) as { content: string }[]).map((r) => r.content).reverse();
	const instructions = tidyInstructions(projectsOf(roomId, true).map((p) => ({ title: p.title, status: p.status })).reverse(), said);
	for (const m of membersOf(roomId)) {
		if (!m.conversation_id || lastContextTokens(m.conversation_id) < TIDY_MIN_TOKENS()) continue;
		const rt = runtime(m.agent_id, m.conversation_id);
		if (rt.busy) continue;
		await rt.compact(instructions).catch((e) => console.warn(`[room] 交付后整理 ${m.agent_id} 的群会话失败：${e instanceof Error ? e.message : e}`));
	}
}

/** 正在整理时返回整理的 Promise（群里的下一轮先等它）；没在整理返回 undefined，调用方不 await、不改变回合时序 */
export const tidyingOf = (roomId: string) => tidying.get(roomId);
