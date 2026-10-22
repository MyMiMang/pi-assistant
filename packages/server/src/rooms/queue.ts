/**
 * 群的发言队列与状态（从 scheduler.ts 拆出）：RoomState、states、入队（带去重认领）、撤回排队、排着的回合查询。
 * 谁来说话、怎么跑一个回合在 scheduler.ts；给模型的回合提示在 turn-prompt.ts。
 */
import { bus } from "../bus.ts";
import { db, now, uid } from "../db.ts";
import type { ReplySnapshot } from "../messages.ts";
import type { PlannedTurn, QuoteTarget, RoundCounters } from "./logic.ts";

/** 已解析的引用：快照（给模型/UI）+ 纯逻辑路由目标 */
export type QuoteInfo = { snapshot: ReplySnapshot; target: QuoteTarget };
export type Turn = PlannedTurn & { turnId: string };

export interface RoomState {
	roundId: string;
	queue: Turn[];
	current: { agentId: string; turnId: string; conversationId: string; reason: string } | null;
	counters: RoundCounters;
	/** 管理者这一轮派活：派出去还没做完的成员 */
	batch: Set<string>;
	batchRan: boolean;
	/** 正在进行的管理者回合里收集到的派活（长期任务的派活不在这里：直接进负责人的任务会话） */
	assignments: { agentId: string; task?: string }[];
	/** 运行中用户又发了消息：当前发言结束后重新安排 */
	replan: { mentions: string[]; quote: QuoteInfo | null; sourceMessageId: string; workCtx: string | null } | null;
	/** 本轮用户消息带来的引用快照（模型上下文），无引用为 null */
	quote: ReplySnapshot | null;
	/** 触发这一轮的用户消息 id（可信持久化来源；幂等键，见 routeUserMessage） */
	sourceMessageId: string | null;
	/** 这条用户消息指到某个长期任务时，给管理者的任务上下文（不指任务时为 null） */
	workCtx: string | null;
	stopped: boolean;
	running: boolean;
}
export const states = new Map<string, RoomState>();
export const fresh = (): RoomState => ({ roundId: uid("rd"), queue: [], current: null, counters: { turns: 0, perAgent: {} }, batch: new Set(), batchRan: false, assignments: [], replan: null, quote: null, sourceMessageId: null, workCtx: null, stopped: false, running: false });

export function stateOf(roomId: string) {
	const s = states.get(roomId);
	if (!s || (!s.current && !s.queue.length)) return { running: false, current: null, queue: [] as string[] };
	return { running: true, current: s.current ? { agentId: s.current.agentId, reason: s.current.reason } : null, queue: s.queue.map((q) => q.agentId) };
}
export const emitState = (roomId: string) => bus.emit({ type: "room.state", roomId, state: stateOf(roomId) });

/**
 * 入队。`sourceMessageId` 记录触发本轮的用户消息（可信持久化 id）。
 * `dedup=true` 时原子认领：同一来源消息的同一「收件人 + 用途」已有未取消回合 → 跳过，
 * 使重复路由事件 / 客户端重试 / 服务重启不重复唤醒；真正分工出的不同收件人 / 用途照常入队（见 docs/design/message-replies.md §7）。
 */
export function enqueue(roomId: string, s: RoomState, turns: PlannedTurn[], sourceMessageId: string | null = null, dedup = false) {
	const insert = (t: PlannedTurn) => {
		const turnId = uid("rt");
		if (dedup && sourceMessageId) {
			const res = db.prepare(
				`INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, task, depth, status, created_at, source_message_id)
				 SELECT ?,?,?,?,?,?,?,?,?,?
				 WHERE NOT EXISTS (SELECT 1 FROM room_turns WHERE room_id = ? AND source_message_id = ? AND agent_id = ? AND reason = ? AND status != 'cancelled')`,
			).run(turnId, roomId, s.roundId, t.agentId, t.reason, t.task ?? null, t.depth, "queued", now(), sourceMessageId, roomId, sourceMessageId, t.agentId, t.reason);
			if (!res.changes) return;
		} else {
			db.prepare("INSERT INTO room_turns(id, room_id, round_id, agent_id, reason, task, depth, status, created_at, source_message_id) VALUES(?,?,?,?,?,?,?,?,?,?)").run(turnId, roomId, s.roundId, t.agentId, t.reason, t.task ?? null, t.depth, "queued", now(), sourceMessageId);
		}
		s.queue.push({ ...t, turnId });
	};
	// 去重批次整体事务化：@所有人 等多收件人组要么全认领、要么全不认领。
	if (dedup && sourceMessageId && turns.length > 1) {
		db.exec("BEGIN");
		try {
			for (const t of turns) insert(t);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	} else {
		for (const t of turns) insert(t);
	}
}
/** 撤回排队中的回合（可只撤某个成员的；keep 里的保留，例如用户插话时不丢掉管理者的看板检查）。 */
export function cancelQueue(s: RoomState, o: { agentId?: string; keep?: (q: Turn) => boolean } = {}) {
	const drop = s.queue.filter((q) => (!o.agentId || q.agentId === o.agentId) && !o.keep?.(q));
	for (const q of drop) db.prepare("UPDATE room_turns SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now(), q.turnId);
	s.queue = s.queue.filter((q) => !drop.includes(q));
}
export function cancelQueuedFor(roomId: string, agentId: string) {
	const s = states.get(roomId);
	if (!s) return;
	cancelQueue(s, { agentId });
	emitState(roomId);
}

/** 群里有没有排着的回合（含正在跑的） */
export const hasQueuedTurns = (roomId: string) => {
	const s = states.get(roomId);
	return !!s && (!!s.current || s.queue.length > 0);
};
/** 群里排着的回合（reason 为 null = 不限原因）。 */
export const queuedFor = (roomId: string, reason: PlannedTurn["reason"] | null, agentId?: string) => !!states.get(roomId)?.queue.some((q) => (!reason || q.reason === reason) && (!agentId || q.agentId === agentId));
