/**
 * 群聊协作（docs/design/group-collaboration.md）：
 *  - 项目进行中（群里有用户确认过方案的 active 项目，见 projects.ts、docs/design/group-team.md）：成员可以 @ 彼此（被 @ 的成员醒来回复，回复会送进提问者正在跑的任务会话）。
 *  - 管理者只在关键事件被唤醒（任务提交 / 卡住 / 用户消息或 @ / 定时检查 / 卡住检测），醒来只读看板摘要 + 少量新消息。
 *  - 项目进行中管理者回合结束后手上没活、项目没结束 → 兜底再叫醒它一次（idleWake；两次之间没有新进展就不再叫，提示用户）。
 *  - 防护只做检测：只聊不干活 → 先管理者、再用户；卡住与反复卡住在 work-items/watch.ts。不设固定次数 / 费用上限。
 * 任务 → 群的接口（RoomPort）在这里注册。
 */
import { db, now } from "../db.ts";
import { notify } from "../push.ts";
import { getAgent } from "../runtime.ts";
import { boardDigest, itemsOfProject, setRoomPort, steerToLiveRun } from "../work-items.ts";
import { boardDigestOrUnchanged, boardSig as projectBoardSig, freshWakeReasons, PROJECT_IDLE_WAKE, idleWakeStep, planPeerTurns, type WakeReason } from "./logic.ts";
import { askIdOf } from "./ask-logic.ts";
import { answerAsk, checkAskTimeouts, dropAnsweredTail } from "./ask-flow.ts";
import { getAsk } from "./asks.ts";
import { planText } from "./plan.ts";
import { activeProjects, checkProjectStall, getProject, hasActiveProject, projectView } from "./projects.ts";
import { projectProgress, renderProgress } from "./progress.ts";
import { holdForCheckpoint, releaseAfterManagerTurn } from "./hold.ts";
import { stageMaybeDone } from "./stages.ts";
import { chatterStep } from "../stuck.ts";
import { hasQueuedTurns, postUserMessage, queuedFor, scheduleTurns, setTurnHooks } from "./scheduler.ts";
import { activeIds, getRoom, memberConversation, memberRefs, rosterText, stoppedFlag, sys } from "./store.ts";

const CHATTER = () => Number(process.env.PIA_ROOM_CHATTER) || 6;
export const CHECK_MS = () => Number(process.env.PIA_WORK_CHECK_MS) || 30 * 60_000;
/** 唤醒原因带上所属项目：项目先结束了，排着的原因就作废（免得交付后管理者又被「阶段完成」叫醒、再收尾一遍）。 */
const wakeReasons = new Map<string, WakeReason[]>();
const lastWake = new Map<string, number>();
const chatter = new Map<string, { streak: number; blocked: boolean }>();
/** 项目进行中的兜底唤醒：上一次兜底时的看板指纹；同指纹再来就不再叫醒（提示过用户后 hinted） */
const idle = new Map<string, { sig: string; hinted: boolean }>();
const nameOf = (id: string | null | undefined) => getAgent(id ?? "")?.name ?? "成员";
const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

/**
 * 项目开始（用户确认方案 / 管理者在用户同意后开始）：清掉空聊计数。
 * 用户确认时会唤醒管理者，这次算第一次兜底；管理者自己开始时没有额外唤醒，它这一轮没派出活的话兜底还能叫它一次。
 */
export function projectStarted(roomId: string, byManager: boolean) {
	chatter.delete(roomId);
	if (byManager) idle.delete(roomId);
	else idle.set(roomId, { sig: boardSig(roomId, true), hinted: false }); // 这一刻项目刚确认 active
}
/** 项目结束（完成 / 停下）：群里没有进行中的项目了就清掉兜底和空聊状态。 */
export function projectEnded(roomId: string) {
	if (hasActiveProject(roomId)) return;
	chatter.delete(roomId);
	idle.delete(roomId);
}

/**
 * 唤醒管理者看板：只有群被用户按了「停止」、或管理者不在群里时不唤醒（看板仍可见，用户发话后恢复）。
 * 「本轮已暂停」（发言次数到上限、服务重启）不挡：check 回合不占每轮上限，暂停时存下的待发言队列也不会被放出来（仍等用户点继续）。
 * 同一个群还没轮到的唤醒合并成一次，原因一起交给它。
 */
