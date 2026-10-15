/**
 * 本地 Laya 一键安装的进程内单例 + 事件推送。
 *
 * 只在真正用到时才构造（懒加载），避免测试 / 启动时触碰文件系统。
 * 说明：不进统一下载面板（`registerDownload`）——本模块有自己的分阶段状态接口（`/status` 的
 * install.phase/received/error），而统一下载面板只能显示 trackDownload 驱动的进度，容易误报「未下载」。
 * 安装入口统一走「模型服务 → 本地 Laya」页的按钮。
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
