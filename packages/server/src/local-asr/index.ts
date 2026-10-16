/**
 * 本地 ASR 的进程内单例：多模型协调器（懒加载，避免测试 / 启动时碰文件系统）。
 *
 * 与 local-laya 的分工：本模块**不注册 chat / classifier**（用户要求不伪造成 chat/classifier）；
 * 运行中的端点只进 `adapter-registry`（server 内部，含进程内 token），统一注册表里以
 * `type:"asr"` 的卡片出现（安全元数据经 `local-asr.changed` → local-models.ts 缓存）。
 */
import { arch, cpus, platform, totalmem } from "node:os";
import { bus } from "../bus.ts";
import { ASR_PROTOCOL } from "./adapter.ts";
import { ASR_CATALOG, type AsrModelSpec } from "./catalog.ts";
import { createAsrDeps } from "./deps.ts";
import { ASR_MODEL_ID, ASR_PROVIDER_ID, SENSEVOICE_LICENSE, SENSEVOICE_MODEL, SENSEVOICE_SOURCE } from "./manifest.ts";
import { LocalAsrManager, type AsrStatus } from "./manager.ts";
import { LocalAsrService, type AsrSelectionPort } from "./service.ts";

function emit(spec: AsrModelSpec, status: AsrStatus): void {
	try {
		bus.emit({ type: "local-asr.changed", status, provider: spec.provider, modelId: spec.id, label: spec.name });
	} catch {
		/* 事件失败不影响状态 */
	}
}

let service: LocalAsrService | null = null;

export function localAsrService(): LocalAsrService {
	if (!service) {
		const deps = createAsrDeps();
		service = new LocalAsrService({
			createManager: (spec) => {
				let mgr: LocalAsrManager;
				mgr = new LocalAsrManager(
					deps,
					{ source: spec.source, license: spec.license, model: spec.manifest, ids: { provider: spec.provider, modelId: spec.id, protocol: ASR_PROTOCOL } },
					() => emit(spec, mgr.status()),
				);
				return mgr;
			},
			// 默认空端口；生产在 http.ts 注入 voice 的来源读写（避免循环依赖）。
			selection: { read: () => null, write: () => {} },
			onChange: (spec, status) => emit(spec, status),
			hardware: () => ({ os: platform(), arch: arch(), cpuCores: cpus().length, memoryBytes: totalmem() }),
		});
	}
	return service;
}

/** 由 http.ts 装配来源读写端口（PUT /api/audio/asr/source 仍是唯一来源真相）。 */
export function setAsrSelectionPort(port: AsrSelectionPort): void {
	localAsrService().setSelectionPort(port);
}

/** 兼容旧调用：SenseVoice 的 manager。 */
export function asrManager(): LocalAsrManager {
	return localAsrService().legacyManager();
}

export { ASR_BIND_HOST, ASR_MODEL_ID, ASR_PROVIDER_ID, SENSEVOICE_LICENSE, SENSEVOICE_MODEL, SENSEVOICE_SOURCE } from "./manifest.ts";
export { ASR_PROTOCOL } from "./adapter.ts";
export { ASR_CATALOG } from "./catalog.ts";
export type { AsrStatus } from "./manager.ts";
export type { LocalAsrService, AsrSelectionPort } from "./service.ts";
export type { AsrModelSpec } from "./catalog.ts";
