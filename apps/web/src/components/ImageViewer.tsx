import { Download, Loader2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { download as downloadFile, fetchBlob } from "../api";
import { cx } from "./ui";

/** 全屏图片查看器要显示的图片。二选一：src（可直接渲染）或 authPath（需带登录凭证拉取）。 */
export type ViewerImage = {
	/** 已经可以直接给 <img> 用的地址（http(s) / blob / 同源路径） */
	src?: string;
	/** 需要带凭证拉取的地址（聊天附件走这个，查看器自己转 blob，生命周期自己管） */
	authPath?: string;
	alt?: string;
	/** 顶部显示的文件名 */
	name?: string;
	/** 下载地址（带凭证）；给了才显示「下载」 */
	downloadPath?: string;
};

const MIN_SCALE = 1; // 1 = 适配视口
const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;
const TAP_MS = 320;
const TAP_SLOP = 6;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

type State = { item: ViewerImage | null; open: (i: ViewerImage) => void; close: () => void };
const useViewer = create<State>((set) => ({ item: null, open: (item) => set({ item }), close: () => set({ item: null }) }));

/** 从任意位置打开全屏图片查看器（Portal 到 body，不受聊天区 overflow/transform 影响） */
export function openImageViewer(item: ViewerImage) {
	useViewer.getState().open(item);
}

/** 全局挂载一次（App.tsx） */
export function ImageViewerHost() {
	const item = useViewer((s) => s.item);
	const close = useViewer((s) => s.close);
	if (!item) return null;
	return <Viewer key={item.authPath ?? item.src} item={item} onClose={close} />;
}

const BTN = "pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-white/12 px-3 text-[13px] font-medium text-white backdrop-blur transition select-none hover:bg-white/22 active:scale-95 disabled:opacity-35 disabled:hover:bg-white/12";

function Viewer({ item, onClose }: { item: ViewerImage; onClose: () => void }) {
	const [src, setSrc] = useState(item.src ?? "");
	const [failed, setFailed] = useState(false);
	const [scale, setScale] = useState(MIN_SCALE);
	const [pos, setPos] = useState({ x: 0, y: 0 });

	const overlay = useRef<HTMLDivElement>(null);
	const stage = useRef<HTMLDivElement>(null);
	const img = useRef<HTMLImageElement>(null);
	// 手势用 ref 读写，避免闭包过期（window 监听只挂一次）
	const scaleRef = useRef(MIN_SCALE);
	const posRef = useRef({ x: 0, y: 0 });
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const drag = useRef<{ id: number; sx: number; sy: number; bx: number; by: number } | null>(null);
	const pinch = useRef<{ dist: number; mx: number; my: number } | null>(null);
	const moved = useRef(false);
	const lastTap = useRef(0);

	const apply = (s: number, p: { x: number; y: number }) => {
		scaleRef.current = s;
		posRef.current = p;
		setScale(s);
		setPos(p);
	};
	/** 拖动范围：放大后能滑到每条边，没放大时居中不动 */
	const clampPos = (x: number, y: number, s: number) => {
		const el = img.current;
		const st = stage.current;
		if (!el || !st) return { x, y };
		const mx = Math.max(0, (el.offsetWidth * s - st.clientWidth) / 2);
		const my = Math.max(0, (el.offsetHeight * s - st.clientHeight) / 2);
		return { x: clamp(x, -mx, mx), y: clamp(y, -my, my) };
	};
	/** 以 (cx,cy) 屏幕点为锚点缩放，锚点下的内容保持不动 */
	const zoomAt = (cx: number, cy: number, factor: number) => {
		const st = stage.current;
		if (!st) return;
		const s = scaleRef.current;
		const s2 = clamp(s * factor, MIN_SCALE, MAX_SCALE);
		if (Math.abs(s2 - s) < 0.0001) return;
		const r = st.getBoundingClientRect();
		const px = cx - r.left - r.width / 2;
		const py = cy - r.top - r.height / 2;
		const p = posRef.current;
		const wx = (px - p.x) / s;
		const wy = (py - p.y) / s;
		apply(s2, clampPos(px - wx * s2, py - wy * s2, s2));
	};
	const zoomCenter = (factor: number) => {
		const r = stage.current?.getBoundingClientRect();
		if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
	};
	const reset = () => apply(MIN_SCALE, { x: 0, y: 0 });
	const toggleZoom = (cx: number, cy: number) => (scaleRef.current > MIN_SCALE + 0.01 ? reset() : zoomAt(cx, cy, DOUBLE_TAP_SCALE));

	// 聊天附件：带凭证拉取，转成 blob（自己持有生命周期，缩略图卸载也不影响）
	useEffect(() => {
		if (!item.authPath) return;
		let url: string | undefined;
		let live = true;
		fetchBlob(item.authPath)
			.then((b) => {
				if (live) setSrc((url = URL.createObjectURL(b)));
			})
			.catch(() => setFailed(true));
		return () => {
			live = false;
			if (url) URL.revokeObjectURL(url);
		};
	}, [item.authPath]);

	// Esc 关闭；+/-/0 缩放（键盘）
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			} else if (e.key === "+" || e.key === "=") zoomCenter(1.4);
			else if (e.key === "-") zoomCenter(1 / 1.4);
			else if (e.key === "0") reset();
		};
		addEventListener("keydown", onKey, true);
		return () => removeEventListener("keydown", onKey, true);
	}, [onClose]);

	// 滚轮 / 触控板双指：以指针为中心缩放（必须非 passive 才能 preventDefault）
	useEffect(() => {
		const el = overlay.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			zoomAt(e.clientX, e.clientY, clamp(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), 0.4, 2.5));
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	// 拖动 / 双指缩放：监听挂 window，指针移出窗口也不丢
	useEffect(() => {
		const onMove = (e: PointerEvent) => {
			if (!pointers.current.has(e.pointerId)) return;
			pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pointers.current.size >= 2) {
				const [a, b] = [...pointers.current.values()];
				const dist = Math.hypot(a.x - b.x, a.y - b.y);
				const mx = (a.x + b.x) / 2;
				const my = (a.y + b.y) / 2;
				const prev = pinch.current;
				if (prev && prev.dist > 0) {
					if (dist > 0) zoomAt(mx, my, dist / prev.dist);
					const p = posRef.current;
					apply(scaleRef.current, clampPos(p.x + (mx - prev.mx), p.y + (my - prev.my), scaleRef.current));
				}
				pinch.current = { dist, mx, my };
				moved.current = true;
			} else if (drag.current?.id === e.pointerId) {
				const d = drag.current;
				const dx = e.clientX - d.sx;
				const dy = e.clientY - d.sy;
				if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) moved.current = true;
				apply(scaleRef.current, clampPos(d.bx + dx, d.by + dy, scaleRef.current));
			}
		};
		const onUp = (e: PointerEvent) => {
			if (!pointers.current.has(e.pointerId)) return;
			pointers.current.delete(e.pointerId);
			if (pointers.current.size === 1) {
				// 双指松开一根：以剩下那根重新做拖动基准
				const [id, p] = [...pointers.current.entries()][0];
				drag.current = { id, sx: p.x, sy: p.y, bx: posRef.current.x, by: posRef.current.y };
				pinch.current = null;
				return;
			}
			if (pointers.current.size > 1) return;
			pinch.current = null;
			drag.current = null;
			if (moved.current) return;
			// 双击 / 双击轻点：放大 ↔ 还原
			const now = Date.now();
			if (now - lastTap.current < TAP_MS) {
				lastTap.current = 0;
				toggleZoom(e.clientX, e.clientY);
			} else lastTap.current = now;
		};
		const onCancel = (e: PointerEvent) => {
			pointers.current.delete(e.pointerId);
			if (!pointers.current.size) {
				drag.current = null;
				pinch.current = null;
			}
		};
		addEventListener("pointermove", onMove);
		addEventListener("pointerup", onUp);
		addEventListener("pointercancel", onCancel);
		return () => {
			removeEventListener("pointermove", onMove);
			removeEventListener("pointerup", onUp);
			removeEventListener("pointercancel", onCancel);
		};
	}, []);

	const onPointerDown = (e: React.PointerEvent) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.current.size === 1) {
			drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, bx: posRef.current.x, by: posRef.current.y };
			moved.current = false;
		} else {
			drag.current = null;
			moved.current = true;
			const [a, b] = [...pointers.current.values()];
			pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
		}
	};
	// 只有点在图片外、且没拖动过才关（拖动结束时松手不会误关）
	const onBackdropClick = (e: React.MouseEvent) => {
		if (moved.current) return;
		if ((e.target as HTMLElement).closest?.("[data-viewer-img]")) return;
		onClose();
	};
	const stop = (e: React.SyntheticEvent) => e.stopPropagation();

	const canDownload = !!(item.downloadPath ?? item.authPath);
	const zoomed = scale > MIN_SCALE + 0.01;
	const title = item.name ?? item.alt ?? "图片";

	return createPortal(
		<div
			ref={overlay}
			role="dialog"
			aria-modal="true"
			aria-label={`图片预览：${title}`}
			className="fixed inset-0 z-[70] flex touch-none flex-col bg-black/90 select-none"
			data-testid="image-viewer"
			onClick={onBackdropClick}
			onPointerDown={onPointerDown}
		>
			{/* 顶栏：文件名 + 关闭（很窄，不遮图） */}
			<div
				className="relative z-10 flex items-center gap-2 bg-gradient-to-b from-black/65 to-transparent px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-3 text-white"
				onPointerDown={stop}
				onClick={stop}
			>
				<span className="min-w-0 flex-1 truncate text-[13px] opacity-85" title={title}>
					{item.name ?? ""}
				</span>
				<button type="button" className={cx(BTN, "h-9 w-9 justify-center px-0")} onClick={onClose} aria-label="关闭" title="关闭（Esc）" data-testid="viewer-close">
					<X size={18} />
				</button>
			</div>

			{/* 图片舞台 */}
			<div ref={stage} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-1 sm:p-4">
				{failed ? (
					<div className="text-sm text-white/70">图片加载失败</div>
				) : src ? (
					<img
						ref={img}
						data-viewer-img
						src={src}
						alt={item.alt ?? item.name ?? ""}
						draggable={false}
						onDragStart={(e) => e.preventDefault()}
						onError={() => setFailed(true)}
						className={cx("max-h-full max-w-full origin-center rounded-lg object-contain shadow-2xl", scale > MIN_SCALE + 0.01 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in")}
						style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0) scale(${scale})` }}
					/>
				) : (
					<Loader2 className="animate-spin text-white/60" size={22} />
				)}
			</div>

			{/* 底栏：缩放 / 重置 / 下载（胶囊，手机上也只占一行） */}
			<div
				className="relative z-10 flex justify-center px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
				onPointerDown={stop}
				onClick={stop}
			>
				<div className="pointer-events-none flex items-center gap-1 rounded-full bg-black/45 p-1 backdrop-blur">
					<button type="button" className={cx(BTN, "w-9 justify-center px-0")} onClick={() => zoomCenter(1 / 1.4)} disabled={!zoomed} aria-label="缩小" title="缩小（-）" data-testid="viewer-zoom-out">
						<ZoomOut size={17} />
					</button>
					<button type="button" className={cx(BTN, "min-w-14 justify-center px-2 tabular-nums")} onClick={reset} disabled={!zoomed && pos.x === 0 && pos.y === 0} title="回到适配视口" data-testid="viewer-scale">
						{Math.round(scale * 100)}%
					</button>
					<button type="button" className={cx(BTN, "w-9 justify-center px-0")} onClick={() => zoomCenter(1.4)} disabled={scale >= MAX_SCALE - 0.01} aria-label="放大" title="放大（+）" data-testid="viewer-zoom-in">
						<ZoomIn size={17} />
					</button>
					<span className="mx-0.5 h-5 w-px bg-white/20" />
					<button type="button" className={cx(BTN, "px-3")} onClick={reset} title="还原到适配视口（0）" data-testid="viewer-reset">
						<RotateCcw size={15} /> 重置
					</button>
					{canDownload && (
						<button type="button" className={cx(BTN, "px-3")} onClick={() => void downloadFile(item.downloadPath ?? item.authPath!, item.name ?? "图片")} title="下载原图" data-testid="viewer-download">
							<Download size={15} /> 下载
						</button>
					)}
				</div>
			</div>
		</div>,
		document.body,
	);
}
