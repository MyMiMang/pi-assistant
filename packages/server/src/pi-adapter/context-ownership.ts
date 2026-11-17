/** 编程工具拥有上下文；Pi 只在明确溢出时整理一次，并继续已有输入。 */
import { calculateContextTokens, type AgentSession, type ExtensionFactory, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { CLI_PROVIDER_IDS } from "./cli-models/provider.ts";
import { compactSessionWithFallback } from "./compaction-fallback.ts";
import { subscribeSession, type AgentEvent } from "./session-events.ts";

type ContextModel = { provider: string; id: string; api?: string; contextWindow?: number };
let recoveryFallback: () => { provider: string; id: string } | null = () => null;
/** 宿主注入与手动入口相同的实时默认模型读取，避免反向依赖 models.ts。 */
export function setContextRecoveryFallback(read: typeof recoveryFallback) { recoveryFallback = read; }
/** native 注册允许宿主提供动态 provider；只认注册入口的精确协议，不按名字猜。 */
export const cliOwnsContext = (m: ContextModel | undefined): boolean => !!m && (CLI_PROVIDER_IDS.includes(m.provider) || m.api === `${m.provider}-acp-native`);
export function syncContextOwnership(s: Pick<AgentSession, "model" | "settingsManager">) {
	s.settingsManager.setCompactionEnabled(!cliOwnsContext(s.model));
}
export const contextOwnershipExtension = (settingsManager: SettingsManager): ExtensionFactory => (pi) => {
	pi.on("model_select", (event) => { settingsManager.setCompactionEnabled(!cliOwnsContext(event.model)); });
};

type Run = { cancelled: boolean; settled?: Extract<AgentEvent, { type: "settled" }>; listeners: Set<(event: AgentEvent) => void> };
const runs = new WeakMap<AgentSession, Run>();
/** 拦住恢复过程中的中间 settled，避免运行时提前释放会话 / 宣布任务完成。 */
export function subscribeContextSession(s: AgentSession, fn: (event: AgentEvent) => void): () => void {
	return subscribeSession(s, (event) => {
		const run = runs.get(s);
		if (run && event.type === "settled") {
			run.settled = event;
			run.listeners.add(fn);
		} else fn(event);
	});
}
export function cancelContextRecovery(s: AgentSession) {
	const run = runs.get(s);
	if (run) run.cancelled = true;
}

/** 当前模型最后一次有效工具回报；没有回报就未知，绝不估算 Pi 历史或借用别的模型。 */
export function reportedContextTokens(s: Pick<AgentSession, "model" | "messages">): number | null {
	for (let i = s.messages.length - 1; i >= 0; i--) {
		const m = s.messages[i];
		if (m.role !== "assistant" || m.provider !== s.model?.provider || m.model !== s.model?.id || m.stopReason === "error" || m.stopReason === "aborted") continue;
		const tokens = calculateContextTokens(m.usage);
		if (Number.isFinite(tokens) && tokens > 0) return tokens;
	}
	return null;
}

/** submit 只调用一次：恢复用公开隐藏消息启动新轮，不重放用户文字 / 附件 / 技能。 */
export async function runWithContextRecovery(s: AgentSession, submit: () => Promise<void>): Promise<void> {
	syncContextOwnership(s);
	// 插话归已有轮次所有；不能为排队消息再开启恢复循环。
	if (!cliOwnsContext(s.model) || s.isStreaming || runs.has(s)) return submit();
	const run: Run = { cancelled: false, listeners: new Set() };
	runs.set(s, run);
	const model = s.model;
	try {
		await submit();
		const last = s.messages.at(-1);
		if (run.cancelled || run.settled?.aborted || !cliOwnsContext(s.model) || s.model !== model || last?.role !== "assistant" || last.provider !== model?.provider || last.model !== model.id || last.stopReason !== "error" || !isContextOverflow(last)) return;
		// 明确溢出的请求没有正文或工具调用才可安全重试。已发生的步骤保留，不重放。
		if (last.content.some((b) => b.type === "toolCall" || (b.type === "text" && b.text.trim()) || (b.type === "thinking" && b.thinking.trim()))) return;
		await compactSessionWithFallback(s, undefined, recoveryFallback() ?? undefined);
		if (run.cancelled || s.model !== model) return;
		await s.sendCustomMessage({
			customType: "cli-context-recovery",
			content: "（系统通知）上下文已整理。请继续完成上文尚未回答的用户请求；已完成的步骤不要重做，状态不明的操作先核实。",
			display: false,
		}, { triggerTurn: true });
	} finally {
		runs.delete(s);
		if (run.settled) for (const fn of run.listeners) fn({ ...run.settled, aborted: run.cancelled || run.settled.aborted });
	}
}

export function contextUsage(s: AgentSession): { tokens: number | null; contextWindow: number | null } {
	if (cliOwnsContext(s.model)) return { tokens: reportedContextTokens(s), contextWindow: s.model?.contextWindow ?? null };
	const u = s.getContextUsage();
	return { tokens: u?.tokens ?? null, contextWindow: u?.contextWindow ?? s.model?.contextWindow ?? null };
}

/** 输入框圆环与模型详情共用；累计账本继续由 Pi 统计。 */
export function sessionStats(s: AgentSession) {
	const ctx = contextUsage(s);
	const st = s.getSessionStats();
	return {
		...ctx,
		percent: ctx.tokens != null && ctx.contextWindow ? Math.min(100, Math.round((ctx.tokens / ctx.contextWindow) * 1000) / 10) : null,
		model: s.model ? { provider: s.model.provider, id: s.model.id, name: s.model.name } : null,
		session: st ? { tokens: st.tokens, cost: st.cost, userMessages: st.userMessages, assistantMessages: st.assistantMessages, toolCalls: st.toolCalls } : null,
	};
}
