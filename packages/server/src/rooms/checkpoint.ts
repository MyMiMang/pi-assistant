/**
 * 关键点确认（docs/design/group-team.md §6，决策 0019 第 5 步）：方案里写的关键点到了，管理者用 room_checkpoint 请用户看一眼。
 * 复用提问卡机制（requests.question，卡片出在管理者的群会话里）；项目表的 waiting 记着「在等用户看哪个关键点」。
 * 用户答了 → 清掉 waiting，把答复以用户身份发到群里（正常路由，叫醒管理者按答复继续）；
 * 项目结束 / 停下 → 清掉 waiting 并收掉卡片。waiting 对应的卡片已不在等待（过期、重启）就当没有。
 * 本文件不 import projects.ts（projects.ts 要用这里的 dropWaiting / waitingOf），项目行直接按表读。
 */
import { db, now } from "../db.ts";
import { requests } from "../requests.ts";
import { MISSING_HINT, postFiles, resolveFiles } from "./deliver.ts";
import { postUserMessage } from "./scheduler.ts";
import { changed, memberConversation } from "./store.ts";

export interface Waiting {
	checkpoint: string;
	message: string;
	options: string[];
	requestId: string;
	at: number;
}
const DEFAULT_OPTIONS = ["可以，继续", "要改"];
const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

const requestPending = (id: string) => (db.prepare("SELECT status FROM requests WHERE id = ?").get(id) as { status: string } | undefined)?.status === "pending";
/** 解析项目行的 waiting：卡片已经不在等待（过期 / 重启）就当没有。 */
export function waitingOf(raw: string | null): Waiting | null {
	if (!raw) return null;
	try {
		const w = JSON.parse(raw) as Waiting;
		return w?.requestId && requestPending(w.requestId) ? w : null;
	} catch {
		return null;
	}
}
const rawWaiting = (projectId: string) => (db.prepare("SELECT waiting FROM room_projects WHERE id = ?").get(projectId) as { waiting: string | null } | undefined)?.waiting ?? null;

/** 这个群里等用户看的关键点卡片（停群时保留，和「等你决定」一样；停群只停发言，不撤回要用户看的东西）。 */
export function waitingRequestIds(roomId: string): string[] {
	return (db.prepare("SELECT waiting FROM room_projects WHERE room_id = ? AND waiting IS NOT NULL").all(roomId) as { waiting: string }[]).map((r) => waitingOf(r.waiting)?.requestId).filter((x): x is string => !!x);
}

/** 项目结束 / 停下：清掉 waiting，把还在等的卡片收掉（系统收尾，不算用户的答复）。 */
export function dropWaiting(projectId: string) {
	const raw = rawWaiting(projectId);
	if (!raw) return;
	const w = waitingOf(raw);
	db.prepare("UPDATE room_projects SET waiting = NULL WHERE id = ?").run(projectId);
	if (w) requests.resolve(w.requestId, { answer: "（项目已结束）" }, "system");
}

/** 用户在卡片上答了：清掉 waiting，答复发到群里（以用户身份，叫醒管理者按答复继续）。 */
function answered(projectId: string, requestId: string, answer: string) {
	const p = db.prepare("SELECT room_id FROM room_projects WHERE id = ?").get(projectId) as { room_id: string } | undefined;
	let w: Waiting | null = null;
	try {
		w = JSON.parse(rawWaiting(projectId) ?? "null") as Waiting | null;
	} catch {
		/* 坏数据按没有算 */
	}
	if (!p || !w || w.requestId !== requestId) return;
	db.prepare("UPDATE room_projects SET waiting = NULL, updated_at = ? WHERE id = ?").run(now(), projectId);
	changed(p.room_id);
	try {
		postUserMessage(p.room_id, `关于关键点「${w.checkpoint}」：${answer}`, { from: { kind: "user" } });
	} catch {
		/* 群已删：忽略 */
	}
}

type R = { ok: true; text: string } | { ok: false; error: string };
export function askCheckpoint(o: { roomId: string; managerId: string; projectId: string; checkpoint: string; message: string; options?: string[]; files?: string[] }): R {
	const p = db.prepare("SELECT id, room_id, title, status, waiting FROM room_projects WHERE id = ?").get(o.projectId) as { id: string; room_id: string; title: string; status: string; waiting: string | null } | undefined;
	if (!p || p.room_id !== o.roomId) return { ok: false, error: "项目不存在。" };
	if (p.status !== "active") return { ok: false, error: "这个项目不在进行中，不用请用户确认关键点。" };
	const checkpoint = clip(o.checkpoint, 200);
	const message = clip(o.message, 1000);
	if (!checkpoint || !message) return { ok: false, error: "写清是哪个关键点（checkpoint）、请用户看什么以及为什么现在看（message）。" };
	const cur = waitingOf(p.waiting);
	if (cur) return { ok: false, error: `项目「${p.title}」已经有一个关键点「${cur.checkpoint}」在等用户看了，等用户答复后再请下一个。` };
	const { files, missing } = resolveFiles(o.roomId, o.managerId, o.files);
	if (missing.length) return { ok: false, error: MISSING_HINT(missing) };
	const conv = memberConversation(o.roomId, o.managerId);
	const options = (o.options ?? []).map((x) => clip(x, 80)).filter(Boolean).slice(0, 4);
	const choices = options.length >= 2 ? options : DEFAULT_OPTIONS;
	postFiles(o.roomId, o.managerId, files, `关键点「${checkpoint}」要你看的文件`, { projectId: p.id });
	const question = `关键点：${checkpoint}\n${message}`;
	const pending = requests.question(o.managerId, null, question, choices, true, conv, { projectId: p.id, checkpoint });
	const requestId = requests.pendingQuestionId(conv, question);
	if (!requestId) return { ok: false, error: "没能给用户发出确认卡片，稍后再试。" };
	const waiting: Waiting = { checkpoint, message, options: choices, requestId, at: now() };
	db.prepare("UPDATE room_projects SET waiting = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(waiting), now(), p.id);
	changed(o.roomId);
	void pending
		.then((ans) => {
			// 只认用户真的回答了（停群 / 项目结束 / 过期等系统收尾不算答复）
			const row = db.prepare("SELECT status, resolved_by FROM requests WHERE id = ?").get(requestId) as { status: string; resolved_by: string | null } | undefined;
			if (row?.status === "answered" && row.resolved_by !== "system" && ans.answer) answered(p.id, requestId, ans.answer);
		})
		.catch(() => {});
	return { ok: true, text: "已请用户看。不受这个关键点影响的任务照常推进；受影响的等用户答复后再做。" };
}
