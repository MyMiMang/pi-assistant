import type { Hono } from "hono";
import { getConversation } from "./conversations.ts";
import { db } from "./db.ts";
import { getAgent, runtime } from "./runtime.ts";
import { toMessage, type MessageRow } from "./messages.ts";
import { providerNames } from "./models.ts";
import { configuredModels } from "./rooms/model-pick.ts";
import { agentSubagentChoice, getSubagent, isLiveSubagent, listSubagents, saveAgentSubagentChoice, saveSubagentSettings, sendSubagentMessage, spawnSubagent, stopSubagent, subagentSettings, type AgentSubagentChoice, type SubagentSettingsInput } from "./subagents.ts";

// biome-ignore lint/suspicious/noExplicitAny: 同 http.ts
export function mountSubagentRoutes(app: Hono<any>) {
	app.get("/api/subagents/settings", (c) => c.json({ settings: subagentSettings(), models: configuredModels().map((m) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: !!m.reasoning, providerName: providerNames().get(m.provider) ?? m.provider })) }));
	app.put("/api/subagents/settings", async (c) => {
		try { return c.json(saveSubagentSettings(await c.req.json<SubagentSettingsInput>())); }
		catch (e) { return c.json({ error: String(e) }, 400); }
	});
	app.get("/api/agents/:id/subagent-model", (c) => c.json(agentSubagentChoice(c.req.param("id"))));
	app.put("/api/agents/:id/subagent-model", async (c) => {
		if (!getAgent(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
		try { return c.json(saveAgentSubagentChoice(c.req.param("id"), await c.req.json<AgentSubagentChoice>())); }
		catch (e) { return c.json({ error: String(e) }, 400); }
	});
	app.get("/api/subagents", (c) => c.json(listSubagents(c.req.query("agent"), c.req.query("conversation")).filter((r) => !c.req.query("room") || !!db.prepare("SELECT 1 FROM room_members WHERE conversation_id = ? AND room_id = ?").get(r.conversation_id, c.req.query("room") ?? ""))));
	app.get("/api/subagents/:id", (c) => {
		const r = getSubagent(c.req.param("id"));
		if (!r) return c.json({ error: "not_found" }, 404);
		const messages = (db.prepare("SELECT * FROM messages WHERE subagent_id = ? OR task_id = ? ORDER BY created_at, rowid").all(r.id, r.id) as unknown as MessageRow[]).map(toMessage);
		return c.json({ subagent: r, messages });
	});
	app.post("/api/subagents/:id/stop", async (c) => c.json({ ok: await stopSubagent(c.req.param("id")) }));
	app.post("/api/subagents/:id/messages", async (c) => {
		const r = getSubagent(c.req.param("id"));
		if (!r || !getAgent(r.agent_id) || !getConversation(r.conversation_id)) return c.json({ error: "会话已删除" }, 404);
		try {
			const { text } = await c.req.json<{ text: string }>();
			if (typeof text !== "string") return c.json({ error: "请输入消息" }, 400);
			return c.json(await sendSubagentMessage(r.id, text));
		} catch (e) { return c.json({ error: String(e) }, 400); }
	});
	app.post("/api/subagents/:id/retry", (c) => {
		const r = getSubagent(c.req.param("id"));
		if (!r) return c.json({ error: "not_found" }, 404);
		if (isLiveSubagent(r.status)) return c.json({ error: r.status === "queued" ? "子代理正在排队，请先等它开始或停止" : "子代理仍在运行" }, 400);
		const a = getAgent(r.agent_id), conv = getConversation(r.conversation_id);
		if (!a || !conv) return c.json({ error: "会话已删除" }, 404);
		const fallback = runtime(a.id, conv.id).modelFor(a);
		if (!fallback) return c.json({ error: "没有可用模型" }, 400);
		try { return c.json(spawnSubagent(a.id, conv.id, fallback, { task: r.task, context: r.context })); }
		catch (e) { return c.json({ error: String(e) }, 400); }
	});
}
