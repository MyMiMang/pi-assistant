/**
 * 消息「引用回复」的纯逻辑（无 React / 无 DOM），便于 node:test 直接验证。
 * 设计见 docs/design/message-replies-ui.md。
 *
 * 安全边界：
 * - 引用只用于展示，摘录一律 sanitize 成纯文本；不解析 Markdown / HTML / SVG，不加载外链图片。
 * - 附件只带 name / mime / size 摘要，**不带 fileId / url**，避免引用时被重新上传或拉取。
 * - 工具步骤、卡片、系统消息（含隐藏）不可作为引用候选，避免把工具结果 / 密钥 / 隐藏 system 曝露到引用。
 */
import type { Message } from "./types";

/** 引用条摘录上限（字符）；UI 再用 CSS 截成 1–2 行。 */
export const REPLY_EXCERPT_MAX = 240;

export interface ReplyAttachmentSummary {
	name: string;
	mime: string;
	size: number;
}

/** draft 引用。只存展示所需，不存 HTML / URL / 附件本体。 */
export interface ReplyRef {
	messageId: string;
	authorId: string;
	authorName: string;
	authorRole: "user" | "assistant";
	excerpt: string;
	hasText: boolean;
	attachments: ReplyAttachmentSummary[];
}

/** 已发送消息里展示的引用块（来自服务端 ReplySnapshot，宽容读取）。 */
export interface QuotedBlock {
	messageId: string | null;
	authorName: string;
	excerpt: string;
	attachments: ReplyAttachmentSummary[];
	unavailable: boolean;
	edited: boolean;
	truncated: boolean;
}

type Quotable = Pick<Message, "role"> & { meta?: Record<string, any>; status?: string };

/** 只有用户 / 助理的普通消息可引用；工具步骤、卡片、系统消息（含隐藏）都排除。 */
export function isQuotable(m: Quotable): boolean {
	if (m.role !== "user" && m.role !== "assistant") return false;
	const meta = m.meta ?? {};
	if (meta.hidden || meta.visible === false) return false;
	if (meta.kind === "hidden" || meta.kind === "system") return false;
	return true;
}

const THINK = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;

/**
 * 把任意正文变成「只显示」的纯文本：
 * 去掉思考块 → 去掉所有标签（含 script / svg / 属性）→ 压缩空白。
 * 结果里的 `alert(1)` 之类只是文字，不会被当作代码执行。
 */
