/**
 * 助理 / 群成员信息面板导航（e2e 共享）。
 *
 * 信息面板按功能分一级标签（概览/模型/资料/能力/任务/记忆/文件/电脑），
 * 「任务」里再分执行记录/定时任务/主动跟进。标签放不下时收进「更多」菜单，
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
	background: "执行记录",
	routines: "定时任务",
	proactive: "主动跟进",
};

/** 二级标签的旧名 / 候选新名，只做名称解析，不再另写一套标签选择。 */
export const TASK_TAB_ALIASES = { background: ["执行记录", "后台任务"] };

/** key 或中文名 → 稳定的 data-itab key */
function resolveKey(map, keyOrName, aliases = {}) {
	if (map[keyOrName]) return keyOrName;
	const key = Object.keys(map).find((k) => map[k] === keyOrName);
	if (key) return key;
	const aliasKey = Object.keys(aliases).find((k) => aliases[k].includes(keyOrName));
	if (!aliasKey) throw new Error(`未知标签：${keyOrName}（可用：${Object.keys(map).join(" / ")} 或对应中文名）`);
	return aliasKey;
}

async function clickTab(page, testId, keyOrName, map, aliases) {
	const key = resolveKey(map, keyOrName, aliases);
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
	await clickTab(page, "agent-task-tabs", keyOrName, TASK_TABS, TASK_TAB_ALIASES);
}

/**
 * 助理「模型」页里的折叠区块（原生 `<details>`）。
 * 画图 / 子代理分工默认折叠，只有真正要编辑或断言可见时才展开；默认折叠本身也在
 * `agent-details-functional-ui.mjs` 里单独验证，**不要**在这里顺手展开。
 */
export const MODEL_SECTIONS = {
	image: { details: "agent-image-details", content: "agent-image-model", title: "画图模型" },
	subagents: { details: "agent-subagent-details", content: "agent-subagent-model", title: "高级 · 子代理" },
};

/** 按 testid 展开一个原生 `<details>`：真实点 summary，已展开就跳过；结构缺失应直接报错。 */
export async function expandDetails(scope, testId, { timeout = 5000 } = {}) {
	const details = scope.getByTestId(testId).first();
	await details.waitFor({ state: "visible", timeout });
	if (!(await details.evaluate((el) => el.open === true))) {
		await details.locator(":scope > summary").click();
		await details.evaluate((el, { ms, id }) => new Promise((resolve, reject) => {
			const end = Date.now() + ms;
			const tick = () => (el.open ? resolve(true) : Date.now() > end ? reject(new Error(`details 没展开：${id}`)) : setTimeout(tick, 40));
			tick();
		}), { ms: timeout, id: testId });
	}
	return true;
}

/**
 * 展开「模型」页的折叠区块：image = 画图，subagents = 子代理分工。
 * 用真实 summary 点击（不是 JS 改 `open`），已展开就不重复点。
 * 折叠区块缺失或展开失败会报错，不能把旧的直接展开结构误当成本次布局通过。
 */
export async function expandAgentModelSection(page, key, { timeout = 10000 } = {}) {
	const spec = MODEL_SECTIONS[key];
	if (!spec) throw new Error(`未知模型区块：${key}（可用：${Object.keys(MODEL_SECTIONS).join(" / ")}）`);
	const hasDetails = await expandDetails(page, spec.details, { timeout });
	await page.getByTestId(spec.content).first().waitFor({ state: "visible", timeout });
	return hasDetails;
}

/** 目标被折叠的原生 details 挡住时，真实点开未展开的 summary 直到它可见（不改 `open` 属性）。 */
export async function ensureDetailVisible(scope, target, { maxTries = 6 } = {}) {
	if (await target.first().isVisible().catch(() => false)) return true;
	for (let i = 0; i < maxTries; i++) {
		const closed = scope.locator("details:not([open]) > summary");
		if (!(await closed.count())) break;
		await closed.first().click().catch(() => {});
		if (await target.first().isVisible().catch(() => false)) return true;
	}
	return target.first().isVisible().catch(() => false);
}

/** 资料页的人设输入框：按现有 placeholder 精确取（简介改成 textarea 后也不会串到人设）。 */
export const PERSONA_PLACEHOLDER = "例如：回答要简洁；称呼我 deng；改代码前先说明计划";
export const BIO_PLACEHOLDER = "一句话介绍（显示在侧边栏和概览里）";

/** 只定位资料页固定保存按钮；创建/其他设置的保存按钮不混进这个入口。 */
export function agentProfileSave(scope) {
	return scope.getByTestId("agent-profile-save");
}

/** 「模型」页的聊天模型按钮：与输入框下面是同一个 ModelPicker（只在模型页里取，不和输入框那颗混）。 */
/**
 * 「模型」页当前值：地方够时是就地面板里的读屏摘要（model-picker-summary，文字与按钮同一份），
 * 窄 / 矮时是输入框同款按钮（model-picker）。读 innerText 判断当前模型 / 档位两种形态都适用。
 */
export const agentModelButton = (page) => page.getByTestId("agent-models-tab").getByTestId(/^model-picker(-summary)?$/);

/**
 * 拿到「模型」页的思考 / Fast / 模型目录（thinking-*、thinking-fast、thinking-follow、model-menu）：
 * 就地面板直接返回它；按钮形态就打开紧凑层（已开直接返回）。
 */
export async function openAgentModelPop(page) {
	const tab = page.getByTestId("agent-models-tab");
	await tab.getByTestId("agent-model-settings").waitFor();
	const inline = tab.getByTestId("model-picker-inline");
	if (await inline.count()) return inline;
	const pop = page.getByTestId("model-picker-compact");
	if (!(await pop.count())) await tab.getByTestId("model-picker").click();
	await pop.waitFor();
	return pop;
}
