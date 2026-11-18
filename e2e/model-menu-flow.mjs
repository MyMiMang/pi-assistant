/**
 * 两层模型弹层的公共操作（e2e 脚本共用，不启动浏览器）。
 *
 * 聊天 / 输入栏入口：第一次点开的是**紧凑层**（当前档位 + 模型名 + Fast 闪电 + 滑块），
 * 点模型名才进完整目录（搜索 / 常用 / 服务分组）。管理型入口（设置 › 默认模型、组队成员编辑、
 * 子代理候选池）本来就是直接打开目录，不要用这里的 openModelMenu。
 *
 * 用法：
 *   const menu = await openModelMenu(page);              // 聊天输入栏 → 目录，返回 model-menu
 *   const compact = await openCompact(page);             // 只要紧凑层（Fast / 滑块 / 390 布局）
 *
 * 注意：这些脚本需要 Chrome；原生浏览器环境统一走 `e2e/fixtures/native-launch-env.mjs`（真实 HOME / TMPDIR），
 * 服务进程继续用临时数据目录，见 `e2e/fixtures/temp-server.mjs`。PIA_DATA_DIR + PIA_MOCK + PIA_OFFLINE，不碰真实数据 / 付费模型。
 */
export const COMPACT_TESTID = (testid) => `${testid}-compact`;

/** 隔离上个场景的右栏状态，记录同一视口下的聊天栏与输入区宽度。 */
export async function prepareModelPickerLayout(page, log) {
	const workspace = page.getByTestId("right-workspace");
	const collapse = workspace.getByTestId("workspace-collapse");
	const reopen = page.getByTestId("workspace-reopen");
	const wasDocked = await collapse.isVisible();
	if (wasDocked) await collapse.click();
	await workspace.waitFor({ state: "hidden" });
	const logWidths = async (state) => log("模型选择布局", state, page.viewportSize(), {
		chat: (await page.locator("main").boundingBox())?.width,
		composer: (await page.locator(".pa-composer").boundingBox())?.width,
		rail: (await workspace.boundingBox())?.width ?? 0,
	});
	return { workspace, collapse, reopen, wasDocked, logWidths };
}

/** 聊天工具栏回归：保持桌面视口，打开右栏让输入区进入紧凑布局。 */
export async function setHighWithDockedRail(page, { collapse, reopen, log, screenshot }) {
	await reopen.click();
	await collapse.waitFor();
	await page.waitForFunction(() => {
		const composer = document.querySelector(".pa-composer");
		return composer && composer.clientWidth <= 660;
	});
	await log("右栏打开");
	const compact = await openCompact(page);
	await compact.getByTestId("thinking-model").getByText(/Mock 推理模型/).waitFor();
	const level = compact.getByTestId("thinking-current");
	await level.getByText("中", { exact: true }).waitFor();
	await compact.getByTestId("thinking-high").click();
	// 选档后按设计关闭紧凑层；重新打开验证已选档位。
	await compact.waitFor({ state: "hidden" });
	await openCompact(page);
	await level.getByText("高", { exact: true }).waitFor();
	await page.screenshot({ path: screenshot });
	await closeModelPanel(page);
	await collapse.click();
}

/** 打开聊天输入栏的完整模型目录（先紧凑层，再点模型名）；返回 model-menu 的 locator */
export async function openModelMenu(page, { testid = "model-picker", menu = "model-menu" } = {}) {
	const compact = page.getByTestId(COMPACT_TESTID(testid));
	// 选完模型会回到紧凑层并**保持打开**（合同 §7）；这时再点触发器会把它关掉，所以只在都关着时才点
	if (!(await compact.count()) && !(await page.getByTestId(menu).count())) await page.getByTestId(testid).click();
	if (await compact.count()) await compact.getByTestId("thinking-model").click();
	await page.getByTestId(menu).waitFor();
	return page.getByTestId(menu);
}

/** 只打开紧凑层（不点模型名）；返回紧凑层的 locator */
export async function openCompact(page, { testid = "model-picker" } = {}) {
	await page.getByTestId(testid).click();
	const compact = page.getByTestId(COMPACT_TESTID(testid));
	await compact.waitFor();
	return compact;
}

/** 关掉当前弹层（Esc 在目录里先退一层 → 紧凑层 → 再关），确保下一次点开是从关闭状态开始 */
export async function closeModelPanel(page, { testid = "model-picker", menu = "model-menu" } = {}) {
	for (let i = 0; i < 3; i++) {
		if ((await page.getByTestId(menu).count()) === 0 && (await page.getByTestId(COMPACT_TESTID(testid)).count()) === 0) return;
		await page.keyboard.press("Escape");
		await page.waitForTimeout(80);
	}
}
