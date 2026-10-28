/**
 * Office / iWork / zip / Jupyter 预览的纯逻辑（清洗、解析、整理、坐标换算、单元格格式化）。
 * 不碰 DOM、不依赖任何第三方库，方便在 Node 里单测（packages/server/test/office-preview.test.ts）。
 * 设计见 docs/design/office-file-preview.md。
 */

// ------------------------------------------------------------------ PPT 文字清洗（白名单）

const ALLOWED_TAGS = new Set(["p", "span", "div", "br", "b", "strong", "i", "em", "u", "s", "sub", "sup", "ul", "ol", "li", "a"]);
/** 连内容一起丢掉的标签（里面的文字不是给人看的）。 */
const DROP_CONTENT_TAGS = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "title", "svg", "math", "head", "xmp", "noembed", "noframes"]);
const ALLOWED_CSS = new Set([
	"color", "background-color", "font-size", "font-family", "font-weight", "font-style", "text-decoration", "text-decoration-line", "text-align", "line-height",
	"letter-spacing", "text-indent", "vertical-align", "white-space", "text-shadow", "direction", "margin", "margin-top", "margin-bottom", "margin-left", "margin-right",
	"padding", "padding-left", "padding-right", "padding-top", "padding-bottom", "list-style-type", "word-break", "text-transform", "writing-mode",
]);
/** 样式值只允许这些字符，且不能含 url( / expression / import / 反斜杠转义。 */
const CSS_VALUE_OK = /^[\p{L}\p{N}_\s#%.,()+\-'"/]*$/u;
const CSS_VALUE_BAD = /url\s*\(|expression|import|image-set|javascript|var\s*\(|\\/i;

const escText = (t: string) => t.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (t: string) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 只保留白名单里的 CSS 声明；返回清洗后的 style 属性值（可能为空）。 */
export function sanitizeStyle(style: string): string {
	const out: string[] = [];
	for (const decl of style.split(";")) {
		const i = decl.indexOf(":");
		if (i < 0) continue;
		const prop = decl.slice(0, i).trim().toLowerCase();
		const val = decl.slice(i + 1).trim();
		if (!ALLOWED_CSS.has(prop) || !val || !CSS_VALUE_OK.test(val) || CSS_VALUE_BAD.test(val)) continue;
		out.push(`${prop}: ${val}`);
	}
	return out.join("; ");
}

/** a 的 href 只放行 http/https；其他（javascript:、data:、相对路径…）一律去掉。 */
export const safeHttpUrl = (href: string | null | undefined): string | null => {
	const t = (href ?? "").trim();
	return /^https?:\/\/[^\s"'<>\\]+$/i.test(t) ? t : null;
};

function parseAttrs(src: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const m of src.matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g)) {
		const k = m[1].toLowerCase();
		if (!(k in attrs)) attrs[k] = m[2] ?? m[3] ?? m[4] ?? "";
	}
	return attrs;
}

/**
 * 清洗 pptxtojson 给的富文本 HTML：只留 p/span/div/br/b/strong/i/em/u/s/sub/sup/ul/ol/li/a 和白名单 style，
 * `a` 只留 http/https 链接；其余标签去掉（script/iframe 等连内容一起丢），所有事件属性和未知属性丢弃。
 * 做法：词法扫一遍，只用白名单重新拼出一个全新的字符串（不透传任何原始标签 / 属性），所以不依赖浏览器解析差异。
 */
export function sanitizePptHtml(html: string): string {
	const src = String(html ?? "");
	let out = "";
	let i = 0;
	const n = src.length;
	while (i < n) {
		const lt = src.indexOf("<", i);
		if (lt < 0) {
			out += escText(src.slice(i));
			break;
		}
		if (lt > i) out += escText(src.slice(i, lt));
		if (src.startsWith("<!--", lt)) {
			const end = src.indexOf("-->", lt + 4);
			i = end < 0 ? n : end + 3;
			continue;
		}
		const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(src.slice(lt, lt + 8192));
		if (!m) {
			// 不是合法标签（"<" 后面不是字母、或没有收尾）：整个 "<" 当文字
			out += "&lt;";
			i = lt + 1;
			continue;
		}
		i = lt + m[0].length;
		const closing = m[1] === "/";
		const name = m[2].toLowerCase();
		if (DROP_CONTENT_TAGS.has(name)) {
			if (!closing && !/\/\s*$/.test(m[3])) {
				const rest = new RegExp(`</${name}[\\s/>]`, "i").exec(src.slice(i));
				if (!rest) i = n;
				else {
					const gt = src.indexOf(">", i + rest.index);
					i = gt < 0 ? n : gt + 1;
				}
			}
			continue;
		}
		if (!ALLOWED_TAGS.has(name)) continue;
		if (closing) {
			if (name !== "br") out += `</${name}>`;
			continue;
		}
		const attrs = parseAttrs(m[3]);
		let tag = `<${name}`;
		const style = attrs.style ? sanitizeStyle(attrs.style) : "";
		if (style) tag += ` style="${escAttr(style)}"`;
		if (name === "a") {
			const href = safeHttpUrl(decodeBasicEntities(attrs.href));
			if (href) tag += ` href="${escAttr(href)}" target="_blank" rel="noopener noreferrer"`;
		}
		out += `${tag}>`;
	}
	return out;
}

function decodeBasicEntities(s: string | undefined): string {
	return (s ?? "").replace(/&(amp|quot|apos|lt|gt|#39);/g, (_, e: string) => ({ amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", "#39": "'" })[e] ?? "");
}

// ------------------------------------------------------------------ 幻灯片坐标 / 样式换算

/** pptxtojson 的长度单位是 pt；CSS 里 1pt = 4/3 px。 */
export const PT_TO_PX = 4 / 3;

/** 幻灯片按容器宽度等比缩放（不放大超过 maxScale，避免小幻灯片糊成一片）。 */
export function slideScale(containerWidth: number, slideWidthPt: number, maxScale = 2): number {
	const w = slideWidthPt * PT_TO_PX;
	if (!(containerWidth > 0) || !(w > 0)) return 1;
	return Math.min(containerWidth / w, maxScale);
}

/** 颜色只认 #hex / rgb(a) / hsl(a) / 英文颜色名，其他一律丢弃（防止 url() 之类混进 style）。 */
export function safeColor(c: unknown): string | undefined {
	if (typeof c !== "string") return undefined;
	const t = c.trim();
	return /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d\s.,%/-]+\)|[a-z]{3,20})$/i.test(t) ? t : undefined;
}

/** 只认 data:image 的 base64（pptxtojson imageMode=base64 给的）；其他来源（外链 / blob）不加载。 */
export const safeDataImage = (s: unknown): string | undefined => (typeof s === "string" && /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(s) ? s : undefined);

type FillLike = { type?: string; value?: unknown } | undefined | null;
/** 幻灯片 / 形状的填充 → CSS background（颜色、渐变、图片；图案退成前景色）。 */
export function fillToCss(fill: FillLike): { background?: string; backgroundColor?: string; backgroundSize?: string } {
	if (!fill) return {};
	const v = fill.value as Record<string, unknown> | undefined;
	if (fill.type === "color") {
		const c = safeColor(fill.value);
		return c ? { backgroundColor: c } : {};
	}
	if (fill.type === "gradient" && v && Array.isArray(v.colors)) {
		const stops = (v.colors as { pos?: string; color?: string }[])
			.map((s) => {
				const c = safeColor(s.color);
				const p = /^\d{1,3}(\.\d+)?%$/.test(String(s.pos)) ? String(s.pos) : "";
				return c ? `${c} ${p}`.trim() : "";
			})
			.filter(Boolean);
		if (!stops.length) return {};
		if (stops.length === 1) return { backgroundColor: stops[0].split(" ")[0] };
		const rot = Number(v.rot);
		const angle = Number.isFinite(rot) ? rot + 90 : 180;
		return { background: v.path === "circle" ? `radial-gradient(${stops.join(",")})` : `linear-gradient(${angle}deg,${stops.join(",")})` };
	}
	if (fill.type === "image" && v) {
		const img = safeDataImage(v.base64);
		return img ? { background: `center / cover no-repeat url("${img}")` } : {};
	}
	if (fill.type === "pattern" && v) {
		const c = safeColor(v.backgroundColor) ?? safeColor(v.foregroundColor);
		return c ? { backgroundColor: c } : {};
	}
	return {};
}

export function shadowToCss(s: { h?: number; v?: number; blur?: number; color?: string } | undefined): string | undefined {
	const c = safeColor(s?.color);
	if (!s || !c) return undefined;
	return `${(s.h ?? 0) * PT_TO_PX}px ${(s.v ?? 0) * PT_TO_PX}px ${(s.blur ?? 0) * PT_TO_PX}px ${c}`;
}

export function borderToCss(e: { borderColor?: string; borderWidth?: number; borderType?: string }): string | undefined {
	const c = safeColor(e.borderColor);
	const w = Number(e.borderWidth);
	if (!c || !(w > 0)) return undefined;
	const type = e.borderType === "dashed" || e.borderType === "dotted" ? e.borderType : "solid";
	return `${Math.max(w * PT_TO_PX, 0.5)}px ${type} ${c}`;
}

/** 元素的位置 / 大小 / 旋转 / 翻转（px，相对幻灯片左上角）。 */
export function boxStyle(e: { left?: number; top?: number; width?: number; height?: number; rotate?: number; isFlipH?: boolean; isFlipV?: boolean }): Record<string, string | number> {
	const f = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) * PT_TO_PX : 0);
	const tf: string[] = [];
	if (Number(e.rotate)) tf.push(`rotate(${Number(e.rotate)}deg)`);
	if (e.isFlipH || e.isFlipV) tf.push(`scale(${e.isFlipH ? -1 : 1},${e.isFlipV ? -1 : 1})`);
	return { position: "absolute", left: f(e.left), top: f(e.top), width: f(e.width), height: f(e.height), ...(tf.length ? { transform: tf.join(" ") } : {}) };
}

