/**
 * 模型服务（尤其中转站）的额度 / 限流 / 冷却报错 → 一句中文，带上服务给出的恢复时间。
 * 服务端（测试连接、记忆健康）和网页（聊天里的错误）共用；原文仍另外放在详情 / ? 提示里。
 * 真机（2026-10）：中转站回 400 「频率限制…15:04:53 重置」/ "per-model cooldown"，原文直接给用户看不懂。
 */
const QUOTA = /insufficient_quota|exceeded your (?:current )?quota|quota (?:exceeded|exhausted|reached)|credit balance|out of credits|usage_limit_reached|额度(?:已)?(?:用完|耗尽|不足)|配额(?:已)?(?:用完|耗尽)|余额不足/i;
const COOLDOWN = /cool-?down|冷却/i;
const RATE = /rate.?limit|too many requests|\b429\b|频率限制|限流|请求过多|请求太频繁|频率超限/i;

/** 服务给出的恢复时间：「15:04:53 重置」、reset at 2026-10-26T07:04:53Z、retry after 30s */
export function limitResetHint(raw: string): string {
	const iso = raw.match(/\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/);
	if (iso && /reset|retry|重置|恢复|until|直到/i.test(raw)) {
		const d = new Date(iso[1].replace(" ", "T"));
		if (!Number.isNaN(d.getTime())) return `约 ${d.toLocaleTimeString("zh-CN", { hour12: false })} 恢复`;
	}
	const clock = raw.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:后)?\s*(?:重置|恢复|解除|reset)/i) ?? raw.match(/(?:reset|重置|恢复|until|直到)[^\d]{0,12}(\d{1,2}:\d{2}(?::\d{2})?)/i);
	if (clock) return `约 ${clock[1]} 恢复`;
	const secs = raw.match(/(?:retry|try again)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(s|sec|seconds?|秒|m|min|minutes?|分钟)(?![a-z])/i) ?? raw.match(/(\d+)\s*(秒|分钟)后(?:重试|再试|恢复|重置)/);
	if (secs) return `约 ${secs[1]} ${/^(m|min|分)/i.test(secs[2]) ? "分钟" : "秒"}后恢复`;
	return "";
}

/** 是额度 / 限流 / 冷却就返回一句中文，否则 null（交给其它分类） */
export function modelLimitText(raw: string): string | null {
	if (!raw) return null;
	const hint = limitResetHint(raw);
	const when = hint ? `，${hint}` : "";
	if (QUOTA.test(raw)) return `模型服务的额度已用完${when}：充值 / 等额度恢复后再试，或先换一个可用模型`;
	if (COOLDOWN.test(raw)) return `模型服务正在冷却（这个模型请求太频繁被暂时限制）${when}：等一会儿再试，或换个模型`;
	if (RATE.test(raw)) return `模型服务限流（请求太频繁）${when}：等一会儿再试，或换个模型`;
	return null;
}
