/**
 * 助理群聊的纯逻辑（不碰数据库/模型，便于单测）：
 *  - @ 解析（中文名、无空格、重名、@所有人）
 *  - 发言规则（用户 @ 谁谁说；没 @ = 只有管理者说；普通成员 @ 别人不触发）
 *  - 每轮上限（总发言数、管理者派活深度、每人次数；不设 token 预算：缓存命中的读取量会让它几乎每轮都撞线）
 *  - 增量注入：把群里“这个成员还没看过”的消息整理成一段文字
 */

export interface MemberRef {
	id: string;
	name: string;
}
export const ALL_TOKENS = ["所有人", "全体成员", "全体", "all", "everyone"];

const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

/**
 * 解析 @：按出现顺序返回成员 id（去重）。
 * - 名字按最长匹配（"@小明明" 优先匹配成员“小明明”而不是“小明”），中文名后面可以直接跟文字
 * - 英文/数字结尾的名字后面不能紧跟字母数字（"@Bobby" 不会匹配 “Bob”）
 * - '@' 前面是字母数字时不算（邮箱 a@b.com）
 * - 重名：同名成员都算被 @（界面上的 @ 选择器会带上精确 id，见 explicit）
 * - @所有人 / @all → 全部成员（按成员顺序），all=true
 */
