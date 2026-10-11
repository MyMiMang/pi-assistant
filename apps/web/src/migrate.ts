// 迁移旧版本的浏览器存储键（huhao.* → pia.*），保留已配对设备与外观设置
for (const k of ["conn", "theme", "accent", "lang"]) {
	const old = localStorage.getItem(`huhao.${k}`);
	if (old !== null && localStorage.getItem(`pia.${k}`) === null) localStorage.setItem(`pia.${k}`, old);
	localStorage.removeItem(`huhao.${k}`);
}
if (localStorage.getItem("pia.accent") === "#6366f1") localStorage.removeItem("pia.accent"); // 旧版默认强调色 → 改为跟随主题
