import { AlertCircle, Copy, FileQuestion, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchBlobLimited, viewUrl } from "../api";
import { copyText } from "../clipboard";
import { MAX_CSV_COLS, MAX_CSV_ROWS, MAX_TEXT_BYTES, MAX_TEXT_LINES, looksBinary, parseCsv, stripBom } from "../preview";
import Markdown from "./Markdown";
import { Help, cx, fmtSize } from "./ui";

/** FilePreview 弹窗里各类文件的具体视图（Markdown / CSV / 代码 / HTML / SVG）和共用的小部件。 */

export type TextLoad = { s: "ok"; bytes: Uint8Array; text: string } | { s: "oversize" } | { s: "binary" };

/** 按 MAX_TEXT_BYTES 拉取文本：超限 / 看起来是二进制都返回对应状态，不硬解。网络错误直接抛。 */
export async function loadText(url: string, size: number | undefined, signal: AbortSignal): Promise<TextLoad> {
	if (size != null && size > MAX_TEXT_BYTES) return { s: "oversize" };
	const { blob, oversized } = await fetchBlobLimited(url, MAX_TEXT_BYTES, signal);
	if (oversized) return { s: "oversize" };
	const bytes = new Uint8Array(await blob.arrayBuffer());
	// 类型不只靠扩展名 / Content-Type：实际字节像二进制就不当文本解码
	if (looksBinary(bytes)) return { s: "binary" };
	return { s: "ok", bytes, text: stripBom(new TextDecoder("utf-8").decode(bytes)) };
}

export const OVERSIZE_NOTICE = {
	title: "文件太大，没在应用里预览",
	body: `文本预览上限 ${fmtSize(MAX_TEXT_BYTES)}，这个文件更大。用右上角「下载」看完整内容。`,
};

/** 顶部「渲染 / 源码」这类模式切换条（Markdown、HTML、SVG 共用）。testId 为 `${prefix}-mode-bar` / `${prefix}-mode-${模式}`。 */
export function ModeBar({ prefix, label, modes, value, onChange, children }: { prefix: string; label: string; modes: [string, string][]; value: string; onChange: (m: string) => void; children?: React.ReactNode }) {
	return (
		<div className="flex items-center gap-1 border-b border-line px-3 py-1.5 text-xs text-mut2" data-testid={`${prefix}-mode-bar`}>
			<span className="mr-auto flex min-w-0 items-center gap-1">
				<span className="shrink-0">{label}</span>
				{children}
			</span>
			{modes.map(([id, text]) => (
				<button key={id} type="button" className={cx("pa-chip sm", value === id && "!text-accent")} onClick={() => onChange(id)} data-testid={`${prefix}-mode-${id}`}>
					{text}
				</button>
			))}
		</div>
	);
}

export function Notice({ icon, title, body, testId, children }: { icon: React.ReactNode; title: string; body: string; testId: string; children?: React.ReactNode }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" data-testid={testId}>
			<div className="text-mut2">{icon}</div>
			<div className="text-sm font-medium">{title}</div>
			<div className="max-w-md text-xs text-mut2">{body}</div>
			{children}
		</div>
	);
}

export function MarkdownScroll({ text }: { text: string }) {
	const [mode, setMode] = useState("rendered");
	return (
		<div className="flex h-full min-h-0 flex-col">
			<ModeBar prefix="md" label="Markdown" modes={[["rendered", "渲染"], ["source", "源码"]]} value={mode} onChange={setMode} />
			{mode === "rendered" ? (
				<div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-3" data-testid="file-preview-markdown">
					{/* 预览场景：外链图片默认不加载（不自动把来源信息发到外网） */}
					<Markdown text={text} blockRemoteImages />
				</div>
			) : (
				<CodeView text={text} />
			)}
		</div>
	);
}

