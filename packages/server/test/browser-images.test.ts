/**
 * ext-browser：被遮罩挡住的元素也能点到（强制点击/坐标点击兜底）；browser_save_image 用浏览器下载原图（必应 m.murl），
 * 防盗链（要 Referer + Cookie）也能下；取不到原图时存缩略图；都失败时截取元素。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
const { browserExtension } = await import("@pi-assistant/ext-browser");
const { browserFor, closeAllBrowsers, findChrome } = await import("../src/browser.ts");
const { config } = await import("../src/config.ts");

const chrome = findChrome();
// 1x1 PNG 放大成 >200 字节（加 tEXt 填充）
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f20000000049454e44ae426082", "hex"), Buffer.alloc(400)]);
const srv = createServer((req, res) => {
	const u = req.url ?? "/";
	if (u.startsWith("/full.png")) {
		// 防盗链：必须带来源页 Referer 和页面设置的 Cookie
		if (!String(req.headers.referer ?? "").includes("/images") || !String(req.headers.cookie ?? "").includes("sid=1")) return (res.writeHead(403), res.end("forbidden"));
		return (res.writeHead(200, { "content-type": "image/png" }), res.end(PNG));
	}
	if (u.startsWith("/thumb.png")) return (res.writeHead(200, { "content-type": "image/png" }), res.end(PNG));
	if (u.startsWith("/broken")) return (res.writeHead(404), res.end());
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "sid=1; Path=/" });
	res.end(`<!doctype html><title>图片搜索</title>
		<div id="cover" style="position:fixed;inset:0;background:rgba(0,0,0,.01);z-index:9"></div>
		<a class="iusc" href="#" onclick="document.title='点开了';return false" m='{"murl":"/full.png","turl":"/thumb.png"}'><img src="/thumb.png" width="120" height="90" alt="穿越火线 2008"></a>
		<a href="#"><img src="/thumb.png?2" width="120" height="90" alt="只有缩略图"></a>
		<div><img src="/broken.png" width="120" height="90" alt="坏图" style="background:red"></div>`);
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const ws = join(config.workspaceRoot, "browser-img-test");
mkdirSync(ws, { recursive: true });

test("ext-browser：遮罩下点击兜底 + 保存图片", { skip: !chrome && "没有 Chrome" }, async () => {
	const tools = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[] }> }>();
	browserExtension({ workspace: ws, context: async () => (await browserFor("bit")).ctx, mode: () => "host", isPaused: () => false, request: async () => ({ approved: true }), handoff: async () => "" })({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on() {} } as never);
	const call = async (n: string, p: Record<string, unknown> = {}) => (await tools.get(n)!.execute("id", p)).content.map((c) => c.text ?? `[${c.type}]`).join("\n");
	const ref = (label: RegExp, s: string) => (s.split("\n").find((l) => label.test(l))?.match(/\[ref=(\w+)\]/) ?? [])[1];
	const nav = await call("browser_navigate", { url: `${BASE}/images` });
	assert.match(nav, /img "穿越火线 2008" \[ref=e\d+\]/, "图片有编号");
	// 遮罩挡住了链接：正常点击超时 → 兜底点到
	const clicked = await call("browser_click", { ref: ref(/link .*穿越火线|link "穿越火线/, nav) ?? ref(/穿越火线/, nav) });
	assert.match(clicked, /已点击/);
	assert.match(clicked, /正常点击失败/);
	// 原图（m.murl），带 Referer + Cookie
	const s1 = await call("browser_save_image", { ref: ref(/img "穿越火线 2008"/, nav), name: "cf" });
	assert.match(s1, /已保存原图到工作区：images\/cf\.png/, s1);
	assert.ok(existsSync(join(ws, "images", "cf.png")));
	assert.equal(readFileSync(join(ws, "images", "cf.png")).length, PNG.length);
	// 没有原图线索 → 存页面上的图
	const s2 = await call("browser_save_image", { ref: ref(/img "只有缩略图"/, nav) });
	assert.match(s2, /已保存页面上的图片/);
	// 下载失败 → 截取元素
	const s3 = await call("browser_save_image", { ref: ref(/img "坏图"/, nav), name: "bad" });
	assert.match(s3, /已截取该元素/);
	assert.ok(existsSync(join(ws, "images", "bad.png")));
	await closeAllBrowsers();
	srv.close();
});
