/**
 * 一条助手消息「正文气泡该怎么显示」——纯函数，单独放这里便于 node:test 直接测（不需要 DOM / 浏览器）。
 *
 * 背景（真机事故）：请求失败的那一轮，服务端落库是 `content: ""` + `status: "error"`，
 * 错误原因只在气泡里渲染。旧实现的气泡渲染条件是 `body || (streaming && !thinking)`，
 * 于是失败的轮次**整个气泡都不渲染** → 界面上只剩「引用」按钮，看起来像「助理回复了但正文空白」。
 * 结论：错误 / 中断本身就是一种「要显示的内容」，不能拿「有没有正文」当唯一条件。
 */

export type BotBodyInput = {
	/** 已去掉思考后的正文（splitThinking 之后的 text） */
	body: string;
	/** 这一轮是否有思考内容（决定流式中要不要先占位显示气泡） */
	thinking: boolean;
	status: string;
	/** 消息 meta.error 原文 */
	error?: unknown;
};

export type BotBodyView = {
	/** 是否渲染正文气泡（false 时这一轮只有思考 / 步骤 / 操作按钮） */
	showBubble: boolean;
	showError: boolean;
	/** 给人看的短说明（已知错误翻成人话，未知原样） */
	errorText: string;
	/** 原始错误串，放 title，方便排查（不塞进界面主视线） */
	errorRaw: string;
	showInterrupted: boolean;
};

/** 常见模型 / 传输错误 → 人能看懂的一句话。没匹配上的保留原文，不吞掉真实原因。 */
const KNOWN: [RegExp, string][] = [
	[/timeout|timed out|etimedout|timeouterror/i, "模型服务超时，这次没收到回复"],
	[/connection error|econnreset|econnrefused|enotfound|fetch failed|network|socket hang up/i, "连不上模型服务"],
	[/401|403|unauthor|invalid.*api.?key|incorrect api key|permission/i, "模型服务鉴权失败，检查 Key / 权限"],
	[/429|rate.?limit|quota|insufficient/i, "模型服务限流或额度不足"],
	[/context|too many tokens|maximum context/i, "上下文超出模型上限"],
	[/5\d\d/ , "模型服务出错了"],
];

/** 把 meta.error 收敛成可读字符串：对象 / 数组等没有可读信息的一律当空，绝不让 [object Object] 露到界面上。 */
function errorString(error: unknown): string {
	if (error == null) return "";
	if (typeof error === "string") return error.trim();
	if (typeof error === "number" || typeof error === "boolean") return String(error);
	if (typeof error === "object") {
		const msg = (error as { message?: unknown }).message;
		if (typeof msg === "string") return msg.trim();
	}
	return "";
}

/** 错误原因写成一句中文；空错误也给一句，不留「什么都没说」。 */
export function assistantErrorText(error: unknown): string {
	const raw = errorString(error);
	if (!raw) return "这次没收到回复，可以重发或换个模型";
	for (const [re, label] of KNOWN) if (re.test(raw)) return `${label}，可以重发或换个模型`;
	const short = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
	return `${short}（可以重发或换个模型）`;
}

export function botBodyView({ body, thinking, status, error }: BotBodyInput): BotBodyView {
	const text = String(body ?? "");
	const errorRaw = errorString(error);
	const showError = status === "error";
	const view: BotBodyView = {
		showBubble: !!text.trim() || (status === "streaming" && !thinking),
		showError,
		errorText: showError ? assistantErrorText(errorRaw) : "",
		errorRaw,
		showInterrupted: status === "interrupted",
	};
	// 失败 / 中断本身就是内容：即使没有正文，也必须有气泡把原因显示出来
	if (view.showError || view.showInterrupted) view.showBubble = true;
	return view;
}
