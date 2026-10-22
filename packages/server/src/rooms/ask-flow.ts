/**
 * 成员之间可追踪的提问的流程（决策 0019 第 4 步，docs/design/group-team.md 第 5 节）：
 * 发问 / 追问 / 回答 / 上游有问题 / 交给管理者 / 超时检查。群文字里的 @ 保留不动，这里是可追踪的那一种：
 * 问题和回答都发在群里（全部可见），回答直接送回提问者手上，来回有上限、没人答有超时。
 */
import { db, now } from "../db.ts";
import { deleteMessage, insertMessage } from "../messages.ts";
import { getAgent } from "../runtime.ts";
import { findByName, itemRow, parseDepends, type WorkItemRow, resolveRefs, resumeWithNote, steerToLiveRun } from "../work-items.ts";
import { ASK_TIMEOUT_MS, askIntro, askStep, threadSummary } from "./ask-logic.ts";
import { type AskRow, createAsk, getAsk, threadOf, unansweredAsks, updateAsk } from "./asks.ts";
import { wakeManager } from "./collab.ts";
import { activeProjects } from "./projects.ts";
import { scheduleTurns } from "./scheduler.ts";
import { activeIds, getRoom, memberConversation, memberRefs, sys } from "./store.ts";

const nameOf = (id: string) => getAgent(id)?.name ?? "成员";
const clip = (s: string, n: number) => s.trim().slice(0, n);
type R = { ok: true; ask: AskRow; text: string } | { ok: false; error: string };

/** 以某位成员的身份往群里发一条消息（提问 / 回答），和它平时在群里说话一样可见。 */
function post(roomId: string, agentId: string, content: string, meta: Record<string, unknown>) {
	const projectId = typeof meta.askId === "string" ? getAsk(meta.askId)?.project_id : null; // 标明属于哪个项目（界面按项目筛选）
	insertMessage({ agentId, conversationId: memberConversation(roomId, agentId), roomId, role: "assistant", content, meta: { ...meta, ...(projectId ? { projectId } : {}) } });
}

/** 送到被问的人手上：它有正在跑的任务执行 → 插话递进去不打断；管理者 → 唤醒；否则排一个 peer 回合叫醒它。 */
function deliver(ask: AskRow, intro: string) {
	const r = getRoom(ask.room_id);
	if (!r) return;
	if (steerToLiveRun(ask.room_id, ask.to_agent, `（群聊里的提问）${intro}`)) return;
	if (ask.to_agent === r.manager_id) wakeManager(ask.room_id, intro);
	else if (activeIds(ask.room_id).includes(ask.to_agent)) scheduleTurns(ask.room_id, [{ agentId: ask.to_agent, reason: "peer", depth: 0, task: intro, from: ask.from_agent }]);
}

/** 交给管理者：状态改 escalated、群里一条系统通知、唤醒管理者并带上对话摘要。 */
export function escalateAsk(ask: AskRow, headline: string) {
	const cur = updateAsk(ask.id, { status: "escalated" }) ?? ask;
	sys(cur.room_id, `${headline}，已交给管理者`, { kind: "peer-ask-escalated", askId: cur.id, ...(cur.project_id ? { projectId: cur.project_id } : {}) });
	wakeManager(cur.room_id, `${headline}。提问编号 ${cur.id}（${nameOf(cur.from_agent)} 问 ${nameOf(cur.to_agent)}），对话：${threadSummary(threadOf(cur), nameOf)}。影响方案的你拍板（必要时问用户），其余直接用 answer_colleague（askId 填 ${cur.id}）代答或安排；回答会送回提问者手上`);
}
const topicOf = (a: AskRow) => clip(threadOf(a)[0]?.text.replace(/\s+/g, " ") ?? "", 30);

function projectOf(roomId: string, fromItem: string | null) {
	const mine = fromItem ? itemRow(fromItem)?.project_id : null;
	if (mine) return mine;
	const ps = activeProjects(roomId);
	return ps.length === 1 ? ps[0].id : null;
}

/** 给成员发起一个新提问。 */
export function startAsk(o: { roomId: string; from: string; toName: string; text: string; fromItem: string | null }): R {
	const refs = memberRefs(o.roomId);
	const to = findByName(refs, o.toName);
	if (!to) return { ok: false, error: `找不到成员「${o.toName}」，可用成员：${refs.filter((m) => m.id !== o.from).map((m) => m.name).join("、")}` };
	if (to.id === o.from) return { ok: false, error: "不能问自己" };
	const text = clip(o.text, 2000);
	if (!text) return { ok: false, error: "写清楚要问什么" };
	const ask = createAsk({ roomId: o.roomId, projectId: projectOf(o.roomId, o.fromItem), from: o.from, to: to.id, fromItem: o.fromItem, kind: "question", targetItem: null, text });
	post(o.roomId, o.from, `@${to.name} ${text}`, { kind: "peer-ask", askId: ask.id, to: to.id, toName: to.name, from: o.from, rounds: 1 });
	deliver(ask, askIntro({ id: ask.id, kind: "question", fromName: nameOf(o.from), text: clip(text, 1500), rounds: 1, toIsManager: to.id === getRoom(o.roomId)?.manager_id }));
	return { ok: true, ask, text: `已经问了 ${to.name}（提问编号 ${ask.id}），回答会直接送到你这里；不用干等，先做不依赖这个答案的部分。` };
}

