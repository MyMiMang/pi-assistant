/**
 * 电脑操控工具返回的旧截图只留最近几张：每张图每步都要被模型重读，旧屏幕对下一步没用。
 * 纯逻辑（不依赖 Pi）。不改传入的消息对象；按批次清，让被改动的前缀不会每步都变（保住提示缓存）。
 */
export const KEEP_SCREENS = 3;
export const PRUNE_BATCH = 5;
export const PRUNED_NOTE = "（较早的屏幕截图已省略；需要看现在的屏幕就重新截图）";

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; toolName?: string; content?: unknown };

const isImage = (b: unknown): boolean => !!b && typeof b === "object" && (b as Block).type === "image";

export function pruneOldScreens<T extends Msg>(messages: T[], isComputer: (toolName: string) => boolean, opts: { keep?: number; batch?: number } = {}): T[] {
	const keep = opts.keep ?? KEEP_SCREENS;
	const batch = opts.batch ?? PRUNE_BATCH;
	const targets: number[] = [];
	let total = 0;
	messages.forEach((m, i) => {
		if (m.role !== "toolResult" || !m.toolName || !isComputer(m.toolName) || !Array.isArray(m.content)) return;
		const n = m.content.filter(isImage).length;
		if (n) (targets.push(i), (total += n));
	});
	let toPrune = Math.floor(Math.max(0, total - keep) / batch) * batch;
	if (toPrune <= 0) return messages;
	const out = messages.slice();
	for (const i of targets) {
		if (toPrune <= 0) break;
		const content = (messages[i].content as unknown[]).map((b) => (isImage(b) && toPrune > 0 ? (toPrune--, { type: "text", text: PRUNED_NOTE }) : b));
		out[i] = { ...messages[i], content };
	}
	return out;
}
