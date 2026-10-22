/**
 * 任务相关的模型工具。actor 都来自会话闭包（宿主绑定），不接受模型自报身份或 runId。
 *  - workItemTools：群会话里（管理者记录 / 核验 / 改派 / 请用户决定；成员只能看）；
 *  - workExecTools：负责人自己的任务会话里（提交结果 / 阻塞、汇报进展、看看板）。
 */
import { Type } from "typebox";
import { db } from "../db.ts";
import { cancelWorkItem, continueWorkItem, createWorkItem, editWorkItem, pauseWorkItem, reopenWorkItem } from "./actions.ts";
import { verifyWorkItem } from "./verify.ts";
import { roundAllows } from "./correction.ts";
import { hasDependents } from "./deps.ts";
import { reportProgress, submitWorkItem } from "./exec.ts";
import { currentSource, port } from "./ports.ts";
import { roleOf } from "../helper-scope.ts";
import { emit, event, findByName, isManager, itemRow, listWorkItems, WORK_STATUSES, type WorkActor, type WorkStatus } from "./store.ts";
import { askUserDecision, EXHAUSTED_MARK, SWITCH_HINT } from "./watch.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
const errText = (e: unknown) => text(e instanceof Error ? e.message : String(e));
type Pi = { registerTool: (t: unknown) => void };

function members(roomId: string) {
	return db.prepare("SELECT rm.agent_id AS id, COALESCE(a.name, rm.name) AS name FROM room_members rm LEFT JOIN agents a ON a.id = rm.agent_id WHERE rm.room_id = ? AND rm.left_at IS NULL AND rm.deleted = 0").all(roomId) as { id: string; name: string }[];
}
/** 管理者要把任务派给自己、而群里还有别的成员：没写 selfReason 就不让派，返回提示（列出成员名 + 角色）；放行返回 null。 */
function selfAssignBlock(roomId: string, managerId: string, ownerId: string | undefined, selfReason: string | undefined) {
	if (ownerId !== managerId || String(selfReason ?? "").trim()) return null;
	const others = db.prepare("SELECT rm.agent_id AS id, COALESCE(a.name, rm.name) AS name, a.persona FROM room_members rm LEFT JOIN agents a ON a.id = rm.agent_id WHERE rm.room_id = ? AND rm.left_at IS NULL AND rm.deleted = 0 AND rm.agent_id != ? ORDER BY rm.sort, rm.joined_at").all(roomId, managerId) as { id: string; name: string; persona: string | null }[];
	if (!others.length) return null;
	const me = db.prepare("SELECT name, persona FROM agents WHERE id = ?").get(managerId) as { name: string; persona: string | null } | undefined;
	const mine = me ? roleOf(me.persona, me.name).role : "管理者";
	return `先想清楚这件事属于谁的职责：你自己也有角色（${mine}），属于你自己职责的活，带上 selfReason 写一句「这是我的职责：…」就能派给自己；属于其他成员职责的，派给最对口的成员，不要把别人的活揽过来。现在的其他成员：\n${others.map((m) => `- ${m.name}：${roleOf(m.persona, m.name).role}`).join("\n")}`;
}
const SELF_REASON = { description: "负责人是你自己、且群里还有别的成员时需要：一句话说明这件事为什么属于你自己的角色职责（或群里没有对口的成员）" };
const memberNames = (roomId: string) => members(roomId).map((m) => m.name).join("、");
const memberByName = (roomId: string, name: string) => findByName(members(roomId), name) ?? null;

function listTool(pi: Pi, roomId: string, description: string) {
	pi.registerTool({
		name: "work_list",
		label: "查看长期任务",
		description,
		parameters: Type.Object({ status: Type.Optional(Type.Union(WORK_STATUSES.map((s) => Type.Literal(s)))) }),
		async execute(_id: string, p: { status?: WorkStatus }) {
			const out = listWorkItems(roomId, { status: p.status, limit: 30 });
			if (!out.items.length) return text("这个群还没有长期任务。");
			return text(out.items.map((x) => `- 【${x.boardLabel}】${x.title}（编号 ${x.id}，${x.statusLabel}）负责人 ${x.ownerName}；${x.needsUser ? `等用户决定：${x.needsUser.question}` : x.latestProgress || "暂无进度"}`).join("\n"));
		},
	});
}

