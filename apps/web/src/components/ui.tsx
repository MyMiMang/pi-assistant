import { X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
	return c.filter(Boolean).join(" ");
}

export function Button({ variant = "default", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" | "outline"; size?: "sm" | "md" | "icon" }) {
	return (
		<button
			{...p}
			className={cx(
				"inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
				size === "sm" && "h-8 px-3 text-sm",
				size === "md" && "h-9 px-4 text-sm",
				size === "icon" && "h-9 w-9",
				variant === "primary" && "bg-accent text-white shadow-sm hover:brightness-110",
				variant === "default" && "bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700",
				variant === "ghost" && "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
				variant === "outline" && "border border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800",
				variant === "danger" && "bg-red-600 text-white hover:bg-red-500",
				className,
			)}
		/>
	);
}

export function Avatar({ text, color, size = 36, running }: { text: string; color: string; size?: number; running?: boolean }) {
	return (
		<div className="relative shrink-0" style={{ width: size, height: size }}>
			<div className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white" style={{ background: color, fontSize: size * 0.42 }}>
				{text}
			</div>
			{running && <span className="absolute -right-0.5 -bottom-0.5 h-3 w-3 animate-pulse rounded-full border-2 border-white bg-emerald-500 dark:border-zinc-900" />}
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
	return (
		<div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
			<div
				className={cx("flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl dark:bg-zinc-900", wide ? "sm:max-w-4xl" : "sm:max-w-md")}
				onClick={(e) => e.stopPropagation()}
			>
				{title !== undefined && (
					<div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
						<div className="font-semibold">{title}</div>
						<Button variant="ghost" size="icon" onClick={onClose} aria-label="关闭">
							<X size={18} />
						</Button>
					</div>
				)}
				<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
			</div>
		</div>
	);
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "green" | "amber" | "red" | "accent" }) {
	return (
		<span
			className={cx(
				"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
				tone === "zinc" && "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
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
	<input {...p} className={cx("h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft dark:border-zinc-700 dark:bg-zinc-900", p.className)} />
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
