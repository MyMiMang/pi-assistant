/**
 * 成员之间直接协作的模型工具（决策 0019 第 4 步）：ask_colleague / answer_colleague / report_upstream / work_rework。
 * 任务会话和群会话都挂这一份；身份来自会话闭包（宿主绑定），不接受模型自报。流程在 ask-flow.ts。
 */
import { Type } from "typebox";
import { itemRow, reworkByOwner } from "../work-items.ts";
import { answerAsk, followUp, reportUpstream, startAsk } from "./ask-flow.ts";
import { openUpstreamAsk } from "./asks.ts";
import { text } from "./proposals.ts";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** itemId：任务会话里就是这个任务；群会话里为 undefined（成员可以在参数里指明自己的任务）。 */
export function askTools(roomId: string, agentId: string, itemId?: string) {
	/** 提问者当时在做的任务：任务会话固定是它；群会话里只认确实是自己负责的任务。 */
	const ownItem = (ref?: string) => {
		if (itemId) return itemId;
		const row = ref ? itemRow(ref) : undefined;
		return row && row.room_id === roomId && row.owner_agent_id === agentId ? row.id : null;
	};
	return (pi: { registerTool: (t: unknown) => void }) => {
		pi.registerTool({
			name: "ask_colleague",
			label: "问同事",
			description:
				"资料不够、理解拿不准、结果没把握时，先问清楚再往下做，不要硬猜。to 填群里成员的名字：问具体的事问对口的同事；涉及目标 / 范围 / 分工的问管理者。问题会发到群里（大家都看得到），回答会直接送到你这里，不用干等，先做不依赖这个答案的部分。对方回答后还不清楚可以带 askId 追问；一个问题最多来回 3 轮，再追问会交给管理者。别人的成果有问题请用 report_upstream，不要在这里问。",
			parameters: Type.Object({
				to: Type.String({ description: "被问的成员名字（含管理者）" }),
				question: Type.String({ description: "要问的事：背景、你已经知道的、具体想确认什么" }),
				askId: Type.Optional(Type.String({ description: "追问时填之前那次提问的编号（同一段对话）；新问题不填" })),
				workItemId: Type.Optional(Type.String({ description: "这个问题和你负责的哪个任务有关（任务会话里自动就是当前任务）" })),
			}),
			async execute(_id: string, p: { to: string; question: string; askId?: string; workItemId?: string }) {
				try {
					const r = p.askId ? followUp({ roomId, from: agentId, askId: p.askId, text: p.question }) : startAsk({ roomId, from: agentId, toName: p.to, text: p.question, fromItem: ownItem(p.workItemId) });
					return text(r.ok ? r.text : r.error);
				} catch (e) {
					return text(msg(e));
				}
			},
		});
		pi.registerTool({
			name: "answer_colleague",
			label: "回答同事",
			description: "回答同事的提问（提问编号 askId 在提问里）。只有被问的人本人能答；提问被交给管理者之后管理者可以代答。回答会直接送到提问者手上，也会发在群里，不用另外再说一遍。不知道就如实说，并建议该问谁。",
			parameters: Type.Object({ askId: Type.String({ description: "提问编号" }), answer: Type.String({ description: "回答" }) }),
			async execute(_id: string, p: { askId: string; answer: string }) {
				try {
					const r = answerAsk({ roomId, by: agentId, askId: p.askId, text: p.answer });
					return text(r.ok ? r.text : r.error);
				} catch (e) {
					return text(msg(e));
				}
			},
		});
		pi.registerTool({
			name: "report_upstream",
			label: "上游有问题",
			description: "你发现前置任务（你的任务要等它完成的那个）的成果有问题时用：告诉上游负责人哪里不对、为什么。只能针对你自己任务的前置任务。上游确认有问题会自己重做，改好重新核验通过后新版本会自动送到你这里；先做不依赖这个成果的部分，不要自己去改别人的成果。",
			parameters: Type.Object({ workItemId: Type.String({ description: "有问题的前置任务（编号或名字）" }), issue: Type.String({ description: "哪里不对、为什么、你期望怎么样" }) }),
			async execute(_id: string, p: { workItemId: string; issue: string }) {
				try {
					const r = reportUpstream({ roomId, from: agentId, ownItem: itemId ?? null, upstream: p.workItemId, issue: p.issue });
					return text(r.ok ? r.text : r.error);
				} catch (e) {
					return text(msg(e));
				}
			},
		});
		pi.registerTool({
			name: "work_rework",
			label: "重做自己的任务",
			description: "（任务负责人本人）同事指出你已完成的任务的成果有问题（你收到了上游提问）、你认为确实有问题时，把自己的任务重开成新修订重做。没有人指出问题时不能用；认为没问题请用 answer_colleague 说明理由。改好后提交，重新核验通过会自动把新版本交给依赖它的同事。",
			parameters: Type.Object({ workItemId: Type.String({ description: "你的任务编号" }), why: Type.String({ description: "要改什么、为什么（会写进新修订的执行说明）" }) }),
			async execute(_id: string, p: { workItemId: string; why: string }) {
				const row = itemRow(p.workItemId);
				if (!row || row.room_id !== roomId) return text("任务不存在或不在这个群。");
				if (row.owner_agent_id !== agentId) return text("只有任务负责人能重做自己的任务；别人的成果你不能直接改。");
				const ask = openUpstreamAsk(row.id, agentId);
				if (!ask) return text("现在没有同事指出这个任务有问题，不能重开重做。认为没问题就用 answer_colleague 说明理由。");
				try {
					reworkByOwner({ workItemId: row.id, agentId, roomId, why: p.why });
					answerAsk({ roomId, by: agentId, askId: ask.id, text: `确认有问题，已重开重做：${p.why.trim().slice(0, 500)}。改好并重新核验通过后，新版本会自动交给你。` });
					return text(`已重开「${row.title}」并开始重做，改好后用 work_submit 提交；那条提问已回复。`);
				} catch (e) {
					return text(msg(e));
				}
			},
		});
	};
}
