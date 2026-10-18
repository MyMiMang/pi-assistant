/**
 * run.mjs 的页面辅助：弹出菜单溢出检查、群聊输入 / 等待空闲 / 按成员取消息。
 */

/** 在浏览器里跑：菜单是否超出屏幕、内容是否超出菜单或溢出（返回最多 5 条问题） */
export const menuOverflowProblems = (el) => {
	const r = el.getBoundingClientRect();
	const bad = [];
	if (r.left < -0.5 || r.right > innerWidth + 0.5 || r.top < -0.5) bad.push(`菜单超出屏幕 ${Math.round(r.left)}–${Math.round(r.right)} / ${innerWidth}`);
	for (const c of el.querySelectorAll("*")) {
		const cr = c.getBoundingClientRect();
		if (!cr.width) continue;
		const clip = c.closest("[class*=overflow-],.truncate");
		if ((cr.right > r.right + 1 || cr.left < r.left - 1) && !(clip && clip !== c && el.contains(clip))) bad.push(`超出菜单：「${(c.textContent || "").trim().slice(0, 24)}」`);
		const cs = getComputedStyle(c);
		if (cs.overflowX === "visible" && c.clientWidth && c.scrollWidth > c.clientWidth + 1 && cs.display !== "inline") bad.push(`内容溢出：「${(c.textContent || "").trim().slice(0, 24)}」`);
	}
	return [...new Set(bad)].slice(0, 5);
};

/** 群聊：发一句（等输入框清空）、等全群空闲、取某个成员的消息 */
export function roomHelpers(page) {
	const roomSay = async (text) => {
		const box = page.getByTestId("room-input");
		await box.waitFor();
		await box.fill(text);
		await box.press("Enter");
		await page.waitForFunction(() => document.querySelector("[data-testid=room-input]")?.value === "", null, { timeout: 10_000 });
	};
	const roomIdle = () => page.waitForFunction(() => !document.querySelector("[data-testid=room-status]"), null, { timeout: 60_000 });
	const botsOf = (name) => page.locator(`[data-testid=room-bot][data-agent="${name}"]`);
	return { roomSay, roomIdle, botsOf };
}
