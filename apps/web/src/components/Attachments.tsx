import { AlertCircle, Download, File as FileIc, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Loader2, Paperclip, Presentation, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { download, fetchBlob } from "../api";
import type { Attachment } from "../types";
import { openFilePreview } from "./FilePreview";
import { cx, fmtSize } from "./ui";
import { openImageViewer } from "./ImageViewer";
import { MediaAttachment } from "./MediaPlayer";
import { previewKind } from "../preview";

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
	return (
		<div className={cx("flex flex-col gap-2", mine ? "mt-1.5 items-end" : "items-start")}>
			{items.map((f) =>
				f.mime.startsWith("image/") && f.mime !== "image/svg+xml" ? (
					<div key={f.fileId} className="group relative max-w-full" data-testid="image-attachment">
						<AuthImage
							path={`/api/files/${f.fileId}?inline=1`}
							alt={f.name}
							className="max-h-64 max-w-[min(300px,100%)] cursor-zoom-in rounded-xl border border-line object-cover shadow-sm"
							onClick={() => openImageViewer({ authPath: `/api/files/${f.fileId}?inline=1`, alt: f.name, name: f.name, downloadPath: `/api/files/${f.fileId}` })}
						/>
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
				) : ["video", "audio"].includes(previewKind(f.name, f.mime)) ? (
					<MediaAttachment key={f.fileId} f={f} />
				) : (
					// 非图片：点卡片主体 / 文件名 = 应用内预览；右侧下载图标是独立按钮（stopPropagation，不会误触预览）
					<div key={f.fileId} className="pa-card pa-file-card w-full" data-testid="file-attachment">
						<button
							type="button"
							onClick={() => openFilePreview({ name: f.name, mime: f.mime, size: f.size, url: `/api/files/${f.fileId}`, downloadPath: `/api/files/${f.fileId}` })}
							className="flex min-w-0 flex-1 items-center gap-3 text-left"
							title={`预览 ${f.name}`}
							aria-label={`预览 ${f.name}`}
							data-testid="file-preview-open"
						>
							<span className="pa-file-ic">
								<FileKindIcon name={f.name} className="pa-ic" />
								<em>{(f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase()}</em>
							</span>
							<span className="pa-file-txt">
								<b title={f.name}>{f.name}</b>
								<small title={f.workspacePath || undefined}>{fmtSize(f.size)}{f.workspacePath ? ` · ${f.workspacePath}` : ""}</small>
							</span>
						</button>
						<button
							type="button"
							className="pa-icon-btn shrink-0"
							onClick={(e) => {
								e.stopPropagation();
								void download(`/api/files/${f.fileId}`, f.name);
							}}
							title={`下载 ${f.name}`}
							aria-label={`下载 ${f.name}`}
							data-testid="file-download"
						>
							<Download className="pa-ic" />
						</button>
					</div>
				),
			)}
		</div>
	);
}

// ------------------------------------------------------------------ 输入框附件（单聊和群聊共用）
export const MAX_UPLOAD = 100 * 1024 * 1024;
/** 还在上传、还没拿到 fileId 的附件（图片带本地预览 blob） */
export type Pending = { key: string; name: string; size: number; preview?: string; error?: string };
export const ATTACH_HINT =
	"添加图片或文件（也可以拖进来、直接粘贴截图）。单个文件不超过 100MB。\n助理能看到什么：图片会直接给支持看图的模型（不支持看图的模型只知道文件路径）；PDF、Word、Excel、PPT、文本会自动提取文字（最多约 2 万 token，扫描版 PDF 没有文字）；完整文件放在助理的工作区里，它可以用工具打开。";

export function fileKind(name: string): "image" | "video" | "audio" | "pdf" | "doc" | "sheet" | "slide" | "code" | "archive" | "other" {
	const ext = (name.split(".").pop() ?? "").toLowerCase();
	if (["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg", "bmp"].includes(ext)) return "image";
	if (previewKind(name) === "video") return "video";
	if (previewKind(name) === "audio") return "audio";
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
	const I = { image: FileImage, video: FileVideo, audio: FileAudio, pdf: FileText, doc: FileText, sheet: FileSpreadsheet, slide: Presentation, code: FileCode, archive: FileArchive, other: FileIc }[k];
	return <I className={className} size={size} data-kind={k} />;
}
const SEES: Record<ReturnType<typeof fileKind>, string> = {
	image: "图片：支持看图的模型会直接看到",
	video: "视频：助理会拿到文件路径，可以用工具打开",
	audio: "音频：助理会拿到文件路径，可以用工具打开",
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
	const [pending, setPending] = useState<Pending[]>([]);
	const [uploading, setUploading] = useState(0);
	const [error, setError] = useState("");
	const fn = useRef(uploadFn);
	fn.current = uploadFn;
	const seq = useRef(0);
	// 上传中的本地预览 blob：只给 tray 缩略图用，不交给 ImageViewer（查看器自己拉服务端文件、自己管生命周期），
	// 所以卸载/移除时撤销不会打断已经打开的查看器。
	const previews = useRef(new Map<string, string>());
	const dropPreview = (key: string) => {
		const u = previews.current.get(key);
		if (u) {
			URL.revokeObjectURL(u);
			previews.current.delete(key);
		}
	};
	useEffect(() => () => {
		previews.current.forEach((u) => URL.revokeObjectURL(u));
		previews.current.clear();
	}, []);
	const removePending = (key: string) => {
		dropPreview(key);
		setPending((p) => p.filter((x) => x.key !== key));
	};
	const addFiles = async (list: FileList | File[]) => {
		setError("");
		for (const raw of Array.from(list)) {
			// 粘贴的截图常常没有名字 / 都叫 image.png
			const f = raw.name && raw.name !== "image.png" ? raw : new File([raw], `粘贴的图片-${Date.now()}.${raw.type.split("/")[1] || "png"}`, { type: raw.type });
			if (f.size > MAX_UPLOAD) {
				setError(`「${f.name}」超过 100MB，发不了。可以压缩或拆分后再发。`);
				continue;
			}
			const key = `u${++seq.current}`;
			const preview = f.type.startsWith("image/") && f.type !== "image/svg+xml" ? (previews.current.set(key, URL.createObjectURL(f)), previews.current.get(key)) : undefined;
			setPending((p) => [...p, { key, name: f.name, size: f.size, preview }]);
			setUploading((n) => n + 1);
			try {
				const info = await fn.current(f);
				setFiles((x) => [...x, info]);
				dropPreview(key);
				setPending((p) => p.filter((x) => x.key !== key));
			} catch (e) {
				setPending((p) => p.map((x) => (x.key === key ? { ...x, error: (e as Error).message } : x)));
			} finally {
				setUploading((n) => n - 1);
			}
		}
	};
	return { files, setFiles, pending, uploading, error, addFiles, removePending, clear: () => (setFiles([]), setPending((p) => (p.forEach((x) => dropPreview(x.key)), [])), setError("")) };
}

export function AttachTray({ files, pending = [], uploading, error, onRemove, onRemovePending }: { files: Attachment[]; pending?: Pending[]; uploading: number; error?: string; onRemove: (id: string) => void; onRemovePending?: (key: string) => void }) {
	if (!files.length && !pending.length && !uploading && !error) return null;
	return (
		<div className="flex flex-wrap gap-2 pb-2" data-testid="attach-tray">
			{files.map((f) =>
				f.mime.startsWith("image/") && f.mime !== "image/svg+xml" ? (
					<TrayThumb
						key={f.fileId}
						name={f.name}
						authPath={`/api/files/${f.fileId}?inline=1`}
						onRemove={() => onRemove(f.fileId)}
						onOpen={() => openImageViewer({ authPath: `/api/files/${f.fileId}?inline=1`, alt: f.name, name: f.name, downloadPath: `/api/files/${f.fileId}` })}
					/>
				) : (
					<FileChip key={f.fileId} name={f.name} size={f.size} onRemove={() => onRemove(f.fileId)} />
				),
			)}
			{pending.map((p) =>
				p.preview ? <TrayThumb key={p.key} name={p.name} preview={p.preview} busy={!p.error} error={p.error} onRemove={() => onRemovePending?.(p.key)} /> : <FileChip key={p.key} name={p.name} size={p.size} busy={!p.error} error={p.error} onRemove={() => onRemovePending?.(p.key)} />,
			)}
			{uploading > 0 && (
				<span className="flex items-center gap-1 text-xs text-mut">
					<Loader2 size={12} className="animate-spin" /> 上传中…
				</span>
			)}
			{error && <span className="w-full text-xs text-red-600" data-testid="attach-error">{error}</span>}
		</div>
	);
}

/** 非图片：保留原来的文件 chip（文件名 + 大小 + 移除） */
function FileChip({ name, size, busy, error, onRemove }: { name: string; size: number; busy?: boolean; error?: string; onRemove: () => void }) {
	return (
		<span className={cx("pa-chip sm !h-7 max-w-full", error && "border-red-400")} title={`${name}\n${error ?? SEES[fileKind(name)]}`} data-testid="attach-chip" data-kind="file">
			{busy ? <Loader2 size={12} className="animate-spin" /> : <FileKindIcon name={name} size={12} />} <span className="max-w-[160px] truncate">{name}</span> <span className="text-mut2">{fmtSize(size)}</span>
			<button onClick={onRemove} aria-label={`移除 ${name}`} data-testid="attach-remove">
				<X size={12} />
			</button>
		</span>
	);
}

/** 图片：72px 缩略图，点击复用全屏查看器；上传中/失败盖一层状态。 */
function TrayThumb({ name, authPath, preview, busy, error, onOpen, onRemove }: { name: string; authPath?: string; preview?: string; busy?: boolean; error?: string; onOpen?: () => void; onRemove: () => void }) {
	const box = "relative h-[72px] w-[72px] overflow-hidden rounded-lg border bg-hover";
	const face = preview ? <img src={preview} alt={name} className="h-full w-full object-cover" /> : authPath ? <AuthImage path={authPath} alt={name} className="h-full w-full object-cover" /> : <FileKindIcon name={name} className="pa-ic" />;
	return (
		<div className="relative" data-testid="attach-chip" data-kind="image" title={error ? `${name}\n${error}` : `${name}\n点击预览`}>
			{onOpen ? (
				<button type="button" className={cx(box, "cursor-zoom-in", error ? "border-red-400" : "border-line")} onClick={onOpen} aria-label={`预览 ${name}`} data-testid="attach-thumb">
					{face}
				</button>
			) : (
				<div className={cx(box, error ? "border-red-400" : "border-line")} data-testid="attach-thumb">
					{face}
				</div>
			)}
			{(busy || error) && (
				<span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 text-white">{error ? <AlertCircle size={16} /> : <Loader2 size={16} className="animate-spin" />}</span>
			)}
			<button type="button" className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white shadow transition hover:bg-black/80" onClick={onRemove} aria-label={`移除 ${name}`} data-testid="attach-remove">
				<X size={12} />
			</button>
		</div>
	);
}

export function AttachButton({ onFiles, label = "上传", disabled }: { onFiles: (f: FileList) => void; label?: string; disabled?: boolean }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<input ref={input} type="file" multiple hidden data-testid="attach-input" onChange={(e) => (e.target.files && onFiles(e.target.files), (e.target.value = ""))} />
			<button className="pa-icon-btn ghost disabled:opacity-50" disabled={disabled} onClick={() => input.current?.click()} aria-label={label} title={ATTACH_HINT} data-testid="attach-btn">
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
