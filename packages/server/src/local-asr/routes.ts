/**
 * 本地 SenseVoice ASR 的路由契约。
 *
 * 前缀 `/api/local-models/asr/sensevoice`，全部 `localOnly`（仅本机回环）；安装 / 启动由**显式按钮**触发。
 * 契约要点（用户要求）：
 *  - 许可限制必须**默认可见**：`/source` 返回完整条款链接 + 限制摘要 + `acceptValue`；`install` 必须带
 *    `acceptLicense`（等于 `acceptValue`），且**安装入口在许可未确认时默认关闭**（`/status` 里 `license.decision`）；
 *  - `install` 支持 `source: "import"`（用户自行导入合法取得的权重，canonical 校验在 deps 内做）；
 *  - 生命周期：install / cancel / start / stop / pause / resume / idle / update / DELETE(confirm)；
 *  - 不暴露任何 token：`/status` 只有 `registered` 的 provider / model / protocol。
 *
 * ⚠️ UI → Server 的上传契约（multipart 字段名 / 返回结构）由语音输入主任务（voice agent）最终确定；
 * 这里给出的是**后端先行的最小契约**，字段名可随主契约调整。
 */
import type { Context, Hono, Next } from "hono";
import { asrManager } from "./index.ts";
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
}

export function mountLocalAsrRoutes(app: Hono<any>, localOnly: LocalOnly, getManager: () => LocalAsrManager = asrManager) {
	const base = "/api/local-models/asr/sensevoice";

	// 读状态时顺带把安全元数据刷新进本地模型 hints：重启后「已安装但从未启动」也能在注册表里出现。
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

	// 来源 + 许可（条款正文与限制摘要必须默认可见，不做「一次点击遮盖」）。
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
		const opts = { source, acceptLicense: body.acceptLicense ?? null, importDir: body.importDir };
		// 同步预检决定 HTTP 状态码（异步 install 的抛错会变成 rejected promise，不能用来选状态码）
		const pre = m.precheck(opts);
		if (!pre.ok) return c.json({ ok: false, error: pre.error, status: m.status() }, 400);
		void m.install(opts).catch(() => {});
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

	// 空闲 TTL：0 = 每次推理后立即释放（只释放进程，磁盘权重保留）。
	app.post(`${base}/idle`, localOnly, async (c) => {
		const body = await c.req.json<{ seconds?: number }>().catch(() => ({}) as { seconds?: number });
		const seconds = getManager().setIdleSeconds(Number(body.seconds ?? 0));
		return c.json({ ok: true, seconds, status: getManager().status() });
	});

	app.post(`${base}/update`, localOnly, async (c) => {
		const body = await c.req.json<{ acceptLicense?: string }>().catch(() => ({}) as { acceptLicense?: string });
		const m = getManager();
		const opts = { source: "download" as AsrInstallSource, acceptLicense: body.acceptLicense ?? null };
		const pre = m.precheck(opts);
		if (!pre.ok) return c.json({ ok: false, error: pre.error, status: m.status() }, 400);
		void m.install(opts).catch(() => {});
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

	// 转写（后端先行契约）：raw body = 16k mono 16bit WAV。仅本机回环；音频只在内存里。
	app.post(`${base}/transcribe`, localOnly, async (c) => {
		const m = getManager();
		const st = m.status();
		if (st.runtime.state !== "running") return c.json({ ok: false, error: "本地 ASR 未运行，请先启动" }, 409);
		const endpoint = asrEndpoint(ASR_PROVIDER_ID);
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
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
