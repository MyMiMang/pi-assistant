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

/** 设置 › 语音 › 本地：等本地模型区出现（先选再装后不再折叠；没装时选择器在上方模块卡里）。 */
export async function openLocalAsrModels(page, timeout = 20_000) {
	await page.getByTestId("local-asr-models").waitFor({ timeout });
}

/** 本地语音选模型：没装时在模块卡的选择器里选（先选再装），装过 / 旧后端时在模型卡的下拉里选。 */
export async function pickLocalAsrModel(page, name) {
	const chooser = page.getByTestId("default-voice-model-select");
	const id = (await chooser.isVisible()) ? "default-voice-model-select" : "local-asr-model-select";
	await page.getByTestId(id).click();
	await page.getByTestId(`${id}-menu`).getByRole("option", { name }).click();
}

/** 当前可用的「安装」按钮：先选再装阶段是模块卡的「安装所选模型」，否则是模型卡的「安装并使用」。 */
export async function localAsrInstallButton(page) {
	const chooser = page.getByTestId("default-voice-prep-install");
	return (await chooser.isVisible()) ? chooser : page.getByTestId("local-asr-install-use");
}

/**
 * 决策 0029（Mock 群「三人组」，A 管理者、B 成员）：B 每次都把图表发进群（有进展），到每人次数上限也不暂停，一直跑到派活层数上限；
 * 之后管理者被兜底叫醒收尾，没有新进展只提示一次（room-idle）。`waitFor` 是 run.mjs 的轮询函数。
 */
export async function roomProgressNoPause({ roomSay, base, room, waitFor }) {
	const list = async () => await (await fetch(`${base}/api/rooms/${room}/messages`)).json();
	const seen = new Set((await list()).map((m) => m.id));
	await roomSay("循环 派给B 做个图表");
	const fresh = async () => (await list()).filter((m) => !seen.has(m.id));
	await waitFor(async () => (await fresh()).some((m) => m.meta?.kind === "room-idle"), 120_000);
	const after = await fresh();
	const paused = after.some((m) => m.meta?.kind === "room-paused");
	const charts = after.filter((m) => m.meta?.attachments?.some((a) => a.name === "chart.svg")).length;
	if (paused || charts < 3) throw new Error(`有进展时不该暂停、B 应交了 3 次以上图表：暂停 ${paused}，图表 ${charts}`);
}
