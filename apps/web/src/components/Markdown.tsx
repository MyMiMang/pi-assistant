import { ExternalLink, ImageOff, Link2 } from "lucide-react";
import { Children, isValidElement, memo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { openImageViewer } from "./ImageViewer";

/** 单独成段的链接渲染成链接卡片（结果以卡片呈现） */
function LinkCard({ href }: { href: string }) {
	let host = href;
	let path = "";
	try {
		const u = new URL(href);
		host = u.hostname.replace(/^www\./, "");
		path = (u.pathname + u.search).replace(/\/$/, "");
	} catch {
		/* 非法 URL 原样显示 */
	}
	return (
		<a href={href} target="_blank" rel="noreferrer noopener" className="pa-card pa-link-card not-prose my-1.5">
			<span className="pa-file-ic">
				<Link2 className="pa-ic" />
			</span>
			<span className="pa-file-txt">
				<b>{host}</b>
				<small className="truncate">{path || href}</small>
			</span>
			<ExternalLink className="pa-ic text-mut2" />
		</a>
	);
}

/** 只放行 http/https/mailto 和页内锚点；javascript:/data:/file:/相对路径一律不渲染成链接。 */
const safeHref = (href?: string): string | null => {
	if (!href) return null;
	const raw = href.trim();
	if (raw.startsWith("#")) return raw;
	return /^(https?:|mailto:)/i.test(raw) ? raw : null;
};

/**
 * 正文里的图片。
 * - 默认（聊天）：外链图片直接加载，点击全屏查看（保持原行为）。
 * - blockRemoteImages（文件预览等安全场景）：远端图片不自动加载（不把内网/来源信息发出去），
 *   先显示占位，用户点了才加载。
 */
function MdImage({ src, alt, blockRemote, ...p }: { src?: string; alt?: string; blockRemote?: boolean } & React.ImgHTMLAttributes<HTMLImageElement>) {
	const remote = !!src && /^https?:\/\//i.test(src);
	const [allow, setAllow] = useState(false);
	if (remote && blockRemote && !allow) {
		return (
			<button
				type="button"
				className="pa-card not-prose my-1.5 inline-flex items-center gap-2 px-3 py-2 text-xs text-mut"
				onClick={() => setAllow(true)}
				title={src}
				data-testid="md-remote-image-blocked"
			>
				<ImageOff size={14} /> 外链图片未自动加载，点击加载
			</button>
		);
	}
	return <img {...p} src={src} alt={alt ?? ""} draggable={false} className="h-auto max-w-full cursor-zoom-in" onClick={() => src && openImageViewer({ src, alt: alt ?? "", name: alt || undefined })} />;
}

export default memo(function Markdown({ text, blockRemoteImages }: { text: string; blockRemoteImages?: boolean }) {
	return (
		<div className="pa-md prose prose-sm min-w-0 max-w-full break-words [overflow-wrap:anywhere] prose-p:my-1.5 prose-pre:my-2 prose-ul:my-1.5 prose-li:my-0.5 prose-headings:mt-3 prose-headings:mb-1.5">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: true }]]}
				components={{
					a: ({ node: _n, href, children, ...p }) => {
						const h = safeHref(href);
						// 相对文件引用 / javascript: / data: 等不渲染成可点链接，只显示文字（不访问工作区路径）
						if (!h) return <span {...p}>{children}</span>;
						return (
							<a {...p} href={h} target="_blank" rel="noreferrer noopener">
								{children}
							</a>
						);
					},
					// 宽表格 / 代码块自己横向滚动，不把整个聊天撑宽（手机上竖滑时整页左右晃）
					table: ({ node: _n, ...p }) => (
						<div className="pa-scroll-x" data-testid="md-table-wrap">
							<table {...p} />
						</div>
					),
					pre: ({ node: _n, ...p }) => <pre {...p} className={`${p.className ?? ""} pa-pre-x`} />,
					img: ({ node: _n, src, alt, ...p }) => <MdImage {...p} src={src} alt={alt} blockRemote={blockRemoteImages} />,
					p: ({ children, node: _n, ...rest }) => {
						const kids = Children.toArray(children as ReactNode).filter((c) => !(typeof c === "string" && !c.trim()));
						const only = kids.length === 1 && isValidElement(kids[0]) ? (kids[0] as ReactElement<{ href?: string; children?: ReactNode }>) : null;
						const href = only?.props.href;
						if (href && /^https?:\/\//.test(href) && String(Children.toArray(only.props.children).join("")) === href) return <LinkCard href={href} />;
						return <p {...rest}>{children}</p>;
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});
