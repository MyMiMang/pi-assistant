/**
 * 本地多模型 ASR 的路由契约。
 *
 * 两类路由，**同一实现**：
 *  1. 通用（多模型）：`GET /api/local-models/asr/catalog`（硬件档位 / 推荐 / 每模型状态 + 许可 + 来源一次拿全）、
 *     `GET/POST/DELETE /api/local-models/asr/models/:id/*`（status / install / cancel / start / stop / pause / resume / idle / update / select / transcribe / uninstall）。
 *  2. 兼容旧单例：`/api/local-models/asr/sensevoice/*`（存量导入入口，语义不变）。
 *
 * 契约要点（用户要求）：
 *  - 许可限制必须**默认可见**：catalog / source 返回完整条款链接 + 限制摘要 + `acceptValue`；`install` 必须带
 *    `acceptLicense`（等于 `acceptValue`）；许可未确认的模型（SenseVoice）安装入口默认关闭，只保留「自行导入」。
 *  - **装 ≠ 用**：`install` 只负责装；`intent:"install_and_use"` 时，仅当选择自安装开始后未变，才把来源写成
 *    该本地模型（stale intent 防迟到 job 覆盖后来的 cloud 选择）。
 *  - 不暴露任何 token：status / catalog 只有 provider / model / protocol。
 *
 * ⚠️ UI → Server 的上传契约（multipart 字段名 / 返回结构）由语音输入主任务最终确定。
 */
import type { Context, Hono, Next } from "hono";
import { localAsrService, type LocalAsrService } from "./index.ts";
import { readAsrLogs } from "./deps.ts";
import { rememberLocalModelStatus } from "../local-models.ts";
import { ASR_MODEL_ID, ASR_PROVIDER_ID, SENSEVOICE_MODEL, SENSEVOICE_SOURCE } from "./manifest.ts";
import { licenseDisclosure } from "./license.ts";
import { SENSEVOICE_LICENSE } from "./manifest.ts";
import { senseVoicePlatform } from "./platform.ts";
import type { AsrInstallSource, LocalAsrManager } from "./manager.ts";
import { asrEndpoint } from "./adapter-registry.ts";
import { transcribeWav, WavRejectedError } from "./transcribe.ts";

// biome-ignore lint/suspicious/noExplicitAny: 与 http.ts 一致的挂载风格
type LocalOnly = (c: Context<any>, next: Next) => Promise<unknown>;

interface InstallBody {
	acceptLicense?: string;
	source?: AsrInstallSource;
	importDir?: string;
	intent?: "install" | "install_and_use";
}

