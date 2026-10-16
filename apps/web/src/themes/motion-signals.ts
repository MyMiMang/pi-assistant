/**
 * 主题动效信号（只读订阅）：主题 / DIY 预览改了 `--mo-style` 时回读一次。
 *
 * 为什么需要：`--mo-scale` / `--mo-glow` / `--mo-ease` / `--pa-dur-*` 都是 CSS 变量，主题一变自动生效；
 * 只有 `--mo-style`（`smooth` / `steps`）是枚举字符串，**不能**直接当缓动，必须由 JS 读出来映射成
 * 真实 data 属性（`data-pa-mo-style`）。如果只在挂载时读一次，切主题 / DIY 预览时弹层不重挂就会滞后。
 *
 * 为什么不用主题 store / 事件：DIY 预览在**同一个 custom id** 下只改临时 `<style>` 文本，
 * `data-skin` 与 store 都不变，只有 CSSOM 变了；现有代码也没有主题变更事件总线——不为此新建 store。
 *
 * 订阅范围有界（不是全页 MutationObserver、不轮询、不每帧读计算样式）：
 * - `<html>` 自身的 `data-skin` / `data-mode` / `class` / `style`（切主题、明暗、自选强调色）；
 * - `<head>` 里样式表的增删与文本变化（内置样式、`#pa-custom-themes`、`#pa-theme-preview`）。
 * 回调只在读到**不同的**值时触发（值没变不重渲染）；返回的函数断开订阅（弹层关闭 / 组件卸载时调用）。
 * `env` 可注入，便于不依赖浏览器的单测。
 */
export interface MoStyleEnv {
	documentElement: Element | null;
	head: Element | null;
	getStyle: ((el: Element) => CSSStyleDeclaration) | null;
	MutationObserver: typeof MutationObserver | null;
}

function browserEnv(): Partial<MoStyleEnv> {
	const doc = typeof document !== "undefined" ? document : null;
	return {
		documentElement: doc?.documentElement ?? null,
		head: doc?.head ?? null,
		getStyle: typeof getComputedStyle === "function" ? getComputedStyle : null,
		MutationObserver: typeof MutationObserver !== "undefined" ? MutationObserver : null,
	};
}

/** 读一次元素上的 `--mo-style`（去空白；空值 / 读不到 → null）。 */
export function readMoStyle(el: Element, env: Partial<MoStyleEnv> = browserEnv()): string | null {
	const g = env.getStyle ?? (typeof getComputedStyle === "function" ? getComputedStyle : null);
	if (!g) return null;
	return g(el).getPropertyValue("--mo-style").trim() || null;
}

/** 订阅主题动效信号：开始时先读一次，之后只在上面那两类 DOM 变化时回读；返回断开订阅的函数。 */
export function watchMoStyle(el: Element, onChange: (moStyle: string | null) => void, env: Partial<MoStyleEnv> = browserEnv()): () => void {
	let last = readMoStyle(el, env);
	onChange(last);
	const root = env.documentElement;
	const MO = env.MutationObserver ?? (typeof MutationObserver !== "undefined" ? MutationObserver : null);
	if (!root || !MO) return () => {};
	const read = () => {
		const next = readMoStyle(el, env);
		if (next === last) return;
		last = next;
		onChange(next);
	};
	const mo = new MO(read);
	mo.observe(root, { attributes: true, attributeFilter: ["data-skin", "data-mode", "class", "style"] });
	if (env.head) mo.observe(env.head, { childList: true, subtree: true, characterData: true });
	return () => mo.disconnect();
}
