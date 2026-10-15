import type { Hono } from "hono";
import { models, providerNames } from "../models.ts";
import { configuredModels } from "../rooms/model-pick.ts";
import { fastComputerSettings, saveFastComputerSettings, type FastComputerScope, type FastComputerSettings } from "./index.ts";
import { benchmarkStatus, cancelBenchmark, listBenchmarks, type BenchmarkAvailability, type FastBenchmarkResult } from "./benchmark.ts";
import { BenchmarkFixtureStateStore, isPrivateSource, renderBenchmarkFixtureHtml } from "./benchmark-fixture.ts";

/**
 * 基准测试的宿主（由 runtime / 电脑模块注入）。
 * 未注入或环境未就绪时一律 `blocked`——绝不静默降级成 mock 冒充真实 CUA 结果。
 */
export interface BenchmarkHost {
	availability(): BenchmarkAvailability;
	/** 启动一次真实运行（调用方负责把真实 CUA deps 接进来）。未就绪时抛错。 */
	start(input: { provider?: string; model?: string; maxTrials?: number; warmup?: number; target?: "hostpc" | "computer" }): Promise<FastBenchmarkResult>;
}

/** 默认宿主：环境未就绪，明确告诉 UI 为什么不能跑。 */
const unavailableHost = (reason: string): BenchmarkHost => ({
	availability: () => ({ cuaReady: false, modelReady: false, fixtureReady: false, reasons: [reason] }),
	start: async () => {
		throw new Error(reason);
	},
});

const LOCAL_OWNER = "local";
/** 按调用方设备隔离：同一个 run 的私有进度 / 结果只回给发起它的 owner，别的设备看不到。 */
const ownerOf = (c: { get: (k: string) => unknown }): string => {
	const caller = c.get("caller") as { deviceId?: string | null; local?: boolean; ip?: string } | undefined;
	if (!caller) return LOCAL_OWNER;
	return caller.deviceId ?? (caller.local ? LOCAL_OWNER : caller.ip ?? LOCAL_OWNER);
};

export interface FastComputerRoutesOptions {
	host?: BenchmarkHost;
	store?: BenchmarkFixtureStateStore;
}

