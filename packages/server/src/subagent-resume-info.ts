/** 帮手行 + 恢复摘要（给 subagent_list / 接口用）：从 subagents.ts 拆出，规则不变。 */
import { classifyResume, sessionResumeSafety } from "./subagent-resume.ts";
import { repeatBlocked } from "./subagent-stuck.ts";
import { isLiveSubagent, listSubagents, type Subagent, type SubagentSummary } from "./subagents.ts";

/** 子代理行 + 恢复摘要：给 subagent_list / 接口用，供主模型判断「优先续跑而不是重派」。 */
export function withResumeInfo(r: Subagent): SubagentSummary {
	const info = classifyResume(r.error_reason ?? r.result_summary ?? "");
	const terminal = !isLiveSubagent(r.status);
	// 只有终态、且装了会话的行才需要读文件核验副作用（读不到按不安全处理，不自动续跑）
	const safety = terminal && r.status !== "done" && r.session_file ? sessionResumeSafety(r.session_file) : undefined;
	return {
		...r,
		retryable: info.auto,
		resumeReason: info.label,
		canResume: terminal && r.status !== "done" && info.manual && !!r.session_file && !repeatBlocked(r), // 同一原因失败 3 次起不能原样续跑
		waitingRetry: r.retry_at != null,
		...(safety && !safety.safe ? { needsVerify: true, pendingToolNames: [...new Set(safety.pendingToolCalls.map((p) => p.name))] } : {}),
	};
}
export const listSubagentSummaries = (agentId?: string, conv?: string) => listSubagents(agentId, conv).map(withResumeInfo);