// ------------------------------------------------------------------ Excel 单元格

/** 单元格显示文本：日期按本地格式（Excel 日期没有时区，用 UTC 字段取值避免差一天）；布尔 TRUE/FALSE。 */
export function formatCell(v: unknown, locale?: string): string {
	if (v == null) return "";
	if (v instanceof Date) {
		if (Number.isNaN(v.getTime())) return "";
		const dateOnly = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
		return dateOnly
			? v.toLocaleDateString(locale, { timeZone: "UTC" })
			: v.toLocaleString(locale, { timeZone: "UTC" });
	}
	if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
	// 和 Excel「常规」格式一样最多 11 位有效数字（0.1+0.2 显示 0.3，1/30 显示 0.033333333333）
	if (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v)) return String(Number(v.toPrecision(11)));
	return String(v);
}

/** Word 列表符号常用 Symbol / Wingdings 字体的私有区字符，网页里没有这些字体会显示成方框：换成同义的 Unicode 符号，认不出的一律换成「•」。 */
const SYMBOL_BULLETS: Record<string, string> = { "\uf0b7": "•", "\uf0a7": "▪", "\uf06c": "●", "\uf06e": "■", "\uf071": "❑", "\uf076": "❖", "\uf0d8": "➢", "\uf0fc": "✓", "\uf0e8": "➔", "\uf0a8": "◆" };
export const fixSymbolBullets = (css: string) => css.replace(/[\uf000-\uf0ff]/g, (c) => SYMBOL_BULLETS[c] ?? "•");

