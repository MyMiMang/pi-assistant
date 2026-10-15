/**
 * 服务端侧的本地 ASR 调用（薄 adapter）：校验 WAV → 租约 → 调 loopback sidecar → 返回文本。
 *
 * 与 voice agent 的边界：**UI → Pi Server 的上传契约由语音输入主任务定**；这里只保证
 * 「服务端拿到一段 16k mono WAV 能转成文本」这一层，并把它做成可测的纯协议路径。
 *
 * 行为要点（用户要求逐条对应）：
 *  - 先用 `checkWav` 做**有界校验**（字节 / 时长 / 16k mono / 截断），不合格**不占用租约**、不重置 idle；
 *  - 用 `manager.beginInference()` 拿租约：**有活跃请求时 idle 定时器不会 kill**，新请求重置 idle 截止时间；
 *  - 明确超时（默认 60s）+ 可中止（租约 signal 与超时任一触发即中止）；
 *  - `usage.cost` 未知 → `null`（**不填 0**）；
 *  - 原始音频只在内存里，不落盘、不进日志。
 */
import type { AsrEndpoint, AsrResult, AsrSegment } from "./adapter.ts";
import type { LocalAsrManager } from "./manager.ts";
import { ASR_MAX_AUDIO_BYTES, ASR_MAX_AUDIO_SECONDS, SENSEVOICE_MODEL } from "./manifest.ts";
import { checkWav, type WavInfo } from "./wav.ts";

export interface TranscribeOptions {
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

export class WavRejectedError extends Error {
	problems: string[];
	constructor(problems: string[]) {
		super(`音频不符合要求：${problems.join("；")}`);
		this.problems = problems;
	}
}

/** 只做校验，便于上层在拿到音频时就先给用户明确错误。 */
export function validateWav(wav: Uint8Array): WavInfo {
	const res = checkWav(wav, {
		maxBytes: ASR_MAX_AUDIO_BYTES,
		maxSeconds: ASR_MAX_AUDIO_SECONDS,
		expectSampleRate: SENSEVOICE_MODEL.sampleRate,
		expectChannels: SENSEVOICE_MODEL.channels,
	});
	if (!res.ok || !res.info) throw new WavRejectedError(res.problems);
	return res.info;
}

/** 调用运行中的本地 ASR 端点转写一段 WAV。调用方负责保证端点来自 `asrEndpoint()`（服务端内部）。 */
export async function transcribeWav(manager: LocalAsrManager, endpoint: AsrEndpoint, wav: Uint8Array, opts: TranscribeOptions = {}): Promise<AsrResult> {
	const info = validateWav(wav); // 先校验：不合格不占租约
	const lease = manager.beginInference();
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
	const onLeaseAbort = () => ctrl.abort(new Error("cancelled"));
	lease.signal.addEventListener("abort", onLeaseAbort, { once: true });
	try {
		const fetchImpl = opts.fetchImpl ?? fetch;
		const res = await fetchImpl(`${endpoint.baseUrl}audio/transcriptions`, {
			method: "POST",
			headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "audio/wav" },
			body: wav as unknown as BodyInit,
			signal: ctrl.signal,
		});
		if (!res.ok) throw new Error(`本地 ASR 返回 ${res.status}`);
		const j = (await res.json()) as { text?: unknown; language?: unknown; segments?: unknown; audioSeconds?: unknown };
		const segments: AsrSegment[] = Array.isArray(j.segments)
			? (j.segments as Record<string, unknown>[]).map((s) => ({ start: Number(s.start ?? 0), end: Number(s.end ?? 0), text: String(s.text ?? "") }))
			: [];
		return {
			text: typeof j.text === "string" ? j.text : "",
			language: typeof j.language === "string" ? j.language : null,
			segments,
			usage: { audioSeconds: typeof j.audioSeconds === "number" ? j.audioSeconds : info.seconds, cost: null },
		};
	} catch (e) {
		if (lease.signal.aborted) throw new Error("本地 ASR 已中止（进程停止或已释放）");
		if (ctrl.signal.aborted) throw new Error("本地 ASR 超时或已取消");
		throw e;
	} finally {
		clearTimeout(timer);
		lease.signal.removeEventListener("abort", onLeaseAbort);
		lease.end();
	}
}
