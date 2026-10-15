/** 图片生成的 HTTP 接口（在 http.ts 里挂载） */
import type { Hono, MiddlewareHandler } from "hono";
import { customProviders } from "../models.ts";
import { agentChoice, defaultImageModel, fetchModelsFor, getProvider, labelOf, listProviders, providerJson, removeProvider, runGeneration, saveProvider, setAgentChoice, setDefaultImageModel, type AgentImageChoice, type ProviderInput } from "./index.ts";
import { costNote, ImageGenError, KINDS, supportsEdit } from "./providers.ts";

const errJson = (e: unknown) => {
	const err = e instanceof ImageGenError ? e : null;
	return { ok: false, error: err ? err.message : e instanceof Error ? e.message : String(e), detail: err?.detail, code: err?.code };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountImageRoutes(app: Hono<any>, admin: MiddlewareHandler<any>) {
	app.get("/api/image-models", (c) => {
		const providers = listProviders();
		const d = defaultImageModel();
		return c.json({
			kinds: KINDS,
			providers: providers.map(providerJson),
			models: providers.flatMap((p) => p.models.map((m) => ({ provider: p.id, providerName: p.name, id: m, edit: supportsEdit(p.kind, m), cost: costNote(m) ?? null }))),
			default: d ? { ...d, label: labelOf(d) } : null,
			// 可复用 Key 的自定义模型服务（OpenAI 兼容的中转站等）
			reusable: customProviders.list().filter((p) => p.configured && !p.noKey).map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, api: p.api })),
		});
	});
	app.post("/api/image-models/providers", admin, async (c) => {
		try {
			return c.json(providerJson(await saveProvider(null, await c.req.json<ProviderInput>())));
		} catch (e) {
			return c.json(errJson(e), 400);
		}
	});
	app.put("/api/image-models/providers/:id", admin, async (c) => {
		try {
			return c.json(providerJson(await saveProvider(c.req.param("id"), await c.req.json<ProviderInput>())));
		} catch (e) {
			return c.json(errJson(e), 400);
		}
	});
	app.delete("/api/image-models/providers/:id", admin, async (c) => c.json({ ok: await removeProvider(c.req.param("id")) }));
	app.post("/api/image-models/fetch-models", admin, async (c) => c.json(await fetchModelsFor(await c.req.json())));
	app.put("/api/image-models/default", admin, async (c) => {
		try {
			const b = await c.req.json<{ provider: string; model: string } | null>();
			setDefaultImageModel(b && b.provider ? { provider: b.provider, model: b.model } : null);
			return c.json({ ok: true });
		} catch (e) {
			return c.json(errJson(e), 400);
		}
	});
	/** 测试：真实生成一张小图（会产生一次费用，界面上有提示） */
	app.post("/api/image-models/test", admin, async (c) => {
		const b = await c.req.json<{ provider: string; model: string; prompt?: string }>();
		if (!getProvider(b.provider)?.models.includes(b.model)) return c.json({ ok: false, error: "模型不存在" }, 400);
		const t = Date.now();
		try {
			const r = await runGeneration({ provider: b.provider, model: b.model }, { prompt: b.prompt?.trim() || "一只坐在窗台上的橘猫，水彩风格", n: 1, aspect: "1:1", quality: "low" });
			const im = r.images[0];
			return c.json({ ok: true, ms: Date.now() - t, mime: im.mime, size: im.data.length, preview: `data:${im.mime};base64,${im.data.toString("base64")}` });
		} catch (e) {
			return c.json({ ...errJson(e), ms: Date.now() - t });
		}
	});
	app.get("/api/agents/:id/image-model", (c) => c.json({ choice: agentChoice(c.req.param("id")) }));
	app.put("/api/agents/:id/image-model", async (c) => {
		try {
			setAgentChoice(c.req.param("id"), await c.req.json<AgentImageChoice>());
			return c.json({ ok: true });
		} catch (e) {
			return c.json(errJson(e), 400);
		}
	});
}
