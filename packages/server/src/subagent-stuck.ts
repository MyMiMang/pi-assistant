/**
 * 单聊帮手（子代理）的卡住检测与上报（决策 0014 第 3 步），规则复用 stuck.ts（和群任务同一份）：
 *  - 没进展：先标「暂无进展」并叫醒主会话（原有行为）；主会话被叫过后仍一点动静都没有 → 问用户；
 *  - 反复卡在同一处：同一个帮手第 2 次因为同样的原因失败 / 超时 → 提示主会话换方法、不要原样续跑；第 3 次 → 问用户。
 * 问用户 = 主会话里一张提问卡片 + 推送；用户回答「停止」直接停，「继续等」重新计时，其余回答交给主会话按决定处理。
 * 只做检测和上报，不设固定次数 / 费用上限，不替用户决定。
 */
import { db } from "./db.ts";
import { notify } from "./push.ts";
import { requests } from "./requests.ts";
import { fingerprint, repeatLevel, stallStep, type Escalation, type EscalationKind } from "./stuck.ts";
import type { Subagent } from "./subagents.ts";

/** 多久没有任何动静算「没进展」（毫秒）；e2e 可用环境变量调短。 */
export const SUBAGENT_STALL_MS = () => Number(process.env.PIA_SUBAGENT_STALL_MS) || 180_000;
export interface StuckHooks {
	event: (r: Subagent, kind: string, reason: string) => void;
	changed: (id: string) => void;
	stop: (id: string) => Promise<unknown>;
	deliver: () => Promise<unknown>;
}
type Esc = Escalation & { requestId?: string | null };
const STOP = "停止这个帮手", WAIT = "继续等", DROP = "先放下这件事";
/** 反复卡住时追加在失败原因后的说明；算指纹前去掉，免得说明本身改变「同一处」的判断。 */
const REPEAT_MARK = "（反复卡在同一处";

const escOf = (r: Subagent): Esc | null => {
	try { return r.escalation ? (JSON.parse(r.escalation) as Esc) : null; } catch { return null; }
};
const save = (id: string, esc: Esc | null) => db.prepare("UPDATE subagents SET escalation = ? WHERE id = ?").run(esc ? JSON.stringify(esc) : null, id);
const pendingRequest = (id: string) => !!db.prepare("SELECT 1 FROM requests WHERE task_id = ? AND status = 'pending'").get(id);
const titleOf = (r: Subagent) => {
	const t = r.task.replace(/\s+/g, " ").trim();
	return t.length > 40 ? `${t.slice(0, 40)}…` : t;
};

/** 看门狗每轮调用（运行中 / 暂无进展的帮手）。toolUntil：正在跑的长命令预计结束时间，之前不算卡住。 */
export async function superviseStall(r: Subagent, ts: number, toolUntil: number, h: StuckHooks) {
	if (ts <= toolUntil) return;
	const esc = escOf(r);
	const level = stallStep({ active: r.status === "running" || r.status === "stalled", needsUser: pendingRequest(r.id), lastActivityAt: r.last_activity_at, escalation: esc, now: ts, stallMs: SUBAGENT_STALL_MS() });
	if (!level) return;
	const mins = Math.max(1, Math.round((ts - r.last_activity_at) / 60_000));
	if (level === "manager") {
		db.prepare("UPDATE subagents SET status = 'stalled' WHERE id = ?").run(r.id);
		save(r.id, { kind: "stall", level, at: ts, note: `${mins} 分钟没有进展` });
		h.event(r, "stalled", `子代理已 ${mins} 分钟没有进展，请检查或重新派活`);
		h.changed(r.id);
		return;
	}
	askUser(r, "stall", `已经 ${mins} 分钟没有进展，主会话处理后仍然没有动静`, [WAIT, STOP], h);
}

/**
 * 帮手结束时调用（在写终态之前）：失败 / 超时的原因和这个帮手之前的失败比指纹。
 * 返回要写进终态的原因（反复时追加说明）和写完终态之后要做的事（收掉没进展的提问、必要时问用户）。
 */
