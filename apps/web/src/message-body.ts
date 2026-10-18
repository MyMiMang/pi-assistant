/**
 * 一条助手消息「正文气泡该怎么显示」——纯函数，单独放这里便于 node:test 直接测（不需要 DOM / 浏览器）。
 *
 * 背景（真机事故）：请求失败的那一轮，服务端落库是 `content: ""` + `status: "error"`，
 * 错误原因只在气泡里渲染。旧实现的气泡渲染条件是 `body || (streaming && !thinking)`，
 * 于是失败的轮次**整个气泡都不渲染** → 界面上只剩「引用」按钮，看起来像「助理回复了但正文空白」。
 * 结论：错误 / 中断本身就是一种「要显示的内容」，不能拿「有没有正文」当唯一条件。
 *
 * 另两个真实事故（2026-10）：
 * - Codex 额度耗尽的错误被归成「限流」还让用户重发；实际上重发没用，只能等额度恢复或换模型。
 * - 旧记录里有 `status: "done"` + `content: ""` + 无 thinking / 无附件 的空回合，界面上同样只剩引用。
 * 这里把「额度 / 限流 / 鉴权 / 超时 / 网络 / 上下文 / 服务端 / 未知」分开，并给旧空记录一句兜底说明；
 * 工具步骤占位、流式光标、思考折叠、用户停止都不走兜底，避免把正常的中间态说成出错。
 */

export type BotBodyInput = {
	/** 已去掉思考后的正文（splitThinking 之后的 text） */
	body: string;
	/** 这一轮是否有思考内容（决定流式中要不要先占位显示气泡） */
	thinking: boolean;
	status: string;
	/** 消息 meta.error（服务端已脱敏；这里再兼容对象 / 数组 / JSON 串等历史形态） */
	error?: unknown;
	/** 这一轮是否还有附件等其它可见内容（有内容就不算「空回复」） */
	hasAttachments?: boolean;
	/** 这一轮是工具步骤占位（tool 消息 / toolCall 占位 / 同一轮里只有步骤），不兜底成「没收到回复」 */
	toolOnly?: boolean;
};

/** 错误类型：额度耗尽与普通限流必须分开，未知不臆测。 */
export type ErrorKind = "quota" | "rate_limit" | "auth" | "context" | "timeout" | "network" | "server" | "unknown";

export type BotBodyView = {
	/** 是否渲染正文气泡（false 时这一轮只有思考 / 步骤 / 操作按钮） */
	showBubble: boolean;
	showError: boolean;
	errorKind: ErrorKind;
	/** 给人看的一句中文（已知错误翻成人话，未知保留可读原文） */
	errorText: string;
	/** 服务返回的可读信息（已过滤凭据、截断），放可展开详情，手机上也能点开 */
	errorDetail: string;
	/** 可读错误原文（不含凭据），供排查与测试 */
	errorRaw: string;
	showInterrupted: boolean;
	/** 「已中断」或「已停止」 */
	interruptedText: string;
	/** 旧记录兜底：已结束、没有正文 / 思考 / 附件、也不是工具占位 */
	showEmpty: boolean;
	emptyText: string;
};

const MAX_MAIN = 120;
const MAX_DETAIL = 400;

/** 已结束但没有任何内容的回合：旧版本 / 服务端异常都可能留下这种记录。 */
const EMPTY_TERMINAL = new Set(["done", "complete", "completed", "success", "finished"]);
/** 状态本身已经说明「不是失败」，只是没收到正文。 */
const ERROR_STATUS = new Set(["error", "failed"]);
/** 用户主动停止：说「已停止」，不当错误、不当空回复。 */
const STOPPED_STATUS = new Set(["aborted", "cancelled", "canceled", "stopped"]);
/** 还在进行中：不兜底，流式光标 / 思考占位自己会显示。 */
const LIVE_STATUS = new Set(["streaming", "running", "pending", "queued"]);

const UNSPECIFIED = "这次没收到回复，服务没提供具体原因（可以重发或换个模型）";
const EMPTY_FALLBACK = "这次未收到回复，服务没提供具体原因（可以重发或换个模型）";

