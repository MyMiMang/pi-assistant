/**
 * HTML 网页预览的服务端部分（设计：docs/design/html-file-preview.md）：
 * view-link 接口、/hooks/dl/...?view=1 的响应头（CSP 含 sandbox、不发 X-Frame-Options: DENY、只对 HTML 文件按页面返回）、
 * /api/* 收到 Origin: null 被拒、其他页面的安全头不变。
 * 起真实服务进程（内存凭据、Mock、临时数据目录，同 media-range-http）；不碰真实数据目录 / 钥匙串 / 付费模型。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { previewKind } from "../../../apps/web/src/preview.ts";
const { isHtmlFile, HTML_VIEW_CSP } = await import("../src/routes/common.ts");

const serverDir = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "pia-html-view-"));
const port = 29000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
let srv: ReturnType<typeof spawn> | undefined;
let out = "";
const HTML = "<!doctype html><title>t</title><h1>你好</h1><script>document.title=1</script>";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>';
let htmlId = "";
let svgId = "";
let txtId = "";

const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

before(async () => {
	srv = spawn(process.execPath, ["--import", "tsx", "test/launch-memory.ts"], {
		cwd: serverDir,
		env: { ...process.env, PIA_DATA_DIR: dataDir, PIA_WORKSPACE: join(dataDir, "workspace"), PIA_PORT: String(port), PIA_MOCK: "1", PIA_OFFLINE: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	srv.stdout?.on("data", (d) => (out += d));
	srv.stderr?.on("data", (d) => (out += d));
	const end = Date.now() + 30_000;
	for (;;) {
		try {
			if ((await get("/api/system")).status === 200) break;
		} catch {
			/* 未就绪 */
		}
		if (Date.now() > end) throw new Error(`服务未就绪：\n${out.slice(-2500)}`);
		await new Promise((r) => setTimeout(r, 120));
	}
	const a = await (await fetch(`${base}/api/agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "媒体测试" }) })).json();
	const up = async (name: string, body: string) => {
		const fd = new FormData();
		fd.append("file", new File([body], name));
		return ((await (await fetch(`${base}/api/agents/${a.id}/upload`, { method: "POST", body: fd })).json()) as { fileId: string }).fileId;
	};
	htmlId = await up("report.html", HTML);
	svgId = await up("pic.svg", SVG);
	txtId = await up("notes.txt", "hello");
});
after(() => srv?.kill("SIGKILL"));

const linkOf = async (id: string) => ((await (await get(`/api/files/${id}/view-link`)).json()) as { url: string }).url;

test("view-link：10 分钟内有效的签名链接，带 ?view=1", async () => {
	const r = await get(`/api/files/${htmlId}/view-link`);
	assert.equal(r.status, 200);
	const { url } = (await r.json()) as { url: string };
	assert.match(url, /^\/hooks\/dl\/[^/]+\/\d+\/[\w-]+\?view=1$/);
	const exp = Number(url.split("/")[4]) * 1000;
	assert.ok(exp > Date.now() && exp - Date.now() <= 10 * 60_000 + 5_000, "有效期不超过 10 分钟");
	assert.equal((await get("/api/files/nope/view-link")).status, 404);
});

test("?view=1 的 HTML：按页面返回，CSP 含 sandbox，不发 X-Frame-Options，不是 attachment", async () => {
	const r = await get(await linkOf(htmlId));
	assert.equal(r.status, 200);
	assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
	assert.equal(r.headers.get("content-disposition"), null);
	const csp = r.headers.get("content-security-policy") ?? "";
	assert.match(csp, /^sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads;/);
	assert.ok(!/allow-same-origin/.test(csp), "绝不给 allow-same-origin");
	assert.match(csp, /connect-src https: data: blob:;/);
	assert.ok(!/http:|127\.0\.0\.1|'self'/.test(csp.replace("frame-ancestors 'self'", "")), "只放行 https:，不放行 http / 本机");
	assert.match(csp, /frame-ancestors 'self'$/);
	assert.match(csp, /form-action 'none'; base-uri 'none'/);
	assert.equal(r.headers.get("x-frame-options"), null);
	assert.equal(r.headers.get("referrer-policy"), "no-referrer");
	assert.equal(r.headers.get("x-content-type-options"), "nosniff");
	assert.equal(await r.text(), HTML);
});

test("没有 ?view=1：HTML 仍是下载，带全局安全头（CSP 非 sandbox 那条 + DENY）", async () => {
	const url = (await linkOf(htmlId)).replace("?view=1", "");
	const r = await get(url);
	assert.equal(r.status, 200);
	assert.match(r.headers.get("content-disposition") ?? "", /^attachment/);
	assert.equal(r.headers.get("x-frame-options"), "DENY");
	assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
	await r.arrayBuffer();
});

test("?view=1 对非 HTML（svg / txt）不按页面返回：照旧下载 + 全局安全头", async () => {
	for (const id of [svgId, txtId]) {
		const r = await get(await linkOf(id));
		assert.equal(r.status, 200);
		assert.match(r.headers.get("content-disposition") ?? "", /^attachment/);
		assert.equal(r.headers.get("x-frame-options"), "DENY");
		assert.ok(!(r.headers.get("content-security-policy") ?? "").includes("sandbox"));
		await r.arrayBuffer();
	}
});

test("view 链接签名被篡改 / 换文件 → 403", async () => {
	const url = await linkOf(htmlId);
	const bad = await get(url.replace(/\/[\w-]+\?view=1$/, "/deadbeef?view=1"));
	assert.equal(bad.status, 403);
	await bad.arrayBuffer();
	const swapped = await get(url.replace(`/hooks/dl/${encodeURIComponent(htmlId)}/`, `/hooks/dl/${encodeURIComponent(txtId)}/`));
	assert.equal(swapped.status, 403);
	await swapped.arrayBuffer();
});

test("/api/* 收到 Origin: null → 403（本机免登录也一样）；正常请求和同源 Origin 不受影响", async () => {
	const r = await get("/api/system", { origin: "null" });
	assert.equal(r.status, 403);
	await r.arrayBuffer();
	const post = await fetch(`${base}/api/agents`, { method: "POST", headers: { origin: "null", "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
	assert.equal(post.status, 403);
	await post.arrayBuffer();
	const ok = await get("/api/system");
	assert.equal(ok.status, 200);
	await ok.arrayBuffer();
	const same = await get("/api/system", { origin: base });
	assert.equal(same.status, 200);
	await same.arrayBuffer();
});

test("普通页面 / API 的安全头不变", async () => {
	const api = await get("/api/system");
	assert.equal(api.headers.get("x-frame-options"), "DENY");
	assert.equal(api.headers.get("content-security-policy"), null);
	await api.arrayBuffer();
	const page = await get("/");
	assert.equal(page.headers.get("x-frame-options"), "DENY");
	assert.equal(page.headers.get("referrer-policy"), "no-referrer");
	assert.equal(page.headers.get("x-content-type-options"), "nosniff");
	assert.equal(
		page.headers.get("content-security-policy"),
		"default-src 'self'; script-src 'self' blob:; object-src 'self' blob:; frame-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'none'",
	);
	await page.arrayBuffer();
});

test("isHtmlFile 与前端 previewKind 的 html 判定一致", () => {
	const cases: [string, string, boolean][] = [
		["a.html", "text/html", true], ["a.HTM", "application/octet-stream", true], ["a.xhtml", "", true],
		["noext", "text/html; charset=utf-8", true], ["noext", "application/xhtml+xml", true],
		["a.svg", "image/svg+xml", false], ["a.txt", "text/plain", false], ["a.hta", "application/hta", false], ["a.js", "text/javascript", false],
	];
	for (const [n, m, want] of cases) {
		assert.equal(isHtmlFile(n, m), want, `${n} ${m}`);
		assert.equal(previewKind(n, m) === "html", want, `previewKind ${n} ${m}`);
	}
});

test("previewKind：SVG 单独成 svg；hta / 老格式 Office / 非 zip 压缩包仍 unsupported；其余类型不变", () => {
	assert.equal(previewKind("a.svg"), "svg");
	assert.equal(previewKind("noext", "image/svg+xml"), "svg");
	assert.equal(previewKind("a.html"), "html");
	assert.equal(previewKind("a.htm"), "html");
	assert.equal(previewKind("a.xhtml", "application/xhtml+xml"), "html");
	assert.equal(previewKind("x", "text/html; charset=utf-8"), "html");
	for (const n of ["a.hta", "a.doc", "a.xls", "a.ppt", "a.7z", "a.exe"]) assert.equal(previewKind(n), "unsupported", n);
	assert.equal(previewKind("a.md"), "markdown");
	assert.equal(previewKind("a.png"), "image");
	assert.equal(previewKind("a.js"), "code");
	assert.equal(previewKind("a.txt"), "text");
});

test("e2e/file-preview.mjs 模拟页面用的 CSP 与服务端 HTML_VIEW_CSP 逐字一致", () => {
	const e2e = readFileSync(join(import.meta.dirname, "../../../e2e/file-preview.mjs"), "utf8");
	assert.ok(e2e.includes(JSON.stringify(HTML_VIEW_CSP)), "e2e 里的 HTML_VIEW_CSP 与 routes/common.ts 不一致");
});
