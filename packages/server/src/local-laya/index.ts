/**
 * **非产品 / 已撤下接入（2026-10-18，beta.30 候选起）**：本模块只服务电脑快速候选选择器，
 * 现已无任何产品入口（不挂路由、不登记下载、不注册 classifier、不自动启动）。
 * 源码与测试保留，用户已安装的 venv / 权重 / 数据目录与在跑的生产进程不动。
 *
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