export function mountLocalAsrRoutes(
	app: Hono<any>,
	localOnly: LocalOnly,
	getManager: () => LocalAsrManager = () => localAsrService().legacyManager(),
	opts: { service?: () => LocalAsrService } = {},
) {
	const svc = opts.service ?? (() => localAsrService());
	const base = "/api/local-models/asr/sensevoice";

	// ------------------------------------------------- legacy 单例（兼容存量）

	app.get(`${base}/status`, localOnly, (c) => {
		const st = getManager().status();
		rememberLocalModelStatus(st, ASR_PROVIDER_ID, ASR_MODEL_ID, Date.now(), "asr");
		return c.json(st);
	});

	app.get(`${base}/platform`, localOnly, (c) =>
		c.json({
			platform: senseVoicePlatform(process.platform, process.arch),
			accelerators: [{ id: "cpu", label: "CPU（唯一路径；未启用 MPS / CoreML）" }],
		}),
	);

	app.get(`${base}/source`, localOnly, (c) =>
		c.json({
			source: SENSEVOICE_SOURCE,
			license: licenseDisclosure(SENSEVOICE_LICENSE),
			model: {
				id: SENSEVOICE_MODEL.id,
				repo: SENSEVOICE_MODEL.repo,
				revision: SENSEVOICE_MODEL.revision,
				bytes: SENSEVOICE_MODEL.bytes,
				sampleRate: SENSEVOICE_MODEL.sampleRate,
				channels: SENSEVOICE_MODEL.channels,
				punctuation: SENSEVOICE_MODEL.punctuation,
				languages: SENSEVOICE_MODEL.languages,
				files: SENSEVOICE_MODEL.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
			},
		}),
	);

	app.get(`${base}/logs`, localOnly, (c) => c.json({ lines: readAsrLogs(Number(c.req.query("lines") ?? 200)) }));

	app.post(`${base}/install`, localOnly, async (c) => {
		const body = await c.req.json<InstallBody>().catch(() => ({}) as InstallBody);
		const m = getManager();
		const source: AsrInstallSource = body.source === "import" ? "import" : "download";
		const installOpts = { source, acceptLicense: body.acceptLicense ?? null, importDir: body.importDir };
		const pre = m.precheck(installOpts);
		if (!pre.ok) return c.json({ ok: false, error: pre.error, status: m.status() }, 400);
		void m.install(installOpts).catch(() => {});
		return c.json({ ok: true, status: m.status() });
	});

	app.post(`${base}/cancel`, localOnly, (c) => {
		const m = getManager();
		return c.json({ ok: m.cancel().ok, status: m.status() });
	});

	app.post(`${base}/start`, localOnly, async (c) => {
		try {
			await getManager().start();
			return c.json({ ok: true, status: getManager().status() });
		} catch (e) {
			return c.json({ ok: false, error: msg(e), status: getManager().status() }, 400);
		}
	});

	app.post(`${base}/stop`, localOnly, async (c) => {
		await getManager().stop("manual");
		return c.json({ ok: true, status: getManager().status() });
	});

	app.post(`${base}/pause`, localOnly, async (c) => {
		await getManager().pause();
		return c.json({ ok: true, status: getManager().status() });
	});

	app.post(`${base}/resume`, localOnly, async (c) => {
		await getManager().resume();
		return c.json({ ok: true, status: getManager().status() });
	});

	app.post(`${base}/idle`, localOnly, async (c) => {
		const body = await c.req.json<{ seconds?: number }>().catch(() => ({}) as { seconds?: number });
		const seconds = getManager().setIdleSeconds(Number(body.seconds ?? 0));
		return c.json({ ok: true, seconds, status: getManager().status() });
	});

	app.post(`${base}/update`, localOnly, async (c) => {
		const body = await c.req.json<{ acceptLicense?: string }>().catch(() => ({}) as { acceptLicense?: string });
		const m = getManager();
		const installOpts = { source: "download" as AsrInstallSource, acceptLicense: body.acceptLicense ?? null };
		const pre = m.precheck(installOpts);
		if (!pre.ok) return c.json({ ok: false, error: pre.error, status: m.status() }, 400);
		void m.install(installOpts).catch(() => {});
		return c.json({ ok: true, status: m.status() });
	});

	app.delete(base, localOnly, async (c) => {
		const body = await c.req.json<{ confirm?: boolean }>().catch(() => ({}) as { confirm?: boolean });
		if (!body.confirm) return c.json({ ok: false, error: "卸载需要显式确认", status: getManager().status() }, 400);
		try {
			await getManager().uninstall(true);
			return c.json({ ok: true, status: getManager().status() });
		} catch (e) {
			return c.json({ ok: false, error: msg(e), status: getManager().status() }, 400);
		}
	});

	app.post(`${base}/transcribe`, localOnly, async (c) => {
		const m = getManager();
		const st = m.status();
		if (st.runtime.state !== "running") return c.json({ ok: false, error: "本地 ASR 未运行，请先启动" }, 409);
		const endpoint = asrEndpoint(ASR_PROVIDER_ID, ASR_MODEL_ID) ?? asrEndpoint(ASR_PROVIDER_ID);
		if (!endpoint) return c.json({ ok: false, error: "本地 ASR 端点未注册" }, 409);
		try {
			const buf = new Uint8Array(await c.req.arrayBuffer());
			const result = await transcribeWav(m, endpoint, buf);
			return c.json({ ok: true, result });
		} catch (e) {
			const code = e instanceof WavRejectedError ? 400 : 502;
			return c.json({ ok: false, error: msg(e), problems: e instanceof WavRejectedError ? e.problems : undefined }, code);
		}
	});

	// ------------------------------------------------- 通用多模型（catalog + :id）

	const specOr404 = (c: Context, id: string | undefined) => {
		const spec = svc().spec(id ?? "");
		if (!spec) return { spec: null, res: c.json({ ok: false, error: `未知的本地 ASR 模型：${id}` }, 404) };
		return { spec, res: null };
	};

	app.get("/api/local-models/asr/catalog", localOnly, (c) => {
		const view = svc().catalog();
		// 顺带把每个模型的安全状态刷进本地模型 hints（重启后「已装未启动」也能出现）。
		for (const m of view.models) {
			const spec = svc().spec(m.id);
			if (spec) rememberLocalModelStatus(svc().managerFor(m.id).status(), spec.provider, spec.id, Date.now(), "asr");
		}
		return c.json(view);
	});

	app.get("/api/local-models/asr/models/:id/status", localOnly, (c) => {
		const { spec, res } = specOr404(c, c.req.param("id"));
		if (!spec) return res;
		const st = svc().managerFor(spec.id).status();
		rememberLocalModelStatus(st, spec.provider, spec.id, Date.now(), "asr");
		return c.json(st);
	});

	app.post("/api/local-models/asr/models/:id/install", localOnly, async (c) => {
		const { spec, res } = specOr404(c, c.req.param("id"));
		if (!spec) return res;
		const body = await c.req.json<InstallBody>().catch(() => ({}) as InstallBody);
		const installOpts = { source: body.source === "import" ? ("import" as const) : ("download" as const), acceptLicense: body.acceptLicense ?? null, importDir: body.importDir, intent: body.intent };
		const pre = svc().precheckInstall(spec.id, installOpts);
		if (!pre.ok) return c.json({ ok: false, error: pre.error, install: svc().catalog().models.find((m) => m.id === spec.id)?.install ?? null }, 400);
		void svc()
			.install(spec.id, installOpts)
			.catch(() => {});
		return c.json({ ok: true, install: svc().catalog().models.find((m) => m.id === spec.id)?.install ?? null });
	});

	app.post("/api/local-models/asr/models/:id/cancel", localOnly, (c) => {
		const { spec, res } = specOr404(c, c.req.param("id"));
		if (!spec) return res;
		return c.json({ ok: svc().cancel(spec.id).ok });
	});

	app.post("/api/local-models/asr/models/:id/select", localOnly, async (c) => {
		const { spec, res } = specOr404(c, c.req.param("id"));
		if (!spec) return res;
		try {
			await svc().select(spec.id);
			return c.json({ ok: true, status: svc().managerFor(spec.id).status() });
		} catch (e) {
			return c.json({ ok: false, error: msg(e), status: svc().managerFor(spec.id).status() }, 400);
		}
	});

	for (const action of ["start", "stop", "pause", "resume"] as const) {
		app.post(`/api/local-models/asr/models/:id/${action}`, localOnly, async (c) => {
			const { spec, res } = specOr404(c, c.req.param("id"));
			if (!spec) return res;
			try {
				const m = svc().managerFor(spec.id);
				if (action === "start") await m.start();
				else if (action === "stop") await m.stop("manual");
				else if (action === "pause") await m.pause();
				else await m.resume();
				return c.json({ ok: true, status: m.status() });
			} catch (e) {
				return c.json({ ok: false, error: msg(e), status: svc().managerFor(spec.id).status() }, 400);
			}
		});
	}

	app.post("/api/local-models/asr/models/:id/idle", localOnly, async (c) => {
		const { spec, res } = specOr404(c, c.req.param("id"));
		if (!spec) return res;
		const body = await c.req.json<{ seconds?: number }>().catch(() => ({}) as { seconds?: number });
		const seconds = svc().managerFor(spec.id).setIdleSeconds(Number(body.seconds ?? 0));
		return c.json({ ok: true, seconds, status: svc().managerFor(spec.id).status() });
	});

	app.post("/api/local-models/asr/models/:id/update", localOnly, async (c) => {
		const { spec, res } = specOr404(c, c.req.param("id"));
		if (!spec) return res;
		const body = await c.req.json<{ acceptLicense?: string }>().catch(() => ({}) as { acceptLicense?: string });
		const installOpts = { source: "download" as const, acceptLicense: body.acceptLicense ?? null };
		const pre = svc().precheckInstall(spec.id, installOpts);
		if (!pre.ok) return c.json({ ok: false, error: pre.error }, 400);
		void svc()
			.install(spec.id, installOpts)
			.catch(() => {});
		return c.json({ ok: true });
	});

	app.delete("/api/local-models/asr/models/:id", localOnly, async (c) => {
		const { spec, res } = specOr404(c, c.req.param("id"));
		if (!spec) return res;
		const body = await c.req.json<{ confirm?: boolean }>().catch(() => ({}) as { confirm?: boolean });
		if (!body.confirm) return c.json({ ok: false, error: "卸载需要显式确认" }, 400);
		try {
			await svc().uninstall(spec.id, true);
			return c.json({ ok: true });
		} catch (e) {
			return c.json({ ok: false, error: msg(e) }, 400);
		}
	});
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
