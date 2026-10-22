/** 从 http.ts 拆出的路由（行为不变）。 */
import { deleteAgentSubagentLimits } from "../subagents.ts";
import { isStopCommand } from "../interject.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { db, now } from "../db.ts";
import { attachmentInputFor, fileInfo, getFile, insideWorkspace, listFiles, listWorkspace, mimeOf, saveUpload } from "../files.ts";
import { getMessageByClientId, insertMessage, listMessages, toMessage, type MessageRow } from "../messages.ts";
import { defaultModel, defaultThinking, isThinkingLevel, models, withProviderName } from "../models.ts";
import { sessionStats } from "../pi-adapter/index.ts";
import { requests } from "../requests.ts";
import { disposeConversationRuntime, disposeRuntime, getAgent, listAgents, runtime } from "../runtime.ts";
import { desktopPause, desktopStatus, ensureOwnScreen, forgetAgentComputer, hasSeparateData, issueTicket, mergeIntoShared, releaseScreen, screenshotDesktop, setSeparateComputer, startDesktop, stopDesktop } from "../desktop.ts";
import { desktopSettings } from "../desktop/settings.ts";
import { agentBusy } from "../runtime.ts";
import { createConversation, currentConversation, deleteConversation, getConversation, listConversations, renameConversation, setCurrentConversation } from "../conversations.ts";
import { forkConversation, ForkError } from "../fork.ts";
import { globalMemoryProviderId, listMemoryProviders, memory } from "../memory/index.ts";
import { assignedSkillIds, setAssignedSkillIds } from "../skill-assignments.ts";
import { enabledSkillsFor, resolveSelectedSkills } from "../skill-scope.ts";
import { createRoutine, deleteAgentRoutines, listRoutines, rescheduleAgentRoutines, type RoutineInput } from "../routines.ts";
import { actionShot, clearActions, listActions } from "../action-log.ts";
import { cancelFollowup, proactiveJson, runHeartbeat, saveProactive } from "../proactive.ts";
import { cancelWait, listWaits, refreshWait } from "../task-waits.ts";
import { hostAgentsChanged } from "../host-control.ts";
import { onAgentChanged, onAgentDeleted } from "../rooms/index.ts";
import { copyAgentToUser } from "../rooms/copy.ts";
import { getMessage } from "../messages.ts";
import { buildReplySnapshot, formatQuotedContext, ReplyError, resolveReplyTarget } from "../replies.ts";
import { by, localOnly, roomErr, sendFile, type Env } from "./common.ts";
import { deskChanged } from "./desktop.ts";
import { syncSidecarWanted } from "./memory.ts";
import { routineJson } from "./routines.ts";

// ---------------------------------------------------------------- 助理与聊天
export const agentJson = (a: NonNullable<ReturnType<typeof getAgent>>) => {
	const last = db.prepare("SELECT content, role, created_at FROM messages WHERE agent_id = ? AND task_id IS NULL AND subagent_id IS NULL AND room_id IS NULL AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 1").get(a.id);
	return { ...a, session_file: undefined, model: runtime(a.id).modelFor(a), thinking: runtime(a.id).thinkingFor(a), thinkingSetting: a.thinking, fast: a.fast === 1, workspace: join(config.workspaceRoot, a.id), last, conversation_id: currentConversation(a.id) };
};

type AgentInput = { name?: string; avatar?: string; color?: string; persona?: string; description?: string; model?: { provider: string; id: string } | null; thinking?: string | null; /** 请求级 Fast：只动 agents.fast，不碰 thinking / 模型 */ fast?: boolean | null };

const cleanAvatar = (v: string | undefined, name: string) => {
	const t = (v ?? "").trim();
	if (t.startsWith("img:")) return t; // 上传的图片（img:<版本>）
	return [...(t || name.trim() || "A")].slice(0, 2).join(""); // emoji 或 1–2 个字
};

