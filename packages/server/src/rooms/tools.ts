/** 群会话里的群工具：派活、提议加成员、提议自主推进（目标 + 完成标准）。 */
import { Type } from "typebox";
import { insertMessage } from "../messages.ts";
import { listAgents } from "../runtime.ts";
import { dispatchFromRoom } from "../work-items.ts";
import { memberSchema, modelsHint, normalizeProposal, text, type ProposalMember } from "./proposals.ts";
import { states } from "./scheduler.ts";
import { getRoom, memberRefs, memberRow } from "./store.ts";

export function roomTools(roomId: string, agentId: string) {
	return (pi: { registerTool: (t: unknown) => void }) => {
		pi.registerTool({
			name: "room_assign",
			label: "分配任务",
			description: "（只有管理者可用）把任务分配给群里的成员。普通派活：成员在群里依次回答，做完后你会再收到一次来总结。带 workItemId 的长期任务：直接在负责人自己的任务会话里开跑，它提交或卡住时你会被叫醒。",
			parameters: Type.Object({
				assignments: Type.Array(
					Type.Object({
						agent: Type.String({ description: "成员名字" }),
						task: Type.String({ description: "具体要做什么" }),
						files: Type.Optional(Type.Array(Type.String(), { description: "要交给这个成员的群附件文件名（会把文件放进它的工作区并发给它）" })),
						workItemId: Type.Optional(Type.String({ description: "可选：这次派活属于哪个长期任务（负责人必须已经是这个成员；用 work_create 记录任务）" })),
					}),
				),
			}),
			async execute(_id: string, p: { assignments: { agent: string; task: string; files?: string[]; workItemId?: string }[] }) {
				const r = getRoom(roomId);
				if (!r || r.manager_id !== agentId) return text("只有管理者能分配任务。你可以在回复里建议，由管理者决定。");
				const s = states.get(roomId);
				if (!s || s.stopped) return text("现在不能分配（群聊已停止）。");
				const refs = memberRefs(roomId);
				const ok: string[] = [];
				const bad: string[] = [];
				const queued: string[] = [];
				for (const a of p.assignments ?? []) {
					const name = String(a.agent ?? "").replace(/^[@＠]/, "").trim();
					const m = refs.find((x) => x.name === name) ?? refs.find((x) => x.name.toLowerCase() === name.toLowerCase());
					if (!m || m.id === agentId) {
						bad.push(name || "（空）");
						continue;
					}
					const taskText = String(a.task ?? "") + (a.files?.length ? `\n相关附件：${a.files.map(String).join("、")}` : "");
					if (a.workItemId) {
						// 长期任务：校验后直接在负责人自己的任务会话里开跑（不进群的发言队列、不占每轮上限），提交或卡住时你会被叫醒。
						try {
							dispatchFromRoom(roomId, m.id, String(a.workItemId), taskText);
						} catch (e) {
							bad.push(`${name}（长期任务无法派出：${e instanceof Error ? e.message : String(e)}）`);
							continue;
						}
						ok.push(`${m.name}（长期任务，已在它的任务会话里开始）`);
						continue;
					}
					if (!s.assignments.some((x) => x.agentId === m.id)) s.assignments.push({ agentId: m.id, task: taskText });
					queued.push(m.name);
					ok.push(m.name);
				}
				return text([ok.length ? `已分配给：${ok.join("、")}。${queued.length ? "你说完后群里的派活会依次开始。" : ""}` : "", bad.length ? `这些不是群成员（或是你自己）：${bad.join("、")}。成员有：${refs.filter((x) => x.id !== agentId).map((x) => x.name).join("、")}` : ""].filter(Boolean).join("\n"));
			},
		});
		pi.registerTool({
			name: "room_propose_member",
			label: "提议加成员",
			description: `（管理者）群里缺某个角色时，向用户提议加一个新成员（或拉一个已有助理）。会在群里出一张卡片，用户确认后才加入。${modelsHint()}`,
			parameters: Type.Object({ member: Type.Optional(memberSchema), existingAgent: Type.Optional(Type.String({ description: "已有助理的名字" })), reason: Type.String({ description: "为什么需要" }) }),
			async execute(_id: string, p: { member?: ProposalMember; existingAgent?: string; reason: string }) {
				const r = getRoom(roomId);
				if (!r || r.manager_id !== agentId) return text("只有管理者能提议加成员。");
				const ex = p.existingAgent ? listAgents().find((a) => a.name === p.existingAgent) : undefined;
				if (!ex && !p.member) return text("请提供 member 或 existingAgent。");
				const [m] = normalizeProposal({ members: [ex ? { agentId: ex.id } : p.member!], manager: -1 }, { auto: true }).members;
				const conv = memberRow(roomId, agentId)?.conversation_id;
				insertMessage({ agentId, conversationId: conv ?? undefined, role: "card", meta: { kind: "member-proposal", roomId, member: m, reason: String(p.reason ?? "").slice(0, 300), status: "pending" } });
				return text("提议已发给用户，确认后新成员会加入群聊，到时你可以再给它分配任务。");
			},
		});
		pi.registerTool({
			name: "room_goal",
			label: "提议自主推进",
			description: "（管理者）用户给了一个需要大家长期协作的目标时，先把目标和可检查的完成标准写清楚，发一张确认卡片给用户。用户确认后群进入自主推进：成员可以 @ 彼此，你在任务提交、卡住、定时检查时被叫醒。目标或完成标准不清楚时先问用户，不要替用户编。",
			parameters: Type.Object({ goal: Type.String({ description: "要达成的目标（一两句话）" }), doneCriteria: Type.String({ description: "怎样检查算达成（具体、可检查）" }) }),
			async execute(_id: string, p: { goal: string; doneCriteria: string }) {
				const r = getRoom(roomId);
				if (!r || r.manager_id !== agentId) return text("只有管理者能提议自主推进。");
				const goalText = String(p.goal ?? "").trim().slice(0, 1000);
				const doneCriteria = String(p.doneCriteria ?? "").trim().slice(0, 2000);
				if (!goalText || !doneCriteria) return text("目标和完成标准都要写清楚；不清楚就先问用户一个关键问题。");
				const conv = memberRow(roomId, agentId)?.conversation_id;
				insertMessage({ agentId, conversationId: conv ?? undefined, role: "card", meta: { kind: "room-goal", roomId, goal: goalText, doneCriteria, status: "pending" } });
				return text("确认卡片已发给用户。用户确认（可以先修改）后才会开启自主推进，在那之前照常工作。");
			},
		});
	};
}
