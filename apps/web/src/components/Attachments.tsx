import { Download, FileText } from "lucide-react";
import { useEffect, useState } from "react";
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
							<FileText className="pa-ic" />
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
