/**
 * 群里的帮手（决策 0014 第 5 步）：
 *  - 角色范围：群成员（比如被分配成「编剧」的助理）派帮手时，帮手的说明自动带上它代表谁、这个角色的职责、
 *    子任务、完成标准和不归它管的事（其他成员的角色）；帮手不替别的角色干活、不直接找群成员或协调者，
 *    超出范围的交回派它的助理，由那个助理决定或上报协调者。下一层帮手继承同样的范围（spawnSubagent 里继承 scope）。
 *  - 执行详情（2026-10-20 用户定，没有开关）：群里别的成员列帮手时只看概况（谁派的、在做什么、做到哪一步、结果）；
 *    需要时点名查某一个帮手（subagent_list 带 subagent_id）就给完整记录和工具步骤。用户在界面里随时能看全部。
 */
import { bus } from "./bus.ts";
import { db } from "./db.ts";
import { roomOfConversation } from "./messages.ts";
import { isLiveSubagent, stopSubagent, type Subagent } from "./subagents.ts";

const clip = (s: string | null | undefined, n: number) => {
	const t = String(s ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};
interface Member { agentId: string; name: string; role: string; duty: string }
/** 群成员的角色：建群时写进人设的「你在群里的角色：…」，没有就用人设第一句。 */
export function roleOf(persona: string | null | undefined, name: string): { role: string; duty: string } {
	const p = String(persona ?? "");
	const m = p.match(/你在群里的角色[：:]\s*(.+)/);
	const role = clip(m?.[1] ?? p.split(/\n|。/)[0], 40) || name;
	const duty = clip(p.replace(/你在群里的角色[：:].*\n?/, ""), 300);
	return { role, duty };
}
const membersOf = (roomId: string): Member[] =>
	(db.prepare("SELECT rm.agent_id, rm.name, a.persona FROM room_members rm LEFT JOIN agents a ON a.id = rm.agent_id WHERE rm.room_id = ? AND rm.left_at IS NULL AND rm.deleted = 0 ORDER BY rm.sort, rm.joined_at").all(roomId) as { agent_id: string; name: string; persona: string | null }[])
		.map((r) => ({ agentId: r.agent_id, name: r.name, ...roleOf(r.persona, r.name) }));

/** 这个会话属于哪个群（成员的群内会话或群任务的执行会话）；不在群里返回 null。 */
export const helperRoomOf = (conversationId: string | null | undefined) => roomOfConversation(conversationId);

/**
 * 群成员派帮手时的角色范围说明（写进帮手的系统规则，续跑 / 重启都在）。不在群里返回 null（单聊不加）。
 * 子任务本身和完成标准另外写进帮手的第一条说明（见 scopedContext）。
 */
export function helperScope(agentId: string, conversationId: string | null | undefined): string | null {
	const roomId = helperRoomOf(conversationId);
	if (!roomId) return null;
	const room = db.prepare("SELECT name, manager_id FROM rooms WHERE id = ?").get(roomId) as { name: string; manager_id: string | null } | undefined;
	if (!room) return null;
	const members = membersOf(roomId);
	const me = members.find((m) => m.agentId === agentId) ?? { agentId, name: agentId, role: "成员", duty: "" };
	const coordinator = members.find((m) => m.agentId === room.manager_id);
	const others = members.filter((m) => m.agentId !== agentId).map((m) => `${m.name}（${m.agentId === room.manager_id ? "协调者" : m.role}）`);
	const work = db.prepare("SELECT w.title, w.done_criteria FROM work_exec_conversations e JOIN work_items w ON w.id = e.work_item_id WHERE e.conversation_id = ?").get(conversationId ?? "") as { title: string; done_criteria: string | null } | undefined;
	return [
		`【帮手范围】你代表群「${room.name}」里的 ${me.name}（角色：${me.role}）工作，只做这个角色职责内的事。`,
		`这个角色的职责：${me.duty || me.role}`,
		work ? `所属群任务：${work.title}${work.done_criteria ? `（任务的完成标准：${clip(work.done_criteria, 300)}）` : ""}` : "",
		others.length ? `不归你管（其他成员的角色）：${others.join("、")}。不要替他们做他们角色的事。` : "",
		`不要直接联系群里的其他成员或${coordinator ? `协调者 ${coordinator.name}` : "协调者"}（也不要通过文件、邮件等别的渠道找他们）。超出这个角色范围、或需要别人配合的事：这一部分停下，在结果摘要里写「超出范围：…」交回给 ${me.name}，由它决定或上报协调者。`,
		"你再派的下一层帮手继承同样的范围。",
	].filter(Boolean).join("\n");
}
/** 帮手第一条说明里的子任务完成标准（有角色范围时一定写；没给就用通用标准）。 */
export function scopedContext(scope: string | null, doneCriteria: string | undefined, context: string | undefined) {
	if (!scope) return context;
	const done = clip(doneCriteria, 600) || "完成上面的子任务，并在结果摘要里写清产出在哪、怎么检查";
	return [`完成标准：${done}`, context ?? ""].filter(Boolean).join("\n");
}

/** 帮手最近的工具步骤（完整执行详情的一部分）。 */
export function helperSteps(id: string, n = 8) {
	const rows = db.prepare("SELECT content, meta FROM messages WHERE subagent_id = ? AND role = 'tool' ORDER BY rowid DESC LIMIT ?").all(id, n) as { content: string; meta: string }[];
	return rows.reverse().map((m) => {
		let meta: { toolName?: string; status?: string } = {};
		try { meta = JSON.parse(m.meta); } catch { /* 坏数据 */ }
		return { tool: meta.toolName ?? "", status: meta.status ?? "", output: clip(m.content, 300) };
	});
}
const agentName = (id: string) => (db.prepare("SELECT name FROM agents WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? id;
/** 群里人人能看的帮手概况：谁派的、在做什么、做到哪一步、进展摘要、结果（不含工具步骤和命令输出）。 */
export function helperSummary(r: Subagent) {
	const steps = helperSteps(r.id, 1);
	const said = db.prepare("SELECT content FROM messages WHERE subagent_id = ? AND role = 'assistant' AND content != '' ORDER BY rowid DESC LIMIT 1").get(r.id) as { content: string } | undefined;
	return {
		id: r.id,
		spawnedBy: agentName(r.agent_id),
		title: clip(r.title || r.task, 120),
		status: r.status,
		currentStep: steps[0]?.tool || null,
		progress: isLiveSubagent(r.status) ? clip(said?.content, 200) || null : null,
		result: isLiveSubagent(r.status) ? null : clip(r.result_summary || r.error_reason, 600) || null,
		detail: `要看完整过程，用 subagent_list 带上 subagent_id:"${r.id}" 查`,
	};
}
/** 同一个群里别的成员派的帮手（成员看群里的帮手用）。 */
export function roomHelpers(roomId: string, exceptAgentId: string): Subagent[] {
	return db.prepare("SELECT * FROM subagents WHERE agent_id != ? AND (conversation_id IN (SELECT conversation_id FROM room_members WHERE room_id = ?) OR conversation_id IN (SELECT conversation_id FROM work_exec_conversations WHERE room_id = ?)) ORDER BY created_at DESC LIMIT 30").all(exceptAgentId, roomId, roomId) as unknown as Subagent[];
}
/** 别的成员查看一个帮手：列表里只给概况；点名查（full）给完整记录和工具步骤。不在同一个群返回 null。 */
export function peerHelperView(viewerAgentId: string, conversationId: string | null | undefined, r: Subagent | undefined, full = false) {
	const roomId = helperRoomOf(conversationId);
	if (!r || !roomId || r.agent_id === viewerAgentId || helperRoomOf(r.conversation_id) !== roomId) return null;
	return full ? { ...r, steps: helperSteps(r.id) } : helperSummary(r);
}

/** 下一层帮手（只有一层）。 */
export const childHelpers = (parentId: string) => db.prepare("SELECT * FROM subagents WHERE parent_subagent_id = ? ORDER BY created_at, rowid").all(parentId) as unknown as Subagent[];
/** 上一层结束（完成 / 失败 / 停止）时，还在跑的下一层一并停掉：没人收它的结果了。 */
bus.on((e) => {
	const r = (e as { type: string; subagent?: Subagent }).type === "subagent.updated" ? (e as { subagent?: Subagent }).subagent : undefined;
	if (!r || isLiveSubagent(r.status)) return;
	for (const c of childHelpers(r.id)) if (isLiveSubagent(c.status)) void stopSubagent(c.id).catch(() => {});
});

const LABEL: Record<string, string> = { done: "完成", failed: "失败", stopped: "已停止", timeout: "超时", lost: "中断待核验" };
/**
 * 上一层帮手说完之后：等它派的下一层帮手全部结束，把还没交给它的结果整理成一条消息（由它核对整合）。
 * 没有新的下一层帮手返回 null。alive() 变假（上一层被停）就不再等。
 */
export async function awaitChildResults(parentId: string, seen: Set<string>, alive: () => boolean): Promise<string | null> {
	const fresh = () => childHelpers(parentId).filter((c) => !seen.has(c.id));
	if (!fresh().length) return null;
	while (alive() && fresh().some((c) => isLiveSubagent(c.status))) await new Promise((res) => setTimeout(res, 300));
	const done = fresh().filter((c) => !isLiveSubagent(c.status));
	if (!done.length) return null;
	for (const c of done) seen.add(c.id);
	return [
		"（系统通知：你派的下一层帮手都结束了）",
		...done.map((c) => `- ${clip(c.title || c.task, 60)}（${c.id}）${LABEL[c.status] ?? c.status}：${clip(c.status === "done" ? c.result_summary : c.error_reason, 1500) || "没有结果"}`),
		"核对这些结果，整合进你的结果摘要；失败的部分自己补上或换做法，超出范围的写明交回。",
	].join("\n");
}
