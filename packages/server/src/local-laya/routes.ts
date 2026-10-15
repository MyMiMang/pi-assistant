/**
 * 本地 Laya 一键安装 / 生命周期路由。
 *
 * 契约见 docs/design/local-laya-api.md。全部 localOnly（仅本机回环），安装由**显式按钮**触发。
 */
import type { Context, Hono, Next } from "hono";
import { probeNvidia, readLayaLogs } from "./deps.ts";
import { layaManager } from "./index.ts";
import { rememberLocalModelStatus } from "../local-models.ts";
import { LAYA_MODEL_ID, LAYA_PROVIDER_ID, type LocalLayaManager } from "./manager.ts";
import { DEFAULT_CHECKPOINT, LAYA_CHECKPOINTS, LAYA_SOURCE } from "./manifest.ts";
import { platformProfile } from "./platform.ts";

// biome-ignore lint/suspicious/noExplicitAny: 与 http.ts 一致的挂载风格
type LocalOnly = (c: Context<any>, next: Next) => Promise<unknown>;

interface InstallBody {
	cuda?: boolean;
	xpu?: boolean;
	checkpoint?: string;
}

export function mountLocalLayaRoutes(app: Hono<any>, localOnly: LocalOnly, getManager: () => LocalLayaManager = layaManager) {
	const base = "/api/local-models/laya";

	// 读状态时顺带把安全元数据刷新进本地模型 hints：重启后「已安装但从未启动」也能在注册表里出现（不再只靠 bus 内存缓存）。
	app.get(`${base}/status`, localOnly, (c) => {
		const st = getManager().status();
		rememberLocalModelStatus(st, LAYA_PROVIDER_ID, LAYA_MODEL_ID);
		return c.json(st);
	});

	// 安装前预检：探测 NVIDIA 驱动（只看，不自动装系统驱动）+ 平台能力；UI 据此决定是否提供 CUDA / XPU 选项。
	app.get(`${base}/platform`, localOnly, async (c) => {
		const nvidia = await probeNvidia();
		return c.json({
			platform: platformProfile(process.platform, process.arch),
			nvidia,
			cudaAvailable: nvidia.available,
			options: [
				{ id: "cpu", label: "CPU（基线，所有平台可用）" },
				...(nvidia.available ? [{ id: "cuda", label: `NVIDIA CUDA（驱动 ${nvidia.driver ?? "已检测到"}）` }] : []),
			],
		});
	});

	app.post(`${base}/install`, localOnly, async (c) => {
		const body = await c.req.json<InstallBody>().catch(() => ({}) as InstallBody);
		const ctx = { wantCuda: !!body.cuda, wantXpu: !!body.xpu, nvidia: body.cuda ? await probeNvidia() : undefined };
		const profile = platformProfile(process.platform, process.arch, { wantCuda: ctx.wantCuda, wantXpu: ctx.wantXpu, nvidia: ctx.nvidia });
		if (profile.support === "unsupported") return c.json({ ok: false, error: profile.reason }, 400);
		const checkpoint = LAYA_CHECKPOINTS[body.checkpoint ?? DEFAULT_CHECKPOINT] ?? LAYA_CHECKPOINTS[DEFAULT_CHECKPOINT];
		const m = getManager();
		void m.install({ checkpoint, ctx: { wantCuda: ctx.wantCuda, wantXpu: ctx.wantXpu, nvidia: ctx.nvidia } }).catch(() => {});
		return c.json({ ok: true, status: m.status() });
	});

	app.post(`${base}/cancel`, localOnly, (c) => {
		const m = getManager();
		return c.json({ ok: m.cancel().ok, status: m.status() });
	});

	app.post(`${base}/start`, localOnly, async (c) => {
		try {
			const m = getManager();
			await m.start();
			return c.json({ ok: true, status: m.status() });
		} catch (e) {
			return c.json({ ok: false, error: msg(e), status: getManager().status() }, 400);
		}
	});

	app.post(`${base}/stop`, localOnly, async (c) => {
		const m = getManager();
		await m.stop();
		return c.json({ ok: true, status: m.status() });
	});

	app.post(`${base}/update`, localOnly, async (c) => {
		const m = getManager();
		void m.update().catch(() => {});
		return c.json({ ok: true, status: m.status() });
	});

	app.delete(base, localOnly, async (c) => {
		const body = await c.req.json<{ confirm?: boolean }>().catch(() => ({}) as { confirm?: boolean });
		try {
			await getManager().uninstall(!!body.confirm);
			return c.json({ ok: true, status: getManager().status() });
		} catch (e) {
			return c.json({ ok: false, error: msg(e), status: getManager().status() }, 400);
		}
	});

	// 只读的来源信息（界面「来源」标签），不碰安装状态。
	app.get(`${base}/source`, localOnly, (c) => c.json(LAYA_SOURCE));

	// 最近日志（已脱敏，不含 token）；界面「查看日志」用。
	app.get(`${base}/logs`, localOnly, (c) => c.json({ lines: readLayaLogs(Number(c.req.query("lines") ?? 200)) }));
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
