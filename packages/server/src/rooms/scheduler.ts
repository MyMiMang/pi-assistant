/**
 * 群的发言调度（用户决定的“管理者”模式）：
 *  1. 用户 @ 了谁，就只有谁回答（按 @ 的顺序依次说，后说的能看到前面的）；@所有人 = 全部成员
 *  2. 用户没 @ 人：只有管理者回答——它理解需求，自己答或用 room_assign / @名字 派活
 *  3. 普通成员只有被用户或管理者 @ 才会说话；开了自主推进后成员可以 @ 彼此（collab.ts）
 *  4. 派出去的成员都做完后管理者再总结一次（可关），还可以继续派（有深度上限）
 * 每轮上限：发言次数、派活深度、每人次数、token 预算；到上限写“本轮已暂停”，用户点继续。
 * 长期任务的执行不在这里：它们在负责人自己的任务会话里跑（work-items/exec.ts），不占群的回合和上限。
 */
import { bus } from "../bus.ts";
import { db, now, uid } from "../db.ts";
import { attachmentInputFor, type FileRow, fileInfo, getFile, materializeFor } from "../files.ts";
import { isStopCommand } from "../interject.ts";
import { getMessage, getMessageByClientId, insertMessage, updateMessage, type Message, type ReplySnapshot } from "../messages.ts";
import { buildReplySnapshot, formatQuotedContext, resolveReplyTarget } from "../replies.ts";
import { requests } from "../requests.ts";
import { getAgent, listAgents, runtime } from "../runtime.ts";
import { stopConversationSubagents } from "../subagents.ts";
import { buildWorkCorrectionContext, execConversationsOfRoom, resolveWorkReferences } from "../work-items.ts";
import { buildTranscript, capCheck, parseMentions, planAfter, planForUser, planForUserWithQuote, type PlannedTurn, type QuoteTarget, type RoomCaps, type RoundCounters, type TranscriptItem } from "./logic.ts";
import { activeIds, capsOf, changed, getRoom, memberConversation, memberRefs, memberRow, membersOf, snapshot, sys } from "./store.ts";

/** 已解析的引用：快照（给模型/UI）+ 纯逻辑路由目标 */
type QuoteInfo = { snapshot: ReplySnapshot; target: QuoteTarget };
type Turn = PlannedTurn & { turnId: string };

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
const fresh = (): RoomState => ({ roundId: uid("rd"), queue: [], current: null, counters: { turns: 0, perAgent: {}, tokens: 0 }, batch: new Set(), batchRan: false, assignments: [], replan: null, quote: null, sourceMessageId: null, workCtx: null, stopped: false, running: false });

/** 协作层（collab.ts）挂进来的钩子：避免调度和协作互相 import。 */
export interface TurnHooks {
	/** 回合正常结束后（没停、没中止）：自主推进的成员互相 @、空聊检测、回复送回提问者 */
	after?: (roomId: string, t: Turn, res: { text: string; error?: string }) => void;
	/** check 回合的上下文：唤醒原因 + 看板摘要（读过的原因会清掉） */
	checkContext?: (roomId: string) => string;
	/** 用户在群里发话（空聊计数清零、恢复成员互相叫醒） */
	onUserMessage?: (roomId: string) => void;
}
let hooks: TurnHooks = {};
export const setTurnHooks = (h: TurnHooks) => void (hooks = h);

export function stateOf(roomId: string) {
	const s = states.get(roomId);
	if (!s || (!s.current && !s.queue.length)) return { running: false, current: null, queue: [] as string[] };
	return { running: true, current: s.current ? { agentId: s.current.agentId, reason: s.current.reason } : null, queue: s.queue.map((q) => q.agentId) };
}
const emitState = (roomId: string) => bus.emit({ type: "room.state", roomId, state: stateOf(roomId) });

/**
 * 入队。`sourceMessageId` 记录触发本轮的用户消息（可信持久化 id）。
 * `dedup=true` 时原子认领：同一来源消息的同一「收件人 + 用途」已有未取消回合 → 跳过，
 * 使重复路由事件 / 客户端重试 / 服务重启不重复唤醒；真正分工出的不同收件人 / 用途照常入队（见 docs/design/message-replies.md §7）。
 */
