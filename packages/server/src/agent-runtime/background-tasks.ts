/** 后台任务（含定时 / 巡检）与「完全权限」降权时立即停下主机工作。 */
import { listSubagents, stopAgentSubagents, isActiveSubagent, agentFast } from "../subagents.ts";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { hostFileAccess } from "../host-control.ts";
import { currentConversation } from "../conversations.ts";
import { skillPaths } from "../skills.ts";
import { skillFilterFor } from "../skill-scope.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { db, now, uid } from "../db.ts";
import { workspaceOf } from "../files.ts";
import { insertMessage } from "../messages.ts";
import { models } from "../models.ts";
import { abortSession, type AgentSession, createPiSession, disposeSession, isSessionBusy, lastAssistantText, lastAssistantError, modelErrorMessage, promptSession, sessionFileOf } from "../pi-adapter/index.ts";
import { attachFastMode } from "../pi-adapter/fast-mode.ts";
import { notify } from "../push.ts";
import { requests } from "../requests.ts";
import { type TaskRow, getAgent, listAgents, getTask, setTask } from "./rows.ts";
import { SYSTEM_RULES } from "./system-rules.ts";
import { bindSession } from "./bind-session.ts";
import { extensionsFor, integrationsFor } from "./extensions.ts";
import { runtimes, runtime } from "./agent-runtime.ts";
import { RESTART_RESUME_PROMPT, sessionResumeSafety, verifyResumePrompt } from "../subagent-resume.ts";

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

/** 中止某个助理正在跑的主机工作：主会话、子代理、后台任务（复用已有 abort，命令子进程随 abort 信号结束） */
async function stopHostWork(agentId: string) {
	for (const r of [...runtimes.values()]) if (r.id === agentId && r.busy) await r.abort().catch(() => {});
	await stopAgentSubagents(agentId).catch(() => {});
	for (const [taskId, s] of [...live]) if (liveAgent.get(taskId) === agentId) await abortSession(s).catch(() => {});
}

// ---------------------------------------------------------------- 后台任务

const MAX_CONCURRENT = 3;
const live = new Map<string, AgentSession>();
/** 后台任务（含定时任务）taskId → agentId：空闲关机判定用 */
const liveAgent = new Map<string, string>();
/** 助理正在干活（任一对话回合、后台任务或定时任务在跑）：助理电脑不会被空闲关机 */
export function agentBusy(agentId: string) {
	return [...runtimes.values()].some((r) => r.id === agentId && r.busy) || [...liveAgent.values()].includes(agentId) || listSubagents(agentId).some((r) => isActiveSubagent(r.status));
}

