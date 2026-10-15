/**
 * 本地 Laya 一键安装的进程内单例 + 统一下载登记 + 事件推送。
 *
 * 只在真正用到时才构造（懒加载），避免测试 / 启动时触碰文件系统。
 */
import { bus } from "../bus.ts";
import { registerDownload } from "../downloads.ts";
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
		// 统一下载面板也能看到「本地 Laya」条目（阶段 / 字节 / 出错都来自状态机）。
		registerDownload({
			id: "local-laya",
			name: "本地 Laya（判断模型）",
			group: "模型服务",
			size: 700_000_000,
			installed: () => m.status().install.state === "installed",
		});
	}
	return manager;
}

export { LAYA_PROVIDER_ID, LAYA_MODEL_ID, LAYA_BIND_HOST } from "./manager.ts";
export { LAYA_CHECKPOINTS, LAYA_SOURCE, DEFAULT_CHECKPOINT } from "./manifest.ts";
export type { LayaStatus } from "./manager.ts";
