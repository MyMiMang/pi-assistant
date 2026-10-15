/**
 * 子代理失败分类与「原任务续跑」决策（DESIGN §21.9）。
 *
 * 目的：失败/中断后**不新开子代理**，而是在原子代理的原会话里从断点继续。这里只做纯分类，
 * 不碰数据库、不调模型，便于单测与跨模块复用。
 *
 * 分类边界（用户 2026-10-22 明确）：
 * - 网络断开 / 连接 reset / 临时 DNS / 超时 / 429 retry-after / 5xx / provider 临时不可用 /
 *   服务重启 → 可恢复：允许**有界退避**的自动重试（auto=true）。
 * - 上下文超限 / 永久 401·403 / 配置错 / 余额不足 / 模型被删 / 会话损坏 → 用户修好后可用
 *   原任务手动继续（auto=false，manual=true）。
 * - 用户 cancel / stop / 权限拒绝 → 不自动恢复；保留会话，允许显式手动继续。
 * - 未识别的错误 → **不自动重试**（不做全量白名单，避免盲目重放）；可由用户核验后手动继续。
 *
 * 绝不承诺 exactly-once：恢复时工具可能已执行也可能没执行，提示词要求先核实实际结果。
 */

export type ResumeClass = "transport" | "transient" | "config" | "context" | "session" | "blocked" | "unknown";

export interface ResumeInfo {
	cls: ResumeClass;
	/** 系统可以有界退避后自动重试续跑（连接类 / 服务临时不可用）。 */
	auto: boolean;
	/** 用户或主模型可显式用原 subagent id 继续。 */
	manual: boolean;
	/** 中文短标签，给界面 / 工具摘要用。 */
	label: string;
}

// 用户主动停止 / 权限拒绝：绝不自动恢复，但保留会话允许显式继续
const BLOCKED = /用户(?:或主会话)?停止|已停止|被用户停止|aborted by user|用户取消|用户拒绝了|审批.{0,6}拒绝|approval.{0,12}denied|permission denied by user/i;
// 会话损坏 / 无法读取：修好后手动继续
const SESSION = /session (?:file|store|state).*(?:corrupt|invalid|unreadable|not found)|会话.*(?:损坏|无效|不存在|无法读取|读取失败)/i;
// 上下文超限：整理后手动继续
const CONTEXT = /context (?:length|window)|maximum context|too many tokens|token (?:limit|count) exceeded|上下文(?:长度)?(?:超过|超)|超过.{0,10}上下文|上下文.{0,8}超/i;
// 网络 / 连接 / 超时：可有界退避自动续跑
const TRANSPORT = /ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|socket hang ?up|network (?:error|request failed)|fetch failed|connection (?:reset|refused|closed|error)|连接(?:被)?(?:重置|中断|关闭|失败)|网络|断网|\bDNS\b|offline|timed?[\s_-]*out|ETIMEDOUT|ESOCKETTIMEDOUT|请求超时|超时/i;
// 服务临时不可用 / 限流：可有界退避自动续跑
const TRANSIENT = /rate.?limit|too many requests|retry.?after|\b429\b|service unavailable|overloaded|temporarily unavailable|bad gateway|gateway timeout|\b50[0234]\b|限流|过载|暂时不可用|繁忙/i;
// 配置 / 凭据 / 额度 / 模型被删：修好后手动继续
const CONFIG = /unauthorized|invalid[\s_-]*api[\s_-]*key|authentication|incorrect api key|permission denied|forbidden|\b401\b|\b403\b|鉴权|密钥无效|api key|余额|欠费|insufficient|balance|quota|额度|模型不存在|模型不可用|模型已删除|unknown model|no such model|model.*not found|配置/i;

/** 有界自动重试的参数（连接类 / 服务临时不可用）。 */
export const TRANSPORT_RETRY = { maxAttempts: 3, baseMs: 500, maxMs: 8000 } as const;

/**
 * 分类一条失败原因，给出「能否自动重试 / 能否原 id 手动继续」。
 * 空原因按未识别处理：不自动重试，可由用户核验后手动继续。
 */
export function classifyResume(message?: string | null): ResumeInfo {
	const text = (message ?? "").trim();
	if (!text) return { cls: "unknown", auto: false, manual: true, label: "结果未知，请先核验再用原任务继续" };
	if (BLOCKED.test(text)) return { cls: "blocked", auto: false, manual: true, label: "已停止；可显式继续，但不会自动恢复" };
	if (SESSION.test(text)) return { cls: "session", auto: false, manual: true, label: "会话可能损坏，修复后可用原任务继续" };
	if (CONTEXT.test(text)) return { cls: "context", auto: false, manual: true, label: "上下文超限，整理后可用原任务继续" };
	if (TRANSPORT.test(text)) return { cls: "transport", auto: true, manual: true, label: "网络/连接问题，将有界退避后自动续跑" };
	if (TRANSIENT.test(text)) return { cls: "transient", auto: true, manual: true, label: "服务临时不可用，将有界退避后自动续跑" };
	if (CONFIG.test(text)) return { cls: "config", auto: false, manual: true, label: "配置或凭据问题，修好后可用原任务继续" };
	return { cls: "unknown", auto: false, manual: true, label: "原因未识别，不会自动重试；核验后可用原任务继续" };
}

/** 第 attempt 次（从 1 起）重试前的等待毫秒：指数退避 0.5×~1.5× 抖动，封顶 maxMs。 */
export function transportBackoffMs(attempt: number, rand: () => number = Math.random): number {
	const capped = Math.min(TRANSPORT_RETRY.maxMs, TRANSPORT_RETRY.baseMs * 2 ** Math.max(0, attempt - 1));
	return Math.round(Math.min(TRANSPORT_RETRY.maxMs, capped * (0.5 + rand())));
}

/** 这次失败是否可以再自动重试：只有连接类 / 服务临时不可用，且没到次数上限。 */
export function shouldAutoRetry(message: string | null | undefined, attempt: number): boolean {
	return classifyResume(message).auto && attempt < TRANSPORT_RETRY.maxAttempts;
}
