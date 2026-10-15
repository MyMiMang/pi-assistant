/**
 * 桌面程序外链左键点击修复的回归测试（页面侧共享处理 + capability 放行 + Rust 兜底白名单）。
 *
 * 测的是 `apps/web/src/externalLinks.ts` 这条真实链路：
 *   markdown 渲染 <a target="_blank"> → 全局 capture click → preventDefault
 *   → invoke plugin:opener|open_url → 失败退回 window.open → 再失败必须给可见反馈。
 *
 * 不启动桌面程序、不读真实配置/凭据、不碰钥匙串；capability 与 Rust 只做静态核对。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { handleExternalClick, inTauri, isExternalHref, type ClickDeps } from "../../../apps/web/src/externalLinks.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PAGE_ORIGIN = "http://127.0.0.1:8787";

/** 造一个「点击了 <a href> 内部子元素」的事件，target 只有 closest 这一个真实能力。 */
function clickOn(href: string, over: Record<string, unknown> = {}) {
	const anchor = { getAttribute: (n: string) => (n === "href" ? href : null) };
	const prevented: string[] = [];
	const ev = {
		button: 0,
		detail: 1,
		defaultPrevented: false,
		target: { closest: (sel: string) => (sel === "a[href]" ? anchor : null) },
		preventDefault: () => prevented.push("preventDefault"),
		...over,
	};
	return { ev, prevented, anchor };
}

/** 记录各条出口调用的假依赖。 */
function deps(over: Partial<ClickDeps> = {}) {
	const calls = { invoke: [] as unknown[][], open: [] as string[], notify: [] as string[], warn: [] as unknown[][] };
	const d: ClickDeps = {
		invoke: async (cmd, args) => {
			calls.invoke.push([cmd, args]);
		},
		open: (url) => {
			calls.open.push(url);
			return {};
		},
		notify: (url) => calls.notify.push(url),
		pageOrigin: PAGE_ORIGIN,
		warn: (msg, err) => calls.warn.push([msg, err]),
		...over,
	};
	return { d, calls };
}

// ---------- Tauri 检测：新版只认 __TAURI_INTERNALS__ ----------

test("生产 Tauri 检测只认 __TAURI_INTERNALS__（window.__TAURI__ 不算）", () => {
	const g = globalThis as unknown as { window?: unknown };
	const prev = g.window;
	try {
		g.window = { __TAURI__: { invoke: async () => {} } }; // 旧版/伪装的全局
		assert.equal(inTauri(), false, "只有 __TAURI__ 不能当成桌面程序，否则普通浏览器也会被接管");
		g.window = { __TAURI_INTERNALS__: {} }; // 有壳没有 invoke
		assert.equal(inTauri(), false);
		g.window = { __TAURI_INTERNALS__: { invoke: async () => {} } };
		assert.equal(inTauri(), true);
	} finally {
		if (prev === undefined) delete g.window;
		else g.window = prev;
	}
});

// ---------- 协议与同源判断 ----------

test("只把 http/https/mailto 外链交给系统浏览器，同源与相对地址保持原生", () => {
	for (const href of ["https://github.com/MyMiMang/pi-assistant", "http://example.com/a?b=1", "mailto:a@b.com", "HTTPS://Example.com"])
		assert.equal(isExternalHref(href, PAGE_ORIGIN), true, href);
	for (const href of [
		"http://127.0.0.1:8787/settings", // 同源（本机界面自己）
		"/api/files/1", // 相对地址
		"#steps",
		"",
		"   ",
		null,
		undefined,
		"javascript:alert(1)",
		"data:text/html,<a>",
		"file:///etc/passwd",
		"blob:http://127.0.0.1:8787/abc",
		"tel:10086",
		"ftp://example.com/x",
	])
		assert.equal(isExternalHref(href, PAGE_ORIGIN), false, String(href));
});

// ---------- 点击链路 ----------

test("桌面程序里左键点 markdown 外链：preventDefault + invoke plugin:opener|open_url，不再走 window.open", async () => {
	const { ev, prevented } = clickOn("https://github.com/MyMiMang/pi-assistant/actions/runs/38703641245");
	const { d, calls } = deps();
	assert.equal(await handleExternalClick(ev, d), "tauri");
	assert.deepEqual(calls.invoke, [["plugin:opener|open_url", { url: "https://github.com/MyMiMang/pi-assistant/actions/runs/38703641245" }]]);
	assert.equal(prevented.length, 1, "必须先阻止 WebView 内嵌导航/新窗口请求");
	assert.deepEqual(calls.open, [], "走通 opener 后不能再 window.open（避免打开两次）");
	assert.deepEqual(calls.notify, []);
});

test("invoke 被 capability 拒绝时退回 window.open，不静默也不误报", async () => {
	const { ev, prevented } = clickOn("https://example.com/x");
	const { d, calls } = deps({
		invoke: async () => {
			throw new Error("opener.open_url not allowed. Permissions associated with this command: opener:allow-open-url");
		},
	});
	assert.equal(await handleExternalClick(ev, d), "browser");
	assert.equal(prevented.length, 1);
	assert.deepEqual(calls.open, ["https://example.com/x"]);
	assert.equal(calls.notify.length, 0, "window.open 成功就不该弹失败提示");
	assert.equal(calls.warn.length, 1, "失败原因要留痕");
});

