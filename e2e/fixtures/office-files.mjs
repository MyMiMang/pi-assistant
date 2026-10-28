/**
 * Office 预览 e2e 用的测试文件：运行时用 jszip 现生成（docx / xlsx / pptx / pages / zip / ipynb），不入库任何二进制。
 * 都是手写的最小合法 OOXML，内容固定，方便断言。设计见 docs/design/office-file-preview.md。
 */
import JSZip from "jszip";

const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = (t) => `${NS_R}/${t}`;
const rels = (items) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"${ext ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
const types = (defaults, overrides) =>
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join("")}${overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join("")}</Types>`;
const gen = (z) => z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

export const DOCX_LINK = "https://example.com/docx-link";
export const PPTX_LINK = "https://example.com/pptx-link";
export const XSS_TEXT = '<img src=x onerror="window.__pptxXss=1"><script>window.__pptxXss=2</script>危险文字';

export async function makeDocx() {
	const z = new JSZip();
	z.file("[Content_Types].xml", types([["rels", "application/vnd.openxmlformats-package.relationships+xml"], ["xml", "application/xml"]], [["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"]]));
	z.file("_rels/.rels", rels([["rId1", REL("officeDocument"), "word/document.xml"]]));
	z.file("word/_rels/document.xml.rels", rels([["rId1", REL("hyperlink"), DOCX_LINK, true]]));
	z.file(
		"word/document.xml",
		`${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${NS_R}"><w:body>
<w:p><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>季度报告（Word）</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">正文第一段，后面有一个链接：</w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:rPr><w:u w:val="single"/><w:color w:val="0000FF"/></w:rPr><w:t>官网链接</w:t></w:r></w:hyperlink></w:p>
<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>
<w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>收入</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1024</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
	);
	return gen(z);
}

