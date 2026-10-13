/**
 * 去掉模型“思考过程”。有些模型 / 中转把思考写进正文：<think>…</think>、<thinking>…</thinking>、
 * <reasoning>…</reasoning>，或者只漏出半截（开头标签被截掉，只剩 “…我先看尺寸。</thinking>”；
 * 流式中还没收到结束标签）。返回干净正文和提取出的思考内容。
 */
const TAGS = "think|thinking|reasoning|reflection";
const BLOCK = new RegExp(`<(${TAGS})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, "gi");
const ORPHAN_CLOSE = new RegExp(`^[\\s\\S]*?</(?:${TAGS})\\s*>`, "i");
const OPEN_TAIL = new RegExp(`<(?:${TAGS})\\b[^>]*>[\\s\\S]*$`, "i");

export function splitThinking(input: string | null | undefined): { text: string; thinking: string } {
	let s = String(input ?? "");
	const parts: string[] = [];
	s = s.replace(BLOCK, (m) => (parts.push(m.replace(/^<[^>]+>|<\/[^>]+>$/g, "").trim()), ""));
	// 只剩结束标签：标签前面全是思考
	const orphan = s.match(ORPHAN_CLOSE);
	if (orphan) {
		parts.unshift(orphan[0].replace(new RegExp(`</(?:${TAGS})\\s*>$`, "i"), "").trim());
		s = s.slice(orphan[0].length);
	}
	// 只有开始标签（流式中 / 被截断）：后面全是思考
	const open = s.match(OPEN_TAIL);
	if (open) {
		parts.push(open[0].replace(/^<[^>]+>/, "").trim());
		s = s.slice(0, open.index);
	}
	return { text: parts.length ? s.replace(/^\s+/, "").replace(/\n{3,}/g, "\n\n").trimEnd() : s, thinking: parts.filter(Boolean).join("\n\n") };
}
export const stripThinking = (s: string | null | undefined) => splitThinking(s).text;
