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
					<AuthImage key={f.fileId} path={`/api/files/${f.fileId}?inline=1`} alt={f.name} className="max-h-64 max-w-[300px] cursor-zoom-in rounded-xl border border-line object-cover shadow-sm" onClick={() => setZoom(f)} />
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
				</div>
			)}
		</div>
	);
}
