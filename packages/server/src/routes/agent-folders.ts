import type { Hono } from "hono";
import { bus } from "../bus.ts";
import { db, now, uid } from "../db.ts";
import type { Env } from "./common.ts";

export const isNonemptyId = (id: unknown): id is string => typeof id === "string" && !!id.trim();
export const folderExists = (id: string) => !!db.prepare("SELECT 1 FROM agent_folders WHERE id = ?").get(id);

function folderName(value: unknown) {
	return typeof value === "string" ? value.trim().slice(0, 40) : "";
}

function moveAgents(ids: string[], folderId: string | null) {
	// 先核对整个批次。验证与更新在同一事务内，遇到缺失或群专属助理时不会留下部分结果。
	db.exec("BEGIN IMMEDIATE");
	try {
		if (folderId !== null && !folderExists(folderId)) return "folder_not_found";
		const unique = new Set(ids);
		const selected = JSON.stringify([...unique]);
		const rows = db.prepare("SELECT scope FROM agents WHERE id IN (SELECT value FROM json_each(?))").all(selected);
		if (rows.length !== unique.size) return "agent_not_found";
		if (rows.some((row) => row.scope !== "user")) return "room_agent";
		db.prepare("UPDATE agents SET folder_id = ? WHERE id IN (SELECT value FROM json_each(?))").run(folderId, selected);
		db.exec("COMMIT");
		return null;
	} finally {
		if (db.isTransaction) db.exec("ROLLBACK");
	}
}

export function mountAgentFolderRoutes(app: Hono<Env>) {
	app.get("/api/agent-folders", (c) => c.json(db.prepare("SELECT id, name FROM agent_folders ORDER BY created_at, rowid").all()));
	app.post("/api/agent-folders", async (c) => {
		const b = await c.req.json<{ name?: unknown }>().catch(() => null);
		const name = folderName(b?.name);
		if (!name) return c.json({ error: "请给文件夹起个名字" }, 400);
		const id = uid("af");
		db.prepare("INSERT INTO agent_folders(id, name, created_at) VALUES(?, ?, ?)").run(id, name, now());
		bus.emit({ type: "agents.changed" });
		return c.json({ id, name });
	});
	app.patch("/api/agent-folders/:id", async (c) => {
		const b = await c.req.json<{ name?: unknown }>().catch(() => null);
		const name = folderName(b?.name);
		if (!name) return c.json({ error: "请给文件夹起个名字" }, 400);
		const id = c.req.param("id");
		if (!db.prepare("UPDATE agent_folders SET name = ? WHERE id = ?").run(name, id).changes) return c.json({ error: "folder_not_found" }, 404);
		bus.emit({ type: "agents.changed" });
		return c.json({ id, name });
	});
	app.delete("/api/agent-folders/:id", (c) => {
		// 外键只清空归类，不删除助理或其数据。
		if (!db.prepare("DELETE FROM agent_folders WHERE id = ?").run(c.req.param("id")).changes) return c.json({ error: "folder_not_found" }, 404);
		bus.emit({ type: "agents.changed" });
		return c.json({ ok: true });
	});
	app.post("/api/agent-folders/move", async (c) => {
		const b = await c.req.json<{ agentIds?: unknown; folderId?: unknown }>().catch(() => null);
		if (!Array.isArray(b?.agentIds) || !b.agentIds.length || !b.agentIds.every(isNonemptyId) || (b.folderId !== null && !isNonemptyId(b.folderId))) {
			return c.json({ error: "invalid_move" }, 400);
		}
		const error = moveAgents(b.agentIds, b.folderId);
		if (error) return c.json({ error }, error === "room_agent" ? 400 : 404);
		bus.emit({ type: "agents.changed" });
		return c.json({ ok: true });
	});
}
