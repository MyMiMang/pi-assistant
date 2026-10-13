/**
 * 各渠道的能力：能不能发图片 / 文件、支持什么格式、多大，正文用什么格式、多长。
 * 用于：① 告诉助理用户现在在哪里聊天（注入到这轮消息前面）；② 出站时按渠道转换格式、决定图片怎么发。
 */
import type { ChannelKind } from "./types.ts";

export interface ChannelCaps {
	label: string;
	/** 正文格式：plain = 纯文本（Markdown 会被转成纯文本）；markdown = 支持常见 Markdown */
	format: "plain" | "markdown";
	/** 单条文字上限（字符，超出分段或截断） */
	maxText: number;
	/** 原生图片消息：支持的扩展名、大小上限（字节）；null = 不支持 */
	image: { exts: string[]; maxBytes: number } | null;
	/** 原生文件消息：大小上限；null = 不支持 */
	file: { maxBytes: number } | null;
	notes?: string;
}
const MB = 1024 * 1024;
export const CAPS: Record<ChannelKind | "app", ChannelCaps> = {
	app: { label: "Pi Assistant App / 手机网页", format: "markdown", maxText: 100_000, image: { exts: ["png", "jpg", "jpeg", "gif", "webp", "svg"], maxBytes: 200 * MB }, file: { maxBytes: 200 * MB } },
	wechat_clawbot: { label: "微信（ClawBot）", format: "plain", maxText: 1800, image: { exts: ["png", "jpg", "jpeg", "gif"], maxBytes: 20 * MB }, file: { maxBytes: 50 * MB }, notes: "只支持单聊；用户 23 小时没说话或一轮发太多条时会排队到用户下次发消息" },
	feishu: { label: "飞书", format: "markdown", maxText: 3800, image: { exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "ico"], maxBytes: 10 * MB }, file: { maxBytes: 30 * MB } },
	wecom: { label: "企业微信（自建应用）", format: "markdown", maxText: 2000, image: { exts: ["png", "jpg", "jpeg"], maxBytes: 10 * MB }, file: { maxBytes: 20 * MB } },
	wecom_bot: { label: "企业微信（智能机器人）", format: "markdown", maxText: 4000, image: { exts: ["png", "jpg", "jpeg"], maxBytes: 10 * MB }, file: { maxBytes: 20 * MB } },
	dingtalk: { label: "钉钉", format: "markdown", maxText: 3800, image: { exts: ["png", "jpg", "jpeg", "gif", "bmp"], maxBytes: 20 * MB }, file: { maxBytes: 20 * MB } },
};

const size = (n: number) => `${Math.round(n / MB)}MB`;
/** 给助理看的一行渠道说明（拼在这轮用户消息前面） */
export function channelContext(kind: ChannelKind, extra?: { group?: boolean }): string {
	const c = CAPS[kind];
	const bits = [
		`用户这条消息来自「${c.label}」${extra?.group ? "群聊" : ""}，你的回复和 deliver_file 交付的文件会自动发回这里`,
		c.format === "plain" ? "只显示纯文本（Markdown 会被去掉，别用表格）" : "支持基本 Markdown（表格可能显示不全）",
		`单条约 ${c.maxText} 字以内为宜`,
		c.image ? `能直接显示图片（${c.image.exts.join("/")}，≤${size(c.image.maxBytes)}，其它格式会自动转换或改发文件）` : "不能显示图片",
		c.file ? `能收文件（≤${size(c.file.maxBytes)}）` : "不能收文件",
	];
	if (c.notes) bits.push(c.notes);
	return `［渠道：${bits.join("；")}。图片/文件请用 deliver_file 发送，不要只写文件名或路径。］`;
}

/** Markdown → 纯文本（微信等）：去掉强调符号、标题井号、代码围栏，链接写成「文字 网址」，表格转成行 */
export function markdownToPlain(md: string): string {
	return md
		.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => code.trimEnd())
		.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt: string, url: string) => `${alt || "图片"} ${url}`)
		.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t: string, url: string) => (t === url ? url : `${t} ${url}`))
		.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "")
		.replace(/^\s*\|(.+)\|\s*$/gm, (_, row: string) => row.split("|").map((x) => x.trim()).join("  "))
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s?/gm, "")
		.replace(/^(\s*)[-*+]\s+/gm, "$1• ")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/^\s*([-*_])\1{2,}\s*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
