/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import { setSetting } from "../db.ts";
import { defaultModel, models, withProviderName } from "../models.ts";
import { globalMemoryProviderId, hindsightInUse, listMemoryProviders, memory } from "../memory/index.ts";
import { flush, hindsightMemory, resyncAll } from "../memory/hindsight/provider.ts";
import { configuredModels, resetEmbeddingStore, resolveMemoryModel, sidecar } from "../memory/hindsight/sidecar.ts";
import { embeddingSignature, LOCAL_EMBEDDINGS, LOCAL_RERANKERS, pickMemoryModel, publicSettings, saveHindsightSettings } from "../memory/hindsight/settings.ts";
import { llmProxy } from "../llm-proxy.ts";
import { localOnly, type Env } from "./common.ts";

/** 有人用 Hindsight 就保证它在跑；没人用了就停掉省内存 */
export function syncSidecarWanted() {
	if (hindsightInUse()) void sidecar.ensure();
	else if (sidecar.status.state !== "off") void sidecar.stop();
}

export function mountMemoryRoutes(app: Hono<Env>) {
	// ---------------------------------------------------------------- 记忆（与后端无关）
	app.get("/api/memory/providers", (c) => c.json({ global: globalMemoryProviderId(), providers: listMemoryProviders() }));
	app.put("/api/memory/provider", async (c) => {
		const { id } = await c.req.json<{ id: string }>();
		if (!listMemoryProviders().some((p) => p.id === id)) return c.json({ error: "unknown_provider" }, 400);
		setSetting("memoryProvider", id);
		syncSidecarWanted();
		return c.json({ ok: true });
	});
	// ---------------------------------------------------------------- 高级记忆（Hindsight）
	app.get("/api/memory/hindsight", async (c) => {
		const proxy = await llmProxy();
		const ms = await configuredModels();
		return c.json({
			settings: publicSettings(),
			status: hindsightMemory.status(),
			inUse: hindsightInUse(),
			models: ms.map((m) => withProviderName({ provider: m.provider, id: m.id, name: m.name })),
			autoModel: (() => {
				const a = pickMemoryModel(ms, defaultModel());
				return a ? withProviderName(a) : a;
			})(),
			effectiveModel: resolveMemoryModel(),
			localEmbeddings: LOCAL_EMBEDDINGS,
			localRerankers: LOCAL_RERANKERS,
			usage: proxy.stats,
		});
	});
	app.put("/api/memory/hindsight", localOnly, async (c) => {
		try {
			const { before, after } = saveHindsightSettings(await c.req.json());
			const sigChanged = embeddingSignature(before.embedding) !== embeddingSignature(after.embedding) || before.mode !== after.mode || before.remoteUrl !== after.remoteUrl;
			const needRestart = sigChanged || JSON.stringify(before.reranker) !== JSON.stringify(after.reranker) || before.mirror !== after.mirror;
			const embChanged = embeddingSignature(before.embedding) !== embeddingSignature(after.embedding);
			if (needRestart && sidecar.status.state !== "off")
				void sidecar.restart({ resetStore: embChanged }).then(() => (sigChanged ? resyncAll() : flush()));
			// 没在运行：现在就清掉旧维度的内嵌库，否则下次启动 Hindsight 会因向量维度不一致直接报错
			else if (embChanged) resetEmbeddingStore();
			const running = sidecar.status.state !== "off";
			// 只有已在运行时才会重启 / 重建；没在用时保存只是改设置
			return c.json({ ok: true, restarting: needRestart && running, rebuild: sigChanged && running });
		} catch (e) {
			return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.post("/api/memory/hindsight/restart", localOnly, async (c) => {
		void sidecar.restart();
		return c.json({ ok: true });
	});
	/** 测试记忆用模型：经本机网关走一遍（与 Hindsight 实际调用路径相同） */
	app.post("/api/memory/hindsight/test-model", async (c) => {
		const proxy = await llmProxy();
		// 可以测还没保存的选择（设置页里刚选的）；不传就测当前生效的
		const body = await c.req.json<{ llm?: { provider: string; id: string } | null }>().catch(() => ({}) as { llm?: { provider: string; id: string } | null });
		const m = body.llm ?? resolveMemoryModel();
		if (!m) return c.json({ ok: false, message: "还没有可用的模型，请先在「模型」里配置" });
		const t0 = Date.now();
		try {
			const r = await fetch(`${proxy.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: `${m.provider}/${m.id}`, messages: [{ role: "user", content: "Say 'ok'" }], max_tokens: 16 }), signal: AbortSignal.timeout(60_000) });
			const j = (await r.json()) as { choices?: { message: { content: string } }[]; error?: { message: string } };
			if (!r.ok) return c.json({ ok: false, message: j.error?.message ?? `HTTP ${r.status}` });
			return c.json({ ok: true, message: `${m.provider}/${m.id} 可用（${Date.now() - t0} ms）：${j.choices?.[0]?.message.content?.slice(0, 40) ?? ""}` });
		} catch (e) {
			return c.json({ ok: false, message: e instanceof Error ? e.message : String(e) });
		}
	});
}