export function superviseFinish(r: Subagent, status: string, reason: string, h: StuckHooks): { reason: string; after: () => void } {
	const esc = escOf(r);
	const clearStall = () => {
		if (esc?.kind === "stall" && esc.requestId) requests.resolve(esc.requestId, { answer: "（帮手已结束）", note: "帮手已结束" }, "system");
		if (esc) save(r.id, null);
	};
	if (!["failed", "timeout"].includes(status)) return { reason, after: clearStall };
	const fp = fingerprint(reason);
	const previous = (db.prepare("SELECT reason FROM subagent_events WHERE subagent_id = ? AND kind IN ('failed','timeout')").all(r.id) as { reason: string }[]).map((e) => fingerprint(e.reason.split(REPEAT_MARK)[0]));
	const level = repeatLevel(previous, fp);
	if (!level) return { reason, after: clearStall };
	const times = previous.filter((x) => x === fp).length + 1;
	const hint = level === "manager" ? `${REPEAT_MARK}，第 ${times} 次：换个方法、拆小或改由主会话接手，不要原样续跑）` : `${REPEAT_MARK}，第 ${times} 次，已请用户决定）`;
	return {
		reason: `${reason}${hint}`,
		after: () => {
			clearStall();
			if (level === "user") askUser(r, "repeat", `第 ${times} 次卡在同一处：${reason.slice(0, 200)}`, ["换个方法继续", DROP], h);
		},
	};
}

/** 帮手又有动静了：收掉还没回答的「没进展」提问（不再需要用户决定）。 */
export function clearStallQuestion(r: Subagent) {
	const esc = escOf(r);
	if (esc?.kind !== "stall" || !esc.requestId) return;
	requests.resolve(esc.requestId, { answer: "（帮手恢复了进展）", note: "帮手恢复了进展" }, "system");
	save(r.id, null);
}

function askUser(r: Subagent, kind: EscalationKind, note: string, options: string[], h: StuckHooks) {
	if (r.kind === "heartbeat") return void h.stop(r.id).catch(() => {}); // 巡检不打扰用户：卡住就停下，下次巡检再看
	const question = `帮手「${titleOf(r)}」${note}。下一步怎么办？`;
	const pending = requests.question(r.agent_id, r.id, question, options, true, r.conversation_id);
	// create() 同步落库：按插入顺序取刚建的这张
	const row = db.prepare("SELECT id FROM requests WHERE task_id = ? AND status = 'pending' AND kind = 'question' ORDER BY rowid DESC LIMIT 1").get(r.id) as { id: string } | undefined;
	const requestId = row?.id ?? null;
	save(r.id, { kind, level: "user", at: Date.now(), note, requestId });
	notify({ title: "帮手需要你决定", body: question, tag: `helper-${r.id}`, url: `/?agent=${r.agent_id}` });
	h.changed(r.id);
	void pending
		.then(async (ans) => {
			// 只认用户真的回答了（过期 / 帮手结束等系统收尾不算决定）
			const res = db.prepare("SELECT status, resolved_by FROM requests WHERE id = ?").get(requestId) as { status: string; resolved_by: string | null } | undefined;
			const a = ans.answer?.trim();
			if (res?.status !== "answered" || res.resolved_by === "system" || !a) return;
			save(r.id, null);
			if (a === STOP) return void (await h.stop(r.id));
			if (a === WAIT) {
				db.prepare("UPDATE subagents SET last_activity_at = ? WHERE id = ?").run(Date.now(), r.id);
				return h.changed(r.id);
			}
			// 其余决定交给主会话：它负责按用户的决定续跑、换方法或收尾
			h.event(r, "decided", a === DROP ? "用户决定先放下这件事：不要再续跑，向用户简短说明已做到哪一步" : `用户的决定：${a}`);
			await h.deliver();
		})
		.catch(() => {});
}
