import { AlertCircle, Download, FileQuestion, Loader2, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { ApiError, download as downloadFile, fetchBlob } from "../api";
import { isTextKind, previewKind, type PreviewKind } from "../preview";
import { FileKindIcon } from "./Attachments";
import { MediaPlayer } from "./MediaPlayer";
import { CodeView, CsvView, HtmlView, MarkdownScroll, Notice, OVERSIZE_NOTICE, SvgView, loadText } from "./FilePreviewViews";
import { Modal, fmtSize } from "./ui";

/**
 * 聊天 / 交付 / 信息面板 / 子代理附件共用的应用内文件预览。
 *
 * 只读、安全：
 * - 只通过授权资源地址（/api/files/:id）带登录凭证拉取，不读本机任意路径 / URL，不绕权限（视频 / 音频改用该文件的短时签名链接流式播放）；
 * - HTML 只在无 allow-same-origin 的 sandbox iframe 里显示（短时签名链接，见 docs/design/html-file-preview.md），SVG 只当 <img> 显示；
 *   Office / 压缩包等不 inline、不执行，只给下载；
 * - 文本先做二进制嗅探，乱码不硬解；超过上限只提示 + 下载；
 * - Markdown 复用现有 react-markdown，但外链图片默认不自动加载，链接只放行 http/https/mailto。
 *
 * 图片附件仍走 ImageViewer（本组件只在 kind=image 时兜底显示，不替换原查看器）。
 */
export type FilePreviewItem = {
	name: string;
	mime?: string;
	size?: number;
	/** 授权资源地址（带登录凭证拉取），例如 /api/files/:id */
	url: string;
	/** 下载地址；默认与 url 相同 */
	downloadPath?: string;
};

type State = { item: FilePreviewItem | null; open: (i: FilePreviewItem) => void; close: () => void };
const usePreview = create<State>((set) => ({ item: null, open: (item) => set({ item }), close: () => set({ item: null }) }));

/** 从任意位置打开应用内文件预览（Portal 到 body，复用共享 Modal 栈）。 */
export function openFilePreview(item: FilePreviewItem) {
	usePreview.getState().open(item);
}

const KIND_LABEL: Record<PreviewKind, string> = {
	image: "图片",
	video: "视频",
	audio: "音频",
	pdf: "PDF",
	markdown: "Markdown",
	csv: "表格",
	code: "代码",
	text: "文本",
	html: "网页",
	svg: "SVG",
	unsupported: "文件",
};

/** 全局挂载一次（App.tsx）。关闭后把焦点还给触发它的卡片（键盘用户）。 */
export function FilePreviewHost() {
	const item = usePreview((s) => s.item);
	const close = usePreview((s) => s.close);
	const [nonce, setNonce] = useState(0);
	const returnFocus = useRef<HTMLElement | null>(null);
	const wasOpen = useRef(false);

	useEffect(() => {
		if (item && !wasOpen.current) {
			wasOpen.current = true;
			returnFocus.current = (document.activeElement as HTMLElement) ?? null;
			setNonce(0);
		} else if (!item && wasOpen.current) {
			wasOpen.current = false;
			returnFocus.current?.focus?.();
			returnFocus.current = null;
		}
	}, [item]);

	if (!item) return null;
	const kind = previewKind(item.name, item.mime);
	const dl = item.downloadPath ?? item.url;
	return (
		<Modal open onClose={close} wide fixed testId="file-preview">
			<div className="flex h-full min-h-0 flex-col pb-[env(safe-area-inset-bottom)]" data-kind={kind}>
				<header className="flex items-center gap-2 border-b border-line px-3 py-2" data-testid="file-preview-toolbar">
					<FileKindIcon name={item.name} size={18} className="shrink-0 text-mut" />
					<div className="min-w-0 flex-1">
						<div className="min-w-0 break-words text-[13.5px] font-medium leading-tight" title={item.name} data-testid="file-preview-name">
							{item.name}
						</div>
						<div className="mt-0.5 text-xs text-mut2">
							{KIND_LABEL[kind]}
							{item.size != null ? ` · ${fmtSize(item.size)}` : ""}
						</div>
					</div>
					<button
						type="button"
						className="pa-icon-btn ghost"
						title={`下载 ${item.name}`}
						aria-label={`下载 ${item.name}`}
						onClick={() => void downloadFile(dl, item.name)}
						data-testid="file-preview-download"
					>
						<Download size={17} />
					</button>
					<button type="button" className="pa-icon-btn ghost" title="关闭（Esc）" aria-label="关闭" onClick={close} data-testid="file-preview-close">
						<X size={18} />
					</button>
				</header>
				<div className="min-h-0 flex-1 overflow-hidden">
					<Body key={`${item.url}:${nonce}`} item={item} kind={kind} onRetry={() => setNonce((n) => n + 1)} onClose={close} />
				</div>
			</div>
		</Modal>
	);
}

type BodyState =
	| { s: "loading" }
	| { s: "error"; code: "notfound" | "permission" | "error"; message: string }
	| { s: "ready" }
	| { s: "oversize" }
	| { s: "binary" };

function Body({ item, kind, onRetry, onClose }: { item: FilePreviewItem; kind: PreviewKind; onRetry: () => void; onClose: () => void }) {
	const [state, setState] = useState<BodyState>({ s: "loading" });
	const [text, setText] = useState("");
	const [url, setUrl] = useState<string>();

	useEffect(() => {
		const ac = new AbortController();
		let objUrl: string | undefined;
		const run = async () => {
			try {
				if (isTextKind(kind) || kind === "svg") {
					const r = await loadText(item.url, item.size, ac.signal);
					if (ac.signal.aborted) return;
					if (r.s !== "ok") {
						setState({ s: r.s });
						return;
					}
					setText(r.text);
					// SVG 图片档：blob 类型强制成 image/svg+xml，只当 <img> 显示
					if (kind === "svg") {
						objUrl = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: "image/svg+xml" }));
						setUrl(objUrl);
					}
					setState({ s: "ready" });
				} else if (kind === "image" || kind === "pdf") {
					const blob = await fetchBlob(item.url, ac.signal);
					if (ac.signal.aborted) return;
					objUrl = URL.createObjectURL(blob);
					setUrl(objUrl);
					setState({ s: "ready" });
				} else {
					setState({ s: "ready" });
				}
			} catch (e) {
				if (ac.signal.aborted) return;
				const status = e instanceof ApiError ? e.status : 0;
				setState({
					s: "error",
					code: status === 404 ? "notfound" : status === 403 || status === 401 ? "permission" : "error",
					message: (e as Error).message,
				});
			}
		};
		void run();
		return () => {
			ac.abort();
			if (objUrl) URL.revokeObjectURL(objUrl);
		};
	}, [item.url, item.size, kind]);

	if (state.s === "loading") {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-mut" data-testid="file-preview-loading">
				<Loader2 className="animate-spin" size={22} />
				<div>加载中…</div>
				<button type="button" className="pa-chip sm" onClick={onClose} data-testid="file-preview-cancel">
					取消
				</button>
			</div>
		);
	}
	if (state.s === "error") {
		const msg =
			state.code === "notfound"
				? "文件不存在或已被删除。"
				: state.code === "permission"
					? "没有权限读取这个文件。"
					: `加载失败：${state.message || "未知错误"}`;
		return (
			<Notice icon={<AlertCircle size={22} />} title="打不开预览" body={msg} testId="file-preview-error">
				<button type="button" className="pa-chip sm" onClick={onRetry} data-testid="file-preview-retry">
					<RotateCcw size={13} /> 重试
				</button>
			</Notice>
		);
	}
	if (state.s === "oversize") {
		return <Notice icon={<FileQuestion size={22} />} title={OVERSIZE_NOTICE.title} body={OVERSIZE_NOTICE.body} testId="file-preview-oversize" />;
	}
	if (state.s === "binary") {
		return <Notice icon={<FileQuestion size={22} />} title="这是二进制文件" body="不能按文本预览（避免显示乱码）。用右上角「下载」打开。" testId="file-preview-binary" />;
	}
	if (kind === "unsupported") {
		return <Notice icon={<FileQuestion size={22} />} title="暂不支持这种文件预览" body="为保证安全（不执行 Office 宏等），这类文件只在应用外打开。用右上角「下载」保存后查看。" testId="file-preview-unsupported" />;
	}
	if (kind === "video" || kind === "audio") {
		// 不拉成 blob：播放器自己用短时签名链接流式加载（能拖进度条）
		return (
			<div className="flex h-full items-center justify-center overflow-hidden p-3" data-testid={`file-preview-${kind}`}>
				<MediaPlayer kind={kind} path={item.url} name={item.name} className={kind === "video" ? "max-h-full max-w-full rounded-lg bg-black shadow" : "w-full max-w-md"} />
			</div>
		);
	}
	if (kind === "html") return <HtmlView path={item.url} size={item.size} />;
	if (kind === "svg") return <SvgView text={text} url={url} name={item.name} />;
	if (kind === "markdown") return <MarkdownScroll text={text} />;
	if (kind === "csv") return <CsvView text={text} tsv={item.mime === "text/tab-separated-values" || /\.tsv$/i.test(item.name)} />;
	if (kind === "code" || kind === "text") return <CodeView text={text} />;
	if (kind === "image") {
		return (
			<div className="flex h-full items-center justify-center overflow-hidden p-2" data-testid="file-preview-image">
				{url ? <img src={url} alt={item.name} className="max-h-full max-w-full rounded-lg object-contain shadow" /> : null}
			</div>
		);
	}
	// pdf：浏览器内置查看器；不支持时 <object> 会显示 fallback（提示 + 下载）
	return (
		<div className="h-full" data-testid="file-preview-pdf">
			{url ? (
				<object data={url} type="application/pdf" className="h-full w-full">
					<Notice icon={<FileQuestion size={22} />} title="这个环境不能内嵌显示 PDF" body="用右上角「下载」保存后用系统阅读器打开。" testId="file-preview-pdf-fallback" />
				</object>
			) : null}
		</div>
	);
}
