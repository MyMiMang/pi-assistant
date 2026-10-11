import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

export default memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="prose prose-sm prose-zinc max-w-none break-words dark:prose-invert prose-p:my-1.5 prose-pre:my-2 prose-ul:my-1.5 prose-li:my-0.5 prose-headings:mt-3 prose-headings:mb-1.5">
			<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: true }]]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer noopener" /> }}>
				{text}
			</ReactMarkdown>
		</div>
	);
});
