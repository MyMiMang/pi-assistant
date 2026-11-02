/**
 * 主动巡检里的「群」（只读 db，不 import rooms/ 和 proactive.ts，避免循环）：
 *  - 助理在的群、群里有没有用户消息 / 未完成的事（算巡检对象：群成员没有单聊也要巡检）；
 *  - 巡检「现在的情况」里「你在的群」一段：每个群只给少量最近内容，超了截断（token 有界）；
 *  - 群里的回合怎么叫醒由 rooms/followup.ts 注册（setRoomHandler）：跟进到点和主动推进共用。
 */
import { db } from "./db.ts";

export interface RoomHandler {
	/** 这个会话是不是该助理在某个群里的会话（群里约的跟进） */
	inRoom(agentId: string, conversationId: string | null): boolean;
	/** 群里约的跟进到点：fired 已叫醒发言 / stopped 群已停止只留说明 / null 不是群里的 */
	fire(agentId: string, fu: { note: string; conversation_id: string | null }): "fired" | "stopped" | null;
	/** 主动推进：在群里叫醒该成员发言；null = 不是这个群的在职成员 */
	advance(agentId: string, roomId: string, i: { title: string; body: string }): "fired" | "stopped" | null;
	isMember(agentId: string, roomId: string): boolean;
}
let handler: RoomHandler | null = null;
export const setRoomHandler = (h: RoomHandler | null) => (handler = h);
export const roomHandler = () => handler;

const clip = (s: string | null | undefined, n: number) => {
	const v = (s ?? "").replace(/\s+/g, " ").trim();
	return v.length > n ? `${v.slice(0, n)}…` : v;
};
/** 一个群给多少字、最多几个群、每个群几条用户消息 / 几件事 */
export const ROOM_LIMITS = { rooms: 4, userMsgs: 4, items: 5, perRoomChars: 1400, totalChars: 4500, msgChars: 140 };
const DAY = 86400_000;
/** 群 / 任务表由别的模块建（巡检不为它们引入依赖）：读不到就当作没有，不让巡检因此失败 */
const safe = <T>(f: () => T, fallback: T): T => {
	try {
		return f();
	} catch {
		return fallback;
	}
};

interface RoomLite {
	id: string;
	name: string;
	manager_id: string | null;
	conversation_id: string | null;
}
/** 助理在职的群（按最近有动静排序） */
export function agentRooms(agentId: string): RoomLite[] {
	return db
		.prepare("SELECT r.id, r.name, r.manager_id, m.conversation_id FROM room_members m JOIN rooms r ON r.id = m.room_id WHERE m.agent_id = ? AND m.left_at IS NULL AND m.deleted = 0 ORDER BY r.updated_at DESC")
		.all(agentId) as unknown as RoomLite[];
}
const OPEN_WORK = "('pending','active','blocked','review','paused')";

/** 助理在的群里，最近 since 之后有没有用户说过话（让群成员也算「用过」） */
export const roomUserSince = (agentId: string, since: number) =>
	safe(() => !!db.prepare("SELECT 1 FROM messages x JOIN room_members m ON m.room_id = x.room_id WHERE m.agent_id = ? AND m.left_at IS NULL AND m.deleted = 0 AND x.role = 'user' AND x.created_at >= ? LIMIT 1").get(agentId, since), false);
/** 助理在的群里有没有它负责的、没完成的事（算未闭环） */
export const roomOpenWork = (agentId: string) =>
	safe(() => !!db.prepare(`SELECT 1 FROM work_items w JOIN room_members m ON m.room_id = w.room_id WHERE m.agent_id = ? AND m.left_at IS NULL AND m.deleted = 0 AND w.owner_agent_id = ? AND w.status IN ${OPEN_WORK} LIMIT 1`).get(agentId, agentId), false);

/**
 * 「你在的群」一段（每个群：用户最近说的话、进行中的项目 / 任务（卡住的、等你的、久没进展的）、群里约的跟进）。
 * 没有值得看的内容的群不列；每个群和总量都按字数截断。
 */
export const roomSituationLines = (agentId: string, t: number, fmt: (t: number) => string): string[] => safe(() => buildRoomLines(agentId, t, fmt), []);
function buildRoomLines(agentId: string, t: number, fmt: (t: number) => string): string[] {
	const L = ROOM_LIMITS;
	const out: string[] = [];
	let total = 0;
	for (const r of agentRooms(agentId).slice(0, L.rooms * 2)) {
		if (out.length >= L.rooms || total >= L.totalChars) break;
		const lines: string[] = [];
		const said = (db.prepare("SELECT content, created_at FROM messages WHERE room_id = ? AND role = 'user' AND created_at >= ? ORDER BY rowid DESC LIMIT ?").all(r.id, t - 3 * DAY, L.userMsgs) as { content: string; created_at: number }[]).reverse();
		for (const m of said) lines.push(`  - 用户 ${fmt(m.created_at)}：${clip(m.content, L.msgChars)}`);
		for (const p of db.prepare("SELECT title FROM room_projects WHERE room_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 2").all(r.id) as { title: string }[]) lines.push(`  - 进行中的项目：${clip(p.title, 60)}`);
		const works = db
			.prepare(`SELECT id, title, status, owner_agent_id, blocker, needs_user, COALESCE(last_progress_at, updated_at) AS prog FROM work_items WHERE room_id = ? AND status IN ${OPEN_WORK} ORDER BY updated_at DESC LIMIT ?`)
			.all(r.id, L.items) as { id: string; title: string; status: string; owner_agent_id: string | null; blocker: string | null; needs_user: string | null; prog: number }[];
		for (const w of works) {
			const tags: string[] = [];
			if (w.status === "blocked" || w.blocker) tags.push(`卡住${w.blocker ? `：${clip(w.blocker, 60)}` : ""}`);
			if (w.needs_user) tags.push("等用户决定");
			if (w.status === "review") tags.push("待核验");
			if (w.status === "active" && t - w.prog > 6 * 3600_000) tags.push(`${Math.round((t - w.prog) / 3600_000)} 小时没有进展`);
			if (w.status === "pending" && w.owner_agent_id === agentId) tags.push("等你开始");
			if (w.owner_agent_id === agentId) tags.push("你负责");
			lines.push(`  - 任务 ${clip(w.title, 60)} · ${w.status}${tags.length ? `（${tags.join("，")}）` : ""}`);
		}
		if (r.conversation_id)
			for (const f of db.prepare("SELECT due_at, note FROM proactive_followups WHERE agent_id = ? AND conversation_id = ? AND status = 'pending' ORDER BY due_at LIMIT 3").all(agentId, r.conversation_id) as { due_at: number; note: string }[])
				lines.push(`  - 你在这个群约的跟进 ${fmt(f.due_at)}：${clip(f.note, 80)}`);
		if (!lines.length) continue;
		let body = `- [room:${r.id}] 群「${clip(r.name, 30)}」${r.manager_id === agentId ? "（你是管理者）" : ""}\n${lines.join("\n")}`;
		const room = Math.min(L.perRoomChars, L.totalChars - total);
		if (body.length > room) body = `${body.slice(0, room)}…`;
		total += body.length;
		out.push(body);
	}
	return out;
}
