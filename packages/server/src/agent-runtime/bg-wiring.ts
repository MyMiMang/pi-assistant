/**
 * 长命令转后台的接线（逻辑在 ../bg-jobs.ts，Pi 部分在 ../pi-adapter/bg-shell.ts，设计见 docs/design/background-commands.md）：
 * - 所有者键：单聊 / 群里成员的对话 `conv:<对话>`（跨会话重建保留，停止时整批结束）；帮手 / 后台任务 / 巡检不转后台（没人插话，照旧等命令跑完）；
 * - 作业结束 → 聊天里一条小提示，并把结果交给助理：这一轮还在 → 插话（steer）；已空闲 → 开一轮接着处理；群里成员空闲 → 留到他下次发言；
 * - 状态落 bg_jobs 表；服务重启时「在跑」的标成「中断」，助理下次开口前告诉它（重启不续跑作业）。
 */
import { db } from "../db.ts";
import { insertMessage } from "../messages.ts";
import { bgHooks, jobLine, type BgJob, type BgOwner, killOwner } from "../bg-jobs.ts";
import { injectContext, isSessionBusy } from "../pi-adapter/index.ts";
import { sendBgResult } from "../pi-adapter/bg-shell.ts";
import { roomHooks } from "./room-hooks.ts";
import { runtime } from "./agent-runtime.ts";

export const BG_NOTE_TYPE = "pia_bg_job";

/** 这个会话里的作业归谁：用户看得见的对话按对话；帮手 / 后台任务 / 巡检 → null（不转后台） */
export function bgOwnerFor(agentId: string, conversationId: string | null, taskId: string | null, subagentId?: string): BgOwner | null {
	if (subagentId || taskId || !conversationId) return null;
	return { key: `conv:${conversationId}`, agentId, conversationId };
}

/** 用户点停止：这个对话名下转到后台的命令一起结束 */
export const killConversationJobs = (conversationId: string) => killOwner(`conv:${conversationId}`);

/** 给助理看的结束通知 */
export function endNote(j: BgJob, tail: string): string {
	return `（后台命令结束）${jobLine(j)}\n输出末尾：\n${tail || "（没有输出）"}\n这是你之前转到后台的命令。如果你在等它，就接着处理；如果它出了问题，先告诉用户原因和打算。`;
}

async function deliver(j: BgJob, tail: string) {
	if (!j.conversationId) return;
	const short = j.command.length > 60 ? `${j.command.slice(0, 60)}…` : j.command;
	const ok = j.status === "done";
	insertMessage({ agentId: j.agentId, conversationId: j.conversationId, role: "system", content: `后台命令${ok ? "结束" : j.status === "timeout" ? "超时结束" : "出错结束"}：${short}`, meta: { system: "bg-job", jobId: j.id, jobStatus: j.status } });
	const r = runtime(j.agentId, j.conversationId);
	const s = await r.ensure();
	if (!s) return;
	const text = endNote(j, tail);
	// 群里成员的对话：回合由群调度管，空闲时不自己开口，留到他下次发言前给他看
	if (roomHooks?.info(j.agentId, j.conversationId) && !isSessionBusy(s)) return void (await injectContext(s, BG_NOTE_TYPE, text));
	await r.deliverBgResult(text);
}

/** 启动时调用一次：挂上持久化 / 通知钩子，并把上次没跑完的作业标成「中断」 */
export function initBackgroundJobs() {
	bgHooks.onStart = (j) => void db.prepare("INSERT OR REPLACE INTO bg_jobs(id, agent_id, conversation_id, command, status, started_at) VALUES(?,?,?,?,?,?)").run(j.id, j.agentId, j.conversationId, j.command.slice(0, 2000), "running", j.startedAt);
	bgHooks.onFinish = (j) => void db.prepare("UPDATE bg_jobs SET status = ?, ended_at = ?, exit_code = ? WHERE id = ?").run(j.status, j.endedAt ?? Date.now(), j.exitCode ?? null, j.id);
	bgHooks.onEnd = (j, tail) => void deliver(j, tail).catch((e) => console.warn("[bg-job] 结果没能交给助理：", e instanceof Error ? e.message : e));
	db.prepare("UPDATE bg_jobs SET status = 'interrupted', ended_at = ?, told = 0 WHERE status = 'running'").run(Date.now());
}

/** 助理下次开口前：把重启中断的作业告诉它（只告诉一次） */
export function takeInterruptedNote(conversationId: string): string | null {
	const rows = db.prepare("SELECT id, command FROM bg_jobs WHERE conversation_id = ? AND status = 'interrupted' AND told = 0").all(conversationId) as { id: string; command: string }[];
	if (!rows.length) return null;
	db.prepare("UPDATE bg_jobs SET told = 1 WHERE conversation_id = ? AND status = 'interrupted'").run(conversationId);
	return `（后台命令被中断）服务重启了，你之前转到后台的这些命令没跑完就被结束了：\n${rows.map((r) => `- ${r.id}：${r.command.slice(0, 120)}`).join("\n")}\n需要的话重新确认结果或重新运行；在确认之前不要说它们已经做完了。`;
}
