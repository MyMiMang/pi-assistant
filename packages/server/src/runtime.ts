/**
 * Agent 运行时（门面）：每个助理每个对话一个主会话（Pi AgentSession），后台任务各自一个会话。
 * 所有 Pi 调用都经过 pi-adapter。实现拆在 agent-runtime/ 下，这里只做对外导出、启动接线与启动恢复，
 * 调用方继续 import "./runtime.ts"，不用改。
 */
import { setSubagentDriver, recoverSubagents, startSubagentWatcher, migrateSubagentModelSettings } from "./subagents.ts";
import { setWaitWaker, setWaitNoteInjector, startWaitScheduler } from "./task-waits.ts";
import { resumeAdvances, setAdvanceHooks, setProactiveSpawner } from "./proactive.ts";
import { currentConversation } from "./conversations.ts";
import { setRoutineSpawner } from "./routines.ts";
import { expireStaleSuggestions } from "./skill-intel.ts";
import { db } from "./db.ts";
import { insertMessage } from "./messages.ts";
import { requests } from "./requests.ts";
import { listAgents, type TaskRow } from "./agent-runtime/rows.ts";
import { roomHooks } from "./agent-runtime/room-hooks.ts";
import { runtime } from "./agent-runtime/agent-runtime.ts";
import { tasks } from "./agent-runtime/background-tasks.ts";
import { subagentDriver } from "./agent-runtime/subagent-driver.ts";

export { getAgent, listAgents, getTask, type AgentRow, type TaskRow } from "./agent-runtime/rows.ts";
export { setRoomHooks, type RoomHooks } from "./agent-runtime/room-hooks.ts";
export { bindSession } from "./agent-runtime/bind-session.ts";
export { describeRoutine } from "./agent-runtime/extensions.ts";
export { disposeRuntime, disposeConversationRuntime, runtime } from "./agent-runtime/agent-runtime.ts";
export { initHostAccessWatch, agentBusy, tasks } from "./agent-runtime/background-tasks.ts";

// ---------------------------------------------------------------- 启动接线与启动恢复

setRoutineSpawner((agentId, title, instructions, opts) => tasks.spawn(agentId, title, instructions, opts));
setProactiveSpawner((agentId, title, instructions, opts) => tasks.spawn(agentId, title, instructions, opts));
// 任务等待：有结果时用一次隐藏触发（nudge）唤醒对应会话；等待本身不耗模型 token。
// nudge 现在会把“没送达”如实返回 false（不再 catch 吞掉），这里转成异常，交给 task-waits 重试/补投。
setWaitWaker(async ({ wait, prompt }) => {
	const ok = await runtime(wait.agent_id, wait.conversation_id ?? undefined).nudge(prompt);
	if (!ok) throw new Error("nudge 未送达（没有可用会话/模型，或 Pi 触发失败）");
});
// 子代理完成通知抢先送达、等待让位时：把等待目的作为「下一轮才生效」的上下文注入，不重复唤醒也不丢目的。
setWaitNoteInjector((agentId, conversationId, text) => runtime(agentId, conversationId ?? undefined).inject(text));
// 主动推进：在相关对话的主会话里跑（走用户平时的权限规则），忙时由 proactive.ts 合并 / 排队。
setAdvanceHooks({
	busy: (agentId, conversationId) => runtime(agentId, conversationId).busy,
	send: async (agentId, conversationId, text) => {
		// 巡检摘要不是新的用户发言/授权。用公开custom消息触发，不继承用户轮的技能授权。
		return await runtime(agentId, conversationId).nudge(text, { onlyIdle: true }) ? "started" : "none";
	},
});

export async function bootstrap() {
	migrateSubagentModelSettings();
	recoverSubagents();
	startSubagentWatcher();
	startWaitScheduler();
	// 不再预置任何助理：首次运行向导里由用户创建并命名第一个助理
	const expired = requests.expireStale();
	expireStaleSuggestions();
	db.prepare("UPDATE messages SET status = 'interrupted' WHERE status IN ('streaming', 'running')").run();
	// 主会话：上次运行中被中断 → 自动续跑
	for (const a of listAgents()) {
		if (a.status === "running" && !roomHooks?.busyInRoom(a.id)) {
			insertMessage({ agentId: a.id, conversationId: currentConversation(a.id), role: "system", content: `服务已重启，正在继续上次未完成的工作…${expired ? `（${expired} 个待处理请求已过期，必要时会重新询问）` : ""}` });
			await runtime(a.id).send("（系统通知）服务刚刚重启，上一轮工作可能被中断。请检查进度并继续完成我最后的请求；如果已经完成，简短告诉我即可。");
		}
	}
	// 后台任务（含定时 / 巡检）：和子代理同一套重启判定——安全的排队续跑，结果未知的标中断待核验
	tasks.recover();
	// 只恢复未发出的推进；已发出而结果未知的不重放。空闲对话现在就送，不等用户再说话。
	resumeAdvances(undefined, { dispatch: true });
}

// 子代理只替换会话身份，工作区、权限、技能与审批仍走同一套扩展。
setSubagentDriver(subagentDriver);
