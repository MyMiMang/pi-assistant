/*
 * 首屏主题预置：阻塞式同步执行，在样式与 React 之前把
 * <html data-skin data-mode class="dark"> 和 <meta name="theme-color"> 设成上次的选择，
 * 避免默认暗夜在启动瞬间先闪一下亮白（CSP 是 script-src 'self'，所以只能放外部文件，不能内联）。
 *
 * 下面 DATA 里的常量必须与 apps/web/src/themes/registry.ts 保持一致：
 * packages/server/test/appearance-theme.test.ts 会读取本文件逐项校验，改主题时两边一起改。
 */
(function () {
	try {
		var DATA = { "default": "noir", "legacy": { "linear": "noir" }, "themes": { "noir": { "mode": "dark", "light": "#f4f4f6", "dark": "#09090b" }, "glass": { "light": "#eef1f8", "dark": "#0b0d1a" }, "warm": { "light": "#f7f3ea", "dark": "#1c1915" }, "pixel": { "light": "#fbf7ef", "dark": "#181524" } } };
		var store = window.localStorage;
		var skin = store.getItem("pia.skin") || "";
		skin = DATA.legacy[skin] || skin;
		var t = DATA.themes[skin];
		// 自定义主题（DIY）的 token 由主脚本注入；这里保留选择，不回退到暗夜（避免闪一下）。
		var custom = !t && skin.indexOf("custom-") === 0;
		if (!t && !custom) {
			skin = DATA.default;
			t = DATA.themes[skin];
		}
		var theme = store.getItem("pia.theme") || (t && t.mode) || "system";
		var dark = theme === "dark" || (theme === "system" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
		var el = document.documentElement;
		el.dataset.skin = skin;
		el.dataset.mode = dark ? "dark" : "light";
		el.classList.toggle("dark", dark);
		var meta = document.querySelector('meta[name="theme-color"]');
		if (meta && t) meta.setAttribute("content", dark ? t.dark : t.light);
	} catch (e) {
		/* 存储被禁用等极端情况：交给主脚本 applyTheme 兜底 */
	}
})();
