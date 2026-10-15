import { migrateAppearance } from "./appearance-migration";

// 迁移旧版本的浏览器存储键（huhao.* → pia.*），保留已配对设备与外观设置
for (const k of ["conn", "theme", "accent", "lang"]) {
	const old = localStorage.getItem(`huhao.${k}`);
	if (old !== null && localStorage.getItem(`pia.${k}`) === null) localStorage.setItem(`pia.${k}`, old);
	localStorage.removeItem(`huhao.${k}`);
}

// 外观值迁移：旧默认强调色、已移除的极简主题 → 暗夜（见 appearance-migration.ts）。
migrateAppearance(localStorage);
