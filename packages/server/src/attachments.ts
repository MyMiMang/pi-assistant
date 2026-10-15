/**
 * 附件 → 模型输入（单聊和群聊共用）：
 *  - 图片：模型支持看图时作为真正的图片内容发给模型（大图先缩小）；不支持看图时只写一句说明 + 路径
 *  - HEIC/HEIF（iPhone）：macOS 上用系统自带 sips 转成 JPEG；其他系统给说明
 *  - 文档：PDF / DOCX / XLSX / PPTX / CSV / TXT / MD / JSON 等自动抽取文字，按 token 预算截取摘录，并注明完整文件路径
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

export interface AttachmentInput {
	name: string;
	mime: string;
	/** 服务端可读取的绝对路径 */
	absPath: string;
	/** 告诉模型的路径（工作区相对路径） */
	displayPath: string;
}
export interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}
export interface PreparedAttachments {
	text: string;
	images: ImagePart[];
}

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
export const HEIC_EXT = new Set([".heic", ".heif"]);
const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log", ".yaml", ".yml", ".xml", ".html", ".htm", ".py", ".ts", ".tsx", ".js", ".jsx", ".css", ".sh", ".sql", ".ini", ".toml", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".rb", ".php", ".swift", ".kt"]);

/** 粗略估算 token：中日韩字符约 1 token/字，其他约 4 字符/token */
export function estimateTokens(s: string) {
	let cjk = 0;
	for (const ch of s) if (/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch)) cjk++;
	return Math.ceil(cjk + (s.length - cjk) / 4);
}
/** 按 token 预算截断 */
export function clipTokens(s: string, maxTokens: number): { text: string; clipped: boolean } {
	if (estimateTokens(s) <= maxTokens) return { text: s, clipped: false };
	let lo = 0;
	let hi = s.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid;
		else hi = mid - 1;
	}
	return { text: s.slice(0, lo), clipped: true };
}

const xmlText = (xml: string, tag: string) =>
	[...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => decodeXml(m[1]));
const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

