import { X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useState } from "react";
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

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; wide?: boolean }) {
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
				className={cx("pa-modal flex max-h-[92dvh] w-full flex-col overflow-hidden max-sm:rounded-b-none", wide ? "sm:max-w-4xl" : "sm:max-w-md")}
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
				<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
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
