/** 从 http.ts 拆出的路由（行为不变）。 */
import { effectiveApi, effectiveBaseUrl, guessFromUrl } from "../pi-adapter/relay-protocols.ts";
import { registryAsrProviders } from "../voice/index.ts";
import { Hono } from "hono";
import { modelLimitText } from "@pi-assistant/shared";
import { bus } from "../bus.ts";
import { getSetting, setSetting } from "../db.ts";
import { answerLogin, cancelLogin, loginLog, startLogin } from "../login-flows.ts";
import { customProviders, defaultModel, defaultThinking, isThinkingLevel, models, providerNames, providerReferences, clearProviderReferences, withProviderName } from "../models.ts";
import { fastCapability } from "../pi-adapter/fast-mode.ts";
import { getModelPicks, recordModelPick } from "../model-picks.ts";
import { buildRegistry, type RegistryImageProvider, type RegistryProviderHint } from "../model-registry.ts";
import { localModelHints } from "../local-models.ts";
import { hasKey as hasImageKey, listProviders as listImageProviders } from "../image-gen/index.ts";
import { costNote, supportsEdit } from "../image-gen/providers.ts";
import { supportedApis, MODEL_CAPABILITIES, type CustomProviderInput } from "../pi-adapter/custom-providers.ts";
import type { ModelCapability } from "../model-registry.ts";
import { classifierProtocols } from "../pi-adapter/index.ts";
import { errJson, type Env } from "./common.ts";

/** 统一模型服务注册表：一份带能力的元数据视图（内置 + 自定义 + 生图 + 本地；凭据仍由 Pi 按 provider 解析）。 */
const registryJson = () => {
	const names = providerNames();
	const providers: RegistryProviderHint[] = models.listProviders().map((p) => ({ id: p.id, name: p.name, configured: p.configured, source: p.source }));
	const image: RegistryImageProvider[] = listImageProviders().map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, models: p.models, configured: hasImageKey(p), credentialProvider: p.keyFrom || undefined }));
	return {
		providers: buildRegistry({
			providers,
			chatModels: models.listModels(),
			classifierModels: models.listClassifierModels(),
			custom: customProviders.list().map((p) => ({ ...p, name: p.name || names.get(p.id) || p.id })),
			image: { providers: image, supportsEdit: (kind, model) => supportsEdit(kind as Parameters<typeof supportsEdit>[0], model), costNote },
			local: localModelHints(),
			asr: registryAsrProviders(),
		}),
	};
};

