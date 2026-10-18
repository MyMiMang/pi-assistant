import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../i18n";
import { cx } from "./ui";

/**
 * 自适应标签栏：量出可用宽度，放不下的标签收进「更多」菜单（.pa-pop 样式）。
 * 当前选中的标签始终可见（若本应溢出，则替换掉最后一个可见标签）。
 * 键盘：标签间 ←/→/Home/End；「更多」按钮 Enter/↓ 打开菜单，菜单内 ↑/↓/Esc。
 *
 * variant：chips = 默认胶囊标签；plain = 助理设置的单行文字分类；tabs = 二级页签（下划线）。
 * 测量行与可见标签用同一套排版类，保证「更多」的临界点和真实宽度一致。
 */
export function ResponsiveTabs({ tabs, value, onChange, className, testId, variant = "chips" }: { tabs: readonly (readonly [string, string])[]; value: string; onChange: (k: string) => void; className?: string; testId?: string; variant?: "chips" | "plain" | "tabs" }) {
	const wrap = useRef<HTMLDivElement>(null);
	const measure = useRef<HTMLDivElement>(null);
	const moreBtn = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [widths, setWidths] = useState<number[]>([]);
	const [moreW, setMoreW] = useState(0);
	const [open, setOpen] = useState(false);
	const GAP = variant === "chips" ? 4 : 0;

	useLayoutEffect(() => {
		const m = measure.current;
		if (!m) return;
		const bs = [...m.querySelectorAll<HTMLElement>("[data-measure]")];
		setWidths(bs.map((b) => b.getBoundingClientRect().width));
		setMoreW(m.querySelector<HTMLElement>("[data-measure-more]")?.getBoundingClientRect().width ?? 40);
	}, [tabs, variant]);
	useLayoutEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const upd = () => setWidth(el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight));
		upd();
		const ro = new ResizeObserver(upd);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// 计算可见集合
	let visible = tabs.map((_, i) => i);
	let overflow: number[] = [];
	if (width > 0 && widths.length === tabs.length) {
		const total = widths.reduce((a, b) => a + b, 0) + GAP * (tabs.length - 1);
		if (total > width + 0.5) {
			const avail = width - moreW - GAP;
			let used = 0;
			visible = [];
			for (let i = 0; i < tabs.length; i++) {
				const w = widths[i] + (visible.length ? GAP : 0);
				if (used + w > avail) break;
				used += w;
				visible.push(i);
			}
			const ai = tabs.findIndex(([k]) => k === value);
			if (ai >= 0 && !visible.includes(ai)) {
				// 腾出空间放入选中标签
				while (visible.length && used + widths[ai] + (visible.length ? GAP : 0) > avail) {
					const r = visible.pop()!;
					used -= widths[r] + (visible.length ? GAP : 0);
				}
				visible.push(ai);
				visible.sort((a, b) => a - b);
			}
			overflow = tabs.map((_, i) => i).filter((i) => !visible.includes(i));
		}
	}

	useEffect(() => {
		if (!open) return;
		const off = (e: MouseEvent) => { if (!menu.current?.contains(e.target as Node) && !moreBtn.current?.contains(e.target as Node)) setOpen(false); };
		document.addEventListener("mousedown", off);
		menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
		return () => document.removeEventListener("mousedown", off);
	}, [open]);
	useEffect(() => { if (!overflow.length) setOpen(false); }, [overflow.length]);

	const onTabKey = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
		const bs = [...(wrap.current?.querySelectorAll<HTMLElement>(":scope > [role=tab], :scope > [data-more]") ?? [])];
		const i = bs.indexOf(document.activeElement as HTMLElement);
		if (i < 0) return;
		let n = -1;
		if (e.key === "ArrowRight") n = (i + 1) % bs.length;
		else if (e.key === "ArrowLeft") n = (i - 1 + bs.length) % bs.length;
		else if (e.key === "Home") n = 0;
		else if (e.key === "End") n = bs.length - 1;
		if (n >= 0) { e.preventDefault(); bs[n].focus(); }
	}, []);
	const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
		const items = [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
		const i = items.indexOf(document.activeElement as HTMLElement);
		if (e.key === "Escape") { e.preventDefault(); setOpen(false); moreBtn.current?.focus(); }
		else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
		else if (e.key === "End") { e.preventDefault(); items.at(-1)?.focus(); }
		else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
		else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
		else if (e.key === "Tab") setOpen(false);
	};

	const chip = (k: string) =>
		variant === "plain"
			? cx("pa-info-tab shrink-0", value === k && "font-medium")
			: variant === "tabs"
				? cx("pa-subtab")
				: cx("pa-chip sm shrink-0 !border-transparent whitespace-nowrap", value === k ? "!bg-hover !text-fg font-medium" : "!bg-transparent");
	const measureCls = variant === "plain" ? "pa-info-tab shrink-0 font-medium" : variant === "tabs" ? "pa-subtab !flex-none font-medium" : "pa-chip sm shrink-0 font-medium";
	const moreCls = variant === "plain" ? "pa-info-tab" : variant === "tabs" ? "pa-subtab !flex-none" : "pa-chip sm shrink-0 !border-transparent !bg-transparent";
	return (
		<div className="relative min-h-0 shrink-0">
			<div ref={wrap} className={cx("flex overflow-hidden", variant === "chips" ? "gap-1" : "gap-0", className)} role="tablist" data-testid={testId} onKeyDown={onTabKey}>
				{visible.map((i) => {
					const [k, label] = tabs[i];
					return (
						<button key={k} role="tab" data-itab={k} aria-selected={value === k} tabIndex={value === k ? 0 : -1} onClick={() => onChange(k)} className={chip(k)}>
							{t(label)}
						</button>
					);
				})}
				{overflow.length > 0 && (
					<button ref={moreBtn} data-more type="button" aria-haspopup="menu" aria-expanded={open} aria-label={t("更多")} title={t("更多")} data-testid={testId ? `${testId}-more` : undefined}
						onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); } }} className={cx(moreCls, variant === "chips" && open && "!bg-hover")}>
						{t("更多")}
						<ChevronDown size={12} />
					</button>
				)}
			</div>
			{open && overflow.length > 0 && (
				<div ref={menu} role="menu" onKeyDown={onMenuKey} className="pa-pop absolute top-full right-3 z-30 mt-1 max-h-[50vh] overflow-y-auto rounded-xl border border-line bg-card p-1.5 shadow-lg [--pop-w:14rem]" data-testid={testId ? `${testId}-menu` : undefined}>
					{overflow.map((i) => {
						const [k, label] = tabs[i];
						return (
							<button key={k} role="menuitem" data-itab={k} tabIndex={-1} onClick={() => { onChange(k); setOpen(false); moreBtn.current?.focus(); }} className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover focus:bg-hover focus:outline-none">
								{t(label)}
							</button>
						);
					})}
				</div>
			)}
			{/* 隐藏测量行：所有标签按选中态（加粗）的宽度测量 */}
			<div ref={measure} aria-hidden className={cx("pointer-events-none invisible absolute top-0 left-0 flex whitespace-nowrap", variant === "chips" ? "gap-1" : "gap-0")} style={{ height: 0, overflow: "hidden" }}>
				{tabs.map(([k, label]) => (
					<span key={k} data-measure className={measureCls}>{t(label)}</span>
				))}
				<span data-measure-more className={moreCls}>{t("更多")}<ChevronDown size={12} /></span>
			</div>
		</div>
	);
}
