/** 聊天渠道（企业微信 / 飞书 / 钉钉）的公共类型。每个平台一个适配器，只用各平台官方公开接口 / 官方 SDK。 */
export type ChannelKind = "wecom" | "feishu" | "dingtalk";

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
}
export interface AdapterStatus {
	state: "off" | "connecting" | "online" | "waiting" | "error";
	detail: string;
}
export interface AdapterDeps<C, S> {
	config: C;
	secret: S;
	onMessage(m: Inbound): void;
	setStatus(s: AdapterStatus): void;
}
export interface ChannelAdapter {
	start(): Promise<void>;
	stop(): Promise<void>;
	/** 发一条（Markdown）消息 */
	send(ctx: Record<string, unknown>, markdown: string): Promise<void>;
	/** 测试凭据（拿一次 access token 等） */
	test(): Promise<string>;
}
export const clip = (s: string, n = 3800) => (s.length > n ? `${s.slice(0, n)}\n…（内容较长，完整内容请在 App 里查看）` : s);
