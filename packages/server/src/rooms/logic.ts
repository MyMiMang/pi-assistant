/**
 * 助理群聊的纯逻辑（不碰数据库/模型，便于单测）：
 *  - @ 解析（中文名、无空格、重名、@所有人）
 *  - 发言规则（用户 @ 谁谁说；没 @ = 只有管理者说；普通成员 @ 别人不触发）
 *  - 每轮上限（总发言数、管理者派活深度、每人次数、token 预算）
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
	/** 每轮 token 预算（输入+输出），0 = 不限 */
	tokenBudget: number;
	/** 成员做完后管理者再总结一次 */
	followup: boolean;
}
export const DEFAULT_CAPS: RoomCaps = { maxTurns: 8, maxDepth: 3, perAgent: 2, tokenBudget: 400_000, followup: true };
export function normalizeCaps(c: Partial<RoomCaps> | null | undefined): RoomCaps {
	const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
	return {
		maxTurns: n(c?.maxTurns, 1, 30, DEFAULT_CAPS.maxTurns),
		maxDepth: n(c?.maxDepth, 0, 10, DEFAULT_CAPS.maxDepth),
		perAgent: n(c?.perAgent, 1, 10, DEFAULT_CAPS.perAgent),
		tokenBudget: n(c?.tokenBudget, 0, 10_000_000, DEFAULT_CAPS.tokenBudget),
		followup: typeof c?.followup === "boolean" ? c.followup : DEFAULT_CAPS.followup,
	};
}

export type TurnReason = "mention" | "manager" | "assign" | "followup" | "resume";
export interface PlannedTurn {
	agentId: string;
	reason: TurnReason;
	/** 管理者派活时写的任务说明 */
	task?: string;
	/** 派活深度（用户触发 = 0） */
	depth: number;
	/** 用户引用定向的一轮：只回应引用，默认不自动扩派（见 docs/design/message-replies.md §5） */
	directed?: boolean;
	/** 这一轮要执行的长期任务执行记录（派发时就精确绑定，不在轮到时猜） */
	workItemId?: string;
	workRunId?: string;
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
	o: { managerId: string | null; activeIds: string[]; assignments: { agentId: string; task?: string; workItemId?: string; workRunId?: string }[]; caps: RoomCaps; batchDone: boolean; anyWorkerRan: boolean },
): PlannedTurn[] {
	const isMgr = turn.agentId === o.managerId;
	if (isMgr) {
		const depth = turn.depth + 1;
		if (depth > o.caps.maxDepth) return [];
		const seen = new Set<string>();
		return o.assignments
			.filter((a) => a.agentId !== o.managerId && o.activeIds.includes(a.agentId) && !seen.has(a.agentId) && (seen.add(a.agentId), true))
			.map((a) => ({ agentId: a.agentId, reason: "assign" as const, task: a.task, depth, ...(a.workItemId ? { workItemId: a.workItemId, workRunId: a.workRunId } : {}) }));
	}
	if (turn.reason === "assign" && o.batchDone && o.anyWorkerRan && o.caps.followup && o.managerId && o.activeIds.includes(o.managerId))
		return [{ agentId: o.managerId, reason: "followup", depth: turn.depth }];
	return [];
}

export interface RoundCounters {
	turns: number;
	perAgent: Record<string, number>;
	tokens: number;
}
/** 下一次发言能不能进行；不能时给出原因（写进“本轮已暂停”提示） */
export function capCheck(next: PlannedTurn, c: RoundCounters, caps: RoomCaps): string | null {
	if (c.turns >= caps.maxTurns) return `这一轮已经发言 ${c.turns} 次`;
	if ((c.perAgent[next.agentId] ?? 0) >= caps.perAgent) return "同一个助理这一轮发言次数到上限了";
	if (caps.tokenBudget && c.tokens >= caps.tokenBudget) return `这一轮用掉了约 ${Math.round(c.tokens / 1000)}k tokens`;
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
const cardLine = (who: string, m: Record<string, unknown>) => {
	const st = String(m.status ?? "");
	const stTxt = ({ pending: "等待用户处理", approved: "用户已批准", rejected: "用户已拒绝", answered: "用户已回答", expired: "已过期", done: "已完成", failed: "失败", cancelled: "已取消", running: "进行中", queued: "排队中" } as Record<string, string>)[st] ?? st;
	if (m.kind === "approval") return `[${who} 请求批准] ${String(m.summary ?? m.toolName ?? "")}（${stTxt}）`;
	if (m.kind === "question") return `[${who} 提问] ${String(m.question ?? "")}（${stTxt}${m.answer ? `：${String(m.answer)}` : ""}）`;
	if (m.kind === "task") return `[${who} 的后台任务] ${String(m.title ?? "")}（${stTxt}）`;
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
