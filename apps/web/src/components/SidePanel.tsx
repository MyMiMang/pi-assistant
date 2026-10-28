import { Maximize2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { PREVIEW, clampPreview } from "../layout";
import { useStore } from "../store";
import { Resizer } from "./Resizer";
import { Modal } from "./ui";

/**
 * 聊天右边的侧栏（设计见 docs/design/side-panel-views.md、file-preview-side-panel.md）。
 *
 * `<SidePanel open onClose title testId>` 用法和 `Modal` 一样：
 * - 窗口够宽（App 用 layout.ts 的 resolveLayout 算出 docked）：内容 portal 进聊天右边的槽位（SidePanelDock），同一时间只有一个，
 *   新的打开时调用旧的 onClose；工具栏有「放大」和 ×；
 * - 放不下（手机 / 窄窗口）：就是原来的 Modal，行为不变（不抢占别的面板）；
 * - 「放大」：同一份内容改渲染进 `Modal wide fixed`，关掉就整个关闭。
 * 不传 title = 内容自带工具栏（文件预览）：children 可以是函数，拿到 onExpand（只有侧栏里才有）。
 */
type Active = { id: symbol; onClose: () => void };
type PanelState = { active: Active | null; expanded: boolean; docked: boolean; slot: HTMLElement | null };
const usePanel = create<PanelState>(() => ({ active: null, expanded: false, docked: false, slot: null }));
const setSlot = (el: HTMLElement | null) => usePanel.setState({ slot: el });
const expand = () => usePanel.setState({ expanded: true });

/** 侧栏正显示在聊天旁边（App 据此让信息面板让位） */
export const useSidePanelShown = () => usePanel((s) => !!s.active && s.docked && !s.expanded);

export function SidePanel({ open, onClose, title, label, testId, wide, fixed, children }: {
	open: boolean;
	onClose: () => void;
	title?: ReactNode;
	/** 无标题（内容自带工具栏）时的无障碍名称 */
	label?: string;
	testId?: string;
	/** 以下两项只影响窄屏弹窗，和 Modal 同名同义 */
	wide?: boolean;
	fixed?: boolean;
	children: ReactNode | ((p: { onExpand?: () => void }) => ReactNode);
}) {
	const idRef = useRef(Symbol());
	const id = idRef.current;
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const docked = usePanel((s) => s.docked);
	const isActive = usePanel((s) => s.active?.id === id);
	const expanded = usePanel((s) => s.expanded && s.active?.id === id);
	const slot = usePanel((s) => s.slot);

	useEffect(() => {
		if (!open || !docked) return;
		const prev = usePanel.getState().active;
		usePanel.setState({ active: { id, onClose: () => closeRef.current() }, expanded: false });
		if (prev && prev.id !== id) prev.onClose();
		return () => {
			if (usePanel.getState().active?.id === id) usePanel.setState({ active: null, expanded: false });
		};
	}, [open, docked, id]);

	if (!open) return null;
	const inDock = docked && !expanded;
	const content = typeof children === "function" ? children({ onExpand: inDock ? expand : undefined }) : children;
	if (!inDock) {
		const big = docked && expanded;
		return (
			<Modal open onClose={onClose} title={title} wide={big || wide} fixed={big || fixed} testId={testId}>
				{big && !fixed ? <div className="h-full overflow-y-auto">{content}</div> : content}
			</Modal>
		);
	}
	if (!slot || !isActive) return null;
	return createPortal(
		<aside className="pa-preview flex flex-col" aria-label={label ?? (typeof title === "string" ? title : undefined)} data-testid={testId} data-docked="1">
			{title !== undefined && (
				<header className="flex items-center gap-1 border-b border-line px-3 py-2">
					<div className="min-w-0 flex-1 truncate font-semibold">{title}</div>
					<button type="button" className="pa-icon-btn ghost" title="放大（用大窗口查看）" aria-label="放大" onClick={expand} data-testid="side-panel-expand">
						<Maximize2 size={16} />
					</button>
					<button type="button" className="pa-icon-btn ghost" title="关闭（Esc）" aria-label="关闭" onClick={onClose} data-testid="side-panel-close">
						<X size={18} />
					</button>
				</header>
			)}
			<div className={fixed || title === undefined ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto"}>{content}</div>
		</aside>,
		slot,
	);
}

/**
 * 侧栏槽位（App 挂一次）：聊天区右边一栏——Resizer 调宽、Esc 关闭、换助理 / 对话自动关；
 * `docked` / `width` 由 App 用 layout.ts 的 resolveLayout 算好传进来。
 */
export function SidePanelDock({ docked, width }: { docked: boolean; width: number }) {
	const active = usePanel((s) => s.active);
	const expanded = usePanel((s) => s.expanded);
	const previewW = useStore((s) => s.layout.previewW);
	const setLayout = useStore((s) => s.setLayout);
	useLayoutEffect(() => usePanel.setState({ docked }), [docked]);
	const show = !!active && docked && !expanded;
	const showRef = useRef(show);
	showRef.current = show;
	const close = () => usePanel.getState().active?.onClose();

	// 当前助理 / 群 / 对话变了：侧栏开着就自动关（刚进来、对话 id 还没加载好时补上 id 不算切换）
	const who = useStore((s) => `${s.room ?? ""}|${s.current ?? ""}`);
	const conv = useStore((s) => s.convs[s.current ?? ""]?.current ?? "");
	const last = useRef({ who, conv });
	useEffect(() => {
		const p = last.current;
		last.current = { who, conv };
		if (p.who === who && (!p.conv || p.conv === conv)) return;
		if (showRef.current) close();
	}, [who, conv]);

	// Esc 关闭：在输入框 / 可编辑区域里打字时不关；已有弹层（设置、图片查看等）开着时让它们先处理
	useEffect(() => {
		if (!show) return;
		const k = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
			if (document.querySelector(".pa-modal, [data-testid=image-viewer]")) return;
			close();
		};
		addEventListener("keydown", k);
		return () => removeEventListener("keydown", k);
	}, [show]);

	if (!show) return null;
	return (
		<div className="pa-preview-wrap" ref={setSlot} style={{ ["--preview-w" as string]: `${width}px` }}>
			<Resizer side="left" value={width} onChange={(v) => setLayout({ previewW: clampPreview(v) })} onReset={() => setLayout({ previewW: PREVIEW.def })} onCollapse={close} label="调整侧栏宽度" />
		</div>
	);
}
