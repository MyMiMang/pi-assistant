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
		<div className={cx("mt-1.5 flex flex-wrap gap-2", mine && "justify-end")}>
			{items.map((f) =>
				f.mime.startsWith("image/") && f.mime !== "image/svg+xml" ? (
					<AuthImage key={f.fileId} path={`/api/files/${f.fileId}?inline=1`} alt={f.name} className="max-h-64 max-w-[260px] cursor-zoom-in rounded-xl border border-zinc-200 object-cover dark:border-zinc-700" onClick={() => setZoom(f)} />
				) : (
					<button
						key={f.fileId}
						onClick={() => download(`/api/files/${f.fileId}`, f.name)}
						className="flex w-64 max-w-full items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 text-left transition hover:border-accent dark:border-zinc-700 dark:bg-zinc-900"
						title="下载"
					>
						<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
							<FileText size={20} />
						</div>
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{f.name}</div>
							<div className="text-xs text-zinc-500">{fmtSize(f.size)}</div>
						</div>
						<Download size={16} className="text-zinc-400" />
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