export async function deleteAgentFully(id: string) {
	const a = getAgent(id);
	if (!a) return false;
	await disposeRuntime(a.id);
	await forgetAgentComputer(a.id).catch(() => {});
	deleteAgentRoutines(a.id);
	deleteAgentSubagentLimits(a.id);
	await memory.purgeAgent(a.id);
	onAgentDeleted(a.id);
	// 群里的消息保留（标“已删除”），其余一并删除
	db.prepare("DELETE FROM messages WHERE agent_id = ? AND room_id IS NULL").run(a.id);
	for (const t of ["tasks", "requests", "files", "conversations"]) db.prepare(`DELETE FROM ${t} WHERE agent_id = ?`).run(a.id);
	if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_projects'").get()) db.prepare("DELETE FROM chat_projects WHERE agent_id = ?").run(a.id);
	db.prepare("DELETE FROM agents WHERE id = ?").run(a.id);
	void hostAgentsChanged();
	// 工作区与会话移到回收站（不直接删除，误删可找回）
	const trash = join(config.dataDir, "trash", `${a.id}-${Date.now()}`);
	mkdirSync(trash, { recursive: true });
	for (const [src, dst] of [[join(config.workspaceRoot, a.id), "workspace"], [join(config.agentsDir, a.id), "agent"]] as const) if (existsSync(src)) renameSync(src, join(trash, dst));
	rmSync(join(config.dataDir, "avatars", a.id), { force: true, recursive: true });
	bus.emit({ type: "agents.changed" });
	return true;
}

// ---------------------------------------------------------------- 助理电脑（sandbox desktop）
const deskJson = async (id: string) => ({ ...(await desktopStatus(id)), paused: desktopPause.isPaused(id) });