export function wakeManager(roomId: string, reason: string, workItemId?: string, projectId?: string) {
	const r = getRoom(roomId);
	if (!r?.manager_id || stoppedFlag(r) || !activeIds(roomId).includes(r.manager_id)) return false;
	const list = wakeReasons.get(roomId) ?? [];
	const why = clip(reason, 800);
	const pid = projectId ?? (workItemId ? (db.prepare("SELECT project_id FROM work_items WHERE id = ?").get(workItemId) as { project_id: string | null } | undefined)?.project_id : null) ?? undefined;
	if (why && !list.some((x) => x.text === why)) list.push({ text: why, projectId: pid });
	wakeReasons.set(roomId, list.slice(-12));
	lastWake.set(roomId, now());
	if (queuedFor(roomId, "check", r.manager_id)) return true;
	return scheduleTurns(roomId, [{ agentId: r.manager_id, reason: "check", depth: 0 }]);
}

/** 降成本：每个群上次发给管理者的看板摘要（内存即可，重启后第一次照常全量）。 */
const lastBoardDigest = new Map<string, string>();

/** 项目连续没进展到 3 次要求改计划（§6「项目级进度检查」）；每个 active 项目在每次被叫醒时查一次。 */
const REPLAN_HINT = "这个项目连续几次没有进展。先用一两句话写清为什么卡住，再选一种改法：带着改进意见重做、换更对口的成员、把任务拆小、换一种做法，或者改方案（影响目标 / 范围 / 交付物时要用 room_plan 改方案请用户重新确认）。用 room_project_replan 记下来。";
const EXHAUSTED_HINT = "这个项目反复卡住，换过的办法都没能解决，已经向用户报告了。请你在群里直接跟用户说清楚卡在哪、需要用户帮什么。";

function checkContext(roomId: string) {
	const queued = wakeReasons.get(roomId) ?? [];
	wakeReasons.delete(roomId);
	const projects = activeProjects(roomId);
	const reasons = freshWakeReasons(queued, (id) => getProject(id)?.status === "active");
	if (queued.length && !reasons.length && !projects.length) return null; // 原因全属于已结束的项目：这次不用醒
	const digest = boardDigest(roomId, 20, (id) => getProject(id)?.title);
	const boardLine = boardDigestOrUnchanged(digest, lastBoardDigest.get(roomId) ?? null);
	lastBoardDigest.set(roomId, digest);
	const stallHints: string[] = [];
	const projectsBlock = projects.length
		? `进行中的项目：\n${projects
				.map((p) => {
					const progress = projectProgress(projectView(p).plan, itemsOfProject(p.id));
					const stall = checkProjectStall(p);
					if (stall === "replan") stallHints.push(`「${p.title}」：${REPLAN_HINT}`);
					else if (stall === "exhausted") stallHints.push(`「${p.title}」：${EXHAUSTED_HINT}`);
					return `${planText(projectView(p))}\n${renderProgress(progress)}`;
				})
				.join("\n\n")}\n对照进度清单想清楚：做完了没有、是不是在原地打转、有没有进展、下一步谁做、交代他什么。`
		: "";
	return [
		projectsBlock,
		...(stallHints.length ? [stallHints.join("\n")] : []),
		reasons.length ? `唤醒原因：\n${reasons.map((x) => `- ${x}`).join("\n")}` : "唤醒原因：定时检查",
		boardLine,
	].filter(Boolean).join("\n");
}

/** 项目进行中成员 @ 了别人：叫醒被 @ 的成员（正在跑任务的直接把话送进它的任务会话），@ 管理者则唤醒管理者。 */
function peerMentions(roomId: string, fromAgentId: string, text: string, exclude: string[] = []) {
	const r = getRoom(roomId);
	if (!r || stoppedFlag(r)) return;
	const plan = planPeerTurns({ fromAgentId, text, members: memberRefs(roomId), managerId: r.manager_id, projectActive: hasActiveProject(roomId) });
	if (plan.wakeManager) wakeManager(roomId, `${nameOf(fromAgentId)} @ 了你：${text.slice(0, 200)}`);
	if (chatter.get(roomId)?.blocked) return; // 空聊已经上报给用户：先不再互相叫醒
	const act = activeIds(roomId);
	const turns = plan.turns.filter((t) => act.includes(t.agentId) && !exclude.includes(t.agentId) && !steerToLiveRun(roomId, t.agentId, `（${nameOf(fromAgentId)} 在群里 @ 你）${text.slice(0, 2000)}`));
	scheduleTurns(roomId, turns);
}

