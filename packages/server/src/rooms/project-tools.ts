/**
 * 管理者的项目工具（docs/design/group-team.md §3、决策 0019）：出方案卡、用户在群里说可以时确认开始、宣布项目完成。
 * 按钮确认 / 取消走 HTTP（routes/rooms.ts → projects.ts），这里是管理者在对话里主动调用的三个工具。
 */
import { Type } from "typebox";
import { fileInfo } from "../files.ts";
import { askCheckpoint } from "./checkpoint.ts";
import { MISSING_HINT, resolveFiles } from "./deliver.ts";
import { checkPlan, normalizePlan } from "./plan.ts";
import { confirmProject, finishProject, getProject, proposePlan, replanProject, resumeProject, userRepliedAfterStop, userRepliedToCard } from "./projects.ts";
import { getRoom, memberRefs } from "./store.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
type Pi = { registerTool: (t: unknown) => void };

const PLAN_FIELDS = {
	goal: Type.String({ description: "要做成什么（一两句）" }),
	doneCriteria: Type.String({ description: "做到什么程度算完成（可检查）" }),
	assumptions: Type.Optional(Type.Array(Type.String(), { description: "我们的理解 / 假设，最关键的放前面" })),
	roles: Type.Array(Type.Object({ member: Type.String({ description: "群成员名字（含你自己）" }), does: Type.String({ description: "负责什么" }) }), { description: "分工（含管理者自己）" }),
	stages: Type.Array(Type.Object({ name: Type.String(), output: Type.String({ description: "这个阶段交出什么" }) }), { description: "分几个阶段" }),
	checkpoints: Type.Optional(Type.Array(Type.String(), { description: "哪几个关键点会请用户看一眼" })),
	deliverables: Type.String({ description: "最后交给用户什么" }),
	needs: Type.Optional(Type.String({ description: "需要用户提供什么，没有就不写" })),
	scale: Type.Optional(Type.String({ description: "规模感：大概多久、工作量的量级，不写精确数字" })),
};

