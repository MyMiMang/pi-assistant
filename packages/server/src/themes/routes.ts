/**
 * 外观主题 AI 创作路由。
 *
 * POST /api/themes/draft  ← ThemeDraftRequest（packages/shared 冻结 DTO）
 *   → ThemeDraftResult（同 DTO）
 * 客户端取消（关面板 / 离开）时 fetch 会 abort，`c.req.raw.signal` 随之触发，后端真 abort 模型请求。
 */
import type { Hono } from "hono";
import type { ThemeDraftRequest } from "@pi-assistant/shared";
import { draftTheme } from "./index.ts";

// biome-ignore lint/suspicious/noExplicitAny: 与 http.ts 的其它 mount*Routes 一致
export function mountThemeRoutes(app: Hono<any>) {
	app.post("/api/themes/draft", async (c) => {
		const body = await c.req.json<ThemeDraftRequest>().catch(() => null);
		if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);
		const result = await draftTheme(body, { signal: c.req.raw.signal });
		return c.json(result);
	});
}
