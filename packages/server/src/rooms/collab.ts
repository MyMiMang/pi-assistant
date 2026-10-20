/**
 * 群聊协作（docs/design/group-collaboration.md）：
 *  - 自主推进：用户确认目标 + 完成标准后开启；成员可以 @ 彼此（被 @ 的成员醒来回复，回复会送进提问者正在跑的任务会话）。
 *  - 管理者只在关键事件被唤醒（任务提交 / 卡住 / 用户消息或 @ / 定时检查 / 卡住检测），醒来只读看板摘要 + 少量新消息。
 *  - 开着自主推进时管理者回合结束后手上没活、目标没结束 → 兜底再叫醒它一次（idleWake；两次之间没有新进展就不再叫，提示用户）。
 *  - 防护只做检测：只聊不干活 → 先管理者、再用户；卡住与反复卡住在 work-items/watch.ts。不设固定次数 / 费用上限。
 * 任务 → 群的接口（RoomPort）在这里注册。
 */
import { db, now } from "../db.ts";
import { notify } from "../push.ts";
import { getAgent } from "../runtime.ts";
import { boardDigest, setRoomPort, steerToLiveRun } from "../work-items.ts";
import { AUTONOMY_IDLE_WAKE, idleWakeStep, planPeerTurns } from "./logic.ts";
import { chatterStep } from "../stuck.ts";
import { hasQueuedTurns, postUserMessage, queuedFor, scheduleTurns, setTurnHooks } from "./scheduler.ts";
import { activeIds, autonomyOf, changed, getRoom, memberConversation, memberRefs, stoppedFlag, sys, writeAutonomy, type Autonomy } from "./store.ts";

const CHATTER = () => Number(process.env.PIA_ROOM_CHATTER) || 6;
export const CHECK_MS = () => Number(process.env.PIA_WORK_CHECK_MS) || 30 * 60_000;
const wakeReasons = new Map<string, string[]>();
const lastWake = new Map<string, number>();
const chatter = new Map<string, { streak: number; blocked: boolean }>();
/** 自主推进兜底唤醒：上一次兜底时的看板指纹；同指纹再来就不再叫醒（提示过用户后 hinted） */
const idle = new Map<string, { sig: string; hinted: boolean }>();
const nameOf = (id: string | null | undefined) => getAgent(id ?? "")?.name ?? "成员";
const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

export const getAutonomy = (roomId: string) => autonomyOf(getRoom(roomId));

export function setAutonomy(roomId: string, a: { goal?: string; doneCriteria?: string }): Autonomy {
	if (!getRoom(roomId)) throw new Error("群不存在");
	const goal = clip(a.goal, 1000);
	const doneCriteria = clip(a.doneCriteria, 2000);
	if (!goal || !doneCriteria) throw new Error("目标和完成标准都要写清楚");
	const next = { goal, doneCriteria, startedAt: now() };
	writeAutonomy(roomId, next);
	chatter.delete(roomId);
	idle.set(roomId, { sig: boardSig(roomId), hinted: false }); // 开启时的这次唤醒算第一次兜底
	sys(roomId, `已开启自主推进。目标：${goal}；完成标准：${doneCriteria}。成员可以 @ 彼此协作，管理者在任务提交、卡住或定时检查时出来协调；只有需要你拍板的事才会问你。`, { kind: "room-autonomy", on: true });
	changed(roomId);
	wakeManager(roomId, "用户确认了目标和完成标准：按目标拆成具体任务（work_create，写清要求和完成标准）派给合适的成员，开始自主推进");
	return next;
}

