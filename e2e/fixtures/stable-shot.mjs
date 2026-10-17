/**
 * 截图前等界面**真的稳定**：弹层可见、有限动画播完、computed opacity / visibility 正常、
 * 连续几帧 boundingBox 不变。
 *
 * 为什么要有这一层：之前直接在 `openCompact()` / `hover()` 之后截图，拍到的可能是进入动画
 * 的 `opacity: 0` 第一帧（看起来「完全没有弹层」）或半透明中途（文字和底部输入栏叠在一起）。
 * 这里**不禁用动画**、也不强制 reduced-motion —— 那只会把动画期间的真实问题藏起来；
 * 只等它自然播完，再用真实的 computed 样式和几何确认稳定。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 `locator` 可见、有限动画结束、自身及祖先 opacity=1 / visibility=visible、连续 frames 帧位置不变。 */
export async function waitStable(page, locator, { frames = 4, timeout = 6000 } = {}) {
	await locator.waitFor({ state: "visible", timeout });
	await page.evaluate(() => document.fonts?.ready ?? Promise.resolve());
	// 只等有限动画（spinner 这类无限动画跳过）；超时也继续，后面还有 computed / 几何两道硬校验
	await page.evaluate(async () => {
		const finite = document.getAnimations().filter((a) => {
			try {
				const t = a.effect?.getComputedTiming?.();
				return !!t && Number.isFinite(t.endTime);
			} catch {
				return false;
			}
		});
		await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]);
	});
	// 自身和祖先都不能还在透明 / 隐藏状态（portal 弹层通常在 body 下）
	const styleOk = await locator.evaluate((el) => {
		const ok = (n) => {
			if (!n) return true;
			const s = getComputedStyle(n);
			return s.display !== "none" && s.visibility === "visible" && Number(s.opacity) >= 0.999;
		};
		let n = el;
		while (n && n !== document.body) {
			if (!ok(n)) return false;
			n = n.parentElement;
		}
		return true;
	});
	if (!styleOk) throw new Error("等稳定失败：弹层自身或祖先仍是透明 / 隐藏（动画没播完或样式真的有问题）");
	let prev = null;
	let same = 0;
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const box = await locator.boundingBox();
		if (!box) throw new Error("等稳定失败：拿不到 boundingBox");
		if (prev && ["x", "y", "width", "height"].every((k) => Math.abs(prev[k] - box[k]) < 0.5)) same++;
		else same = 0;
		prev = box;
		if (same >= frames) return box;
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
		await sleep(16);
	}
	throw new Error(`等稳定失败：${timeout}ms 内 boundingBox 一直在变`);
}

/** `waitStable` 之后截图（普通整页截图，不裁剪、不加遮罩）。 */
export async function stableShot(page, locator, path, opts) {
	const box = await waitStable(page, locator, opts);
	await page.screenshot({ path });
	return box;
}
