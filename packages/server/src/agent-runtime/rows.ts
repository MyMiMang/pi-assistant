/** 助理 / 后台任务的库表行与读写（runtime 各模块共用）。 */
import { bus } from "../bus.ts";
import { db } from "../db.ts";
import { updateMessage } from "../messages.ts";
import { tasks } from "./background-tasks.ts";

export interface AgentRow {
	id: string;
	name: string;
	avatar: string;
	color: string;
	persona: string;
	description: string;
	model_provider: string | null;
	model_id: string | null;
	thinking: string | null;
	/** 请求级 Fast（0/1）：主会话 / 群成员 / 后台 / 定时都用它，与 thinking 独立 */
	fast: number | null;
	status: string;
	session_file: string | null;
	unread: number;
	sort: number;
	created_at: number;
	conversation_id: string | null;
	memory_provider: string | null;
}
export interface TaskRow {
	id: string;
	agent_id: string;
	title: string;
	instructions: string;
	status: string;
	session_file: string | null;
	result: string | null;
	error: string | null;
	created_at: number;
	started_at: number | null;
	finished_at: number | null;
	conversation_id: string | null;
	routine_run_id: string | null;
	kind?: string | null;
	/** 0 = 按任务说明开跑；1 = 重启后安全续跑；2 = 中断 / 失败后手动继续（先核验） */
	resume?: number;
}

export const getAgent = (id: string) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
export const listAgents = () => db.prepare("SELECT * FROM agents ORDER BY sort, created_at").all() as unknown as AgentRow[];
export const getTask = (id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;

export function setAgentStatus(id: string, status: string) {
	db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
	bus.emit({ type: "agent.status", agentId: id, status });
}
export function setTask(id: string, patch: Partial<TaskRow>) {
	const keys = Object.keys(patch);
	db.prepare(`UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => (patch as Record<string, never>)[k]), id);
	const t = getTask(id)!;
	bus.emit({ type: "task.updated", task: t });
	const card = db.prepare("SELECT id FROM messages WHERE role = 'card' AND json_extract(meta, '$.taskId') = ? AND json_extract(meta, '$.kind') = 'task'").get(id) as { id: string } | undefined;
	if (card) updateMessage(card.id, { meta: { status: t.status, result: t.result, error: t.error } });
	return t;
}