/** 额度耗尽：只有服务明确说了额度 / 配额 / 余额才归这里，不能因为 429 就猜。 */
const QUOTA_RE =
	/usage_limit_reached|insufficient_quota|credit balance|balance (?:is )?(?:exhausted|insufficient|depleted)|out of credits|exceeded your (?:current )?quota|quota (?:exceeded|exhausted|reached)|billing (?:hard )?limit|you have hit your [^.]{0,40}usage limit|hit your (?:chatgpt |codex )?usage limit|额度(?:已)?(?:用完|耗尽|不足)|配额(?:已)?(?:用完|耗尽)|余额不足/i;
/** 普通限流：重发（等一会）通常有效，和额度耗尽区别对待。 */
const RATE_RE = /rate.?limit|rate_limit|too many requests|\b429\b|tpm|rpm|限流|请求过多|请求太频繁|频率超限/i;
const AUTH_RE = /unauthor|invalid[\s_-]*api[\s_-]*key|incorrect api key|authentication|forbidden|permission denied|\b401\b|\b403\b|鉴权|密钥无效|无权限/i;
const CONTEXT_RE = /context[\s_-]*(?:length|window|limit)|too many tokens|maximum context|上下文(?:超出|过长)|token 上限/i;
const TIMEOUT_RE = /timed?[\s_-]*out|etimedout|esockettimedout|timeout (?:of|after)|\b超时\b/i;
const NETWORK_RE = /connection (?:error|refused|reset)|econnreset|econnrefused|enotfound|eai_again|fetch failed|network error|socket hang up|dns|getaddrinfo|连不上|网络(?:错误|不通|异常)/i;
const SERVER_RE = /internal server error|bad gateway|service unavailable|gateway timeout|overloaded|temporarily unavailable|\b50[0234]\b|服务(?:暂时)?不可用|过载|繁忙/i;

