/**
 * 单聊里的项目（docs/design/group-team.md §13）：单聊助理遇到多步骤的大事时，和群聊一样先出方案、用户确认、推进、交付。
 *  - 表 chat_projects：字段和 room_projects 对齐，用 conversation_id（+ agent_id）代替 room_id。
 *    没有扩展 room_projects：它的 room_id 是 NOT NULL，SQLite 改列要重建表，老库升级有风险；单聊也没有任务清单、卡住计数、关键点这些列，分开更干净。
 *  - 状态：proposed（方案卡等用户确认）→ active → done / stopped；proposed 也可以 dismissed；
 *    进行中改方案写进 draft，用户确认后覆盖 plan。
 *  - 方案卡复用群聊的 meta.kind = "room-plan"（带 conversationId），交付卡沿用 "project-delivery"，界面同一套组件。
 * 方案的规范化 / 渲染在 rooms/plan.ts，进度在 progress.ts，规则文字在 rules.ts，工具在 tools.ts。
 */
import { db, now, uid } from "../db.ts";
import type { fileInfo } from "../files.ts";
import { getMessage, insertMessage, updateMessage } from "../messages.ts";
import { clipTitle, normalizePlan, ProjectError, type ProjectPlan } from "../rooms/plan.ts";
import type { ProjectProgress } from "../rooms/progress.ts";
import type { ProjectStatus } from "../rooms/projects.ts";
import { chatProgress, stageNotice } from "./progress.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS chat_projects (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  plan TEXT NOT NULL, draft TEXT, card_message_id TEXT, summary TEXT, stages_done TEXT,
  created_at INTEGER NOT NULL, confirmed_at INTEGER, ended_at INTEGER, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chat_projects_conv ON chat_projects(conversation_id, status);
