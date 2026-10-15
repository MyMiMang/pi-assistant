import type { Hono } from "hono";
import { getConversation } from "./conversations.ts";
import { db } from "./db.ts";
import { getAgent, runtime } from "./runtime.ts";
import { toMessage, type MessageRow } from "./messages.ts";
import { providerNames, defaultThinking } from "./models.ts";
import { configuredModels } from "./rooms/model-pick.ts";
import { agentSubagentPool, agentSubagentThinking, applyLiveSubagentThinking, getSubagent, isLiveSubagent, listSubagents, resolveSubagentThinking, saveAgentSubagentPool, saveAgentSubagentChoice, saveAgentSubagentThinking, saveSubagentSettings, sendSubagentMessage, setSubagentThinkingOverride, spawnSubagent, stopSubagent, subagentSettings, type SubagentThinking, type SubagentSettingsInput } from "./subagents.ts";

/** 子代理行 + 实际生效的思考强度（已按模型收敛） */
const withThinking = (r: ReturnType<typeof getSubagent>) => {
	if (!r) return r;
	const a = getAgent(r.agent_id);
	const main = a?.thinking ?? defaultThinking();
	return { ...r, resolvedThinking: resolveSubagentThinking(r.agent_id, { provider: r.model_provider, id: r.model_id }, main, r.thinking) };
};

// biome-ignore lint/suspicious/noExplicitAny: 同 http.ts
export function mountSubagentRoutes(app: Hono<any>) {
	app.get("/api/subagents/settings", (c) => c.json({ settings: subagentSettings(), models: configuredModels().map((m) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: !!m.reasoning, providerName: providerNames().get(m.provider) ?? m.provider, thinking: m.thinking ?? ["off"] })) }));
	app.put("/api/subagents/settings", async (c) => {
		try { return c.json(saveSubagentSettings(await c.req.json<SubagentSettingsInput>())); }
		catch (e) { return c.json({ error: String(e) }, 400); }
	});
	app.get("/api/agents/:id/subagent-model", (c) => c.json({ pool: agentSubagentPool(c.req.param("id")) }));
	app.put("/api/agents/:id/subagent-model", async (c) => {
		if (!getAgent(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
		try {
			const body = await c.req.json<{ pool?: { provider: string; id: string }[]; mode?: string; model?: { provider: string; id: string } }>();
			// 新形状：{ pool: [...] }；旧客户端可能还发 { mode, model }，兼容转换
			const saved = Array.isArray(body.pool) ? saveAgentSubagentPool(c.req.param("id"), { pool: body.pool }) : saveAgentSubagentChoice(c.req.param("id"), body.mode === "fixed" && body.model ? { mode: "fixed", model: body.model } : { mode: "follow" });
			return c.json(saved);
		} catch (e) { return c.json({ error: String(e) }, 400); }
	});
	app.get("/api/agents/:id/subagent-thinking", (c) => c.json(agentSubagentThinking(c.req.param("id"))));
	app.put("/api/agents/:id/subagent-thinking", async (c) => {
		if (!getAgent(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
		try { return c.json(saveAgentSubagentThinking(c.req.param("id"), await c.req.json<SubagentThinking>())); }
		catch (e) { return c.json({ error: String(e) }, 400); }
	});
	app.get("/api/subagents", (c) => c.json(listSubagents(c.req.query("agent"), c.req.query("conversation")).filter((r) => !c.req.query("room") || !!db.prepare("SELECT 1 FROM room_members WHERE conversation_id = ? AND room_id = ?").get(r.conversation_id, c.req.query("room") ?? ""))));
	app.get("/api/subagents/:id", (c) => {
		const r = getSubagent(c.req.param("id"));
		if (!r) return c.json({ error: "not_found" }, 404);
		const messages = (db.prepare("SELECT * FROM messages WHERE subagent_id = ? OR task_id = ? ORDER BY created_at, rowid").all(r.id, r.id) as unknown as MessageRow[]).map(toMessage);
		return c.json({ subagent: withThinking(r), messages });
	});
	// 单个子代理详情里改思考强度：落库为覆盖值（null = 跟随助理默认）；运行中立即切换（不动主会话）
	app.patch("/api/subagents/:id", async (c) => {
		const id = c.req.param("id");
		const r = getSubagent(id);
		if (!r) return c.json({ error: "not_found" }, 404);
		try {
			const b = await c.req.json<{ thinking?: string | null }>();
			if (b.thinking !== undefined) {
				const row = setSubagentThinkingOverride(id, b.thinking ?? null);
				const a = getAgent(r.agent_id);
				const level = resolveSubagentThinking(row.agent_id, { provider: row.model_provider, id: row.model_id }, a?.thinking ?? defaultThinking(), row.thinking);
				await applyLiveSubagentThinking(id, level);
			}
			return c.json({ subagent: withThinking(getSubagent(id)) });
		} catch (e) { return c.json({ error: String(e) }, 400); }
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
		try { return c.json(spawnSubagent(a.id, conv.id, fallback, { task: r.task, context: r.context, thinking: r.thinking ?? undefined })); }
		catch (e) { return c.json({ error: String(e) }, 400); }
	});
}