export function projectTools(roomId: string, agentId: string) {
	return (pi: Pi) => {
		pi.registerTool({
			name: "room_plan",
			label: "出方案卡",
			description: "（只有管理者可用）把想清楚的方案发给用户确认：不带 projectId 是新立项；带 projectId 且这个项目还在等确认是改方案（重新发卡）；带 projectId 且项目已经在进行中是「进行中改方案」（写进草稿，用户重新确认后才生效，取消则按原方案继续）。确认前不要建任务、不要派活开工。",
			parameters: Type.Object({ title: Type.String({ description: "项目名，不超过 40 字" }), projectId: Type.Optional(Type.String({ description: "改已有项目的方案时填" })), ...PLAN_FIELDS }),
			async execute(_id: string, p: { title: string; projectId?: string } & Record<string, unknown>) {
				const r = getRoom(roomId);
				if (!r || r.manager_id !== agentId) return text("只有管理者能出方案卡。");
				const plan = normalizePlan(p);
				const checked = checkPlan(plan, memberRefs(roomId));
				if (checked.error || !checked.plan) return text(checked.error ?? "方案校验失败。");
				try {
					const { project, revision } = proposePlan({ roomId, managerId: agentId, title: p.title, plan: checked.plan, projectId: p.projectId?.trim() || undefined });
					return text(`方案卡已发给用户（项目编号 ${project.id}）。等用户确认后再派任务开工；用户在群里说可以，就用 room_project_start 开始${revision ? "（这是改过的方案，等用户重新确认）" : ""}。`);
				} catch (e) {
					return text(e instanceof Error ? e.message : String(e));
				}
			},
		});
		pi.registerTool({
			name: "room_project_start",
			label: "确认项目开始",
			description: "（只有管理者可用）用户在群里明确同意方案（比如说「可以」「就这么干」）时调用，效果和用户点「就这么干」一样。只有这份方案卡确认发出之后群里有用户本人的消息才能调用，不能替用户确认。",
			parameters: Type.Object({ projectId: Type.String({ description: "方案对应的项目编号" }) }),
			async execute(_id: string, p: { projectId: string }) {
				const r = getRoom(roomId);
				if (!r || r.manager_id !== agentId) return text("只有管理者能确认项目开始。");
				const proj = getProject(p.projectId);
				if (!proj || proj.room_id !== roomId) return text("项目不存在。");
				// 只在这份方案真的还等着用户确认时才检查「用户回复过没有」；已经处理过的交给 confirmProject 自己报错，别说成「用户还没回复」。
				const confirmable = proj.status === "proposed" || (proj.status === "active" && !!proj.draft);
				if (confirmable && !userRepliedToCard(proj)) return text("用户还没回复这份方案，不能替用户确认。");
				const wasRevision = proj.status === "active";
				try {
					confirmProject(roomId, p.projectId, "manager");
				} catch (e) {
					return text(e instanceof Error ? e.message : String(e));
				}
				return text(wasRevision ? `已确认，项目「${proj.title}」按新方案继续。` : `已确认，项目「${proj.title}」开始了：按方案的分工和阶段把第一批任务派下去。`);
			},
		});
		pi.registerTool({
			name: "room_project_resume",
			label: "恢复已停下的项目",
			description: "（只有管理者可用）用户说「接着做 / 继续」且指的是某个已停下的项目时调用，从停下的地方继续。只有这个项目停下之后群里有用户本人的消息才能调用，不能自己恢复用户停下的项目。",
			parameters: Type.Object({ projectId: Type.String({ description: "要恢复的项目编号" }) }),
			async execute(_id: string, p: { projectId: string }) {
				const r = getRoom(roomId);
				if (!r || r.manager_id !== agentId) return text("只有管理者能恢复项目。");
				const proj = getProject(p.projectId);
				if (!proj || proj.room_id !== roomId) return text("项目不存在。");
				if (proj.status !== "stopped") return text(proj.status === "active" ? "这个项目正在进行中，不用恢复。" : "这个项目不是已停下的状态，不能恢复。");
				if (!userRepliedAfterStop(proj)) return text("项目停下之后用户还没有再发话，不能自己恢复；等用户明确说接着做再调用。");
				try {
					await resumeProject(roomId, p.projectId);
				} catch (e) {
					return text(e instanceof Error ? e.message : String(e));
				}
				return text(`已恢复，项目「${proj.title}」接着做，从停下的地方继续。`);
			},
		});
		pi.registerTool({
			name: "room_project_replan",
			label: "记录改计划",
			description: "（只有管理者可用）项目连续几次没有进展、被要求改计划时调用：记下为什么卡住、选了哪种改法。change = plan 时改完还要再用 room_plan 出新方案请用户确认（影响目标 / 范围 / 交付物才需要）；其余几种改法记完就可以照新办法继续推进，不用等用户确认。",
			parameters: Type.Object({
				projectId: Type.String(),
				why: Type.String({ description: "一两句话：为什么卡住" }),
				change: Type.Union([Type.Literal("retry"), Type.Literal("reassign"), Type.Literal("split"), Type.Literal("approach"), Type.Literal("plan")], {
					description: "retry=带着改进意见重做；reassign=换更对口的成员；split=把任务拆小；approach=换一种做法；plan=改方案（需要用户重新确认）",
				}),
				detail: Type.String({ description: "具体怎么改" }),
			}),
			async execute(_id: string, p: { projectId: string; why: string; change: "retry" | "reassign" | "split" | "approach" | "plan"; detail: string }) {
				const r = getRoom(roomId);
				if (!r || r.manager_id !== agentId) return text("只有管理者能记录改计划。");
				const proj = getProject(p.projectId);
				if (!proj || proj.room_id !== roomId) return text("项目不存在。");
				try {
					replanProject(roomId, p.projectId, { why: p.why, change: p.change, detail: p.detail });
				} catch (e) {
					return text(e instanceof Error ? e.message : String(e));
				}
				return text(`已记录改计划。${p.change === "plan" ? "改方案影响目标 / 范围 / 交付物，接着用 room_plan（带 projectId）出新方案请用户重新确认。" : "按新办法继续推进。"}`);
			},
		});
		pi.registerTool({
			name: "room_checkpoint",
			label: "请用户看关键点",
			description: "（只有管理者可用）方案里写的关键点到了，请用户看一眼：群里出一张确认卡片（可以给几个选项让用户挑，也可以附上要看的文件），用户答复后会以用户的话发回群里，你再按答复继续。其余进度只通知，不要用它提问；不受这个关键点影响的任务照常推进，受影响的等用户答复后再做。",
			parameters: Type.Object({
				projectId: Type.String(),
				checkpoint: Type.String({ description: "方案里的哪个关键点（尽量照方案里的写法）" }),
				message: Type.String({ description: "要用户看什么、为什么现在看（两三句话）" }),
				options: Type.Optional(Type.Array(Type.String(), { description: "可选：2–4 个选项（比如几个方向让用户挑）；不给就是「可以，继续」「要改」" })),
				files: Type.Optional(Type.Array(Type.String(), { description: "可选：要给用户看的文件（群里已有的文件名，或你工作区里的路径）" })),
			}),
			async execute(_id: string, p: { projectId: string; checkpoint: string; message: string; options?: string[]; files?: string[] }) {
				const r = getRoom(roomId);
				if (!r || r.manager_id !== agentId) return text("只有管理者能请用户确认关键点。");
				const res = askCheckpoint({ roomId, managerId: agentId, projectId: p.projectId, checkpoint: p.checkpoint, message: p.message, options: p.options, files: p.files });
				return text(res.ok ? res.text : res.error);
			},
		});
		pi.registerTool({
			name: "room_project_done",
			label: "宣布项目完成",
			description: "（只有管理者可用）对照完成标准逐条核对过、确认都满足时调用：结束项目，群里发一张交付卡（做成了什么、交付文件、怎么用、还没做的）。最终要交给用户的文件放进 deliverables（群里已有的文件名，或你工作区里的路径）。",
			parameters: Type.Object({
				projectId: Type.String(),
				summary: Type.String({ description: "做成了什么：对照完成标准怎么满足的（简短）" }),
				deliverables: Type.Optional(Type.Array(Type.String(), { description: "交付文件：群里已有的文件名，或你工作区里的路径" })),
				howToUse: Type.Optional(Type.String({ description: "怎么用 / 去哪看" })),
				notDone: Type.Optional(Type.String({ description: "还没做的、建议的下一步（没有就不写）" })),
			}),
			async execute(_id: string, p: { projectId: string; summary: string; deliverables?: string[]; howToUse?: string; notDone?: string }) {
				const r = getRoom(roomId);
				if (!r || r.manager_id !== agentId) return text("只有管理者能宣布项目完成。");
				const summary = String(p.summary ?? "").trim().slice(0, 2000);
				if (!summary) return text("请写一句结果总结：做成了什么、交付物在哪里。");
				const proj = getProject(p.projectId);
				if (!proj || proj.room_id !== roomId) return text("项目不存在。");
				// 先确认项目状态再登记文件，免得状态不对时白白登记
				if (proj.status !== "active") return text(proj.status === "proposed" ? "这个项目还没开始（方案还在等用户确认）。" : "这个项目已经结束了。");
				const { files, missing } = resolveFiles(roomId, agentId, p.deliverables);
				if (missing.length) return text(`没有结束项目：${MISSING_HINT(missing)}。`);
				try {
					finishProject(roomId, p.projectId, summary, { files: files.map(fileInfo), howToUse: String(p.howToUse ?? "").trim().slice(0, 1000), notDone: String(p.notDone ?? "").trim().slice(0, 1000), managerId: agentId });
					return text(`项目「${proj.title}」已结束，交付卡已发到群里。`);
				} catch (e) {
					return text(e instanceof Error ? e.message : String(e));
				}
			},
		});
	};
}
