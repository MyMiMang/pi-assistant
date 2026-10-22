/**
 * 群的发言调度（用户决定的“管理者”模式）：
 *  1. 用户 @ 了谁，就只有谁回答（按 @ 的顺序依次说，后说的能看到前面的）；@所有人 = 全部成员
 *  2. 用户没 @ 人：只有管理者回答——它理解需求，自己答或用 room_assign / @名字 派活
 *  3. 普通成员只有被用户或管理者 @ 才会说话；项目进行中成员可以 @ 彼此（collab.ts）
 *  4. 派出去的成员都做完后管理者再总结一次（可关），还可以继续派（有深度上限）
 * 每轮上限：发言次数、派活深度、每人次数；到上限写“本轮已暂停”，用户点继续。
 * 长期任务的执行不在这里：它们在负责人自己的任务会话里跑（work-items/exec.ts），不占群的回合和上限。
 */
import { bus } from "../bus.ts";
import { db, now, uid } from "../db.ts";
import { attachmentInputFor, type FileRow, fileInfo, getFile } from "../files.ts";
import { isStopCommand } from "../interject.ts";
import { getMessage, getMessageByClientId, insertMessage, updateMessage, type Message } from "../messages.ts";
import { buildReplySnapshot, formatQuotedContext, resolveReplyTarget } from "../replies.ts";
import { requests } from "../requests.ts";
import { getAgent, listAgents, runtime } from "../runtime.ts";
import { stopConversationSubagents } from "../subagents.ts";
import { buildWorkCorrectionContext, execConversationsOfRoom, resolveWorkReferences } from "../work-items.ts";
import { capCheck, parseMentions, planAfter, planForUser, planForUserWithQuote, type PlannedTurn, type QuoteTarget, type RoomCaps } from "./logic.ts";
import { waitingRequestIds } from "./checkpoint.ts";
import { hasActiveProject } from "./projects.ts";
import { cancelQueue, emitState, enqueue, fresh, states, type QuoteInfo, type RoomState, type Turn } from "./queue.ts";
import { activeIds, capsOf, changed, getRoom, memberConversation, memberRefs, memberRow, membersOf, snapshot, sys } from "./store.ts";
import { REASON_LINE, roomFiles, transcriptFor } from "./turn-prompt.ts";

// 队列状态和 roomFiles 拆到了 queue.ts / turn-prompt.ts；外面照旧从这里取。
export { cancelQueuedFor, hasQueuedTurns, queuedFor, stateOf, states, type RoomState } from "./queue.ts";
export { roomFiles } from "./turn-prompt.ts";

/** 从群内可信消息行算引用路由目标（作者是否仍是可用成员）。 */
function quoteTargetOf(roomId: string, target: Message): QuoteTarget {
	if (target.role === "user") return { quotable: true, role: "user", authorAgentId: null, authorActive: false };
	if (target.role === "assistant") {
		const m = memberRow(roomId, target.agent_id);
		const active = !!m && !m.left_at && !m.deleted && !!getAgent(target.agent_id);
		return { quotable: true, role: "assistant", authorAgentId: target.agent_id, authorActive: active };
	}
	return { quotable: false, role: "system", authorAgentId: null, authorActive: false };
}

/** 协作层（collab.ts）挂进来的钩子：避免调度和协作互相 import。 */
export interface TurnHooks {
	/** 回合正常结束后（没停、没中止）：项目进行中成员互相 @、空聊检测、回复送回提问者 */
	after?: (roomId: string, t: Turn, res: { text: string; error?: string }) => void;
	/** 回合结束后（没停、没中止，成功与否都算）：管理者回合结束放行暂缓的任务 */
	ended?: (roomId: string, t: Turn) => void;
	/** check 回合的上下文：唤醒原因 + 看板摘要（读过的原因会清掉）；null = 原因都过时了，这一轮不跑 */
	checkContext?: (roomId: string) => string | null;
	/** 用户在群里发话（空聊计数清零、恢复成员互相叫醒） */
	onUserMessage?: (roomId: string) => void;
}
let hooks: TurnHooks = {};
export const setTurnHooks = (h: TurnHooks) => void (hooks = h);

