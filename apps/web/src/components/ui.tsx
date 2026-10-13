import { CircleHelp, X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchBlob } from "../api";

export function cx(...c: (string | false | null | undefined)[]) {
	return c.filter(Boolean).join(" ");
}

export function Button({ variant = "default", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" | "outline"; size?: "sm" | "md" | "icon" }) {
	return (
		<button
			{...p}
			className={cx(
				"pa-ui-btn inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap transition active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50",
				size === "sm" && "h-8 px-3 text-[13px]",
				size === "md" && "h-9 px-4 text-[13.5px]",
				size === "icon" && "h-9 w-9",
				variant === "primary" && "pa-ui-primary",
				variant === "default" && "bg-hover text-fg hover:brightness-95",
				variant === "ghost" && "text-mut hover:bg-hover hover:text-fg",
				variant === "outline" && "border border-line bg-card hover:bg-hover",
				variant === "danger" && "bg-red-600 text-white hover:bg-red-500",
				className,
			)}
		/>
	);
}

const avatarCache = new Map<string, Promise<string>>();
/** 头像：emoji / 文字（彩色圆底）或上传的图片（avatar = "img:<版本>"，需带 agentId）。 */
export function Avatar({ text, color, size = 36, running, agentId, src }: { text: string; color: string; size?: number; running?: boolean; agentId?: string; src?: string }) {
	const isImg = text.startsWith("img:") && !!agentId;
	const [url, setUrl] = useState<string | null>(src ?? null);
	useEffect(() => {
		if (src) return setUrl(src);
		if (!isImg) return setUrl(null);
		const key = `${agentId}:${text}`;
		let p = avatarCache.get(key);
		if (!p) avatarCache.set(key, (p = fetchBlob(`/api/agents/${agentId}/avatar?v=${text.slice(4)}`).then((b) => URL.createObjectURL(b))));
		let live = true;
		p.then((u) => live && setUrl(u)).catch(() => {});
		return () => void (live = false);
	}, [isImg, agentId, text, src]);
	const emojiOnly = /\p{Extended_Pictographic}/u.test(text);
	return (
		<div className="relative shrink-0" style={{ width: size, height: size }}>
			{url ? (
				<img src={url} alt="" className="pa-avatar h-full w-full object-cover" />
			) : (
				<div className="pa-avatar flex h-full w-full items-center justify-center font-semibold text-white select-none" style={{ background: emojiOnly ? `color-mix(in srgb, ${color} 18%, var(--card))` : color, fontSize: size * (emojiOnly ? 0.52 : 0.42) }}>
					{isImg ? "" : text}
				</div>
			)}
			{running && <span className="pa-av-dot" />}
		</div>
	);
}

/** fixed：固定尺寸（不随内容变高/变宽、位置不跳），内部自己负责滚动——设置窗口用，切换标签时左侧/顶部标签栏不动。 */
export function Modal({ open, onClose, title, children, wide, fixed, testId }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; wide?: boolean; fixed?: boolean; testId?: string }) {
	useEffect(() => {
		if (!open) return;
		const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, [open, onClose]);
	if (!open) return null;
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
			<div
				className={cx(
					"pa-modal flex w-full flex-col overflow-hidden max-sm:rounded-b-none",
					fixed ? "h-[92dvh] shrink-0 sm:h-[min(720px,90dvh)]" : "max-h-[92dvh]",
					wide ? (fixed ? "sm:w-[min(56rem,100%)]" : "sm:max-w-4xl") : "sm:max-w-md",
				)}
				data-testid={testId}
				onClick={(e) => e.stopPropagation()}
			>
				{title !== undefined && (
					<div className="flex items-center justify-between border-b border-line px-5 py-3">
						<div className="font-semibold">{title}</div>
						<Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
							<X size={18} />
						</Button>
					</div>
				)}
				<div className={cx("min-h-0 flex-1", fixed ? "overflow-hidden" : "overflow-y-auto")}>{children}</div>
			</div>
		</div>,
		document.body,
	);
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "green" | "amber" | "red" | "accent" }) {
	return (
		<span
			className={cx(
				"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
				tone === "zinc" && "bg-hover text-mut",
				tone === "green" && "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
				tone === "amber" && "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
				tone === "red" && "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
				tone === "accent" && "bg-accent-soft text-accent",
			)}
		>
			{children}
		</span>
	);
}

export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
	<input {...p} className={cx("pa-input", p.className)} />
);

