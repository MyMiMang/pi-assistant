/**
 * 孵化宠物：用图片模型画 6 个基础姿势（定妆图 + 开心 / 难过 / 干活 / 思考 / 举手），
 * 在浏览器里去掉纯色背景、裁剪对齐，再用挤压 / 弹跳 / 倾斜 / 镜像做成 9 行动画，拼成 Codex 格式的精灵图。
 * 做法参考 openai/skills hatch-pet（Apache-2.0）：先定角色再出各行、去底后检查透明、按固定格子校验。
 * 不同于 hatch-pet 让模型逐帧画整条：图片模型很难稳定画出逐帧一致的条图，这里每个姿势只要一张，动画由程序生成，更稳也更省钱。
 */
import { CELL_H, CELL_W, COLS, ROWS } from "./atlas";

export const POSES = ["base", "happy", "sad", "working", "thinking", "asking"] as const;
export type Pose = (typeof POSES)[number];
export const POSE_LABEL: Record<Pose, string> = { base: "定妆", happy: "开心", sad: "难过", working: "干活", thinking: "思考", asking: "举手" };

export function loadImg(src: string) {
	return new Promise<HTMLImageElement>((res, rej) => {
		const im = new Image();
		im.onload = () => res(im);
		im.onerror = () => rej(new Error("图片读不出来"));
		im.src = src;
	});
}

/** 去背景：从四条边往里“漫水”，和边缘颜色接近的像素变透明；边缘半透明过渡。返回裁掉空白后的画布 */
export function cutout(im: HTMLImageElement | HTMLCanvasElement, tol = 48): HTMLCanvasElement {
	const max = 512; // 统一缩到 512 以内处理，够用也快
	const w0 = im.width,
		h0 = im.height;
	const k = Math.min(1, max / Math.max(w0, h0));
	const w = Math.round(w0 * k),
		h = Math.round(h0 * k);
	const cv = document.createElement("canvas");
	cv.width = w;
	cv.height = h;
	const ctx = cv.getContext("2d", { willReadFrequently: true })!;
	ctx.drawImage(im, 0, 0, w, h);
	const img = ctx.getImageData(0, 0, w, h);
	const d = img.data;
	// 背景色：四个角的中位数
	const corners = [0, w - 1, (h - 1) * w, h * w - 1].map((i) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]);
	const med = (j: number) => corners.map((c) => c[j]).sort((a, b) => a - b)[1];
	const bg = [med(0), med(1), med(2)];
	const alreadyTransparent = corners.every((c) => c[3] < 16);
	const dist = (i: number) => Math.hypot(d[i * 4] - bg[0], d[i * 4 + 1] - bg[1], d[i * 4 + 2] - bg[2]);
	if (!alreadyTransparent) {
		const seen = new Uint8Array(w * h);
		const stack: number[] = [];
		for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
		for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
		while (stack.length) {
			const i = stack.pop()!;
			if (seen[i]) continue;
			seen[i] = 1;
			if (d[i * 4 + 3] > 16 && dist(i) > tol) continue;
			d[i * 4 + 3] = 0;
			const x = i % w,
				y = (i / w) | 0;
			if (x > 0) stack.push(i - 1);
			if (x < w - 1) stack.push(i + 1);
			if (y > 0) stack.push(i - w);
			if (y < h - 1) stack.push(i + w);
		}
		// 边缘柔化：紧挨透明区、颜色又接近背景的像素做半透明
		for (let i = 0; i < w * h; i++) {
			if (d[i * 4 + 3] === 0) continue;
			const x = i % w,
				y = (i / w) | 0;
			const nearClear = (x > 0 && d[(i - 1) * 4 + 3] === 0) || (x < w - 1 && d[(i + 1) * 4 + 3] === 0) || (y > 0 && d[(i - w) * 4 + 3] === 0) || (y < h - 1 && d[(i + w) * 4 + 3] === 0);
			if (nearClear) d[i * 4 + 3] = Math.min(d[i * 4 + 3], Math.round(255 * Math.min(1, dist(i) / (tol * 2.2))));
		}
	}
	ctx.putImageData(img, 0, 0);
	// 裁到内容范围
	let x0 = w,
		y0 = h,
		x1 = -1,
		y1 = -1,
		solid = 0;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			if (d[(y * w + x) * 4 + 3] > 40) {
				solid++;
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
	if (x1 < 0 || solid < w * h * 0.03) throw new Error("没找到角色（图里几乎是空的）");
	if (solid > w * h * 0.9) throw new Error("背景去不干净（整张图都是实心的）");
	const out = document.createElement("canvas");
	out.width = x1 - x0 + 1;
	out.height = y1 - y0 + 1;
	out.getContext("2d")!.drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
	return out;
}

