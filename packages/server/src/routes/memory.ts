/** 从 http.ts 拆出的路由（行为不变）。 */
import { Hono } from "hono";
import { setSetting } from "../db.ts";
import { defaultModel, models, withProviderName } from "../models.ts";
import { globalMemoryProviderId, hindsightInUse, listMemoryProviders, memory } from "../memory/index.ts";
import { flush, hindsightMemory, probeRecall, resyncAll } from "../memory/hindsight/provider.ts";
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
	/**
	 * 测试高级记忆：按 Hindsight 实际的三种用法各走一遍（与真实调用同一条网关路径、同样“思考能关就关”）
	 *  ① 多轮工具调用（反思就是这样：先调检索工具、拿到结果再回答；思考模式的模型在这一步最容易出错）
	 *  ② JSON 输出（事实抽取、整理）
	 *  ③ 真实召回一次（用户库），看耗时
	 */
	app.post("/api/memory/hindsight/test-model", async (c) => {
		const body = await c.req.json<{ llm?: { provider: string; id: string } | null }>().catch(() => ({}) as { llm?: { provider: string; id: string } | null });
		// 可以测还没保存的选择（设置页里刚选的）；不传就测当前生效的
		const m = body.llm ?? resolveMemoryModel();
		if (!m) return c.json({ ok: false, message: "还没有可用的模型，请先在「模型」里配置", steps: [] });
		const steps = await memorySelfTest(m);
		const bad = steps.filter((x) => !x.ok);
		const skipped = steps.filter((x) => x.skipped);
		return c.json({ ok: !bad.length, steps, message: bad.length ? `${bad.map((x) => x.name).join("、")}没通过` : skipped.length ? `${m.provider}/${m.id} 可用（${skipped.map((x) => x.name).join("、")}跳过）` : `${m.provider}/${m.id} 三项检查都通过` });
	});
}

type Step = { name: string; ok: boolean; ms: number; detail: string; skipped?: boolean };
const SKIP = "跳过：";
const TEST_ALIAS = "memory-selftest";
export async function memorySelfTest(m: { provider: string; id: string }): Promise<Step[]> {
	const proxy = await llmProxy();
	proxy.alias(TEST_ALIAS, () => m);
	const call = async (payload: Record<string, unknown>) => {
		const r = await fetch(`${proxy.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: TEST_ALIAS, max_tokens: 256, ...payload }), signal: AbortSignal.timeout(90_000) });
		const j = (await r.json()) as { choices?: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]; error?: { message: string } };
		if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
		return j.choices?.[0]?.message ?? { content: null };
	};
	const step = async (name: string, run: () => Promise<string>): Promise<Step> => {
		const t0 = Date.now();
		try {
			const detail = await run();
			return { name, ok: true, ms: Date.now() - t0, detail, ...(detail.startsWith(SKIP) ? { skipped: true } : {}) };
		} catch (e) {
			return { name, ok: false, ms: Date.now() - t0, detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
		}
	};
	const tools = [
		{ type: "function", function: { name: "search_memories", description: "检索记忆", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
		{ type: "function", function: { name: "done", description: "给出最终回答", parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } },
	];
	const system = "You MUST ONLY use information from retrieved tool results. 先调用 search_memories 检索，拿到结果后调用 done 给出回答。";
	const out: Step[] = [];
	out.push(
		await step("多轮工具调用", async () => {
			const user = { role: "user", content: "用户喜欢什么样的回答？" };
			const a = await call({ messages: [{ role: "system", content: system }, user], tools });
			const tc = a.tool_calls?.[0];
			if (!tc) throw new Error("模型没有调用工具（记忆反思需要工具调用）");
			const b = await call({ messages: [{ role: "system", content: system }, user, { role: "assistant", content: a.content, tool_calls: a.tool_calls }, { role: "tool", tool_call_id: tc.id, content: "用户喜欢简洁的回答" }], tools });
			if (!b.content && !b.tool_calls?.length) throw new Error("第二轮没有返回内容");
			return "两轮都正常";
		}),
	);
	out.push(
		await step("JSON 输出", async () => {
			const a = await call({ response_format: { type: "json_object" }, messages: [{ role: "user", content: '只返回这个 JSON：{"ok": true}' }] });
			JSON.parse(a.content ?? "");
			return "返回了合法 JSON";
		}),
	);
	out.push(
		await step("真实召回", async () => {
			// 还没启用 / 没在运行（比如刚在设置里选模型、还没保存）：只测模型，召回跳过并说明
			if (!sidecar.ready) return `${SKIP}高级记忆服务还没运行，保存并启用后再测`;
			const r = await probeRecall();
			return `用户库召回 ${r.count} 条`;
		}),
	);
	return out;
}