/** 群会话里的任务工具：管理者才能记录 / 改派 / 核验 / 请用户决定；成员只能看看板（提交在自己的任务会话里）。 */
export function workItemTools(roomId: string, agentId: string) {
	const actor: WorkActor = { kind: "agent", agentId, roomId };
	const manager = isManager(roomId, agentId);
	return (pi: Pi) => {
		listTool(pi, roomId, manager ? "（管理者）查看这个群的任务看板：状态、负责人、最近进度、等用户决定的事。" : "查看这个群的任务看板（你负责的任务在你自己的任务会话里执行和提交）。");
		if (!manager) return;
		pi.registerTool({
			name: "work_create",
			label: "记录长期任务",
			description:
				"（管理者）把需要长期负责、可能多次执行或交接的工作记录成任务，并（默认）马上派给一位成员开始。群聊是分工合作：你自己也有角色，属于你自己职责的活你自己做（负责人填你自己，并写 selfReason 说明这是你的职责），属于其他成员职责的派给最对口的成员，不要把别人的活揽过来；你同时负责拆解、协调、核验、整合和跟用户沟通。负责人会在自己的任务会话里用自己的记忆、权限和电脑去做，不占群里的发言。临时问答、一次工具步骤不要建任务；普通文字回复也不能当验收。目标 / 范围 / 关键约束 / 完成标准不清楚时，先用一句话问清最必要的问题，不要替用户编造需求或笼统的完成标准。\n" +
				"任务与单次执行分开：改派 / 退回 / 继续都会保留历史，执行结束不会自动完成。\n" +
				"依赖：有前置任务（after）时，前置没全部完成这个任务就先停在待安排，不会派活；前置全部完成后系统会自动开始并把前置的交接单和成果文件交给负责人，不用你记得去派。",
			parameters: Type.Object({
				title: Type.String({ description: "任务名字（简短具体）" }),
				requirement: Type.Optional(Type.String({ description: "要做成什么、背景和约束" })),
				doneCriteria: Type.Optional(Type.String({ description: "完成标准：怎样才算做成（可检查）" })),
				owner: Type.Optional(Type.String({ description: "负责人名字（群成员）；按角色选最对口的成员" })),
				selfReason: Type.Optional(Type.String(SELF_REASON)),
				start: Type.Optional(Type.Boolean({ description: "是否马上派给负责人开始，默认是；只记录责任时传 false" })),
				projectId: Type.Optional(Type.String({ description: "这个任务属于哪个进行中的项目（项目编号）；群里只有一个进行中的项目时可以不填，默认挂到它上面" })),
				after: Type.Optional(Type.Array(Type.String(), { description: "前置任务（编号或任务名，同一个群）；要等这些任务全部完成才会自动开始" })),
				stage: Type.Optional(Type.String({ description: "属于方案里的哪个阶段（阶段名，和方案里的阶段对应）；没有阶段限制也可以不填" })),
			}),
			async execute(_id: string, p: { title: string; requirement?: string; doneCriteria?: string; owner?: string; selfReason?: string; start?: boolean; projectId?: string; after?: string[]; stage?: string }) {
				const projects = port()?.activeProjects(roomId) ?? [];
				const projectId = p.projectId?.trim() ? p.projectId.trim() : projects.length === 1 ? projects[0].id : null;
				if (projectId && !projects.some((x) => x.id === projectId)) return text(`「${p.projectId}」不是这个群进行中的项目。${projects.length ? `进行中的项目：${projects.map((x) => `「${x.title}」（项目编号 ${x.id}）`).join("、")}` : "现在没有进行中的项目，不属于项目的任务不用填 projectId。"}`);
				const owner = p.owner ? memberByName(roomId, p.owner) : null;
				if (p.owner && !owner) return text(`找不到成员「${p.owner}」，可用成员：${memberNames(roomId)}`);
				const blocked = selfAssignBlock(roomId, agentId, owner?.id, p.selfReason);
				if (blocked) return text(blocked);
				if (!String(p.requirement ?? "").trim() || !String(p.doneCriteria ?? "").trim()) return text("先别记录执行：目标 / 范围或完成标准还不清楚。先问用户一个关键问题（怎样检查算做完），得到明确回答后再用 work_create；方法和技术细节可以自己定。");
				try {
					const { item } = createWorkItem(
						{ roomId, title: p.title, requirement: p.requirement, doneCriteria: p.doneCriteria, ownerAgentId: owner?.id ?? null, start: p.start !== false && !!owner, sourceMessageId: currentSource(roomId), projectId, after: p.after, stage: p.stage, taskText: [p.title, p.requirement, p.doneCriteria].filter(Boolean).join("\n") },
						actor,
					);
					if (owner?.id === agentId && p.selfReason?.trim()) event(item.id, "self_owner_reason", actor, item.revision, { reason: p.selfReason.trim().slice(0, 200) });
					emit(roomId);
					return text(`已记录任务「${item.title}」（编号 ${item.id}，${item.statusLabel}${owner ? `，负责人 ${owner.name}` : ""}${owner && p.start !== false && item.status === "active" ? "，已在它自己的任务会话里开始执行" : ""}）。它提交或卡住时你会被叫醒；核验时用 work_verify 写清检查结论。`);
				} catch (e) {
					return errText(e);
				}
			},
		});
		pi.registerTool({
			name: "work_verify",
			label: "核验任务",
			description:
				"（管理者）核验成员提交的任务，读真实产物。你自己负责、已经直接做完的任务也用它收尾（verdict=pass，note 写清产物在哪、怎么核对过）。note 必须写检查结论。三种结论：pass = 对照完成标准都满足，任务完成；return = 没达到但这条路走得通，写清怎么改，任务保持进行中并自动安排下一次执行；impossible = 这条路走不通（不是没做好，是方法 / 方向本身行不通），不会再自动重做，直接交给你换做法或改方案，别再原样退回重做。核验完要在群里用一两句话说明结论和交付在哪里；失败或阻塞也要在原群说清楚（不要只更新看板，也不要逐个工具细节刷屏）。",
			parameters: Type.Object({
				workItemId: Type.String({ description: "任务编号" }),
				verdict: Type.Union([Type.Literal("pass"), Type.Literal("return"), Type.Literal("impossible")], { description: "pass = 通过完成；return = 退回修改（这条路走得通）；impossible = 这条路走不通，要换做法或改方案" }),
				note: Type.String({ description: "检查结论（必填）" }),
			}),
			async execute(_id: string, p: { workItemId: string; verdict: "pass" | "return" | "impossible"; note: string }) {
				try {
					const r = await verifyWorkItem({ workItemId: p.workItemId, actor, verdict: p.verdict, note: p.note });
					emit(roomId);
					if (p.verdict === "impossible") return text(`已标为「这条路走不通」：${r.item.title}。现在就改计划，别原样重做：带着改进意见重做、换更对口的成员、把任务拆小、换一种做法，或者改方案（影响目标 / 范围 / 交付物时用 room_plan 请用户重新确认）；用 room_project_replan 记一下。`);
					if (p.verdict === "return" && r.item.status === "blocked") {
						const exhausted = r.item.blocker?.startsWith(EXHAUSTED_MARK);
						return text(`已退回：${r.item.title}。${exhausted ? `这个任务${EXHAUSTED_MARK}：请你在群里跟用户说清楚问题是什么、需要用户帮什么或哪个决定你无权拍板。` : `这个任务已反复退回，任务标为受阻，没有再自动重做。${SWITCH_HINT}`}`);
					}
					return text(`已${p.verdict === "pass" ? "核验通过，任务完成" : "退回修改，任务保持进行中"}：${r.item.title}`);
				} catch (e) {
					return errText(e);
				}
			},
		});
		pi.registerTool({
			name: "work_update",
			label: "改长期任务",
			description: "（管理者）改派负责人、编辑要求 / 完成标准，或暂停 / 取消 / 继续一个长期任务。",
			parameters: Type.Object({
				workItemId: Type.String({ description: "任务编号" }),
				action: Type.Union([Type.Literal("assign"), Type.Literal("edit"), Type.Literal("continue"), Type.Literal("pause"), Type.Literal("cancel"), Type.Literal("reopen")]),
				owner: Type.Optional(Type.String({ description: "改派时的负责人名字；按角色选最对口的成员" })),
				selfReason: Type.Optional(Type.String(SELF_REASON)),
				title: Type.Optional(Type.String()),
				requirement: Type.Optional(Type.String()),
				doneCriteria: Type.Optional(Type.String()),
				after: Type.Optional(Type.Array(Type.String(), { description: "改前置任务（编号或任务名）；传空数组清空前置" })),
				stage: Type.Optional(Type.String({ description: "改所属阶段（阶段名）；传空字符串清空" })),
			}),
			async execute(_id: string, p: { workItemId: string; action: "assign" | "edit" | "continue" | "pause" | "cancel" | "reopen"; owner?: string; selfReason?: string; title?: string; requirement?: string; doneCriteria?: string; after?: string[]; stage?: string }) {
				try {
					let d;
					if (p.action === "assign" || p.action === "edit") {
						const owner = p.owner ? memberByName(roomId, p.owner) : undefined;
						if (p.owner && !owner) return text(`找不到成员「${p.owner}」`);
						const blocked = p.action === "assign" ? selfAssignBlock(roomId, agentId, owner?.id, p.selfReason) : null;
						if (blocked) return text(blocked);
						d = editWorkItem({ workItemId: p.workItemId, actor, title: p.title, requirement: p.requirement, doneCriteria: p.doneCriteria, after: p.after, ...(p.stage !== undefined ? { stage: p.stage || null } : {}), ...(p.action === "assign" ? { ownerAgentId: owner?.id ?? null } : {}) });
					} else if (p.action === "pause") d = await pauseWorkItem({ workItemId: p.workItemId, actor });
					else if (p.action === "cancel") d = await cancelWorkItem({ workItemId: p.workItemId, actor });
					else if (p.action === "reopen") {
						if (!roundAllows(roomId, p.workItemId, "reopen")) return text("这条用户消息没有明确要求重开这个任务；先问清用户是不是要改，再重开。");
						d = reopenWorkItem({ workItemId: p.workItemId, actor, note: "用户要求在群里修改" });
					} else {
						if (!roundAllows(roomId, p.workItemId, "continue") && itemRow(p.workItemId)?.status === "paused") return text("任务已暂停。用户没有明确说继续，先不要自动恢复执行。");
						d = await continueWorkItem({ workItemId: p.workItemId, actor });
					}
					if (p.action === "assign" && d.item.ownerAgentId === agentId && p.selfReason?.trim()) event(p.workItemId, "self_owner_reason", actor, d.item.revision, { reason: p.selfReason.trim().slice(0, 200) });
					const label = { assign: "改派", edit: "更新要求", continue: "继续", pause: "暂停", cancel: "取消", reopen: "重开" }[p.action];
					return text(`已${label}「${d.item.title}」：${d.item.statusLabel}${d.item.ownerName ? `，负责人 ${d.item.ownerName}` : ""}。`);
				} catch (e) {
					return errText(e);
				}
			},
		});
		pi.registerTool({
			name: "work_ask_user",
			label: "请用户决定",
			description: "（管理者）大部分决定按群目标自己分析、自己推进，不要问。只在两种情况用：需要用户才能给的帮助（批准 / 授权、登录凭据、只有用户有的资源），或者决定超出了群目标、你无权拍板。卡住、反复退回由你自己换方法或改派。任务进入「等你决定」，用户会收到提问卡片和推送。问的时候说清问题是什么、需要用户做什么，给 2–4 个具体选项。",
			parameters: Type.Object({
				workItemId: Type.String({ description: "任务编号" }),
				question: Type.String({ description: "要用户决定的一件事（一句话）" }),
				options: Type.Optional(Type.Array(Type.String(), { description: "可选答案" })),
				reason: Type.Optional(Type.String({ description: "为什么需要用户决定" })),
			}),
			async execute(_id: string, p: { workItemId: string; question: string; options?: string[]; reason?: string }) {
				const row = itemRow(p.workItemId);
				if (!row || row.room_id !== roomId) return text("任务不存在或不在这个群。");
				try {
					await askUserDecision(row.id, { question: p.question, options: p.options, reason: p.reason });
					return text(`已放进「等你决定」：${p.question.slice(0, 80)}。用户回答后你会收到他的决定。`);
				} catch (e) {
					return errText(e);
				}
			},
		});
	};
}

