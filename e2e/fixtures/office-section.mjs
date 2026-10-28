/**
 * file-preview.mjs 的 Office 段：Word / Excel / PPT / iWork / zip / Jupyter / 损坏文件 / 老格式 / 超限，加 390 窄屏。
 * 测试文件由 office-files.mjs 运行时生成。设计见 docs/design/office-file-preview.md。
 */
import { DOCX_LINK, PPTX_LINK, XSS_TEXT } from "./office-files.mjs";

export async function runOfficeSection({ browser, base, installRoutes, check, OUT, join }) {
	console.log("\n── Office / iWork / zip / Jupyter 预览 ──");
	const state = { fileHits: [], remoteHits: [] };
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true });
	await installRoutes(ctx, state);
	const page = await ctx.newPage();
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		const t = m.text();
		if (m.type() !== "error" || /WebSocket connection to .*\/ws|status of 404|ERR_FAILED|Failed to load resource/.test(t)) return;
		errors.push(t);
	});
	await page.goto(`${base}/?agent=a1`);
	await page.locator('[aria-label="预览 report.docx"]').waitFor({ timeout: 20_000 });

	const open = async (name, testId) => {
		await page.locator(`[aria-label="预览 ${name}"]`).click();
		await page.locator(`[data-testid=${testId}]`).waitFor({ timeout: 15_000 });
	};
	const close = async () => {
		await page.keyboard.press("Escape");
		await page.locator("[data-testid=file-preview]").waitFor({ state: "detached", timeout: 5000 });
	};
	const shadowText = (host) => page.evaluate((h) => document.querySelector(`[data-testid=${h}]`)?.shadowRoot?.textContent ?? "", host);
	const clickLinkExpectPopup = async (selector, want) => {
		const url0 = page.url();
		const [popup] = await Promise.all([page.waitForEvent("popup", { timeout: 5000 }).catch(() => null), page.locator(selector).first().click()]);
		await page.waitForTimeout(300);
		if (popup) await popup.close().catch(() => {});
		// 新窗口的请求被 installRoutes 拦下并记在 remoteHits 里：能看到目标地址就说明是新窗口打开的 http(s) 链接
		const hit = state.remoteHits.some((u) => u.startsWith(want));
		return { ok: page.url() === url0 && !!popup && hit, popup: !!popup, same: page.url() === url0, hit };
	};

	// ---- Word ----
	await open("report.docx", "file-preview-docx");
	await page.waitForFunction(() => /季度报告/.test(document.querySelector("[data-testid=docx-host]")?.shadowRoot?.textContent ?? ""), null, { timeout: 15_000 });
	const docx = await shadowText("docx-host");
	check("Word：标题、正文、表格内容都渲染出来", docx.includes("季度报告（Word）") && docx.includes("正文第一段") && docx.includes("收入") && docx.includes("1024"), docx.slice(0, 120));
	check("Word：工具栏类型是「Word」", (await page.locator("[data-testid=file-preview-toolbar]").textContent())?.includes("Word"));
	check("Word：渲染在 Shadow DOM 里（样式不串到 App）", await page.evaluate(() => !!document.querySelector("[data-testid=docx-host]")?.shadowRoot?.querySelector(".docx-wrapper, section.docx") && !document.querySelector("section.docx")));
	check("Word：有分页（页面容器）", (await page.evaluate(() => document.querySelector("[data-testid=docx-host]")?.shadowRoot?.querySelectorAll("section.docx").length ?? 0)) >= 1);
	await page.screenshot({ path: join(OUT, "desktop-docx.png") });
	const wl = await clickLinkExpectPopup("[data-testid=file-preview-docx] a", "https://example.com");
	check("Word：点链接不在 App 窗口里跳转（新窗口打开）", wl.ok && wl.same && wl.popup, JSON.stringify(wl));
	check("Word：文档里的链接地址保持原样", (await page.evaluate(() => document.querySelector("[data-testid=docx-host]")?.shadowRoot?.querySelector("a")?.getAttribute("href"))) === DOCX_LINK);
	await close();

	// ---- Excel ----
	await open("sales.xlsx", "file-preview-xlsx");
	const xl = await page.locator("[data-testid=file-preview-xlsx]").textContent();
	check("Excel：表头与数据", /日期/.test(xl) && /产品/.test(xl) && /苹果/.test(xl) && /42/.test(xl), xl.slice(0, 120));
	const wantDate = await page.evaluate(() => new Date(Date.UTC(2024, 2, 5)).toLocaleDateString(undefined, { timeZone: "UTC" }));
	check("Excel：日期按本地格式显示（2024-03-05，没有差一天）", xl.includes(wantDate), `${wantDate} / ${xl.slice(0, 100)}`);
	check("Excel：两个工作表可切换", (await page.locator("[data-testid=xlsx-sheets] button").count()) === 2);
	await page.screenshot({ path: join(OUT, "desktop-xlsx.png") });
	await page.locator("[data-testid=xlsx-sheet-1]").click();
	await page.waitForFunction(() => /第二张表的内容/.test(document.querySelector("[data-testid=file-preview-xlsx]")?.textContent ?? ""));
	check("Excel：切到第二个工作表", true);
	await close();

	// ---- PPT ----
	await open("deck.pptx", "file-preview-pptx");
	await page.waitForFunction(() => document.querySelector("[data-testid=pptx-host]")?.shadowRoot?.querySelectorAll("[data-testid=pptx-slide]").length === 2, null, { timeout: 15_000 });
	const ppt = await shadowText("pptx-host");
	check("PPT：两页，每页一张", true);
	check("PPT：文字、形状文字、表格都渲染出来", ["季度汇报（PPT）", "幻灯片链接", "蓝色色块", "表头甲", "格二", "第二页正文"].every((t) => ppt.includes(t)), ppt.slice(0, 160));
	const pptInfo = await page.evaluate(() => {
		const r = document.querySelector("[data-testid=pptx-host]").shadowRoot;
		return { img: r.querySelector("img")?.src.slice(0, 30), fills: [...r.querySelectorAll("div,path")].map((d) => d.style.backgroundColor || d.getAttribute("fill") || "").filter(Boolean).slice(0, 8) };
	});
	check("PPT：图片按 data: 渲染", pptInfo.img?.startsWith("data:image/png"), JSON.stringify(pptInfo));
	check("PPT：形状有填充色", pptInfo.fills.some((c) => /^(#3b82f6|rgb\(59, 130, 246\))$/i.test(c)), JSON.stringify(pptInfo));
	check("PPT：页面按容器宽度缩放（不超出）", await page.evaluate(() => {
		const host = document.querySelector("[data-testid=pptx-host]");
		const s = host.shadowRoot.querySelector("[data-testid=pptx-slide]");
		return s.getBoundingClientRect().width <= host.parentElement.clientWidth + 1 && s.getBoundingClientRect().width > 300;
	}));
	check("PPT：渲染在 Shadow DOM 里", await page.evaluate(() => !document.querySelector("[data-testid=pptx-slide]")));
	check("PPT：危险文字只当文字显示（没有 img/script 标签、没有执行）", ppt.includes("onerror") && (await page.evaluate(() => window.__pptxXss === undefined && document.querySelector("[data-testid=pptx-host]").shadowRoot.querySelectorAll("img").length === 1 && document.querySelector("[data-testid=pptx-host]").shadowRoot.querySelectorAll("script").length === 0)), XSS_TEXT);
	check("PPT：链接带 noopener、只放 http(s)", await page.evaluate((u) => {
		const a = document.querySelector("[data-testid=pptx-host]").shadowRoot.querySelector("a");
		return a?.getAttribute("href") === u && a.getAttribute("target") === "_blank" && /noopener/.test(a.getAttribute("rel") ?? "");
	}, PPTX_LINK));
	await page.screenshot({ path: join(OUT, "desktop-pptx.png") });
	const pl = await clickLinkExpectPopup("[data-testid=file-preview-pptx] a", "https://example.com");
	check("PPT：点链接不在 App 窗口里跳转", pl.ok && pl.same, JSON.stringify(pl));
	await close();

	// ---- iWork ----
	await open("notes.pages", "file-preview-iwork");
	await page.locator("[data-testid=file-preview-iwork] img").waitFor();
	check("Pages：显示文件自带预览图并有说明", (await page.evaluate(() => { const i = document.querySelector("[data-testid=file-preview-iwork] img"); return i.src.startsWith("blob:") && i.complete && i.naturalWidth >= 1; })) && /自带的预览图/.test(await page.locator("[data-testid=file-preview-iwork]").textContent()));
	await close();
	await open("bare.key", "iwork-nopreview");
	check("Keynote：包里没有预览图 → 提示下载", /没带预览图/.test(await page.locator("[data-testid=iwork-nopreview]").textContent()) && (await page.locator("[data-testid=file-preview-download]").isVisible()));
	await close();

	// ---- zip ----
	await open("bundle.zip", "file-preview-zip");
	const names = await page.locator("[data-testid=zip-entry]").allTextContents();
	check("zip：列出文件和文件夹，不显示 __MACOSX", names.length === 4 && names.some((n) => n.includes("docs/readme.txt")) && names.some((n) => n.includes("说明.md")) && !names.some((n) => n.includes("__MACOSX")), JSON.stringify(names));
	check("zip：显示文件大小、总数，并说明不解压", names.some((n) => /5 B/.test(n)) && /共 4 项/.test(await page.locator("[data-testid=file-preview-zip]").textContent()));
	await close();

	// ---- Jupyter ----
	await open("analysis.ipynb", "file-preview-ipynb");
	const nb = await page.locator("[data-testid=file-preview-ipynb]").textContent();
	check("ipynb：Markdown 单元渲染成标题", (await page.locator("[data-testid=file-preview-ipynb] h1").textContent()) === "笔记标题");
	check("ipynb：代码单元、输出文本、纯文本版输出", nb.includes("print('你好 notebook')") && nb.includes("In [1]") && nb.includes("纯文本版输出"));
	check("ipynb：图片输出用 data: 显示；html 输出不渲染也不执行", (await page.locator("[data-testid=ipynb-image]").getAttribute("src"))?.startsWith("data:image/png;base64,") && !nb.includes("html 输出") && (await page.evaluate(() => window.__nbXss === undefined)));
	await page.screenshot({ path: join(OUT, "desktop-ipynb.png") });
	await page.locator("[data-testid=ipynb-mode-source]").click();
	await page.locator("[data-testid=file-preview-code]").waitFor();
	check("ipynb：可切到源码", (await page.locator("[data-testid=file-preview-code]").textContent()).includes("nbformat"));
	await close();

	// ---- 损坏文件 ----
	for (const [name, label] of [["broken.docx", "Word"], ["broken.xlsx", "Excel"], ["broken.pptx", "PPT"], ["broken.zip", "zip"], ["broken.ipynb", "ipynb"]]) {
		await open(name, "office-parse-error");
		check(`${label} 损坏：显示「解析不了」+ 保留下载，不白屏`, /解析不了/.test(await page.locator("[data-testid=office-parse-error]").textContent()) && (await page.locator("[data-testid=file-preview-download]").isVisible()));
		await close();
	}

	// ---- 老格式 / 超限 ----
	for (const name of ["legacy.doc", "legacy.xls"]) {
		await open(name, "file-preview-unsupported");
		check(`${name}：提示另存为新格式`, /另存为 \.docx \/ \.xlsx \/ \.pptx/.test(await page.locator("[data-testid=file-preview-unsupported]").textContent()));
		await close();
	}
	await open("huge.pptx", "file-preview-oversize");
	check("超过 30MB：提示文件太大、没有去下载整份", /30(\.0)? ?MB/i.test(await page.locator("[data-testid=file-preview-oversize]").textContent()) && !state.fileHits.includes("o-big"), JSON.stringify(state.fileHits.slice(-3)));
	await close();
	check("Office 段：没有触发外网图片请求之外的控制台报错", errors.length === 0, errors.slice(0, 3).join(" | "));
	await ctx.close();

	// ---- 手机 390 ----
	console.log("\n── Office 预览 手机 390x844 ──");
	const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "zh-CN", acceptDownloads: true });
	await installRoutes(mctx, { fileHits: [], remoteHits: [] });
	const mp = await mctx.newPage();
	await mp.goto(`${base}/?agent=a1`);
	await mp.locator('[aria-label="预览 report.docx"]').waitFor({ timeout: 20_000 });
	for (const [name, testId, shot] of [["report.docx", "file-preview-docx", "mobile-390-docx.png"], ["deck.pptx", "file-preview-pptx", "mobile-390-pptx.png"], ["sales.xlsx", "file-preview-xlsx", "mobile-390-xlsx.png"]]) {
		await mp.locator(`[aria-label="预览 ${name}"]`).tap();
		await mp.locator(`[data-testid=${testId}]`).waitFor({ timeout: 15_000 });
		await mp.waitForTimeout(900); // 弹窗动画 + 文档渲染
		const bar = await mp.locator("[data-testid=file-preview-toolbar]").boundingBox();
		check(`[390] ${name}：工具栏在视口内、页面无横向溢出`, bar && bar.x >= 0 && bar.x + bar.width <= 390.5 && (await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
		if (testId === "file-preview-pptx") check("[390] PPT：幻灯片缩到屏幕宽度以内", await mp.evaluate(() => document.querySelector("[data-testid=pptx-host]").shadowRoot.querySelector("[data-testid=pptx-slide]").getBoundingClientRect().width <= 390));
		if (testId === "file-preview-docx") check("[390] Word：整页缩放后不需要横向滚动", await mp.evaluate(() => { const w = document.querySelector("[data-testid=docx-host]").shadowRoot.querySelector(".docx-wrapper"); const o = document.querySelector("[data-testid=file-preview-docx]"); return !!w && o.scrollWidth <= o.clientWidth + 1; }));
		await mp.screenshot({ path: join(OUT, shot) });
		await mp.locator("[data-testid=file-preview-close]").tap();
		await mp.locator("[data-testid=file-preview]").waitFor({ state: "detached", timeout: 5000 });
	}
	await mctx.close();
}