/** 结束自主推进。achieved = 管理者宣布目标已达成时的结果总结（room_goal_done），会一起发到群里。 */
export function endAutonomy(roomId: string, o: { achieved?: string } = {}) {
	if (!getAutonomy(roomId)) return false;
	writeAutonomy(roomId, null);
	chatter.delete(roomId);
	idle.delete(roomId);
	const achieved = clip(o.achieved, 2000);
	sys(roomId, achieved ? `目标已达成，已结束自主推进，回到普通模式。结果：${achieved}` : "已结束自主推进，回到普通模式：成员只在被用户或管理者 @ 时发言。已经在做的任务不受影响。", { kind: "room-autonomy", on: false, ...(achieved ? { achieved: true } : {}) });
	changed(roomId);
	return true;
}

/**
 * 唤醒管理者看板：只有群被用户按了「停止」、或管理者不在群里时不唤醒（看板仍可见，用户发话后恢复）。
 * 「本轮已暂停」（发言次数到上限、服务重启）不挡：check 回合不占每轮上限，暂停时存下的待发言队列也不会被放出来（仍等用户点继续）。
 * 同一个群还没轮到的唤醒合并成一次，原因一起交给它。
 */
export function wakeManager(roomId: string, reason: string, _workItemId?: string) {
	const r = getRoom(roomId);
	if (!r?.manager_id || stoppedFlag(r) || !activeIds(roomId).includes(r.manager_id)) return false;
	const list = wakeReasons.get(roomId) ?? [];
	const why = clip(reason, 300);
	if (why && !list.includes(why)) list.push(why);
	wakeReasons.set(roomId, list.slice(-12));
	lastWake.set(roomId, now());
	if (queuedFor(roomId, "check", r.manager_id)) return true;
	return scheduleTurns(roomId, [{ agentId: r.manager_id, reason: "check", depth: 0 }]);
}

function checkContext(roomId: string) {
	const reasons = wakeReasons.get(roomId) ?? [];
	wakeReasons.delete(roomId);
	const a = getAutonomy(roomId);
	return [
		a ? `自主推进目标：${a.goal}\n完成标准：${a.doneCriteria}` : "",
		reasons.length ? `唤醒原因：\n${reasons.map((x) => `- ${x}`).join("\n")}` : "唤醒原因：定时检查",
		boardDigest(roomId),
	].filter(Boolean).join("\n");
}

/** 自主推进中成员 @ 了别人：叫醒被 @ 的成员（正在跑任务的直接把话送进它的任务会话），@ 管理者则唤醒管理者。 */
function peerMentions(roomId: string, fromAgentId: string, text: string, exclude: string[] = []) {
	const r = getRoom(roomId);
	if (!r || stoppedFlag(r)) return;
	const plan = planPeerTurns({ fromAgentId, text, members: memberRefs(roomId), managerId: r.manager_id, autonomous: !!autonomyOf(r) });
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
		sys(roomId, `成员之间来回聊了 ${step.streak} 次仍没有实际进展，已先暂停成员互相叫醒。告诉管理者下一步怎么做，或者结束自主推进。`, { kind: "room-chatter" });
		notify({ title: `${r?.name ?? "群聊"}：需要你看一下`, body: "成员之间来回聊了很久没有实际进展", tag: `chatter-${roomId}`, url: `/?room=${roomId}` });
	}
}
const resetChatter = (roomId: string) => void chatter.set(roomId, { streak: 0, blocked: false });

/** 看板指纹：每个任务的状态 + 已完成的普通派活次数。两次兜底之间指纹没变 = 没有新进展。 */
function boardSig(roomId: string) {
	const items = db.prepare("SELECT id, status FROM work_items WHERE room_id = ? ORDER BY id").all(roomId) as { id: string; status: string }[];
	const plain = db.prepare("SELECT COUNT(*) AS n FROM room_turns WHERE room_id = ? AND reason = 'assign' AND status = 'done'").get(roomId) as { n: number };
	return `${items.map((x) => `${x.id}:${x.status}`).join(",")}|${plain.n}`;
}
const hasInFlight = (roomId: string) => !!db.prepare("SELECT 1 FROM work_items WHERE room_id = ? AND status IN ('active','blocked','review') LIMIT 1").get(roomId);

