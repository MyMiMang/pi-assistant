/**
 * file-preview.mjs 的「文件预览侧栏」段：桌面宽窗口里预览在聊天右边（不是弹窗），窄窗口 / 手机仍是弹窗。
 * 设计见 docs/design/file-preview-side-panel.md。
 */
export async function runSidePanelSection({ browser, base, installRoutes, check, OUT, join }) {
	console.log("\n── 文件预览侧栏 ──");
	const state = { fileHits: [], remoteHits: [] };
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true });
	await installRoutes(ctx, state);
	await ctx.addInitScript(() => { try { if (!localStorage.getItem("pia.skin")) { localStorage.setItem("pia.skin", "noir"); localStorage.setItem("pia.theme", "dark"); } } catch {} });
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await page.goto(`${base}/?agent=a1`);
	await page.locator('[data-testid="file-attachment"]').first().waitFor({ timeout: 20_000 });
	const box = (sel) => page.locator(sel).first().boundingBox();
	const panelOpen = () => page.locator("[data-testid=file-preview][data-docked]").count();
	const openCard = (name) => page.locator(`[aria-label="预览 ${name}"]`).click();
	const closeBtn = async () => {
		await page.locator("[data-testid=file-preview-close]").click();
		await page.locator("[data-testid=file-preview]").waitFor({ state: "detached", timeout: 5000 });
	};

	// 先把信息面板打开，验证侧栏让位 / 恢复
	await page.getByRole("button", { name: "信息面板", exact: true }).click();
	await page.getByTestId("info-tabs").waitFor({ timeout: 10_000 });

	await openCard("voice-input-feasibility.md");
	await page.locator("[data-testid=file-preview-markdown]").waitFor({ timeout: 10_000 });
	check("[侧栏] 宽窗口点文件：显示在聊天右边的侧栏（不是弹窗）", (await panelOpen()) === 1 && (await page.locator(".pa-modal").count()) === 0);
	const pb = await box("[data-testid=file-preview]");
	const cb = await box("[data-testid=main-conversation]");
	check("[侧栏] 侧栏在聊天区右边、贴右缘", pb && cb && pb.x >= cb.x + cb.width - 2 && near(pb.x + pb.width, 1440, 3), JSON.stringify({ pb, cb }));
	check("[侧栏] 聊天区仍可见且宽度 ≥ 520", cb && cb.width >= 520 && (await page.locator("[data-testid=main-conversation]").isVisible()), JSON.stringify(cb));
	check("[侧栏] 默认宽度约 560", pb && near(pb.width, 560, 3), String(pb?.width));
	check("[侧栏] 信息面板让位（不同时显示）", !(await page.getByTestId("info-tabs").isVisible()));
	check("[侧栏] 工具栏有文件名 / 下载 / 放大 / 关闭", (await page.locator("[data-testid=file-preview-name]").textContent())?.includes("voice-input-feasibility.md") && (await page.locator("[data-testid=file-preview-download]").isVisible()) && (await page.locator("[data-testid=file-preview-expand]").isVisible()) && (await page.locator("[data-testid=file-preview-close]").isVisible()));
	await page.screenshot({ path: join(OUT, "side-panel-noir-dark.png") });

	// 拖动调宽 / 双击恢复默认 / 偏好按设备记住
	const rz = await box("[role=separator][aria-label=调整侧栏宽度]");
	await page.mouse.move(rz.x + rz.width / 2, 400);
	await page.mouse.down();
	await page.mouse.move(rz.x + rz.width / 2 - 60, 400, { steps: 6 });
	await page.mouse.up();
	const wide = await box("[data-testid=file-preview]");
	check("[侧栏] 拖动手柄调宽生效", wide && near(wide.width, 620, 6), String(wide?.width));
	check("[侧栏] 宽度偏好存进本机", (await page.evaluate(() => JSON.parse(localStorage.getItem("pia.layout") ?? "{}").previewW)) === Math.round(wide.width));
	await page.locator("[role=separator][aria-label=调整侧栏宽度]").dblclick();
	check("[侧栏] 双击手柄恢复默认宽度", near((await box("[data-testid=file-preview]")).width, 560, 3));

	// 换文件：直接换内容
	await openCard("data.csv");
	await page.locator("[data-testid=file-preview-csv]").waitFor({ timeout: 10_000 });
	check("[侧栏] 开着时点另一个文件：直接换内容（仍是侧栏）", (await panelOpen()) === 1 && (await page.locator("[data-testid=file-preview-name]").textContent())?.includes("data.csv") && (await page.locator("[data-testid=file-preview-markdown]").count()) === 0);

	// 放大 → 弹窗；Esc 关闭
	await page.locator("[data-testid=file-preview-expand]").click();
	await page.locator(".pa-modal [data-testid=file-preview-csv]").waitFor({ timeout: 10_000 });
	check("[侧栏] 「放大」打开成大弹窗（侧栏收起）", (await panelOpen()) === 0 && (await page.locator(".pa-modal").count()) === 1 && (await page.locator("[data-testid=file-preview-expand]").count()) === 0);
	await page.keyboard.press("Escape");
	await page.locator("[data-testid=file-preview]").waitFor({ state: "detached", timeout: 5000 });
	check("[侧栏] 弹窗里 Esc 关闭", true);
	check("[侧栏] 关掉预览后信息面板按原状态回来", await page.getByTestId("info-tabs").isVisible());

	// × 关闭
	await openCard("config.json");
	await page.locator("[data-testid=file-preview-code]").waitFor({ timeout: 10_000 });
	check("[侧栏] 再点文件又出现侧栏", (await panelOpen()) === 1);
	await closeBtn();
	check("[侧栏] × 关闭侧栏", (await panelOpen()) === 0);

	// Esc：输入框里不关，别处才关
	await openCard("config.json");
	await page.locator("[data-testid=file-preview-code]").waitFor({ timeout: 10_000 });
	await page.locator("textarea").first().click();
	await page.keyboard.type("你好");
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	check("[侧栏] 在输入框里打字时 Esc 不关侧栏，输入内容还在", (await panelOpen()) === 1 && (await page.locator("textarea").first().inputValue()) === "你好");
	await page.locator("textarea").first().fill("");
	await page.locator("[data-testid=file-preview-name]").click();
	await page.keyboard.press("Escape");
	await page.locator("[data-testid=file-preview]").waitFor({ state: "detached", timeout: 5000 });
	check("[侧栏] 焦点不在输入框时 Esc 关闭侧栏", true);

	// 切换对话自动关
	await openCard("config.json");
	await page.locator("[data-testid=file-preview-code]").waitFor({ timeout: 10_000 });
	await page.getByTestId("conv-menu").click();
	await page.getByText("第二段对话", { exact: true }).click();
	await page.locator("[data-testid=file-preview]").waitFor({ state: "detached", timeout: 5000 });
	check("[侧栏] 切换对话自动关闭侧栏", true);

	// 图片仍走 ImageViewer
	await page.locator("[data-testid=image-attachment] img").first().click();
	await page.locator("[data-testid=image-viewer]").waitFor({ timeout: 10_000 });
	check("[侧栏] 图片仍走 ImageViewer，不进侧栏", (await panelOpen()) === 0);
	await page.keyboard.press("Escape");

	// glass 浅色截图
	await page.evaluate(() => { localStorage.setItem("pia.skin", "glass"); localStorage.setItem("pia.theme", "light"); });
	await page.reload();
	await page.locator('[data-testid="file-attachment"]').first().waitFor({ timeout: 20_000 });
	await openCard("voice-input-feasibility.md");
	await page.locator("[data-testid=file-preview-markdown]").waitFor({ timeout: 10_000 });
	await page.waitForTimeout(400);
	check("[侧栏] glass 浅色：侧栏正常停靠", (await panelOpen()) === 1 && (await page.locator("html[data-skin=glass]").count()) === 1);
	await page.screenshot({ path: join(OUT, "side-panel-glass-light.png") });
	await page.keyboard.press("Escape");
	await page.locator("[data-testid=file-preview]").waitFor({ state: "detached", timeout: 5000 });

	// 1100 宽放不下侧栏：保持弹窗（先把信息面板关掉，否则窄窗口里它会变成覆盖式抽屉）
	if (await page.getByTestId("info-tabs").isVisible()) await page.getByRole("button", { name: "信息面板", exact: true }).click();
	await page.setViewportSize({ width: 1100, height: 800 });
	await page.waitForTimeout(300);
	await page.locator('[aria-label="预览 voice-input-feasibility.md"]').click();
	await page.locator("[data-testid=file-preview-markdown]").waitFor({ timeout: 10_000 });
	check("[侧栏] 窗口放不下（1100 宽）：仍是弹窗", (await panelOpen()) === 0 && (await page.locator(".pa-modal").count()) === 1);
	check("[侧栏] 控制台无报错", errors.length === 0, errors.slice(0, 3).join(" | "));
	await ctx.close();
}

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
