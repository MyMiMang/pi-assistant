/** 子代理驱动：只替换会话身份，工作区、权限、技能与审批仍走同一套扩展。 */
import { createAgentSession } from "./agent-session.ts";
import { subagentNotifyText } from "../subagent-supervision.ts";
import { toolExpectMs } from "../subagent-stuck.ts";
import { awaitChildResults } from "../helper-scope.ts";
import { setSubagentDriver, getSubagent, subagentActivity, isActiveSubagent, switchSubagentModel, planFallback, livePool, modelKey, resolveSubagentThinking, resolveSubagentFast, setSubagentRetryAt, type Subagent, type SubagentEvent } from "../subagents.ts";
import { classifyModelError, isRecoverableModelError } from "../model-errors.ts";
import { assessResumeSafety, shouldAutoRetry, transportBackoffMs, TRANSPORT_RETRY_PROMPT } from "../subagent-resume.ts";
import { join } from "node:path";
import { db } from "../db.ts";
import { updateMessage } from "../messages.ts";
import { defaultThinking, models } from "../models.ts";
import { abortSession, type AgentSession, applyModelSettings, disposeSession, lastAssistantText, promptSession, sessionFileOf, branchMessagesOf, subscribeSession, INTERJECTION_PREFIX } from "../pi-adapter/index.ts";
import { attachFastMode } from "../pi-adapter/fast-mode.ts";
import { getAgent, setAgentStatus } from "./rows.ts";
import { bindSession } from "./bind-session.ts";
import { runtime } from "./agent-runtime.ts";

