/**
 * 本地 ASR **原生流式会话中枢**的生产装配（单例 + 目标解析）。
 *
 * 目标解析把「模型目录 / 安装态 / 运行中端点 / 租约」收在一处，注入 `LocalAsrStreamHub`（便于单测）：
 *  - 省略 modelId 时用 catalog 解析出的**默认本地流式模型**（不猜、不回落第一个本地模型）；
 *  - 模型必须 `streaming === true` 且有 adapter 能力，否则明确 `asr_not_ready`（不假装支持）；
 *  - 已安装但未运行 → 按需 `manager.start()`（复用现有 lazy 启动 / 退避 / 有界重试）；
 *  - 端点（含进程内 token）只从 `adapter-registry` 取，绝不外发；
 *  - 会话租约用 `manager.acquireStreamLease()`（会话期间 worker 不被 idle 卸载）。
 *
 * 来源版本由 voice 侧注入（避免 local-asr ↔ voice 循环依赖）；会话期间来源被改选 → 明确取消，不 fallback。
 */
import { asrEndpoint } from "./adapter-registry.ts";
import { asrModelSpec, resolveCatalogDefaultVoice } from "./catalog.ts";
import { localAsrService } from "./index.ts";
import { ASR_STREAM_ERRORS, AsrStreamError, LocalAsrStreamHub, type AsrStreamTarget } from "./stream.ts";

let hub: LocalAsrStreamHub | null = null;
let selectionVersionFn: () => number = () => 0;
let sourceReader: () => { location: string; provider: string; model: string } | null = () => null;

/** 由 http.ts 注入 voice 的来源版本读取（`readVoiceSourceVersion`）。 */
export function setAsrStreamSelectionVersion(fn: () => number): void {
	selectionVersionFn = fn;
}

/** 由 http.ts 注入当前来源读取（`readVoiceSource`）：省略 modelId 时优先用当前来源里的本地流式模型。 */
export function setAsrStreamSourceReader(fn: () => { location: string; provider: string; model: string } | null): void {
	sourceReader = fn;
}

/** 未就绪错误：`asr_not_ready` 的 body 带契约 `defaultVoice.prep` 结构（前端不依赖也必须真实）。 */
function notReady(message: string): AsrStreamError {
	let defaultVoice: unknown = null;
	try {
		defaultVoice = localAsrService().defaultVoicePrepView();
	} catch {
		/* 状态不可读时不编造结构 */
	}
	return new AsrStreamError(ASR_STREAM_ERRORS.notReady, 409, message, undefined, defaultVoice ? { defaultVoice } : undefined);
}

export function localAsrStreamHub(): LocalAsrStreamHub {
	if (!hub) {
		hub = new LocalAsrStreamHub({
			selectionVersion: () => selectionVersionFn(),
			now: () => Date.now(),
			setTimer: (fn, ms) => {
				const t = setTimeout(fn, ms);
				t.unref?.();
				return { cancel: () => clearTimeout(t) };
			},
			resolveTarget: async (modelId?: string) => {
				const resolved = resolveCatalogDefaultVoice();
				// 省略 modelId 时：优先当前来源里的本地流式模型；**来源已是其它模型（云 / 本地批量）就明确拒绝**，
				// 不用默认流式模型偷偷代替（不把用户已选的来源换成别的模型）。
				const current = sourceReader();
				if (!modelId && current) {
					const fromSource = current.location === "local" && asrModelSpec(current.model)?.streaming === true ? current.model : null;
					if (!fromSource) return { ok: false, error: notReady("当前语音识别来源不是原生流式模型（不支持边录边出字）") };
					modelId = fromSource;
				}
				const id = modelId ?? (resolved.ok ? resolved.id : null);
				if (!id) return { ok: false, error: notReady("没有可用的原生流式本地语音模型") };
				const spec = asrModelSpec(id);
				if (!spec || !spec.streaming || !spec.adapter) {
					return { ok: false, error: notReady("该模型不支持原生流式（只有本地流式听写支持）") };
				}
				const manager = localAsrService().managerFor(id);
				const st = manager.status();
				if (st.install.state !== "installed") {
					return { ok: false, error: notReady("本地流式模型尚未准备完成，请先完成首次准备") };
				}
				if (st.runtime.state !== "running" && st.runtime.state !== "starting") {
					try {
						await manager.start();
					} catch (e) {
						return { ok: false, error: notReady(`本地流式识别启动失败：${e instanceof Error ? e.message : String(e)}`) };
					}
				}
				const ep = asrEndpoint(spec.provider, spec.id);
				if (!ep) return { ok: false, error: notReady("本地流式识别端点未注册") };
				const target: AsrStreamTarget = {
					modelId: spec.id,
					provider: spec.provider,
					capability: spec.adapter,
					baseUrl: ep.baseUrl,
					token: ep.token,
					sampleRate: spec.manifest.sampleRate,
					lease: manager.acquireStreamLease(),
				};
				return { ok: true, target };
			},
		});
	}
	return hub;
}

export { ASR_STREAM_ERRORS, AsrStreamError } from "./stream.ts";
