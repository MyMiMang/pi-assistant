import type { Hono } from "hono";
import { models, providerNames } from "../models.ts";
import { configuredModels } from "../rooms/model-pick.ts";
import { fastComputerSettings, saveFastComputerSettings, type FastComputerSettings } from "./index.ts";

// biome-ignore lint/suspicious/noExplicitAny: 同 http.ts
export function mountFastComputerRoutes(app: Hono<any>) {
	app.get("/api/fast-computer/settings", (c) =>
		c.json({
			settings: fastComputerSettings(),
			models: configuredModels().map((m) => ({ provider: m.provider, id: m.id, name: m.name, providerName: providerNames().get(m.provider) ?? m.provider })),
			// 原生 Jev（System One）只能从 Pi 的 classifier 目录选；只回安全元数据（无 baseUrl / headers / 凭据）
			classifierModels: models.listClassifierModels().map((m) => ({ provider: m.provider, id: m.id, name: m.name, api: m.api, configured: m.configured, providerName: providerNames().get(m.provider) ?? m.provider })),
		}),
	);
	app.put("/api/fast-computer/settings", async (c) => {
		try {
			return c.json(saveFastComputerSettings(await c.req.json<Partial<FastComputerSettings>>()));
		} catch (e) {
			return c.json({ error: String(e) }, 400);
		}
	});
}