`);

export interface ChatProjectRow {
	id: string;
	conversation_id: string;
	agent_id: string;
	title: string;
	status: ProjectStatus;
	plan: string;
	draft: string | null;
	card_message_id: string | null;
	summary: string | null;
	stages_done: string | null;
	created_at: number;
	confirmed_at: number | null;
	ended_at: number | null;
	updated_at: number;
}
/** 给界面的形状：和群聊的 ProjectJson 一致（roomId 换成 conversationId），界面的方案正文 / 进度清单直接复用。 */
export interface ChatProjectJson {
	id: string;
	conversationId: string;
	title: string;
	status: ProjectStatus;
	plan: ProjectPlan;
	draft: ProjectPlan | null;
	cardMessageId: string | null;
	summary: string | null;
	createdAt: number;
	confirmedAt: number | null;
	endedAt: number | null;
	progress: ProjectProgress;
}

const parsePlan = (s: string | null) => {
	if (!s) return null;
	try {
		return normalizePlan(JSON.parse(s));
	} catch {
		return normalizePlan({});
	}
};
const parseNames = (s: string | null): string[] => {
	try {
		const v = JSON.parse(s ?? "[]");
		return Array.isArray(v) ? v.map(String) : [];
	} catch {
		return [];
	}
};
export const getChatProject = (id: string) => db.prepare("SELECT * FROM chat_projects WHERE id = ?").get(id) as ChatProjectRow | undefined;
/** 默认只给 proposed / active（按创建时间升序）；all = 全部（含已结束，按创建时间降序）。 */
export const chatProjectsOf = (conversationId: string, all = false) =>
	db.prepare(all ? "SELECT * FROM chat_projects WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC" : "SELECT * FROM chat_projects WHERE conversation_id = ? AND status IN ('proposed','active') ORDER BY created_at, rowid").all(conversationId) as unknown as ChatProjectRow[];
/** planText 要的形状 */
export const chatProjectView = (r: ChatProjectRow) => ({ id: r.id, title: r.title, plan: parsePlan(r.plan)! });
export const chatProjectProgress = (r: ChatProjectRow) => chatProgress(parsePlan(r.plan)!, parseNames(r.stages_done));

export function chatProjectJson(r: ChatProjectRow): ChatProjectJson {
	return {
		id: r.id, conversationId: r.conversation_id, title: r.title, status: r.status, plan: parsePlan(r.plan)!, draft: parsePlan(r.draft), cardMessageId: r.card_message_id, summary: r.summary,
		createdAt: r.created_at, confirmedAt: r.confirmed_at, endedAt: r.ended_at, progress: chatProjectProgress(r),
	};
}

function requireProject(conversationId: string, projectId: string) {
	const p = getChatProject(projectId);
	if (!p || p.conversation_id !== conversationId) throw new ProjectError("not_found", 404);
	return p;
}
/** 当前方案卡还在等用户时改成 status（确认 / 先不做 / 被新方案取代）。 */
function settleCard(p: ChatProjectRow, status: "confirmed" | "dismissed" | "superseded") {
	const m = p.card_message_id ? getMessage(p.card_message_id) : undefined;
	if (m?.meta.status === "pending") updateMessage(m.id, { meta: { status } });
}
/** 方案卡还在等用户，而且卡片发出之后这个对话里有用户本人的消息（chat_project_start 的防护：不能替用户确认）。 */
export function userRepliedToCard(p: ChatProjectRow) {
	const m = p.card_message_id ? getMessage(p.card_message_id) : undefined;
	if (m?.meta.status !== "pending") return false;
	return !!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND role = 'user' AND rowid > (SELECT rowid FROM messages WHERE id = ?) LIMIT 1").get(p.conversation_id, m.id);
}
const notice = (p: ChatProjectRow, text: string, event: string) => insertMessage({ agentId: p.agent_id, conversationId: p.conversation_id, role: "system", content: text, meta: { kind: "chat-project", projectId: p.id, event } });

/**
 * 助理出方案卡（chat_plan）：不带 projectId 新建 proposed 项目；带 projectId 且还在 proposed 是改方案（重新发卡）；
 * 项目进行中则写进 draft，发「改过的方案」卡请用户重新确认。新卡发出时，之前还在等用户的卡改成 superseded。
 * plan 由调用方先用 rooms/plan.ts 的 checkPlan（solo）校验过。
 */
export function proposeChatPlan(o: { agentId: string; conversationId: string; title: string; plan: ProjectPlan; projectId?: string }) {
	const t = now();
	let id = o.projectId ?? "";
	let revision = false;
	if (id) {
		const p = requireProject(o.conversationId, id);
		if (p.status === "proposed") db.prepare("UPDATE chat_projects SET title = ?, plan = ?, updated_at = ? WHERE id = ?").run(clipTitle(o.title, o.plan.goal) || p.title, JSON.stringify(o.plan), t, id);
		else if (p.status === "active") {
			db.prepare("UPDATE chat_projects SET draft = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(o.plan), t, id);
			revision = true;
		} else throw new ProjectError(`项目「${p.title}」已经结束了，不能再改方案；要做新的事，不带 projectId 重新出方案。`);
		settleCard(p, "superseded");
	} else {
		id = uid("cp");
		db.prepare("INSERT INTO chat_projects(id, conversation_id, agent_id, title, status, plan, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, o.conversationId, o.agentId, clipTitle(o.title, o.plan.goal) || "新项目", "proposed", JSON.stringify(o.plan), t, t);
	}
	const p = getChatProject(id)!;
	const card = insertMessage({ agentId: o.agentId, conversationId: o.conversationId, role: "card", meta: { kind: "room-plan", conversationId: o.conversationId, projectId: id, title: p.title, plan: o.plan, revision, status: "pending" } });
	db.prepare("UPDATE chat_projects SET card_message_id = ? WHERE id = ?").run(card.id, id);
	return { project: getChatProject(id)!, revision };
}

/** 确认方案（用户点「就这么干」，或用户说可以后助理用 chat_project_start）：proposed → active；进行中且有 draft → draft 覆盖 plan。 */
export function confirmChatProject(conversationId: string, projectId: string) {
	const p = requireProject(conversationId, projectId);
	const t = now();
	let revised = false;
	if (p.status === "proposed") {
		db.prepare("UPDATE chat_projects SET status = 'active', confirmed_at = ?, updated_at = ? WHERE id = ?").run(t, t, p.id);
		settleCard(p, "confirmed");
		notice(p, `方案已确认，项目「${p.title}」开始了。`, "started");
	} else if (p.status === "active" && p.draft) {
		db.prepare("UPDATE chat_projects SET plan = draft, draft = NULL, updated_at = ? WHERE id = ?").run(t, p.id);
		settleCard(p, "confirmed");
		notice(p, `改过的方案已确认，项目「${p.title}」按新方案继续。`, "revised");
		revised = true;
	} else throw new ProjectError("这份方案已经处理过了");
	return { project: getChatProject(p.id)!, revised };
}

/** 用户点「先不做」：proposed → dismissed；进行中有 draft → 丢掉 draft，按原方案继续。 */
export function dismissChatProject(conversationId: string, projectId: string) {
	const p = requireProject(conversationId, projectId);
	const t = now();
	if (p.status === "proposed") {
		db.prepare("UPDATE chat_projects SET status = 'dismissed', ended_at = ?, updated_at = ? WHERE id = ?").run(t, t, p.id);
		settleCard(p, "dismissed");
		notice(p, "这份方案先不做了。", "dismissed");
	} else if (p.status === "active" && p.draft) {
		db.prepare("UPDATE chat_projects SET draft = NULL, updated_at = ? WHERE id = ?").run(t, p.id);
		settleCard(p, "dismissed");
		notice(p, `改过的方案先不用，项目「${p.title}」按原方案继续。`, "dismissed");
	} else throw new ProjectError("这份方案已经处理过了");
	return getChatProject(p.id)!;
}

/** 用户在项目面板停下项目：active → stopped（进度保留）。调用方负责让助理停下手上的活。 */
export function stopChatProject(conversationId: string, projectId: string) {
	const p = requireProject(conversationId, projectId);
	if (p.status !== "active") throw new ProjectError(p.status === "proposed" ? "这个项目还没开始，不用停；不想做就在方案卡上点「先不做」" : "这个项目已经结束了");
	const t = now();
	db.prepare("UPDATE chat_projects SET status = 'stopped', draft = NULL, summary = ?, ended_at = ?, updated_at = ? WHERE id = ?").run("用户停下了这个项目，进度保留", t, t, p.id);
	settleCard(p, "superseded");
	notice(p, `项目「${p.title}」已停下，进度保留。`, "stopped");
	return getChatProject(p.id)!;
}

/** 助理标一个阶段完成（chat_stage_done）：每个阶段只记一次；聊天里发一条简短进度。 */
export function markStageDone(conversationId: string, projectId: string, stageIndex: number, note: string) {
	const p = requireProject(conversationId, projectId);
	if (p.status !== "active") throw new ProjectError(p.status === "proposed" ? "这个项目还没开始（方案还在等用户确认）" : "这个项目已经结束了");
	const plan = parsePlan(p.plan)!;
	const stage = plan.stages[stageIndex];
	if (!stage) throw new ProjectError("没有这个阶段");
	const done = parseNames(p.stages_done);
	if (done.includes(stage.name)) return { project: p, already: true, progress: chatProjectProgress(p) };
	db.prepare("UPDATE chat_projects SET stages_done = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...done, stage.name]), now(), p.id);
	const fresh = getChatProject(p.id)!;
	const progress = chatProjectProgress(fresh);
	notice(fresh, stageNotice(p.title, `阶段「${stage.name}」`, progress.done, progress.total, note.trim().slice(0, 200)), "stage");
	return { project: fresh, already: false, progress };
}

/** 助理交付后结束项目（chat_project_done）：active → done，聊天里发一张交付卡（沿用群聊的 project-delivery 形状）。不汇报花费。 */
export function finishChatProject(conversationId: string, projectId: string, summary: string, delivery: { files: ReturnType<typeof fileInfo>[]; howToUse: string; notDone: string }) {
	const p = requireProject(conversationId, projectId);
	if (p.status !== "active") throw new ProjectError(p.status === "proposed" ? "这个项目还没开始（方案还在等用户确认）" : "这个项目已经结束了");
	const t = now();
	db.prepare("UPDATE chat_projects SET status = 'done', draft = NULL, summary = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(summary, t, t, p.id);
	settleCard(p, "superseded");
	notice(p, `项目「${p.title}」已完成，成果见下面的交付卡。`, "done");
	insertMessage({ agentId: p.agent_id, conversationId: p.conversation_id, role: "card", meta: { kind: "project-delivery", projectId: p.id, title: p.title, summary, files: delivery.files, howToUse: delivery.howToUse, notDone: delivery.notDone } });
	return getChatProject(p.id)!;
}
