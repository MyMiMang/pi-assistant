/**
 * ext-browser（本机无头 Chromium 模式）：打开网页 → 大纲带编号 → 输入/选择/勾选 → 普通点击不审批 →
 * 提交表单要审批（拒绝即停；“本任务内都允许”后不再问）→ 下载进工作区 → 上传要审批 → 标签页 → 子框架 → 暂停 → 持久化用户目录。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
const { browserExtension } = await import("@pi-assistant/ext-browser");
const { browserFor, closeAllBrowsers, findChrome, profileDir } = await import("../src/browser.ts");
const { config } = await import("../src/config.ts");

const chrome = findChrome();
const PAGES: Record<string, string> = {
	"/": `<!doctype html><title>测试商店</title><h1>欢迎</h1><p>这是一段说明文字。</p>
		<a href="/next">下一页</a> <a href="/next" target="_blank">新窗口打开</a>
		<form action="/order" method="post"><label for="q">收货人</label><input id="q" name="q" placeholder="姓名">
		<select name="city" aria-label="城市"><option>北京</option><option>上海</option></select>
		<label><input type="checkbox" name="agree"> 同意条款</label>
		<input type="file" name="f" aria-label="附件">
		<button type="submit">提交订单</button></form>
		<button onclick="document.title='点过了'">普通按钮</button>
		<a href="/file.txt" download>下载说明书</a>
		<iframe src="/frame" width="300" height="100"></iframe>`,
	"/next": `<!doctype html><title>第二页</title><h2>第二页</h2>`,
	"/frame": `<!doctype html><button>框架里的按钮</button>`,
	"/order": `<!doctype html><title>下单成功</title><p>已下单</p>`,
};
const posts: string[] = [];
const srv = createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	if (req.method === "POST") posts.push(`${req.url} ${body.slice(0, 200)}`);
	if (req.url === "/file.txt") return (res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="manual.txt"' }), res.end("说明书内容"));
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(PAGES[req.url?.split("?")[0] ?? "/"] ?? "<title>404</title>");
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

const ws = join(config.workspaceRoot, "browser-test");
mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, "a.txt"), "附件");

test("ext-browser：本机无头浏览器全流程", { skip: !chrome && "没有 Chrome" }, async () => {
	const tools = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[] }> }>();
	const asks: { summary: string; allowTask?: boolean }[] = [];
	let answer: { approved: boolean; scope?: "task" } = { approved: false };
	let paused = false;
	browserExtension({
		workspace: ws,
		context: async () => (await browserFor("bt")).ctx,
		mode: () => "host",
		isPaused: () => paused,
		request: async (r) => (asks.push(r), answer),
		handoff: async () => "已完成",
	})({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on() {} } as never);
	const call = async (n: string, p: Record<string, unknown> = {}) => (await tools.get(n)!.execute("id", p)).content.map((c) => c.text ?? `[${c.type}]`).join("\n");

	const nav = await call("browser_navigate", { url: BASE });
	assert.match(nav, /页面：测试商店/);
	assert.match(nav, /heading "欢迎"/);
	assert.match(nav, /text "这是一段说明文字。"/);
	const ref = (label: RegExp, s: string) => (s.split("\n").find((l) => label.test(l))?.match(/\[ref=(\w+)\]/) ?? [])[1];
	const snap = await call("browser_snapshot");
	assert.match(snap, /\[image\]/, "附截图");
	assert.match(snap, /button "提交订单" \[ref=e\d+\] \(提交表单\)/);
	assert.match(snap, /子框架 f1/);
	assert.ok(ref(/框架里的按钮/, snap)?.startsWith("f1e"), "子框架编号");
	// 输入 / 选择 / 勾选
	await call("browser_type", { ref: ref(/textbox "收货人"/, snap), text: "张三" });
	await call("browser_select", { ref: ref(/combobox "城市"/, snap), values: ["上海"] });
	const s2 = await call("browser_select", { ref: ref(/checkbox/, snap), values: ["on"] });
	assert.match(s2, /textbox "收货人" \[ref=\w+\] value="张三"/);
	assert.match(s2, /combobox "城市" \[ref=\w+\] value="上海"/);
	assert.match(s2, /checkbox .*\(已选\)/);
	// 普通按钮不审批
	await call("browser_click", { ref: ref(/button "普通按钮"/, s2) });
	assert.equal(asks.length, 0);
	// 上传：要审批（先拒绝）
	const s3 = await call("browser_snapshot", { screenshot: false });
	const up1 = await call("browser_upload", { ref: ref(/file "附件"/, s3), paths: ["a.txt"] });
	assert.match(up1, /用户拒绝/);
	assert.equal(asks.at(-1)?.allowTask, true);
	assert.match(await call("browser_upload", { ref: ref(/file "附件"/, s3), paths: ["../../etc/passwd"] }), /只能使用工作区里的文件/);
	// 提交订单：拒绝 → 不提交
	const r1 = await call("browser_click", { ref: ref(/提交订单/, s3) });
	assert.match(r1, /用户拒绝.*提交订单|用户拒绝.*付款/);
	assert.equal(posts.length, 0, "拒绝后没有提交");
	// 本任务内都允许 → 提交；之后同类不再问
	answer = { approved: true, scope: "task" };
	const before = asks.length;
	const r2 = await call("browser_click", { ref: ref(/提交订单/, s3) });
	assert.match(r2, /下单成功/);
	assert.equal(posts.length, 1);
	assert.match(posts[0], /q=%E5%BC%A0%E4%B8%89/);
	assert.equal(asks.length, before + 1);
	answer = { approved: false };
	await call("browser_navigate", { url: "back" });
	const s4 = await call("browser_snapshot", { screenshot: false });
	await call("browser_click", { ref: ref(/提交订单/, s4) });
	assert.equal(asks.length, before + 1, "同类动作本任务内不再询问");
	// 下载进工作区
	await call("browser_navigate", { url: BASE });
	const s5 = await call("browser_snapshot", { screenshot: false });
	const dl = await call("browser_download", { ref: ref(/下载说明书/, s5) });
	assert.match(dl, /downloads\/manual\.txt/);
	assert.equal(readFileSync(join(ws, "downloads/manual.txt"), "utf8"), "说明书内容");
	// 新窗口打开的链接自动成为当前页；标签页列表/切换/关闭
	const s6 = await call("browser_snapshot", { screenshot: false });
	await call("browser_click", { ref: ref(/新窗口打开/, s6) });
	let tabs = await call("browser_tabs", { action: "list" });
	assert.match(tabs, /→ \[1\] 第二页/);
	tabs = await call("browser_tabs", { action: "switch", index: 0 });
	assert.match(tabs, /→ \[0\] 测试商店/);
	tabs = await call("browser_tabs", { action: "close", index: 1 });
	assert.doesNotMatch(tabs, /第二页/);
	// 暂停
	paused = true;
	assert.match(await call("browser_snapshot"), /已暂停/);
	paused = false;
	// 每个助理独立的持久化用户目录（在我们的数据目录里）
	assert.ok(profileDir("bt").startsWith(config.dataDir));
	assert.ok(existsSync(join(profileDir("bt"), "Default")) || existsSync(join(profileDir("bt"), "Local State")));
	await closeAllBrowsers();
});

test.after(async () => {
	await closeAllBrowsers();
	srv.close();
});
