import { AlertCircle, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { download, mediaUrl } from "../api";
import { previewKind } from "../preview";
import type { Attachment } from "../types";
import { FileKindIcon } from "./Attachments";
import { cx, fmtSize } from "./ui";

/**
 * 聊天附件和文件预览共用的视频 / 音频播放器（原生 <video> / <audio>，浏览器自带控件和全屏）。
 *
 * 地址：登录凭证（Authorization 头）带不进 <video src>，也不能把最大 200MB 的视频整个拉成 blob（拖进度条要 Range），
 * 所以向服务端换一条短时有效、只针对这一个文件的签名链接（api.ts 的 mediaUrl）。链接过期 / 播放出错先换一条重试一次，
 * 还不行才显示「没法在这里播放」，下载始终保留。
 */
export type MediaKind = "video" | "audio";

function useMediaSrc(path: string) {
	const [st, setSt] = useState<{ src?: string; failed: boolean }>({ failed: false });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let live = true;
		setSt({ failed: false });
		mediaUrl(path).then(
			(src) => live && setSt({ src, failed: false }),
			() => live && setSt({ failed: true }),
		);
		return () => {
			live = false;
		};
	}, [path, attempt]);
	return { ...st, onError: () => (attempt < 1 ? setAttempt((a) => a + 1) : setSt({ failed: true })) };
}

export function MediaPlayer({ kind, path, name, className, autoPlay }: { kind: MediaKind; path: string; name: string; className?: string; autoPlay?: boolean }) {
	const { src, failed, onError } = useMediaSrc(path);
	if (failed) {
		return (
			<p className="m-0 flex items-center gap-1.5 text-xs text-mut" data-testid="media-error">
				<AlertCircle size={14} className="shrink-0" /> 这个{kind === "video" ? "视频" : "音频"}没法在这里播放，可以下载后打开。
			</p>
		);
	}
	if (!src) return <div className={cx(className, "animate-pulse bg-zinc-200 dark:bg-zinc-800", kind === "video" ? "h-40" : "h-10")} data-testid="media-loading" />;
	return kind === "video" ? (
		<video src={src} controls preload="metadata" playsInline autoPlay={autoPlay} onError={onError} aria-label={name} className={className} data-testid="media-video" />
	) : (
		<audio src={src} controls preload="metadata" autoPlay={autoPlay} onError={onError} aria-label={name} className={className} data-testid="media-audio" />
	);
}

/** 聊天里的视频 / 音频附件：视频是内嵌播放器 + 一行文件信息；音频是带播放器的紧凑卡片。 */
export function MediaAttachment({ f }: { f: Attachment }) {
	const kind: MediaKind = previewKind(f.name, f.mime) === "video" ? "video" : "audio";
	const path = `/api/files/${f.fileId}`;
	const dl = (
		<button type="button" className="pa-icon-btn shrink-0" onClick={() => void download(path, f.name)} title={`下载 ${f.name}`} aria-label={`下载 ${f.name}`} data-testid="file-download">
			<Download className="pa-ic" />
		</button>
	);
	if (kind === "video") {
		return (
			<div className="w-[min(360px,100%)] max-w-full" data-testid="video-attachment">
				<MediaPlayer kind="video" path={path} name={f.name} className="block max-h-72 w-full rounded-xl border border-line bg-black shadow-sm" />
				<div className="mt-1 flex items-center gap-2">
					<span className="pa-file-txt">
						<b title={f.name}>{f.name}</b>
						<small>{fmtSize(f.size)}</small>
					</span>
					{dl}
				</div>
			</div>
		);
	}
	return (
		<div className="pa-card w-full max-w-[440px] px-3 py-2.5" data-testid="audio-attachment">
			<div className="flex items-center gap-3">
				<span className="pa-file-ic">
					<FileKindIcon name={f.name} className="pa-ic" />
					<em>{(f.name.split(".").pop() ?? "").slice(0, 4).toUpperCase()}</em>
				</span>
				<span className="pa-file-txt">
					<b title={f.name}>{f.name}</b>
					<small>{fmtSize(f.size)}</small>
				</span>
				{dl}
			</div>
			<MediaPlayer kind="audio" path={path} name={f.name} className="mt-2 block h-9 w-full" />
		</div>
	);
}
