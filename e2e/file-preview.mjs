/**
 * 聊天附件「应用内预览」定向验证。
 *
 * 用户报的问题：聊天里的文件卡片（如 voice-input-feasibility.md）只有下载图标，
 * 点卡片主体没有任何预览，只能下载。
 *
 * 这里验证修好后的行为（纯前端 fixture）：
 *  - 点卡片主体 / 文件名（键盘 Enter/Space 也算）打开应用内预览；下载图标是独立按钮，
 *    点它只下载、不打开预览（stopPropagation）；
 *  - Markdown（含 39KB 长内容 / 表格 / 代码块）默认渲染，外链图片不自动加载，
 *    javascript: / 相对文件引用不渲染成可点链接，http 链接带 target=_blank + rel；
 *  - 文本 / 代码：行号 + 复制；CSV：引号内换行的有界表格；不支持的类型、超限文件、
 *    404 各自有明确提示且始终保留下载；404 可重试成功；
 *  - PDF：<object> 内嵌 + fallback 提示 + 下载；
 *  - 390 窄屏工具栏在视口内、Esc 关闭、焦点回到触发卡片；图片附件仍走 ImageViewer（不回归）。
 *
 * 纯前端 fixture：静态托管 apps/web/dist，用 page.route 拦截所有 /api 与文件读取，
 * 不启动 packages/server/src/main.ts，不碰真实数据目录、不碰系统钥匙串、不读用户文件。
 * 运行前先构建：npm run build -w @pi-assistant/web
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium } from "playwright-core";
import { artifactDir } from "./fixtures/artifacts.mjs";

const root = decodeURIComponent(new URL("..", import.meta.url).pathname);
const dist = join(root, "apps/web/dist");
if (!existsSync(join(dist, "index.html"))) {
	console.error("找不到 apps/web/dist/index.html；先跑 `npm run build -w @pi-assistant/web`");
	process.exit(2);
}
const OUT = artifactDir("file-preview");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".map": "application/json" };
const web = createServer(async (req, res) => {
	const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
	const file = path === "/" || path === "" ? join(dist, "index.html") : join(dist, path);
	try {
		const data = await readFile(file);
		res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
		res.end(data);
	} catch {
		const html = await readFile(join(dist, "index.html"));
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(html);
	}
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${web.address().port}`;

const now = Date.now();
const AGENT = { id: "a1", name: "测试助理", avatar: "测", color: "#3b82f6", persona: "", description: "", status: "idle", unread: 0, model: { provider: "mock", id: "mock" }, model_provider: "mock", model_id: "mock", workspace: "/tmp/ws/a1", scope: "user" };
const system = () => ({
	serverId: "srv", publicKey: "pk", pi: { version: "0.0.0", testedWith: "0.0.0", compatible: true, message: "ok" },
	mock: true, local: true, owner: true, server: false, deviceId: "dev", onboarded: true, modelSetupDone: true,
	defaultModel: { provider: "mock", id: "mock" }, credentialBackend: "file",
	sandbox: { mode: "workspace", preference: "workspace", dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "off" }, binary: null, named: {} },
	workspaceRoot: "/tmp/ws", push: { publicKey: "pk" }, seq: 1,
});
const hostInfo = { settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } };

// ---- 附件 fixture（自建假文件，不读用户真实数据）----
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// 39KB 左右的 Markdown：标题 + 表格 + 代码块 + 外链图片 + javascript: / 相对链接 / http 链接
const MD_BODY = [
	"# 语音输入可行性",
	"",
	"结论：**先做语音输入，再做双向通话**。",
	"",
	"| 方案 | 延迟 | 备注 |",
	"| --- | --- | --- |",
	"| 流式识别 | 低 | 推荐 |",
	"| 整段识别 | 中 | 兜底 |",
	"",
	"```ts",
	"const rec = new MediaRecorder(stream);",
	"rec.onstop = () => transcribe(blob);",
	"```",
	"",
	"![外链图](https://example.com/pic.png)",
	"",
	"[危险链接](javascript:alert(1)) 和 [相对文件](./secret.txt) 和 [官网](https://example.com/docs)。",
	"",
	...Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 段：手机需 HTTPS，局域网普通 HTTP 通常拿不到麦克风权限，转写模型要统一在模型服务里管理。`),
].join("\n");

const CSV_BODY = 'name,note,count\n"张三","第一行\n第二行",3\n"带,逗号","他说""你好""",4\n';

const FILES = {
	"f-md": { name: "voice-input-feasibility.md", mime: "text/markdown", body: MD_BODY },
	"f-txt": { name: "notes.txt", mime: "text/plain", body: "第一行\n第二行\n第三行\n" },
	"f-json": { name: "config.json", mime: "application/json", body: '{\n  "a": 1,\n  "b": [true, null]\n}\n' },
	"f-csv": { name: "data.csv", mime: "text/csv", body: CSV_BODY },
	"f-pdf": { name: "report.pdf", mime: "application/pdf", body: Buffer.from("%PDF-1.4\n% fixture\n%%EOF\n") },
	"f-zip": { name: "archive.zip", mime: "application/zip", body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]) },
	"f-img": { name: "photo.png", mime: "image/png", body: PNG_1PX },
	// 视频 / 音频：字节不是真正可解码的媒体流（够不上体积限制、不提交大二进制），只用来验证播放器元素
	// 挂载、src 指向签名播放链接、以及解码失败时的「没法在这里播放」提示（真实 mp4/mp3 由服务端真实单测覆盖）。
	"f-mp4": { name: "clip.mp4", mime: "video/mp4", body: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]) },
	"f-mp3": { name: "voice.mp3", mime: "audio/mpeg", body: Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0]) },
};

const attachments = [
	{ fileId: "f-md", name: "voice-input-feasibility.md", mime: "text/markdown", size: Buffer.byteLength(MD_BODY), direction: "out", workspacePath: "research/voice-input-feasibility.md" },
	{ fileId: "f-csv", name: "data.csv", mime: "text/csv", size: Buffer.byteLength(CSV_BODY), direction: "out" },
	{ fileId: "f-json", name: "config.json", mime: "application/json", size: 30, direction: "out" },
	{ fileId: "f-txt", name: "notes.txt", mime: "text/plain", size: 30, direction: "out" },
	{ fileId: "f-pdf", name: "report.pdf", mime: "application/pdf", size: 24, direction: "out" },
	{ fileId: "f-zip", name: "archive.zip", mime: "application/zip", size: 8, direction: "out" },
	{ fileId: "f-huge", name: "huge.txt", mime: "text/plain", size: 2 * 1024 * 1024, direction: "out" },
	{ fileId: "f-missing", name: "missing.txt", mime: "text/plain", size: 10, direction: "out" },
	{ fileId: "f-img", name: "photo.png", mime: "image/png", size: PNG_1PX.length, direction: "out" },
];
const mediaAttachments = [
	{ fileId: "f-mp4", name: "clip.mp4", mime: "video/mp4", size: FILES["f-mp4"].body.length, direction: "out" },
	{ fileId: "f-mp3", name: "voice.mp3", mime: "audio/mpeg", size: FILES["f-mp3"].body.length, direction: "out" },
];
const msgs = [
	{ id: "m1", agent_id: "a1", task_id: null, role: "assistant", content: "语音输入与双向通话可行性调研，报告已附上。", meta: { attachments }, status: "done", created_at: now - 60_000, updated_at: now - 60_000, conversation_id: "c1" },
	{ id: "m2", agent_id: "a1", task_id: null, role: "assistant", content: "录屏和语音备忘也发你。", meta: { attachments: mediaAttachments }, status: "done", created_at: now - 30_000, updated_at: now - 30_000, conversation_id: "c1" },
];
// 「文件」信息面板用同一批文件（含视频 / 音频），验证预览弹窗里也能播放
const infoFiles = [...attachments, ...mediaAttachments].filter((f) => f.fileId !== "f-huge" && f.fileId !== "f-missing");

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
// 需求要求 Markdown 长内容（约 39KB）也要能预览
check(`Markdown fixture ≥ 39KB（实际 ${(Buffer.byteLength(MD_BODY) / 1024).toFixed(1)}KB）`, Buffer.byteLength(MD_BODY) >= 39 * 1024);

/** 每个页面装一套 route：返回 fixture 文件 / 记录请求（用于断言「不自动加载外链图」「大文件不下载」）。 */
async function installRoutes(context, state) {
	await context.route("**/api/**", async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT]);
		if (p === "/api/rooms") return json([]);
		if (p === "/api/channels") return json({ items: [], publicUrl: null });
		if (p === "/api/wechat") return json({ enabled: false, acknowledgedAt: null, agentIds: [] });
		if (p === "/api/downloads") return json({ items: [] });
		if (p.startsWith("/api/proactive/inbox")) return json({ items: [], count: 0, defaultLevel: "normal" });
		if (p === "/api/devices") return json([]);
		if (p === "/api/models/providers") return json({ providers: [] });
		if (p === "/api/models") return json([]);
		if (p === "/api/host-control") return json(hostInfo);
		if (p.startsWith("/api/usage/summary")) return json({ totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 } });
		if (p === "/api/memory/providers") return json({ global: "basic", providers: [] });
		if (p === "/api/skill-suggest") return json({ enabled: false });
		if (p === "/api/settings") return json({});
		if (p === "/api/agents/a1/messages") return json(msgs);
		if (p === "/api/agents/a1/conversations" && req.method() === "GET") return json({ current: "c1", items: [{ id: "c1", agent_id: "a1", title: "第一段对话", created_at: now, updated_at: now, message_count: 1, last: "报告" }] });
		if (p === "/api/subagents") return json([]);
		if (p === "/api/agents/a1/computer") return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		if (p === "/api/agents/a1/files") return json(infoFiles);
		// 视频 / 音频播放链接：真实服务端是另起一条短时签名地址（见 packages/server/src/http.ts 的 /play-link +
		// channels/media.ts 的 signedPath），这里为简化直接换回同一个带 inline=1 的授权地址——测试只关心播放器
		// 元素挂载、src 非空，不重复验证签名机制（签名链接的单测在 packages/server/test/media-range-http.test.ts）。
		const pl = /^\/api\/files\/([^/]+)\/play-link$/.exec(p);
		if (pl) return json({ url: `/api/files/${pl[1]}?inline=1` });
		const fm = /^\/api\/files\/([^/]+)$/.exec(p);
		if (fm) {
			const id = fm[1];
			state.fileHits.push(id);
			if (id === "f-missing" && !state.missingFixed) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
			const f = FILES[id];
			if (!f) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
			const body = Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body, "utf8");
			const inline = new URL(req.url()).searchParams.get("inline") === "1" && /^(image\/|text\/plain|(video|audio)\/)/.test(f.mime);
			return route.fulfill({ status: 200, headers: { "content-type": f.mime, "content-length": String(body.length), "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}` }, body });
		}
		return json({});
	});
	// 外链图片：默认不应被请求（预览里外链图不自动加载）
	await context.route("**://example.com/**", (route) => {
		state.remoteHits.push(route.request().url());
		return route.abort();
	});
}

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME, headless: true });

	// ================================ 桌面 ================================
	console.log("\n── 桌面 1440x900 ──");
	{
		const state = { fileHits: [], remoteHits: [] };
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", acceptDownloads: true });
		await installRoutes(ctx, state);
		const page = await ctx.newPage();
		const errors = [];
		page.on("pageerror", (e) => errors.push(String(e)));
		page.on("console", (m) => {
			if (m.type() !== "error") return;
			const t = m.text();
			// fixture 噪音：没有真实 WS 服务；404 是本测试故意造的 /api/files/f-missing
			if (/WebSocket connection to .*\/ws/.test(t)) return;
			if (/Failed to load resource: the server responded with a status of 404/.test(t)) return;
			errors.push(t);
		});
		await page.goto(`${base}/?agent=a1`);
		await page.locator('[data-testid="file-attachment"]').first().waitFor({ timeout: 20_000 });

		// 卡片结构：主体是按钮，下载是独立按钮（不能嵌套 button）
		check("文件卡片存在且主体/下载是两个独立按钮", (await page.locator('[data-testid="file-preview-open"]').count()) >= 1 && (await page.locator('[data-testid="file-download"]').count()) >= 1);
		check("卡片里没有嵌套按钮（无效 HTML）", await page.evaluate(() => [...document.querySelectorAll("[data-testid=file-attachment]")].every((c) => !c.querySelector("button button"))));

		// 下载图标：只下载、不打开预览
		const beforeOpen = await page.locator("[data-testid=file-preview]").count();
		const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), page.locator('[data-testid="file-download"]').first().click()]);
		check("点下载图标触发下载", /voice-input-feasibility\.md$/.test(dl.suggestedFilename()), dl.suggestedFilename());
		check("点下载图标不打开预览（stopPropagation）", (await page.locator("[data-testid=file-preview]").count()) === beforeOpen && beforeOpen === 0);

		// 点卡片主体（文件名）打开预览
		await page.locator('[data-testid="file-preview-open"]').first().click();
		await page.locator("[data-testid=file-preview]").waitFor({ timeout: 10_000 });
		await page.locator("[data-testid=file-preview-markdown]").waitFor({ timeout: 10_000 });
		check("点卡片主体打开应用内预览", await page.locator("[data-testid=file-preview]").isVisible());
		check("工具栏显示文件名与类型/大小", (await page.locator("[data-testid=file-preview-name]").textContent())?.includes("voice-input-feasibility.md") && (await page.locator("[data-testid=file-preview-toolbar]").textContent())?.includes("Markdown"));
		check("Markdown 长内容已渲染（表格 + 代码块）", (await page.locator("[data-testid=file-preview-markdown] table").count()) >= 1 && (await page.locator("[data-testid=file-preview-markdown] pre code").count()) >= 1);
		await page.screenshot({ path: join(OUT, "desktop-markdown-preview.png") });
		// 渲染 / 源码切换
		await page.locator("[data-testid=md-mode-source]").click();
		await page.locator("[data-testid=file-preview-code]").waitFor({ timeout: 10_000 });
		check("Markdown 可切到源码", (await page.locator("[data-testid=file-preview-code]").textContent())?.includes("# 语音输入可行性"));
		await page.locator("[data-testid=md-mode-rendered]").click();
		await page.locator("[data-testid=file-preview-markdown] table").first().waitFor({ timeout: 10_000 });
		check("Markdown 可切回渲染", (await page.locator("[data-testid=file-preview-markdown] table").count()) >= 1);

		// 外链图片不自动加载
		check("外链图片显示占位、未自动请求", (await page.locator("[data-testid=md-remote-image-blocked]").count()) >= 1 && state.remoteHits.length === 0, JSON.stringify(state.remoteHits));
		// 危险 / 相对链接不渲染成可点链接
		const hrefs = await page.evaluate(() => [...document.querySelectorAll("[data-testid=file-preview-markdown] a")].map((a) => a.getAttribute("href") ?? ""));
		check("javascript: / 相对文件引用不渲染成链接", hrefs.every((h) => !/^javascript:/i.test(h) && !/^\.\//.test(h) && !/^file:/i.test(h)), JSON.stringify(hrefs));
		const extLink = await page.evaluate(() => {
			const a = [...document.querySelectorAll("[data-testid=file-preview-markdown] a[href^='https://example.com/docs']")][0];
			return a ? { target: a.getAttribute("target"), rel: a.getAttribute("rel") } : null;
		});
		check("http 外链带 target=_blank + rel", extLink?.target === "_blank" && /noreferrer/.test(extLink?.rel ?? ""), JSON.stringify(extLink));

		// Esc 关闭 + 焦点回到触发卡片
		await page.keyboard.press("Escape");
		await page.locator("[data-testid=file-preview]").waitFor({ state: "detached", timeout: 5000 });
		check("Esc 关闭预览", true);
		check("关闭后焦点回到触发卡片", await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "file-preview-open"));
		await page.screenshot({ path: join(OUT, "desktop-chat.png") });

		// 键盘 Enter 打开
		await page.locator('[data-testid="file-preview-open"]').first().focus();
		await page.keyboard.press("Enter");
		await page.locator("[data-testid=file-preview-markdown]").waitFor({ timeout: 10_000 });
		check("键盘 Enter 也能打开预览", true);
		await page.keyboard.press("Escape");

		// CSV：引号内换行 + 有界表格
		await page.locator('[data-testid="file-preview-open"]').nth(1).click();
		await page.locator("[data-testid=file-preview-csv]").waitFor({ timeout: 10_000 });
		const csvCells = await page.evaluate(() => [...document.querySelectorAll("[data-testid=file-preview-csv] td")].map((t) => t.textContent));
		check("CSV 解析引号内换行 / 转义引号", csvCells.some((c) => c?.includes("第一行\n第二行")) && csvCells.some((c) => c?.includes('他说"你好"')), JSON.stringify(csvCells.slice(0, 6)));
		check("CSV 表头存在", (await page.locator("[data-testid=file-preview-csv] th").count()) === 3);
		await page.screenshot({ path: join(OUT, "desktop-csv-preview.png") });
		await page.keyboard.press("Escape");

		// 代码 / 文本：行号 + 复制
		await page.locator('[data-testid="file-preview-open"]').nth(2).click();
		await page.locator("[data-testid=file-preview-code]").waitFor({ timeout: 10_000 });
		check("代码预览有行号", (await page.locator("[data-testid=file-preview-code] code > div").count()) >= 3);
		check("代码预览有复制按钮", await page.locator("[data-testid=file-preview-copy]").isVisible());
		await page.keyboard.press("Escape");

		// 不支持的类型：提示 + 下载
		await page.locator('[data-testid="file-preview-open"]').nth(5).click();
		await page.locator("[data-testid=file-preview-unsupported]").waitFor({ timeout: 10_000 });
		check("压缩包等不支持类型：明确提示", await page.locator("[data-testid=file-preview-unsupported]").isVisible());
		check("不支持类型仍保留下载", await page.locator("[data-testid=file-preview-download]").isVisible());
		await page.keyboard.press("Escape");

		// 超限：不下载大文件，直接提示 + 下载
		const hitsBeforeHuge = state.fileHits.length;
		await page.locator('[data-testid="file-preview-open"]').nth(6).click();
		await page.locator("[data-testid=file-preview-oversize]").waitFor({ timeout: 10_000 });
		check("超大文本：提示超限", await page.locator("[data-testid=file-preview-oversize]").isVisible());
		check("超大文本：没有去下载整份文件", !state.fileHits.slice(hitsBeforeHuge).includes("f-huge"), JSON.stringify(state.fileHits.slice(hitsBeforeHuge)));
		await page.keyboard.press("Escape");

		// 404：错误提示 + 重试（第二次路由改成 200）
		await page.locator('[data-testid="file-preview-open"]').nth(7).click();
		await page.locator("[data-testid=file-preview-error]").waitFor({ timeout: 10_000 });
		check("404 显示明确错误", await page.locator("[data-testid=file-preview-error]").isVisible());
		check("404 时仍保留下载", await page.locator("[data-testid=file-preview-download]").isVisible());
		FILES["f-missing"] = { name: "missing.txt", mime: "text/plain", body: "重试之后有了内容\n" };
		state.missingFixed = true;
		await page.locator("[data-testid=file-preview-retry]").click();
		await page.locator("[data-testid=file-preview-code]").waitFor({ timeout: 10_000 });
		check("重试后成功显示内容", (await page.locator("[data-testid=file-preview-code]").textContent())?.includes("重试之后有了内容"));
		await page.keyboard.press("Escape");

		// PDF：object 内嵌 + fallback 提示 + 下载
		await page.locator('[data-testid="file-preview-open"]').nth(4).click();
		await page.locator("[data-testid=file-preview-pdf]").waitFor({ timeout: 10_000 });
		const pdfInfo = await page.evaluate(() => {
			const o = document.querySelector("[data-testid=file-preview-pdf] object");
			return o ? { type: o.getAttribute("type"), data: o.getAttribute("data") ?? "" } : null;
		});
		check("PDF 用 object 内嵌且来自本会话 blob（不外源）", pdfInfo?.type === "application/pdf" && pdfInfo.data.startsWith("blob:"), JSON.stringify(pdfInfo));
		check("PDF 保留 fallback 提示与下载", (await page.locator("[data-testid=file-preview-pdf-fallback]").count()) >= 1 && (await page.locator("[data-testid=file-preview-download]").isVisible()));
		await page.keyboard.press("Escape");

		// 图片附件仍走 ImageViewer（不回归）
		await page.locator("[data-testid=image-attachment] img").first().click();
		await page.locator("[data-testid=image-viewer]").waitFor({ timeout: 10_000 });
		check("图片附件仍打开 ImageViewer（未换成文件预览）", (await page.locator("[data-testid=image-viewer]").isVisible()) && (await page.locator("[data-testid=file-preview]").count()) === 0);
		await page.keyboard.press("Escape");

		// ---- 视频 / 音频：聊天附件直接内嵌播放器 ----
		await page.locator("[data-testid=video-attachment] video").first().waitFor({ timeout: 10_000 });
		check("视频附件：内嵌 <video> 且 src 指向签名播放链接", (await page.locator("[data-testid=video-attachment] video").getAttribute("src"))?.includes("/api/files/f-mp4"));
		check("视频附件：有文件名 + 下载按钮", (await page.locator("[data-testid=video-attachment]").textContent())?.includes("clip.mp4") && (await page.locator("[data-testid=video-attachment] [data-testid=file-download]").count()) === 1);
		await page.locator("[data-testid=audio-attachment] audio").first().waitFor({ timeout: 10_000 });
		check("音频附件：内嵌 <audio> 且 src 指向签名播放链接", (await page.locator("[data-testid=audio-attachment] audio").getAttribute("src"))?.includes("/api/files/f-mp3"));
		check("音频附件：有文件名 + 下载按钮", (await page.locator("[data-testid=audio-attachment]").textContent())?.includes("voice.mp3") && (await page.locator("[data-testid=audio-attachment] [data-testid=file-download]").count()) === 1);
		// fixture 里的 mp4/mp3 字节不是真能解码的媒体流：等浏览器探测格式失败，应回落到「没法在这里播放」提示，且下载仍在
		await page.locator("[data-testid=video-attachment] [data-testid=media-error]").waitFor({ timeout: 15_000 });
		check("视频解码失败：显示友好提示并保留下载", /没法在这里播放/.test((await page.locator("[data-testid=video-attachment] [data-testid=media-error]").textContent()) ?? "") && (await page.locator("[data-testid=video-attachment] [data-testid=file-download]").isVisible()));
		await page.screenshot({ path: join(OUT, "desktop-media-attachments.png") });

		// ---- 视频 / 音频：文件预览弹窗（信息面板「文件」） ----
		await page.getByRole("button", { name: "信息面板", exact: true }).click();
		await page.locator('[data-testid=info-tabs] [role=tab][data-itab="files"]').click();
		await page.locator("[data-testid=agent-files]").waitFor({ timeout: 10_000 });
		await page.locator('[data-testid=info-file-open]').filter({ hasText: "clip.mp4" }).first().click();
		await page.locator("[data-testid=file-preview-video]").waitFor({ timeout: 10_000 });
		check("预览弹窗：视频用同一个播放器组件（<video data-testid=media-video>）", (await page.locator("[data-testid=file-preview-video] video[data-testid=media-video]").count()) === 1);
		await page.keyboard.press("Escape");
		await page.locator('[data-testid=info-file-open]').filter({ hasText: "voice.mp3" }).first().click();
		await page.locator("[data-testid=file-preview-audio]").waitFor({ timeout: 10_000 });
		check("预览弹窗：音频用同一个播放器组件（<audio data-testid=media-audio>）", (await page.locator("[data-testid=file-preview-audio] audio[data-testid=media-audio]").count()) === 1);
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "信息面板", exact: true }).click();

		check("桌面无控制台报错", errors.length === 0, errors.slice(0, 3).join(" | "));
		await ctx.close();
	}

	// ================================ 手机 390 ================================
	console.log("\n── 手机 390x844 ──");
	{
		const state = { fileHits: [], remoteHits: [] };
		const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "zh-CN", acceptDownloads: true });
		await installRoutes(ctx, state);
		const page = await ctx.newPage();
		await page.goto(`${base}/?agent=a1`);
		await page.locator('[data-testid="file-attachment"]').first().waitFor({ timeout: 20_000 });
		await page.locator('[data-testid="file-preview-open"]').first().tap();
		await page.locator("[data-testid=file-preview-markdown]").waitFor({ timeout: 10_000 });
		const box = await page.locator("[data-testid=file-preview]").boundingBox();
		const bar = await page.locator("[data-testid=file-preview-toolbar]").boundingBox();
		check("[390] 预览铺满可视宽度", box && box.x <= 1 && box.width >= 389, JSON.stringify(box));
		check("[390] 工具栏在视口内", bar && bar.x >= 0 && bar.x + bar.width <= 390.5 && bar.y >= 0, JSON.stringify(bar));
		check("[390] 文件名与下载/关闭都可见", (await page.locator("[data-testid=file-preview-name]").isVisible()) && (await page.locator("[data-testid=file-preview-download]").isVisible()) && (await page.locator("[data-testid=file-preview-close]").isVisible()));
		const docW = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		check("[390] 页面无横向溢出", docW <= 1, String(docW));
		check("[390] 长内容可纵向滚动", await page.evaluate(() => { const el = document.querySelector("[data-testid=file-preview-markdown]"); return el ? el.scrollHeight > el.clientHeight : false; }));
		await page.screenshot({ path: join(OUT, "mobile-390-markdown.png") });
		await page.locator("[data-testid=file-preview-close]").tap();
		await page.locator("[data-testid=file-preview]").waitFor({ state: "detached", timeout: 5000 });
		check("[390] 关闭按钮可点", true);
		await ctx.close();
	}
} finally {
	if (browser) await browser.close();
	web.close();
}

console.log("\n===== 结果 =====");
if (failed) {
	console.error(`\n${failed} 项未通过`);
	process.exit(1);
}
console.log("\n全部通过");
