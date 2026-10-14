/**
 * 判断一次「模型请求」失败是不是明确可恢复的故障（限流 / 服务不可用 / 模型不存在 / 鉴权不通等）。
 * 只用于子代理的池内自动 fallback：返回 true 才会换池内下一个模型重试。
 *
 * 边界（用户 2026-10-15 定）：
 * - 只处理模型层的错误。工具 / 命令失败不算模型失败（它们不会走到这里，这里也额外挡一层）。
 * - 用户主动停止（abort）不算故障，由调用方单独判断，不走这里。
 * - 权限拒绝（审批 deny）不算模型故障，绝不因此换模型绕过。
 * - 未知错误一律当不可恢复：宁可明确停下，也不擅自换模型。
 */

/** 明确可恢复的模型故障分类，便于把原因写清楚给用户看。 */
export type ModelErrorKind = "rate_limit" | "unavailable" | "model_missing" | "auth" | "timeout";

const PATTERNS: { kind: ModelErrorKind; label: string; re: RegExp }[] = [
	{ kind: "model_missing", label: "模型不存在或不可用", re: /模型不存在|模型不可用|模型已删除|unknown model|no such model|model[\s_-]*(?:not found|does not exist|unavailable|unknown|invalid)|not a valid model|invalid model/i },
	{ kind: "auth", label: "鉴权失败", re: /unauthorized|invalid[\s_-]*api[\s_-]*key|authentication|incorrect api key|permission denied|forbidden|\b401\b|\b403\b|鉴权|密钥无效|api key/i },
	{ kind: "rate_limit", label: "触发限流", re: /rate.?limit|too many requests|quota|tpm|rpm|\b429\b|限流|频率|请求过多|超限/i },
	{ kind: "unavailable", label: "服务暂时不可用", re: /service unavailable|overloaded|temporarily unavailable|bad gateway|gateway timeout|\b50[0234]\b|服务不可用|过载|繁忙|暂时不可用/i },
	{ kind: "timeout", label: "请求超时", re: /timed?[\s_-]*out|ETIMEDOUT|ESOCKETTIMEDOUT|timeout of|请求超时|超时/i },
];

/** 明显不是模型故障的错误：工具 / 命令 / 权限拒绝 / 用户停止 —— 绝不换模型。 */
const NOT_MODEL = /审批|approval|denied|permission denied by user|用户拒绝|工具|tool[\s_-]*error|命令执行失败|command failed|ENOENT|EACCES|not permitted|被用户停止|aborted by user/i;

export interface ModelErrorInfo {
	kind: ModelErrorKind;
	label: string;
}

/** 分类一条模型错误；不可恢复返回 null。 */
export function classifyModelError(message?: string | null): ModelErrorInfo | null {
	const text = (message ?? "").trim();
	if (!text) return null;
	if (NOT_MODEL.test(text)) return null;
	for (const p of PATTERNS) if (p.re.test(text)) return { kind: p.kind, label: p.label };
	return null;
}

export function isRecoverableModelError(message?: string | null): boolean {
	return classifyModelError(message) !== null;
}
