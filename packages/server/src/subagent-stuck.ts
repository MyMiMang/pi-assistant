/**
 * 帮手（子代理）的卡住处理（决策 0014 第 3 步，按用户反馈改成「主会话自己解决」）：
 *  1. 先诊断：在预计时长内的工具、仍在输出的命令、模型还在流式输出、工作区文件还在变 → 都是「慢但在动」，不算卡住、不打断；
 *  2. 真卡住 → 主会话按阶梯自己处理，目标不变：看记录和最后的错误 → 带针对性纠正从最近检查点重启（结果未知的操作先核验）
 *     → 换做法（改说明派新帮手、拆小或主会话接手）→ 办法用尽就结束这个帮手并写清楚试过什么，由主会话向用户报告失败总结；
 *  3. 同一原因反复失败：第 2 次提示换策略，第 3 次起拒绝原样续跑；
 *  4. 只有进展需要用户才能给的东西（批准 / 登录凭据 / 真正的决定 / 只有用户有的资源）才找用户，而且说清楚要什么——
 *     审批、提问本来就走 requests 卡片，等用户期间不算卡住。不再问用户「继续等 / 停止」。
 * 后台 / 定时 / 巡检的帮手没有主会话回合负责：系统自己走同一阶梯的机械部分（重启一次 → 失败并写明试过什么）。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db.ts";
import { workspaceOf } from "./files.ts";
import type { ResumeSafety } from "./subagent-resume.ts";
import { fingerprint, repeatLevel } from "./stuck.ts";
import type { Subagent } from "./subagents.ts";

/** 多久没有任何动静才去诊断（毫秒）；e2e 可用环境变量调短。 */
export const SUBAGENT_STALL_MS = () => Number(process.env.PIA_SUBAGENT_STALL_MS) || 180_000;
/** 工具没写超时时，按多久算「预计时长」（毫秒）；超过预计时长只要还在输出也不算卡住。 */
export const toolExpectMs = (args: Record<string, unknown>) => {
	const t = Number(args.timeoutMs ?? 0) || Number(args.timeout ?? 0) * 1000;
	return t > 0 ? t : Number(process.env.PIA_SUBAGENT_TOOL_EXPECT_MS) || 120_000;
};
export interface StuckHooks {
	event: (r: Subagent, kind: string, reason: string) => void;
	changed: (id: string) => void;
	/** 中断这一轮、带纠正说明从最近检查点续跑；正在跑才生效 */
	restart: (id: string, note: string) => Promise<boolean>;
	fail: (id: string, reason: string) => void;
}
/** 卡住处理的记录：第几级、试过什么（帮手结束时清掉）。 */
interface Ladder { kind: "stall"; rung: number; at: number; tried: string[] }
/** 反复卡住时追加在失败原因后的说明；算指纹前去掉，免得说明本身改变「同一处」的判断。 */
const REPEAT_MARK = "（反复卡在同一处";
/** 办法用尽：失败原因里带这个标记，主会话据此向用户报告失败总结（见 subagent-supervision）。 */
export const EXHAUSTED_MARK = "已用尽办法";

const ladderOf = (r: Subagent): Ladder | null => {
	try { const v = r.escalation ? JSON.parse(r.escalation) : null; return v?.kind === "stall" ? (v as Ladder) : null; } catch { return null; }
};
const save = (id: string, l: Ladder | null) => db.prepare("UPDATE subagents SET escalation = ? WHERE id = ?").run(l ? JSON.stringify(l) : null, id);
const waitingForUser = (id: string) => !!db.prepare("SELECT 1 FROM requests WHERE task_id = ? AND status = 'pending'").get(id);
const lastTool = (id: string) => {
	const m = db.prepare("SELECT meta FROM messages WHERE subagent_id = ? AND role = 'tool' ORDER BY rowid DESC LIMIT 1").get(id) as { meta: string } | undefined;
	try { return m ? (JSON.parse(m.meta) as { toolName?: string; status?: string }) : null; } catch { return null; }
};