export function mountAgentRoutes(app: Hono<Env>) {
	app.get("/api/agents", (c) => c.json(listAgents().map(agentJson)));
	app.post("/api/agents", async (c) => {
		const b = await c.req.json<AgentInput>();
		const name = (b.name ?? "").trim().slice(0, 40);
		if (!name) return c.json({ error: "请给助理起个名字" }, 400);
		const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
		const model = b.model && models.getModel(b.model.provider, b.model.id) ? b.model : defaultModel();
		db.prepare("INSERT INTO agents(id, name, avatar, color, persona, description, model_provider, model_id, sort, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
			id, name, cleanAvatar(b.avatar, name), b.color || "#6366f1", (b.persona ?? "").slice(0, 8000), (b.description ?? "").slice(0, 200), model?.provider ?? null, model?.id ?? null, listAgents().length, now(),
		);
		void hostAgentsChanged();
		db.prepare("UPDATE agents SET thinking = ? WHERE id = ?").run(isThinkingLevel(b.thinking) ? b.thinking : defaultThinking(), id);
		insertMessage({ agentId: id, role: "assistant", content: `你好，我是${name} 👋\n\n我有自己的电脑，可以写代码、处理文件、上网查资料、操作网页和桌面应用，也能把耗时的活放到后台去做。想让我做点什么？` });
		bus.emit({ type: "agents.changed" });
		return c.json(agentJson(getAgent(id)!));
	});
	app.patch("/api/agents/:id", async (c) => {
		const a = getAgent(c.req.param("id"));
		if (!a) return c.json({ error: "not_found" }, 404);
		const b = await c.req.json<AgentInput>();
		if (b.model !== undefined && b.model && !models.getModel(b.model.provider, b.model.id)) return c.json({ error: "模型不存在" }, 400);
		// 先校验整份输入，再写任何字段：失败时不能已经悄悄更改模型/资料。
		if (b.thinking !== undefined && b.thinking !== null && !isThinkingLevel(b.thinking)) return c.json({ error: "思考强度不对" }, 400);
		if (b.fast !== undefined && b.fast !== null && typeof b.fast !== "boolean") return c.json({ error: "Fast 开关不对" }, 400);
		const name = b.name !== undefined ? b.name.trim().slice(0, 40) || a.name : a.name;
		// 默认头像是名字前两个字：改名时若头像仍是旧名字的默认头像，跟着新名字走，否则群成员条/列表还显示旧名
		let avatar = b.avatar !== undefined ? cleanAvatar(b.avatar, name) : a.avatar;
		if (name !== a.name && avatar === cleanAvatar("", a.name)) avatar = cleanAvatar("", name);
		db.prepare("UPDATE agents SET name = ?, avatar = ?, color = ?, persona = ?, description = ?, model_provider = ?, model_id = ? WHERE id = ?").run(
			name, avatar, b.color ?? a.color, b.persona ?? a.persona, b.description ?? a.description,
			b.model === undefined ? a.model_provider : (b.model?.provider ?? null), b.model === undefined ? a.model_id : (b.model?.id ?? null), a.id,
		);
		if (b.thinking !== undefined) db.prepare("UPDATE agents SET thinking = ? WHERE id = ?").run(b.thinking, a.id);
		// Fast 与思考强度是两个独立字段：这里只改 fast，不动 thinking / 模型选择
		if (b.fast !== undefined) db.prepare("UPDATE agents SET fast = ? WHERE id = ?").run(b.fast ? 1 : 0, a.id);
		onAgentChanged(a.id);
		bus.emit({ type: "agents.changed" });
		return c.json(agentJson(getAgent(a.id)!));
	});
	app.delete("/api/agents/:id", async (c) => ((await deleteAgentFully(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404)));
	app.post("/api/agents/:id/avatar", async (c) => {
		const a = getAgent(c.req.param("id"));
		if (!a) return c.json({ error: "not_found" }, 404);
		const f = (await c.req.parseBody()).file;
		if (!(f instanceof File)) return c.json({ error: "no_file" }, 400);
		if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) return c.json({ error: "只支持 PNG / JPG / WebP / GIF" }, 400);
		if (f.size > 2 * 1024 * 1024) return c.json({ error: "头像图片不能超过 2MB" }, 413);
		const dir = join(config.dataDir, "avatars", a.id);
		rmSync(dir, { force: true, recursive: true });
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `avatar.${f.type.split("/")[1]}`), Buffer.from(await f.arrayBuffer()));
		db.prepare("UPDATE agents SET avatar = ? WHERE id = ?").run(`img:${Date.now().toString(36)}`, a.id);
		onAgentChanged(a.id);
		bus.emit({ type: "agents.changed" });
		return c.json(agentJson(getAgent(a.id)!));
	});
	app.get("/api/agents/:id/avatar", (c) => {
		const dir = join(config.dataDir, "avatars", c.req.param("id").replace(/[^a-zA-Z0-9_-]/g, ""));
		const f = existsSync(dir) ? readdirSync(dir)[0] : undefined;
		if (!f) return c.json({ error: "not_found" }, 404);
		return c.body(readFileSync(join(dir, f)), 200, { "content-type": `image/${f.split(".").pop() === "jpeg" ? "jpeg" : f.split(".").pop()}`, "cache-control": "private, max-age=31536000, immutable" });
	});
	app.get("/api/agents/:id/messages", (c) => {
		const before = c.req.query("before");
		const beforeSeq = c.req.query("beforeSeq");
		const after = c.req.query("after");
		const afterSeq = c.req.query("afterSeq");
		return c.json(
			listMessages(c.req.param("id"), {
				conversationId: c.req.query("conversation") || undefined,
				before: before ? Number(before) : undefined,
				// 稳定游标：同一毫秒的多条消息不会被分页边界跳过 / 重复；不传时保持旧行为
				beforeSeq: beforeSeq ? Number(beforeSeq) : undefined,
				// 前向分页（历史窗口「加载较新消息」）：与 before 对称的复合游标，不传时保持旧行为
				after: after ? Number(after) : undefined,
				afterSeq: afterSeq ? Number(afterSeq) : undefined,
				limit: Number(c.req.query("limit") ?? 200),
			}),
		);
	});
	app.post("/api/agents/:id/messages", async (c) => {
		const id = c.req.param("id");
		if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
		const b = await c.req.json<{ text: string; attachments?: string[]; conversationId?: string; replyToId?: string; clientId?: string; skills?: unknown }>();
		const conv = b.conversationId && getConversation(b.conversationId)?.agent_id === id ? b.conversationId : currentConversation(id);
		// 幂等：同 clientId 重复投递直接返回已存在的那条，不再唤醒（也不再校验技能，重试幂等优先）
		if (b.clientId) {
			const dup = getMessageByClientId({ conversationId: conv, clientId: b.clientId });
			if (dup) return c.json(dup);
		}
		// 本次选用技能：只接受 canonical id，服务端按该助理分配表重新校验（fail closed，不自动启用、不接受路径 / 正文）
		let selectedSkills: NonNullable<ReturnType<typeof resolveSelectedSkills>> = [];
		if (b.skills !== undefined) {
			if (!Array.isArray(b.skills) || !b.skills.every((x) => typeof x === "string" && x.length > 0 && x.length <= 200)) return c.json({ error: "invalid_skills" }, 400);
			// 第一版一次只选一个：Pi 原生 `/skill:` 只展开开头一个命令
			if (b.skills.length > 1) return c.json({ error: "本次只能选一个技能", code: "too_many_skills" }, 400);
			const resolved = resolveSelectedSkills(id, b.skills as string[]);
			if (!resolved) return c.json({ error: "技能未启用或不存在", code: "skill_not_enabled" }, 400);
			selectedSkills = resolved;
		}
		// 引用：服务端解析，失败 fail closed（不落库、不唤醒）
		let snapshot = null;
		if (b.replyToId) {
			try {
				const target = resolveReplyTarget({ scope: { kind: "conversation", id: conv }, messageId: b.replyToId });
				snapshot = buildReplySnapshot(target, { kind: "conversation", id: conv });
			} catch (e) {
				if (e instanceof ReplyError) return c.json({ error: e.message, code: e.code }, e.status as 400 | 403 | 404);
				throw e;
			}
		}
		const files = (b.attachments ?? []).map(getFile).filter((f) => f && f.agent_id === id) as NonNullable<ReturnType<typeof getFile>>[];
		const text = (b.text ?? "").slice(0, 100_000);
		if (!text.trim() && !files.length) return c.json({ error: "empty" }, 400);
		const msg = insertMessage({ agentId: id, conversationId: conv, role: "user", content: text, replyToId: b.replyToId ?? null, replySnapshot: snapshot, clientId: b.clientId ?? null, meta: { attachments: files.map(fileInfo), from: by(c), ...(b.replyToId ? { replyTo: b.replyToId } : {}) } });
		// 正在工作时：停止词立即停；其他消息插进正在进行的任务（delivery: queued → delivered）
		const r = runtime(id, conv);
		const busy = r.busy;
		void r.send(text, files.map((f) => attachmentInputFor(id, f)), { messageId: msg.id, quote: snapshot ? formatQuotedContext(snapshot) : undefined, skills: selectedSkills.length ? selectedSkills : undefined });
		return c.json(busy ? { ...msg, meta: { ...msg.meta, delivery: isStopCommand(text) && !files.length ? "stop" : "queued" } } : msg);
	});
	app.post("/api/agents/:id/abort", async (c) => {
		const conv = c.req.query("conversation");
		await runtime(c.req.param("id"), conv || undefined).abort();
		return c.json({ ok: true });
	});
	/** 单条消息（引用跳转用）；带 roomId / conversationId 时校验容器，不一致 fail closed 不泄露。 */
	app.get("/api/messages/:mid", (c) => {
		const m = getMessage(c.req.param("mid"));
		if (!m) return c.json({ error: "not_found" }, 404);
		const rid = c.req.query("roomId");
		const cid = c.req.query("conversationId");
		if (rid && m.room_id !== rid) return c.json({ error: "不在这个群里", code: "reply_cross_scope" }, 403);
		if (cid && (m.room_id || m.conversation_id !== cid)) return c.json({ error: "不在这个对话里", code: "reply_cross_scope" }, 403);
		return c.json(m);
	});
	/** 目标消息的有界上下文窗口（前后各 ≤ limit/2），用于点击引用后定位，不拉全量历史。
	 *  默认返回升序 `Message[]`（旧契约）；`?bounds=1` 时返回 `{ messages, hasOlder, hasNewer }`，
	 *  告诉客户端这个连续窗口之外是否还有更早 / 更新的消息，供「加载较新消息 / 回到最新」使用。 */
	app.get("/api/messages/:mid/context", (c) => {
		const mid = c.req.param("mid");
		const m = getMessage(mid);
		if (!m) return c.json({ error: "not_found" }, 404);
		const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 100);
		const rid = c.req.query("roomId");
		const cid = c.req.query("conversationId");
		const bounds = c.req.query("bounds") === "1";
		const half = Math.floor(limit / 2);
		if (m.room_id) {
			if (rid && m.room_id !== rid) return c.json({ error: "不在这个群里", code: "reply_cross_scope" }, 403);
			const row = db.prepare("SELECT rowid AS seq FROM messages WHERE id = ?").get(mid) as { seq: number };
			const rows = db.prepare("SELECT rowid AS seq, * FROM messages WHERE room_id = ? AND rowid >= ? AND rowid <= ? ORDER BY rowid").all(m.room_id, row.seq - half, row.seq + half) as unknown as (MessageRow & { seq: number })[];
			const msgs = rows.map((r) => ({ ...toMessage(r), seq: r.seq }));
			if (!bounds) return c.json(msgs);
			const ext = db.prepare("SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM messages WHERE room_id = ?").get(m.room_id) as { lo: number | null; hi: number | null };
			return c.json({ messages: msgs, hasOlder: msgs.length > 0 && msgs[0].seq > (ext.lo ?? 0), hasNewer: msgs.length > 0 && msgs[msgs.length - 1].seq < (ext.hi ?? 0) });
		}
		if (m.subagent_id || m.task_id || !m.conversation_id) return c.json({ error: "not_found" }, 404);
		if (cid && m.conversation_id !== cid) return c.json({ error: "不在这个对话里", code: "reply_cross_scope" }, 403);
		const row = db.prepare("SELECT rowid AS seq FROM messages WHERE id = ?").get(mid) as { seq: number };
		const rows = db.prepare("SELECT rowid AS seq, * FROM messages WHERE conversation_id = ? AND task_id IS NULL AND subagent_id IS NULL AND rowid >= ? AND rowid <= ? ORDER BY rowid").all(m.conversation_id, row.seq - half, row.seq + half) as unknown as (MessageRow & { seq: number })[];
		const msgs = rows.map((r) => ({ ...toMessage(r), seq: r.seq }));
		if (!bounds) return c.json(msgs);
		// 边界与窗口同一过滤条件：否则子代理 / 任务消息会把 hasNewer 永远顶成 true（点「加载较新消息」返回空）。
		const ext = db.prepare("SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM messages WHERE conversation_id = ? AND task_id IS NULL AND subagent_id IS NULL").get(m.conversation_id) as { lo: number | null; hi: number | null };
		return c.json({ messages: msgs, hasOlder: msgs.length > 0 && msgs[0].seq > (ext.lo ?? 0), hasNewer: msgs.length > 0 && msgs[msgs.length - 1].seq < (ext.hi ?? 0) });
	});
	/** 群专属助理 →「复制到我的助理」 */
	app.post("/api/agents/:id/copy", async (c) => {
		const b = await c.req.json<{ name?: string; memory?: boolean }>().catch(() => ({}) as { name?: string; memory?: boolean });
		try {
			const r = await copyAgentToUser(c.req.param("id"), b);
			return c.json({ ...agentJson(getAgent(r.id)!), copiedMemories: r.memories });
		} catch (e) {
			return roomErr(c, e);
		}
	});
	// ---------------------------------------------------------------- 对话
	app.get("/api/agents/:id/conversations", (c) => {
		const id = c.req.param("id");
		if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
		return c.json({ current: currentConversation(id), items: listConversations(id).map((x) => ({ ...x, session_file: undefined })) });
	});
	app.post("/api/agents/:id/conversations", async (c) => {
		const id = c.req.param("id");
		if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
		const b = await c.req.json<{ title?: string }>().catch(() => ({}) as { title?: string });
		return c.json(createConversation(id, (b.title ?? "").slice(0, 60)));
	});
	app.post("/api/agents/:id/conversations/:cid/select", (c) => c.json({ ok: setCurrentConversation(c.req.param("id"), c.req.param("cid")) }));
	app.patch("/api/conversations/:cid", async (c) => {
		const b = await c.req.json<{ title: string }>();
		renameConversation(c.req.param("cid"), String(b.title ?? ""));
		return c.json({ ok: true });
	});
	app.delete("/api/conversations/:cid", async (c) => {
		await disposeConversationRuntime(c.req.param("cid"));
		return c.json({ ok: !!deleteConversation(c.req.param("cid")) });
	});
	/** 上下文用量（输入框旁的圆环）：会话还没在内存里时只返回模型的上下文窗口 */
	app.get("/api/conversations/:cid/context", async (c) => {
		const conv = getConversation(c.req.param("cid"));
		if (!conv) return c.json({ error: "not_found" }, 404);
		const s = runtime(conv.agent_id, conv.id).session;
		if (s) {
			const st = sessionStats(s);
			return c.json({ ...st, model: st.model ? withProviderName(st.model) : st.model });
		}
		return c.json({ tokens: null, contextWindow: null, percent: null, model: null, session: null });
	});
	/** 手动整理上下文（Pi compaction）。可选 body { instructions }：只影响摘要请求（希望保留什么），
	 *  不进主会话 system prompt、不改变权限 / 安全策略；缺省 / 空串 = 原行为。 */
	app.post("/api/conversations/:cid/compact", async (c) => {
		const conv = getConversation(c.req.param("cid"));
		if (!conv) return c.json({ error: "not_found" }, 404);
		const b = await c.req.json<{ instructions?: unknown }>().catch(() => ({}) as { instructions?: unknown });
		if (b.instructions !== undefined && b.instructions !== null && typeof b.instructions !== "string") return c.json({ error: "invalid_instructions" }, 400);
		const raw = typeof b.instructions === "string" ? b.instructions : "";
		if (raw.length > 2000) return c.json({ error: "instructions_too_long" }, 400);
		try {
			return c.json({ ok: true, ...(await runtime(conv.agent_id, conv.id).compact(raw)) });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	// ---------------------------------------------------------------- 从消息另开会话分支
	/** 从某一则 user 消息另开一个分支对话（Pi 公开 SessionManager fork）；不自动发 prompt、不重放工具。 */
	app.post("/api/conversations/:cid/fork", async (c) => {
		const b = await c.req.json<{ messageId?: string; clientId?: string }>().catch(() => ({}) as { messageId?: string; clientId?: string });
		if (!b.messageId || typeof b.messageId !== "string") return c.json({ error: "缺少 messageId", code: "not_found" }, 404);
		try {
			return c.json(forkConversation({ conversationId: c.req.param("cid"), messageId: b.messageId, clientId: typeof b.clientId === "string" && b.clientId ? b.clientId : null }));
		} catch (e) {
			if (e instanceof ForkError) return c.json({ error: e.message, code: e.code }, e.status);
			return c.json({ error: e instanceof Error ? e.message : String(e), code: "fork_failed" }, 500);
		}
	});
	app.get("/api/agents/:id/memory", async (c) => {
		const id = c.req.param("id");
		const a = getAgent(id);
		if (!a) return c.json({ error: "not_found" }, 404);
		const items = await memory.list(id, undefined, c.req.query("q") || undefined);
		const p = listMemoryProviders().find((x) => x.id === (a.memory_provider ?? globalMemoryProviderId()))!;
		return c.json({ provider: p, agentProvider: a.memory_provider ?? null, items: items.map((i) => ({ id: i.id, text: i.text, kind: i.kind, scope: i.scope, status: i.status, taskId: i.taskId ?? null, createdAt: i.createdAt, expiresAt: i.expiresAt ?? null, conversationId: i.conversationId ?? null, source: i.origin?.source ?? i.meta?.source ?? null })) });
	});
	app.post("/api/agents/:id/memory", async (c) => {
		const b = await c.req.json<{ text: string; kind?: "fact" | "experience" | "note"; scope?: "user" | "agent" | "conversation"; conversationId?: string; ttlDays?: number }>();
		try {
			const r = await memory.remember(c.req.param("id"), b.conversationId ?? null, { content: String(b.text ?? ""), kind: b.kind, scope: b.scope, ttlDays: b.ttlDays, source: "user", actor: "user" });
			bus.emit({ type: "memory.changed", agentId: c.req.param("id") });
			return c.json(r);
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.patch("/api/agents/:id/memory/:mid", async (c) => {
		const b = await c.req.json<{ text?: string; kind?: "fact" | "experience" | "note"; scope?: "user" | "agent" | "conversation" }>();
		const id = await memory.update(c.req.param("id"), c.req.param("mid"), b, null, { actor: "user" });
		bus.emit({ type: "memory.changed", agentId: c.req.param("id") });
		return id ? c.json({ ok: true, id }) : c.json({ error: "not_found" }, 404);
	});
	app.delete("/api/agents/:id/memory/:mid", async (c) => {
		let ok = false;
		try {
			ok = await memory.forget(c.req.param("id"), c.req.param("mid"), { actor: "user" });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 403);
		}
		bus.emit({ type: "memory.changed", agentId: c.req.param("id") });
		return c.json({ ok });
	});
	app.get("/api/agents/:id/memory/export", async (c) => {
		try {
			const data = await memory.exportAgent(c.req.param("id"));
			return c.body(JSON.stringify(data, null, 2), 200, { "content-type": "application/json", "content-disposition": `attachment; filename="memory-${c.req.param("id")}.json"` });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	/** 反思：在记忆上推理作答（后端支持时，如 Hindsight） */
	app.post("/api/agents/:id/memory/reflect", async (c) => {
		const { query } = await c.req.json<{ query: string }>();
		try {
			const r = await memory.reflect(c.req.param("id") as string, String(query ?? "").slice(0, 1000), { actor: "user" });
			if (!r) return c.json({ error: "当前记忆后端不支持反思" }, 400);
			return c.json({ answer: r.answer, citations: (r.citations ?? []).slice(0, 8).map((i) => ({ id: i.id, text: i.text })) });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	/** 导入统一格式的记忆 JSON（本应用导出的文件；可以来自另一个后端或另一台电脑） */
	app.post("/api/agents/:id/memory/import", async (c) => {
		try {
			const n = await memory.importAgent(c.req.param("id") as string, await c.req.json());
			bus.emit({ type: "memory.changed", agentId: c.req.param("id") });
			return c.json({ ok: true, count: n });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.put("/api/agents/:id/memory-provider", async (c) => {
		const { id } = await c.req.json<{ id: string | null }>();
		if (id && !listMemoryProviders().some((p) => p.id === id)) return c.json({ error: "unknown_provider" }, 400);
		db.prepare("UPDATE agents SET memory_provider = ? WHERE id = ?").run(id, c.req.param("id"));
		syncSidecarWanted();
		return c.json({ ok: true });
	});
	// 某助理启用的技能：`enabled` 是 canonical id 列表；`enabledSkills` 只给已启用技能的元数据（composer 技能入口用，不下发未分配技能）。
	app.get("/api/agents/:id/skills", (c) => {
		const id = c.req.param("id");
		return c.json({ enabled: assignedSkillIds(id), enabledSkills: enabledSkillsFor(id).map((s) => ({ id: s.id, name: s.name, description: s.description, source: s.source })) });
	});
	app.put("/api/agents/:id/skills", async (c) => {
		const b = await c.req.json<{ ids?: unknown }>();
		if (!Array.isArray(b.ids) || !b.ids.every((x) => typeof x === "string")) return c.json({ error: "ids 必须是字符串数组" }, 400);
		if (!getAgent(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
		setAssignedSkillIds(c.req.param("id"), b.ids as string[]);
		return c.json({ enabled: assignedSkillIds(c.req.param("id")) });
	});
	app.get("/api/agents/:id/routines", (c) => c.json(listRoutines(c.req.param("id")).map(routineJson)));
	app.post("/api/agents/:id/routines", async (c) => {
		const id = c.req.param("id");
		if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
		try {
			const b = await c.req.json<RoutineInput>();
			return c.json(routineJson(createRoutine(id, { ...b, conversationId: b.conversationId ?? currentConversation(id) }, by(c))));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.post("/api/agents/:id/read", (c) => {
		db.prepare("UPDATE agents SET unread = 0 WHERE id = ?").run(c.req.param("id"));
		bus.emit({ type: "agent.read", agentId: c.req.param("id") });
		return c.json({ ok: true });
	});
	app.post("/api/agents/:id/upload", async (c) => {
		const id = c.req.param("id");
		if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
		const body = await c.req.parseBody();
		const f = body.file;
		if (!(f instanceof File)) return c.json({ error: "no_file" }, 400);
		if (f.size > 100 * 1024 * 1024) return c.json({ error: "文件超过 100MB" }, 413);
		const row = saveUpload(id, f.name, Buffer.from(await f.arrayBuffer()));
		return c.json(fileInfo(row));
	});
	app.get("/api/agents/:id/files", (c) => c.json(listFiles(c.req.param("id"))));
	app.get("/api/agents/:id/workspace", (c) => {
		try {
			return c.json(listWorkspace(c.req.param("id"), c.req.query("path") ?? ""));
		} catch (e) {
			return c.json({ error: String(e) }, 400);
		}
	});
	app.get("/api/agents/:id/workspace/file", (c) => {
		const abs = insideWorkspace(c.req.param("id"), c.req.query("path") ?? "");
		if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return c.json({ error: "not_found" }, 404);
		return sendFile(c, abs, abs.split(/[\\/]/).pop()!, mimeOf(abs));
	});
	/** 任务等待：状态 + 最后检查时间可查询；手动刷新让用户问“现在怎么样了”立刻有结果 */
	app.get("/api/agents/:id/task-waits", (c) => c.json(listWaits(c.req.param("id"))));
	app.post("/api/task-waits/:id/refresh", async (c) => {
		try {
			const r = await refreshWait(c.req.param("id"));
			return c.json({ wait: r.wait, outcome: r.outcome, fired: r.fired });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
		}
	});
	app.post("/api/task-waits/:id/cancel", (c) => c.json({ ok: cancelWait(c.req.param("id")) }));
	app.get("/api/files/:id", (c) => {
		const f = getFile(c.req.param("id"));
		if (!f || !existsSync(f.stored_path)) return c.json({ error: "not_found" }, 404);
		return sendFile(c, f.stored_path, f.name, f.mime);
	});
	// ---------------------------------------------------------------- 审批 / 提问
	app.post("/api/requests/:id", async (c) => {
		const b = await c.req.json<{ approved?: boolean; answer?: string; note?: string; scope?: string }>();
		return c.json(requests.resolve(c.req.param("id"), { approved: b.approved, answer: b.answer, note: b.note, scope: b.scope === "task" ? "task" : undefined }, by(c)));
	});
	app.get("/api/agents/:id/proactive", (c) => {
		try {
			return c.json(proactiveJson(c.req.param("id")!));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 404);
		}
	});
	app.put("/api/agents/:id/proactive", async (c) => {
		try {
			const id = c.req.param("id")!;
			const body = await c.req.json<Parameters<typeof saveProactive>[1]>();
			const res = saveProactive(id, body);
			// 免打扰时段是助理级的一份：定时任务也按它顺延，改了就重算下次执行
			if (body.cfg && "quiet" in body.cfg) rescheduleAgentRoutines(id);
			return c.json(res);
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.post("/api/agents/:id/proactive/run", (c) => {
		try {
			return c.json({ runId: runHeartbeat(c.req.param("id")!, "manual") });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.delete("/api/agents/:id/proactive/followups/:fid", (c) => c.json({ ok: cancelFollowup(c.req.param("id")!, c.req.param("fid")!) }));
	/** 电脑操作记录 */
	app.get("/api/actions", (c) =>
		c.json({ items: listActions({ agentId: c.req.query("agentId") || undefined, target: c.req.query("target") || undefined, before: Number(c.req.query("before")) || undefined, limit: Number(c.req.query("limit")) || 100 }) }),
	);
	app.get("/api/actions/:id/shot", (c) => {
		const png = actionShot(c.req.param("id")!);
		return png ? new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, max-age=86400" } }) : c.json({ error: "not_found" }, 404);
	});
	app.delete("/api/actions", localOnly, (c) => (clearActions(c.req.query("agentId") || undefined), c.json({ ok: true })));
	app.get("/api/agents/:id/desktop", async (c) => c.json(await deskJson(c.req.param("id"))));
	app.post("/api/agents/:id/desktop/start", async (c) => {
		try {
			const p = startDesktop(c.req.param("id"));
			deskChanged(c.req.param("id")); // 界面先显示“启动中”
			await p;
			deskChanged(c.req.param("id"));
			return c.json(await deskJson(c.req.param("id")));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.post("/api/agents/:id/desktop/stop", async (c) => {
		await stopDesktop(c.req.param("id"));
		bus.emit({ type: "desktop.changed", agentId: c.req.param("id") });
		return c.json(await deskJson(c.req.param("id")));
	});
	app.post("/api/agents/:id/desktop/pause", async (c) => {
		const { paused } = await c.req.json<{ paused: boolean }>();
		desktopPause.set(c.req.param("id"), paused);
		if (paused) await runtime(c.req.param("id")).abort();
		bus.emit({ type: "desktop.changed", agentId: c.req.param("id") });
		return c.json(await deskJson(c.req.param("id")));
	});
	/** 单独的电脑：开 / 关（关掉时数据保留）；hasData = 这个助理有单独电脑留下的数据（null = 虚拟机关着，不知道） */
	app.get("/api/agents/:id/computer", async (c) => {
		const id = c.req.param("id");
		return c.json({ separate: desktopSettings().separate.includes(id), hasData: await hasSeparateData(id).catch(() => null), desktop: await deskJson(id) });
	});
	app.put("/api/agents/:id/computer", async (c) => {
		const id = c.req.param("id");
		const b = await c.req.json<{ separate: boolean }>();
		if (agentBusy(id)) return c.json({ error: "这个助理正在工作，等它做完再切换电脑" }, 409);
		await setSeparateComputer(id, !!b.separate);
		deskChanged(id);
		return c.json({ separate: desktopSettings().separate.includes(id), hasData: await hasSeparateData(id).catch(() => null), desktop: await deskJson(id) });
	});
	/** 把单独电脑的数据合并进共用电脑（两台电脑都会先关机），之后这个助理用共用电脑 */
	app.post("/api/agents/:id/computer/merge", async (c) => {
		const id = c.req.param("id");
		try {
			const r = await mergeIntoShared(id, agentBusy);
			deskChanged(id);
			return c.json({ ok: true, result: r, desktop: await deskJson(id) });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	/** 用户在「电脑」标签里给这个助理开 / 关自己的屏幕 */
	app.post("/api/agents/:id/desktop/screen", async (c) => {
		const id = c.req.param("id");
		const b = await c.req.json<{ own: boolean }>();
		try {
			if (b.own) await ensureOwnScreen(id);
			else await releaseScreen(id);
			deskChanged(id);
			return c.json(await deskJson(id));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.post("/api/agents/:id/desktop/ticket", async (c) => {
		const b = await c.req.json<{ screen?: string }>().catch(() => ({}) as { screen?: string });
		return c.json({ ticket: issueTicket(c.req.param("id"), b.screen) });
	});
	app.get("/api/agents/:id/desktop/screenshot", async (c) => {
		try {
			return c.body(new Uint8Array(await screenshotDesktop(c.req.param("id"), c.req.query("screen") || undefined)), 200, { "content-type": "image/png", "cache-control": "no-store" });
		} catch {
			return c.json({ error: "not_running" }, 409);
		}
	});
}
