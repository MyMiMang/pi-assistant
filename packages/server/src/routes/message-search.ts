import type { Hono } from "hono";
import type { Env } from "./common.ts";
import { db } from "../db.ts";
import { searchMessages, type SearchScope } from "../message-search.ts";
import { getRoom } from "../rooms/store.ts";

export function mountMessageSearchRoutes(app: Hono<Env>) {
	const find = (scope: SearchScope, q?: string, cursor?: string) => searchMessages(scope, q ?? "", cursor);
	app.get("/api/agents/:id/messages/search", (c) => {
		const agentId = c.req.param("id");
		const id = c.req.query("conversationId") ?? "";
		// 对话由该浏览器当前选择；校验归属，不回退、不搜群的内部成员会话。
		if (!db.prepare("SELECT 1 FROM conversations WHERE id = ? AND agent_id = ? AND COALESCE(hidden, 0) = 0").get(id, agentId)) return c.json({ error: "会话不存在" }, 404);
		const result = find({ kind: "conversation", id, agentId }, c.req.query("q"), c.req.query("cursor"));
		return result ? c.json(result) : c.json({ error: "搜索词或分页参数无效" }, 400);
	});
	app.get("/api/rooms/:rid/messages/search", (c) => {
		const id = c.req.param("rid");
		if (!getRoom(id)) return c.json({ error: "群不存在" }, 404);
		const result = find({ kind: "room", id }, c.req.query("q"), c.req.query("cursor"));
		return result ? c.json(result) : c.json({ error: "搜索词或分页参数无效" }, 400);
	});
}
