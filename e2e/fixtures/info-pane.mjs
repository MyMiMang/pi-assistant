/**
 * 助理 / 群成员信息面板导航（e2e 共享）。
 *
 * 信息面板按功能分一级标签（概览/模型/资料/能力/任务/记忆/文件/电脑），
 * 「任务」里再分后台任务/定时任务/主动跟进。标签放不下时收进「更多」菜单，
 * 这些测试都通过同一个 helper 走真实界面（key 或中文名都行），避免各文件各写一套。
 */
export const INFO_TABS = {
	overview: "概览",
	models: "模型",
	profile: "资料",
	capabilities: "能力",
	tasks: "任务",
	memory: "记忆",
	files: "文件",
	computer: "电脑",
};

export const TASK_TABS = {
	background: "后台任务",
	routines: "定时任务",
	proactive: "主动跟进",
};

/** key 或中文名 → 稳定的 data-itab key */
function resolveKey(map, keyOrName) {
	if (map[keyOrName]) return keyOrName;
	const key = Object.keys(map).find((k) => map[k] === keyOrName);
	if (!key) throw new Error(`未知标签：${keyOrName}（可用：${Object.keys(map).join(" / ")} 或对应中文名）`);
	return key;
}

async function clickTab(page, testId, keyOrName, map) {
	const key = resolveKey(map, keyOrName);
	const direct = page.getByTestId(testId).locator(`[role=tab][data-itab="${key}"]`);
	if (await direct.count()) {
		await direct.first().click();
		return;
	}
	await page.getByTestId(`${testId}-more`).click();
	await page.getByTestId(`${testId}-menu`).locator(`[data-itab="${key}"]`).first().click();
}

/** 切一级标签；支持 key（models/profile/...）或中文名（模型/资料/...）。 */
export async function infoTab(page, keyOrName) {
	await clickTab(page, "info-tabs", keyOrName, INFO_TABS);
}

/** 切「任务」内的二级标签；会自动先进入一级「任务」页。 */
export async function taskTab(page, keyOrName) {
	if (!(await page.getByTestId("agent-task-tabs").count())) await infoTab(page, "tasks");
	await clickTab(page, "agent-task-tabs", keyOrName, TASK_TABS);
}