/** 协作层追加回合（唤醒管理者 / 成员互相 @）：群空闲就开一轮，正在跑就排在后面。群已停止返回 false。 */
export function scheduleTurns(roomId: string, turns: PlannedTurn[]) {
	if (!turns.length || !getRoom(roomId)) return false;
	let s = states.get(roomId);
	if (s?.stopped) return false;
	if (!s || (!s.current && !s.queue.length && !s.running)) {
		s = fresh();
		states.set(roomId, s);
	}
	enqueue(roomId, s, turns, s.sourceMessageId);
	emitState(roomId);
	void pump(roomId);
	return true;
}

/** 用户在群里发言：先落库，再按可信持久化源消息路由（幂等，见 routeUserMessage）。 */
export function postUserMessage(roomId: string, text: string, opts: { mentions?: string[]; from?: unknown; attachments?: string[]; replyToId?: string; clientId?: string; workItemId?: string } = {}) {
	const r = getRoom(roomId);
	if (!r) throw new Error("群不存在");
	if (opts.clientId) {
		const dup = getMessageByClientId({ roomId, clientId: opts.clientId });
		if (dup) return dup;
	}
	const body = text.slice(0, 100_000);
	const files = (opts.attachments ?? []).map(getFile).filter((f): f is FileRow => !!f && f.room_id === roomId && f.agent_id === "");
	// 看板反馈入口：任务必须真的属于这个群，关联由服务端写入（前端不能自己伪造 workItemId）。
	const workItemId = opts.workItemId && db.prepare("SELECT 1 FROM work_items WHERE id = ? AND room_id = ?").get(opts.workItemId, roomId) ? opts.workItemId : undefined;
	if (!body.trim() && !files.length) throw new Error("empty");
	let quote: QuoteInfo | null = null;
	if (opts.replyToId) {
		const target = resolveReplyTarget({ scope: { kind: "room", id: roomId }, messageId: opts.replyToId });
		quote = { snapshot: buildReplySnapshot(target, { kind: "room", id: roomId }), target: quoteTargetOf(roomId, target) };
	}
	const parsed = parseMentions(body, memberRefs(roomId), opts.mentions ?? []);
	const msg = insertMessage({ agentId: "", roomId, conversationId: null, role: "user", content: body, replyToId: opts.replyToId ?? null, replySnapshot: quote?.snapshot ?? null, clientId: opts.clientId ?? null, meta: { from: opts.from, mentions: parsed.ids, all: parsed.all, ...(quote ? { replyTo: opts.replyToId } : {}), ...(files.length ? { attachments: files.map(fileInfo) } : {}), ...(workItemId ? { workItemId } : {}) } });
	routeUserMessage(roomId, msg.id);
	return msg;
}

/**
 * 按已持久化的群用户消息路由本轮。以 DB 行（可信 sourceMessageId）为准，不接受客户端传参。
 * 幂等：同一来源已有任何回合就整组不再路由、不重复唤醒；只有显式 `retry` 且此前全部回合都被取消时才重新唤醒。
 */
