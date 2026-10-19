/**
 * 后台任务（含定时 / 巡检）与「完全权限」降权时立即停下主机工作。
 * 决策 0014 第 4 步：后台任务、定时任务和主动巡检的每次运行都是一个「帮手」（subagents 表，kind 区分来源），
 * 执行、重启判定、卡住上报、停止、并发都走子代理那一套；这里只剩触发入口的适配、完成推送和旧 tasks 表的迁移。
 */
import { listSubagents, stopAgentSubagents, isActiveSubagent, spawnSubagent, stopSubagent, resumeSubagent, getSubagent, type HelperKind, type Subagent } from "../subagents.ts";
import { hostFileAccess } from "../host-control.ts";
import { currentConversation } from "../conversations.ts";
import { bus } from "../bus.ts";
import { db } from "../db.ts";
import { defaultModel } from "../models.ts";
import { notify } from "../push.ts";
import { insertMessage } from "../messages.ts";
import { type TaskRow, getAgent, listAgents, syncTaskCard } from "./rows.ts";
import { runtimes, runtime } from "./agent-runtime.ts";

// ---------------------------------------------------------------- 完全权限：降权 / 暂停立即生效

/** 当前“完全权限”可访问用户主机的助理集合（用于检测降权 / 暂停） */
let hostAccessAgents = new Set<string>();
/**
 * 完全权限的主机文件 / 命令权限由 hostFileAccess() 每次工具调用求值，降权 / 暂停后下一个工具就被拦下。
 * 这里额外在 host 状态变化时中止正在跑的会话（含子代理、后台任务），让正在执行的主机命令立刻停下，
 * 而不是等这一轮自然结束（不依赖下一轮 session 重建）。启动时调用一次。
 */
export function initHostAccessWatch() {
	const refresh = () => {
		const next = new Set(listAgents().map((a) => a.id).filter((id) => hostFileAccess(id)));
		const lost = [...hostAccessAgents].filter((id) => !next.has(id));
		hostAccessAgents = next;
		return lost;
	};
	refresh();
	bus.on((e) => {
		if (e.type !== "host.changed") return;
		for (const id of refresh()) void stopHostWork(id);
	});
}

/** 中止某个助理正在跑的主机工作：主会话和所有帮手（含后台 / 定时 / 巡检；复用已有 abort，命令子进程随 abort 信号结束） */
async function stopHostWork(agentId: string) {
	for (const r of [...runtimes.values()]) if (r.id === agentId && r.busy) await r.abort().catch(() => {});
	await stopAgentSubagents(agentId).catch(() => {});
}

// ---------------------------------------------------------------- 后台任务 = 帮手

/** 助理正在干活（任一对话回合或任何帮手在跑，含后台 / 定时 / 巡检）：助理电脑不会被空闲关机 */
export function agentBusy(agentId: string) {
	return [...runtimes.values()].some((r) => r.id === agentId && r.busy) || listSubagents(agentId).some((r) => isActiveSubagent(r.status));
}

/** 帮手行 → 旧「后台任务」形状（/api/agents/:id/tasks、旧聊天卡片和定时 / 巡检记录沿用这些字段名） */
export function taskView(r: Subagent): TaskRow {
	return {
		id: r.id, agent_id: r.agent_id, conversation_id: r.conversation_id, routine_run_id: r.routine_run_id ?? null, kind: r.kind ?? null,
		title: r.title ?? r.task, instructions: r.task, status: r.status === "stopped" ? "cancelled" : r.status, session_file: r.session_file,
		result: r.result_summary || null, error: r.status === "done" ? null : r.error_reason, created_at: r.created_at, started_at: r.run_started_at, finished_at: r.finished_at,
	};
}

export const tasks = {
	/** 开一个后台帮手（spawn_task 工具 / 定时任务 / 主动巡检）。没有可用模型时直接报错，由触发方记失败。 */
	spawn(agentId: string, title: string, instructions: string, opts: { conversationId?: string | null; routineRunId?: string; kind?: HelperKind } = {}) {
		const a = getAgent(agentId);
		const model = a ? runtime(a.id).modelFor(a) : null;
		if (!a || !model) throw new Error("没有可用的模型");
		const kind = opts.kind ?? (opts.routineRunId ? "routine" : "task");
		const conv = opts.conversationId ?? currentConversation(agentId);
		const h = spawnSubagent(agentId, conv, model, { task: instructions, title, kind, routineRunId: opts.routineRunId });
		// 聊天里照旧留一张后台任务卡片（状态由 syncTaskCard 跟着帮手更新）；巡检保持安静
		if (kind !== "heartbeat") insertMessage({ agentId, conversationId: conv, role: "card", meta: { kind: "task", taskId: h.id, title, status: taskView(h).status, routineRunId: opts.routineRunId } });
		return h;
	},
	cancel: (id: string) => stopSubagent(id),
	/** 中断待核验 / 失败后在原会话继续（先核验、不重做）；规则同子代理的「继续」。 */
	resume(id: string) {
		try {
			resumeSubagent(id, { mode: "manual" });
			return true;
		} catch {
			return false;
		}
	},
	list: (agentId: string) => listSubagents(agentId).filter((r) => r.kind === "task" || r.kind === "routine").map(taskView),
};

