import { AlertCircle, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tauriInvoke } from "../externalLinks";
import { safeHttpUrl } from "../office-preview";
import { Notice } from "./FilePreviewViews";

/** Office 类预览的共用小件：异步解析的状态钩子、解析失败提示、Shadow DOM 容器（文档里的链接统一在这里拦截）。设计见 docs/design/office-file-preview.md。 */

export type Parsed<T> = { s: "loading" } | { s: "ok"; v: T } | { s: "fail"; message: string };

/** 跑一次异步解析（库按需 import()）；依赖变了重跑，卸载时放弃结果。失败不抛，进 fail 状态。 */
export function useParsed<T>(run: (signal: AbortSignal) => Promise<T>, deps: unknown[]): Parsed<T> {
	const [st, setSt] = useState<Parsed<T>>({ s: "loading" });
	useEffect(() => {
		const ac = new AbortController();
		setSt({ s: "loading" });
		run(ac.signal).then(
			(v) => !ac.signal.aborted && setSt({ s: "ok", v }),
			(e) => !ac.signal.aborted && setSt({ s: "fail", message: (e as Error)?.message ?? "" }),
		);
		return () => ac.abort();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);
	return st;
}

export function ParseFail({ message }: { message?: string }) {
	return (
		<Notice icon={<AlertCircle size={22} />} title="这个文件解析不了" body={`文件可能已损坏，或格式不被识别。用右上角「下载」用本机软件打开。${message ? `（${message.slice(0, 120)}）` : ""}`} testId="office-parse-error" />
	);
}

export function ParseLoading() {
	return (
		<div className="flex h-full items-center justify-center text-mut" data-testid="office-loading">
			<Loader2 className="animate-spin" size={22} />
		</div>
	);
}

/** 打开文档里的外链：桌面程序交给系统浏览器，其余新窗口（noopener）。绝不在 App 窗口里跳转。 */
function openExternal(url: string) {
	const invoke = tauriInvoke();
	const fallback = () => window.open(url, "_blank", "noopener,noreferrer");
	if (invoke) invoke("plugin:opener|open_url", { url }).catch(fallback);
	else fallback();
}

/**
 * Shadow DOM 容器：文档的样式不串到 App 里。
 * - onRoot：拿到 ShadowRoot 后调用一次（docx-preview 这类库往里命令式渲染）；
 * - children：用 React portal 渲染进 ShadowRoot（PPT 幻灯片）。
 * 容器上拦截所有点击里的 <a>：一律不让浏览器默认跳转；只有 http/https 才用新窗口打开，其他协议（javascript: 等）忽略。
 */
export function ShadowHost({ onRoot, children, className, testId }: { onRoot?: (root: ShadowRoot) => void; children?: React.ReactNode; className?: string; testId?: string }) {
	const [root, setRoot] = useState<ShadowRoot | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = hostRef.current;
		if (!el) return;
		const sr = el.shadowRoot ?? el.attachShadow({ mode: "open" });
		setRoot(sr);
		onRoot?.(sr);
		const onClick = (e: MouseEvent) => {
			const a = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
			if (!a) return;
			e.preventDefault();
			e.stopPropagation();
			const url = safeHttpUrl(a.getAttribute("href"));
			if (url && (e.type === "click" || e.type === "auxclick")) openExternal(url);
		};
		el.addEventListener("click", onClick, true);
		el.addEventListener("auxclick", onClick, true);
		return () => {
			el.removeEventListener("click", onClick, true);
			el.removeEventListener("auxclick", onClick, true);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return (
		<div ref={hostRef} className={className} data-testid={testId}>
			{root && children ? createPortal(children, root as unknown as Element) : null}
		</div>
	);
}