export function routeUserMessage(roomId: string, messageId: string, opts: { retry?: boolean } = {}): void {
	const r = getRoom(roomId);
	if (!r) throw new Error("群不存在");
	const msg = getMessage(messageId);
	if (!msg || msg.room_id !== roomId || msg.role !== "user" || msg.agent_id !== "") throw new Error("不是群里的用户消息");
	const prior = db.prepare("SELECT status FROM room_turns WHERE room_id = ? AND source_message_id = ?").all(roomId, messageId) as { status: string }[];
	if (prior.length && !(opts.retry && prior.every((x) => x.status === "cancelled"))) return;
	hooks.onUserMessage?.(roomId);
	const meta = msg.meta ?? {};
	const body = msg.content;
	const files = ((meta.attachments as { fileId?: string }[] | undefined) ?? []).map((a) => (a.fileId ? getFile(a.fileId) : undefined)).filter((f): f is FileRow => !!f && f.room_id === roomId && f.agent_id === "");
	let quote: QuoteInfo | null = null;
	if (msg.replyToId) {
		const target = resolveReplyTarget({ scope: { kind: "room", id: roomId }, messageId: msg.replyToId });
		quote = { snapshot: msg.reply ?? buildReplySnapshot(target, { kind: "room", id: roomId }), target: quoteTargetOf(roomId, target) };
	}
	const parsed = parseMentions(body, memberRefs(roomId), Array.isArray(meta.mentions) ? (meta.mentions as string[]) : []);
	let plan = planForUserWithQuote({ mentioned: parsed.ids, managerId: r.manager_id, activeIds: activeIds(roomId), quote: quote?.target ?? null });
	// 长期任务：用户明确指到某个任务（编号 / 任务名 / 引用结果卡）时由管理者接收纠正；只是 @ 成员时保持定向规则。
	const workRef = resolveWorkReferences(roomId, body, msg.replyToId ?? null, typeof msg.meta.workItemId === "string" ? msg.meta.workItemId : null);
	let workCtx: string | null = null;
	if (!parsed.ids.length && workRef.matches.length) {
		plan = { turns: planForUser([], r.manager_id, activeIds(roomId)), directed: false };
		workCtx = buildWorkCorrectionContext(roomId, workRef, body, msg.id);
	}
	if (plan.notice && !workCtx) sys(roomId, plan.notice, { kind: "reply-unroutable" });
	// 暂停后回复“继续”：接着跑没说完的
	if (r.paused && !states.get(roomId)?.current && !parsed.ids.length && !quote && /^\s*(继续|接着来|continue)\s*[。.!！]?\s*$/i.test(body)) {
		continueRoom(roomId);
		changed(roomId);
		return;
	}
	if (r.paused) db.prepare("UPDATE rooms SET paused = NULL WHERE id = ?").run(roomId);
	const s = states.get(roomId);
	if (s?.current && !files.length && isStopCommand(body)) {
		updateMessage(msg.id, { meta: { delivery: "stop" } });
		void stop(roomId);
		changed(roomId);
		return;
	}
	if (s?.current) {
		const cur = s.current;
		const directedIds = plan.directed ? plan.turns.map((t) => t.agentId) : null;
		// 任务纠正需要完整上下文：不塞进正在跑的回合里当插话，等这一轮结束后单独给管理者一次协调回合。
		const forCurrent = workCtx ? false : plan.notice ? false : directedIds ? directedIds.includes(cur.agentId) : parsed.ids.length ? parsed.ids.includes(cur.agentId) : true;
		const rt = runtime(cur.agentId, cur.conversationId);
		const quoteText = quote && forCurrent ? formatQuotedContext(quote.snapshot) : undefined;
		if (forCurrent && rt.busy) void rt.send(`（用户在群里说）${body}${files.length ? `\n（附带 ${files.length} 个附件，见群聊记录）` : ""}`, undefined, { messageId: msg.id, quote: quoteText });
		// 取消排队的（管理者的看板检查保留），等它说完按新消息重新安排
		cancelQueue(s, { keep: (q) => q.reason === "check" });
		s.batch.clear();
		const others = plan.directed ? plan.turns.map((t) => t.agentId).filter((x) => x !== cur.agentId) : parsed.ids.filter((x) => x !== cur.agentId);
		const handled = !workCtx && !plan.notice && forCurrent && rt.busy && (plan.directed ? others.length === 0 : parsed.ids.length ? !others.length : cur.agentId === r.manager_id);
		s.replan = workCtx ? { mentions: [], quote, sourceMessageId: msg.id, workCtx } : handled || !plan.turns.length ? null : { mentions: parsed.ids, quote, sourceMessageId: msg.id, workCtx };
		emitState(roomId);
	} else if (plan.turns.length) startRound(roomId, plan.turns, quote, msg.id, workCtx);
	else if (!plan.notice && !parsed.ids.length) sys(roomId, "群里还没有可以回答的助理，请在群设置里添加。", { action: "room-settings" });
	changed(roomId);
}

function startRound(roomId: string, plan: PlannedTurn[], quote: QuoteInfo | null, sourceMessageId: string, workCtx: string | null = null) {
	const s = fresh();
	s.quote = quote?.snapshot ?? null;
	s.sourceMessageId = sourceMessageId;
	s.workCtx = workCtx;
	enqueue(roomId, s, plan, sourceMessageId, true);
	const prev = states.get(roomId);
	if (!s.queue.length && prev && (prev.current || prev.queue.length)) return;
	// 上一轮还排着的看板检查不丢：接到新一轮后面
	if (prev && prev !== s) {
		s.queue.push(...prev.queue.filter((x) => x.reason === "check"));
		prev.queue = prev.queue.filter((x) => x.reason !== "check");
	}
	states.set(roomId, s);
	void pump(roomId);
}


