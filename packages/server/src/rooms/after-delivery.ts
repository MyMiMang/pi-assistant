/**
 * 群项目交付之后（决策 0022 第 2、3 步，docs/design/context-growth.md）：
 *  - 记忆：用户本人在这个项目期间的原话 + 交付摘要，用可信来源写进管理者的长期记忆一次（群聊每轮写入按安全分层只是草稿）。
 *  - 整理：群空闲、没有别的进行中 / 待确认项目时，把成员的群会话用 Pi 自带的整理上下文各整理一次（原始记录留在会话文件里）。
 *    整理期间群里的下一轮先等它做完（scheduler 调 tidyingOf），不和整理同时跑。
 */
import { db } from "../db.ts";
import { lastContextTokens } from "../messages.ts";
import { memory } from "../memory/index.ts";
import { runtime } from "../runtime.ts";
import { deliveryMemory, TIDY_MIN_TOKENS, tidyInstructions } from "./logic.ts";
import { projectsOf } from "./projects.ts";
import { setTidying } from "./queue.ts";
import { getRoom, memberConversation, membersOf } from "./store.ts";

const pending = new Set<string>();
const tidying = new Map<string, Promise<void>>();
/** 按大小整理中的单个成员群会话（key = 群 id + 成员 id） */
const memberTidying = new Map<string, Promise<void>>();
/** 失败后，读入量比该次尝试增加 2 万 token 才再次尝试；两个整理入口共用。 */
const failedTokens = new Map<string, number>();
const TIDY_RETRY_GROWTH = 20_000;

function canTidy(key: string, tokens: number) {
	const failed = failedTokens.get(key);
	return tokens >= TIDY_MIN_TOKENS() && (failed === undefined || tokens >= failed + TIDY_RETRY_GROWTH);
}

/** 交付成功后调：写记忆（不阻塞交付），并记下这个群待整理 */
export function afterDelivery(roomId: string, p: { id: string; title: string }, managerId: string, card: { summary: string; files: string[]; notDone: string }) {
	pending.add(roomId);
	const since = (db.prepare("SELECT MAX(ended_at) AS t FROM room_projects WHERE room_id = ? AND status = 'done' AND id != ?").get(roomId, p.id) as { t: number | null }).t ?? 0;
	const said = (db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'user' AND created_at > ? ORDER BY rowid").all(roomId, since) as { content: string }[]).map((r) => r.content);
	const m = deliveryMemory({ room: getRoom(roomId)?.name ?? "群聊", title: p.title, said, ...card });
	if (m) void memory.retainTurn(managerId, memberConversation(roomId, managerId), { ...m, actor: "user" }).catch((e) => console.warn(`[room] 交付记忆写入失败：${e instanceof Error ? e.message : e}`));
}

/** 管理者回合结束后调：有待整理的交付、群里没有排队的回合、没有别的进行中 / 待确认项目 → 开始整理 */
export function maybeTidy(roomId: string, o: { idle: boolean; openProjects: number }) {
	if (!pending.has(roomId) || !o.idle || o.openProjects > 0 || tidying.has(roomId)) return;
	pending.delete(roomId);
	// 等这一轮的会话彻底空下来再整理
	const job = new Promise<void>((r) => setTimeout(r, 0)).then(() => tidyRoom(roomId)).finally(() => tidying.delete(roomId));
	tidying.set(roomId, job);
}

/** 整理说明：每个项目的真实状态 + 用户在群里最近说过的话 */
function instructionsFor(roomId: string, mode: "delivered" | "size") {
	const said = (db.prepare("SELECT content FROM messages WHERE room_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 40").all(roomId) as { content: string }[]).map((r) => r.content).reverse();
	return tidyInstructions(projectsOf(roomId, true).map((p) => ({ title: p.title, status: p.status })).reverse(), said, mode);
}

/**
 * 按大小整理（决策 0026）：成员的一轮群回合结束后调。它的群会话空闲、上一次调用读入的 token 超过 TIDY_MIN_TOKENS，
 * 就只整理这一个成员（进行中的项目也整理，整理说明要求保留进行中的事）。整理期间这位成员的下一轮先等（scheduler 调 tidyingOf）。
 */
export function maybeTidyMember(roomId: string, agentId: string, conversationId: string) {
	const key = `${roomId}:${agentId}`;
	if (memberTidying.has(key) || tidying.has(roomId) || !canTidy(key, lastContextTokens(conversationId))) return;
	const job = new Promise<void>((r) => setTimeout(r, 0))
		.then(async () => {
			const rt = runtime(agentId, conversationId);
			if (rt.busy) return;
			const tokens = lastContextTokens(conversationId);
			if (!canTidy(key, tokens)) return;
			setTidying(roomId, agentId, true);
			try {
				await rt.compact(instructionsFor(roomId, "size"));
				failedTokens.delete(key);
			} catch (e) {
				failedTokens.set(key, tokens);
				console.warn(`[room] 按大小整理 ${agentId} 的群会话失败：${e instanceof Error ? e.message : e}`);
			} finally {
				setTidying(roomId, agentId, false);
			}
		})
		.finally(() => memberTidying.delete(key));
	memberTidying.set(key, job);
}

async function tidyRoom(roomId: string) {
	const instructions = instructionsFor(roomId, "delivered");
	for (const m of membersOf(roomId)) {
		if (!m.conversation_id) continue;
		const key = `${roomId}:${m.agent_id}`;
		const tokens = lastContextTokens(m.conversation_id);
		if (!canTidy(key, tokens)) continue;
		if (memberTidying.has(key)) continue; // 这位已经在按大小整理了
		const rt = runtime(m.agent_id, m.conversation_id);
		if (rt.busy) continue;
		setTidying(roomId, m.agent_id, true);
		try {
			await rt.compact(instructions);
			failedTokens.delete(key);
		} catch (e) {
			failedTokens.set(key, tokens);
			console.warn(`[room] 交付后整理 ${m.agent_id} 的群会话失败：${e instanceof Error ? e.message : e}`);
		} finally {
			setTidying(roomId, m.agent_id, false);
		}
	}
}

/** 正在整理时返回整理的 Promise（全群整理，或传了 agentId 时这位成员的单独整理；群里的下一轮先等它）；没在整理返回 undefined，调用方不 await、不改变回合时序 */
export const tidyingOf = (roomId: string, agentId?: string) => tidying.get(roomId) ?? (agentId ? memberTidying.get(`${roomId}:${agentId}`) : undefined);
