import { REMOVED_SKINS } from "./themes/registry.ts";

/** 外观存储的最小接口（localStorage 子集，可注入假实现方便单测）。 */
export interface AppearanceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/**
 * 外观相关的存储值迁移（纯函数，不碰 DOM，storage 可注入）：
 *  1. 旧版默认强调色 `#6366f1` → 删掉，改为跟随主题默认色。
 *  2. 已移除的内置主题 id（极简 `linear`）→ 当前默认主题（暗夜）；其他显式选择一律不动。
 * 返回值说明改了什么，便于调用方与测试核对。
 */
export function migrateAppearance(storage: AppearanceStorage): { accentRemoved: boolean; skinMigrated: string | null } {
	let accentRemoved = false;
	if (storage.getItem("pia.accent") === "#6366f1") {
		storage.removeItem("pia.accent");
		accentRemoved = true;
	}
	const skin = storage.getItem("pia.skin");
	const target = skin ? REMOVED_SKINS[skin] : undefined;
	if (target) storage.setItem("pia.skin", target);
	return { accentRemoved, skinMigrated: target ?? null };
}
