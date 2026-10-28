import { FileQuestion, Folder } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fixSymbolBullets, formatCell, listZipEntries, parseIpynb, pickIworkPreview, type ZipEntry } from "../office-preview";
import { MAX_CSV_COLS, MAX_CSV_ROWS, type PreviewKind } from "../preview";
import { CodeView, ModeBar, Notice, TableView } from "./FilePreviewViews";
import Markdown from "./Markdown";
import { ParseFail, ParseLoading, ShadowHost, useParsed } from "./OfficeParts";
import { PptxView } from "./OfficeSlides";
import { Select, cx, fmtSize } from "./ui";

/** Word / Excel / Apple iWork / zip / Jupyter 的预览视图。库都用 import() 按需加载。设计见 docs/design/office-file-preview.md。 */

export function OfficeView({ kind, buf, name }: { kind: PreviewKind; buf: ArrayBuffer; name: string }) {
	if (kind === "docx") return <DocxView buf={buf} />;
	if (kind === "xlsx") return <XlsxView buf={buf} />;
	if (kind === "pptx") return <PptxView buf={buf} />;
	if (kind === "iwork") return <IworkView buf={buf} name={name} />;
	if (kind === "zip") return <ZipView buf={buf} />;
	return <IpynbView buf={buf} />;
}

// ------------------------------------------------------------------ Word