/** 负责人任务会话里的工具：只认这个任务、只认这个会话里正在跑的执行。 */
export function workExecTools(itemId: string, agentId: string, conversationId: string) {
	const actor: WorkActor = { kind: "agent", agentId };
	const roomId = itemRow(itemId)?.room_id ?? "";
	return (pi: Pi) => {
		listTool(pi, roomId, "查看群里的任务看板（了解别人在做什么、避免重复）。");
		pi.registerTool({
			name: "work_submit",
			label: "提交任务结果",
			description:
				"把这个任务的结果或真实阻塞提交给管理者核验。执行结束不等于任务完成，必须提交；不能改状态或负责人。\n" +
				"交接单：有别的任务要等你的成果时，写 handoff（做了什么、东西在哪、接手的人要注意什么、还有什么没做）+ files（工作区里的成果文件路径），下游任务自动开始时会把这些交给接手的人，不用你自己去通知。",
			parameters: Type.Object({
				result: Type.Optional(Type.String({ description: "实际做了什么、产物在哪里、怎么检查" })),
				blocker: Type.Optional(Type.String({ description: "做不下去的真实原因（没有就不填）" })),
				workItemId: Type.Optional(Type.String({ description: "任务编号（可省略，默认就是当前任务）" })),
				handoff: Type.Optional(Type.String({ description: "交接说明：做了什么、东西在哪、接手的人要注意什么、还有什么没做" })),
				files: Type.Optional(Type.Array(Type.String(), { description: "成果文件在你工作区里的路径（有下游任务等着时尽量带上）" })),
			}),
			async execute(_id: string, p: { result?: string; blocker?: string; workItemId?: string; handoff?: string; files?: string[] }) {
				if (p.workItemId && p.workItemId !== itemId) return text(`这个会话只负责任务 ${itemId}，不能提交别的任务。`);
				try {
					const r = submitWorkItem({ workItemId: itemId, conversationId, actor, result: p.result, blocker: p.blocker, handoff: p.handoff, files: p.files });
					const missing = r.missingFiles.length ? `\n找不到这些文件，没有登记：${r.missingFiles.join("、")}（提交已生效，没有因此失败）。` : "";
					const remind = r.applied && !p.blocker && !p.handoff?.trim() && hasDependents(itemId) ? "\n有别的任务在等你的成果，建议补一段交接说明（work_submit 的 handoff）。" : "";
					return text((r.applied ? `已提交，等待核验。${r.item.item.blocker ? "已标为受阻，管理者会来处理。" : ""}` : "这次结果属于旧修订（任务已改派 / 退回 / 暂停或取消），已作为历史保留，未覆盖当前任务。") + missing + remind);
				} catch (e) {
					return errText(e);
				}
			},
		});
		pi.registerTool({
			name: "work_report",
			label: "汇报进展",
			description: "做到一半时记一句阶段性进展（看板会显示，也说明你没有卡住）。不是提交；做完仍要 work_submit。",
			parameters: Type.Object({ note: Type.String({ description: "做到哪了、接下来做什么" }) }),
			async execute(_id: string, p: { note: string }) {
				try {
					reportProgress({ workItemId: itemId, conversationId, actor, note: p.note });
					return text("已记录进展。");
				} catch (e) {
					return errText(e);
				}
			},
		});
	};
}
