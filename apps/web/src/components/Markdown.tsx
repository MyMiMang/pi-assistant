import { ExternalLink, Link2 } from "lucide-react";
import { Children, isValidElement, memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

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

export default memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="prose prose-sm max-w-none break-words prose-p:my-1.5 prose-pre:my-2 prose-ul:my-1.5 prose-li:my-0.5 prose-headings:mt-3 prose-headings:mb-1.5">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: true }]]}
				components={{
					a: (p) => <a {...p} target="_blank" rel="noreferrer noopener" />,
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
