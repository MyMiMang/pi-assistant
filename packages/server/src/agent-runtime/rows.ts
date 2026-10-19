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
	/** 旧 tasks 表的续跑方式（迁移时带进 subagents.resume） */
	resume?: number;
}

export const getAgent = (id: string) => db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
export const listAgents = () => db.prepare("SELECT * FROM agents ORDER BY sort, created_at").all() as unknown as AgentRow[];

export function setAgentStatus(id: string, status: string) {
	db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
	bus.emit({ type: "agent.status", agentId: id, status });
}
/** 后台任务（帮手）状态变了：通知界面，并同步旧聊天卡片（迁移前留下的 kind=task 卡片）上的状态。 */
export function syncTaskCard(t: TaskRow) {
	bus.emit({ type: "task.updated", task: t });
	const card = db.prepare("SELECT id FROM messages WHERE role = 'card' AND json_extract(meta, '$.taskId') = ? AND json_extract(meta, '$.kind') = 'task'").get(t.id) as { id: string } | undefined;
	if (card) updateMessage(card.id, { meta: { status: t.status, result: t.result, error: t.error } });
}