function redact(text: string): string {
	return text
		.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-[已隐藏]")
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [已隐藏]")
		.replace(/([?&](?:api[_-]?key|key|token|access_token|refresh_token|sig|signature|password)=)[^&\s"'<>]+/gi, "$1[已隐藏]")
		.replace(/\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|password|secret)=([^\s"'`,;&]+)/gi, "$1=[已隐藏]")
		.replace(/("?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|password|secret)"?\s*[:=]\s*")[^"]{4,}"/gi, '$1[已隐藏]"');
}

function clip(text: string, max: number): string {
	const t = text.trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

function safeJson(value: unknown): string {
	try {
		const s = JSON.stringify(value);
		return typeof s === "string" ? s : "";
	} catch {
		return "";
	}
}

/**
 * 从历史 / 第三方错误对象里只取受控的可读字段：message / error.message / code / type / detail / reason…
 * 绝不把整个对象 String() 成 `[object Object]`。数组逐项读，去重、限条数。
 */
function collectParts(error: unknown, out: string[], seen: Set<unknown>, depth: number): string[] {
	if (error == null || out.length >= 8 || depth > 4) return out;
	if (typeof error === "string") {
		const s = error.trim();
		if (!s || /^\[object .+\]$/.test(s)) return out;
		// 有服务商把整个 JSON 错误塞在 error 字符串里：优先取里面的可读字段，失败才按普通文本
		if (/^[[{]/.test(s)) {
			try {
				const parsed: unknown = JSON.parse(s);
				const before = out.length;
				collectParts(parsed, out, seen, depth + 1);
				if (out.length > before) return out;
			} catch {
				// 不是合法 JSON，按普通文本处理
			}
		}
		if (!out.includes(s)) out.push(s);
		return out;
	}
	if (typeof error === "number" || typeof error === "boolean") {
		const s = String(error);
		if (!out.includes(s)) out.push(s);
		return out;
	}
	if (typeof error !== "object") return out;
	if (seen.has(error)) return out;
	seen.add(error);
	if (Array.isArray(error)) {
		for (const item of error) collectParts(item, out, seen, depth + 1);
		return out;
	}
	const o = error as Record<string, unknown>;
	// 先读人话字段，再补 code / type / status，最后兜底其它常见的说明字段
	for (const key of ["message", "error", "msg", "detail", "reason", "description", "title"]) collectParts(o[key], out, seen, depth + 1);
	for (const key of ["code", "type", "status", "error_code", "error_type"]) collectParts(o[key], out, seen, depth + 1);
	for (const key of ["body", "data", "response", "cause"]) collectParts(o[key], out, seen, depth + 1);
	return out;
}

/** 只保留可读字段的原文（不含凭据）；空 / 纯占位对象返回空串。 */
function readableError(error: unknown): string {
	if (error == null) return "";
	const parts = collectParts(error, [], new Set<unknown>(), 0);
	const text = parts.join(" · ").trim();
	if (!text || /^\[object .+\]$/.test(text)) return "";
	return clip(redact(text), MAX_DETAIL * 2);
}

/** 分类用的全文：可读字段 +（对象时）JSON 里的错误码，只用于匹配，绝不直接展示。 */
function classifyText(error: unknown, readable: string): string {
	if (typeof error === "string" || error == null) return readable;
	return `${readable} ${safeJson(error)}`;
}

export function assistantErrorKind(error: unknown): ErrorKind {
	const text = classifyText(error, readableError(error));
	if (!text) return "unknown";
	if (QUOTA_RE.test(text)) return "quota";
	if (RATE_RE.test(text)) return "rate_limit";
	if (AUTH_RE.test(text)) return "auth";
	if (CONTEXT_RE.test(text)) return "context";
	if (TIMEOUT_RE.test(text)) return "timeout";
	if (NETWORK_RE.test(text)) return "network";
	if (SERVER_RE.test(text)) return "server";
	return "unknown";
}

const KIND_TEXT: Record<Exclude<ErrorKind, "unknown">, string> = {
	// 额度用完：重发没用，只能等额度恢复或换模型；不臆测恢复时间
	quota: "当前模型服务的额度已用完：等额度恢复后再试，或先换一个可用模型",
	rate_limit: "模型服务限流（请求太频繁），等一会儿再重发，或换个模型",
	auth: "模型服务鉴权失败：检查这个模型的 Key / 权限，或换个可用模型",
	context: "上下文超出模型上限：开个新对话再试，或换支持更长上下文的模型",
	timeout: "模型服务超时，这次没收到回复；可以重发或换个模型",
	network: "连不上模型服务：检查网络或代理后再重发",
	server: "模型服务出错了（服务端故障），稍后再重发或换个模型",
};

/** 错误原因写成一句中文；空错误也给一句，不留「什么都没说」。 */
export function assistantErrorText(error: unknown): string {
	const raw = readableError(error);
	const kind = assistantErrorKind(error);
	if (kind !== "unknown") return KIND_TEXT[kind];
	if (!raw) return UNSPECIFIED;
	return `${clip(raw, MAX_MAIN)}（可以重发或换个模型）`;
}

/** 服务返回的可读信息，放可展开详情用；已过滤凭据并截断（不泄密、不撑爆界面）。 */
export function assistantErrorDetail(error: unknown): string {
	return clip(readableError(error), MAX_DETAIL);
}

export function botBodyView({ body, thinking, status, error, hasAttachments, toolOnly }: BotBodyInput): BotBodyView {
	const text = String(body ?? "");
	const hasText = !!text.trim();
	const live = LIVE_STATUS.has(status);
	const stopped = STOPPED_STATUS.has(status);
	const interrupted = status === "interrupted";
	const readable = readableError(error);
	const kind = assistantErrorKind(error);
	// 有错误可读信息（或明确 error/failed 状态）就显示错误行；用户停止 / 中断优先按停止显示，不当失败
	const showError = !live && !stopped && !interrupted && (ERROR_STATUS.has(status) || !!readable);
	const showInterrupted = interrupted || stopped;
	const interruptedText = interrupted ? "（已中断）" : "（已停止）";
	// 旧记录兜底：真的结束了、确实什么都没有、也不是工具占位 —— 才说「没收到回复」
	const showEmpty = !showError && !showInterrupted && !hasText && !thinking && !hasAttachments && !toolOnly && EMPTY_TERMINAL.has(status);
	const view: BotBodyView = {
		showBubble: hasText || (status === "streaming" && !thinking),
		showError,
		errorKind: kind,
		errorText: showError ? assistantErrorText(error) : "",
		errorDetail: showError ? assistantErrorDetail(error) : "",
		errorRaw: showError ? readable : "",
		showInterrupted,
		interruptedText,
		showEmpty,
		emptyText: EMPTY_FALLBACK,
	};
	// 失败 / 中断 / 空回复本身就是内容：即使没有正文，也必须有气泡把原因显示出来
	if (view.showError || view.showInterrupted || view.showEmpty) view.showBubble = true;
	return view;
}