// ------------------------------------------------------------------ zip 列表

export const MAX_ZIP_ENTRIES = 2000;
export type ZipEntry = { name: string; dir: boolean; size?: number };
export type ZipListing = { entries: ZipEntry[]; total: number; truncated: boolean };

/** 整理 zip 条目：去掉 macOS 的 __MACOSX/ 噪音，按路径排序（文件夹自然排在它的内容前面），最多 MAX_ZIP_ENTRIES 条。 */
export function listZipEntries(raw: ZipEntry[], max = MAX_ZIP_ENTRIES): ZipListing {
	const all = raw.filter((e) => e.name && !/^__MACOSX\//.test(e.name));
	all.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }));
	return { entries: all.slice(0, max), total: all.length, truncated: all.length > max };
}

// ------------------------------------------------------------------ iWork 预览图

const IWORK_PREVIEW_PATHS = ["preview.jpg", "preview.jpeg", "preview.png", "quicklook/thumbnail.jpg", "quicklook/thumbnail.png", "thumbnails/thumbnail.jpg", "thumbnails/thumbnail.png", "preview-web.jpg", "preview-micro.jpg"];

/** 从 iWork 包（zip）的文件名里挑最大最合适的预览图；没有返回 null。 */
export function pickIworkPreview(names: string[]): { path: string; mime: string } | null {
	const lower = new Map<string, string>();
	for (const n of names) lower.set(n.toLowerCase().replace(/^\.\//, ""), n);
	let hit: string | undefined;
	for (const p of IWORK_PREVIEW_PATHS) {
		hit = lower.get(p);
		if (hit) break;
	}
	if (!hit) for (const [k, n] of lower) if (/^(quicklook|thumbnails)\/[^/]+\.(jpe?g|png)$/.test(k)) hit = hit ?? n;
	if (!hit) return null;
	return { path: hit, mime: /\.png$/i.test(hit) ? "image/png" : "image/jpeg" };
}

// ------------------------------------------------------------------ Jupyter

export type NbOutput = { kind: "text"; text: string; error?: boolean } | { kind: "image"; mime: "image/png" | "image/jpeg"; src: string };
export type NbCell = { kind: "markdown" | "code" | "raw"; source: string; count: number | null; outputs: NbOutput[] };
export type Notebook = { cells: NbCell[]; language: string; truncated: boolean };

const MAX_NB_CELLS = 1000;
const MAX_NB_OUTPUT_CHARS = 200_000;
const joinLines = (v: unknown): string => (Array.isArray(v) ? v.map(String).join("") : typeof v === "string" ? v : "");
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
const clip = (s: string) => (s.length > MAX_NB_OUTPUT_CHARS ? `${s.slice(0, MAX_NB_OUTPUT_CHARS)}\n…（输出过长，已截断）` : s);

function parseOutput(o: Record<string, unknown>): NbOutput[] {
	const type = o.output_type;
	if (type === "stream") return [{ kind: "text", text: clip(stripAnsi(joinLines(o.text))) }];
	if (type === "error") {
		const tb = Array.isArray(o.traceback) ? o.traceback.map(String).join("\n") : "";
		return [{ kind: "text", error: true, text: clip(stripAnsi(tb || `${String(o.ename ?? "Error")}: ${String(o.evalue ?? "")}`)) }];
	}
	if (type !== "display_data" && type !== "execute_result") return [];
	const data = (o.data ?? {}) as Record<string, unknown>;
	const res: NbOutput[] = [];
	for (const mime of ["image/png", "image/jpeg"] as const) {
		const b64 = joinLines(data[mime]).replace(/\s+/g, "");
		if (b64 && /^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
			res.push({ kind: "image", mime, src: `data:${mime};base64,${b64}` });
			break;
		}
	}
	// text/html、image/svg+xml、javascript 等不渲染；只显示 text/plain（没有就什么都不显示）
	const plain = joinLines(data["text/plain"]);
	if (plain && !res.length) res.push({ kind: "text", text: clip(stripAnsi(plain)) });
	return res;
}

/** 解析 .ipynb（nbformat 3 的 worksheets 也认）。不是合法 notebook 时抛错。 */
export function parseIpynb(text: string): Notebook {
	const nb = JSON.parse(text) as Record<string, unknown>;
	if (!nb || typeof nb !== "object") throw new Error("not a notebook");
	const rawCells = Array.isArray(nb.cells) ? nb.cells : Array.isArray((nb.worksheets as { cells?: unknown[] }[] | undefined)?.[0]?.cells) ? (nb.worksheets as { cells: unknown[] }[])[0].cells : null;
	if (!rawCells) throw new Error("not a notebook");
	const meta = (nb.metadata ?? {}) as { language_info?: { name?: string }; kernelspec?: { language?: string } };
	const cells: NbCell[] = [];
	for (const c of rawCells.slice(0, MAX_NB_CELLS) as Record<string, unknown>[]) {
		if (!c || typeof c !== "object") continue;
		const t = c.cell_type === "markdown" || c.cell_type === "heading" ? "markdown" : c.cell_type === "code" ? "code" : "raw";
		const source = joinLines(c.source ?? c.input);
		const prefix = c.cell_type === "heading" ? `${"#".repeat(Math.min(Math.max(Number(c.level) || 1, 1), 6))} ` : "";
		const outs = Array.isArray(c.outputs) ? (c.outputs as Record<string, unknown>[]).flatMap((o) => (o && typeof o === "object" ? parseOutput(o) : [])) : [];
		const n = Number(c.execution_count ?? c.prompt_number);
		cells.push({ kind: t, source: prefix + source, count: Number.isFinite(n) && c.execution_count !== null ? n : null, outputs: outs });
	}
	return { cells, language: meta.language_info?.name ?? meta.kernelspec?.language ?? "python", truncated: rawCells.length > MAX_NB_CELLS };
}
