/** 只为应用主动调用的手动整理临时选择摘要模型，不改变会话模型。 */
import { compact, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

type ModelRef = { provider: string; id: string };
const fallbackFor = new Map<string, ModelRef>();
const retrying = new Set<string>();

/** 摘要请求被服务拒绝才换模型；限流、网络故障和无须整理不在此列。 */
export function isProviderRefusal(message: string): boolean {
	const status = /Summarization failed:\s*(4\d{2})\b/.exec(message)?.[1];
	return status !== undefined && status !== "429";
}

/** 第一次摘要被拒后还会重试时，不向聊天插入中间失败消息。 */
export function refusalWillRetry(sessionId: string, error: string): boolean {
	return retrying.has(sessionId) && isProviderRefusal(error);
}

export const compactionFallbackExtension: ExtensionFactory = (pi) => {
	pi.on("session_before_compact", async (event, ctx) => {
		const fallback = fallbackFor.get(ctx.sessionManager.getSessionId());
		if (!fallback) return;
		const model = ctx.modelRegistry.find(fallback.provider, fallback.id);
		// 以下模型/认证异常会被 Pi runner 吞掉并 emitError，随后仍用原模型整理，不会直接报给用户。
		if (!model) throw new Error(`整理备用模型不存在：${fallback.provider}/${fallback.id}`);
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		const headers = auth.headers && Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => entry[1] !== null));
		return { compaction: await compact(event.preparation, model, auth.apiKey, headers, event.customInstructions, event.signal) };
	});
};

/** Pick 允许单测注入 compact；实际会话仍走 Pi 的公开手动整理入口。 */
export async function compactWithFallback(s: Pick<AgentSession, "compact" | "model" | "sessionId">, instructions?: string, fallback?: ModelRef) {
	const canFallback = !!fallback && !(s.model?.provider === fallback.provider && s.model.id === fallback.id);
	if (!canFallback) return s.compact(instructions);
	retrying.add(s.sessionId);
	try {
		return await s.compact(instructions);
	} catch (error) {
		if (!isProviderRefusal(error instanceof Error ? error.message : String(error))) throw error;
	} finally {
		retrying.delete(s.sessionId);
	}
	fallbackFor.set(s.sessionId, fallback);
	try {
		return await s.compact(instructions);
	} finally {
		fallbackFor.delete(s.sessionId);
	}
}

export async function compactSessionWithFallback(s: AgentSession, instructions?: string, fallback?: ModelRef) {
	const r = await compactWithFallback(s, instructions, fallback);
	return { tokensBefore: r.tokensBefore, summary: r.summary };
}