export const tasks = {
	spawn(agentId: string, title: string, instructions: string, opts: { conversationId?: string | null; routineRunId?: string; kind?: "heartbeat" } = {}): TaskRow {
		const id = uid("t");
		const conv = opts.conversationId ?? currentConversation(agentId);
		db.prepare("INSERT INTO tasks(id, agent_id, conversation_id, routine_run_id, title, instructions, status, kind, created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, agentId, conv, opts.routineRunId ?? null, title, instructions, "queued", opts.kind ?? null, now());
		// 主动巡检在隐藏对话里静默进行，不在聊天里放任务卡片
		if (opts.kind !== "heartbeat") insertMessage({ agentId, conversationId: conv, role: "card", meta: { kind: "task", taskId: id, title, status: "queued", routineRunId: opts.routineRunId } });
		bus.emit({ type: "task.updated", task: getTask(id) });
		queueMicrotask(() => tasks.pump());
		return getTask(id)!;
	},
	pump() {
		const running = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get() as { n: number }).n;
		const slots = MAX_CONCURRENT - running;
		if (slots <= 0) return;
		const queued = db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at LIMIT ?").all(slots) as unknown as TaskRow[];
		for (const t of queued) void tasks.run(t);
	},
	/**
	 * 服务重启后处理被打断的后台任务（含定时 / 巡检），和子代理同一套判定（复用 subagent-resume.ts）：
	 * 会话里没有「已派发、结果未落库」的工具调用 → 排队从断点续跑；否则标「中断待核验」(lost)，不自动重放，等人核验后点继续。
	 */
	recover() {
		for (const t of db.prepare("SELECT * FROM tasks WHERE status = 'running'").all() as unknown as TaskRow[]) {
			const safety = sessionResumeSafety(t.session_file);
			if (safety.safe) setTask(t.id, { status: "queued", resume: 1 });
			else {
				const error = `服务重启，且${safety.reason}`;
				setTask(t.id, { status: "lost", error, finished_at: now() });
				reportStop(t, `后台任务「${t.title}」中断待核验：${error}。核验后可以在任务卡片上点「继续」。`, `后台任务中断待核验：${t.title}`, error, "task-lost");
			}
		}
		tasks.pump();
	},
	/** 中断待核验 / 失败的任务在原会话里继续（先核验、不重做）；没有落库会话的无法继续，需要重新派活。 */
	resume(id: string) {
		const t = getTask(id);
		if (!t || !["lost", "failed"].includes(t.status) || !t.session_file) return false;
		setTask(id, { status: "queued", resume: 2, finished_at: null });
		tasks.pump();
		return true;
	},
	async run(t: TaskRow) {
		const a = getAgent(t.agent_id);
		const model = a ? runtime(a.id).modelFor(a) : null;
		if (!a || !model) {
			setTask(t.id, { status: "failed", error: "没有可用的模型", finished_at: now() });
			return;
		}
		setTask(t.id, { status: "running", started_at: t.started_at ?? now(), resume: 0 });
		try {
			const workspace = workspaceOf(a.id);
			const session = await createPiSession({
				models,
				cwd: workspace,
				agentDir: join(config.agentsDir, a.id),
				sessionDir: join(config.agentsDir, a.id, "tasks"),
				sessionFile: t.session_file ?? undefined,
				model,
				systemPromptAppend: [...SYSTEM_RULES(a.name, workspace, a.persona, hostFileAccess(a.id)), "你正在执行一个后台任务。完成后用几句话总结结果作为最终回复。"],
				extensions: await extensionsFor(a.id, t.conversation_id, t.id, { allowSpawn: false, actor: "background" }),
				skillPaths: skillPaths(),
				skillFilter: skillFilterFor(a.id),
				...integrationsFor(a.id, t.conversation_id),
			});
			// 后台任务用所属助理的 Fast 开关；每次请求重新读，运行中改开关对下一次请求生效
			const fast = attachFastMode(session, () => agentFast(a.id));
			live.set(t.id, session);
			liveAgent.set(t.id, a.id);
			const file = sessionFileOf(session);
			if (file) setTask(t.id, { session_file: file });
			const done = new Promise<boolean>((resolve) => {
				const unsub = bindSession(session, a.id, t.conversation_id, t.id, (aborted) => {
					if (isSessionBusy(session)) return;
					unsub();
					resolve(aborted);
				}, undefined, undefined, fast);
			});
			await promptSession(session, t.resume === 2 ? verifyResumePrompt(t.error, t.error, sessionResumeSafety(t.session_file)) : t.resume ? RESTART_RESUME_PROMPT : t.instructions);
			const aborted = await done;
			const result = lastAssistantText(session);
			const error = aborted ? undefined : lastAssistantError(session);
			disposeSession(session);
			live.delete(t.id);
			liveAgent.delete(t.id);
			if (getTask(t.id)?.status === "cancelled") return;
			if (aborted) {
				setTask(t.id, { status: "cancelled", finished_at: now() });
			} else if (error) {
				setTask(t.id, { status: "failed", error, finished_at: now() });
				reportStop(t, `后台任务「${t.title}」失败：${error}`, `后台任务失败：${t.title}`, error);
			} else {
				setTask(t.id, { status: "done", result, error: null, finished_at: now() });
				// 主动巡检：结果只记录；要告诉用户的已经通过 proactive_surface 走了防打扰规则
				if (t.kind === "heartbeat") return;
				// 定时任务的结果由 routines.ts 发聊天消息与推送（遵守免打扰）
				if (!t.routine_run_id) notify({ title: `后台任务完成：${t.title}`, body: result, tag: t.id, url: `/?agent=${a.id}` });
				await runtime(a.id, t.conversation_id).inject(`${t.routine_run_id ? "定时" : "后台"}任务「${t.title}」已完成。结果：\n${result}`);
			}
		} catch (e) {
			live.delete(t.id);
			liveAgent.delete(t.id);
			const error = modelErrorMessage(e);
			setTask(t.id, { status: "failed", error, finished_at: now() });
			reportStop(t, `后台任务「${t.title}」失败：${error}`, `后台任务失败：${t.title}`, error);
		} finally {
			tasks.pump();
		}
	},
	async cancel(id: string) {
		const t = getTask(id);
		if (!t || !["queued", "running"].includes(t.status)) return false;
		setTask(id, { status: "cancelled", finished_at: now() });
		requests.cancelForTask(id);
		const s = live.get(id);
		if (s) await abortSession(s);
		return true;
	},
	list(agentId: string) {
		return db.prepare("SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100").all(agentId) as unknown as TaskRow[];
	},
};

/**
 * 失败 / 中断待核验的统一回报：报错直接可见（额度耗尽时不再花一次模型请求来解释失败）。
 * 定时任务由 routines.ts 发消息与推送（遵守免打扰）；主动巡检静默，只记录。
 */
function reportStop(t: TaskRow, content: string, title: string, error: string, kind: "task-error" | "task-lost" = "task-error") {
	if (t.routine_run_id || t.kind === "heartbeat") return;
	notify({ title, body: error, tag: t.id });
	insertMessage({ agentId: t.agent_id, conversationId: t.conversation_id, role: "system", content, status: "error", meta: { kind, taskTitle: t.title, error } });
}
