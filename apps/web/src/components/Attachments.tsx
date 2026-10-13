import { Download, File as FileIc, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, Loader2, Paperclip, Presentation, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { download, fetchBlob } from "../api";
import type { Attachment } from "../types";
import { cx, fmtSize } from "./ui";

export function AuthImage({ path, alt, className, onClick }: { path: string; alt: string; className?: string; onClick?: () => void }) {
	const [src, setSrc] = useState<string>();
	useEffect(() => {
		let url: string | undefined;
		fetchBlob(path).then((b) => setSrc((url = URL.createObjectURL(b)))).catch(() => {});
		return () => {
			if (url) URL.revokeObjectURL(url);
		};
	}, [path]);
	return src ? <img src={src} alt={alt} className={className} onClick={onClick} /> : <div className={cx(className, "animate-pulse bg-zinc-200 dark:bg-zinc-800")} />;
}

export default function Attachments({ items, mine }: { items: Attachment[]; mine?: boolean }) {
	const [zoom, setZoom] = useState<Attachment | null>(null);
	return (
		<div className={cx("flex flex-col gap-2", mine ? "mt-1.5 items-end" : "items-start")}>
			{items.map((f) =>
				f.mime.startsWith("image/") && f.mime !== "image/svg+xml" ? (
					<div key={f.fileId} className="group relative max-w-full" data-testid="image-attachment">
						<AuthImage path={`/api/files/${f.fileId}?inline=1`} alt={f.name} className="max-h-64 max-w-[min(300px,100%)] cursor-zoom-in rounded-xl border border-line object-cover shadow-sm" onClick={() => setZoom(f)} />
						<button
							type="button"
							title={`下载 ${f.name}`}
							aria-label="下载"
							onClick={() => download(`/api/files/${f.fileId}`, f.name)}
							className="absolute right-1.5 bottom-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white opacity-80 transition group-hover:opacity-100 hover:bg-black/75"
						>
							<Download size={14} />
						</button>
					</div>
				) : (
					<button key={f.fileId} onClick={() => download(`/api/files/${f.fileId}`, f.name)} className="pa-card pa-file-card w-full text-left" title="下载">
						<span className="pa-file-ic">
							<FileKindIcon name={f.name} className="pa-ic" />
							<em>{(f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase()}</em>
						</span>
						<span className="pa-file-txt">
							<b>{f.name}</b>
							<small>{fmtSize(f.size)}{f.workspacePath ? ` · ${f.workspacePath}` : ""}</small>
						</span>
						<span className="pa-icon-btn">
							<Download className="pa-ic" />
						</span>
					</button>
				),
			)}
			{zoom && (
				<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setZoom(null)}>
					<AuthImage path={`/api/files/${zoom.fileId}?inline=1`} alt={zoom.name} className="max-h-full max-w-full rounded-lg" />
					<button type="button" className="absolute top-4 right-4 inline-flex h-9 items-center gap-1.5 rounded-full bg-white/90 px-3 text-sm text-zinc-900" onClick={(e) => (e.stopPropagation(), download(`/api/files/${zoom.fileId}`, zoom.name))}>
						<Download size={15} /> 下载
					</button>
				</div>
			)}
		</div>
	);
}

// ------------------------------------------------------------------ 输入框附件（单聊和群聊共用）
export const MAX_UPLOAD = 100 * 1024 * 1024;
export const ATTACH_HINT =
	"添加图片或文件（也可以拖进来、直接粘贴截图）。单个文件不超过 100MB。\n助理能看到什么：图片会直接给支持看图的模型（不支持看图的模型只知道文件路径）；PDF、Word、Excel、PPT、文本会自动提取文字（最多约 2 万 token，扫描版 PDF 没有文字）；完整文件放在助理的工作区里，它可以用工具打开。";

export function fileKind(name: string): "image" | "pdf" | "doc" | "sheet" | "slide" | "code" | "archive" | "other" {
	const ext = (name.split(".").pop() ?? "").toLowerCase();
	if (["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg", "bmp"].includes(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (["doc", "docx", "txt", "md", "rtf", "odt", "pages"].includes(ext)) return "doc";
	if (["xls", "xlsx", "csv", "tsv", "numbers", "ods"].includes(ext)) return "sheet";
	if (["ppt", "pptx", "key", "odp"].includes(ext)) return "slide";
	if (["js", "ts", "tsx", "py", "json", "html", "css", "sh", "sql", "yaml", "yml", "xml", "go", "rs", "java"].includes(ext)) return "code";
	if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) return "archive";
	return "other";
}
export function FileKindIcon({ name, className, size }: { name: string; className?: string; size?: number }) {
	const k = fileKind(name);
	const I = { image: FileImage, pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slide: Presentation, code: FileCode, archive: FileArchive, other: FileIc }[k];
	return <I className={className} size={size} data-kind={k} />;
}
const SEES: Record<ReturnType<typeof fileKind>, string> = {
	image: "图片：支持看图的模型会直接看到",
	pdf: "PDF：会提取文字给助理（扫描版没有文字）",
	doc: "文档：会提取文字给助理",
	sheet: "表格：会提取单元格内容给助理",
	slide: "幻灯片：会提取每页文字给助理",
	code: "文本：内容会直接给助理",
	archive: "压缩包：助理可以在工作区里解压",
	other: "助理会拿到文件路径，可以用工具打开",
};

export function useAttachUploader(uploadFn: (f: File) => Promise<Attachment>) {
	const [files, setFiles] = useState<Attachment[]>([]);
	const [uploading, setUploading] = useState(0);
	const [error, setError] = useState("");
	const fn = useRef(uploadFn);
	fn.current = uploadFn;
	const addFiles = async (list: FileList | File[]) => {
		setError("");
		for (const raw of Array.from(list)) {
			// 粘贴的截图常常没有名字 / 都叫 image.png
			const f = raw.name && raw.name !== "image.png" ? raw : new File([raw], `粘贴的图片-${Date.now()}.${raw.type.split("/")[1] || "png"}`, { type: raw.type });
			if (f.size > MAX_UPLOAD) {
				setError(`「${f.name}」超过 100MB，发不了。可以压缩或拆分后再发。`);
				continue;
			}
			setUploading((n) => n + 1);
			try {
				const info = await fn.current(f);
				setFiles((x) => [...x, info]);
			} catch (e) {
				setError(`「${f.name}」上传失败：${(e as Error).message}`);
			} finally {
				setUploading((n) => n - 1);
			}
		}
	};
	return { files, setFiles, uploading, error, addFiles, clear: () => (setFiles([]), setError("")) };
}

export function AttachTray({ files, uploading, error, onRemove }: { files: Attachment[]; uploading: number; error?: string; onRemove: (id: string) => void }) {
	if (!files.length && !uploading && !error) return null;
	return (
		<div className="flex flex-wrap gap-2 pb-2" data-testid="attach-tray">
			{files.map((f) => (
				<span key={f.fileId} className="pa-chip sm !h-7 max-w-full" title={`${f.name}\n${SEES[fileKind(f.name)]}`} data-testid="attach-chip">
					<FileKindIcon name={f.name} size={12} /> <span className="max-w-[160px] truncate">{f.name}</span> <span className="text-mut2">{fmtSize(f.size)}</span>
					<button onClick={() => onRemove(f.fileId)} aria-label="移除">
						<X size={12} />
					</button>
				</span>
			))}
			{uploading > 0 && (
				<span className="flex items-center gap-1 text-xs text-mut">
					<Loader2 size={12} className="animate-spin" /> 上传中…
				</span>
			)}
			{error && <span className="w-full text-xs text-red-600" data-testid="attach-error">{error}</span>}
		</div>
	);
}

export function AttachButton({ onFiles, label = "上传" }: { onFiles: (f: FileList) => void; label?: string }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<input ref={input} type="file" multiple hidden data-testid="attach-input" onChange={(e) => (e.target.files && onFiles(e.target.files), (e.target.value = ""))} />
			<button className="pa-icon-btn ghost" onClick={() => input.current?.click()} aria-label={label} title={ATTACH_HINT} data-testid="attach-btn">
				<Paperclip className="pa-ic" />
			</button>
		</>
	);
}

/** 粘贴：剪贴板里有文件（截图）就当附件 */
export const pasteFiles = (e: React.ClipboardEvent, add: (f: File[]) => void) => {
	const fs = Array.from(e.clipboardData.files);
	if (fs.length) (e.preventDefault(), add(fs));
};
