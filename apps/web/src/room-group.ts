/**
 * 群聊消息分组（纯逻辑，便于单测）：群里只显示说的话（决策 0026）。
 * 助理消息里只有思考 / 工具步骤、没有文字的不单独显示，它们的步骤并进这位成员下一条有文字的消息，显示成那条消息里折叠的「N 个步骤」。
 * 正在发言的那位（liveAgent）照旧显示过程，这样它在干活时能看到进度。单聊用 ChatMessages 的 group，不受影响。
 */
import type { Message } from "./types.ts";

/** 和 ChatMessages.tsx 的 Part 同形（这里不 import 它：它是 tsx，服务端单测的类型检查不认） */
export type Part = { kind: "msg"; m: Message } | { kind: "steps"; items: Message[] };
export type RRow = { kind: "user"; m: Message } | { kind: "system"; m: Message } | { kind: "bot"; id: string; agentId: string; parts: Part[] } | { kind: "day"; label: string; id: string };

/** 只有过程、没有文字的消息：工具步骤、只有思考的助理消息、帮手执行卡（失败的空消息要让用户看到，不算） */
/**
 * 单聊用：只有思考、没有文字的一步（不是出错、不是还在生成、没带附件）不单独占一块（决策 0026 同一条规则用到单聊）。
 * 跳过它之后，前后的工具步骤自然连成一组「N 个步骤」；正在进行的那一步照旧显示「思考中…」。
 */
export const quietThinking = (m: Message) => m.role === "assistant" && !m.content.trim() && m.status === "done" && !(m.meta.attachments?.length);

export const isProcess = (m: Message) => m.role === "tool" || (m.role === "assistant" && !m.content.trim() && m.status !== "error") || (m.role === "card" && m.meta.kind === "subagent");

const dayLabel = (ts: number) => {
	const d = new Date(ts);
	const same = d.toDateString() === new Date().toDateString();
	return `${same ? "今天" : `${d.getMonth() + 1}月${d.getDate()}日`} ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
};

export function groupRoom(list: Message[], liveAgent: string | null = null): RRow[] {
	const rows: RRow[] = [];
	const held = new Map<string, Message[]>(); // 每位成员还没说话时攒下的工具步骤
	const solid = new Set<RRow>(); // 已经有「真内容」（不是只有过程）的行
	let lastTs = 0;
	for (const m of list) {
		const hide = isProcess(m) && m.agent_id !== liveAgent && m.role !== "system" && m.role !== "user";
		if (hide) {
			if (m.role === "tool") held.set(m.agent_id, [...(held.get(m.agent_id) ?? []), m]);
			continue;
		}
		if (m.created_at - lastTs > 30 * 60_000) rows.push({ kind: "day", id: `d${m.id}`, label: dayLabel(m.created_at) });
		lastTs = m.created_at;
		if (m.role === "user" || (m.role === "system" && !m.agent_id)) {
			rows.push({ kind: m.role === "user" ? "user" : "system", m } as RRow);
			continue;
		}
		if (m.role === "system") {
			rows.push({ kind: "system", m });
			continue;
		}
		let bot = rows[rows.length - 1];
		if (bot?.kind !== "bot" || bot.agentId !== m.agent_id) rows.push((bot = { kind: "bot", id: m.id, agentId: m.agent_id, parts: [] }));
		// 行的 id（React key）取第一条真内容的 id：发言人正在发言（过程可见）和说完（过程隐藏）两种状态下 id 一样，说完时整行不会重新挂载闪一下
		if (!isProcess(m) && !solid.has(bot)) {
			solid.add(bot);
			bot.id = m.id;
		}
		const steps = held.get(m.agent_id);
		if (steps?.length && m.role !== "tool") {
			bot.parts.push({ kind: "steps", items: steps });
			held.delete(m.agent_id);
		}
		if (m.role === "tool") {
			const last = bot.parts[bot.parts.length - 1];
			if (last?.kind === "steps") last.items.push(m);
			else bot.parts.push({ kind: "steps", items: [m] });
		} else bot.parts.push({ kind: "msg", m });
	}
	return rows;
}