async function unzip(buf: Buffer, filter: (name: string) => boolean): Promise<Record<string, string>> {
	const { unzipSync, strFromU8 } = await import("fflate");
	const files = unzipSync(new Uint8Array(buf), { filter: (f) => filter(f.name) });
	return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

async function docxText(buf: Buffer) {
	const f = await unzip(buf, (n) => n === "word/document.xml");
	const xml = f["word/document.xml"] ?? "";
	return xml
		.split(/<\/w:p>/)
		.map((p) => xmlText(p.replace(/<w:tab\/>/g, "<w:t>\t</w:t>"), "w:t").join(""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
async function pptxText(buf: Buffer) {
	const f = await unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
	return Object.keys(f)
		.sort(natural)
		.map((k, i) => `--- 第 ${i + 1} 页 ---\n${f[k].split(/<\/a:p>/).map((p) => xmlText(p, "a:t").join("")).filter(Boolean).join("\n")}`)
		.join("\n\n")
		.trim();
}
async function xlsxText(buf: Buffer) {
	const f = await unzip(buf, (n) => n === "xl/sharedStrings.xml" || n === "xl/workbook.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
	const shared = (f["xl/sharedStrings.xml"] ?? "").split(/<\/si>/).map((si) => xmlText(si, "t").join(""));
	const names = [...(f["xl/workbook.xml"] ?? "").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
	const out: string[] = [];
	Object.keys(f)
		.filter((k) => k.startsWith("xl/worksheets/"))
		.sort(natural)
		.forEach((k, i) => {
			out.push(`--- 工作表 ${names[i] ?? i + 1} ---`);
			for (const row of f[k].matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
				const cells = [...row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
					const attrs = c[1];
					const inner = c[2] ?? "";
					const v = inner.match(/<v>([^<]*)<\/v>/)?.[1];
					if (/t="s"/.test(attrs)) return shared[Number(v)] ?? "";
					if (/t="inlineStr"/.test(attrs)) return xmlText(inner, "t").join("");
					return v != null ? decodeXml(v) : "";
				});
				if (cells.some((c) => c !== "")) out.push(cells.join("\t"));
			}
		});
	return out.join("\n").trim();
}
async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
	const { extractText, getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(new Uint8Array(buf));
	const r = await extractText(pdf, { mergePages: false });
	const pages = (r.text as string[]).map((t, i) => `--- 第 ${i + 1} 页 ---\n${t.trim()}`);
	const text = (r.text as string[]).join("").trim() ? pages.join("\n\n") : "";
	return { text, pages: r.totalPages };
}

/** 抽取文档文字；不支持的类型返回 null */
export async function extractDocText(name: string, buf: Buffer): Promise<{ text: string; note?: string } | null> {
	const ext = extname(name).toLowerCase();
	if (ext === ".pdf") {
		const r = await pdfText(buf);
		return r.text ? { text: r.text, note: `共 ${r.pages} 页` } : { text: "", note: `共 ${r.pages} 页，没有文字层（可能是扫描件/图片 PDF），需要 OCR 或转成图片再看` };
	}
	if (ext === ".docx") return { text: await docxText(buf) };
	if (ext === ".pptx") return { text: await pptxText(buf) };
	if (ext === ".xlsx") return { text: await xlsxText(buf) };
	if (TEXT_EXT.has(ext)) return { text: buf.toString("utf8").replace(/^\uFEFF/, "") };
	return null;
}

async function heicToJpeg(abs: string): Promise<Buffer | null> {
	if (process.platform !== "darwin") return null;
	const dir = mkdtempSync(join(tmpdir(), "pia-heic-"));
	try {
		const out = join(dir, "out.jpg");
		await promisify(execFile)("sips", ["-s", "format", "jpeg", abs, "--out", out], { timeout: 30_000 });
		return readFileSync(out);
	} catch {
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const MIME_OF: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

/** 缩小到 provider 能接受的尺寸（Pi 自带的 Photon 缩放）；失败时原图小于 4MB 就原样发 */
export async function toImagePart(bytes: Buffer, mimeType: string): Promise<ImagePart | null> {
	try {
		const { resizeImage } = await import("@earendil-works/pi-coding-agent");
		const r = await resizeImage(new Uint8Array(bytes), mimeType, { maxWidth: 2000, maxHeight: 2000 } as never);
		if (r) return { type: "image", data: (r as { data: string }).data, mimeType: (r as { mimeType: string }).mimeType };
	} catch {
		/* 缩放失败：下面兜底 */
	}
	return bytes.length <= 4 * 1024 * 1024 ? { type: "image", data: bytes.toString("base64"), mimeType } : null;
}

export interface PrepareOptions {
	vision: boolean;
	/** 所有文档摘录合计的 token 上限 */
	docTokens?: number;
	/** 最多发给模型的图片张数 */
	maxImages?: number;
	/** 不支持看图时：交给识图模型换成文字描述（vision.ts describeImages） */
	describe?: (imgs: { data: string; mimeType: string; label: string }[]) => Promise<{ ok: boolean; text: string }>;
}

/** 把附件变成模型输入：一段说明文字 + 图片内容 */
export async function prepareAttachments(files: AttachmentInput[], opts: PrepareOptions): Promise<PreparedAttachments> {
	const lines: string[] = [];
	const images: ImagePart[] = [];
	let docBudget = opts.docTokens ?? 20_000;
	const maxImages = opts.maxImages ?? 8;
	for (const f of files) {
		const ext = extname(f.name).toLowerCase();
		let size = 0;
		try {
			size = statSync(f.absPath).size;
		} catch {
			lines.push(`[附件: ${f.displayPath}]（文件已不存在）`);
			continue;
		}
		const head = `[附件: ${f.displayPath}]（${f.name}，${fmtSize(size)}）`;
		if (IMAGE_EXT.has(ext) || HEIC_EXT.has(ext)) {
			if (!opts.vision) {
				let desc = "";
				if (opts.describe) {
					try {
						const bytes = HEIC_EXT.has(ext) ? await heicToJpeg(f.absPath) : readFileSync(f.absPath);
						const part = bytes ? await toImagePart(bytes, HEIC_EXT.has(ext) ? "image/jpeg" : (MIME_OF[ext] ?? f.mime)) : null;
						const r = part ? await opts.describe([{ data: part.data, mimeType: part.mimeType, label: f.displayPath }]) : null;
						if (r?.ok) desc = r.text;
					} catch {
						/* 识图失败：只给路径 */
					}
				}
				lines.push(
					desc
						? `${head} 图片。当前模型不能直接看图，以下是识图模型的描述：\n${desc}`
						: `${head} 图片。当前模型不支持看图，看不到图片内容；请让用户把当前对话换成支持图片的模型（设置 › 模型）后再发。`,
				);
				continue;
			}
			if (images.length >= maxImages) {
				lines.push(`${head} 图片（本条消息图片太多，这张没有直接发给你，需要时用工具读取）。`);
				continue;
			}
			const bytes = HEIC_EXT.has(ext) ? await heicToJpeg(f.absPath) : readFileSync(f.absPath);
			const part = bytes ? await toImagePart(bytes, HEIC_EXT.has(ext) ? "image/jpeg" : (MIME_OF[ext] ?? f.mime)) : null;
			if (part) {
				images.push(part);
				lines.push(`${head} 图片，已作为第 ${images.length} 张图片附在这条消息里。`);
			} else lines.push(`${head} 图片（${HEIC_EXT.has(ext) ? "HEIC 格式在这台电脑上无法转换" : "无法读取/缩放"}，没有直接发给你）。`);
			continue;
		}
		let doc: Awaited<ReturnType<typeof extractDocText>> = null;
		if (size <= 50 * 1024 * 1024) {
			try {
				doc = await extractDocText(f.name, readFileSync(f.absPath));
			} catch (e) {
				lines.push(`${head} 无法解析文字（${e instanceof Error ? e.message : String(e)}），需要时用工具读取完整文件。`);
				continue;
			}
		}
		if (!doc) {
			lines.push(head);
			continue;
		}
		if (!doc.text.trim()) {
			lines.push(`${head}${doc.note ? ` ${doc.note}。` : " 没有抽取到文字。"}`);
			continue;
		}
		if (docBudget < 200) {
			lines.push(`${head}${doc.note ? `（${doc.note}）` : ""} 文字内容没有附上（本条消息摘录已达上限），需要时读取完整文件。`);
			continue;
		}
		const c = clipTokens(doc.text, docBudget);
		docBudget -= estimateTokens(c.text);
		lines.push(
			`${head}${doc.note ? `（${doc.note}）` : ""} 文字内容${c.clipped ? "（摘录，已截断；完整内容请读取上面的文件）" : ""}：\n<<<文件内容 ${f.name}\n${c.text}\n文件内容>>>`,
		);
	}
	return { text: lines.join("\n"), images };
}

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