/** 只聊不干活：peer 回合累加，任务有进展 / 用户发话清零。 */
function notePeerTurn(roomId: string) {
	const c = chatter.get(roomId) ?? { streak: 0, blocked: false };
	const step = chatterStep(c.streak, { progressed: false, threshold: CHATTER() });
	c.streak = step.streak;
	chatter.set(roomId, c);
	if (step.level === "manager") wakeManager(roomId, `成员之间已经来回聊了 ${step.streak} 次，看板上没有新进展，看看是不是只聊不干活`);
	if (step.level === "user") {
		c.blocked = true;
		const r = getRoom(roomId);
		sys(roomId, `成员之间来回聊了 ${step.streak} 次仍没有实际进展，已先暂停成员互相叫醒。告诉管理者下一步怎么做，或者停下这个项目。`, { kind: "room-chatter" });
		notify({ title: `${r?.name ?? "群聊"}：需要你看一下`, body: "成员之间来回聊了很久没有实际进展", tag: `chatter-${roomId}`, url: `/?room=${roomId}` });
	}
}
const resetChatter = (roomId: string) => void chatter.set(roomId, { streak: 0, blocked: false });

/**
 * 看板指纹：每个任务的状态，项目进行中不再把「已完成的普通派活次数」算进去（纯逻辑见 logic.ts 的 boardSig：
 * 管理者反复用 room_assign 派同样的活不建 work_item 时，不能让指纹一直在变、兜底永远觉得有进展而无限叫醒）。
 * 两次兜底之间指纹没变 = 没有新进展。
 */
