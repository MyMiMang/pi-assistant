/**
 * 单聊助理的项目工具（docs/design/group-team.md §13）：出方案卡、用户说可以时确认开始、标阶段完成、交付。
 * 只挂在用户可见的单聊会话上（群会话 / 帮手 / 后台任务没有）；按钮确认 / 先不做 / 停下走 HTTP（routes/chat-projects.ts）。
 * 和群聊 room_plan / room_project_start / room_project_done 同一套方案和交付卡，只是执行者是助理自己和它的帮手。
 */
import { Type } from "typebox";
import { fileInfo } from "../files.ts";
import { hostFileAccess } from "../host-control.ts";
import { resolveFileRefs } from "../rooms/file-refs.ts";
import { checkPlan, normalizePlan } from "../rooms/plan.ts";
import { PLAN_FIELDS } from "../rooms/plan-schema.ts";
import { chatProjectView, confirmChatProject, finishChatProject, getChatProject, markStageDone, proposeChatPlan, userRepliedToCard } from "./store.ts";
import { findStage } from "./progress.ts";
import { isChatConversation } from "./rules.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
type Pi = { registerTool: (t: unknown) => void };
const errText = (e: unknown) => (e instanceof Error ? (e.message === "not_found" ? "项目不存在。" : e.message) : String(e));