export function sanitizeExcerpt(text: unknown): string {
	return String(text ?? "")
		.replace(THINK, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/[<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** 生成引用摘录（超长截断加省略号）。 */
export function excerptOf(text: unknown, max = REPLY_EXCERPT_MAX): string {
	const s = sanitizeExcerpt(text);
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 附件只留摘要：名字 / 类型 / 大小；刻意丢掉 fileId、url、workspacePath。 */
export function replyAttachments(atts?: { name: string; mime?: string; size?: number }[] | null): ReplyAttachmentSummary[] {
	return (atts ?? []).map((a) => ({ name: String(a.name ?? "文件"), mime: String(a.mime ?? ""), size: Number(a.size ?? 0) }));
}

/** 引用条 / 引用块里附件的一句话摘要（图片标注「图片」）。 */
export function attachmentLabel(a: ReplyAttachmentSummary): string {
	return `${a.mime.startsWith("image/") ? "图片：" : ""}${a.name}`;
}

export function buildReplyRef(m: Message, author: { id: string; name: string }): ReplyRef {
	const excerpt = excerptOf(m.content);
	return {
		messageId: m.id,
		authorId: author.id,
		authorName: author.name,
		authorRole: m.role === "user" ? "user" : "assistant",
		excerpt,
		hasText: !!excerpt,
		attachments: replyAttachments(m.meta?.attachments),
	};
}

/**
 * 读取服务端 ReplySnapshot（`Message.reply`）。客户端不解析也不信任客户端自填数据。
 * 旧消息没有 reply 字段 → null。
 */
export function quotedBlock(m: Pick<Message, "reply">): QuotedBlock | null {
	const r = m.reply;
	if (!r || typeof r !== "object") return null;
	const author = (r.author ?? {}) as { name?: unknown };
	const unavailable = !!r.unavailable;
	return {
		messageId: r.messageId != null ? String(r.messageId) : null,
		authorName: String(author.name ?? "原消息"),
		excerpt: unavailable ? "" : excerptOf(r.excerpt ?? ""),
		attachments: unavailable ? [] : replyAttachments(r.attachments),
		unavailable,
		edited: !!r.edited,
		truncated: !!r.truncated,
	};
}

// ------------------------------------------------------------------ 发送 payload（typed adapter 复用）
// 客户端只传 replyToId（+ 幂等 clientId）；作者 / 摘录 / 接收人由服务端可信解析。
// skills 只传 canonical id；服务端按分配表重新校验（不接受路径 / 正文）。
export function agentSendBody(text: string, attachmentIds: string[], conversationId?: string | null, replyToId?: string | null, clientId?: string | null, skillIds?: string[]) {
	return { text, attachments: attachmentIds, conversationId, ...(replyToId ? { replyToId } : {}), ...(clientId ? { clientId } : {}), ...(skillIds?.length ? { skills: skillIds } : {}) };
}
export function roomSendBody(text: string, mentions: string[], attachmentIds: string[], replyToId?: string | null, clientId?: string | null) {
	return { text, mentions, attachments: attachmentIds, ...(replyToId ? { replyToId } : {}), ...(clientId ? { clientId } : {}) };
}
export function subagentSendBody(text: string, replyToId?: string | null, clientId?: string | null) {
	return { text, ...(replyToId ? { replyToId } : {}), ...(clientId ? { clientId } : {}) };
}

/** 从输入框文字里筛出仍然生效的 @（删掉的不算）；与 RoomChat 现有逻辑一致。 */
export function liveMentions(picked: string[], text: string, nameOf: (id: string) => string | undefined): string[] {
	return picked.filter((id) => {
		const name = nameOf(id);
		return !!name && text.includes(`@${name}`);
	});
}

/** 幂等发送用的新 id（浏览器一定支持 randomUUID，不支持就退化为时间戳 + 随机）。 */
export function newClientId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}
}

/** 一份草稿的签名：文字 + 附件 + 引用 + 本次技能。变了就该换新的 clientId。 */
export function draftSignature(o: { text: string; attachmentIds: string[]; replyToId?: string | null; skills?: string[] }): string {
	return JSON.stringify([o.text, o.attachmentIds, o.replyToId ?? null, o.skills ?? []]);
}

// ------------------------------------------------------------------ 目标标签（展示用；最终由后端裁定）
export interface RoomReplyTarget {
	quoteLabel: string | null;
	mentionLabel: string | null;
	replyToId: string | null;
	/** 引用的助理已删除 / 已离群 → 需要用户用 @ 指定 */
	unavailable: boolean;
	needMention: boolean;
}

export interface MemberLike {
	agentId: string;
	name: string;
	left?: boolean;
	deleted?: boolean;
}

/**
 * 群聊里引用 + @ 的目标标签：
 *  - 显式 @：只有被 @ 的人回复（@ 优先）；引用活跃助理时额外显示「回复给 A」。
 *  - 无 @ 且引用活跃助理 A：只 A 回复。
 *  - 引用用户消息 / 其它：不显示「只有用户」这类误导标签。
 *  - 引用的助理不可用：提示需要用 @ 指定。
 */
export function resolveRoomReplyTarget(input: { ref: ReplyRef | null; mentions: MemberLike[]; members: MemberLike[]; managerId: string | null }): RoomReplyTarget {
	const { ref, mentions, members, managerId } = input;
	const mentionLabel = mentions.length ? `@${mentions.map((m) => m.name).join("、")} 将回复` : null;
	if (!ref) return { quoteLabel: null, mentionLabel, replyToId: null, unavailable: false, needMention: false };
	if (ref.authorRole === "user") {
		// 引用用户消息：沿用现有「不 @ 人时由管理者回答」，不假装「只有用户回复」
		return { quoteLabel: null, mentionLabel, replyToId: ref.messageId, unavailable: false, needMention: false };
	}
	const member = members.find((m) => m.agentId === ref.authorId);
	const active = !!member && !member.left && !member.deleted;
	if (!active) return { quoteLabel: null, mentionLabel, replyToId: ref.messageId, unavailable: true, needMention: true };
	return { quoteLabel: `回复给 ${ref.authorName}`, mentionLabel, replyToId: ref.messageId, unavailable: false, needMention: false };
}

export interface AgentReplyTarget {
	quoteLabel: string | null;
	replyToId: string | null;
}

/** 单聊 / 子代理：引用目标恒为当前助理（不做任何跨助理路由）。 */
export function resolveAgentReplyTarget(ref: ReplyRef | null, agentName: string): AgentReplyTarget {
	return { quoteLabel: ref ? `回复给 ${agentName}` : null, replyToId: ref?.messageId ?? null };
}

// ------------------------------------------------------------------ draft key（每对话 / 群 / 子代理独立）
export const replyDraftKey = {
	agent: (agentId: string, conversationId?: string | null) => `a:${agentId}:${conversationId ?? ""}`,
	room: (roomId: string) => `r:${roomId}`,
	subagent: (subagentId: string) => `s:${subagentId}`,
};
