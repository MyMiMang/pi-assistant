import type { Hono } from "hono";
import { models, providerNames } from "../models.ts";
import { configuredModels } from "../rooms/model-pick.ts";
import { fastComputerSettings, saveFastComputerSettings, type FastComputerSettings } from "./index.ts";
import { benchmarkStatus, cancelBenchmark, listBenchmarks, startBenchmark, type BenchmarkAvailability, type FastBenchmarkResult } from "./benchmark.ts";

/**
 * 基准测试的宿主（由 runtime / 电脑模块注入）。
 * 未注入或环境未就绪时一律 `blocked`——绝不静默降级成 mock 冒充真实 CUA 结果。
 */
export interface BenchmarkHost {
	availability(): BenchmarkAvailability;
	/** 启动一次真实运行（调用方负责把真实 CUA deps 接进来）。未就绪时抛错。 */
	start(input: { provider: string; model: string; maxTrials?: number; warmup?: number }): FastBenchmarkResult;
}

/** 默认宿主：环境未就绪，明确告诉 UI 为什么不能跑。 */
const unavailableHost = (reason: string): BenchmarkHost => ({
	availability: () => ({ cuaReady: false, modelReady: false, fixtureReady: false, reasons: [reason] }),
	start: () => {
		throw new Error(reason);
	},
});

// biome-ignore lint/suspicious/noExplicitAny: 同 http.ts
export function mountFastComputerRoutes(app: Hono<any>, host?: BenchmarkHost) {
	const benchHost = host ?? unavailableHost("真实操控基准需要先开启「操作这台电脑」授权或让助理电脑就绪，且已选定快速操作模型");
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

	// ------------------------------------------------------------ 真实操控基准测试
	// 共享结果 DTO：FastBenchmarkResult（见 benchmark.ts），UI 直接渲染，不要再拆独立 config section。
	app.get("/api/fast-computer/benchmark", (c) => c.json({ availability: benchHost.availability(), runs: listBenchmarks() }));
	app.post("/api/fast-computer/benchmark", async (c) => {
		const avail = benchHost.availability();
		if (!avail.cuaReady || !avail.modelReady || !avail.fixtureReady) {
			return c.json({ ok: false, blocked: true, availability: avail }, 409);
		}
		try {
			let body: { provider?: string; model?: string; maxTrials?: number; warmup?: number } = {};
			try {
				body = await c.req.json();
			} catch {
				/* 空 body 允许 */
			}
			return c.json({ ok: true, run: benchHost.start({ provider: String(body.provider ?? ""), model: String(body.model ?? ""), maxTrials: body.maxTrials, warmup: body.warmup }) });
		} catch (e) {
			return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.get("/api/fast-computer/benchmark/:id", (c) => {
		const s = benchmarkStatus(c.req.param("id")!);
		return s ? c.json(s) : c.json({ error: "没有这次测试" }, 404);
	});
	app.post("/api/fast-computer/benchmark/:id/cancel", (c) => c.json({ ok: cancelBenchmark(c.req.param("id")!) }));
}
