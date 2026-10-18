/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import { bus } from "../bus.ts";
import { db } from "../db.ts";
import { fileInfo, saveRoomUpload } from "../files.ts";
import { getAgent } from "../runtime.ts";
import { confirmMemberProposal, confirmProposal, continueRoom, createRoom, deleteRoom, getRoom, listRoomMessages, markRead as markRoomRead, membersOf, normalizeProposal, postUserMessage, roomJson, listRooms, stop as stopRoom, updateRoom, createRoomAgent } from "../rooms/index.ts";
import { createWorkItem, listWorkItems } from "../work-items.ts";
import { getMessage, updateMessage as patchMessage } from "../messages.ts";
import { by, roomErr, type Env } from "./common.ts";
import { agentJson, deleteAgentFully } from "./agents.ts";
import { workErr } from "./work-items.ts";



export function mountRoomRoutes(app: Hono<Env>) {
	// ---------------------------------------------------------------- 群聊
	app.get("/api/rooms", (c) => c.json(listRooms()));
	app.post("/api/rooms", async (c) => {
		const b = await c.req.json<{ name?: string; purpose?: string; memberIds?: string[]; managerId?: string }>();
		try {
			return c.json(roomJson(createRoom({ name: b.name, purpose: b.purpose, memberIds: b.memberIds ?? [], managerId: b.managerId })));
		} catch (e) {
			return roomErr(c, e);
		}
	});
	app.get("/api/rooms/:rid", (c) => {
		const r = getRoom(c.req.param("rid"));
		return r ? c.json(roomJson(r)) : c.json({ error: "not_found" }, 404);
	});
	app.patch("/api/rooms/:rid", async (c) => {
		try {
			return c.json(roomJson(updateRoom(c.req.param("rid"), await c.req.json())));
		} catch (e) {
			return roomErr(c, e);
		}
	});
	app.delete("/api/rooms/:rid", async (c) => {
		const b = await c.req.json<{ keepAgents?: string[] }>().catch(() => ({}) as { keepAgents?: string[] });
		const r = await deleteRoom(c.req.param("rid"), { keepAgents: b.keepAgents });
		if (!r) return c.json({ error: "not_found" }, 404);
		// 没有保留的群专属助理：和普通删除助理一样清理
		for (const id of r.deletedAgents) await deleteAgentFully(id).catch(() => {});
		return c.json({ ok: true, deletedAgents: r.deletedAgents });
	});
	app.get("/api/rooms/:rid/messages", (c) => {
		const before = c.req.query("before");
		const after = c.req.query("after");
		return c.json(listRoomMessages(c.req.param("rid"), { before: before ? Number(before) : undefined, after: after ? Number(after) : undefined, limit: Number(c.req.query("limit") ?? 200) }));
	});
	app.post("/api/rooms/:rid/upload", async (c) => {
		const rid = c.req.param("rid");
		if (!getRoom(rid)) return c.json({ error: "not_found" }, 404);
		const f = (await c.req.parseBody()).file;
		if (!(f instanceof File)) return c.json({ error: "no_file" }, 400);
		if (f.size > 100 * 1024 * 1024) return c.json({ error: "文件超过 100MB" }, 413);
		return c.json(fileInfo(saveRoomUpload(rid, f.name, Buffer.from(await f.arrayBuffer()))));
	});
	app.post("/api/rooms/:rid/messages", async (c) => {
		const b = await c.req.json<{ text: string; mentions?: string[]; attachments?: string[]; replyToId?: string; clientId?: string; skills?: unknown }>();
		// 本次选用技能第一版只支持单聊：群聊多接收人需按目标逐个过滤，这里明确拒绝而不是静默丢掉
		if (b.skills !== undefined) return c.json({ error: "群聊暂不支持选用技能", code: "skills_not_supported" }, 400);
		try {
			return c.json(postUserMessage(c.req.param("rid"), String(b.text ?? ""), {
				mentions: Array.isArray(b.mentions) ? b.mentions.map(String) : [],
				from: by(c),
				attachments: Array.isArray(b.attachments) ? b.attachments.map(String) : [],
				replyToId: typeof b.replyToId === "string" && b.replyToId ? b.replyToId : undefined,
				clientId: typeof b.clientId === "string" && b.clientId ? b.clientId : undefined,
			}));
		} catch (e) {
			return roomErr(c, e);
		}
	});
	app.get("/api/rooms/:rid/work-items", (c) => {
		if (!getRoom(c.req.param("rid"))) return c.json({ error: "not_found" }, 404);
		const status = c.req.query("status");
		return c.json(listWorkItems(c.req.param("rid"), {
			status: status && ["pending", "active", "blocked", "review", "done", "paused", "cancelled", "open"].includes(status) ? (status as never) : undefined,
			limit: Number(c.req.query("limit") ?? 100),
			before: c.req.query("before") ? Number(c.req.query("before")) : undefined,
			beforeId: c.req.query("beforeId") || undefined,
		}));
	});
	app.post("/api/rooms/:rid/work-items", async (c) => {
		const b = await c.req.json<{ title?: string; requirement?: string; doneCriteria?: string; ownerAgentId?: string | null; start?: boolean; sourceMessageId?: string }>();
		try {
			const d = createWorkItem({ roomId: c.req.param("rid"), title: String(b.title ?? ""), requirement: b.requirement, doneCriteria: b.doneCriteria, ownerAgentId: b.ownerAgentId ?? null, start: b.start, sourceMessageId: b.sourceMessageId }, { kind: "user" });
			return c.json(d);
		} catch (e) {
			return workErr(c, e);
		}
	});
	app.post("/api/rooms/:rid/stop", async (c) => c.json({ ok: await stopRoom(c.req.param("rid")) }));
	app.post("/api/rooms/:rid/continue", (c) => {
		try {
			return c.json({ ok: continueRoom(c.req.param("rid")) });
		} catch (e) {
			return roomErr(c, e);
		}
	});
	app.post("/api/rooms/:rid/read", (c) => (markRoomRead(c.req.param("rid")), c.json({ ok: true })));
	/** 一键创建内置管理者（群里没有合适的助理当管理者时） */
	app.post("/api/rooms/builtin-manager", async (c) => {
		const b = await c.req.json<{ roomId?: string }>().catch(() => ({}) as { roomId?: string });
		const id = createRoomAgent(b.roomId ?? null, {
			name: "管家",
			avatar: "🧭",
			color: "#0f766e",
			role: "群管理者：理解需求、分配任务、汇总结果",
			persona: "你是群聊的管理者。先弄清用户真正想要什么，再把工作拆给最合适的成员，自己只做协调和简单的事。分配时写清楚每个人要交付什么。成员做完后，给用户一个简短、可执行的总结。",
			model: null,
		});
		if (!b.roomId) db.prepare("UPDATE agents SET scope = 'user' WHERE id = ?").run(id);
		const { safeTier } = await import("../rooms/permissions.ts");
		safeTier(id);
		if (b.roomId && getRoom(b.roomId)) updateRoom(b.roomId, { memberIds: [...membersOf(b.roomId).map((m) => m.agent_id), id], managerId: id });
		bus.emit({ type: "agents.changed" });
		return c.json(agentJson(getAgent(id)!));
	});
	/** 提议卡片（propose_room / room_propose_member）：用户在卡片上改完点确认才创建 */
	app.post("/api/proposals/:mid/confirm", async (c) => {
		const m = getMessage(c.req.param("mid"));
		if (!m || m.role !== "card" || !["room-proposal", "member-proposal"].includes(String(m.meta.kind))) return c.json({ error: "not_found" }, 404);
		if (m.meta.status !== "pending") return c.json({ error: "这张卡片已经处理过了" }, 409);
		const b = await c.req.json<{ proposal?: unknown; member?: unknown }>().catch(() => ({}) as { proposal?: unknown; member?: unknown });
		try {
			if (m.meta.kind === "room-proposal") {
				const p = normalizeProposal((b.proposal ?? m.meta.proposal) as never);
				const room = await confirmProposal(p);
				patchMessage(m.id, { meta: { status: "confirmed", proposal: p, roomId: room.id } });
				return c.json({ ok: true, room: roomJson(getRoom(room.id)!) });
			}
			const roomId = String(m.meta.roomId);
			const [mem] = normalizeProposal({ members: [(b.member ?? m.meta.member) as never] }).members;
			const id = await confirmMemberProposal(roomId, mem);
			patchMessage(m.id, { meta: { status: "confirmed", member: mem, agentId: id } });
			return c.json({ ok: true, agentId: id });
		} catch (e) {
			return roomErr(c, e);
		}
	});
	app.post("/api/proposals/:mid/dismiss", (c) => {
		const m = getMessage(c.req.param("mid"));
		if (!m || m.role !== "card") return c.json({ error: "not_found" }, 404);
		if (m.meta.status === "pending") patchMessage(m.id, { meta: { status: "dismissed" } });
		return c.json({ ok: true });
	});
}
