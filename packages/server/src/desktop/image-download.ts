/**
 * 助理电脑镜像接入统一下载管理（设置 › 下载与组件 / 助理电脑页同一个进度组件）。
 * 不改 image.ts 的下载流程：这里只观察 installState()，下载期间用 trackDownload 汇报进度。
 * 引擎（docker / nerdctl）不给字节数，按“已完成层 / 总层数 × 镜像压缩大小”估算字节，并显示“第 x/y 层”。
 */
import { downloadInfo, type Progress, registerDownload, trackDownload } from "../downloads.ts";
import { imagePresent, installState, startInstall } from "./image.ts";
import { customImage, desktopSettings, pinned } from "./settings.ts";

export const DESKTOP_IMAGE_ID = "desktop-image";
let present = false;
let tracking = false;

/** 重新查一次镜像在不在（下载完成 / 设置变化后） */
export async function refreshImagePresent() {
	present = await imagePresent().catch(() => false);
	return present;
}

function report(p: Progress) {
	const s = installState();
	const total = pinned.downloadBytes || null;
	const det = (s as { detail?: string }).detail;
	// macOS 虚拟机后端：installState 把“虚拟机组件 / 开机 / 镜像”合成一个进度；镜像段（后 50%）换算回镜像本身，其余阶段只显示说明（虚拟机组件有自己的条目）
	let frac: number | null = s.progress;
	if (det) frac = /桌面镜像/.test(det) ? Math.max(0, (s.progress - 0.5) * 2) : null;
	p.bytes(total && frac !== null ? Math.round(frac * total) : 0, frac === null ? null : total);
	p.detail(det ? (frac !== null && s.layersTotal ? `${det} · 第 ${s.layersDone}/${s.layersTotal} 层` : det) : s.layersTotal ? `第 ${s.layersDone}/${s.layersTotal} 层` : "正在准备…");
}

/** 下载进行中：一直汇报到结束；出错时抛出（下载管理显示“出错 · 重试”） */
function follow() {
	if (tracking) return;
	tracking = true;
	present = false;
	void trackDownload(
		DESKTOP_IMAGE_ID,
		(p) =>
			new Promise<void>((res, rej) => {
				const t = setInterval(() => {
					const s = installState();
					if (s.phase === "downloading") return report(p);
					clearInterval(t);
					if (s.phase === "error") rej(new Error(s.error ?? "下载失败"));
					else void refreshImagePresent().then(() => res());
				}, 500);
				report(p);
			}),
	)
		.catch(() => {})
		.finally(() => (tracking = false));
}

export function startImageDownload() {
	if (!desktopSettings().enabled) return Promise.reject(new Error("先在 设置 › 助理电脑 里开启"));
	const run = startInstall();
	follow();
	return run.then(() => {
		const s = installState();
		if (s.phase === "error") throw new Error(s.error ?? "下载失败");
	});
}

registerDownload({
	id: DESKTOP_IMAGE_ID,
	name: "助理电脑桌面镜像",
	group: "助理电脑",
	size: pinned.downloadBytes || undefined,
	installed: () => present,
	start: () => startImageDownload(),
	hidden: () => !!customImage() || (!desktopSettings().enabled && !present),
});

// 其他入口（开启开关、开机前自动下载）直接调 startInstall：这里盯着状态，开始下载就接上进度
const watcher = setInterval(() => {
	if (installState().phase === "downloading") follow();
	else if (!present && installState().phase === "done") void refreshImagePresent();
}, 1000);
watcher.unref();
if (desktopSettings().enabled) void refreshImagePresent();
export const imageDownloadInfo = () => downloadInfo(DESKTOP_IMAGE_ID);
