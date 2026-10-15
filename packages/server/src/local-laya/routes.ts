/**
 * 本地 Laya 一键安装 / 生命周期路由。
 *
 * 契约见 docs/design/local-laya-api.md。全部 localOnly（仅本机回环），安装由**显式按钮**触发。
 */
import type { Context, Hono, Next } from "hono";
import { probeNvidia } from "./deps.ts";
import { layaManager } from "./index.ts";
import { DEFAULT_CHECKPOINT, LAYA_CHECKPOINTS, LAYA_SOURCE } from "./manifest.ts";
import { platformProfile } from "./platform.ts";

// biome-ignore lint/suspicious/noExplicitAny: 与 http.ts 一致的挂载风格
type LocalOnly = (c: Context<any>, next: Next) => Promise<unknown>;

interface InstallBody {
	cuda?: boolean;
	xpu?: boolean;
	checkpoint?: string;
}

export function mountLocalLayaRoutes(app: Hono<any>, localOnly: LocalOnly) {
	const base = "/api/local-models/laya";

	app.get(`${base}/status`, localOnly, (c) => c.json(layaManager().status()));

	app.post(`${base}/install`, localOnly, async (c) => {
		const body = await c.req.json<InstallBody>().catch(() => ({}) as InstallBody);
		const ctx = { wantCuda: !!body.cuda, wantXpu: !!body.xpu, nvidia: body.cuda ? await probeNvidia() : undefined };
		const profile = platformProfile(process.platform, process.arch, { wantCuda: ctx.wantCuda, wantXpu: ctx.wantXpu, nvidia: ctx.nvidia });
		if (profile.support === "unsupported") return c.json({ ok: false, error: profile.reason }, 400);
		const checkpoint = LAYA_CHECKPOINTS[body.checkpoint ?? DEFAULT_CHECKPOINT] ?? LAYA_CHECKPOINTS[DEFAULT_CHECKPOINT];
		const m = layaManager();
		void m.install({ checkpoint, ctx: { wantCuda: ctx.wantCuda, wantXpu: ctx.wantXpu, nvidia: ctx.nvidia } }).catch(() => {});
		return c.json({ ok: true, status: m.status() });
	});

	app.post(`${base}/cancel`, localOnly, (c) => {
		const m = layaManager();
		return c.json({ ok: m.cancel().ok, status: m.status() });
	});

	app.post(`${base}/start`, localOnly, async (c) => {
		try {
			const m = layaManager();
			await m.start();
			return c.json({ ok: true, status: m.status() });
		} catch (e) {
			return c.json({ ok: false, error: msg(e), status: layaManager().status() }, 400);
		}
	});

	app.post(`${base}/stop`, localOnly, async (c) => {
		const m = layaManager();
		await m.stop();
		return c.json({ ok: true, status: m.status() });
	});

	app.post(`${base}/update`, localOnly, async (c) => {
		const m = layaManager();
		void m.update().catch(() => {});
		return c.json({ ok: true, status: m.status() });
	});

	app.delete(base, localOnly, async (c) => {
		const body = await c.req.json<{ confirm?: boolean }>().catch(() => ({}) as { confirm?: boolean });
		try {
			await layaManager().uninstall(!!body.confirm);
			return c.json({ ok: true, status: layaManager().status() });
		} catch (e) {
			return c.json({ ok: false, error: msg(e), status: layaManager().status() }, 400);
		}
	});

	// 只读的来源信息（界面「来源」标签），不碰安装状态。
	app.get(`${base}/source`, localOnly, (c) => c.json(LAYA_SOURCE));
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