export function chatProjectTools(agentId: string, conversationId: string | null) {
	return (pi: Pi) => {
		if (!conversationId || !isChatConversation(conversationId)) return;
		const mine = (projectId: string) => {
			const p = getChatProject(String(projectId ?? ""));
			return p && p.conversation_id === conversationId ? p : undefined;
		};
		pi.registerTool({
			name: "chat_plan",
			label: "出方案卡",
			description: "遇到真正多步骤的大事（要做较久、有明确交付物、要分几步）时，把想清楚的方案发给用户确认：不带 projectId 是新立项；带 projectId 且这个项目还在等确认是改方案（重新发卡）；带 projectId 且项目已在进行中是「进行中改方案」（写进草稿，用户重新确认后才生效）。小事和闲聊不要用。发出后这一轮就停下等用户，确认前不要开工。",
			parameters: Type.Object({
				title: Type.String({ description: "项目名，不超过 40 字" }),
				projectId: Type.Optional(Type.String({ description: "改已有项目的方案时填" })),
				...PLAN_FIELDS,
				roles: Type.Optional(Type.Array(Type.Object({ member: Type.String({ description: "「我」或「帮手」" }), does: Type.String({ description: "负责什么" }) }), { description: "分工：你和你的帮手各做什么；可以不写" })),
			}),
			async execute(_id: string, p: { title: string; projectId?: string } & Record<string, unknown>) {
				const checked = checkPlan(normalizePlan(p), [], { solo: true });
				if (checked.error || !checked.plan) return text(checked.error ?? "方案校验失败。");
				try {
					const { project, revision } = proposeChatPlan({ agentId, conversationId, title: p.title, plan: checked.plan, projectId: p.projectId?.trim() || undefined });
					return text(`方案卡已发给用户（项目编号 ${project.id}）。这一轮先停下等用户：用户点「就这么干」你会收到确认通知；用户在聊天里说可以，就用 chat_project_start 开始${revision ? "（这是改过的方案，等用户重新确认）" : ""}。`);
				} catch (e) {
					return text(errText(e));
				}
			},
		});
		pi.registerTool({
			name: "chat_project_start",
			label: "确认项目开始",
			description: "用户在聊天里明确同意方案（比如说「可以」「就这么干」）时调用，效果和用户点「就这么干」一样。只有这份方案卡发出之后用户本人说过话才能调用，不能替用户确认。",
			parameters: Type.Object({ projectId: Type.String({ description: "方案对应的项目编号" }) }),
			async execute(_id: string, p: { projectId: string }) {
				const proj = mine(p.projectId);
				if (!proj) return text("项目不存在。");
				// 只在这份方案真的还等着用户确认时才检查「用户回复过没有」；已经处理过的交给 confirmChatProject 自己报错
				const confirmable = proj.status === "proposed" || (proj.status === "active" && !!proj.draft);
				if (confirmable && !userRepliedToCard(proj)) return text("用户还没回复这份方案，不能替用户确认。");
				try {
					const { revised } = confirmChatProject(conversationId, proj.id);
					return text(revised ? `已确认，项目「${proj.title}」按新方案继续。` : `已确认，项目「${proj.title}」开始了：按方案的阶段推进，每个阶段做完用 chat_stage_done 标记。`);
				} catch (e) {
					return text(errText(e));
				}
			},
		});
		pi.registerTool({
			name: "chat_stage_done",
			label: "标记阶段完成",
			description: "方案里的一个阶段做完、交出了该交的东西时调用：聊天里会给用户一条简短进度，你不用再复述。stage 写阶段名或第几个（从 1 开始）。",
			parameters: Type.Object({
				projectId: Type.String(),
				stage: Type.String({ description: "阶段名，或第几个阶段（从 1 开始）" }),
				note: Type.Optional(Type.String({ description: "一句话：这个阶段做出了什么" })),
			}),
			async execute(_id: string, p: { projectId: string; stage: string; note?: string }) {
				const proj = mine(p.projectId);
				if (!proj) return text("项目不存在。");
				const { plan } = chatProjectView(proj);
				const idx = findStage(plan, p.stage);
				if (idx === -1) return text(`没有这个阶段「${p.stage}」。方案的阶段：${plan.stages.map((s, i) => `${i + 1}. ${s.name}`).join("；")}。`);
				try {
					const r = markStageDone(conversationId, proj.id, idx, String(p.note ?? ""));
					const next = r.progress.currentStage;
					if (r.already) return text("这个阶段之前已经标过完成了。");
					return text(next === null ? "所有阶段都做完了：对照完成标准逐条核对，再用 chat_project_done 交付。" : `已记录（${r.progress.done}/${r.progress.total}）。下一个阶段：${r.progress.stages[next].name}。`);
				} catch (e) {
					return text(errText(e));
				}
			},
		});
		pi.registerTool({
			name: "chat_project_done",
			label: "交付项目",
			description: "全部阶段做完、对照完成标准逐条核对过、确认都满足时调用：结束项目，聊天里发一张交付卡（做成了什么、交付文件、怎么用、还没做的）。最终要给用户的文件放进 deliverables（你工作区里的路径）。",
			parameters: Type.Object({
				projectId: Type.String(),
				summary: Type.String({ description: "做成了什么：对照完成标准怎么满足的（简短）" }),
				deliverables: Type.Optional(Type.Array(Type.String(), { description: "交付文件：你工作区里的路径" })),
				howToUse: Type.Optional(Type.String({ description: "怎么用 / 去哪看" })),
				notDone: Type.Optional(Type.String({ description: "还没做的、建议的下一步（没有就不写）" })),
			}),
			async execute(_id: string, p: { projectId: string; summary: string; deliverables?: string[]; howToUse?: string; notDone?: string }) {
				const summary = String(p.summary ?? "").trim().slice(0, 2000);
				if (!summary) return text("请写一句结果总结：做成了什么、交付物在哪里。");
				const proj = mine(p.projectId);
				if (!proj) return text("项目不存在。");
				// 先确认项目状态再登记文件，免得状态不对时白白登记
				if (proj.status !== "active") return text(proj.status === "proposed" ? "这个项目还没开始（方案还在等用户确认）。" : "这个项目已经结束了。");
				const { files, missing } = resolveFileRefs(agentId, p.deliverables, [], hostFileAccess(agentId));
				if (missing.length) return text(`没有结束项目：找不到这些文件：${missing.join("、")}（写你工作区里的路径）。`);
				try {
					finishChatProject(conversationId, proj.id, summary, { files: files.map(fileInfo), howToUse: String(p.howToUse ?? "").trim().slice(0, 1000), notDone: String(p.notDone ?? "").trim().slice(0, 1000) });
					return text(`项目「${proj.title}」已结束，交付卡已发给用户。`);
				} catch (e) {
					return text(errText(e));
				}
			},
		});
	};
}