/** 追问（同一段对话）：已经来回到上限就不再递给对方，交给管理者。 */
export function followUp(o: { roomId: string; from: string; askId: string; text: string }): R {
	const ask = getAsk(o.askId);
	if (!ask || ask.room_id !== o.roomId || ask.from_agent !== o.from) return { ok: false, error: "找不到这条提问，或不是你问的" };
	const text = clip(o.text, 2000);
	if (!text) return { ok: false, error: "写清楚要追问什么" };
	if (ask.status === "open") return { ok: false, error: `${nameOf(ask.to_agent)} 还没回答，先做别的；回答会直接送到你这里` };
	if (ask.status === "escalated" || ask.status === "closed") return { ok: false, error: ask.status === "escalated" ? "这条提问已经交给管理者，等管理者安排" : "这条提问已经结束" };
	const toName = nameOf(ask.to_agent);
	const rounds = ask.rounds + 1;
	const step = askStep({ rounds: ask.rounds, status: ask.status, now: now(), updatedAt: ask.updated_at, timeoutMs: ASK_TIMEOUT_MS() });
	const next = updateAsk(ask.id, { add: { by: o.from, text, at: now() }, ...(step === "ok" ? { status: "open" as const } : {}) })!;
	post(o.roomId, o.from, `@${toName} ${text}`, { kind: "peer-ask", askId: ask.id, to: ask.to_agent, toName, from: o.from, rounds });
	if (step !== "ok") {
		escalateAsk(next, `${nameOf(o.from)} 和 ${toName} 关于「${topicOf(next)}」来回 ${ask.rounds} 轮还没解决`);
		return { ok: true, ask: next, text: "已经交给管理者，先做别的或等管理者安排；回答会直接送到你这里。" };
	}
	deliver(next, askIntro({ id: ask.id, kind: ask.kind, fromName: nameOf(o.from), text: clip(text, 1500), rounds, targetItem: ask.target_item ? { id: ask.target_item, title: itemRow(ask.target_item)?.title ?? "" } : null, toIsManager: ask.to_agent === getRoom(o.roomId)?.manager_id }));
	return { ok: true, ask: next, text: `已经追问了 ${toName}，回答会直接送到你这里；先做不依赖这个答案的部分。` };
}

/** 回答：被问的人本人，或（交给管理者之后）管理者代答。回答送回提问者手上。post=false 表示这段话已经在群里发过了（回合文字兜底）。 */
export function answerAsk(o: { roomId: string; by: string; askId: string; text: string; post?: boolean }): R {
	const ask = getAsk(o.askId);
	if (!ask || ask.room_id !== o.roomId) return { ok: false, error: "找不到这条提问" };
	const manager = getRoom(o.roomId)?.manager_id === o.by;
	if (ask.to_agent !== o.by && !(manager && ask.status === "escalated")) return { ok: false, error: "只有被问的人本人（或交给管理者之后的管理者）能回答这条提问" };
	if (ask.status === "answered" || ask.status === "closed") return { ok: false, error: "这条提问已经回答过了" };
	const text = clip(o.text, 4000);
	if (!text) return { ok: false, error: "写清楚回答" };
	const rounds = ask.rounds + 1;
	const next = updateAsk(ask.id, { status: "answered", rounds, add: { by: o.by, text, at: now() } })!;
	if (o.post !== false) post(o.roomId, o.by, text, { kind: "peer-answer", askId: ask.id, rounds, ...(o.by !== ask.to_agent ? { onBehalfOf: ask.to_agent } : {}) });
	const question = clip(threadOf(ask).filter((e) => e.by === ask.from_agent).pop()?.text ?? "", 200);
	const msg = `${nameOf(o.by)} 回答了你的提问「${question}」（提问编号 ${ask.id}）：${clip(text, 3000)}`;
	if (steerToLiveRun(o.roomId, ask.from_agent, msg)) return { ok: true, ask: next, text: "已回答，已经送到对方手上。" };
	if (ask.from_item && resumeWithNote(ask.from_item, ask.from_agent, `${msg}\n你之前问了这个问题，现在有答案了，接着按答案把任务做完并提交。`)) return { ok: true, ask: next, text: "已回答，对方当时没在执行，已经让它带着回答重新开始。" };
	return { ok: true, ask: next, text: "已回答，已发在群里。" };
}