export function parseMentions(text: string, members: MemberRef[], explicit: string[] = []): { ids: string[]; all: boolean } {
	const names = [...new Set(members.map((m) => m.name.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
	const hits: { pos: number; ids: string[]; all?: boolean }[] = [];
	let all = false;
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "@" && text[i] !== "＠") continue;
		if (isWordChar(text[i - 1])) continue;
		const rest = text.slice(i + 1);
		const low = rest.toLowerCase();
		const allTok = ALL_TOKENS.find((t) => low.startsWith(t.toLowerCase()) && !(isWordChar(t.at(-1)) && isWordChar(rest[t.length])));
		const name = names.find((n) => low.startsWith(n.toLowerCase()) && !(isWordChar(n.at(-1)) && isWordChar(rest[n.length])));
		// 成员名比“所有人”更长且匹配时优先成员（例如有人叫“全体成员小助手”）
		if (allTok && (!name || name.length <= allTok.length)) {
			all = true;
			hits.push({ pos: i, ids: members.map((m) => m.id), all: true });
			continue;
		}
		if (name) hits.push({ pos: i, ids: members.filter((m) => m.name.trim().toLowerCase() === name.toLowerCase()).map((m) => m.id) });
	}
	const out: string[] = [];
	// 重名：界面 @ 选择器带来的精确 id 优先（只 @ 选中的那一个）
	const valid = explicit.filter((id) => members.some((m) => m.id === id));
	for (const h of hits) {
		if (h.all || h.ids.length < 2) continue;
		const picked = h.ids.filter((id) => valid.includes(id));
		if (picked.length) h.ids = picked;
	}
	for (const h of hits.sort((a, b) => a.pos - b.pos)) for (const id of h.ids) if (!out.includes(id)) out.push(id);
	return { ids: out, all };
}

export interface RoomCaps {
	/** 每轮（一条用户消息引发的）最多发言次数 */
	maxTurns: number;
	/** 管理者最多派活几层 */
	maxDepth: number;
	/** 每个助理每轮最多发言次数 */
	perAgent: number;
	/** 成员做完后管理者再总结一次 */
	followup: boolean;
}
export const DEFAULT_CAPS: RoomCaps = { maxTurns: 8, maxDepth: 3, perAgent: 2, followup: true };
export function normalizeCaps(c: Partial<RoomCaps> | null | undefined): RoomCaps {
	const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
	return {
		maxTurns: n(c?.maxTurns, 1, 30, DEFAULT_CAPS.maxTurns),
		maxDepth: n(c?.maxDepth, 0, 10, DEFAULT_CAPS.maxDepth),
		perAgent: n(c?.perAgent, 1, 10, DEFAULT_CAPS.perAgent),
		followup: typeof c?.followup === "boolean" ? c.followup : DEFAULT_CAPS.followup,
	};
}

/** 管理者判断用户来意、立项出方案的规则（群规则里管理者永远带上；docs/design/group-team.md §2–3）。 */
export const INTENT_PLAN_RULE = "用户说话时，先判断来意：\n- 聊天、问问题、一两步就能做完的小事 → 直接回答，或点名对口成员回答，不立项。\n- 想做成一件需要多步、多人配合的事 → 立项，按这个顺序：① 先想清楚要做成什么、做到什么程度算完成、哪些地方不确定；② 能按常理定的细节用你的专业判断补上，写成「我们的理解 / 假设」，用户已经说得很清楚的就直接整理；③ 需要专业意见时，先用 room_assign 请对口成员简短出个主意（只出主意，不开工）；④ 只把真正没法替用户决定、又会影响结果的事问用户（比如给谁用、预算、个人偏好），一次最多问两个，每个都给出你建议的选项，答完还不清楚就接着问；⑤ 想清楚了就用 room_plan 出方案卡，分工里写上你自己负责的部分，然后等用户确认——确认前不要建任务、不要派活开工。\n- 用户看了方案明确同意（「可以」「就这么干」）→ 用 room_project_start 开始；说哪里要改 → 改好后用 room_plan（带 projectId）重新出卡；说先不做 → 不开始，回到平时。\n- 项目进行中用户补充要求：小调整直接纳入、照常推进；影响目标、范围或交付物的大改动，用 room_plan（带 projectId）出改过的方案请用户重新确认。\n- 项目进行中用户问进度：两三句话说清做到哪了、接下来做什么、需不需要用户做什么。\n- 同时有几个项目时，先判断用户这句话属于哪个项目、还是一件新事；拿不准就用一句话问用户。";
/** 有项目进行中时给管理者的「接着推进」规则（唤醒文案、群规则共用一份）。 */
export const PROJECT_NEXT_STEP = "有项目在进行：成果核验通过、或手上没有在做的任务而项目还没完成时，就在这一轮里按方案规划下一步，按成员的角色分工用 work_create（带 projectId）建任务派给最对口的成员（属于你自己职责的你自己做），不要只汇报一句然后等用户；方案里写的关键点到了，用 room_checkpoint 请用户看一眼，其余进度只通知不提问；项目完成（对照完成标准逐条核对、都满足，项目下的任务都已收尾）时，直接用 room_project_done 结束这个项目：summary 写做成了什么，deliverables 填最终文件，howToUse 写怎么用，notDone 写还没做的。交付卡会把文件一起发给用户，交付前不要再用 deliver_file 把同样的文件逐个发一遍，交付后也不用再补一句「已经发给你了」。";
/** 项目进行中的唤醒原因：管理者回合结束后手上没活、项目还没结束（兜底），或定时检查时没有未完成任务 */
export const PROJECT_IDLE_WAKE = "项目还没完成，手上没有在做的任务：按方案规划下一步并派出去；已经完成就交付并结束项目";

/**
 * 看板指纹（给 idleWakeStep 判断「两次兜底之间有没有新进展」用）：项目进行中只认 work_items 的状态变化算进展——
 * 管理者反复用 room_assign 派同样的活（没建 work_item）不能让它一直觉得「有进展」而无限叫醒自己（boardSig 若把这类
 * 普通派活的完成次数也算进去，每叫醒一次管理者再派一次活，指纹就又变了，兜底永远判定有进展 → 无限循环）。
 * 没有项目进行中时 idleWakeStep 根本不会走到这一步（见上），这里仍把 plainAssignsDone 算进去只是让这个纯函数在
 * 两种输入下都有确定、可测的行为。
 */
export function boardSig(o: { items: { id: string; status: string }[]; plainAssignsDone: number; projectActive: boolean }): string {
	const itemsPart = o.items.map((x) => `${x.id}:${x.status}`).join(",");
	return o.projectActive ? itemsPart : `${itemsPart}|${o.plainAssignsDone}`;
}

/**
 * 降成本（§8「少读」）：管理者被叫醒时看板摘要和上一次完全一样，就不再整段重复，只写一行提示。
 * `digest` 是这次算出来的看板摘要全文，`lastDigest` 是上一次发给管理者的那份（没有就是 null，照常全量）。
 */
export function boardDigestOrUnchanged(digest: string, lastDigest: string | null): string {
	return lastDigest !== null && lastDigest === digest ? "任务看板和上次一样，没有变化。" : digest;
}

/**
 * 项目进行中的兜底：管理者一个回合正常结束后，项目没结束、没有进行中 / 待核验的任务、队列里也没有排着的回合 → 再叫醒它一次。
 * 有界：连续两次兜底之间看板没有任何新进展（sig 没变）就不再叫醒，改为提示用户一次（hint）；用户发话会重置（调用方清掉 lastSig / hinted）。
 */
export function idleWakeStep(o: { projectActive: boolean; inFlight: boolean; queued: boolean; lastSig: string | null; sig: string; hinted: boolean }): "wake" | "hint" | "none" {
	if (!o.projectActive || o.inFlight || o.queued) return "none";
	if (o.lastSig === null || o.lastSig !== o.sig) return "wake";
	return o.hinted ? "none" : "hint";
}

/** check = 关键事件唤醒管理者看看板；peer = 项目进行中成员 @ 了另一位成员 */
export type TurnReason = "mention" | "manager" | "assign" | "followup" | "resume" | "check" | "peer";
export interface PlannedTurn {
	agentId: string;
	reason: TurnReason;
	/** 管理者派活时写的任务说明 */
	task?: string;
	/** 派活深度（用户触发 = 0） */
	depth: number;
	/** 用户引用定向的一轮：只回应引用，默认不自动扩派（见 docs/design/message-replies.md §5） */
	directed?: boolean;
	/** peer：是谁 @ 了它（回复会送回提问者正在跑的任务会话） */
	from?: string;
}

/** 用户发言后谁来说：@ 了谁就是谁（按顺序）；没 @ = 只有管理者 */
export function planForUser(mentioned: string[], managerId: string | null, activeIds: string[]): PlannedTurn[] {
	const ids = mentioned.filter((id) => activeIds.includes(id));
	if (ids.length) return ids.map((agentId) => ({ agentId, reason: "mention" as const, depth: 0 }));
	const mgr = managerId && activeIds.includes(managerId) ? managerId : activeIds[0];
	return mgr ? [{ agentId: mgr, reason: "manager", depth: 0 }] : [];
}

/** 引用目标的解析结果（供纯逻辑判断，不含内容）。 */
export interface QuoteTarget {
	/** 目标是否可引用（user / assistant） */
	quotable: boolean;
	role: "user" | "assistant" | "system" | "other";
	/** assistant 的作者 agentId；user / system 为 null */
	authorAgentId: string | null;
	/** 作者是否是当前群里可用（存在、未删除、未移出）的成员 */
	authorActive: boolean;
}

/**
 * 群聊用户消息的路由（含引用）。优先级见 docs/design/message-replies.md §5：
 *  1. 显式 @（含 @all）优先，引用只作上下文；
 *  2. 无 @ + 引用群内可用助理 → 只唤醒作者 A；
 *  3. 无 @ + 引用用户 / system / 不可路由消息 → 走既有管理者路由；
 *  4. 无 @ + 引用被删除 / 停用的助理 → 不误唤管理者，给用户明确提示。
 * `directed` 标记“只回应引用、默认不自动扩派”的定向回合。
 */
export function planForUserWithQuote(o: {
	mentioned: string[];
	managerId: string | null;
	activeIds: string[];
	quote: QuoteTarget | null;
}): { turns: PlannedTurn[]; notice?: string; directed: boolean } {
	const ids = o.mentioned.filter((id) => o.activeIds.includes(id));
	if (ids.length) return { turns: ids.map((agentId) => ({ agentId, reason: "mention" as const, depth: 0, directed: true })), directed: true };
	const q = o.quote;
	if (q && q.role === "assistant" && q.authorAgentId) {
		if (q.quotable && q.authorActive && o.activeIds.includes(q.authorAgentId))
			return { turns: [{ agentId: q.authorAgentId, reason: "mention", depth: 0, directed: true }], directed: true };
		return { turns: [], notice: "你引用的这位成员已被删除或停用，不能定向回复；请用 @ 选择群里其它成员。", directed: true };
	}
	// 无 @，引用的是用户 / system / 不可引用消息：走既有管理者路由
	return { turns: planForUser([], o.managerId, o.activeIds), directed: false };
}

/**
 * 某人说完以后要接着安排谁：
 *  - 管理者说完：它派的活（工具 + 文字里的 @）→ 依次排队；深度 +1，超过 maxDepth 不再派
 *  - 普通成员说完：@ 别人一律不触发（只能建议，管理者决定）
 *  - 这一批派出去的成员都做完了：管理者再总结一次（followup 开关）
 */
export function planAfter(
	turn: PlannedTurn,
	o: { managerId: string | null; activeIds: string[]; assignments: { agentId: string; task?: string }[]; caps: RoomCaps; batchDone: boolean; anyWorkerRan: boolean },
): PlannedTurn[] {
	const isMgr = turn.agentId === o.managerId;
	if (isMgr) {
		const depth = turn.depth + 1;
		if (depth > o.caps.maxDepth) return [];
		const seen = new Set<string>();
		return o.assignments
			.filter((a) => a.agentId !== o.managerId && o.activeIds.includes(a.agentId) && !seen.has(a.agentId) && (seen.add(a.agentId), true))
			.map((a) => ({ agentId: a.agentId, reason: "assign" as const, task: a.task, depth }));
	}
	if (turn.reason === "assign" && o.batchDone && o.anyWorkerRan && o.caps.followup && o.managerId && o.activeIds.includes(o.managerId))
		return [{ agentId: o.managerId, reason: "followup", depth: turn.depth }];
	return [];
}

export interface RoundCounters {
	turns: number;
	perAgent: Record<string, number>;
}
/** 下一次发言能不能进行；不能时给出原因（写进“本轮已暂停”提示） */
export function capCheck(next: PlannedTurn, c: RoundCounters, caps: RoomCaps): string | null {
	// 关键事件唤醒管理者、项目进行中的成员互相 @：不算“这一轮用户发言引出的回合”，不占每轮上限（防护靠卡住 / 空聊检测）。
	if (next.reason === "check" || next.reason === "peer") return null;
	if (c.turns >= caps.maxTurns) return `这一轮已经发言 ${c.turns} 次`;
	// 管理者收尾（成员回报后的 followup）不占「同一助理每轮次数」：否则两波派活后管理者没法做总结。总次数上限仍然生效。
	if (next.reason !== "followup" && (c.perAgent[next.agentId] ?? 0) >= caps.perAgent) return "同一个助理这一轮发言次数到上限了";
	return null;
}

// ---------------------------------------------------------------- 增量注入

export interface TranscriptItem {
	seq: number;
	role: "user" | "assistant" | "system" | "card";
	agentId: string;
	content: string;
	meta: Record<string, unknown>;
	status: string;
}
/** 群里人人能看到的帮手概况：谁派的、在做什么、当前步骤、结果（工具步骤和命令输出不进群，见 helper-scope.ts）。 */
const HELPER_ST: Record<string, string> = { queued: "排队中", running: "进行中", stalled: "暂无进展", done: "已完成", failed: "失败", stopped: "已停止", timeout: "超时", lost: "中断待核验" };
function helperCardLine(who: string, m: Record<string, unknown>) {
	const h = (m.subagent ?? {}) as { title?: string | null; task?: string; status?: string; result_summary?: string | null; error_reason?: string | null };
	const one = (t: string | null | undefined, n: number) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
	const end = h.status === "done" ? one(h.result_summary, 300) : ["failed", "timeout", "lost"].includes(h.status ?? "") ? one(h.error_reason, 200) : "";
	return `[${who} 的帮手] ${one(h.title || h.task, 60)}（${HELPER_ST[h.status ?? ""] ?? h.status ?? ""}${m.currentStep && !end ? `，当前步骤：${String(m.currentStep)}` : ""}${end ? `：${end}` : ""}）`;
}
const cardLine = (who: string, m: Record<string, unknown>) => {
	const st = String(m.status ?? "");
	const stTxt = ({ pending: "等待用户处理", approved: "用户已批准", rejected: "用户已拒绝", answered: "用户已回答", expired: "已过期", done: "已完成", failed: "失败", cancelled: "已取消", running: "进行中", queued: "排队中" } as Record<string, string>)[st] ?? st;
	if (m.kind === "approval") return `[${who} 请求批准] ${String(m.summary ?? m.toolName ?? "")}（${stTxt}）`;
	if (m.kind === "question") return `[${who} 提问] ${String(m.question ?? "")}（${stTxt}${m.answer ? `：${String(m.answer)}` : ""}）`;
	if (m.kind === "task") return `[${who} 的后台任务] ${String(m.title ?? "")}（${stTxt}）`;
	if (m.kind === "subagent") return helperCardLine(who, m);
	if (m.kind === "room-plan") return `[${who} 的${m.revision ? "改过的" : ""}方案] ${String(m.title ?? "")}（项目编号 ${String(m.projectId ?? "")}，${({ pending: "等用户确认", confirmed: "用户已确认", dismissed: "用户选了先不做", superseded: "已被新方案取代" } as Record<string, string>)[st] ?? st}）`;
	return `[${who} 的卡片]`;
};
/**
 * 把这个成员还没看过的群消息整理成文字（只有最终文字和卡片摘要，不含别人的工具输出）。
 * 自己说过的不再重复（已经在自己的会话里）。超过预算时保留最近的，并提示省略了多少。
 */
export interface TranscriptFile {
	fileId: string;
	name: string;
}
export function buildTranscript(
	items: TranscriptItem[],
	selfId: string,
	nameOf: (agentId: string) => string,
	budgetChars = 16_000,
	/** 附件在当前助理工作区里的路径（没有就只写文件名） */
	pathOf?: (f: TranscriptFile) => string | undefined,
): { text: string; lastSeq: number; omitted: number; files: TranscriptFile[] } {
	const lines: string[] = [];
	const files: TranscriptFile[] = [];
	const fileNote = (it: TranscriptItem, verb: string) => {
		const fs = ((it.meta.attachments as TranscriptFile[] | undefined) ?? []).filter((f) => f?.fileId && f.name);
		if (!fs.length) return "";
		files.push(...fs);
		return `\n（${verb}：${fs.map((f) => { const p = pathOf?.(f); return p ? `${f.name} → ${p}` : f.name; }).join("、")}）`;
	};
	let lastSeq = 0;
	for (const it of items) {
		lastSeq = Math.max(lastSeq, it.seq);
		if (it.agentId === selfId && it.role !== "user") continue;
		if (it.role === "system" && (it.meta.kind === "compaction" || it.meta.internal)) continue;
		if (it.role === "assistant" && (it.status === "streaming" || !it.content.trim())) {
			if (!(it.meta.attachments as unknown[] | undefined)?.length) continue;
		}
		const who = it.role === "user" ? "用户" : nameOf(it.agentId);
		if (it.role === "user") lines.push(`【用户】${it.content}${fileNote(it, "附件")}`);
		else if (it.role === "assistant") {
			lines.push(`【${who}】${it.content}${fileNote(it, "发送了文件")}${it.status === "error" ? "（出错）" : ""}`);
		} else if (it.role === "card") lines.push(cardLine(who, it.meta));
		else lines.push(`【系统】${it.content}`);
	}
	let omitted = 0;
	let total = lines.reduce((n, l) => n + l.length + 1, 0);
	while (lines.length > 1 && total > budgetChars) {
		total -= lines.shift()!.length + 1;
		omitted++;
	}
	if (lines.length === 1 && lines[0].length > budgetChars) lines[0] = `${lines[0].slice(0, budgetChars)}…（已截断）`;
	return { text: (omitted ? `（更早的 ${omitted} 条群消息已省略）\n` : "") + lines.join("\n"), lastSeq, omitted, files };
}

/**
 * 项目进行中某位成员说完：它 @ 到的其他成员各叫醒一次（peer），@ 管理者则改为唤醒管理者看看板。
 * 平时（没有进行中的项目）成员 @ 别人一律不触发，保持原来的规则。
 */
export function planPeerTurns(o: { fromAgentId: string; text: string; members: MemberRef[]; managerId: string | null; projectActive: boolean }): { turns: PlannedTurn[]; wakeManager: boolean } {
	if (!o.projectActive || o.fromAgentId === o.managerId) return { turns: [], wakeManager: false };
	const { ids } = parseMentions(o.text, o.members.filter((m) => m.id !== o.fromAgentId));
	const peers = ids.filter((id) => id !== o.managerId && id !== o.fromAgentId);
	return { turns: peers.map((agentId) => ({ agentId, reason: "peer" as const, depth: 0, task: o.text.slice(0, 2000), from: o.fromAgentId })), wakeManager: !!o.managerId && ids.includes(o.managerId) };
}

export type WakeReason = { text: string; projectId?: string };
/** 叫醒管理者时排着的原因里，去掉属于已结束项目的（项目已交付，「阶段完成 / 全部完成」之类的提醒就过时了）。 */
export function freshWakeReasons(list: WakeReason[], projectActive: (projectId: string) => boolean): string[] {
	return list.filter((x) => !x.projectId || projectActive(x.projectId)).map((x) => x.text);
}
