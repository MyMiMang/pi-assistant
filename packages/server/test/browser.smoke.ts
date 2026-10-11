/**
 * 助理电脑里的浏览器冒烟测试（需要 Docker 与 pi-assistant/desktop 镜像，不在默认 npm test 里）：
 *   PIA_DOCKER="sudo docker" node --import tsx test/browser.smoke.ts
 * 验证：容器启动 → 浏览器以有界面方式在助理电脑里打开（CDP 连接）→ ext-browser 打开网页、输入、大纲 →
 * 整屏截图里能看到浏览器窗口（即「电脑」实时画面里可见）→ 断开重连后浏览器与标签页仍在（只断开、不关闭）。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserExtension } from "@pi-assistant/ext-browser";
import { browserFor, closeAllBrowsers } from "../src/browser.ts";
import { config } from "../src/config.ts";
import { containerOf, screenshotDesktop, startDesktop, stopDesktop } from "../src/desktop.ts";

const AGENT = "bsmoke";
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
await startDesktop(AGENT);
log("助理电脑已启动");
const tools = new Map<string, { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[] }> }>();
browserExtension({ workspace: config.workspaceRoot, context: async () => (await browserFor(AGENT)).ctx, mode: () => "sandbox", isPaused: () => false, request: async () => ({ approved: false }), handoff: async () => "已完成" })({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on() {} } as never);
const call = async (n: string, p: Record<string, unknown> = {}) => (await tools.get(n)!.execute("id", p)).content.map((c) => c.text ?? `[${c.type}]`).join("\n");
try {
	const html = encodeURIComponent(`<title>助理的浏览器</title><h1 style="font:48px sans-serif">你好，我是助理的浏览器</h1><input placeholder="搜索" style="font-size:24px">`);
	const nav = await call("browser_navigate", { url: `data:text/html;charset=utf-8,${html}` });
	assert.match(nav, /heading "你好，我是助理的浏览器"/);
	assert.equal((await browserFor(AGENT)).mode, "sandbox");
	log("ext-browser 已通过 CDP 连上助理电脑里的 Chromium");
	const ref = nav.split("\n").find((l) => l.includes('textbox "搜索"'))?.match(/\[ref=(\w+)\]/)?.[1];
	assert.ok(ref);
	assert.match(await call("browser_type", { ref, text: "Pi Assistant" }), /value="Pi Assistant"/);
	await call("browser_navigate", { url: "https://example.com" }).then((r) => log(r.includes("Example Domain") ? "外网网页可打开" : `外网不可达（${r.split("\n")[0]}）`));
	await call("browser_navigate", { url: "back" });
	await new Promise((r) => setTimeout(r, 800));
	const png = await screenshotDesktop(AGENT);
	const out = join(import.meta.dirname, "../../../docs/screenshots/40-browser-in-desktop.png");
	writeFileSync(out, png);
	log(`整屏截图（电脑实时画面）→ ${out}`);
	// 断开重连：浏览器和用户目录都还在
	await closeAllBrowsers();
	const ctx = (await browserFor(AGENT)).ctx;
	log(`重连后标签页 ${ctx.pages().length} 个：${ctx.pages()[0].url().slice(0, 40)}`);
	assert.ok(ctx.pages().length >= 1);
	log("✓ 通过");
} finally {
	await closeAllBrowsers();
	await stopDesktop(AGENT);
	await import("node:child_process").then(({ execFileSync }) => execFileSync(config.docker[0], [...config.docker.slice(1), "rm", "-f", containerOf(AGENT)], { stdio: "ignore" }));
}