/**
 * 提问回合里成员已经用工具回答 / 重做过（answer_colleague、work_rework 都会把回答发在群里）：回合结尾那句短话（「已回答。」「已重开任务」）不再留在群里。
 * 只在这一回合里真的回答过时才删；回合文字当回答的兜底（answerAsk post=false）不走这里，最后一条不是普通回复（卡片 / 提问回答）也不动。
 */
export function dropAnsweredTail(o: { roomId: string; agentId: string; turnId: string; askId: string }): boolean {
	const ask = getAsk(o.askId);
	const last = ask ? threadOf(ask).at(-1) : undefined;
	const startedAt = (db.prepare("SELECT started_at FROM room_turns WHERE id = ?").get(o.turnId) as { started_at: number | null } | undefined)?.started_at ?? 0;
	if (!ask || ask.status !== "answered" || !last || last.by !== o.agentId || last.at < startedAt) return false;
	const tail = db.prepare("SELECT id, meta FROM messages WHERE room_id = ? AND agent_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1").get(o.roomId, o.agentId) as { id: string; meta: string } | undefined;
	if (!tail || JSON.parse(tail.meta).kind) return false;
	deleteMessage(tail.id);
	return true;
}

/** 群会话里的成员没带自己的任务编号时：它负责的、依赖这个前置任务的、还没结束的那个任务。 */
const ownedDownstream = (roomId: string, agentId: string, upstreamId: string) =>
	(db.prepare("SELECT * FROM work_items WHERE room_id = ? AND owner_agent_id = ? AND status NOT IN ('done','cancelled') AND depends_on LIKE ? ORDER BY created_at DESC").all(roomId, agentId, `%"${upstreamId}"%`) as unknown as WorkItemRow[]).find((r) => parseDepends(r.depends_on).includes(upstreamId));

/** 下游发现前置任务的成果有问题：建一条 upstream 提问发给上游负责人（群里可见）。 */
export function reportUpstream(o: { roomId: string; from: string; ownItem: string | null; upstream: string; issue: string }): R {
	const issue = clip(o.issue, 2000);
	if (!issue) return { ok: false, error: "写清楚哪里不对、为什么" };
	const resolved = resolveRefs(o.roomId, [o.upstream]);
	const up = resolved.ids[0] ? itemRow(resolved.ids[0]) : undefined;
	if (!up) return { ok: false, error: `找不到任务「${o.upstream}」` };
	const own = o.ownItem ? itemRow(o.ownItem) : undefined;
	const mine = own ?? ownedDownstream(o.roomId, o.from, up.id);
	if (!mine || mine.owner_agent_id !== o.from || !parseDepends(mine.depends_on).includes(up.id)) return { ok: false, error: `只能针对你自己任务的前置任务提：「${up.title}」不是你负责的任务的前置任务` };
	if (!up.owner_agent_id || up.owner_agent_id === o.from || !activeIds(o.roomId).includes(up.owner_agent_id)) return { ok: false, error: "这个前置任务的负责人现在不可用，请改用 ask_colleague 问管理者" };
	const ask = createAsk({ roomId: o.roomId, projectId: projectOf(o.roomId, mine.id), from: o.from, to: up.owner_agent_id, fromItem: mine.id, kind: "upstream", targetItem: up.id, text: issue });
	const toName = nameOf(up.owner_agent_id);
	post(o.roomId, o.from, `@${toName} 「${up.title}」的成果有问题：${issue}`, { kind: "peer-ask", askId: ask.id, to: up.owner_agent_id, toName, from: o.from, rounds: 1, upstream: up.id });
	deliver(ask, askIntro({ id: ask.id, kind: "upstream", fromName: nameOf(o.from), text: clip(issue, 1500), rounds: 1, targetItem: { id: up.id, title: up.title }, toIsManager: false }));
	return { ok: true, ask, text: `已经告诉 ${toName}（提问编号 ${ask.id}）。他确认有问题会重做，改好重新核验通过后新版本会自动送到你这里；先做不依赖这个成果的部分，不要自己去改它。` };
}

/** 定时检查：没人回答超时的提问交给管理者（挂在 collab.runRoomChecks 里，不另起计时器）。 */
export function checkAskTimeouts(at = now()) {
	for (const ask of unansweredAsks()) {
		if (askStep({ rounds: ask.rounds, status: ask.status, now: at, updatedAt: ask.updated_at, timeoutMs: ASK_TIMEOUT_MS() }) !== "timeout") continue;
		const mins = Math.max(1, Math.round(ASK_TIMEOUT_MS() / 60_000));
		escalateAsk(ask, `${nameOf(ask.from_agent)} 问 ${nameOf(ask.to_agent)} 的问题「${topicOf(ask)}」${mins} 分钟没回`);
	}
}
