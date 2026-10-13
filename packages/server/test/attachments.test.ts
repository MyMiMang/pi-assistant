import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { clipTokens, estimateTokens, extractDocText, prepareAttachments } from "../src/attachments.ts";
import { deleteRoomFiles, getFile, materializeFor, saveRoomUpload, workspaceOf } from "../src/files.ts";
import { buildTranscript } from "../src/rooms/logic.ts";

const dir = mkdtempSync(join(tmpdir(), "pia-att-"));
const put = (name: string, data: Buffer | string) => {
	const p = join(dir, name);
	writeFileSync(p, data);
	return { name, mime: "", absPath: p, displayPath: `uploads/${name}` };
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function pdf(text: string | null) {
	const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offs: number[] = [];
	objs.forEach((o, i) => {
		offs.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const x = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
	return Buffer.from(out, "latin1");
}
const zip = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

test("文档抽取：PDF / 扫描 PDF / DOCX / PPTX / XLSX / 文本", async () => {
	assert.match((await extractDocText("a.pdf", pdf("Hello Quarterly Report")))!.text, /Hello Quarterly Report/);
	const scanned = (await extractDocText("s.pdf", pdf(null)))!;
	assert.equal(scanned.text, "");
	assert.match(scanned.note!, /没有文字层/);
	assert.equal((await extractDocText("d.docx", zip({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>A&amp;B</w:t></w:r></w:p></w:body></w:document>" })))!.text, "第一段\nA&B");
	assert.match((await extractDocText("p.pptx", zip({ "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>二</a:t></a:r></a:p></p:sld>", "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>一</a:t></a:r></a:p></p:sld>" })))!.text, /第 1 页 ---\n一[\s\S]*第 2 页 ---\n二/);
	const xl = (await extractDocText(
		"x.xlsx",
		zip({
			"xl/workbook.xml": '<workbook><sheets><sheet name="销售" sheetId="1"/></sheets></workbook>',
			"xl/sharedStrings.xml": "<sst><si><t>月份</t></si><si><t>金额</t></si></sst>",
			"xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>99.5</v></c></row></sheetData></worksheet>',
		}),
	))!.text;
	assert.equal(xl, "--- 工作表 销售 ---\n月份\t金额\n1\t99.5");
	assert.equal((await extractDocText("n.md", Buffer.from("\uFEFF# 标题")))!.text, "# 标题");
	assert.equal(await extractDocText("b.bin", Buffer.from([1, 2])), null);
});

test("token 估算与截断", () => {
	assert.equal(estimateTokens("你好"), 2);
	assert.equal(estimateTokens("abcdefgh"), 2);
	const c = clipTokens("字".repeat(1000), 100);
	assert.equal(c.clipped, true);
	assert.equal(c.text.length, 100);
});

test("prepareAttachments：看图模型收到图片；不看图的给说明；文档附摘录并截断", async () => {
	const img = put("p.png", PNG);
	const doc = put("long.txt", "内容".repeat(30_000));
	const v = await prepareAttachments([img, doc], { vision: true });
	assert.equal(v.images.length, 1);
	assert.match(v.images[0].mimeType, /^image\//);
	assert.match(v.text, /\[附件: uploads\/p\.png\].*第 1 张图片/);
	assert.match(v.text, /摘录，已截断/);
	assert.ok(estimateTokens(v.text) < 21_000);
	const nv = await prepareAttachments([img], { vision: false });
	assert.equal(nv.images.length, 0);
	assert.match(nv.text, /不支持看图/);
	const ds = await prepareAttachments([img], { vision: false, describe: async (imgs) => ({ ok: true, text: `一个图标（${imgs[0].label}）` }) });
	assert.equal(ds.images.length, 0);
	assert.match(ds.text, /识图模型的描述：\n一个图标（uploads\/p\.png）/);
	const sc = await prepareAttachments([put("scan.pdf", pdf(null))], { vision: true });
	assert.match(sc.text, /没有文字层/);
	assert.match((await prepareAttachments([{ ...img, absPath: join(dir, "nope.png") }], { vision: true })).text, /不存在/);
});

test("群附件：每群存一份，复制进成员工作区，删群一起清理；注入时写出路径", () => {
	const f = saveRoomUpload("room_t1", "报告.pdf", Buffer.from("x"));
	assert.equal(getFile(f.id)!.room_id, "room_t1");
	const rel = materializeFor("agent_x", f, "room_t1");
	assert.match(rel, /^room-files\/room_t1\/.+-报告\.pdf$/);
	assert.ok(existsSync(join(workspaceOf("agent_x"), rel)));
	assert.equal(materializeFor("agent_x", f, "room_t1"), rel, "只复制一次");
	const tr = buildTranscript([{ seq: 1, role: "user", agentId: "", content: "看看", meta: { attachments: [{ fileId: f.id, name: f.name }] }, status: "done" }], "agent_x", () => "", 16_000, () => rel);
	assert.match(tr.text, new RegExp(`报告\\.pdf → ${rel}`));
	assert.equal(tr.files.length, 1);
	deleteRoomFiles("room_t1");
	assert.equal(getFile(f.id), undefined);
	assert.ok(!existsSync(f.stored_path));
});