function boardSig(roomId: string, projectActive: boolean) {
	const items = db.prepare("SELECT id, status FROM work_items WHERE room_id = ? ORDER BY id").all(roomId) as { id: string; status: string }[];
	const plainAssignsDone = (db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ? AND reason = 'assign' AND status = 'done'").get(roomId) as { n: number }).n;
	return projectBoardSig({ items, plainAssignsDone, projectActive });
}
const hasInFlight = (roomId: string) => !!db.prepare("SELECT 1 FROM work_items WHERE room_id = ? AND status IN ('active','blocked','review') LIMIT 1").get(roomId);

/** 管理者回合正常结束后：有进行中的项目、手上没有在做的任务、队列也空 → 再叫醒它规划下一步；没有新进展就只提示用户一次。 */
function idleWake(roomId: string) {
	const r = getRoom(roomId);
	if (!r?.manager_id || stoppedFlag(r)) return;
	const st = idle.get(roomId);
	const projectActive = hasActiveProject(roomId);
	const sig = boardSig(roomId, projectActive);
	const step = idleWakeStep({ projectActive, inFlight: hasInFlight(roomId), queued: hasQueuedTurns(roomId), lastSig: st?.sig ?? null, sig, hinted: !!st?.hinted });
	if (step === "wake") {
		idle.set(roomId, { sig, hinted: false });
		wakeManager(roomId, PROJECT_IDLE_WAKE);
	} else if (step === "hint") {
		idle.set(roomId, { sig, hinted: true });
		sys(roomId, "管理者被叫醒后，看板上还是没有新任务或新进展，已先停止自动叫醒。请看一下项目是不是已经完成，或告诉管理者下一步怎么做。", { kind: "room-idle" });
		notify({ title: `${r.name}：需要你看一下`, body: "项目进行中管理者没有新的安排，看板没有进展", tag: `idle-${roomId}`, url: `/?room=${roomId}` });
	}
}

setTurnHooks({
	after(roomId, t, res) {
		const r = getRoom(roomId);
		if (!r) return;
		const askId = t.reason === "peer" ? askIdOf(t.task) : null;
		if (askId) {
			// 可追踪的提问：被问的人没调 answer_colleague、只在回合里说了话 → 这段话就是回答（已经发在群里，不再重复发），照样送回提问者
			if (res.text && getAsk(askId)?.status === "open") answerAsk({ roomId, by: t.agentId, askId, text: res.text, post: false });
			else if (res.text) dropAnsweredTail({ roomId, agentId: t.agentId, turnId: t.turnId, askId }); // 这一回合已经用工具回答 / 重做过：结尾那句短话不再发群
		} else if (t.reason === "peer") {
			notePeerTurn(roomId);
			if (t.from && res.text) steerToLiveRun(roomId, t.from, `（${nameOf(t.agentId)} 在群里回复你）${res.text.slice(0, 4000)}`);
		}
		if (t.agentId === r.manager_id) idleWake(roomId);
		if (t.agentId !== r.manager_id && res.text) peerMentions(roomId, t.agentId, res.text, t.reason === "peer" && t.from ? [t.from].filter((id) => steeredLive(roomId, id)) : []);
	},
	ended: (roomId, t) => releaseAfterManagerTurn(roomId, t.agentId),
	checkContext,
	onUserMessage(roomId) {
		resetChatter(roomId);
		idle.delete(roomId);
	},
});
/** 提问者有正在跑的任务会话：回复已经送进去了，不再额外叫醒它在群里回话。 */
const steeredLive = (roomId: string, agentId: string) => !!db.prepare("SELECT 1 FROM work_item_runs r JOIN work_items w ON w.id = r.work_item_id WHERE w.room_id = ? AND r.owner_agent_id = ? AND r.status = 'running' LIMIT 1").get(roomId, agentId);

/** 定时检查：有未完成任务、或有进行中项目的群，太久没有唤醒过管理者就叫它看一眼看板（测试可直接调用）。 */
export function runRoomChecks(at = now(), every = CHECK_MS()) {
	checkAskTimeouts(at); // 提问没人回答超时 → 交给管理者（不另起计时器）
	const rows = db.prepare("SELECT DISTINCT room_id FROM work_items WHERE room_id IS NOT NULL AND status IN ('active','blocked','review') UNION SELECT room_id FROM room_projects WHERE status = 'active'").all() as { room_id: string }[];
	let n = 0;
	for (const { room_id } of rows) {
		if (at - (lastWake.get(room_id) ?? 0) < every) continue;
		const projectActive = hasActiveProject(room_id);
		const idleAuto = projectActive && !hasInFlight(room_id);
		// 兜底已经停了、在等用户看一下，且看板此后没动过：定时检查也不叫醒空转（用户发话或看板有变化后恢复）
		const st = idle.get(room_id);
		if (idleAuto && st?.hinted && st.sig === boardSig(room_id, projectActive)) continue;
		if (wakeManager(room_id, idleAuto ? `定时检查：${PROJECT_IDLE_WAKE}` : "定时检查：看看任务进展")) n++;
	}
	return n;
}
let timer: ReturnType<typeof setInterval> | null = null;
export function startRoomChecks() {
	if (timer) return;
	const t0 = now();
	for (const { room_id } of db.prepare("SELECT id AS room_id FROM rooms").all() as { room_id: string }[]) if (!lastWake.has(room_id)) lastWake.set(room_id, t0);
	timer = setInterval(() => runRoomChecks(), Math.min(CHECK_MS(), 5 * 60_000));
	timer.unref?.();
}

// 任务 → 群的接口（钩子②）
setRoomPort({
	postUserMessage,
	wakeManager,
	noteProgress: resetChatter,
	peerMentions: (roomId, from, text) => peerMentions(roomId, from, text),
	activeProjects: (roomId) => activeProjects(roomId).map((p) => ({ id: p.id, title: p.title })),
	projectStages: (projectId) => {
		const p = getProject(projectId);
		const names = p ? projectView(p).plan.stages.map((s) => s.name).filter(Boolean) : [];
		return names.length ? names : null;
	},
	roster: rosterText,
	stageMaybeDone,
	holdForCheckpoint,
	managerConversation(roomId) {
		const r = getRoom(roomId);
		if (!r?.manager_id || !activeIds(roomId).includes(r.manager_id)) return null;
		return { agentId: r.manager_id, conversationId: memberConversation(roomId, r.manager_id) };
	},
});