/** 工作区里有没有比 since 更新的文件（有界扫描：跳过依赖 / 版本库目录，最多看 2000 项、4 层）。 */
export function workspaceTouchedSince(dir: string, since: number): boolean {
	let seen = 0;
	const walk = (d: string, depth: number): boolean => {
		let names: string[];
		try { names = readdirSync(d); } catch { return false; }
		for (const n of names) {
			if (++seen > 2000) return false;
			if (n === "node_modules" || n === ".git") continue;
			const p = join(d, n);
			try {
				const s = statSync(p);
				if (s.mtimeMs > since) return true;
				if (s.isDirectory() && depth < 4 && walk(p, depth + 1)) return true;
			} catch { /* 扫描途中被删 */ }
		}
		return false;
	};
	return walk(dir, 0);
}

/**
 * 诊断：一段时间没有消息 / 输出之后，区分「慢但在动」和「真卡住」。返回 null = 健康（不打断），否则返回卡在哪的说明。
 * 动静本身（模型流式输出、工具开始 / 结束 / 新输出）已经在 subagentActivity 里刷新 last_activity_at。
 */
export function diagnoseStall(r: Subagent, ts: number, toolUntil: number): string | null {
	if (ts <= toolUntil) return null; // 工具还在预计时长内
	if (workspaceTouchedSince(workspaceOf(r.agent_id), r.last_activity_at)) return null; // 文件 / 日志还在变
	const mins = Math.max(1, Math.round((ts - r.last_activity_at) / 60_000));
	const tool = lastTool(r.id);
	const where = tool?.status === "running" ? `工具「${tool.toolName}」超过预计时长且 ${mins} 分钟没有新输出` : `${mins} 分钟没有任何输出（模型请求或工具都没有动静）`;
	return where;
}

/** 看门狗每轮调用（运行中 / 暂无进展的帮手）。 */
export async function superviseStall(r: Subagent, ts: number, toolUntil: number, h: StuckHooks) {
	if (ts <= toolUntil || !["running", "stalled"].includes(r.status) || waitingForUser(r.id)) return; // 工具在预计时长内 / 在等用户批准或回答：不算卡住
	const l = ladderOf(r);
	if (ts - Math.max(r.last_activity_at, l?.at ?? 0) < SUBAGENT_STALL_MS()) return;
	const where = diagnoseStall(r, ts, toolUntil);
	if (!where) {
		db.prepare("UPDATE subagents SET last_activity_at = ? WHERE id = ?").run(ts, r.id); // 慢但在动：重新计时
		return;
	}
	const rung = (l?.rung ?? 0) + 1, tried = l?.tried ?? [];
	const next = (step: string): Ladder => ({ kind: "stall", rung, at: ts, tried: [...tried, step] });
	const exhausted = () => h.fail(r.id, `一直卡住（${where}），${EXHAUSTED_MARK}：${[...tried].join("；") || "无"}`);
	if (r.kind) {
		// 没有主会话回合负责的帮手（后台 / 定时 / 巡检）：系统自己重启一次，仍卡住就失败并写明
		if (rung > 1) return exhausted();
		save(r.id, next("从最近检查点重启过一次"));
		await h.restart(r.id, `系统发现你卡住了（${where}）。先确认卡在哪一步，换一种更稳的做法继续，不要原样重复刚才的操作。`);
		return h.changed(r.id);
	}
	if (rung > 3) return exhausted();
	const steps = [
		["已叫主会话诊断并带纠正重启", `卡住了：${where}。请你（主会话）自己处理，不要问用户要不要等：先用 subagent_list 看它的记录和最后的错误，判断卡在哪；再用 subagent_restart 带上针对性的纠正，从最近检查点续跑（结果未知的操作会先核验）。`],
		["已提示主会话换做法", `重启后又卡住：${where}。换个做法，目标不变：用 subagent_stop 停掉它，按修改后的说明（拆小、换路径、避开卡住的那一步）用 spawn_subagent 派新帮手，或者你自己接手。`],
		["已最后提醒主会话", `仍然卡住：${where}。这是最后一次提醒；下一次仍无进展系统会结束这个帮手，你再向用户报告失败总结（目标、试过什么、卡在哪）。`],
	];
	const [step, text] = steps[rung - 1];
	db.prepare("UPDATE subagents SET status = 'stalled' WHERE id = ?").run(r.id);
	save(r.id, next(step));
	h.event(r, "stalled", text);
	h.changed(r.id);
}

