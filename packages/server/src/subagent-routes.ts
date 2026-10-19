import type { Hono } from "hono";
import { getConversation } from "./conversations.ts";
import { db } from "./db.ts";
import { groupHelperDetail, helperRoomOf, setGroupHelperDetail } from "./helper-scope.ts";
import { getAgent, runtime } from "./runtime.ts";
import { toMessage, type MessageRow } from "./messages.ts";
import { providerNames, defaultThinking } from "./models.ts";
import { configuredModels } from "./rooms/model-pick.ts";
import { agentSubagentPool, agentSubagentSettingsDto, agentSubagentThinking, applyLiveSubagentThinking, getSubagent, resolveSubagentFast, setSubagentFastOverride, isLiveSubagent, listSubagents, resolveSubagentThinking, resumeSubagent, saveAgentSubagentPool, saveAgentSubagentChoice, saveAgentSubagentThinking, saveAgentSubagentLimits, saveSubagentSettings, sendSubagentMessage, setSubagentThinkingOverride, spawnSubagent, stopSubagent, subagentSettings, withResumeInfo, type SubagentThinking, type SubagentSettingsInput, type SubagentLimitsInput } from "./subagents.ts";

/** 子代理行 + 恢复摘要 + 实际生效的思考强度（已按模型收敛） */
const withThinking = (r: ReturnType<typeof getSubagent>) => {
	if (!r) return r;
	const a = getAgent(r.agent_id);
	const main = a?.thinking ?? defaultThinking();
	// resolvedFast：实际会用到的请求级 Fast（子代理覆盖 > 所属助理；默认跟随），与思考强度分开
	return { ...withResumeInfo(r), resolvedThinking: resolveSubagentThinking(r.agent_id, { provider: r.model_provider, id: r.model_id }, main, r.thinking), resolvedFast: resolveSubagentFast(r.agent_id, r.fast) };
};

// biome-ignore lint/suspicious/noExplicitAny: 同 http.ts
export function mountSubagentRoutes(app: Hono<any>) {
	app.get("/api/subagents/settings", (c) => c.json({ settings: subagentSettings(), models: configuredModels().map((m) => ({ provider: m.provider, id: m.id, name: m.name, reasoning: !!m.reasoning, providerName: providerNames().get(m.provider) ?? m.provider, thinking: m.thinking ?? ["off"] })) }));
	// 群里帮手的完整执行详情给谁看（owner = 派它的助理和用户，默认；group = 群成员都能看）
	app.get("/api/settings/group-helper-detail", (c) => c.json({ value: groupHelperDetail() }));
	app.put("/api/settings/group-helper-detail", async (c) => {
		try { return c.json({ value: setGroupHelperDetail((await c.req.json<{ value?: unknown }>()).value) }); }
		catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
	});
	app.put("/api/subagents/settings", async (c) => {
		try { return c.json(saveSubagentSettings(await c.req.json<SubagentSettingsInput>())); }
		catch (e) { return c.json({ error: String(e) }, 400); }
	});
	// 助理级子代理上限（并发 / 最长运行）：只读写该助理自己的独立键，不在旧全局接口里暴露（避免误以为改的是全局）。
	app.get("/api/agents/:id/subagents/settings", (c) => {
		const id = c.req.param("id");
		if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
		return c.json(agentSubagentSettingsDto(id));
	});
	app.put("/api/agents/:id/subagents/settings", async (c) => {
		const id = c.req.param("id");
		if (!getAgent(id)) return c.json({ error: "not_found" }, 404);
		const body = await c.req.json<unknown>().catch(() => undefined);
		// 严格入参：只认 maxConcurrent / maxMinutes（number 或 null），未知字段一律拒绝，不落库
		if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "请求体必须是 JSON 对象" }, 400);
		const b = body as Record<string, unknown>;
		const extra = Object.keys(b).filter((k) => k !== "maxConcurrent" && k !== "maxMinutes");
		if (extra.length) return c.json({ error: `不认识的字段：${extra.join("、")}` }, 400);
		const bad = (["maxConcurrent", "maxMinutes"] as const).find((k) => k in b && b[k] !== null && typeof b[k] !== "number");
		if (bad) return c.json({ error: `${bad} 必须是数字或 null` }, 400);
		try { return c.json(saveAgentSubagentLimits(id, b as SubagentLimitsInput)); }
		catch (e) { return c.json({ error: e instanceof Error ? e.message : String(e) }, 400); }
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
	app.get("/api/subagents", (c) => c.json(listSubagents(c.req.query("agent"), c.req.query("conversation")).filter((r) => !c.req.query("room") || helperRoomOf(r.conversation_id) === c.req.query("room")).map(withResumeInfo)));
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
			const b = await c.req.json<{ thinking?: string | null; fast?: boolean | null }>();
			if (b.thinking !== undefined) {
				const row = setSubagentThinkingOverride(id, b.thinking ?? null);
				const a = getAgent(r.agent_id);
				const level = resolveSubagentThinking(row.agent_id, { provider: row.model_provider, id: row.model_id }, a?.thinking ?? defaultThinking(), row.thinking);
				await applyLiveSubagentThinking(id, level);
			}
			// Fast 覆盖（null = 跟随所属助理）：只动 subagents.fast，不触发思考强度切换；下一次请求即生效
			if (b.fast !== undefined) setSubagentFastOverride(id, b.fast ?? null);
			return c.json({ subagent: withThinking(getSubagent(id)) });
		} catch (e) { return c.json({ error: String(e) }, 400); }
	});
	app.post("/api/subagents/:id/stop", async (c) => c.json({ ok: await stopSubagent(c.req.param("id")) }));
	// 用原 id 从断点继续：不新开子代理、不建新任务（失败/超时/停止后用户点「继续」）
	app.post("/api/subagents/:id/resume", (c) => {
		if (!getSubagent(c.req.param("id"))) return c.json({ error: "not_found" }, 404);
		try { return c.json(withThinking(resumeSubagent(c.req.param("id"), { mode: "manual" }))); }
		catch (e) { return c.json({ error: String(e) }, 400); }
	});
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
		if (isLiveSubagent(r.status)) return c.json({ error: r.status === "queued" ? "帮手正在排队，请先等它开始或停止" : "帮手仍在运行" }, 400);
		const a = getAgent(r.agent_id), conv = getConversation(r.conversation_id);
		if (!a || !conv) return c.json({ error: "会话已删除" }, 404);
		const fallback = runtime(a.id, conv.id).modelFor(a);
		if (!fallback) return c.json({ error: "没有可用模型" }, 400);
		try { return c.json(spawnSubagent(a.id, conv.id, fallback, { task: r.task, context: r.context, thinking: r.thinking ?? undefined })); }
		catch (e) { return c.json({ error: String(e) }, 400); }
	});
}