async function pump(roomId: string) {
	const s = states.get(roomId);
	if (!s || s.running) return;
	s.running = true;
	try {
		while (!s.stopped) {
			if (!s.queue.length && s.replan) {
				const re = s.replan;
				s.replan = null;
				Object.assign(s, { roundId: uid("rd"), counters: { turns: 0, perAgent: {} }, batch: new Set(), batchRan: false });
				const r = getRoom(roomId);
				if (!r) break;
				s.quote = re.quote?.snapshot ?? null;
				s.sourceMessageId = re.sourceMessageId;
				s.workCtx = re.workCtx;
				const replan = planForUserWithQuote({ mentioned: re.mentions, managerId: r.manager_id, activeIds: activeIds(roomId), quote: re.quote?.target ?? null });
				if (replan.notice) sys(roomId, replan.notice, { kind: "reply-unroutable" });
				enqueue(roomId, s, replan.turns, re.sourceMessageId, true);
			}
			const next = s.queue[0];
			if (!next) break;
			const r = getRoom(roomId);
			if (!r) break;
			const caps = capsOf(r);
			// 项目进行中不按「每轮发言次数」暂停（那是平时防刷屏的；项目进行中靠卡住 / 空聊检测）。
			const why = hasActiveProject(roomId) ? null : capCheck(next, s.counters, caps);
			if (why) {
				// 到上限：把还没说的存起来，等用户点“继续”
				const pending = s.queue.map(({ agentId, reason, task, depth, directed, turnId, from }) => ({ agentId, reason, task, depth, directed, turnId, from }));
				cancelQueue(s);
				db.prepare("UPDATE rooms SET paused = ? WHERE id = ?").run(JSON.stringify({ pending, reason: why }), roomId);
				sys(roomId, `本轮已暂停（${why}），回复继续`, { kind: "room-paused", action: "room-continue" });
				break;
			}
			s.queue.shift();
			if (!activeIds(roomId).includes(next.agentId)) continue;
			await runTurn(roomId, s, next, caps);
		}
	} finally {
		s.running = false;
		s.current = null;
		if (!s.queue.length) s.batch.clear();
		emitState(roomId);
		changed(roomId);
	}
}

