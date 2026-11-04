/** 助理 / 后台任务的库表行与读写（runtime 各模块共用）。 */
import { bus } from "../bus.ts";
import { db } from "../db.ts";
import { updateMessage } from "../messages.ts";

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
/** 帮手状态变了：同步聊天里 kind=task 卡片（旧后台任务 / 主会话派的帮手卡片）上的状态（界面列表直接听 subagent.updated）。 */
const lastCardSync = new Map<string, string>();
export function syncTaskCard(t: TaskRow) {
	// 帮手每次有动静都会发 subagent.updated：状态 / 结果 / 错误没变就不去消息表里找卡片（json_extract 查询没有索引）
	const sig = `${t.status}\u0000${t.result ?? ""}\u0000${t.error ?? ""}`;
	if (lastCardSync.get(t.id) === sig) return;
	lastCardSync.set(t.id, sig);
	const card = db.prepare("SELECT id FROM messages WHERE role = 'card' AND json_extract(meta, '$.taskId') = ? AND json_extract(meta, '$.kind') = 'task'").get(t.id) as { id: string } | undefined;
	if (card) updateMessage(card.id, { meta: { status: t.status, result: t.result, error: t.error } });
}