export function fmtSize(n: number) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
export function fmtTime(t: number) {
	const d = new Date(t);
	const today = new Date();
	return d.toDateString() === today.toDateString()
		? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

/** 纯文本场景（下拉选项、标签）里的头像：图片头像不显示，只留 emoji/字母 */
export const avatarText = (avatar: string) => (avatar.startsWith("img:") ? "" : avatar);

/** 「?」帮助图标：电脑上鼠标悬停显示，手机上点一下显示（再点或点别处收起）。详细说明放这里，正文只留简短标签 */
export function Help({ children, className }: { children: ReactNode; className?: string }) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ x: number; y: number; up: boolean }>({ x: 0, y: 0, up: false });
	const ref = useRef<HTMLButtonElement>(null);
	const show = () => {
		const r = ref.current?.getBoundingClientRect();
		if (r) setPos({ x: Math.max(12, Math.min(r.left - 8, innerWidth - 312)), y: r.bottom + 6 > innerHeight - 160 ? r.top - 6 : r.bottom + 6, up: r.bottom + 6 > innerHeight - 160 });
		setOpen(true);
	};
	useEffect(() => {
		if (!open) return;
		const h = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
		document.addEventListener("pointerdown", h);
		addEventListener("scroll", h, true);
		return () => (document.removeEventListener("pointerdown", h), removeEventListener("scroll", h, true));
	}, [open]);
	return (
		<span className={cx("pa-help", className)}>
			<button type="button" ref={ref} aria-label="说明" aria-expanded={open} data-testid="help" onMouseEnter={show} onMouseLeave={() => setOpen(false)} onClick={(e) => (e.preventDefault(), e.stopPropagation(), open ? setOpen(false) : show())}>
				<CircleHelp size={14} />
			</button>
			{open &&
				createPortal(
					<div className="pa-help-pop" role="tooltip" data-testid="help-pop" style={{ left: pos.x, ...(pos.up ? { bottom: innerHeight - pos.y } : { top: pos.y }) }}>
						{children}
					</div>,
					document.body,
				)}
		</span>
	);
}

/** 确认框：const [dlg, ask] = useConfirm(); if (await ask({ title, body })) … ；渲染 {dlg} */
export function useConfirm(): [ReactNode, (o: { title: string; body?: ReactNode; ok?: string; danger?: boolean }) => Promise<boolean>] {
	const [st, setSt] = useState<{ title: string; body?: ReactNode; ok?: string; danger?: boolean; done: (v: boolean) => void } | null>(null);
	const ask = (o: { title: string; body?: ReactNode; ok?: string; danger?: boolean }) => new Promise<boolean>((done) => setSt({ ...o, done }));
	const close = (v: boolean) => (st?.done(v), setSt(null));
	const el = (
		<Modal open={!!st} onClose={() => close(false)} testId="confirm-dialog">
			<div className="space-y-3 p-5">
				<div className="text-base font-semibold">{st?.title}</div>
				{st?.body && <div className="text-sm text-mut">{st.body}</div>}
				<div className="flex justify-end gap-2 pt-1">
					<Button variant="ghost" onClick={() => close(false)} data-testid="confirm-cancel">
						取消
					</Button>
					<Button variant={st?.danger ? "danger" : "primary"} onClick={() => close(true)} data-testid="confirm-ok">
						{st?.ok ?? "确定"}
					</Button>
				</div>
			</div>
		</Modal>
	);
	return [el, ask];
}

/** 长错误（含日志、ASCII 框线）：一句中文摘要 + 可展开、可复制的详情，始终在容器宽度内 */
const BOX_CHARS = /[│┃─━╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝⏳✗✓×]+/g;
export function cleanLog(t: string) {
	return t
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(BOX_CHARS, " ")
		.split("\n")
		.map((l) => l.replace(/[ \t]{2,}/g, " ").trim())
		.filter(Boolean)
		.join("\n");
}
export function errorSummary(t: string) {
	if (/External data path|ONNXRuntimeError|onnxruntime/i.test(t)) return "向量模型加载失败";
	if (/ENOSPC|No space left/i.test(t)) return "磁盘空间不足";
	if (/daemon\.start failed|Failed to start daemon|startup failed/i.test(t)) return "Hindsight 启动失败";
	if (/ETIMEDOUT|timed out|timeout/i.test(t)) return "连接超时";
	if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(t)) return "网络连接失败";
	const first = cleanLog(t).split("\n")[0] ?? "";
	return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}
export function ErrorBox({ text, className }: { text: string; className?: string }) {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState(false);
	const full = cleanLog(text);
	const sum = errorSummary(text);
	return (
		<div className={cx("min-w-0 max-w-full space-y-1 text-xs", className)} data-testid="error-box">
			<div className="flex min-w-0 items-center gap-2 text-red-500">
				<span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{sum}</span>
				{full !== sum && (
					<button type="button" className="shrink-0 text-mut underline-offset-2 hover:underline" onClick={() => setOpen(!open)} data-testid="error-details-toggle">
						{open ? "收起" : "详情"}
					</button>
				)}
				<button
					type="button"
					className="shrink-0 text-mut underline-offset-2 hover:underline"
					onClick={() => void navigator.clipboard?.writeText(full).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
				>
					{copied ? "已复制" : "复制"}
				</button>
			</div>
			{open && <pre className="max-h-60 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-hover p-2 font-mono text-[11px] leading-relaxed text-mut [overflow-wrap:anywhere]" data-testid="error-details">{full}</pre>}
		</div>
	);
}
