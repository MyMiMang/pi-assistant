/**
 * 本地 SenseVoice ASR 的进程内单例 + 事件推送（懒加载，避免测试 / 启动时碰文件系统）。
 *
 * 与 local-laya 的分工：本模块**不注册 chat / classifier**（用户要求不伪造成 chat/classifier）；
 * 运行中的端点只进 `adapter-registry`（server 内部，含进程内 token），统一注册表里以
 * `type:"asr"` 的卡片出现（安全元数据经 `local-asr.changed` → local-models.ts 缓存）。
 */
import { bus } from "../bus.ts";
import { ASR_PROTOCOL } from "./adapter.ts";
import { createAsrDeps } from "./deps.ts";
import { ASR_MODEL_ID, ASR_PROVIDER_ID, SENSEVOICE_LICENSE, SENSEVOICE_MODEL, SENSEVOICE_SOURCE } from "./manifest.ts";
import { LocalAsrManager } from "./manager.ts";

let manager: LocalAsrManager | null = null;

export function asrManager(): LocalAsrManager {
	if (!manager) {
		const m = new LocalAsrManager(
			createAsrDeps(),
			{
				source: SENSEVOICE_SOURCE,
				license: SENSEVOICE_LICENSE,
				model: SENSEVOICE_MODEL,
				ids: { provider: ASR_PROVIDER_ID, modelId: ASR_MODEL_ID, protocol: ASR_PROTOCOL },
			},
			() => {
				try {
					bus.emit({ type: "local-asr.changed", status: m.status() });
				} catch {
					/* 事件失败不影响状态 */
				}
			},
		);
		manager = m;
	}
	return manager;
}

export { ASR_BIND_HOST, ASR_MODEL_ID, ASR_PROVIDER_ID, SENSEVOICE_LICENSE, SENSEVOICE_MODEL, SENSEVOICE_SOURCE } from "./manifest.ts";
export { ASR_PROTOCOL } from "./adapter.ts";
export type { AsrStatus } from "./manager.ts";