export function mountModelRoutes(app: Hono<Env>) {
	// ---------------------------------------------------------------- 模型（完全由 Pi 的 provider 目录驱动）
	app.get("/api/models/providers", (c) => {
		const custom = new Map(customProviders.list().map((m) => [m.id, m]));
		return c.json(models.listProviders().map((p) => ({ ...p, custom: custom.has(p.id), configured: p.configured || !!custom.get(p.id)?.configured })));
	});
	// 自定义模型服务（中转站 / 第三方 / 本地），写入 Pi 的 models.json
	// 每个模型附上实际协议 / 地址（自动模式按模型识别），界面直接显示，不在前端再猜一遍
	app.get("/api/models/custom", (c) => c.json({ providers: customProviders.list().map((p) => ({ ...p, models: p.models.map((m) => ({ ...m, apiEffective: effectiveApi(p, m), baseUrlEffective: effectiveBaseUrl(p, m) })), references: providerReferences(p.id) })), apis: supportedApis(), classifierProtocols: classifierProtocols() }));
	// 新建时从地址猜接口格式和名称（只是预填）
	app.get("/api/models/custom/guess", (c) => c.json(guessFromUrl(c.req.query("url") ?? "")));
	app.post("/api/models/custom", async (c) => {
		try {
			const saved = await customProviders.save(null, await c.req.json<CustomProviderInput>());
			// 模型目录变化广播：已打开的页面（快速操作模型列表等）靠这个刷新，不用退出重进。
			bus.emit({ type: "settings.changed" });
			return c.json(saved);
		} catch (e) {
			return errJson(c, e);
		}
	});
	app.put("/api/models/custom/:id", async (c) => {
		try {
			const saved = await customProviders.save(c.req.param("id"), await c.req.json<CustomProviderInput>());
			bus.emit({ type: "settings.changed" });
			return c.json(saved);
		} catch (e) {
			return errJson(c, e);
		}
	});
	app.delete("/api/models/custom/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const ok = await customProviders.remove(id);
			const cleared = ok ? clearProviderReferences(id) : null;
			bus.emit({ type: "settings.changed" });
			return c.json({ ok, cleared });
		} catch (e) {
			return errJson(c, e);
		}
	});
	app.post("/api/models/custom/fetch-models", async (c) => {
		try {
			return c.json({ models: await customProviders.fetchModels(await c.req.json()) });
		} catch (e) {
			return errJson(c, e);
		}
	});
	app.get("/api/models", (c) => {
		const names = providerNames();
		return c.json(models.listModels(c.req.query("provider") || undefined).map((m) => ({ ...withProviderName(m, names), fast: fastCapability(m.api, m.provider) })));
	});
	app.get("/api/models/registry", (c) => c.json(registryJson()));
	/**
	 * 手动设置自定义模型的能力（统一注册表「手动设能力」的落点）。
	 * 只改我们的元数据（不写 Pi 的 models.json）；内置 / 生图 / 本地模型的能力由事实来源决定，不能手改。
	 * 返回最新注册表，UI 可直接刷新。
	 */
	app.put("/api/models/registry/:provider/models/:model/capabilities", async (c) => {
		const b = await c.req.json<{ capabilities?: unknown }>().catch(() => ({ capabilities: undefined }));
		const caps = Array.isArray(b.capabilities) ? [...new Set(b.capabilities.filter((x): x is string => typeof x === "string"))] : [];
		const bad = caps.find((x) => !(MODEL_CAPABILITIES as readonly string[]).includes(x));
		if (bad) return c.json({ error: `不支持的能力：${bad}` }, 400);
		try {
			customProviders.setModelCapabilities(c.req.param("provider"), c.req.param("model"), caps as ModelCapability[]);
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
		bus.emit({ type: "settings.changed" });
		return c.json(registryJson());
	});
	app.post("/api/models/refresh", async (c) => (await models.refresh(), c.json({ ok: true })));
	// 用户选过哪些模型：输入栏「常用」置顶（只记 provider/id 的频次和最近一次时间，不存凭据）
	app.get("/api/models/picks", (c) => c.json({ picks: getModelPicks() }));
	app.post("/api/models/picks", async (c) => {
		const b = await c.req.json<{ provider?: string; id?: string }>();
		if (!b.provider || !b.id || !models.getModel(b.provider, b.id)) return c.json({ error: "模型不存在" }, 400);
		return c.json({ picks: recordModelPick(b.provider, b.id) });
	});
	app.post("/api/models/login", async (c) => {
		const b = await c.req.json<{ provider: string; type: "api_key" | "oauth" }>();
		return c.json({ flowId: startLogin(b.provider, b.type) });
	});
	app.get("/api/models/login/:id", (c) => c.json(loginLog(c.req.param("id"))));
	app.post("/api/models/login/:id", async (c) => {
		const b = await c.req.json<{ promptId: string; value: string }>();
		return c.json({ ok: answerLogin(c.req.param("id"), b.promptId, b.value) });
	});
	app.delete("/api/models/login/:id", (c) => c.json({ ok: cancelLogin(c.req.param("id")) }));
	app.post("/api/models/logout", async (c) => {
		const b = await c.req.json<{ provider: string }>();
		await models.logout(b.provider);
		return c.json({ ok: true });
	});
	app.post("/api/models/test", async (c) => {
		const b = await c.req.json<{ provider: string; model: string }>();
		const r = await models.test(b.provider, b.model);
		// 额度 / 限流 / 冷却：给一句带恢复时间的中文，原文放 detail（界面 ? 提示里看）
		const friendly = r.ok ? null : modelLimitText(r.message);
		return c.json(friendly ? { ok: false, message: friendly, detail: r.message } : r);
	});
	// 识图模型（legacy，已废弃）：图片现在只跟随当前对话模型，这里仅保留只读兼容旧界面，不再影响路由。
	app.get("/api/models/vision", async (c) => {
		const { pickVisionModel, supportsVision } = await import("../vision.ts");
		const names = providerNames();
		const configured = new Set(models.listProviders().filter((p) => p.configured).map((p) => p.id));
		const candidates = models.listModels().filter((m) => configured.has(m.provider) && supportsVision(m)).map((m) => ({ provider: m.provider, id: m.id, name: m.name, providerName: names.get(m.provider) ?? m.provider }));
		const setting = getSetting<{ provider: string; id: string } | null>("visionModel", null);
		const pick = pickVisionModel();
		return c.json({
			deprecated: true,
			deprecatedNote: "识图模型设置已废弃：图片只跟随当前对话模型，不再单独选识图模型；此接口仅为旧界面保留。",
			setting,
			current: pick.model ? withProviderName(pick.model, names) : null,
			source: pick.source,
			candidates,
		});
	});
	app.put("/api/models/vision", async (c) => {
		// legacy 写入：只保存设置（旧界面用），不再影响图片路由；不删凭据 / 模型。
		const b = await c.req.json<{ provider?: string; id?: string } | null>();
		if (b?.provider && b.id) {
			if (!models.getModel(b.provider, b.id)) return c.json({ error: "模型不存在" }, 400);
			setSetting("visionModel", { provider: b.provider, id: b.id });
		} else setSetting("visionModel", null);
		return c.json({ ok: true, deprecated: true });
	});
	app.get("/api/models/defaults", (c) => c.json({ model: defaultModel(), thinking: defaultThinking() }));
	app.put("/api/models/default", async (c) => {
		const b = await c.req.json<{ provider?: string; model?: string; thinking?: string }>();
		if (b.thinking !== undefined) {
			if (!isThinkingLevel(b.thinking)) return c.json({ error: "思考强度不对" }, 400);
			setSetting("defaultThinking", b.thinking);
		}
		if (b.provider && b.model) {
			if (!models.getModel(b.provider, b.model)) return c.json({ error: "模型不存在" }, 400);
			setSetting("defaultModel", { provider: b.provider, id: b.model });
		}
		bus.emit({ type: "settings.changed" });
		return c.json({ ok: true });
	});
}
