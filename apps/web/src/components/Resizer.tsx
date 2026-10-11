import { useRef } from "react";

/**
 * 拖动边缘调整栏宽。side="right" 表示手柄在元素右边（左栏），side="left" 在元素左边（右栏）。
 * 双击恢复默认宽度；拖到比最小宽度再小 60px 时收起。
 */
export function Resizer({ side, value, onChange, onReset, onCollapse, label }: { side: "left" | "right"; value: number; onChange: (v: number) => void; onReset: () => void; onCollapse?: () => void; label: string }) {
	const start = useRef<{ x: number; w: number } | null>(null);
	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			title={`${label}（拖动；双击恢复默认）`}
			tabIndex={0}
			className={`pa-resizer ${side}`}
			onDoubleClick={onReset}
			onKeyDown={(e) => {
				const d = e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
				if (d) onChange(value + (side === "right" ? d : -d));
			}}
			onPointerDown={(e) => {
				e.preventDefault();
				(e.target as HTMLElement).setPointerCapture(e.pointerId);
				start.current = { x: e.clientX, w: value };
				document.body.classList.add("pa-resizing");
			}}
			onPointerMove={(e) => {
				if (!start.current) return;
				const dx = e.clientX - start.current.x;
				const w = start.current.w + (side === "right" ? dx : -dx);
				onChange(w);
				if (onCollapse && w < 140) {
					start.current = null;
					document.body.classList.remove("pa-resizing");
					onCollapse();
				}
			}}
			onPointerUp={() => {
				start.current = null;
				document.body.classList.remove("pa-resizing");
			}}
		/>
	);
}