/** 管理者回合正常结束后：自主推进还开着、手上没有在做的任务、队列也空 → 再叫醒它规划下一步；没有新进展就只提示用户一次。 */
function idleWake(roomId: string) {
	const r = getRoom(roomId);
	if (!r?.manager_id || stoppedFlag(r)) return;
	const st = idle.get(roomId);
	const sig = boardSig(roomId);
	const step = idleWakeStep({ autonomous: !!autonomyOf(r), inFlight: hasInFlight(roomId), queued: hasQueuedTurns(roomId), lastSig: st?.sig ?? null, sig, hinted: !!st?.hinted });
	if (step === "wake") {
		idle.set(roomId, { sig, hinted: false });
		wakeManager(roomId, AUTONOMY_IDLE_WAKE);
	} else if (step === "hint") {
		idle.set(roomId, { sig, hinted: true });
		sys(roomId, "管理者被叫醒后，看板上还是没有新任务或新进展，已先停止自动叫醒。请看一下目标是不是已经达成，或告诉管理者下一步怎么做。", { kind: "room-idle" });
		notify({ title: `${r.name}：需要你看一下`, body: "自主推进中管理者没有新的安排，看板没有进展", tag: `idle-${roomId}`, url: `/?room=${roomId}` });
	}
}

setTurnHooks({
	after(roomId, t, res) {
		const r = getRoom(roomId);
		if (!r) return;
		if (t.reason === "peer") {
			notePeerTurn(roomId);
			if (t.from && res.text) steerToLiveRun(roomId, t.from, `（${nameOf(t.agentId)} 在群里回复你）${res.text.slice(0, 4000)}`);
		}
		if (t.agentId === r.manager_id) idleWake(roomId);
		if (t.agentId !== r.manager_id && res.text) peerMentions(roomId, t.agentId, res.text, t.reason === "peer" && t.from ? [t.from].filter((id) => steeredLive(roomId, id)) : []);
	},
	checkContext,
	onUserMessage(roomId) {
		resetChatter(roomId);
		idle.delete(roomId);
	},
});
/** 提问者有正在跑的任务会话：回复已经送进去了，不再额外叫醒它在群里回话。 */
const steeredLive = (roomId: string, agentId: string) => !!db.prepare("SELECT 1 FROM work_item_runs r JOIN work_items w ON w.id = r.work_item_id WHERE w.room_id = ? AND r.owner_agent_id = ? AND r.status = 'running' LIMIT 1").get(roomId, agentId);

/** 定时检查：有未完成任务、或开着自主推进的群，太久没有唤醒过管理者就叫它看一眼看板（测试可直接调用）。 */
export function runRoomChecks(at = now(), every = CHECK_MS()) {
	const rows = db.prepare("SELECT DISTINCT room_id FROM work_items WHERE room_id IS NOT NULL AND status IN ('active','blocked','review') UNION SELECT id AS room_id FROM rooms WHERE autonomy IS NOT NULL").all() as { room_id: string }[];
	let n = 0;
	for (const { room_id } of rows) {
		if (at - (lastWake.get(room_id) ?? 0) < every) continue;
		const idleAuto = !!autonomyOf(getRoom(room_id)) && !hasInFlight(room_id);
		// 兜底已经停了、在等用户看一下，且看板此后没动过：定时检查也不叫醒空转（用户发话或看板有变化后恢复）
		const st = idle.get(room_id);
		if (idleAuto && st?.hinted && st.sig === boardSig(room_id)) continue;
		if (wakeManager(room_id, idleAuto ? `定时检查：${AUTONOMY_IDLE_WAKE}` : "定时检查：看看任务进展")) n++;
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
	managerConversation(roomId) {
		const r = getRoom(roomId);
		if (!r?.manager_id || !activeIds(roomId).includes(r.manager_id)) return null;
		return { agentId: r.manager_id, conversationId: memberConversation(roomId, r.manager_id) };
	},
});
