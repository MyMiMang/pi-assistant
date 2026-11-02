/**
 * 群回合给模型的提示（从 scheduler.ts 拆出）：按回合原因写的那一行说明、群里出现过的附件、该成员没看过的群消息整理成的转录。
 */
import { db } from "../db.ts";
import { type FileRow, getFile, materializeFor } from "../files.ts";
import { getAgent } from "../runtime.ts";
import { askIdOf } from "./ask-logic.ts";
import { buildTranscript, type PlannedTurn, type TranscriptItem } from "./logic.ts";
import { memberRow, membersOf } from "./store.ts";

/** 每轮附带的那一行说明：只写这次为什么轮到你；怎么做的规则（立项、被叫醒、项目推进）在群规则里只写一次（决策 0022 第 1 步）。 */
export const REASON_LINE = (t: PlannedTurn, managerName: string, depthLeft: number, projectActive = false) =>
	({
		mention: "用户在群里 @ 了你。请直接回应用户最新的消息（只做用户让你做的，别替其他成员回答）。",
		manager:
			"用户没有 @ 任何人，由你（管理者）负责：先理解用户要什么。简单的事你自己直接回答；需要其他成员做的，调用 room_assign 分配（每个人写清楚具体任务），并在回复里用一两句话说明分工。不需要别人时不要分配。需要长期负责、可检查的工作用 work_create 记成任务，成员会在自己的任务会话里去做。按群规则里的来意判断处理。",
		assign: `管理者 ${managerName} 给你分配了任务：${t.task?.trim() || "（见管理者上面的消息）"}\n完成后在群里简洁汇报结果。`,
		followup: `你分配的成员都已结束（有失败、受阻或待核验的也在上面）。请先核验 / 处理这些结果，再给用户一个简短的总结，不要重复成员说过的细节；还需要继续时可以再用 room_assign 分配${depthLeft > 0 ? `（还能再派 ${depthLeft} 次）` : "（这一轮已不能再派活）"}。${projectActive ? "有项目在进行：按群规则里的项目推进规则接着做。" : ""}`,
		resume: "（系统通知）服务重启或用户让你继续：上一次发言可能被中断了。请检查进度，接着完成你在群里的任务；已经完成就简短说明。",
		check: `任务看板有变化，需要你（管理者）看一下：按群规则里「被叫醒看看板时」的做法处理${projectActive ? "，有项目在进行就按项目推进规则接着做" : ""}。下面是唤醒原因和看板摘要。`,
		timer: `这是你之前在群里约好的跟进，现在到点了，备注是：${t.task?.trim().slice(0, 1500) || "（没有备注）"}\n按备注去做（需要的话先看上面的群消息），然后在群里简短告诉用户结果。这不是用户刚发的消息，别当成用户在说话；备注里没有要做的事就简短说明情况。`,
		proactive: `后台巡检发现下面这件事值得主动推进（不是用户刚发的消息，别当成用户在说话）：\n${t.task?.trim().slice(0, 1500) || "（没有说明）"}\n先看上面的群消息核对用户最近的真实要求：目标清楚且在原授权内（或属于用户写的「可以放心做的事」）就直接做完，然后在群里简短告诉大家结果；不清楚就先在群里问清楚。对外承诺、花钱、破坏性改动、权限变更先问用户。用户说过停止就停手。`,
		peer: askIdOf(t.task)
			? `${t.task!.trim().slice(0, 2500)}\n这是一个可追踪的提问：按上面说的用工具处理，回答只送给提问的人，不用再在群里重复一遍。`
			: `${getAgent(t.from ?? "")?.name ?? "一位成员"} 在群里 @ 了你：${t.task?.trim().slice(0, 1500) || "（见上面的消息）"}\n直接在群里简短回复它；需要你动手的就做。不要替管理者分配任务，也不要只客套。`,
	})[t.reason];

/** 群里出现过的全部附件（用户上传 + 成员发出的） */
export function roomFiles(roomId: string): FileRow[] {
	const ids = new Set<string>();
	for (const m of db.prepare("SELECT meta FROM messages WHERE room_id = ? AND meta LIKE '%fileId%'").all(roomId) as { meta: string }[])
		for (const f of (JSON.parse(m.meta).attachments as { fileId?: string }[] | undefined) ?? []) if (f.fileId) ids.add(f.fileId);
	return [...ids].map(getFile).filter((f): f is FileRow => !!f);
}

export function transcriptFor(roomId: string, agentId: string, budget = 16_000) {
	const m = memberRow(roomId, agentId)!;
	const rows = (
		m.cursor == null
			? db.prepare("SELECT rowid AS seq, * FROM messages WHERE room_id = ? AND role IN ('user','assistant','system','card') ORDER BY rowid DESC LIMIT 300").all(roomId).reverse()
			: db.prepare("SELECT rowid AS seq, * FROM messages WHERE room_id = ? AND rowid > ? AND role IN ('user','assistant','system','card') ORDER BY rowid LIMIT 500").all(roomId, m.cursor)
	) as { seq: number; role: TranscriptItem["role"]; agent_id: string; content: string; meta: string; status: string }[];
	const items: TranscriptItem[] = rows.map((x) => ({ seq: x.seq, role: x.role, agentId: x.agent_id, content: x.content, meta: JSON.parse(x.meta), status: x.status }));
	const names = new Map(membersOf(roomId, true).map((x) => [x.agent_id, getAgent(x.agent_id)?.name ?? x.name]));
	const paths = new Map<string, string>();
	const pathOf = (tf: { fileId: string }) => {
		if (!paths.has(tf.fileId)) {
			const f = getFile(tf.fileId);
			if (f) {
				try {
					paths.set(tf.fileId, materializeFor(agentId, f, roomId));
				} catch {
					/* 文件丢了：只写名字 */
				}
			}
		}
		return paths.get(tf.fileId);
	};
	return buildTranscript(items, agentId, (id) => names.get(id) ?? "助理", budget, pathOf);
}