async function runTurn(roomId: string, s: RoomState, t: Turn, caps: RoomCaps) {
	const r = getRoom(roomId)!;
	const conv = memberConversation(roomId, t.agentId);
	snapshot(roomId, t.agentId);
	const tr = transcriptFor(roomId, t.agentId, t.reason === "check" ? 4000 : 16_000);
	const managerName = getAgent(r.manager_id ?? "")?.name ?? "管理者";
	const selfName = getAgent(t.agentId)?.name ?? "";
	const want = new Map<string, FileRow>();
	for (const tf of tr.files) {
		const f = getFile(tf.fileId);
		if (f && f.agent_id !== t.agentId) want.set(f.id, f);
	}
	if (t.task) for (const f of roomFiles(roomId)) if (f.agent_id !== t.agentId && t.task.includes(f.name)) want.set(f.id, f);
	const inputs = [...want.values()].flatMap((f) => {
		try {
			return [attachmentInputFor(t.agentId, f, roomId)];
		} catch {
			return [];
		}
	});
	const quoteBlock = s.quote && t.reason !== "check" && t.reason !== "peer" ? formatQuotedContext(s.quote) : "";
	const directedLine = t.directed && t.agentId === r.manager_id ? "用户引用了你的消息，只回应用户引用的这条；除非用户明确要求你分工，否则不要 room_assign、不要 @ 其他成员。" : "";
	const taskCtx = s.workCtx && t.agentId === r.manager_id && t.reason !== "check" ? s.workCtx : "";
	const checkCtx = t.reason === "check" && hooks.checkContext ? hooks.checkContext(roomId) : "";
	if (checkCtx === null) return void db.prepare("UPDATE room_turns SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now(), t.turnId);
	const prompt = [`（群聊「${r.name}」里的新消息 · 你是 ${selfName}${t.agentId === r.manager_id ? "（管理者）" : ""}）`, ...(quoteBlock ? [quoteBlock, "——"] : []), tr.text || "（没有新消息）", "——", REASON_LINE(t, managerName, caps.maxDepth - t.depth - 1, hasActiveProject(r.id)), ...(directedLine ? [directedLine] : []), ...(taskCtx ? ["——", taskCtx] : []), ...(checkCtx ? ["——", checkCtx] : [])].join("\n");
	db.prepare("UPDATE room_members SET cursor = ? WHERE room_id = ? AND agent_id = ?").run(tr.lastSeq || memberRow(roomId, t.agentId)?.cursor || 0, roomId, t.agentId);
	s.current = { agentId: t.agentId, turnId: t.turnId, conversationId: conv, reason: t.reason };
	s.assignments = [];
	// 看板检查 / 成员互相 @ 不占这一轮的计数（不和用户这一轮抢上限）
	if (t.reason !== "check" && t.reason !== "peer") {
		s.counters.turns++;
		s.counters.perAgent[t.agentId] = (s.counters.perAgent[t.agentId] ?? 0) + 1;
	}
	db.prepare("UPDATE room_turns SET status = 'running', started_at = ? WHERE id = ?").run(now(), t.turnId);
	emitState(roomId);
	let res: Awaited<ReturnType<ReturnType<typeof runtime>["turn"]>>;
	try {
		res = await runtime(t.agentId, conv).turn(prompt, inputs);
	} catch (e) {
		res = { ok: false, aborted: false, error: e instanceof Error ? e.message : String(e), text: "", tokens: 0 };
	}
	db.prepare("UPDATE room_turns SET status = ?, error = ?, tokens = ?, finished_at = ? WHERE id = ?").run(res.aborted ? "cancelled" : res.error ? "error" : "done", res.error ?? null, res.tokens, now(), t.turnId);
	const name = getAgent(t.agentId)?.name ?? "助理";
	if (res.error && !res.aborted) sys(roomId, `${name} 出错了，已跳过：${res.error.slice(0, 200)}`, {}, "error");
	s.current = null;
	if (s.stopped || res.aborted) return;
	hooks.ended?.(roomId, t);
	const rr = getRoom(roomId);
	if (!rr) return;
	const isMgr = t.agentId === rr.manager_id;
	if (isMgr && !res.error) {
		// 文字里的 @名字 也算派活（工具更可靠，两者合并去重）
		const parsed = parseMentions(res.text, memberRefs(roomId).filter((m) => m.id !== t.agentId));
		for (const id of parsed.ids) if (!s.assignments.some((a) => a.agentId === id)) s.assignments.push({ agentId: id });
	}
	if (t.reason === "assign" || t.reason === "resume") s.batch.delete(t.agentId);
	if (t.reason === "assign") s.batchRan = true; // 失败 / 阻塞也要让管理者收到一次协调机会
	const follow = planAfter(t, { managerId: rr.manager_id, activeIds: activeIds(roomId), assignments: isMgr ? s.assignments : [], caps: capsOf(rr), batchDone: s.batch.size === 0, anyWorkerRan: s.batchRan });
	if (isMgr && s.assignments.length && !follow.length && t.depth + 1 > capsOf(rr).maxDepth) sys(roomId, "派活层数到上限了，这一轮不再继续分配。", { kind: "room-cap" });
	if (follow.length) {
		if (isMgr) {
			s.batch = new Set(follow.map((f) => f.agentId));
			s.batchRan = false;
		}
		enqueue(roomId, s, follow, s.sourceMessageId);
	}
	s.assignments = [];
	if (!res.error) hooks.after?.(roomId, t, { text: res.text ?? "" });
}

/** 运行中回合的收拢：只中止这个群成员对话，不跨群 / 不碰主会话。 */
async function abortConversationTurn(agentId: string, conversationId: string) {
	await runtime(agentId, conversationId).abort({ scope: "conversation" }).catch(() => {});
}

/**
 * 停止：中止正在说话的，取消排队的，拒绝群里等待处理的请求。只停这个群的发言：
 * 长期任务的执行在负责人自己的任务会话里，不跟着停（它们的审批和「等你决定」也保留）；要停任务用看板的暂停 / 全部暂停。
 */
export async function stop(roomId: string, note = true) {
	const s = states.get(roomId);
	const cur = s?.current ?? null;
	const openTurns = db.prepare("SELECT id FROM room_turns WHERE room_id = ? AND status IN ('queued','running')").all(roomId) as { id: string }[];
	const had = !!s || openTurns.length > 0;
	if (s) {
		s.stopped = true;
		s.replan = null;
		cancelQueue(s);
	}
	db.prepare("UPDATE room_turns SET status = 'cancelled', finished_at = COALESCE(finished_at, ?) WHERE room_id = ? AND status IN ('queued','running')").run(now(), roomId);
	markRoomStopped(roomId);
	const decisions = (db.prepare("SELECT json_extract(needs_user, '$.requestId') AS id FROM work_items WHERE room_id = ? AND needs_user IS NOT NULL").all(roomId) as { id: string | null }[]).map((x) => x.id).filter((x): x is string => !!x);
	requests.cancelForRoom(roomId, { exceptConversations: execConversationsOfRoom(roomId), exceptIds: [...decisions, ...waitingRequestIds(roomId)] });
	for (const m of membersOf(roomId)) if (m.conversation_id) await stopConversationSubagents(m.agent_id, m.conversation_id).catch(() => {});
	if (cur) {
		s!.current = null;
		await abortConversationTurn(cur.agentId, cur.conversationId);
	}
	if (s && states.get(roomId) === s) states.delete(roomId);
	if (note && cur) sys(roomId, "已停止");
	emitState(roomId);
	changed(roomId);
	return had;
}

/** 持久停止事实：重启 / 内存状态清掉后，唤醒管理者仍被挡；用户明确的新消息或“继续”才会清掉。 */
function markRoomStopped(roomId: string) {
	if (!getRoom(roomId)) return;
	db.prepare("UPDATE rooms SET paused = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ pending: [], reason: "群聊已停止", stopped: true }), now(), roomId);
}

/** 继续：接着跑上次暂停 / 中断时没说完的；没有就请管理者接着来。旧版本里绑着长期任务的回合不再重放（任务在看板上继续）。 */
export function continueRoom(roomId: string) {
	const r = getRoom(roomId);
	if (!r) throw new Error("群不存在");
	if (states.get(roomId)?.current || !r.paused) return false;
	const p = JSON.parse(r.paused) as { pending?: (PlannedTurn & { workItemId?: string })[] };
	db.prepare("UPDATE rooms SET paused = NULL WHERE id = ?").run(roomId);
	const s = fresh();
	states.set(roomId, s);
	const act = activeIds(roomId);
	const mgr = r.manager_id && act.includes(r.manager_id) ? r.manager_id : act[0];
	const turns: PlannedTurn[] = [];
	let legacy = 0;
	for (const x of (p?.pending ?? []).filter((x) => act.includes(x.agentId))) {
		if (x.workItemId) legacy++;
		else turns.push({ agentId: x.agentId, reason: x.reason, task: x.task, depth: 0, directed: x.directed, from: x.from });
	}
	if (legacy) sys(roomId, "长期任务现在在负责人自己的任务会话里执行，不从群里重放；需要时在任务看板上点继续。", { kind: "work-not-resumed" });
	if (turns.length) {
		s.batch = new Set(turns.filter((x) => x.reason === "assign").map((x) => x.agentId));
		enqueue(roomId, s, turns);
	} else if (mgr) enqueue(roomId, s, [{ agentId: mgr, reason: "resume", depth: 0 }]);
	else return false;
	void pump(roomId);
	changed(roomId);
	return true;
}

export function markRead(roomId: string) {
	db.prepare("UPDATE rooms SET unread = 0 WHERE id = ?").run(roomId);
	bus.emit({ type: "room.read", roomId });
}

/** 启动：上次运行中的群聊回合 → 标记中断，给“继续”按钮（长期任务的执行由 bootstrapWorkItems 标中断）。 */
export function bootstrapRooms() {
	const rows = db.prepare("SELECT * FROM room_turns WHERE status IN ('running','queued') ORDER BY created_at").all() as { id: string; room_id: string; agent_id: string; reason: string; task: string | null; depth: number; status: string; work_item_id?: string | null }[];
	const byRoom = new Map<string, typeof rows>();
	for (const t of rows) byRoom.set(t.room_id, [...(byRoom.get(t.room_id) ?? []), t]);
	for (const [roomId, ts] of byRoom) {
		db.prepare("UPDATE room_turns SET status = 'interrupted', finished_at = ? WHERE room_id = ? AND status IN ('running','queued')").run(now(), roomId);
		if (!getRoom(roomId)) continue;
		const pending = ts.map((t) => ({ agentId: t.agent_id, reason: t.status === "running" ? "resume" : t.reason, task: t.task ?? undefined, depth: t.depth, turnId: t.id, workItemId: t.work_item_id ?? undefined }));
		db.prepare("UPDATE rooms SET paused = ? WHERE id = ?").run(JSON.stringify({ pending, reason: "服务重启" }), roomId);
		sys(roomId, "服务重启，群聊被中断了", { kind: "room-interrupted", action: "room-continue" });
	}
	for (const a of listAgents()) if (a.status === "running" && db.prepare("SELECT 1 FROM room_turns WHERE agent_id = ? AND status = 'interrupted' LIMIT 1").get(a.id)) db.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(a.id);
}
