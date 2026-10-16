/**
 * 本地 Laya 一键安装的进程内单例 + 事件推送。
 *
 * 只在真正用到时才构造（懒加载），避免测试 / 启动时触碰文件系统。
 * 下载 / 安装进度经 `local-laya/download.ts` 接入统一「下载与组件」面板（同一个 job，两个入口同状态）；
 * 安装入口统一走「电脑 › 操作这台电脑 → 本地快速操作模型（Laya）」或统一「下载与组件」页的同一条目。
 */
import { bus } from "../bus.ts";
import { createLayaDeps } from "./deps.ts";
import { LAYA_SOURCE } from "./manifest.ts";
import { LocalLayaManager } from "./manager.ts";

let manager: LocalLayaManager | null = null;

export function layaManager(): LocalLayaManager {
	if (!manager) {
		const m = new LocalLayaManager(createLayaDeps(), LAYA_SOURCE, () => {
			try {
				bus.emit({ type: "local-laya.changed", status: m.status() });
			} catch {
				/* 事件失败不影响状态 */
			}
		});
		manager = m;
	}
	return manager;
}

export { LAYA_PROVIDER_ID, LAYA_MODEL_ID, LAYA_BIND_HOST } from "./manager.ts";
export { LAYA_CHECKPOINTS, LAYA_SOURCE, DEFAULT_CHECKPOINT } from "./manifest.ts";
export type { LayaStatus } from "./manager.ts";
