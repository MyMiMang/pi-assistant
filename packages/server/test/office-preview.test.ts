/**
 * Office / iWork / zip / Jupyter 预览的纯逻辑单测（不碰服务端、不碰用户数据）。
 * 设计见 docs/design/office-file-preview.md。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixSymbolBullets, formatCell, listZipEntries, parseIpynb, pickIworkPreview, safeColor, safeHttpUrl, sanitizePptHtml, sanitizeStyle, slideScale, fillToCss, MAX_ZIP_ENTRIES } from "../../../apps/web/src/office-preview.ts";
import { isLegacyOffice, isOfficeKind, previewKind } from "../../../apps/web/src/preview.ts";

test("previewKind：Office / iWork / zip / ipynb 新类型（扩展名与 MIME 都认）", () => {
	const cases: [string, string | undefined, string][] = [
		["a.docx", undefined, "docx"], ["a.DOCM", undefined, "docx"], ["a.dotx", undefined, "docx"],
		["x", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
		["a.xlsx", undefined, "xlsx"], ["a.xlsm", undefined, "xlsx"],
		["x", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
		["a.pptx", undefined, "pptx"], ["a.pptm", undefined, "pptx"],
		["x", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
		["a.pages", undefined, "iwork"], ["a.numbers", undefined, "iwork"], ["a.key", undefined, "iwork"],
		["a.zip", undefined, "zip"], ["x", "application/zip", "zip"], ["x", "application/x-zip-compressed", "zip"],
		["a.ipynb", undefined, "ipynb"], ["x", "application/x-ipynb+json", "ipynb"],
		// 扩展名优先：docx 的 MIME 是 zip 时仍按 docx
		["a.docx", "application/zip", "docx"],
		["a.doc", undefined, "unsupported"], ["a.xls", "application/vnd.ms-excel", "unsupported"], ["a.ppt", undefined, "unsupported"],
		["a.odt", undefined, "unsupported"], ["a.ods", undefined, "unsupported"], ["a.odp", undefined, "unsupported"],
		["a.7z", undefined, "unsupported"], ["a.json", "application/json", "code"], ["a.csv", undefined, "csv"],
	];
	for (const [n, m, want] of cases) assert.equal(previewKind(n, m), want, `${n} ${m ?? ""}`);
	for (const k of ["docx", "xlsx", "pptx", "iwork", "zip", "ipynb"] as const) assert.ok(isOfficeKind(k), k);
	assert.ok(!isOfficeKind("csv"));
	for (const n of ["a.doc", "a.xls", "a.ppt", "a.odt", "a.ods", "a.odp"]) assert.ok(isLegacyOffice(n), n);
	assert.ok(!isLegacyOffice("a.7z") && !isLegacyOffice("a.docx"));
});

test("sanitizePptHtml：保留白名单标签与安全样式", () => {
	const html = '<p style="text-align: center;"><span style="font-size: 18pt;font-family: Calibri;color:#ff0000">你好 &amp; <b>粗体</b></span><br></p><ul><li>一</li></ul>';
	const out = sanitizePptHtml(html);
	assert.ok(out.includes('<p style="text-align: center">'), out);
	assert.ok(out.includes("font-size: 18pt; font-family: Calibri; color: #ff0000"), out);
	assert.ok(out.includes("你好 &amp; <b>粗体</b>") && out.includes("<br>") && out.includes("<li>一</li>"), out);
});

test("sanitizePptHtml：script / onerror / javascript: / iframe / 事件属性 / 危险样式都被去掉", () => {
	const bad = [
		'<script>window.__x=1</script>文字',
		'<img src=x onerror="window.__x=1">',
		'<p onclick="window.__x=1" style="color:red;background:url(javascript:1);position:fixed">p</p>',
		'<a href="javascript:alert(1)" onclick="x()">链接</a>',
		'<a href=" JaVaScRiPt:alert(1)">链接2</a>',
		'<a href="data:text/html,<script>1</script>">链接3</a>',
		'<iframe src="https://evil.example"></iframe>',
		'<svg onload="x()"><script>1</script></svg>',
		'<style>*{display:none}</style>',
		'<div style="background-image:url(https://evil.example/a.png)">d</div>',
		'<!-- <script>1</script> -->',
		'<<script>script>alert(1)</script>',
	].join("");
	const out = sanitizePptHtml(bad);
	for (const needle of [/<script/i, /<img/i, /onerror/i, /onclick/i, /onload/i, /javascript:/i, /<iframe/i, /<svg/i, /<style/i, /url\(/i, /position/i, /evil\.example/, /data:text/i, /<!--/]) assert.ok(!needle.test(out), `${needle} 仍在输出里：${out}`);
	assert.ok(out.includes("文字") && out.includes("链接") && out.includes('<p style="color: red">'), out);
	assert.ok(!/<a /.test(out.replace(/<a[^>]*>/g, (t) => (/href="https?:/.test(t) ? "" : t.includes("href") ? t : ""))), out);
});

test("sanitizePptHtml：a 只留 http/https 链接并强制 noopener", () => {
	const out = sanitizePptHtml('<a href="https://example.com/a?b=1&amp;c=2" target="_self">官网</a><a href="http://x.test/">明文</a>');
	assert.ok(out.includes('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">官网</a>'), out);
	assert.ok(out.includes('href="http://x.test/"'), out);
	assert.equal(safeHttpUrl("javascript:1"), null);
	assert.equal(safeHttpUrl("//evil.example"), null);
	assert.equal(safeHttpUrl("https://a.b/c"), "https://a.b/c");
});

test("sanitizePptHtml：文字里的 < > 被转义，不会变成标签", () => {
	assert.equal(sanitizePptHtml("1 < 2 > 0 &lt;b&gt; a & b"), "1 &lt; 2 &gt; 0 &lt;b&gt; a &amp; b");
	assert.equal(sanitizeStyle("color:red;font-family:'宋体',serif;margin:expression(1)"), "color: red; font-family: '宋体',serif");
});

test("safeColor / fillToCss / slideScale", () => {
	assert.equal(safeColor("#FF0000"), "#FF0000");
	assert.equal(safeColor("rgba(1,2,3,0.5)"), "rgba(1,2,3,0.5)");
	assert.equal(safeColor("red;background:url(x)"), undefined);
	assert.equal(safeColor("url(x)"), undefined);
	assert.deepEqual(fillToCss({ type: "color", value: "#fff" }), { backgroundColor: "#fff" });
	assert.deepEqual(fillToCss({ type: "image", value: { base64: "https://evil/x.png" } }), {});
	assert.ok(fillToCss({ type: "image", value: { base64: "data:image/png;base64,AAAA" } }).background?.includes("data:image/png"));
	assert.ok(fillToCss({ type: "gradient", value: { path: "line", rot: 90, colors: [{ pos: "0%", color: "#000" }, { pos: "100%", color: "#fff" }] } }).background?.startsWith("linear-gradient(180deg"));
	// 960pt = 1280px：容器 640 → 缩 0.5；容器更宽时最多放大 2 倍
	assert.equal(slideScale(640, 960), 0.5);
	assert.equal(slideScale(5000, 960), 2);
	assert.equal(slideScale(0, 960), 1);
});

test("formatCell：日期（按本地格式、不差一天）/ 布尔 / 空值 / 数字", () => {
	assert.equal(formatCell(null), "");
	assert.equal(formatCell(undefined), "");
	assert.equal(formatCell(true), "TRUE");
	assert.equal(formatCell(3.5), "3.5");
	assert.equal(formatCell("a"), "a");
	assert.equal(formatCell(new Date(Date.UTC(2024, 2, 5)), "en-US"), "3/5/2024");
	assert.equal(formatCell(new Date(Date.UTC(2024, 2, 5)), "zh-CN"), "2024/3/5");
	assert.match(formatCell(new Date(Date.UTC(2024, 2, 5, 13, 4, 5)), "en-US"), /3\/5\/2024, 1:04:05 PM/);
	assert.equal(formatCell(new Date(NaN)), "");
});

test("listZipEntries：去 __MACOSX、排序、2000 条上限", () => {
	const r = listZipEntries([{ name: "b.txt", dir: false, size: 2 }, { name: "__MACOSX/._b.txt", dir: false }, { name: "a/", dir: true }, { name: "a/x.txt", dir: false, size: 1 }]);
	assert.deepEqual(r.entries.map((e) => e.name), ["a/", "a/x.txt", "b.txt"]);
	assert.equal(r.total, 3);
	assert.equal(r.truncated, false);
	const many = Array.from({ length: MAX_ZIP_ENTRIES + 5 }, (_, i) => ({ name: `f${i}.txt`, dir: false }));
	const t = listZipEntries(many);
	assert.equal(t.entries.length, MAX_ZIP_ENTRIES);
	assert.equal(t.total, MAX_ZIP_ENTRIES + 5);
	assert.ok(t.truncated);
});

test("pickIworkPreview：按优先级挑预览图，没有返回 null", () => {
	assert.deepEqual(pickIworkPreview(["Index/Document.iwa", "preview.jpg", "preview-micro.jpg"]), { path: "preview.jpg", mime: "image/jpeg" });
	assert.deepEqual(pickIworkPreview(["Index.zip", "QuickLook/Thumbnail.jpg", "QuickLook/Preview.pdf"]), { path: "QuickLook/Thumbnail.jpg", mime: "image/jpeg" });
	assert.deepEqual(pickIworkPreview(["Preview.PNG"]), { path: "Preview.PNG", mime: "image/png" });
	assert.deepEqual(pickIworkPreview(["QuickLook/other.jpg"]), { path: "QuickLook/other.jpg", mime: "image/jpeg" });
	assert.equal(pickIworkPreview(["Index/Document.iwa", "Data/a.png"]), null);
});

test("parseIpynb：Markdown / 代码 / 输出（文本、图片、错误）；html 输出只留 text/plain", () => {
	const nb = {
		metadata: { language_info: { name: "python" } },
		cells: [
			{ cell_type: "markdown", source: ["# 标题\n", "正文"] },
			{ cell_type: "code", execution_count: 3, source: "print(1)", outputs: [
				{ output_type: "stream", name: "stdout", text: ["1\n"] },
				{ output_type: "display_data", data: { "image/png": "iVBORw0KGgo=\n", "text/plain": "<Figure>" } },
				{ output_type: "execute_result", data: { "text/html": "<script>alert(1)</script><b>x</b>", "text/plain": "x" } },
				{ output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[31mValueError\u001b[0m: bad"] },
				{ output_type: "display_data", data: { "image/png": "<script>" } },
			] },
			{ cell_type: "raw", source: "raw" },
		],
	};
	const r = parseIpynb(JSON.stringify(nb));
	assert.equal(r.language, "python");
	assert.equal(r.cells.length, 3);
	assert.equal(r.cells[0].source, "# 标题\n正文");
	assert.equal(r.cells[1].count, 3);
	const outs = r.cells[1].outputs;
	assert.deepEqual(outs[0], { kind: "text", text: "1\n" });
	assert.deepEqual(outs[1], { kind: "image", mime: "image/png", src: "data:image/png;base64,iVBORw0KGgo=" });
	assert.deepEqual(outs[2], { kind: "text", text: "x" });
	assert.deepEqual(outs[3], { kind: "text", error: true, text: "ValueError: bad" });
	assert.equal(outs.length, 4, "非法 base64 图片不输出");
	assert.ok(!JSON.stringify(r).includes("<script>"));
});

test("parseIpynb：不是 notebook 抛错；nbformat 3 的 worksheets 也能读", () => {
	assert.throws(() => parseIpynb("{}"));
	assert.throws(() => parseIpynb("not json"));
	const v3 = parseIpynb(JSON.stringify({ worksheets: [{ cells: [{ cell_type: "heading", level: 2, source: ["小标题"] }, { cell_type: "code", input: ["a=1"], prompt_number: 1, outputs: [] }] }] }));
	assert.equal(v3.cells[0].source, "## 小标题");
	assert.equal(v3.cells[1].source, "a=1");
	assert.equal(v3.cells[1].count, 1);
});

test("formatCell：小数按 Excel 常规格式最多 11 位有效数字；fixSymbolBullets：Word 私有区列表符号换成 Unicode", () => {
	assert.equal(formatCell(1 / 30), "0.033333333333");
	assert.equal(formatCell(0.1 + 0.2), "0.3");
	assert.equal(formatCell(1037.5), "1037.5");
	assert.equal(formatCell(42), "42");
	assert.equal(fixSymbolBullets('p:before { content: "\uf0b7\\9"; }'), 'p:before { content: "•\\9"; }');
	assert.equal(fixSymbolBullets('content: "\uf0a7"'), 'content: "▪"');
	assert.equal(fixSymbolBullets('content: "\uf0ff"'), 'content: "•"');
	assert.equal(fixSymbolBullets('content: "%1."'), 'content: "%1."');
});
