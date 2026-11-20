import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

const THRESHOLD = 7;
const EDGE = 32;

/** Gestures only; SidebarPersonalFolders owns validation, persistence and errors. */
export function useAgentFolderDrag(enabled: boolean, onMove: (id: string, folderId: string) => void) {
	const zone = useRef<HTMLDivElement>(null);
	const cancel = useRef<(() => void) | null>(null);
	const suppressClick = useRef(false);
	const [dragging, setDragging] = useState<{ name: string; x: number; y: number } | null>(null);
	useEffect(() => {
		if (!enabled) cancel.current?.();
		return () => cancel.current?.();
	}, [enabled]);

	const start = (e: ReactPointerEvent<HTMLButtonElement>, id: string, name: string, handle = false) => {
		suppressClick.current = false;
		if (!enabled || cancel.current || !e.isPrimary || e.button !== 0 || (!handle && e.pointerType !== "mouse")) return;
		// Keep the composer (or existing keyboard target) focused throughout the gesture.
		e.preventDefault();
		const source = e.currentTarget, pointer = e.pointerId, x0 = e.clientX, y0 = e.clientY;
		const scroller = zone.current?.closest(".pa-agents");
		let active = false, frame = 0, x = x0, y = y0, target: HTMLElement | null = null;
		const listeners = new AbortController();
		const options = { capture: true, signal: listeners.signal };
		const hit = () => {
			const candidate = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-folder-drop]");
			const next = candidate && zone.current?.contains(candidate) ? candidate : null;
			if (target === next) return;
			target?.removeAttribute("data-drop-active");
			target = next;
			target?.setAttribute("data-drop-active", "");
		};
		const autoScroll = () => {
			if (scroller) {
				const r = scroller.getBoundingClientRect();
				if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
					const delta = y < r.top + EDGE ? y - r.top - EDGE : y > r.bottom - EDGE ? y - r.bottom + EDGE : 0;
					if (delta) { scroller.scrollTop += delta / 4; hit(); }
				}
			}
			frame = requestAnimationFrame(autoScroll);
		};
		const finish = (drop = false) => {
			listeners.abort();
			cancel.current = null;
			cancelAnimationFrame(frame);
			const folderId = target?.dataset.folderDrop;
			target?.removeAttribute("data-drop-active");
			if (source.hasPointerCapture(pointer)) source.releasePointerCapture(pointer);
			if (!active) return;
			setDragging(null);
			if (drop && folderId !== undefined) onMove(id, folderId);
		};
		cancel.current = () => finish();
		window.addEventListener("pointermove", (ev) => {
			if (ev.pointerId !== pointer) return;
			x = ev.clientX; y = ev.clientY;
			if (!active) {
				if (Math.hypot(x - x0, y - y0) < THRESHOLD) return;
				if (!source.isConnected) return finish();
				active = suppressClick.current = true;
				source.setPointerCapture(pointer);
				frame = requestAnimationFrame(autoScroll);
			}
			hit();
			setDragging({ name, x, y });
		}, options);
		window.addEventListener("pointerup", (ev) => {
			if (ev.pointerId !== pointer) return;
			if (active) { x = ev.clientX; y = ev.clientY; hit(); }
			finish(true);
		}, options);
		const abortPointer = (ev: PointerEvent) => { if (ev.pointerId === pointer) finish(); };
		window.addEventListener("pointercancel", abortPointer, options);
		window.addEventListener("lostpointercapture", abortPointer, options);
		window.addEventListener("blur", () => finish(), options);
		window.addEventListener("keydown", (ev) => {
			if (ev.key === "Escape") {
				if (active) { ev.preventDefault(); ev.stopPropagation(); }
				finish();
			}
		}, options);
	};

	const guardClick = (e: MouseEvent<HTMLDivElement>) => {
		if (!suppressClick.current || !e.detail) return;
		suppressClick.current = false;
		e.preventDefault();
		e.stopPropagation();
	};
	return { zone, dragging, start, guardClick, resetClick: () => { suppressClick.current = false; } };
}