/**
 * 后台任务的帮手结束（和以前一样不额外唤醒主会话、不为解释失败再花一次模型请求）：
 * 完成 → 推送 + 结果作为主会话下一轮的上下文；失败 / 超时 / 中断待核验 → 推送 + 对话里直接可见的报错。
 * 定时任务由 routines.ts 发消息与推送（遵守免打扰）；巡检静默，只记录。旧聊天卡片同步状态。
 */
const reported = new Set<string>();
bus.on((e) => {
	const r = (e as { type: string; subagent?: Subagent }).type === "subagent.updated" ? (e as { subagent?: Subagent }).subagent : undefined;
	if (!r?.kind) return;
	const t = taskView(r);
	syncTaskCard(t);
	if (r.kind !== "task" || !["done", "failed", "timeout", "lost"].includes(r.status) || reported.has(`${r.id}:${r.finished_at}`)) return;
	reported.add(`${r.id}:${r.finished_at}`);
	if (r.status === "done") {
		notify({ title: `后台任务完成：${t.title}`, body: t.result ?? "", tag: r.id, url: `/?agent=${r.agent_id}` });
		void runtime(r.agent_id, r.conversation_id).inject(`后台任务「${t.title}」已完成。结果：\n${t.result ?? ""}`).catch(() => {});
		return;
	}
	const error = r.error_reason ?? (r.status === "timeout" ? "超时" : "未知原因");
	const lost = r.status === "lost";
	notify({ title: `${lost ? "后台任务中断待核验" : "后台任务失败"}：${t.title}`, body: error, tag: r.id, url: `/?agent=${r.agent_id}` });
	const content = lost ? `后台任务「${t.title}」中断待核验：${error}。核验后可以在帮手详情里点「继续」。` : `后台任务「${t.title}」失败：${error}`;
	insertMessage({ agentId: r.agent_id, conversationId: r.conversation_id, role: "system", content, status: "error", meta: { kind: lost ? "task-lost" : "task-error", taskTitle: t.title, error } });
});

/**
 * 旧 tasks 表迁到帮手（幂等，启动时在恢复帮手之前调用）：同一个 id 写进 subagents，旧聊天卡片、定时 / 巡检记录和等待里的 id 都不用改。
 * 运行中 / 排队的照常交给 recoverSubagents 做重启判定；旧表原样保留（只读，不再写）。
 */
export function migrateLegacyTasks() {
	const rows = db.prepare("SELECT t.* FROM tasks t WHERE NOT EXISTS (SELECT 1 FROM subagents s WHERE s.id = t.id)").all() as unknown as (TaskRow & { resume?: number })[];
	const model = defaultModel() ?? { provider: "unknown", id: "unknown" };
	const insert = db.prepare("INSERT OR IGNORE INTO subagents(id, agent_id, conversation_id, task, context, model_provider, model_id, model_reason, status, last_activity_at, error_reason, result_summary, created_at, finished_at, session_file, run_started_at, resume, model_pool, kind, title, routine_run_id, notified_at) VALUES(?,?,?,?,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
	db.exec("BEGIN");
	try {
		for (const t of rows) {
			const m = (getAgent(t.agent_id) && runtime(t.agent_id).modelFor(getAgent(t.agent_id)!)) || model;
			const status = t.status === "cancelled" ? "stopped" : t.status;
			const at = t.finished_at ?? t.started_at ?? t.created_at;
			const kind = t.kind === "heartbeat" ? "heartbeat" : t.routine_run_id ? "routine" : "task";
			// 已结束的旧任务当时已经回报过：标为已通知，迁过来不再唤醒主会话
			insert.run(t.id, t.agent_id, t.conversation_id ?? currentConversation(t.agent_id), t.instructions, m.provider, m.id, "从旧后台任务迁移", status, at, t.error, t.result, t.created_at, t.finished_at, t.session_file, t.started_at, t.resume ?? 0, JSON.stringify([m]), kind, t.title, t.routine_run_id, t.finished_at);
		}
		// 等旧后台任务的等待改成等帮手（同一个 id）
		db.prepare("UPDATE task_waits SET target_kind = 'subagent' WHERE target_kind = 'task'").run();
		db.exec("COMMIT");
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
	return rows.length;
}

/** 按 id 取一条后台任务（帮手）的旧形状；不是后台帮手返回 undefined。 */
export const getTask = (id: string) => {
	const r = getSubagent(id);
	return r?.kind ? taskView(r) : undefined;
};