test("invoke 与 window.open 都失败时必须有可见反馈（带上原地址）", async () => {
	const { ev } = clickOn("https://example.com/only");
	const { d, calls } = deps({
		invoke: async () => {
			throw new Error("denied");
		},
		open: () => null, // 被 popup blocked
	});
	assert.equal(await handleExternalClick(ev, d), "failed");
	assert.deepEqual(calls.notify, ["https://example.com/only"]);
});

test("普通浏览器（没有 __TAURI_INTERNALS__）完全不动原生行为", async () => {
	const { ev, prevented } = clickOn("https://example.com/x");
	const { d, calls } = deps({ invoke: null });
	assert.equal(await handleExternalClick(ev, d), "ignored");
	assert.equal(prevented.length, 0);
	assert.deepEqual(calls.invoke, []);
	assert.deepEqual(calls.open, []);
});

test("右键保留原生菜单、双击第二下、页面已 preventDefault 的都不接管", async () => {
	for (const over of [{ button: 2 }, { detail: 2 }, { defaultPrevented: true }]) {
		const { ev, prevented } = clickOn("https://example.com/x", over);
		const { d, calls } = deps();
		assert.equal(await handleExternalClick(ev, d), "ignored", JSON.stringify(over));
		assert.equal(prevented.length, 0);
		assert.deepEqual(calls.invoke, []);
	}
});

test("中键点击同样交给系统浏览器（桌面程序里没有新标签页）", async () => {
	const { ev } = clickOn("https://example.com/middle", { button: 1 });
	const { d, calls } = deps();
	assert.equal(await handleExternalClick(ev, d), "tauri");
	assert.equal(calls.invoke.length, 1);
});

test("拖动选中链接里的文字后不再打开", async () => {
	const { ev, anchor } = clickOn("https://example.com/x");
	const { d, calls } = deps({ selectionInLink: (a) => a === anchor });
	assert.equal(await handleExternalClick(ev, d), "ignored");
	assert.deepEqual(calls.invoke, []);
});

test("点击目标不是链接（纯文本、同源链接、危险协议）一律不接管", async () => {
	for (const href of ["/api/files/1", "http://127.0.0.1:8787/pet", "javascript:alert(1)", "file:///etc/passwd"]) {
		const { ev, prevented } = clickOn(href);
		const { d, calls } = deps();
		assert.equal(await handleExternalClick(ev, d), "ignored", href);
		assert.equal(prevented.length, 0);
	}
	const { d } = deps();
	const plain = { button: 0, detail: 1, target: { closest: () => null } };
	assert.equal(await handleExternalClick(plain, d), "ignored");
});

// ---------- 真实链路静态核对（capability / Rust 兜底 / markdown 渲染）----------

test("remote-ui capability 真的放行了 opener open_url，且只给 http/https/mailto/tel 范围", () => {
	const cap = JSON.parse(readFileSync(join(ROOT, "apps/tray/src-tauri/capabilities/remote-ui.json"), "utf8")) as {
		windows: string[];
		permissions: string[];
	};
	assert.ok(cap.windows.includes("main"), "主窗口必须在 capability 覆盖范围内");
	assert.ok(cap.permissions.includes("opener:allow-open-url"), "没有这个权限，invoke 会被 ACL 拒绝（就是本次 bug 的根因）");
	assert.ok(cap.permissions.includes("opener:allow-default-urls"), "没有范围，url 会被 scope 判成 ForbiddenUrl");
	// 页面侧的协议白名单必须和 capability 的范围一致：不能放开 javascript/data/file
	const web = readFileSync(join(ROOT, "apps/web/src/externalLinks.ts"), "utf8");
	assert.match(web, /plugin:opener\|open_url/, "页面必须 invoke 这个命令名");
	assert.match(web, /\^\(https\?\|mailto\):/i);
	assert.doesNotMatch(web, /["']tel:["']/);
});

test("Rust 兜底白名单与页面侧一致，且外链失败不再静默吞掉", () => {
	const rs = readFileSync(join(ROOT, "apps/tray/src-tauri/src/main.rs"), "utf8");
	assert.match(rs, /fn is_external_link\(u: &tauri::Url\) -> bool\s*\{\s*matches!\(u\.scheme\(\), "http" \| "https" \| "mailto"\)/);
	// 主窗口的 on_navigation / on_new_window 都用它，并且失败要留日志
	const uses = rs.match(/is_external_link\(/g) ?? [];
	assert.ok(uses.length >= 3, "helper 定义 + on_navigation + on_new_window 都要走白名单");
	assert.doesNotMatch(rs, /let _ = opener\.opener\(\)\.open_url/);
	assert.doesNotMatch(rs, /let _ = opener_nav\.opener\(\)\.open_url/);
});

test("markdown 链接仍然渲染成 target=_blank，共享处理器才接得住", () => {
	const md = readFileSync(join(ROOT, "apps/web/src/components/Markdown.tsx"), "utf8");
	assert.match(md, /target="_blank"/);
	// 入口处必须装上共享处理器
	const main = readFileSync(join(ROOT, "apps/web/src/main.tsx"), "utf8");
	assert.match(main, /installExternalLinkHandling\(\)/);
});
