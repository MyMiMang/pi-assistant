/** 把一个 Pi 会话的事件落盘为消息并广播（主会话 / 后台任务 / 子代理共用）。 */
import { recordUsage } from "../usage/index.ts";
import { bus } from "../bus.ts";
import { splitThinking } from "../thinking.ts";
import { deleteMessage, insertMessage, updateMessage } from "../messages.ts";
import { type AgentSession, subscribeSession } from "../pi-adapter/index.ts";
import { fastMetaOf, type FastTracker } from "../pi-adapter/fast-mode.ts";

/** 把一个 Pi 会话的事件落盘并广播。 */
export function bindSession(session: AgentSession, agentId: string, conversationId: string | null, taskId: string | null, onSettled: (aborted: boolean) => void, subagentId?: string, pendingUserEntries?: string[], fastTracker?: FastTracker, allowEmpty?: () => boolean) {
	const insert = (m: Parameters<typeof insertMessage>[0]) => insertMessage({ ...m, subagentId });
	let cur: { id: string; text: string; thinking: string; flushAt: number } | null = null;
	// app 消息 ↔ Pi entry 的映射：assistant 消息的 id（供紧随 message_end 的 entry_id 事件落 meta.piEntryId）
	let lastAssistantMid: string | null = null;
	const tools = new Map<string, string>();

	/** 把刚写进 Pi 会话文件的 entry id 落到 app 消息的 meta.piEntryId（不额外广播 message.updated，避免刷屏）。 */
	const mapEntry = (e: { entryId: string; role: string; toolCallId?: string }) => {
		if (e.role === "assistant" && lastAssistantMid) {
			updateMessage(lastAssistantMid, { meta: { piEntryId: e.entryId } }, false);
			lastAssistantMid = null;
			return;
		}
		if (e.role === "toolResult" && e.toolCallId) {
			const mid = tools.get(e.toolCallId);
			if (mid) {
				updateMessage(mid, { meta: { piEntryId: e.entryId } }, false);
				tools.delete(e.toolCallId);
			}
			return;
		}
		if (e.role === "user" && conversationId) {
			// 用户消息按发送顺序（FIFO）配对：Pi 把 user 消息按送达顺序持久化（普通发送 / 插话都在各自 message_end 时才落盘），
			// 每条 app 消息在 send() 时入队，这里按同一顺序出队——不靠「第几个 / 同文本」猜，连发同文本也不会串。
			const mid = pendingUserEntries?.shift();
			if (mid) updateMessage(mid, { meta: { piEntryId: e.entryId } }, false);
			return;
		}
	};
	return subscribeSession(session, (e) => {
		switch (e.type) {
			case "assistant_start": {
				// 先写库再显示：先插入空的“流式中”消息
				const m = insert({ agentId, conversationId, taskId, role: "assistant", content: "", status: "streaming" });
				cur = { id: m.id, text: "", thinking: "", flushAt: Date.now() };
				break;
			}
			case "text_delta":
				if (!cur) break;
				cur.text += e.delta;
				bus.emit({ type: "message.delta", id: cur.id, agentId, taskId, subagentId, delta: e.delta });
				if (Date.now() - cur.flushAt > 800) {
					updateMessage(cur.id, { content: cur.text }, false);
					cur.flushAt = Date.now();
				}
				break;
			case "thinking_delta":
				// 原生思考：App 里实时显示在可折叠的「思考」里（不进正文、不发到外部渠道）
				if (!cur) break;
				cur.thinking += e.delta;
				bus.emit({ type: "message.delta", id: cur.id, agentId, taskId, subagentId, delta: e.delta, thinking: true });
				if (Date.now() - cur.flushAt > 800) {
					updateMessage(cur.id, { meta: { thinking: cur.thinking } }, false);
					cur.flushAt = Date.now();
				}
				break;
			case "assistant_end": {
				// 服务可能直接结束而没有start；正文、失败或空最终结果也必须照常落库。
				if (!cur) {
					const m = insert({ agentId, conversationId, taskId, role: "assistant", content: "", status: "streaming" });
					cur = { id: m.id, text: "", thinking: "", flushAt: Date.now() };
				}
				// 用量：每次调用记一行（按当时价格算费用），摘要放进消息 meta 供悬停查看
				let usage: ReturnType<typeof recordUsage> | null = null;
				if (e.usage && e.provider && e.model) {
					try {
						usage = recordUsage({ agentId, provider: e.provider, model: e.model, conversationId, subagentId, messageId: cur.id, ...e.usage });
					} catch (err) {
						console.error("[usage] 记录用量失败", err);
					}
				}
				const fm = fastMetaOf(fastTracker?.snapshot());
				// 失败时也保留已经收到的部分正文/思考；错误由程序显示，不再请求模型解释额度。
				const { text, thinking: inline } = splitThinking(e.text);
				const thinking = [cur.thinking.trim(), inline].filter(Boolean).join("\n\n");
				const meta = { model: `${e.provider}/${e.model}`, ...(usage ? { usage } : {}), ...(thinking ? { thinking: thinking.slice(0, 20000) } : {}), ...(fm ? { fast: fm } : {}) };
				lastAssistantMid = cur.id;
				if (e.aborted) updateMessage(cur.id, { content: text, status: "interrupted", meta });
				else if (e.error) updateMessage(cur.id, { content: text, status: "error", meta: { ...meta, error: e.error } });
				else if (!text.trim() && !thinking && (e.hasToolCalls || allowEmpty?.())) {
					// 纯工具中间态、宿主明确允许无输出的技能用途内部轮不留空引用；服务错误仍优先显示。
					deleteMessage(cur.id);
					lastAssistantMid = null;
				} else if (!text.trim() && !thinking) updateMessage(cur.id, { content: "", status: "error", meta: { ...meta, error: "这次未收到回复，服务未提供具体原因" } });
				else updateMessage(cur.id, { content: text, status: "done", meta });
				cur = null;
				break;
			}
			case "entry_id":
				mapEntry(e);
				break;
			case "tool_start": {
				const m = insert({ agentId, conversationId, taskId, role: "tool", content: "", status: "running", meta: { toolName: e.name, args: e.args, toolCallId: e.id } });
				tools.set(e.id, m.id);
				break;
			}
			case "tool_end": {
				const mid = tools.get(e.id);
				if (mid) updateMessage(mid, { status: e.isError ? "error" : "done", meta: { result: e.resultText.slice(0, 4000) } });
				// 不从 tools 里删：toolResult 的 entry id 在 message_end 之后才到，那时还要用它落 meta.piEntryId（落完再删）
				break;
			}
			case "settled":
				if (cur) {
					// 流意外收尾没发message_end也不能永远显示空回复/光标。
					updateMessage(cur.id, { content: cur.text, status: e.aborted ? "interrupted" : "error", meta: { ...(cur.thinking ? { thinking: cur.thinking.slice(0, 20000) } : {}), ...(!e.aborted ? { error: "回复流意外结束，服务未提供具体原因" } : {}) } });
					cur = null;
				}
				onSettled(e.aborted);
				break;
			case "compaction_end":
				if (taskId) break;
				if (e.ok)
					insert({
						agentId,
						conversationId,
						role: "system",
						content: `${e.reason === "manual" ? "已整理上下文" : "对话较长，已自动整理前文"}：较早的内容压缩成了摘要（约 ${Math.round((e.tokensBefore ?? 0) / 1000)}k tokens → 摘要），最近的消息保持原样。`,
						meta: { kind: "compaction", summary: e.summary?.slice(0, 4000) },
					});
				else if (!e.aborted && e.error) insert({ agentId, conversationId, role: "system", content: `整理上下文失败：${e.error}`, status: "error" });
				break;
		}
	});
}
