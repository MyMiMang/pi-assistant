import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../i18n";
import { cx } from "./ui";

/**
 * 自适应标签栏：量出可用宽度，放不下的标签收进「更多」菜单（.pa-pop 样式）。
 * 当前选中的标签始终可见（若本应溢出，则替换掉最后一个可见标签）。
 * 键盘：标签间 ←/→/Home/End；「更多」按钮 Enter/↓ 打开菜单，菜单内 ↑/↓/Esc。
 */
export function ResponsiveTabs({ tabs, value, onChange, className, testId }: { tabs: readonly (readonly [string, string])[]; value: string; onChange: (k: string) => void; className?: string; testId?: string }) {
	const wrap = useRef<HTMLDivElement>(null);
	const measure = useRef<HTMLDivElement>(null);
	const moreBtn = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [widths, setWidths] = useState<number[]>([]);
	const [moreW, setMoreW] = useState(0);
	const [open, setOpen] = useState(false);
	const GAP = 4;

	useLayoutEffect(() => {
		const m = measure.current;
		if (!m) return;
		const bs = [...m.querySelectorAll<HTMLElement>("[data-measure]")];
		setWidths(bs.map((b) => b.getBoundingClientRect().width));
		setMoreW(m.querySelector<HTMLElement>("[data-measure-more]")?.getBoundingClientRect().width ?? 40);
	}, [tabs]);
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
		else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
		else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
		else if (e.key === "Tab") setOpen(false);
	};

	const chip = (k: string) => cx("pa-chip sm shrink-0 !border-transparent whitespace-nowrap", value === k ? "!bg-hover !text-fg font-medium" : "!bg-transparent");
	return (
		<div className="relative">
			<div ref={wrap} className={cx("flex gap-1 overflow-hidden", className)} role="tablist" data-testid={testId} onKeyDown={onTabKey}>
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
						onClick={() => setOpen(!open)} onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); } }} className={cx("pa-chip sm shrink-0 !border-transparent !bg-transparent", open && "!bg-hover")}>
						{t("更多")}
						<ChevronDown size={12} />
					</button>
				)}
			</div>
			{open && overflow.length > 0 && (
				<div ref={menu} role="menu" onKeyDown={onMenuKey} className="pa-pop absolute top-full right-3 z-30 mt-1 rounded-xl border border-line bg-card p-1.5 shadow-lg [--pop-w:14rem]" data-testid={testId ? `${testId}-menu` : undefined}>
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
			<div ref={measure} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex gap-1 whitespace-nowrap" style={{ height: 0, overflow: "hidden" }}>
				{tabs.map(([k, label]) => (
					<span key={k} data-measure className="pa-chip sm shrink-0 font-medium">{t(label)}</span>
				))}
				<span data-measure-more className="pa-chip sm shrink-0">{t("更多")}<ChevronDown size={12} /></span>
			</div>
		</div>
	);
}