// biome-ignore lint/suspicious/noExplicitAny: 同 http.ts
export function mountFastComputerRoutes(app: Hono<any>, hostOrOpts?: BenchmarkHost | FastComputerRoutesOptions) {
	const isHost = (v: unknown): v is BenchmarkHost => !!v && typeof (v as BenchmarkHost).availability === "function" && typeof (v as BenchmarkHost).start === "function";
	const opts: FastComputerRoutesOptions = isHost(hostOrOpts) ? { host: hostOrOpts } : ((hostOrOpts as FastComputerRoutesOptions) ?? {});
	const benchHost = opts.host ?? unavailableHost("真实操控基准需要先开启「操作这台电脑」授权或让助理电脑就绪，且已选定快速操作模型");
	const store = opts.store ?? new BenchmarkFixtureStateStore();
	const runOwners = new Map<string, string>();

	// ------------------------------------------------------------ 隔离 fixture（测试页 + 机器状态 reporter）
	// GET 页面：run token 只从服务端已 arm 的存储取出后再烤进页面；未 arm 则 token 为空（页面无法上报）。
	// 这保证只有本次 run 真正打开的那个页面能获得 token。
	app.get("/api/fast-computer/benchmark/fixture/:fixtureId", (c) => {
		const fixtureId = c.req.param("fixtureId")!;
		const nonce = c.req.query("nonce") ?? "";
		const token = store.tokenOf(fixtureId, nonce) ?? "";
		return c.html(renderBenchmarkFixtureHtml(fixtureId, nonce, token));
	});
	// POST 机器状态：必须同时带对 nonce + run token，且来源是私有 / 回环地址；缺一不可。
	app.post("/api/fast-computer/benchmark/fixture/:fixtureId/state", async (c) => {
		const fixtureId = c.req.param("fixtureId")!;
		const nonce = c.req.query("nonce") ?? c.req.header("x-bench-nonce") ?? "";
		const token = c.req.header("x-bench-fixture-token") ?? "";
		const remote = (c as unknown as { env?: { incoming?: { socket?: { remoteAddress?: string } } } }).env?.incoming?.socket?.remoteAddress;
		if (!isPrivateSource(remote)) return c.json({ ok: false, reason: "source_not_private" }, 403);
		let patch: Record<string, unknown> = {};
		try {
			patch = await c.req.json<Record<string, unknown>>();
		} catch {
			/* 空 body 允许 */
		}
		const accepted = store.record(fixtureId, nonce, token, patch);
		return c.json({ ok: accepted });
	});

	const parseScope = (v: unknown): FastComputerScope | undefined => (v === "hostpc" || v === "computer" ? v : undefined);
	app.get("/api/fast-computer/settings", (c) =>
		c.json({
			settings: fastComputerSettings(parseScope(c.req.query("scope"))),
			models: configuredModels().map((m) => ({ provider: m.provider, id: m.id, name: m.name, providerName: providerNames().get(m.provider) ?? m.provider })),
			// 原生 Jev（System One）只能从 Pi 的 classifier 目录选；只回安全元数据（无 baseUrl / headers / 凭据）
			classifierModels: models.listClassifierModels().map((m) => ({ provider: m.provider, id: m.id, name: m.name, api: m.api, configured: m.configured, providerName: providerNames().get(m.provider) ?? m.provider })),
		}),
	);
	app.put("/api/fast-computer/settings", async (c) => {
		try {
			const body = await c.req.json<Partial<FastComputerSettings> & { scope?: unknown }>();
			const { scope: rawScope, ...patch } = body;
			return c.json(saveFastComputerSettings(patch, parseScope(rawScope)));
		} catch (e) {
			return c.json({ error: String(e) }, 400);
		}
	});

	// ------------------------------------------------------------ 真实操控基准测试
	// 共享结果 DTO：FastBenchmarkResult（见 benchmark.ts），UI 直接渲染，不要再拆独立 config section。
	app.get("/api/fast-computer/benchmark", (c) => {
		const owner = ownerOf(c);
		const runs = listBenchmarks().filter((r) => (runOwners.get(r.id) ?? owner) === owner);
		return c.json({ availability: benchHost.availability(), runs });
	});
	app.post("/api/fast-computer/benchmark", async (c) => {
		const owner = ownerOf(c);
		const avail = benchHost.availability();
		if (!avail.cuaReady || !avail.modelReady || !avail.fixtureReady) {
			return c.json({ ok: false, blocked: true, availability: avail }, 409);
		}
		try {
			let body: { provider?: string; model?: string; maxTrials?: number; warmup?: number; target?: "hostpc" | "computer" | string } = {};
			try {
				body = await c.req.json();
			} catch {
				/* 空 body 允许 */
			}
			const target = body.target === "hostpc" || body.target === "computer" ? body.target : undefined;
			const run = await benchHost.start({ provider: String(body.provider ?? ""), model: String(body.model ?? ""), maxTrials: body.maxTrials, warmup: body.warmup, target });
			runOwners.set(run.id, owner);
			return c.json({ ok: true, run });
		} catch (e) {
			return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
		}
	});
	app.get("/api/fast-computer/benchmark/:id", (c) => {
		const id = c.req.param("id")!;
		if ((runOwners.get(id) ?? ownerOf(c)) !== ownerOf(c)) return c.json({ error: "没有这次测试" }, 404);
		const s = benchmarkStatus(id);
		return s ? c.json(s) : c.json({ error: "没有这次测试" }, 404);
	});
	app.post("/api/fast-computer/benchmark/:id/cancel", (c) => {
		const id = c.req.param("id")!;
		if ((runOwners.get(id) ?? ownerOf(c)) !== ownerOf(c)) return c.json({ ok: false });
		return c.json({ ok: cancelBenchmark(id) });
	});

	// 供测试 / 内部访问 fixture 状态存储；生产由 host 持有同一个 store 实例。
	return store;
}
