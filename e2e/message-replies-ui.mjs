/**
 * 消息「引用回复」定向验证（纯前端 fixture）。
 *
 * 需求（用户批准）：每条可引用消息旁有**直接可见**的「引用」按钮（不只 hover / 右键 / 长按）；
 * 输入框上方引用条（作者 + 1–2 行摘录 + 附件名 + 取消）；Esc 只取消引用不清草稿；
 * 发送带 replyToId；发送失败保留引用与文字；跳回原消息（已加载高亮 / 未加载 bounded 定位 / 删除提示 + 重试）；
 * draft 按对话 / 群隔离；右键不拦链接原生菜单；长按移动取消；390 无横向溢出。
 *
 * 纯前端：静态托管 apps/web/dist + page.route 拦所有 /api，不启动 packages/server、不碰真实数据 / 钥匙串。
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
const OUT = artifactDir("message-replies-ui");
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
const AGENT = (id, name) => ({ id, name, avatar: name[0], color: "#3b82f6", persona: "", description: "", status: "idle", unread: 0, model: { provider: "mock", id: "mock" }, model_provider: "mock", model_id: "mock", workspace: `/tmp/ws/${id}`, scope: "user" });
const system = () => ({
	serverId: "srv", publicKey: "pk", pi: { version: "0.0.0", testedWith: "0.0.0", compatible: true, message: "ok" },
	mock: true, local: true, owner: true, server: false, deviceId: "dev", onboarded: true, modelSetupDone: true,
	defaultModel: { provider: "mock", id: "mock" }, credentialBackend: "file",
	sandbox: { mode: "workspace", preference: "workspace", dockerAvailable: false }, entryDomain: null,
	tunnel: { enabled: false, state: "off", mode: "quick", url: null, failures: 0, rendezvous: { state: "off" }, binary: null, named: {} },
	workspaceRoot: "/tmp/ws", push: { publicKey: "pk" }, seq: 1,
});
const hostInfo = { settings: { enabled: false, agents: "all", apps: [], workspaceFiles: false, tiers: {}, defaultTier: "bounded" }, tiers: {}, status: { enabled: false, tiers: {}, paused: false, daemon: { state: "off", detail: "" }, platform: "darwin", installed: false, version: "" }, manifest: "", manifestHash: "", permissions: null, activity: { active: false, agent: null, summary: null } };

const mkMsg = (over) => ({ id: "x", agent_id: "a1", role: "assistant", content: "", meta: {}, status: "done", created_at: now, updated_at: now, conversation_id: "c1", ...over });
const U1 = mkMsg({ id: "u1", role: "user", content: "请看一下这个报告", created_at: now - 6000, updated_at: now - 6000, meta: { attachments: [{ fileId: "f1", name: "报告.pdf", mime: "application/pdf", size: 1234 }] } });
const A1 = mkMsg({ id: "a1m", content: "好的，报告我看过了。参考 [官网](https://example.com/doc)。", created_at: now - 5000, updated_at: now - 5000 });
const TOOL = mkMsg({ id: "t1", role: "tool", content: "", meta: { toolName: "read", args: { path: "/tmp/x" } }, created_at: now - 4500, updated_at: now - 4000 });
const A2 = mkMsg({ id: "a2m", content: "这是引用了你上一条消息的回复。", replyToId: "u1", reply: { messageId: "u1", author: { id: "", name: "我", role: "user" }, source: { kind: "conversation", id: "c1" }, excerpt: "请看一下这个报告", truncated: false, edited: false, attachments: [], createdAt: now - 6000 }, created_at: now - 3000, updated_at: now - 3000 });
const A3 = mkMsg({ id: "a3m", content: "这是引用一条更早消息的回复。", replyToId: "m-old", reply: { messageId: "m-old", author: { id: "a1", name: "测试助理", role: "assistant" }, source: { kind: "conversation", id: "c1" }, excerpt: "更早的原话…", truncated: false, edited: false, attachments: [], createdAt: now - 60000 }, created_at: now - 2000, updated_at: now - 2000 });
const A4 = mkMsg({ id: "a4m", content: "这条引用的消息已删除。", replyToId: "m-gone", reply: { messageId: "m-gone", author: { id: "a1", name: "测试助理", role: "assistant" }, source: { kind: "conversation", id: "c1" }, excerpt: "", truncated: false, edited: false, attachments: [], createdAt: now - 70000, unavailable: true }, created_at: now - 1000, updated_at: now - 1000 });
const MOLD = mkMsg({ id: "m-old", content: "这是更早之前的一条消息。", created_at: now - 60000, updated_at: now - 60000 });

const ROOM = { id: "r1", name: "测试群", purpose: "", managerId: "a1", caps: { maxTurns: 6, maxDepth: 2, perAgent: 2, followup: true }, unread: 0, paused: null, members: [{ agentId: "a1", name: "测试助理", avatar: "测", color: "#3b82f6", left: false, deleted: false, scope: "user", status: "idle" }], last: null, created_at: now, updated_at: now, state: { running: false, current: null, queue: [] } };
const ROOMMSGS = [mkMsg({ id: "ru1", agent_id: "", room_id: "r1", role: "user", content: "大家看下", seq: 1, created_at: now - 1000, updated_at: now - 1000 }), mkMsg({ id: "ra1", room_id: "r1", role: "assistant", content: "收到", seq: 2, created_at: now, updated_at: now })];

let failed = 0;
const check = (name, cond, detail = "") => {
	if (cond) console.log(`  ✅ ${name}`);
	else {
		failed++;
		console.error(`  ❌ ${name} ${detail}`);
	}
};

async function installRoutes(context, state) {
	await context.route("**/api/**", async (route) => {
		const req = route.request();
		const p = new URL(req.url()).pathname;
		const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
		const delay = (ms) => new Promise((r) => setTimeout(r, ms));
		if (p === "/api/system") return json(system());
		if (p === "/api/system/public") return json({});
		if (p === "/api/agents" && req.method() === "GET") return json([AGENT("a1", "测试助理"), AGENT("a2", "另一个助理")]);
		if (p === "/api/rooms") return json([ROOM]);
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
		if (p === "/api/agents/a1/computer" || p === "/api/agents/a2/computer") return json({ separate: false, hasData: null, desktop: { enabled: false, state: "off" } });
		// 有界定位：GET /api/messages/:mid/context?limit=50&conversationId=
		const loc = /^\/api\/messages\/([^/]+)\/context$/.exec(p);
		if (loc) {
			const id = decodeURIComponent(loc[1]);
			state.locate.push(id);
			await delay(120);
			if (id === "m-gone") return json({ error: "not_found" }, 404);
			return json([MOLD]);
		}
		if (p === "/api/agents/a1/messages" || p === "/api/agents/a2/messages") {
			if (req.method() === "POST") {
				state.sent.push(JSON.parse(req.postData() ?? "{}"));
				if (state.failSend) return json({ error: "网络不可用" }, 500);
				return json({ id: "sent", agent_id: "a1", conversation_id: "c1", role: "user", content: "", meta: {}, status: "done", created_at: Date.now(), updated_at: Date.now() });
			}
			const conv = new URL(req.url()).searchParams.get("conversation");
			if (p.startsWith("/api/agents/a2")) return json(conv === "c2b" ? [mkMsg({ id: "b2", agent_id: "a2", content: "另一个助理的消息", conversation_id: "c2b" })] : []);
			return json(conv === "c2" ? [] : [U1, A1, TOOL, A2, A3, A4]);
		}
		if (p === "/api/agents/a1/conversations" && req.method() === "GET") return json({ current: state.conv, items: [{ id: "c1", agent_id: "a1", title: "第一段对话", created_at: now, updated_at: now, message_count: 6, last: "报告" }, { id: "c2", agent_id: "a1", title: "第二段对话", created_at: now, updated_at: now, message_count: 0, last: null }] });
		if (p === "/api/agents/a2/conversations" && req.method() === "GET") return json({ current: "c2b", items: [{ id: "c2b", agent_id: "a2", title: "另一个对话", created_at: now, updated_at: now, message_count: 1, last: "你好" }] });
		if (p === "/api/agents/a1/conversations" && req.method() === "POST") {
			state.conv = "c2";
			return json({ id: "c2", agent_id: "a1", title: "第二段对话", created_at: now, updated_at: now, message_count: 0, last: null });
		}
		if (/\/api\/agents\/a1\/conversations\/(c1|c2)\/select$/.test(p)) {
			state.conv = p.includes("/c2/") ? "c2" : "c1";
			return json({});
		}
		if (p.endsWith("/conversations/c2b/select")) return json({});
				if (p.startsWith("/api/subagents")) return json([]);
		if (p === "/api/rooms/r1/messages" && req.method() === "GET") return json(ROOMMSGS);
		if (p === "/api/rooms/r1/messages" && req.method() === "POST") {
			state.roomSent.push(JSON.parse(req.postData() ?? "{}"));
			return json({});
		}
		if (p.endsWith("/read")) return json({});
		if (p === "/api/rooms/r1/stop" || p.startsWith("/api/agents/a1/abort")) return json({});
		return json({});
	});
}

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let browser;
try {
	browser = await chromium.launch({ executablePath: CHROME, headless: true });
	const state = { sent: [], roomSent: [], locate: [], failSend: false, conv: "c1" };
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
	await installRoutes(ctx, state);
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.error("  ⚠️ pageerror", String(e).slice(0, 300)));
	await page.goto(`${base}/?agent=a1`);
	await page.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });

	console.log("\n── 可见入口 ──");
	// 可引用消息：u1 + a1m + a2m + a3m + a4m = 5；工具步骤不算
	const btns = page.locator('[data-testid="quote-btn"]');
	check("每条可引用消息都有可见「引用」按钮（5 条）", (await btns.count()) === 5, `实际 ${await btns.count()}`);
	check("按钮默认可见（非 hover-only）", await btns.first().isVisible());
	check("工具步骤没有引用按钮", (await page.locator('[data-testid="steps"] [data-testid="quote-btn"]').count()) === 0);
	check("按钮有 aria-label + title", (await btns.first().getAttribute("aria-label")) === "引用这条消息" && (await btns.first().getAttribute("title")) === "引用这条消息");

	console.log("\n── 桌面右键（辅助入口，不拦链接） ──");
	await page.locator('[data-mid="a1m"] .pa-bubble').click({ button: "right" });
	await page.locator('[data-testid="reply-menu"]').waitFor({ timeout: 5000 });
	check("消息空白处右键弹出引用菜单", await page.locator('[data-testid="reply-menu-quote"]').isVisible());
	await page.keyboard.press("Escape");
	check("Esc 关闭右键菜单", (await page.locator('[data-testid="reply-menu"]').count()) === 0);
	const linkMenuBefore = await page.locator('[data-testid="reply-menu"]').count();
	await page.locator('[data-mid="a1m"] .pa-bubble a').click({ button: "right" });
	await page.waitForTimeout(200);
	check("右键链接不被接管（保留原生菜单）", (await page.locator('[data-testid="reply-menu"]').count()) === linkMenuBefore);

	console.log("\n── 引用条 / Esc / 发送 payload ──");
	await page.locator('[data-mid="a2m"] [data-testid="quote-btn"]').click();
	await page.locator('[data-testid="quote-bar"]').waitFor({ timeout: 5000 });
	check("点引用出现引用条", await page.locator('[data-testid="quote-bar"]').isVisible());
	check("引用条显示作者 / 目标", (await page.locator('[data-testid="quote-bar"]').textContent())?.includes("回复给 测试助理"));
	check("引用条显示 1–2 行摘录", (await page.locator('[data-testid="quote-excerpt"]').count()) >= 1 || (await page.locator('[data-testid="quote-jump"]').count()) >= 1);
	// 引用附件消息：显示文件名摘要
	await page.locator('[data-mid="u1"] [data-testid="quote-btn"]').click();
	check("引用附件消息显示文件名摘要", (await page.locator('[data-testid="quote-file"]').textContent())?.includes("报告.pdf"));
	await page.locator('[data-testid="quote-cancel"]').click();
	check("点 X 取消引用", (await page.locator('[data-testid="quote-bar"]').count()) === 0);

	// Esc 只清引用，不清草稿
	await page.locator('[data-mid="a2m"] [data-testid="quote-btn"]').click();
	const ta = page.locator("main textarea").first();
	await ta.fill("这是要保留的草稿");
	await ta.press("Escape");
	check("Esc 取消引用但保留草稿文字", (await page.locator('[data-testid="quote-bar"]').count()) === 0 && (await ta.inputValue()) === "这是要保留的草稿");

	// 发送带 replyToId
	await ta.fill("");
	await page.locator('[data-mid="a2m"] [data-testid="quote-btn"]').click();
	await ta.fill("带引用的消息");
	await ta.press("Enter");
	await page.waitForTimeout(300);
	const last = state.sent.at(-1);
	check("发送 payload 带 replyToId", last?.replyToId === "a2m", JSON.stringify(last));
	check("发送 payload 带幂等 clientId", typeof last?.clientId === "string" && last.clientId.length > 8, JSON.stringify(last));
	check("发送成功后引用条清空", (await page.locator('[data-testid="quote-bar"]').count()) === 0);

	// 发送失败：保留引用 + 草稿
	state.failSend = true;
	await page.locator('[data-mid="a2m"] [data-testid="quote-btn"]').click();
	await ta.fill("失败也要保留");
	await ta.press("Enter");
	await page.locator('[data-testid="send-error"]').waitFor({ timeout: 5000 });
	check("发送失败保留引用", (await page.locator('[data-testid="quote-bar"]').count()) === 1);
	check("发送失败还原草稿文字", (await ta.inputValue()) === "失败也要保留");
	state.failSend = false;
	await page.locator('[data-testid="quote-cancel"]').click();

	console.log("\n── 跳回原消息 ──");
	// 已加载：点已发送消息里的引用块 → 高亮
	await page.locator('[data-mid="a2m"] [data-testid="quoted-block"]').click();
	await page.waitForTimeout(200);
	check("点引用块跳回并高亮原消息", (await page.locator('[data-mid="u1"].pa-msg-flash').count()) === 1);
	// 未加载：locate → loading → 插入 + 高亮
	await page.locator('[data-mid="a3m"] [data-testid="quoted-block"]').click();
	await page.waitForTimeout(30);
	const loading = (await page.locator('[data-testid="quote-jump-state"][data-state="loading"]').count()) === 1;
	await page.locator('[data-mid="m-old"]').waitFor({ timeout: 5000 });
	check("未加载消息经 bounded locate 定位（先 loading）", loading);
	await page.locator('[data-mid="m-old"].pa-msg-flash').waitFor({ timeout: 3000 });
	check("定位到的消息插入并高亮", (await page.locator('[data-mid="m-old"].pa-msg-flash').count()) === 1);
	check("locate 只请求目标消息（不加载全历史）", state.locate.at(-1) === "m-old");
	// 已删除：提示 + 重试
	await page.locator('[data-mid="a4m"] [data-testid="quoted-block"]').click();
	await page.locator('[data-testid="quote-jump-state"][data-state="notfound"]').waitFor({ timeout: 5000 });
	check("引用已删除消息显示明确提示（不白屏 / 不死 loading）", (await page.locator('[data-testid="quote-jump-state"]').textContent())?.includes("已删除"));
	const before = state.locate.length;
	await page.locator('[data-testid="quote-jump-retry"]').click();
	await page.waitForTimeout(300);
	check("notfound 可重试", state.locate.length > before);

	console.log("\n── draft 隔离（对话 / 群） ──");
	await page.screenshot({ path: join(OUT, "desktop-quote.png") });
	// 在 c1 引用
	await page.locator('[data-mid="a2m"] [data-testid="quote-btn"]').click();
	check("c1 有引用 draft", (await page.locator('[data-testid="quote-bar"]').count()) === 1);
	// 切到 a2 → 不串
	await page.locator('[data-testid="sidebar-agent"]', { hasText: "另一个助理" }).first().click();
	await page.waitForTimeout(200);
	check("切到别的助理不显示 c1 的引用", (await page.locator('[data-testid="quote-bar"]').count()) === 0);
	await page.locator('[data-testid="sidebar-agent"]', { hasText: "测试助理" }).first().click();
	await page.waitForTimeout(200);
	check("切回助理恢复自己的引用 draft", (await page.locator('[data-testid="quote-bar"]').count()) === 1);
	// 切对话 → 不串
	await page.locator('[data-testid="conv-menu"]').click();
	await page.locator('[role="menu"]').waitFor({ timeout: 5000 });
	await page.locator('[role="menu"] button', { hasText: "新对话" }).click();
	await page.locator('[role="menu"]').waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
	await page.waitForTimeout(300);
	check("切到新对话不显示 c1 的引用", (await page.locator('[data-testid="quote-bar"]').count()) === 0, `menu=${await page.locator('[data-testid="conv-menu"]').textContent()}`);
	await page.locator('[data-testid="conv-menu"]').click();
	await page.locator('[role="menu"] li', { hasText: "第一段对话" }).first().click();
	await page.waitForTimeout(300);
	check("切回 c1 恢复引用 draft", (await page.locator('[data-testid="quote-bar"]').count()) === 1);
	await page.locator('[data-testid="quote-cancel"]').click();

	// 群聊：引用助理 → 回复给该助理；群 draft 与单聊不串
	await page.locator('[data-testid="sidebar-room"]').first().click();
	await page.locator('[data-mid="ra1"]').waitFor({ timeout: 10_000 });
	check("切到群聊不显示单聊的引用", (await page.locator('[data-testid="quote-bar"]').count()) === 0);
	await page.locator('[data-mid="ra1"] [data-testid="quote-btn"]').click();
	await page.locator('[data-testid="quote-bar"]').waitFor({ timeout: 5000 });
	check("群聊引用助理显示「回复给 测试助理」（无 @ 只该助理）", (await page.locator('[data-testid="quote-bar"]').textContent())?.includes("回复给 测试助理"));
	await page.screenshot({ path: join(OUT, "room-quote.png") });
	await page.locator('[data-testid="quote-cancel"]').click();
	await page.locator('[data-testid="sidebar-agent"]', { hasText: "测试助理" }).first().click();
	await page.waitForTimeout(200);
	check("切回单聊不显示群的引用", (await page.locator('[data-testid="quote-bar"]').count()) === 0);

	console.log("\n── 长按（辅助入口，移动取消） ──");
	await page.locator('[data-mid="a1m"] .pa-bubble').waitFor();
	await page.dispatchEvent('[data-mid="a1m"] .pa-bubble', "pointerdown", { pointerType: "touch", button: 0, pointerId: 1, isPrimary: true, clientX: 300, clientY: 300 });
	await page.waitForTimeout(650);
	check("长按弹出引用菜单", (await page.locator('[data-testid="reply-menu"]').count()) === 1);
	await page.dispatchEvent('[data-mid="a1m"] .pa-bubble', "pointerup", { pointerType: "touch", pointerId: 1 });
	await page.keyboard.press("Escape");
	await page.dispatchEvent('[data-mid="a1m"] .pa-bubble', "pointerdown", { pointerType: "touch", button: 0, pointerId: 2, isPrimary: true, clientX: 300, clientY: 300 });
	await page.dispatchEvent('[data-mid="a1m"] .pa-bubble', "pointermove", { pointerType: "touch", pointerId: 2, clientX: 340, clientY: 340 });
	await page.waitForTimeout(650);
	check("长按移动（滚动 / 选择）取消，不误触菜单", (await page.locator('[data-testid="reply-menu"]').count()) === 0);
	await page.dispatchEvent('[data-mid="a1m"] .pa-bubble', "pointerup", { pointerType: "touch", pointerId: 2 });

	console.log("\n── 390 窄屏 ──");
	const ctx2 = await browser.newContext({ viewport: { width: 390, height: 700 }, locale: "zh-CN", hasTouch: true });
	await installRoutes(ctx2, state);
	const p2 = await ctx2.newPage();
	await p2.goto(`${base}/?agent=a1`);
	await p2.locator('[data-mid="a1m"]').waitFor({ timeout: 20_000 });
	check("390 引用按钮可见", await p2.locator('[data-testid="quote-btn"]').first().isVisible());
	await p2.locator('[data-mid="a2m"] [data-testid="quote-btn"]').click();
	await p2.locator('[data-testid="quote-bar"]').waitFor({ timeout: 5000 });
	const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
	check("390 引用条不横向溢出", overflow <= 1, `overflow=${overflow}`);
	const pad = await p2.evaluate(() => { const s = document.querySelector(".pa-scroll"); return s ? parseInt(getComputedStyle(s).paddingBottom) : 0; });
	check("390 引用条抬高后底部留白同步（最后一条不被遮）", pad > 100, `padding=${pad}`);
	await p2.screenshot({ path: join(OUT, "mobile-390-quote.png") });

	console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
	process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
	console.error("运行失败：", e);
	process.exitCode = 1;
} finally {
	await browser?.close();
	web.close();
}
