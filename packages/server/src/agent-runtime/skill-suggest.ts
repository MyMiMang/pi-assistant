/** 技能建议：一轮结束后看要不要提议新建 / 更新技能。 */
import { beginProposal, expireProposal, observeTurn, proposalPrompt, recordSuggestion, resolveSuggestion, type Suggestion, suggestionPrompt } from "../skill-intel.ts";
import { latestUserMessage } from "./extensions.ts";
import { runtime } from "./agent-runtime.ts";

// ---------------------------------------------------------------- 技能建议

/** 对话 → 正在等 diff 审批的“更新技能”建议 */
export const pendingUpdates = new Map<string, string>();

export async function maybeSuggest(agentId: string, conversationId: string | null, turn: { userText: string; tools: string[]; usedSkills: string[]; reply?: string; ok?: boolean }) {
	const sg: Suggestion | null = observeTurn({ agentId, conversationId, ...turn });
	if (!sg) return;
	const rt = runtime(agentId, conversationId);
	const sourceUserId = latestUserMessage(conversationId)?.id;
	// 稍等：让这轮的回复先显示出来，再提建议
	await new Promise((r) => setTimeout(r, 400));
	// 用户已经开始下一轮时不排一条过时建议（即使新轮很快已结束）。
	if (rt.busy || latestUserMessage(conversationId)?.id !== sourceUserId) return;
	if (sg.kind === "update") {
		// 更新已有技能：直接让助理起草修改，用户在 diff 审批卡片上决定（一张卡片，不重复打扰）
		const id = recordSuggestion(agentId, conversationId, sg);
		pendingUpdates.set(conversationId ?? "", id);
		try {
			await rt.nudge(suggestionPrompt(sg), { onlyIdle: true });
		} finally {
			// 正常保存时confirmUpdate已处理；模型没有起草/调用失败也不留悬空更新。
			if (pendingUpdates.get(conversationId ?? "") === id) {
				pendingUpdates.delete(conversationId ?? "");
				resolveSuggestion(id, "expired");
			}
		}
		return;
	}
	// 新建：先记候选，再复用当前会话一次建议轮总结用途（不另设模型服务/不换模型）；
	// 模型调用 skill_propose 才出卡片；nudge 结束仍未提交（或失败/中断）就作废，不留半条 pending。
	const id = beginProposal(agentId, conversationId, sg);
	try {
		await rt.nudge(proposalPrompt(sg, id), { onlyIdle: true, allowEmpty: true });
	} catch {
		/* nudge 自己会把失败返回 false；异常同样清理 */
	} finally {
		expireProposal(id);
	}
}
