/**
 * 应用内文件预览的纯逻辑（类型判定 / 二进制嗅探 / CSV 解析）。
 *
 * 设计边界（见 docs/DESIGN.md「聊天附件应用内预览」）：
 * - 类型判定不只看扩展名，也不只看 Content-Type：两者一起判，再对实际字节做嗅探；
 * - 只读、不执行：HTML/SVG/Office 宏一律当二进制，不 inline；
 * - 文本有上限，超限只提示 + 下载，不把大文件塞进 DOM。
 */

export type PreviewKind = "image" | "pdf" | "markdown" | "csv" | "code" | "text" | "unsupported";

/** 文本类预览的字节上限（超过只提示 + 下载）。 */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** CSV 表格行列预算，防止 50 万行把页面卡死。 */
export const MAX_CSV_ROWS = 500;
export const MAX_CSV_COLS = 50;
/** 代码/文本最多渲染的行数（超出提示截断，仍可下载看全文）。 */
export const MAX_TEXT_LINES = 5000;

const CODE_EXT = new Set([
	"json", "jsonl", "ndjson", "yaml", "yml", "xml", "toml", "ini", "conf", "env", "properties", "sql",
	"sh", "bash", "zsh", "fish", "py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "java",
	"c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "swift", "kt", "kts", "scala", "lua", "r", "pl",
	"vue", "svelte", "css", "scss", "less", "graphql", "proto", "dockerfile", "makefile",
]);
const TEXT_EXT = new Set(["txt", "log", "text", "out", "err", "diff", "patch", "rtf"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif"]);
const SHEET_EXT = new Set(["xls", "xlsx", "xlsm", "ods", "numbers"]);

const extOf = (name: string) => {
	const i = name.lastIndexOf(".");
	return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

/**
 * 判定预览类型。扩展名 + MIME 一起看；两者都没有/都认不出时归 unsupported（只给下载）。
 * 安全相关：SVG、HTML、Office 一律 unsupported，绝不 inline（不执行脚本 / 宏）。
 */
export function previewKind(name: string, mime?: string): PreviewKind {
	const ext = extOf(name);
	const m = (mime ?? "").toLowerCase().split(";")[0].trim();
	// 危险 / 可执行内容：只下载
	if (ext === "svg" || m === "image/svg+xml") return "unsupported";
	if (["html", "htm", "xhtml", "hta"].includes(ext) || m === "text/html" || m === "application/xhtml+xml") return "unsupported";
	if (SHEET_EXT.has(ext) || /spreadsheetml|ms-excel|opendocument\.spreadsheet/.test(m)) return "unsupported";
	if (["doc", "docx", "odt", "pages", "ppt", "pptx", "odp", "key"].includes(ext)) return "unsupported";
	if (["zip", "tar", "gz", "7z", "rar", "dmg", "exe", "app", "bin", "iso"].includes(ext)) return "unsupported";
	// 图片
	if (m.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
	// PDF
	if (m === "application/pdf" || ext === "pdf") return "pdf";
	// Markdown
	if (["md", "markdown", "mdx"].includes(ext) || m === "text/markdown") return "markdown";
	// CSV / TSV
	if (["csv", "tsv"].includes(ext) || m === "text/csv" || m === "text/tab-separated-values") return "csv";
	// 代码
	if (CODE_EXT.has(ext)) return "code";
	// 纯文本
	if (TEXT_EXT.has(ext) || m.startsWith("text/") || m === "application/json" || m === "application/xml" || m === "application/x-yaml") return "text";
	return "unsupported";
}

/** 文本类（需要按字节上限读取并解码）的类型。 */
export const isTextKind = (k: PreviewKind) => k === "markdown" || k === "csv" || k === "code" || k === "text";

/**
 * 字节嗅探：内容看起来是二进制就不要当文本解码。
 * NUL 字节直接判二进制；其它控制字符占比过高也判二进制（乱码保护）。
 */
export function looksBinary(bytes: Uint8Array): boolean {
	const n = Math.min(bytes.length, 8192);
	if (n === 0) return false;
	let suspicious = 0;
	for (let i = 0; i < n; i++) {
		const b = bytes[i];
		if (b === 0) return true;
		// 允许 tab(9) lf(10) cr(13)，其余 <32 的控制字符算可疑
		if (b < 9 || (b > 13 && b < 32)) suspicious++;
	}
	return suspicious / n > 0.1;
}

export interface CsvTable {
	rows: string[][];
	/** 因行/列预算被截断 */
	truncated: boolean;
	cols: number;
}

/** 去掉 UTF-8 BOM。 */
export const stripBom = (t: string) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);

/**
 * 基础 CSV 解析：支持引号包裹、字段内换行、"" 转义、CRLF，行列有预算。
 * 只做展示，不做类型推断。
 */
export function parseCsv(text: string, opts: { maxRows?: number; maxCols?: number; delimiter?: string } = {}): CsvTable {
	const maxRows = opts.maxRows ?? MAX_CSV_ROWS;
	const maxCols = opts.maxCols ?? MAX_CSV_COLS;
	const delim = opts.delimiter ?? ",";
	const src = stripBom(text);
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let truncated = false;
	const n = src.length;
	const pushField = () => {
		if (row.length < maxCols) row.push(field);
		else truncated = true;
		field = "";
	};
	const pushRow = () => {
		pushField();
		if (rows.length < maxRows) rows.push(row);
		else truncated = true;
		row = [];
	};
	let i = 0;
	while (i < n) {
		const c = src[i];
		if (inQuotes) {
			if (c === '"') {
				if (src[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}
		if (c === '"' && field === "") {
			inQuotes = true;
			i++;
			continue;
		}
		if (c === delim) {
			pushField();
			i++;
			continue;
		}
		if (c === "\r") {
			i++;
			continue;
		}
		if (c === "\n") {
			pushRow();
			i++;
			continue;
		}
		field += c;
		i++;
	}
	if (field !== "" || row.length) pushRow();
	const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
	return { rows, truncated, cols };
}
