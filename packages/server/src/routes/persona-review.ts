import type { Hono } from "hono";
import { db } from "../db.ts";
import { cliModelError } from "../cli-services.ts";
import { models } from "../models.ts";
import { getAgent, runtime } from "../runtime.ts";
import { parsePersonaReview, personaReviewPrompt, PERSONA_REVIEW_LIMIT, PERSONA_REVIEW_SYSTEM } from "../persona-review.ts";
import type { Env } from "./common.ts";

export function mountPersonaReviewRoutes(app: Hono<Env>) {
	app.post("/api/agents/:id/persona-review", async (c) => {
		const a = getAgent(c.req.param("id"));
		if (!a) return c.json({ error: "找不到这个助理" }, 404);
		try {
			// 显式选中的 API 模型缺失时也禁止回退；CLI 注册等待及错误复用运行时。
			if (a.model_provider && a.model_id && !models.getModel(a.model_provider, a.model_id) && !cliModelError(a.model_provider)) throw new Error("这个助理选择的模型不可用，请在助理的模型页重新选择。");
			const pick = await runtime(a.id).resolveModel(a);
			if (!pick) throw new Error(cliModelError(a.model_provider) ?? "还没有可用的模型。请先在「设置 → 模型」里登录一个模型服务并选择默认模型。");
			// 隐藏会话包含群成员 / 任务执行，不能作为用户对这个助理的单聊要求。
			const rows = db.prepare(`SELECT m.role, m.content, m.created_at, m.rowid AS seq FROM messages m
				JOIN conversations c ON c.id = m.conversation_id AND c.agent_id = m.agent_id
				WHERE m.agent_id = ? AND COALESCE(c.hidden, 0) = 0
				AND m.room_id IS NULL AND m.task_id IS NULL AND m.subagent_id IS NULL
				AND m.role IN ('user', 'assistant') AND trim(m.content) <> ''
				ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`).all(a.id, PERSONA_REVIEW_LIMIT) as { role: string; content: string; created_at: number; seq: number }[];
			const result = await models.complete(pick.provider, pick.id, {
				systemPrompt: PERSONA_REVIEW_SYSTEM,
				messages: [{ role: "user", text: personaReviewPrompt(a.persona, rows) }],
				maxTokens: 4096, reasoning: "lowest", signal: c.req.raw.signal,
			});
			if (result.stopReason === "error") throw new Error(result.error || "整理失败，请稍后再试。");
			return c.json(parsePersonaReview(result.text, a.persona));
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : "整理失败，请稍后再试。" }, 400);
		}
	});
}