interface Tf {
	dy?: number;
	dx?: number;
	sx?: number;
	sy?: number;
	rot?: number;
	flip?: boolean;
}
/** 把一个姿势画进一格：脚底居中、留边，按变形参数挤压 / 旋转 / 平移 */
function drawCell(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement, col: number, row: number, t: Tf) {
	const boxW = 150,
		boxH = 160; // 角色最大占位，给跳跃和倾斜留空间
	const k = Math.min(boxW / src.width, boxH / src.height);
	const w = src.width * k,
		h = src.height * k;
	const footX = col * CELL_W + CELL_W / 2 + (t.dx ?? 0);
	const footY = row * CELL_H + 198 + (t.dy ?? 0);
	ctx.save();
	ctx.beginPath();
	ctx.rect(col * CELL_W + 1, row * CELL_H + 1, CELL_W - 2, CELL_H - 2); // 不越出格子
	ctx.clip();
	ctx.translate(footX, footY);
	ctx.rotate(((t.rot ?? 0) * Math.PI) / 180);
	ctx.scale((t.flip ? -1 : 1) * (t.sx ?? 1), t.sy ?? 1);
	ctx.drawImage(src, -w / 2, -h, w, h);
	ctx.restore();
}

/** 9 行动画：每行用哪个姿势、每帧怎么变形 */
export function plan(): { pose: Pose; tf: Tf }[][] {
	const sin = (i: number, n: number) => Math.sin((i / n) * Math.PI * 2);
	const idle = [0, 0.015, 0.03, 0.02, 0.005, -0.01].map((b) => ({ pose: "base" as Pose, tf: { sy: 1 + b, sx: 1 - b / 2 } }));
	const run = Array.from({ length: 8 }, (_, i) => ({ pose: "base" as Pose, tf: { dy: -Math.abs(sin(i, 16)) * 7, rot: 5 + sin(i, 8) * 2, sy: 1 - Math.abs(Math.cos((i / 8) * Math.PI * 2)) * 0.03 } }));
	const runL = run.map((f) => ({ pose: f.pose, tf: { ...f.tf, rot: -(f.tf.rot ?? 0), flip: true } }));
	const wave: { pose: Pose; tf: Tf }[] = [
		{ pose: "base", tf: {} },
		{ pose: "asking", tf: { rot: -3 } },
		{ pose: "asking", tf: { rot: 3 } },
		{ pose: "happy", tf: {} },
	];
	const jump: { pose: Pose; tf: Tf }[] = [
		{ pose: "base", tf: { sx: 1.08, sy: 0.9 } },
		{ pose: "happy", tf: { dy: -16, sx: 0.95, sy: 1.06 } },
		{ pose: "happy", tf: { dy: -26 } },
		{ pose: "happy", tf: { dy: -12, sx: 0.97, sy: 1.04 } },
		{ pose: "base", tf: { sx: 1.07, sy: 0.92 } },
	];
	const failed = Array.from({ length: 8 }, (_, i) => {
		const k = Math.min(1, i / 4);
		return { pose: (i === 0 ? "base" : "sad") as Pose, tf: { sy: 1 - 0.07 * k, sx: 1 + 0.04 * k, rot: (i % 2 ? 3 : 1.5) * k } };
	});
	const wait = Array.from({ length: 6 }, (_, i) => ({ pose: "asking" as Pose, tf: { dy: -3 * Math.abs(sin(i, 6)), rot: 2 * sin(i, 6) } }));
	const work = Array.from({ length: 6 }, (_, i) => ({ pose: "working" as Pose, tf: { dy: -1.5 * (i % 2), dx: i % 3 === 0 ? 0.8 : -0.8, sy: i % 2 ? 1.01 : 0.99 } }));
	const review = Array.from({ length: 6 }, (_, i) => ({ pose: "thinking" as Pose, tf: { rot: 4 * sin(i, 6) } }));
	return [idle, run, runL, wave, jump, failed, wait, work, review];
}

/** 拼精灵图 + 校验（尺寸、已用格有内容、未用格全透明），返回 PNG dataURL */
export function compose(poses: Partial<Record<Pose, HTMLCanvasElement>>): string {
	const base = poses.base;
	if (!base) throw new Error("缺少定妆图");
	const cv = document.createElement("canvas");
	cv.width = CELL_W * COLS;
	cv.height = CELL_H * ROWS.length;
	const ctx = cv.getContext("2d", { willReadFrequently: true })!;
	ctx.imageSmoothingQuality = "high";
	plan().forEach((frames, r) => {
		if (frames.length !== ROWS[r].frames) throw new Error(`第 ${r} 行帧数不对`);
		frames.forEach((f, c) => drawCell(ctx, poses[f.pose] ?? base, c, r, f.tf));
	});
	const errs = validate(ctx);
	if (errs.length) throw new Error(`精灵图校验没通过：${errs.slice(0, 3).join("；")}`);
	return cv.toDataURL("image/png");
}

export function validate(ctx: CanvasRenderingContext2D): string[] {
	const errs: string[] = [];
	if (ctx.canvas.width !== CELL_W * COLS || ctx.canvas.height !== CELL_H * ROWS.length) errs.push("尺寸不对");
	ROWS.forEach((r, ri) => {
		for (let c = 0; c < COLS; c++) {
			const px = ctx.getImageData(c * CELL_W, ri * CELL_H, CELL_W, CELL_H).data;
			let n = 0;
			for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n++;
			if (c < r.frames && n < 200) errs.push(`${r.name} 第 ${c + 1} 帧是空的`);
			if (c >= r.frames && n > 0) errs.push(`${r.name} 第 ${c + 1} 格应为透明`);
		}
	});
	return errs;
}

export const canvasUrl = (c: HTMLCanvasElement) => c.toDataURL("image/png");
