/** 聊天渠道（企业微信 / 飞书 / 钉钉）的公共类型。每个平台一个适配器，只用各平台官方公开接口 / 官方 SDK。 */
export type ChannelKind = "wecom" | "wecom_bot" | "feishu" | "dingtalk" | "wechat_clawbot";

export interface Inbound {
	/** 发消息的人（用于授权） */
	userId: string;
	/** 会话键：单聊 = 用户，群聊 = 群 */
	peerId: string;
	display?: string;
	text: string;
	group?: boolean;
	msgId?: string;
	/** 回复时需要的上下文（chat_id / sessionWebhook / userid…） */
	ctx: Record<string, unknown>;
	/** 发来的图片 / 文件（存进助理工作区 uploads/） */
	files?: { name: string; data: Buffer }[];
}
/**
 * 平台不允许现在发（例如微信 ClawBot 只能在用户最近发过消息后的有限窗口内回复）：
 * 渠道层把消息放进待发队列，等用户下次发消息时补发，并用其它方式（App 推送）提醒。
 */
export class DeferredSend extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "DeferredSend";
	}
}
export interface AdapterStatus {
	state: "off" | "connecting" | "online" | "waiting" | "error";
	detail: string;
}
/** 交互卡片：审批 / 选项按钮。button.action 是不透明字符串，点按后原样交给 onAction */
export interface OutCard {
	title: string;
	body: string;
	/** text = 等价的文字回复（「批准」「1」…），给只能“替用户发文字”的平台用 */
	buttons: { label: string; action: string; text: string; style?: "primary" | "danger" | "default" }[];
	/** 不支持按钮时的文字提示（例如“回复「批准」或「拒绝」”） */
	fallback: string;
}
/** 卡片按钮点按 */
export interface CardAction {
	userId: string;
	action: string;
	display?: string;
	ctx: Record<string, unknown>;
}
export interface AdapterDeps<C, S> {
	config: C;
	secret: S;
	onMessage(m: Inbound): void;
	/** 卡片按钮回调；返回给用户看的结果（例如“已批准”），适配器用它更新卡片 */
	onAction?(a: CardAction): Promise<string>;
	setStatus(s: AdapterStatus): void;
}
export interface ChannelAdapter {
	start(): Promise<void>;
	stop(): Promise<void>;
	/** 发一条（Markdown）消息 */
	send(ctx: Record<string, unknown>, markdown: string): Promise<void>;
	/** 发一张带按钮的卡片（不支持的平台不实现，退回文字） */
	sendCard?(ctx: Record<string, unknown>, card: OutCard): Promise<void>;
	/** 发文件 / 图片（不支持的平台不实现，退回“请在 App 里查看”） */
	sendFile?(ctx: Record<string, unknown>, path: string, name: string): Promise<void>;
	/** 现在能不能主动给这个会话发消息（主动提醒选渠道用）；不实现 = 能 */
	canPush?(ctx: Record<string, unknown>): { ok: boolean; reason?: string };
	/** 测试凭据（拿一次 access token 等） */
	test(): Promise<string>;
}
export const clip = (s: string, n = 3800) => (s.length > n ? `${s.slice(0, n)}\n…（内容较长，完整内容请在 App 里查看）` : s);

/** 卡片按钮的 action 编码：pia|<requestId>|approve|reject|task|opt|<序号> */
export const encodeAction = (requestId: string, kind: "approve" | "reject" | "task" | "opt", i?: number) => ["pia", requestId, kind, ...(i === undefined ? [] : [String(i)])].join("|");
export function decodeAction(s: string): { requestId: string; kind: "approve" | "reject" | "task" | "opt"; i?: number } | null {
	const [p, requestId, kind, i] = String(s ?? "").split("|");
	if (p !== "pia" || !requestId || !["approve", "reject", "task", "opt"].includes(kind)) return null;
	return { requestId, kind: kind as never, i: i === undefined ? undefined : Number(i) };
}
/** 企业微信 task_id：字母数字 _-@，≤128 */
export const taskId = (action: string) => `${action.replace(/[^A-Za-z0-9_\-@]/g, "_").slice(0, 100)}_${Date.now().toString(36)}`;
