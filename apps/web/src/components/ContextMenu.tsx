/**
 * 程序自己的右键菜单，替代浏览器 / 桌面程序自带的那份（后退、重新载入、检查元素……）。
 * - ContextMenu：通用小菜单，消息菜单（MessageReply 的 useReplyContext）和全局菜单共用。
 * - AppContextMenuHost：挂在应用外壳。消息以外的地方右键：选了文字给「复制」，链接给「复制链接」，其余不弹菜单。
 *   输入框 / 可编辑区域、图片、音视频保留系统菜单（粘贴、存图）；消息上的右键由消息菜单处理（它已 preventDefault，这里不再接管）。
 */
import { Copy, Link } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText, rememberSelection, selectionBeforeRightClick } from "../clipboard";

export interface MenuItem {
	key: string;
	label: string;
	icon: ReactNode;
	run: () => void;
}

export function ContextMenu({ at, items, onClose, testId }: { at: { x: number; y: number } | null; items: MenuItem[]; onClose: () => void; testId: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const open = !!at && items.length > 0;
	useEffect(() => {
		if (!open) return;
		const onDoc = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && onClose();
		// 捕获阶段吃掉 Esc：只关这一层菜单，不把底下的弹窗一起关掉
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("pointerdown", onDoc, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("scroll", onClose, true);
		window.addEventListener("resize", onClose);
		return () => {
			document.removeEventListener("pointerdown", onDoc, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", onClose, true);
			window.removeEventListener("resize", onClose);
		};
	}, [open, onClose]);
	if (!open) return null;
	const w = 168;
	const left = Math.max(8, Math.min(at.x, window.innerWidth - w - 8));
	const top = Math.max(8, Math.min(at.y, window.innerHeight - items.length * 36 - 16));
	return createPortal(
		<div ref={ref} role="menu" className="pa-reply-menu" style={{ left, top, width: w }} data-testid={testId}>
			{items.map((it) => (
				<button
					key={it.key}
					type="button"
					role="menuitem"
					className="pa-reply-menu-item"
					onClick={() => {
						it.run();
						onClose();
					}}
					data-testid={`${testId}-${it.key}`}
				>
					{it.icon} {it.label}
				</button>
			))}
		</div>,
		document.body,
	);
}

/** 「复制」菜单项：复制选中的文字，没选就复制整段（whole）。 */
export function copyItem(selected: string, whole?: string): MenuItem | null {
	const text = selected || whole || "";
	if (!text.trim()) return null;
	return { key: "copy", label: selected ? "复制选中的文字" : "复制", icon: <Copy className="pa-ic" />, run: () => void copyText(text) };
}

export function AppContextMenuHost() {
	const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
	const close = useCallback(() => setMenu(null), []);
	useEffect(() => {
		const onMenu = (e: MouseEvent) => {
			if (e.defaultPrevented) return;
			const el = e.target as Element | null;
			if (!el || typeof el.closest !== "function" || el.closest("input, textarea, select, img, video, audio, [contenteditable='true']")) return;
			e.preventDefault();
			const link = el.closest("a[href]") as HTMLAnchorElement | null;
			const items = [copyItem(selectionBeforeRightClick())];
			if (link) items.push({ key: "copy-link", label: "复制链接", icon: <Link className="pa-ic" />, run: () => void copyText(link.href) });
			const shown = items.filter((x): x is MenuItem => !!x);
			setMenu(shown.length ? { x: e.clientX, y: e.clientY, items: shown } : null);
		};
		document.addEventListener("mousedown", rememberSelection, true);
		document.addEventListener("contextmenu", onMenu);
		return () => {
			document.removeEventListener("mousedown", rememberSelection, true);
			document.removeEventListener("contextmenu", onMenu);
		};
	}, []);
	return <ContextMenu at={menu} items={menu?.items ?? []} onClose={close} testId="app-menu" />;
}