export async function makeXlsx() {
	const z = new JSZip();
	z.file("[Content_Types].xml", types([["rels", "application/vnd.openxmlformats-package.relationships+xml"], ["xml", "application/xml"]], [
		["/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],
		["/xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"],
		["/xl/worksheets/sheet2.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"],
		["/xl/sharedStrings.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"],
		["/xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"],
	]));
	z.file("_rels/.rels", rels([["rId1", REL("officeDocument"), "xl/workbook.xml"]]));
	z.file("xl/_rels/workbook.xml.rels", rels([["rId1", REL("worksheet"), "worksheets/sheet1.xml"], ["rId2", REL("worksheet"), "worksheets/sheet2.xml"], ["rId3", REL("sharedStrings"), "sharedStrings.xml"], ["rId4", REL("styles"), "styles.xml"]]));
	z.file("xl/workbook.xml", `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}"><sheets><sheet name="销售" sheetId="1" r:id="rId1"/><sheet name="汇总" sheetId="2" r:id="rId2"/></sheets></workbook>`);
	z.file("xl/sharedStrings.xml", `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6"><si><t>日期</t></si><si><t>产品</t></si><si><t>数量</t></si><si><t>苹果</t></si><si><t>汇总说明</t></si><si><t>第二张表的内容</t></si></sst>`);
	z.file("xl/styles.xml", `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`);
	// 45356 = 2024-03-05
	z.file("xl/worksheets/sheet1.xml", `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" s="1"><v>45356</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><v>42</v></c></row></sheetData></worksheet>`);
	z.file("xl/worksheets/sheet2.xml", `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>4</v></c></row><row r="2"><c r="A2" t="s"><v>5</v></c></row></sheetData></worksheet>`);
	return gen(z);
}

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="' + NS_R + '" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const EMU = (pt) => Math.round(pt * 12700);
const xfrm = (l, t, w, h) => `<a:xfrm><a:off x="${EMU(l)}" y="${EMU(t)}"/><a:ext cx="${EMU(w)}" cy="${EMU(h)}"/></a:xfrm>`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function makePptx() {
	const z = new JSZip();
	const CT = "application/vnd.openxmlformats-officedocument.presentationml";
	z.file("[Content_Types].xml", types([["rels", "application/vnd.openxmlformats-package.relationships+xml"], ["xml", "application/xml"], ["png", "image/png"]], [
		["/ppt/presentation.xml", `${CT}.presentation.main+xml`],
		["/ppt/slides/slide1.xml", `${CT}.slide+xml`],
		["/ppt/slides/slide2.xml", `${CT}.slide+xml`],
		["/ppt/slideLayouts/slideLayout1.xml", `${CT}.slideLayout+xml`],
		["/ppt/slideMasters/slideMaster1.xml", `${CT}.slideMaster+xml`],
		["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
	]));
	z.file("_rels/.rels", rels([["rId1", REL("officeDocument"), "ppt/presentation.xml"]]));
	z.file("ppt/presentation.xml", `${XML}<p:presentation ${A}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="${EMU(720)}" cy="${EMU(405)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
	z.file("ppt/_rels/presentation.xml.rels", rels([["rId1", REL("slideMaster"), "slideMasters/slideMaster1.xml"], ["rId2", REL("slide"), "slides/slide1.xml"], ["rId3", REL("slide"), "slides/slide2.xml"], ["rId4", REL("theme"), "theme/theme1.xml"]]));
	const clr = (n, v) => `<a:${n}><a:srgbClr val="${v}"/></a:${n}>`;
	z.file("ppt/theme/theme1.xml", `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements><a:clrScheme name="C">${clr("dk1", "000000")}${clr("lt1", "FFFFFF")}${clr("dk2", "1F497D")}${clr("lt2", "EEECE1")}${clr("accent1", "4F81BD")}${clr("accent2", "C0504D")}${clr("accent3", "9BBB59")}${clr("accent4", "8064A2")}${clr("accent5", "4BACC6")}${clr("accent6", "F79646")}${clr("hlink", "0000FF")}${clr("folHlink", "800080")}</a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="M"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
	const grp = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
	z.file("ppt/slideMasters/slideMaster1.xml", `${XML}<p:sldMaster ${A}><p:cSld><p:spTree>${grp}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`);
	z.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([["rId1", REL("slideLayout"), "../slideLayouts/slideLayout1.xml"], ["rId2", REL("theme"), "../theme/theme1.xml"]]));
	z.file("ppt/slideLayouts/slideLayout1.xml", `${XML}<p:sldLayout ${A} type="blank"><p:cSld name="Blank"><p:spTree>${grp}</p:spTree></p:cSld></p:sldLayout>`);
	z.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels([["rId1", REL("slideMaster"), "../slideMasters/slideMaster1.xml"]]));
	const tbox = (id, name, l, t, w, h, paras, extra = "") =>
		`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(l, t, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${extra}</p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
	const run = (text, sz = 2400) => `<a:r><a:rPr lang="zh-CN" sz="${sz}"/><a:t>${esc(text)}</a:t></a:r>`;
	const link = `<a:r><a:rPr lang="en-US" sz="1800"><a:hlinkClick r:id="rId2"/></a:rPr><a:t>幻灯片链接</a:t></a:r>`;
	const white = `<a:r><a:rPr lang="zh-CN" sz="2000"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>蓝色色块</a:t></a:r>`;
	const shape = `<p:sp><p:nvSpPr><p:cNvPr id="4" name="色块"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(60, 200, 200, 100)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="3B82F6"/></a:solidFill></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>${white}</a:p></p:txBody></p:sp>`;
	const pic = `<p:pic><p:nvPicPr><p:cNvPr id="5" name="图"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(300, 200, 100, 100)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
	const cell = (t) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(t, 1400)}</a:p></a:txBody><a:tcPr/></a:tc>`;
	const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="表"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${EMU(420)}" y="${EMU(200)}"/><a:ext cx="${EMU(240)}" cy="${EMU(60)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="${EMU(120)}"/><a:gridCol w="${EMU(120)}"/></a:tblGrid><a:tr h="${EMU(30)}">${cell("表头甲")}${cell("表头乙")}</a:tr><a:tr h="${EMU(30)}">${cell("格一")}${cell("格二")}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
	const slide = (inner) => `${XML}<p:sld ${A}><p:cSld><p:spTree>${grp}${inner}</p:spTree></p:cSld></p:sld>`;
	z.file("ppt/slides/slide1.xml", slide(tbox(2, "标题", 40, 30, 640, 60, `<a:p>${run("季度汇报（PPT）", 3200)}</a:p>`) + tbox(3, "链接", 40, 110, 640, 40, `<a:p>${link}</a:p>`) + shape + pic + table));
	z.file("ppt/slides/_rels/slide1.xml.rels", rels([["rId1", REL("slideLayout"), "../slideLayouts/slideLayout1.xml"], ["rId2", REL("hyperlink"), PPTX_LINK, true], ["rId3", REL("image"), "../media/image1.png"]]));
	z.file("ppt/media/image1.png", PNG_1PX);
	z.file("ppt/slides/slide2.xml", slide(tbox(2, "危险", 40, 40, 640, 80, `<a:p>${run(XSS_TEXT, 2000)}</a:p>`) + tbox(3, "第二页", 40, 150, 640, 60, `<a:p>${run("第二页正文", 2400)}</a:p>`)));
	z.file("ppt/slides/_rels/slide2.xml.rels", rels([["rId1", REL("slideLayout"), "../slideLayouts/slideLayout1.xml"]]));
	return gen(z);
}

export async function makePages(withPreview = true) {
	const z = new JSZip();
	z.file("Index/Document.iwa", Buffer.from([1, 2, 3]));
	if (withPreview) z.file("preview.jpg", PNG_1PX); // 浏览器按内容识别图片格式，1px PNG 够用
	return gen(z);
}

export const ZIP_NAMES = ["docs/", "docs/readme.txt", "docs/说明.md", "data.csv"];
export async function makeZip() {
	const z = new JSZip();
	z.file("docs/readme.txt", "hello");
	z.file("docs/说明.md", "# 说明");
	z.file("data.csv", "a,b\n1,2\n");
	z.file("__MACOSX/._data.csv", "x");
	return gen(z);
}

export const IPYNB = JSON.stringify({
	nbformat: 4,
	nbformat_minor: 5,
	metadata: { language_info: { name: "python" } },
	cells: [
		{ cell_type: "markdown", source: ["# 笔记标题\n", "一段 **Markdown** 说明。"] },
		{ cell_type: "code", execution_count: 1, source: ["print('你好 notebook')"], outputs: [
			{ output_type: "stream", name: "stdout", text: ["你好 notebook\n"] },
			{ output_type: "display_data", data: { "image/png": PNG_1PX.toString("base64"), "text/plain": ["<Figure>"] } },
			{ output_type: "execute_result", execution_count: 1, data: { "text/html": ["<script>window.__nbXss=1</script><b>html 输出</b>"], "text/plain": ["纯文本版输出"] } },
		] },
	],
});

export const BAD_BYTES = Buffer.from("这不是一个真正的 Office 文件，只是一些随便的字节。".repeat(5));

/** 生成全部测试文件：{ id: { name, mime, body } }。 */
export async function buildOfficeFiles() {
	const M = {
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	};
	return {
		"o-docx": { name: "report.docx", mime: M.docx, body: await makeDocx() },
		"o-xlsx": { name: "sales.xlsx", mime: M.xlsx, body: await makeXlsx() },
		"o-pptx": { name: "deck.pptx", mime: M.pptx, body: await makePptx() },
		"o-pages": { name: "notes.pages", mime: "application/vnd.apple.pages", body: await makePages(true) },
		"o-pages-bare": { name: "bare.key", mime: "application/octet-stream", body: await makePages(false) },
		"o-zip": { name: "bundle.zip", mime: "application/zip", body: await makeZip() },
		"o-ipynb": { name: "analysis.ipynb", mime: "application/x-ipynb+json", body: Buffer.from(IPYNB) },
		"o-bad-docx": { name: "broken.docx", mime: M.docx, body: BAD_BYTES },
		"o-bad-xlsx": { name: "broken.xlsx", mime: M.xlsx, body: BAD_BYTES },
		"o-bad-pptx": { name: "broken.pptx", mime: M.pptx, body: BAD_BYTES },
		"o-bad-zip": { name: "broken.zip", mime: "application/zip", body: BAD_BYTES },
		"o-bad-ipynb": { name: "broken.ipynb", mime: "application/x-ipynb+json", body: Buffer.from("{ not json") },
		"o-old-doc": { name: "legacy.doc", mime: "application/msword", body: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) },
		"o-old-xls": { name: "legacy.xls", mime: "application/vnd.ms-excel", body: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) },
		// 声明大小超过 30MB：不应该去下载
		"o-big": { name: "huge.pptx", mime: M.pptx, body: Buffer.from("x"), declaredSize: 31 * 1024 * 1024 },
	};
}
