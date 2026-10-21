/** 群会话里的群工具：派活、提议加成员（立项出方案 / 确认开始 / 宣布完成见 project-tools.ts）。 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { type FileRow, materializeFor, workspaceOf } from "../files.ts";
import { insertMessage } from "../messages.ts";
import { listAgents } from "../runtime.ts";
import { dispatchFromRoom } from "../work-items.ts";
import { memberSchema, modelsHint, normalizeProposal, text, type ProposalMember } from "./proposals.ts";
import { roomFiles, states } from "./scheduler.ts";
import { getRoom, memberRefs, memberRow } from "./store.ts";

/**
 * 按名字在群附件里找一个文件：文件名精确匹配；只给了路径（deliverables/x.md、room-files/群/abc123-x.md）就取最后一段再匹配；同名多个取最新。
 */
export function findRoomFile(files: FileRow[], ref: string): FileRow | undefined {
	const raw = String(ref ?? "").trim();
	const last = raw.split(/[\\/]/).filter(Boolean).pop() ?? "";
	const newest = (xs: FileRow[]) => xs.sort((a, b) => b.created_at - a.created_at)[0];
	return (raw && newest(files.filter((f) => f.name === raw))) || (last && (newest(files.filter((f) => f.name === last)) || newest(files.filter((f) => `${f.id.slice(-6)}-${f.name}` === last)))) || undefined;
}
/** 把要交给负责人的群附件真的放进它的工作区；返回工作区相对路径，找不到的文件名单独列出（有一个找不到就不该派出这条）。 */
export function handOverFiles(roomId: string, assigneeId: string, refs: string[]): { paths: string[]; missing: string[] } {
	const files = roomFiles(roomId);
	const paths: string[] = [];
	const missing: string[] = [];
	for (const ref of refs.map((x) => String(x ?? "").trim()).filter(Boolean)) {
		const f = findRoomFile(files, ref);
		try {
			if (!f) throw new Error("not found");
			const rel = materializeFor(assigneeId, f, roomId);
			// 原文件已被删掉时 materializeFor 不会复制：确认真的到了负责人的工作区，否则也算找不到
			if (!existsSync(join(workspaceOf(assigneeId), rel))) throw new Error("not copied");
			paths.push(rel);
		} catch {
			missing.push(ref);
		}
	}
	return { paths, missing };
}

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
						files: Type.Optional(Type.Array(Type.String(), { description: "要交给这个成员的群附件文件名（按名字在群附件里找，会把文件放进它的工作区并把路径写进任务；找不到这条就不派出，要先让产出者把文件发到群里）" })),
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
				const failed: string[] = [];
				const queued: string[] = [];
				for (const a of p.assignments ?? []) {
					const name = String(a.agent ?? "").replace(/^[@＠]/, "").trim();
					const m = refs.find((x) => x.name === name) ?? refs.find((x) => x.name.toLowerCase() === name.toLowerCase());
					if (!m || m.id === agentId) {
						bad.push(name || "（空）");
						continue;
					}
					// 附件：真的放进负责人的工作区，任务文字里写工作区路径；有一个找不到就不派出这一条（不能报成功又什么都没给它）。
					const given = a.files?.length ? handOverFiles(roomId, m.id, a.files) : { paths: [], missing: [] };
					if (given.missing.length) {
						failed.push(`${m.name}：${given.missing.map((x) => `找不到附件 ${x}（群里没有这个文件，先让产出者把文件发到群里）`).join("；")}，这条没有派出`);
						continue;
					}
					const taskText = String(a.task ?? "") + (given.paths.length ? `\n相关附件（已放进你的工作区）：${given.paths.join("、")}` : "");
					if (a.workItemId) {
						// 长期任务：校验后直接在负责人自己的任务会话里开跑（不进群的发言队列、不占每轮上限），提交或卡住时你会被叫醒。
						try {
							dispatchFromRoom(roomId, m.id, String(a.workItemId), taskText);
						} catch (e) {
							failed.push(`${m.name}：长期任务无法派出：${e instanceof Error ? e.message : String(e)}`);
							continue;
						}
						ok.push(`${m.name}（长期任务，已在它的任务会话里开始）`);
						continue;
					}
					if (!s.assignments.some((x) => x.agentId === m.id)) s.assignments.push({ agentId: m.id, task: taskText });
					queued.push(m.name);
					ok.push(m.name);
				}
				return text([ok.length ? `已分配给：${ok.join("、")}。${queued.length ? "你说完后群里的派活会依次开始。" : ""}` : "", failed.length ? `这些没有派出：\n${failed.map((x) => `- ${x}`).join("\n")}` : "", bad.length ? `这些不是群成员（或是你自己）：${bad.join("、")}。成员有：${refs.filter((x) => x.id !== agentId).map((x) => x.name).join("、")}` : ""].filter(Boolean).join("\n"));
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
	};
}