export const subagentDriver: Parameters<typeof setSubagentDriver>[0] = {
	async run(r, connect, input) {
		const a = getAgent(r.agent_id);
		if (!a) throw new Error("所属助理已删除");
		const agentThinking = (m: { provider: string; id: string }) => resolveSubagentThinking(r.agent_id, m, a.thinking ?? defaultThinking(), getSubagent(r.id)?.thinking ?? r.thinking);
		// 派活时定好的候选顺序（第一项就是实际用的）；模型可能后来被删，先过滤成当前配置着的
		const stored = ((): { provider: string; id: string }[] => {
			try { const v = JSON.parse(r.model_pool ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
		})();
		// 帮手最多再派一层：第一层能派（巡检除外，保持安静便宜），第二层不能
		const nest = !r.parent_subagent_id && r.kind !== "heartbeat";
		const candidates = livePool([{ provider: r.model_provider, id: r.model_id }, ...stored.filter((m) => modelKey(m) !== `${r.model_provider}/${r.model_id}`)]);
		if (!candidates.length) throw new Error("帮手模型已不可用，候选池里也没有其他可用模型");
		let current = candidates[0];
		let session: AgentSession | null = null;
		// 每候选最多试一次：初始化阶段失败的候选也要记进 tried，避免请求阶段 fallback 又绕回它。
		const tried = new Set<string>();
		for (let i = 0; i < candidates.length && !session; i++) {
			try {
				session = await createAgentSession(a, {
					sessionDir: join("subagents", r.id),
					sessionFile: r.session_file,
					model: { provider: candidates[i].provider, id: candidates[i].id }, thinking: agentThinking(candidates[i]),
					rules: [`你是后台帮手，执行分配的任务。${nest ? "可以再派最多一层帮手（spawn_subagent），只用于可并行或耗时的大块；你派的帮手不能再派。派了就由系统等它们结束、把结果交给你整合。" : "不能再派帮手；没有 spawn_subagent/spawn_task 工具。"}用户可以进入你的会话直接补充要求或继续聊，请在此会话回应。每轮完成后结果和文件也会交给主会话核验汇报：最后用几句话给出结果摘要（做了什么、产出在哪、还有什么没做），不要复述过程。你用 memory_remember 记下的是 task 草稿（默认不会写进共享的「关于用户」事实库），由主会话核验后才会晋升为长期事实；属于群任务的，任务通过核验后自动转正。`, ...(r.scope ? [r.scope] : [])],
					conversationId: r.conversation_id, taskId: r.id, ext: { allowSpawn: nest, subagentId: r.id, actor: "subagent" },
				});
				current = candidates[i];
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				tried.add(modelKey(candidates[i]));
				// 模型不存在 / 服务不可用等可恢复故障：换池内下一个；否则原样抛出
				if (i < candidates.length - 1 && isRecoverableModelError(msg)) { switchSubagentModel(r.id, candidates[i + 1], `模型 ${candidates[i].provider}/${candidates[i].id} 不可用（${msg}），自动切换`); continue; }
				throw e;
			}
		}
		if (!session) throw new Error("候选池里没有可用模型");
		// 子代理 Fast：默认跟随所属助理，单个子代理可独立覆盖；每次请求重新读（运行中改也生效）
		const fast = attachFastMode(session, () => resolveSubagentFast(r.agent_id, getSubagent(r.id)?.fast ?? r.fast));
		db.prepare("UPDATE subagents SET session_file = ? WHERE id = ?").run(sessionFileOf(session) ?? null, r.id);
		let error: string | undefined;
		const routed: string[] = [];
		let started = false;
		const early: string[] = [];
		const unBind = bindSession(session, a.id, r.conversation_id, null, () => {}, r.id, undefined, fast);
		const unActivity = subscribeSession(session, (e) => {
			if (e.type === "user_start" && !started) {
				started = true;
				queueMicrotask(() => { for (const text of early.splice(0)) void promptSession(session, text).catch((e) => { error = String(e); }); });
			}
			if (e.type === "assistant_end") error = e.error;
			if (e.type === "user_start" && e.text.startsWith(INTERJECTION_PREFIX)) {
				const mid = routed.shift();
				if (mid) updateMessage(mid, { meta: { delivery: "delivered", routedTo: r.id } });
			}
			const toolMs = e.type === "tool_start" ? toolExpectMs(e.args) : e.type === "tool_end" ? 0 : undefined;
			subagentActivity(r.id, toolMs);
		});
		connect(() => abortSession(session), async (text, mid) => {
			if (mid) routed.push(mid);
			if (!started) early.push(text);
			else await promptSession(session, text);
		}, async (model, thinking) => {
			// 运行中改思考强度：直接调 pi-adapter 公开的 applyModelSettings（不重建会话、不动主会话）
			await applyModelSettings(session, models, model, thinking);
		});
		// 续跑前的副作用核验：只读公开会话原始历史 / 落库文件，不碰模型与凭据
		const safetyOfSession = () => assessResumeSafety(branchMessagesOf(session));
		try {
			if (!isActiveSubagent(getSubagent(r.id)!.status)) return "";
			if (input?.messageId) updateMessage(input.messageId, { meta: { delivery: "delivered" } });
			// 后台任务 / 定时 / 巡检的帮手：任务说明本身就是完整指令（触发方已经写好），不再套派活前缀
			const firstPrompt = input?.text ?? (r.kind ? r.task : `（后台帮手任务）${r.task}\n\n必要上下文：\n${r.context}`);
			await promptSession(session, firstPrompt);
			// 连接类 / 服务临时不可用：同一会话有界退避重试。退避期间只等时钟、不发模型请求（不忙轮询），可被停止打断。
			for (let attempt = 1; shouldAutoRetry(error, attempt) && isActiveSubagent(getSubagent(r.id)!.status); attempt++) {
				// 先证明没有「已派发、结果未落库」的工具调用：提示模型别重做不是幂等保证，有未知副作用就停下核验
				const safety = safetyOfSession();
				if (!safety.safe) {
					error = safety.reason;
					break;
				}
				const wait = transportBackoffMs(attempt);
				setSubagentRetryAt(r.id, Date.now() + wait);
				subagentActivity(r.id);
				const end = Date.now() + wait;
				while (Date.now() < end && isActiveSubagent(getSubagent(r.id)!.status)) await new Promise((res) => setTimeout(res, Math.min(200, end - Date.now())));
				setSubagentRetryAt(r.id, null);
				if (!isActiveSubagent(getSubagent(r.id)!.status)) break;
				error = undefined;
				// 只续模型轮次：发「先核验、不重做」的续跑指令，**不重发原任务**（firstPrompt 是原始任务，重发会重放已执行的副作用）
				await promptSession(session, TRANSPORT_RETRY_PROMPT);
			}
			// 模型层可恢复故障：池内换下一个模型，从已保存的会话继续，不从头重跑；每个候选最多试一次，用尽就明确停下
			while (isActiveSubagent(getSubagent(r.id)!.status)) {
				tried.add(modelKey(current));
				const next = planFallback(candidates, tried, error);
				if (!next) break;
				// 换模型继续同样是「续跑」：结果未知的副作用同样不允许自动重放，停下核验
				const safety = safetyOfSession();
				if (!safety.safe) {
					error = safety.reason;
					break;
				}
				switchSubagentModel(r.id, next, `${classifyModelError(error)?.label ?? "模型请求失败"}：${error}`);
				current = next;
				error = undefined;
				await applyModelSettings(session, models, next, agentThinking(next));
				await promptSession(session, `（系统通知）上一个模型不可用，已切换到 ${next.provider}/${next.id}。请从断点继续完成这个任务：已经完成的步骤不要重做，也不要重复已经产生的副作用；某个操作状态不明的，先核实实际结果再决定。`);
			}
			if (error) throw new Error(error);
			// 自己派的下一层帮手：等它们结束、把结果交给自己整合（有界：最多 5 轮）
			const seen = new Set<string>();
			for (let round = 0; nest && round < 5; round++) {
				const note = await awaitChildResults(r.id, seen, () => isActiveSubagent(getSubagent(r.id)!.status));
				if (!note || !isActiveSubagent(getSubagent(r.id)!.status)) break;
				await promptSession(session, note);
				if (error) throw new Error(error);
			}
			return lastAssistantText(session);
		} finally {
			for (const mid of routed) updateMessage(mid, { meta: { delivery: "stopped" } });
			unBind(); unActivity(); await disposeSession(session);
		}
	},
	async notify(r: Subagent, event: SubagentEvent) {
		const parent = runtime(r.agent_id, r.conversation_id);
		const session = await parent.ensure();
		if (!session) throw new Error("主会话没有可用模型");
		const marker = `（帮手事件 ${event.id}）`;
		const files = db.prepare("SELECT meta FROM messages WHERE (subagent_id = ? OR task_id = ?) AND json_array_length(meta, '$.attachments') > 0").all(r.id, r.id) as { meta: string }[];
		const artifacts = files.flatMap((m) => (JSON.parse(m.meta).attachments ?? [])).map((f: { name: string; workspacePath?: string }) => `${f.name}：${f.workspacePath ?? "工作区内"}`).join("\n");
		// 只发短标题 + 结果摘要：完整任务说明与最新结果可用 subagent_list 按 id 查（摘要截断时会明确给出查询入口），不重复整段 task（省 token）。
		const text = subagentNotifyText(r, event, artifacts);
		await new Promise<void>((resolve, reject) => {
			const unsub = subscribeSession(session, (e) => {
				if (e.type === "user_start" && e.text.includes(marker)) { unsub(); resolve(); }
				else if (e.type === "settled") { unsub(); reject(new Error("事件送达前主会话已停止")); }
			});
			setAgentStatus(r.agent_id, "running");
			void promptSession(session, text).catch((e) => { unsub(); reject(e); });
		});
	},
};
