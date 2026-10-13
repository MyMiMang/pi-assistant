/** 在 canvas 上播放精灵图的某一行。reduced-motion 时只显示第一帧 */
import { useEffect, useRef } from "react";
import { CELL_H, CELL_W, ROWS, type Row, rowIndex } from "./atlas";

const cache = new Map<string, Promise<HTMLImageElement>>();
export function loadSheet(url: string) {
	let p = cache.get(url);
	if (!p) {
		p = new Promise((res, rej) => {
			const im = new Image();
			im.onload = () => res(im);
			im.onerror = () => (cache.delete(url), rej(new Error("精灵图加载失败")));
			im.src = url;
		});
		cache.set(url, p);
	}
	return p;
}

export function PetSprite({ url, row, scale = 1, once, onDone, className, testId }: { url: string; row: Row; scale?: number; once?: boolean; onDone?: () => void; className?: string; testId?: string }) {
	const ref = useRef<HTMLCanvasElement>(null);
	const doneRef = useRef(onDone);
	doneRef.current = onDone;
	useEffect(() => {
		const cv = ref.current;
		if (!cv) return;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		cv.width = Math.round(CELL_W * scale * dpr);
		cv.height = Math.round(CELL_H * scale * dpr);
		const ctx = cv.getContext("2d")!;
		ctx.imageSmoothingQuality = "high";
		const r = ROWS[rowIndex(row)];
		const ri = rowIndex(row);
		const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
		let frame = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let alive = true;
		loadSheet(url)
			.then((im) => {
				const draw = () => {
					if (!alive) return;
					ctx.clearRect(0, 0, cv.width, cv.height);
					ctx.drawImage(im, frame * CELL_W, ri * CELL_H, CELL_W, CELL_H, 0, 0, cv.width, cv.height);
					if (still) return;
					const ms = r.ms[frame] ?? 150;
					timer = setTimeout(() => {
						frame++;
						if (frame >= r.frames) {
							if (once) return doneRef.current?.();
							frame = 0;
						}
						draw();
					}, ms);
				};
				draw();
			})
			.catch(() => {});
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [url, row, scale, once]);
	return <canvas ref={ref} className={className} data-testid={testId} data-row={row} style={{ width: CELL_W * scale, height: CELL_H * scale }} />;
}