function DocxView({ buf }: { buf: ArrayBuffer }) {
	const [root, setRoot] = useState<ShadowRoot | null>(null);
	const outer = useRef<HTMLDivElement>(null);
	const st = useParsed(async () => {
		if (!root) return new Promise<never>(() => {}); // 等 Shadow DOM 容器就绪
		const { renderAsync } = await import("docx-preview");
		root.replaceChildren();
		const style = document.createElement("div");
		const body = document.createElement("div");
		root.append(style, body);
		// 图片用 data: URL（App 的 CSP 不放行外部资源）；字体不加载（同上）；批注 / 嵌入 HTML 块不渲染
		await renderAsync(buf, body, style, { inWrapper: true, ignoreFonts: true, useBase64URL: true, breakPages: true, renderComments: false, renderAltChunks: false });
		for (const el of style.querySelectorAll("style")) el.textContent = fixSymbolBullets(el.textContent ?? "");
		return true;
	}, [buf, root]);
	// 窄屏：整页按容器宽度等比缩小（不放大）
	useEffect(() => {
		const el = outer.current;
		const wrapper = root?.querySelector<HTMLElement>(".docx-wrapper");
		if (!el || !wrapper || st.s !== "ok") return;
		const fit = () => {
			wrapper.style.zoom = "1";
			// 页面是居中的 flex 子项，溢出时 scrollWidth 量不到：按最宽的一页 + 左右内边距算
			const cs = getComputedStyle(wrapper);
			const pages = [...wrapper.querySelectorAll<HTMLElement>("section")];
			const natural = Math.max(0, ...pages.map((p) => p.offsetWidth)) + parseFloat(cs.paddingLeft || "0") + parseFloat(cs.paddingRight || "0");
			wrapper.style.zoom = natural > el.clientWidth ? String(el.clientWidth / natural) : "1";
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [root, st.s]);
	return (
		<div ref={outer} className="relative h-full overflow-auto bg-hover/30" data-testid="file-preview-docx">
			<ShadowHost onRoot={setRoot} testId="docx-host" />
			{st.s === "loading" && <div className="absolute inset-0 bg-card"><ParseLoading /></div>}
			{st.s === "fail" && <div className="absolute inset-0 bg-card"><ParseFail message={st.message} /></div>}
		</div>
	);
}

// ------------------------------------------------------------------ Excel

function XlsxView({ buf }: { buf: ArrayBuffer }) {
	const st = useParsed(async () => {
		const { default: readXlsxFile } = await import("read-excel-file/browser");
		return readXlsxFile(buf);
	}, [buf]);
	const [idx, setIdx] = useState(0);
	const sheets = st.s === "ok" ? st.v : [];
	const cur = sheets[idx] ?? sheets[0];
	const view = useMemo(() => {
		const data = cur?.data ?? [];
		const rows = data.slice(0, MAX_CSV_ROWS).map((r) => r.slice(0, MAX_CSV_COLS).map((c) => formatCell(c)));
		const truncated = data.length > MAX_CSV_ROWS || data.some((r) => r.length > MAX_CSV_COLS);
		return { rows, truncated };
	}, [cur]);
	if (st.s === "loading") return <ParseLoading />;
	if (st.s === "fail") return <ParseFail message={st.message} />;
	if (!sheets.length) return <Notice icon={<FileQuestion size={22} />} title="这个工作簿是空的" body="没有可显示的工作表。" testId="xlsx-empty" />;
	const picker =
		sheets.length === 1 ? null : sheets.length <= 5 ? (
			<span className="flex items-center gap-1" data-testid="xlsx-sheets">
				{sheets.map((s, i) => (
					<button key={i} type="button" className={cx("pa-chip sm", i === idx && "!text-accent")} onClick={() => setIdx(i)} data-testid={`xlsx-sheet-${i}`}>
						{s.sheet}
					</button>
				))}
			</span>
		) : (
			<Select value={String(idx)} options={sheets.map((s, i) => ({ value: String(i), label: s.sheet }))} onChange={(v) => setIdx(Number(v))} ariaLabel="工作表" testId="xlsx-sheet-select" />
		);
	return <TableView key={idx} rows={view.rows} truncated={view.truncated} testId="file-preview-xlsx" bar={picker} />;
}

// ------------------------------------------------------------------ zip / iWork（jszip）

/** jszip 没有公开的「未压缩大小」接口；这里读它内部记录的值（读不到就不显示大小 / 不拦截）。 */
const entrySize = (f: unknown): number | undefined => {
	const n = (f as { _data?: { uncompressedSize?: number } })?._data?.uncompressedSize;
	return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

function ZipView({ buf }: { buf: ArrayBuffer }) {
	const st = useParsed(async () => {
		const { default: JSZip } = await import("jszip");
		const zip = await JSZip.loadAsync(buf); // 只读中央目录，不解压任何内容
		const raw: ZipEntry[] = [];
		zip.forEach((path, f) => raw.push({ name: path, dir: f.dir, size: f.dir ? undefined : entrySize(f) }));
		return listZipEntries(raw);
	}, [buf]);
	if (st.s === "loading") return <ParseLoading />;
	if (st.s === "fail") return <ParseFail message={st.message} />;
	const { entries, total, truncated } = st.v;
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="file-preview-zip">
			<div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs text-mut2">
				<span>共 {total} 项 · 不解压内容，下载后查看</span>
				{truncated && <span className="text-amber-600">只列出前 {entries.length} 项</span>}
			</div>
			<ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0 text-[12.5px]">
				{entries.map((e, i) => (
					<li key={i} className="flex items-center gap-2 border-b border-line/60 px-3 py-1" data-testid="zip-entry">
						{e.dir ? <Folder size={14} className="shrink-0 text-mut2" /> : <span className="w-[14px] shrink-0" />}
						<span className="min-w-0 flex-1 break-all">{e.name}</span>
						{e.size != null && <span className="shrink-0 text-xs text-mut2">{fmtSize(e.size)}</span>}
					</li>
				))}
			</ul>
		</div>
	);
}

const MAX_IWORK_IMAGE = 20 * 1024 * 1024;

function IworkView({ buf, name }: { buf: ArrayBuffer; name: string }) {
	const st = useParsed(async () => {
		const { default: JSZip } = await import("jszip");
		const zip = await JSZip.loadAsync(buf);
		const hit = pickIworkPreview(Object.keys(zip.files));
		const f = hit && zip.file(hit.path);
		if (!hit || !f || (entrySize(f) ?? 0) > MAX_IWORK_IMAGE) return null;
		return new Blob([await f.async("arraybuffer")], { type: hit.mime });
	}, [buf]);
	const [url, setUrl] = useState<string>();
	useEffect(() => {
		if (st.s !== "ok" || !st.v) return;
		const u = URL.createObjectURL(st.v);
		setUrl(u);
		return () => URL.revokeObjectURL(u);
	}, [st]);
	if (st.s === "loading") return <ParseLoading />;
	if (st.s === "fail") return <ParseFail message={st.message} />;
	if (!st.v) return <Notice icon={<FileQuestion size={22} />} title="这个文件没带预览图" body="Pages / Numbers / Keynote 文件需要用苹果的软件打开。用右上角「下载」保存后查看。" testId="iwork-nopreview" />;
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="file-preview-iwork">
			<div className="border-b border-line px-3 py-1.5 text-xs text-mut2">这是文件自带的预览图（通常只有第一页），完整内容请下载后用苹果软件打开</div>
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-hover/30 p-3">{url ? <img src={url} alt={`${name} 的预览图`} className="max-h-full max-w-full rounded shadow" /> : null}</div>
		</div>
	);
}

// ------------------------------------------------------------------ Jupyter

function IpynbView({ buf }: { buf: ArrayBuffer }) {
	const [mode, setMode] = useState("cells");
	const text = useMemo(() => new TextDecoder("utf-8").decode(buf), [buf]);
	const st = useParsed(async () => parseIpynb(text), [text]);
	if (st.s === "loading") return <ParseLoading />;
	if (st.s === "fail") return <ParseFail message={st.message} />;
	const nb = st.v;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<ModeBar prefix="ipynb" label="Jupyter" modes={[["cells", "单元格"], ["source", "源码"]]} value={mode} onChange={setMode} />
			{mode === "source" ? (
				<CodeView text={text} />
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2" data-testid="file-preview-ipynb">
					{nb.cells.map((c, i) => (
						<div key={i} className="mb-3 border-b border-line/60 pb-3" data-testid={`ipynb-cell-${c.kind}`}>
							{c.kind === "markdown" ? (
								<Markdown text={c.source} blockRemoteImages />
							) : (
								<div className="flex gap-2">
									<span className="w-12 shrink-0 pt-1 text-right font-mono text-[11px] text-mut2 select-none">{c.kind === "code" ? `In [${c.count ?? " "}]` : "Raw"}</span>
									<pre className="m-0 min-w-0 flex-1 overflow-x-auto rounded bg-hover/40 p-2 font-mono text-[12.5px] leading-5">{c.source}</pre>
								</div>
							)}
							{c.outputs.map((o, j) =>
								o.kind === "image" ? (
									<img key={j} src={o.src} alt="输出图片" className="ml-14 mt-1 max-w-[calc(100%-3.5rem)] rounded bg-white" data-testid="ipynb-image" />
								) : (
									<pre key={j} className={cx("m-0 ml-14 mt-1 max-w-[calc(100%-3.5rem)] overflow-x-auto font-mono text-[12.5px] leading-5", o.error && "text-red-600")} data-testid="ipynb-output">
										{o.text}
									</pre>
								),
							)}
						</div>
					))}
					{nb.truncated && <div className="text-xs text-amber-600">单元格太多，只显示前面一部分，完整内容请下载。</div>}
				</div>
			)}
		</div>
	);
}