function enqueue(roomId: string, s: RoomState, turns: PlannedTurn[], sourceMessageId: string | null = null, dedup = false) {
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
function cancelQueue(s: RoomState, o: { agentId?: string; keep?: (q: Turn) => boolean } = {}) {
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
export const queuedFor = (roomId: string, reason: PlannedTurn["reason"], agentId?: string) => !!states.get(roomId)?.queue.some((q) => q.reason === reason && (!agentId || q.agentId === agentId));

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

const REASON_LINE = (t: PlannedTurn, managerName: string, depthLeft: number) =>
	({
		mention: "用户在群里 @ 了你。请直接回应用户最新的消息（只做用户让你做的，别替其他成员回答）。",
		manager:
			"用户没有 @ 任何人，由你（管理者）负责：先理解用户要什么。简单的事你自己直接回答；需要其他成员做的，调用 room_assign 分配（每个人写清楚具体任务），并在回复里用一两句话说明分工。不需要别人时不要分配。需要长期负责、可检查的工作用 work_create 记成任务，成员会在自己的任务会话里去做。",
		assign: `管理者 ${managerName} 给你分配了任务：${t.task?.trim() || "（见管理者上面的消息）"}\n完成后在群里简洁汇报结果。`,
		followup: `你分配的成员都已结束（有失败、受阻或待核验的也在上面）。请先核验 / 处理这些结果，再给用户一个简短的总结，不要重复成员说过的细节；还需要继续时可以再用 room_assign 分配${depthLeft > 0 ? `（还能再派 ${depthLeft} 次）` : "（这一轮已不能再派活）"}。`,
		resume: "（系统通知）服务重启或用户让你继续：上一次发言可能被中断了。请检查进度，接着完成你在群里的任务；已经完成就简短说明。",
		check: "任务看板有变化，需要你（管理者）看一下。下面是唤醒原因和看板摘要：核验已提交的结果（work_verify，先读真实产物）。大部分决定按群目标自己分析、自己推进。卡住或反复退回由你自己处理：看负责人的执行记录找原因，带纠正重派或拆小，改派给别的成员或自己接手（work_update）；只有需要用户才能给的帮助（批准、登录凭据、资源）或超出群目标、你无权拍板的决定才用 work_ask_user；办法用尽时在群里跟用户说清问题是什么、需要用户帮什么。处理完在群里用一两句话说明；没什么要做就简短说一句。",
		peer: `${getAgent(t.from ?? "")?.name ?? "一位成员"} 在群里 @ 了你：${t.task?.trim().slice(0, 1500) || "（见上面的消息）"}\n直接在群里简短回复它；需要你动手的就做。不要替管理者分配任务，也不要只客套。`,
	})[t.reason];

/** 群里出现过的全部附件（用户上传 + 成员发出的） */
export function roomFiles(roomId: string): FileRow[] {
	const ids = new Set<string>();
	for (const m of db.prepare("SELECT meta FROM messages WHERE room_id = ? AND meta LIKE '%fileId%'").all(roomId) as { meta: string }[])
		for (const f of (JSON.parse(m.meta).attachments as { fileId?: string }[] | undefined) ?? []) if (f.fileId) ids.add(f.fileId);
	return [...ids].map(getFile).filter((f): f is FileRow => !!f);
}

function transcriptFor(roomId: string, agentId: string, budget = 16_000) {
	const m = memberRow(roomId, agentId)!;
	const rows = (
		m.cursor == null
			? db.prepare("SELECT rowid AS seq, * FROM messages WHERE room_id = ? AND role IN ('user','assistant','system','card') ORDER BY rowid DESC LIMIT 300").all(roomId).reverse()
			: db.prepare("SELECT rowid AS seq, * FROM messages WHERE room_id = ? AND rowid > ? AND role IN ('user','assistant','system','card') ORDER BY rowid LIMIT 500").all(roomId, m.cursor)
	) as { seq: number; role: TranscriptItem["role"]; agent_id: string; content: string; meta: string; status: string }[];
	const items: TranscriptItem[] = rows.map((x) => ({ seq: x.seq, role: x.role, agentId: x.agent_id, content: x.content, meta: JSON.parse(x.meta), status: x.status }));
	const names = new Map(membersOf(roomId, true).map((x) => [x.agent_id, getAgent(x.agent_id)?.name ?? x.name]));
	const paths = new Map<string, string>();
	const pathOf = (tf: { fileId: string }) => {
		if (!paths.has(tf.fileId)) {
			const f = getFile(tf.fileId);
			if (f) {
				try {
					paths.set(tf.fileId, materializeFor(agentId, f, roomId));
				} catch {
					/* 文件丢了：只写名字 */
				}
			}
		}
		return paths.get(tf.fileId);
	};
	return buildTranscript(items, agentId, (id) => names.get(id) ?? "助理", budget, pathOf);
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
				Object.assign(s, { roundId: uid("rd"), counters: { turns: 0, perAgent: {}, tokens: 0 }, batch: new Set(), batchRan: false });
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
			const why = capCheck(next, s.counters, caps);
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
	const checkCtx = t.reason === "check" ? (hooks.checkContext?.(roomId) ?? "") : "";
	const prompt = [`（群聊「${r.name}」里的新消息 · 你是 ${selfName}${t.agentId === r.manager_id ? "（管理者）" : ""}）`, ...(quoteBlock ? [quoteBlock, "——"] : []), tr.text || "（没有新消息）", "——", REASON_LINE(t, managerName, caps.maxDepth - t.depth - 1), ...(directedLine ? [directedLine] : []), ...(taskCtx ? ["——", taskCtx] : []), ...(checkCtx ? ["——", checkCtx] : [])].join("\n");
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
	if (t.reason !== "check" && t.reason !== "peer") s.counters.tokens += res.tokens;
	db.prepare("UPDATE room_turns SET status = ?, error = ?, tokens = ?, finished_at = ? WHERE id = ?").run(res.aborted ? "cancelled" : res.error ? "error" : "done", res.error ?? null, res.tokens, now(), t.turnId);
	const name = getAgent(t.agentId)?.name ?? "助理";
	if (res.error && !res.aborted) sys(roomId, `${name} 出错了，已跳过：${res.error.slice(0, 200)}`, {}, "error");
	s.current = null;
	if (s.stopped || res.aborted) return;
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
	requests.cancelForRoom(roomId, { exceptConversations: execConversationsOfRoom(roomId), exceptIds: decisions });
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