/**
 * 帮手结束时调用（在写终态之前）：失败 / 超时的原因和这个帮手之前的失败比指纹。
 * 返回要写进终态的原因（反复时追加换策略的说明；需要用户才能给的东西写明是什么）和写完终态之后要做的事。
 */
export function superviseFinish(r: Subagent, status: string, reason: string): { reason: string; after: () => void } {
	const after = () => { if (r.escalation) save(r.id, null); };
	if (!["failed", "timeout"].includes(status)) return { reason, after };
	const need = userOnlyNeed(reason);
	if (need) return { reason: `${reason}（需要用户：${need}）`, after };
	const fp = fingerprint(reason);
	const level = repeatLevel(previousFailures(r.id), fp);
	if (!level) return { reason, after };
	const times = previousFailures(r.id).filter((x) => x === fp).length + 1;
	const hint = level === "manager" ? `${REPEAT_MARK}，第 ${times} 次：换个方法、拆小或改由主会话接手，不要原样续跑）` : `${REPEAT_MARK}，第 ${times} 次：原样续跑已停用，必须换策略——改说明派新帮手或主会话接手；确实没有办法就向用户报告失败总结）`;
	return { reason: `${reason}${hint}`, after };
}
const previousFailures = (id: string) => (db.prepare("SELECT reason FROM subagent_events WHERE subagent_id = ? AND kind IN ('failed','timeout')").all(id) as { reason: string }[]).map((e) => fingerprint(e.reason.split(REPEAT_MARK)[0]));
/** 同一原因已失败 3 次及以上：拒绝原样续跑（resumeSubagent 用），返回拒绝原因。 */
export function repeatBlocked(r: Subagent): string | null {
	const fp = fingerprint((r.error_reason ?? "").split(REPEAT_MARK)[0]);
	return fp && previousFailures(r.id).filter((x) => x === fp).length >= 3 ? "同一原因已经失败 3 次，原样续跑不会有不同结果：请换策略（改说明派新帮手、拆小或主会话接手）" : null;
}

/** 只有用户能提供的东西：批准 / 权限、登录 / 凭据。返回要向用户要的具体东西；其它失败由主会话自己想办法。 */
export function userOnlyNeed(text: string | null | undefined): string | null {
	const t = String(text ?? "");
	if (/未获批准|用户拒绝|需要批准|需要授权|permission denied|not permitted|EACCES|权限不足/i.test(t)) return "批准这一步操作或给出相应权限";
	if (/未登录|需要登录|登录已过期|凭据|密钥|api[ _-]?key|unauthori[sz]ed|\b401\b|invalid token|token (expired|invalid)/i.test(t)) return "登录或提供有效的凭据";
	return null;
}

/** 卡住重启后的第一条提示：带上主会话的纠正，先核验结果未知的操作，从断点继续。 */
export function stuckRestartPrompt(note: string, safety?: ResumeSafety): string {
	const pending = safety && !safety.safe ? `会话里有 ${safety.pendingToolCalls.length} 个工具调用已派发但没看到结果（${[...new Set(safety.pendingToolCalls.map((p) => p.name))].join("、")}），先核实它们的实际结果再决定，绝不能直接重跑。` : "";
	return `（系统通知）你上一轮卡住了，已经被中断，现在从最近的检查点继续。负责的会话给你的纠正：${note.replace(/\s+/g, " ").slice(0, 600)}\n先检查工作区里已经完成的进度，已经完成的步骤不要重做、不要重复副作用。${pending}目标不变，按纠正换一种做法继续，完成后简要总结结果。`;
}
