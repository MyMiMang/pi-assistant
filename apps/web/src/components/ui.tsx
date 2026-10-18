import { Check, ChevronDown, CircleHelp, type LucideIcon, X } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchBlob } from "../api";
import { escLayers } from "../esc-layer";

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
export function Avatar({ text, color, size = 36, running, agentId, src, testId }: { text: string; color: string; size?: number; running?: boolean; agentId?: string; src?: string; testId?: string }) {
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
		<div className="relative shrink-0" style={{ width: size, height: size }} data-testid={testId}>
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

/** 已打开的弹窗栈（后打开的在上）：只让最上层响应 Esc，避免嵌套弹窗（如设置弹窗里的确认框）被一并关掉。 */
const modalStack: symbol[] = [];

/** fixed：固定尺寸（不随内容变高/变宽、位置不跳），内部自己负责滚动——设置窗口用，切换标签时左侧/顶部标签栏不动。 */
export function Modal({ open, onClose, title, children, wide, fixed, testId }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; wide?: boolean; fixed?: boolean; testId?: string }) {
	const idRef = useRef<symbol | undefined>(undefined);
	if (!idRef.current) idRef.current = Symbol();
	useEffect(() => {
		if (!open) return;
		const id = idRef.current!;
		modalStack.push(id);
		const k = (e: KeyboardEvent) => e.key === "Escape" && modalStack[modalStack.length - 1] === id && onClose();
		addEventListener("keydown", k);
		return () => {
			removeEventListener("keydown", k);
			const i = modalStack.lastIndexOf(id);
			if (i >= 0) modalStack.splice(i, 1);
		};
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
				"inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
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

/** 气泡锚点：优先在触发器下方，靠近视口底部时翻到上方；左右夹在视口内（与旧 Help 完全同一套数值）。 */
type BubblePos = { x: number; y: number; up: boolean };
function bubblePos(anchor: HTMLElement | null): BubblePos {
	const r = anchor?.getBoundingClientRect();
	if (!r) return { x: 0, y: 0, up: false };
	return { x: Math.max(12, Math.min(r.left - 8, innerWidth - 312)), y: r.bottom + 6 > innerHeight - 160 ? r.top - 6 : r.bottom + 6, up: r.bottom + 6 > innerHeight - 160 };
}
/** 气泡本体（portal 到 body，避免被弹层裁切）。Help 与 HoverTip 共用，testid 保持旧契约。passive＝只是悬停打开的，不接收点击、不挡住下面的按钮。 */
function Bubble({ id, pos, testid, passive, children }: { id: string; pos: BubblePos; testid: string; passive?: boolean; children: ReactNode }) {
	return createPortal(
		<div id={id} className={cx("pa-help-pop", passive && "passive")} role="tooltip" data-testid={testid} style={{ left: pos.x, ...(pos.up ? { bottom: innerHeight - pos.y } : { top: pos.y }) }}>
			{children}
		</div>,
		document.body,
	);
}
/** 打开期间：点外部 / 滚动 / Escape 关闭。Escape 在捕获阶段只关这一层（不误关底层菜单 / 设置弹窗）。 */
/**
 * 叠加层的 Esc 归属：后打开的那一层（例如菜单里悬停出的 Fast 说明气泡）先处理这一下 Esc，
 * 它关掉后这一下不再往下传 —— 所以「关说明」不会顺手把菜单一起关掉。见 `../esc-layer.ts`。
 */
export function useEscLayer(open: boolean, act: () => void) {
	const fn = useRef(act);
	fn.current = act;
	useEffect(() => {
		if (!open) return;
		const layer = { consume: () => fn.current() };
		const remove = escLayers.push(layer);
		const esc = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// 不是最上层（更晚打开的气泡 / 子弹层）就交回去，不抢先把下面这层关掉
			if (!escLayers.isTop(layer)) return;
			e.preventDefault();
			e.stopPropagation();
			fn.current();
		};
		document.addEventListener("keydown", esc, true);
		return () => (document.removeEventListener("keydown", esc, true), remove());
	}, [open]);
}

function useDismissBubble(open: boolean, anchor: RefObject<HTMLElement | null>, popId: string, close: () => void, onEscape?: () => void) {
	useEffect(() => {
		if (!open) return;
		const outside = (e: Event) => {
			const t = e.target as Node;
			if (anchor.current?.contains(t)) return;
			if (document.getElementById(popId)?.contains(t)) return;
			close();
		};
		document.addEventListener("pointerdown", outside);
		addEventListener("scroll", outside, true);
		return () => (document.removeEventListener("pointerdown", outside), removeEventListener("scroll", outside, true));
	}, [open, anchor, popId, close]);
	// Esc 只关这一层气泡（最上层优先），不把底下的菜单 / 设置弹窗一起关掉
	useEscLayer(open, () => {
		onEscape?.();
		close();
	});
}

/**
 * 延迟悬停提示：给「本身就是一个按钮」的控件用（不再套一个 ? 图标，避免按钮套按钮）。
 * 鼠标悬停 delayMs 后才显示；focus 立即显示（键盘 / 触摸都能看到说明）；移出 / 失焦关闭。
 * 与 Help 共用同一套气泡定位、样式和 Escape / 外部点击规则。
 */
export function useHoverTip(delayMs = 450) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<BubblePos>({ x: 0, y: 0, up: false });
	const ref = useRef<HTMLButtonElement>(null);
	const popId = useId();
	const timer = useRef<number | null>(null);
	const clear = useCallback(() => {
		if (timer.current) {
			window.clearTimeout(timer.current);
			timer.current = null;
		}
	}, []);
	const hide = useCallback(() => {
		clear();
		setOpen(false);
	}, [clear]);
	const show = useCallback(() => {
		clear();
		setPos(bubblePos(ref.current));
		setOpen(true);
	}, [clear]);
	const schedule = useCallback(() => {
		clear();
		timer.current = window.setTimeout(() => {
			timer.current = null;
			setPos(bubblePos(ref.current));
			setOpen(true);
		}, delayMs);
	}, [clear, delayMs]);
	useEffect(() => clear, [clear]);
	useDismissBubble(open, ref, popId, hide);
	return {
		ref,
		open,
		popId,
		show,
		hide,
		schedule,
		/** 挂到触发按钮上：悬停延迟、focus 立即、移出 / 失焦关闭 */
		triggerProps: {
			onMouseEnter: schedule,
			onMouseLeave: hide,
			onFocus: show,
			onBlur: hide,
			"aria-describedby": open ? popId : undefined,
		},
		/** 渲染气泡内容（只在打开时挂载）；内容由调用方给，样式 / 定位 / 关闭规则共用 */
		renderTip: (children: ReactNode) => (open ? <Bubble id={popId} pos={pos} testid="hover-tip">{children}</Bubble> : null),
	};
}

/** 「?」帮助图标：电脑上鼠标悬停显示，手机上点一下显示（再点或点别处收起）。详细说明放这里，正文只留简短标签。
 *  可访问性：Tab 聚焦即打开、Escape 关闭、点外部关闭；Escape 只关这一层（不会连底层设置弹窗一起关），
 *  关掉后焦点仍留在按钮上但不立刻重开（等下一次真正的聚焦 / 点击）。 */
export function Help({ children, className }: { children: ReactNode; className?: string }) {
	// "hover"：鼠标悬停打开（含布局变动把「?」挪到静止的鼠标下）→ 气泡只看不挡点击；点开 / 聚焦打开为 true，可点里面的链接
	const [open, setOpen] = useState<false | "hover" | true>(false);
	const [pos, setPos] = useState<BubblePos>({ x: 0, y: 0, up: false });
	const ref = useRef<HTMLButtonElement>(null);
	const popId = useId();
	// Escape 关闭后抑制「focus 立即重开」：保持焦点在按钮上但不弹，直到用户真的移开再回来（onBlur 复位）。
	const suppressFocus = useRef(false);
	const show = (how: "hover" | true = true) => (setPos(bubblePos(ref.current)), setOpen(how));
	const close = () => setOpen(false);
	// 捕获阶段拦下 Escape：只关气泡，不把底层设置弹窗一起关掉；关掉后焦点留在按钮上但不立刻重开。
	useDismissBubble(!!open, ref, popId, close, () => {
		suppressFocus.current = true;
	});
	return (
		<span className={cx("pa-help", className)}>
			<button
				type="button"
				ref={ref}
				aria-label="说明"
				aria-expanded={!!open}
				aria-describedby={open ? popId : undefined}
				data-testid="help"
				onMouseEnter={() => show("hover")}
				onMouseLeave={() => {
					if (document.activeElement !== ref.current) close();
				}}
				onFocus={() => {
					if (!suppressFocus.current) show();
				}}
				onBlur={() => {
					suppressFocus.current = false;
				}}
				onClick={(e) => (e.preventDefault(), e.stopPropagation(), open ? close() : show())}
			>
				<CircleHelp size={14} />
			</button>
			{open && <Bubble id={popId} pos={pos} testid="help-pop" passive={open === "hover"}>{children}</Bubble>}
		</span>
	);
}

/** 大分类折叠：图标 + 标题 + 数量 + 展开箭头；收起时里面的内容完全不渲染（可以一键全部关上）。
 *  说明用 desc（渲染成独立的「?」按钮，不嵌在折叠按钮里，避免按钮套按钮）。 */
export function Fold({ icon: Icon, title, count, hint, desc, open, onToggle, testId, children }: { icon?: LucideIcon; title: ReactNode; count?: number; hint?: ReactNode; desc?: ReactNode; open: boolean; onToggle: () => void; testId?: string; children: ReactNode }) {
	return (
		<section data-testid={testId}>
			<div className="flex min-w-0 items-center gap-1.5">
				<button type="button" className="flex min-w-0 items-center gap-2 text-left" aria-expanded={open} onClick={onToggle} data-testid={testId ? `${testId}-toggle` : undefined}>
					<ChevronDown size={14} className={cx("shrink-0 text-mut transition-transform", !open && "-rotate-90")} />
					{Icon && <Icon size={16} className="shrink-0 text-mut" />}
					<span className="min-w-0 truncate font-semibold">{title}</span>
					{count !== undefined && <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-normal text-mut dark:bg-zinc-800">{count}</span>}
					{hint && <span className="min-w-0 truncate text-xs font-normal text-mut">{hint}</span>}
				</button>
				{desc && <Help>{desc}</Help>}
			</div>
			{open && <div className="pa-fold-in mt-3">{children}</div>}
		</section>
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
	// 服务端已经给了中文摘要（第一行），后面是详情
	if (/^[\u4e00-\u9fa5]/.test(t) && t.includes("\n")) return t.split("\n")[0]!;
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

/**
 * 应用内下拉选择（不用原生 select）：按钮 + 弹出列表，键盘支持（Esc 关、上下键选），窄屏也不溢出。
 * 选项少时直接用；value 用字符串比较。
 */
export interface SelectOption {
	value: string | number;
	label: string;
	/** 选项右侧的小字（单位等） */
	hint?: string;
}
export function Select({
	value,
	options,
	onChange,
	ariaLabel,
	testId,
	className,
	disabled,
	placeholder,
	menuMinWidth,
}: {
	value: string | number;
	options: SelectOption[];
	onChange: (value: string) => void;
	ariaLabel?: string;
	testId?: string;
	className?: string;
	disabled?: boolean;
	placeholder?: string;
	/** 弹出列表的最小宽度（默认 168）：长选项文案可适度调宽，仍会被视口 clamp */
	menuMinWidth?: number;
}) {
	const [open, setOpen] = useState(false);
	// 键盘高亮项：方向键只移动高亮，回车/空格才提交（避免每按一次方向键就触发一次保存）
	const [active, setActive] = useState(0);
	const [rect, setRect] = useState<{ left: number; top: number; width: number; up: boolean; maxH: number } | null>(null);
	const btn = useRef<HTMLButtonElement>(null);
	const pop = useRef<HTMLDivElement>(null);
	const uid = useId();
	const optId = (i: number) => `${uid}-opt-${i}`;
	const listId = `${uid}-list`;
	const cur = options.find((o) => String(o.value) === String(value));
	const curIndex = Math.max(0, options.findIndex((o) => String(o.value) === String(value)));
	const place = () => {
		const r = btn.current?.getBoundingClientRect();
		if (!r) return;
		const GAP = 6;
		const want = Math.min(280, options.length * 34 + 12);
		// 上下各留 8px 边距，按真正可用的空间限高（向上翻转时不能顶出屏幕）
		const below = window.innerHeight - r.bottom - GAP - 8;
		const above = r.top - GAP - 8;
		const up = below < want && above > below;
		const maxH = Math.max(96, Math.min(want, up ? above : below));
		const width = Math.min(Math.max(r.width, menuMinWidth ?? 168), Math.max(120, window.innerWidth - 16));
		const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
		setRect({ left, top: up ? r.top - GAP : r.bottom + GAP, width, up, maxH });
	};
	const openMenu = () => {
		if (disabled) return;
		place();
		setActive(curIndex);
		setOpen(true);
	};
	useEffect(() => {
		if (!open) return;
		const onDoc = (e: MouseEvent) => {
			if (!pop.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
		};
		// 捕获阶段吃掉：菜单开着时 Esc 只关菜单，不把底下的设置弹窗一起关掉
		const commit = (i: number) => {
			const o = options[i];
			if (o) onChange(String(o.value));
			setOpen(false);
			btn.current?.focus();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
				btn.current?.focus();
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				if (options.length) setActive((i) => (i + 1) % options.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				if (options.length) setActive((i) => (i - 1 + options.length) % options.length);
			} else if (e.key === "Home") {
				e.preventDefault();
				setActive(0);
			} else if (e.key === "End") {
				e.preventDefault();
				setActive(options.length - 1);
			} else if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				commit(active);
			} else if (e.key === "Tab") {
				setOpen(false);
			}
		};
		const close = () => setOpen(false);
		// capture 阶段会先收到菜单内部的 scroll；菜单自己滚不该把它关掉。
		// 祖先滚动（含设置弹窗内容区）不直接关菜单，而是让它跟着触发器重新定位；
		// 只有触发器真的滚出视口才关。否则点击 / 聚焦时浏览器先「把触发器滚进视口」的那个
		// scroll 会在菜单刚打开后到达，把它立刻关掉（菜单开着却查不到选项）。
		const onScroll = (e: Event) => {
			if (pop.current?.contains(e.target as Node)) return;
			const r = btn.current?.getBoundingClientRect();
			if (!r || r.bottom < 0 || r.top > window.innerHeight) return setOpen(false);
			place();
		};
		document.addEventListener("mousedown", onDoc);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", close);
		};
	}, [open, options, value, onChange, disabled, active]);
	// 键盘移动高亮时，把当前项滚进可视区（只动菜单自身滚动，不滚祖先/页面），并把焦点交给 listbox 以播报高亮项
	useEffect(() => {
		if (!open) return;
		pop.current?.focus({ preventScroll: true });
		const box = pop.current;
		const el = box?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
		if (!box || !el) return;
		if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
		else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
	}, [open, active]);
	return (
		<>
			<button
				ref={btn}
				type="button"
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open && options.length ? listId : undefined}
				aria-label={ariaLabel}
				title={cur?.label}
				data-testid={testId}
				onClick={() => (open ? setOpen(false) : openMenu())}
				onKeyDown={(e) => {
					if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
						e.preventDefault();
						openMenu();
					}
				}}
				className={cx("inline-flex h-9 min-w-0 items-center gap-2 rounded-lg border border-line bg-card px-2.5 text-sm text-fg hover:bg-hover disabled:opacity-50", className)}
			>
				<span className={cx("min-w-0 flex-1 truncate text-left", !cur && "text-mut")}>{cur?.label ?? placeholder ?? ""}</span>
				<ChevronDown size={15} className={cx("shrink-0 text-mut transition", open && "rotate-180")} />
			</button>
			{open &&
				rect &&
				createPortal(
					<div
						ref={pop}
						id={listId}
						role="listbox"
						tabIndex={-1}
						aria-label={ariaLabel}
						aria-activedescendant={options.length ? optId(active) : undefined}
						data-testid={testId ? `${testId}-menu` : undefined}
						className="pa-menu-in fixed z-[60] max-h-[280px] max-w-[calc(100vw-16px)] overflow-auto rounded-xl border border-line bg-card p-1 shadow-xl"
						style={{ left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxH, transform: rect.up ? "translateY(-100%)" : undefined }}
					>
						{options.map((o, i) => {
							const sel = String(o.value) === String(value);
							const hi = i === active;
							return (
								<button
									key={o.value}
									type="button"
									id={optId(i)}
									tabIndex={-1}
									data-idx={i}
									role="option"
									aria-selected={sel}
									onMouseEnter={() => setActive(i)}
									onClick={() => {
										onChange(String(o.value));
										setOpen(false);
										btn.current?.focus();
									}}
									data-testid={testId ? `${testId}-option-${o.value}` : undefined}
									className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", (sel || hi) && "bg-hover", sel && "font-medium")}
								>
									<Check size={14} className={cx("shrink-0", sel ? "opacity-100" : "opacity-0")} />
									<span className="min-w-0 flex-1 truncate">{o.label}</span>
									{o.hint && <span className="shrink-0 text-[11px] text-mut">{o.hint}</span>}
								</button>
							);
						})}
					</div>,
					document.body,
				)}
		</>
	);
}