export function CsvView({ text, tsv }: { text: string; tsv?: boolean }) {
	const { rows, truncated } = parseCsv(text, { maxRows: MAX_CSV_ROWS, maxCols: MAX_CSV_COLS, delimiter: tsv ? "\t" : "," });
	const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
	const [head, ...body] = rows;
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="file-preview-csv">
			<div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs text-mut2">
				<span>
					{rows.length} 行 × {cols} 列
				</span>
				{truncated && <span className="text-amber-600">超过 {MAX_CSV_ROWS} 行 / {MAX_CSV_COLS} 列，已截断，完整内容请下载</span>}
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				<table className="w-max min-w-full border-collapse text-[12.5px]">
					<thead className="sticky top-0 z-10 bg-card">
						<tr>
							{Array.from({ length: cols }).map((_, i) => (
								<th key={i} className="border border-line px-2 py-1 text-left font-medium whitespace-nowrap">
									{head?.[i] ?? ""}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{body.map((r, ri) => (
							<tr key={ri} className="even:bg-hover/40">
								{Array.from({ length: cols }).map((_, ci) => (
									<td key={ci} className="max-w-[360px] border border-line px-2 py-1 align-top [overflow-wrap:anywhere]">
										{r[ci] ?? ""}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

export function CodeView({ text }: { text: string }) {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const shown = lines.length > MAX_TEXT_LINES ? lines.slice(0, MAX_TEXT_LINES) : lines;
	const [copied, setCopied] = useState(false);
	const copy = () => {
		void copyText(text).then((ok) => {
			if (!ok) return;
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="file-preview-code">
			<div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-xs text-mut2">
				<span>{lines.length} 行</span>
				<button type="button" className="pa-chip sm ml-auto" onClick={copy} data-testid="file-preview-copy">
					<Copy size={12} /> {copied ? "已复制" : "复制"}
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto bg-hover/30">
				<pre className="m-0 w-max min-w-full p-3 font-mono text-[12.5px] leading-5">
					<code>
						{shown.map((ln, i) => (
							<div key={i} className="flex">
								<span className="w-10 shrink-0 pr-3 text-right text-mut2/70 select-none">{i + 1}</span>
								<span className="whitespace-pre">{ln || " "}</span>
							</div>
						))}
					</code>
				</pre>
			</div>
			{lines.length > MAX_TEXT_LINES && <div className="border-t border-line px-3 py-1.5 text-xs text-amber-600">文件较长，只显示前 {MAX_TEXT_LINES} 行，完整内容请下载。</div>}
		</div>
	);
}

/** SVG：「图片 / 源码」两档。图片档用 <img src=blob:image/svg+xml>：img 里的 SVG 不执行脚本、不加载外部资源。 */
export function SvgView({ text, url, name }: { text: string; url?: string; name: string }) {
	const [mode, setMode] = useState("image");
	return (
		<div className="flex h-full min-h-0 flex-col">
			<ModeBar prefix="svg" label="SVG" modes={[["image", "图片"], ["source", "源码"]]} value={mode} onChange={setMode} />
			{mode === "image" ? (
				<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-white p-3" data-testid="file-preview-svg">
					{url ? <img src={url} alt={name} className="max-h-full max-w-full object-contain" /> : null}
				</div>
			) : (
				<CodeView text={text} />
			)}
		</div>
	);
}

/**
 * HTML：「网页 / 源码」两档，默认网页。
 * 网页档是 sandbox iframe（不给 allow-same-origin，页面读不到 App 的数据），地址是服务端换来的短时签名链接；
 * 源码档切过去才按 MAX_TEXT_BYTES 拉文本。设计见 docs/design/html-file-preview.md。
 */
export function HtmlView({ path, size }: { path: string; size?: number }) {
	const [mode, setMode] = useState("page");
	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="file-preview-html">
			<ModeBar prefix="html" label="网页" modes={[["page", "网页"], ["source", "源码"]]} value={mode} onChange={setMode}>
				<span className="truncate text-mut2" data-testid="html-isolated-note">页面在隔离环境里运行，读不到 App 的数据</span>
				<Help>
					这个页面在隔离的沙盒里运行：能执行自己的脚本、加载 https 的网络资源（比如 CDN 上的库和字体），但读不到本应用的任何数据，也连不到本机服务。
					HTML 里用相对路径引用的旁边文件（如 ./style.css、./img.png）加载不到；单文件网页和用 CDN 的网页正常。
				</Help>
			</ModeBar>
			{mode === "page" ? <HtmlFrame path={path} /> : <HtmlSource path={path} size={size} />}
		</div>
	);
}

function HtmlFrame({ path }: { path: string }) {
	const [src, setSrc] = useState<string>();
	const [err, setErr] = useState("");
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		let dead = false;
		setSrc(undefined);
		setErr("");
		viewUrl(path).then(
			(u) => !dead && setSrc(u),
			(e) => !dead && setErr((e as Error).message || "未知错误"),
		);
		return () => {
			dead = true;
		};
	}, [path, nonce]);
	if (err)
		return (
			<Notice icon={<AlertCircle size={22} />} title="打不开网页" body={`加载失败：${err}`} testId="html-page-error">
				<button type="button" className="pa-chip sm" onClick={() => setNonce((n) => n + 1)}>
					<RotateCcw size={13} /> 重试
				</button>
			</Notice>
		);
	if (!src) return <Loading />;
	return (
		<iframe
			title="网页预览"
			src={src}
			sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
			referrerPolicy="no-referrer"
			className="min-h-0 w-full flex-1 border-0 bg-white"
			data-testid="html-frame"
		/>
	);
}

function HtmlSource({ path, size }: { path: string; size?: number }) {
	const [st, setSt] = useState<TextLoad | { s: "loading" } | { s: "error"; message: string }>({ s: "loading" });
	useEffect(() => {
		const ac = new AbortController();
		loadText(path, size, ac.signal).then(
			(r) => !ac.signal.aborted && setSt(r),
			(e) => !ac.signal.aborted && setSt({ s: "error", message: (e as Error).message }),
		);
		return () => ac.abort();
	}, [path, size]);
	if (st.s === "loading") return <Loading />;
	if (st.s === "error") return <Notice icon={<AlertCircle size={22} />} title="打不开源码" body={`加载失败：${st.message || "未知错误"}`} testId="html-source-error" />;
	if (st.s === "oversize") return <Notice icon={<FileQuestion size={22} />} title={OVERSIZE_NOTICE.title} body={OVERSIZE_NOTICE.body} testId="file-preview-oversize" />;
	if (st.s === "binary") return <Notice icon={<FileQuestion size={22} />} title="这是二进制文件" body="不能按文本预览（避免显示乱码）。用右上角「下载」打开。" testId="file-preview-binary" />;
	return <CodeView text={st.text} />;
}

function Loading() {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center text-mut" data-testid="html-loading">
			<Loader2 className="animate-spin" size={22} />
		</div>
	);
}
