/**
 * 布局偏好（按设备保存在 localStorage）：左右栏宽度、左栏是否收起。
 * 工作区默认收起；并排时聊天区至少 CHAT_MIN 宽，放不下时工作区覆盖聊天。
 */
import { useEffect, useState } from "react";

export const SIDE = { min: 200, max: 420, def: 264 };
/** 工作区侧栏：宽度范围，按设备记住 */
export const PREVIEW = { min: 360, max: 1100, def: 560 };
export const CHAT_MIN = 520;
/** 左栏常驻的最小窗口宽度（更窄时左栏是抽屉） */
export const SIDE_DOCK_MIN = 1024;

export interface LayoutPrefs {
	sideW: number;
	previewW: number;
	sideCollapsed: boolean;
}
const KEY = "pia.layout";
const clamp = (v: number, r: { min: number; max: number }) => Math.round(Math.min(r.max, Math.max(r.min, v)));

export function loadLayout(): LayoutPrefs {
	try {
		const j = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<LayoutPrefs>;
		return { sideW: clamp(j.sideW ?? SIDE.def, SIDE), previewW: clamp(j.previewW ?? PREVIEW.def, PREVIEW), sideCollapsed: !!j.sideCollapsed };
	} catch {
		return { sideW: SIDE.def, previewW: PREVIEW.def, sideCollapsed: false };
	}
}
export function saveLayout(p: LayoutPrefs) {
	try {
		localStorage.setItem(KEY, JSON.stringify(p));
	} catch {
		/* 隐私模式等 */
	}
}
export const clampSide = (v: number) => clamp(v, SIDE);
export const clampPreview = (v: number) => clamp(v, PREVIEW);

export function useWindowWidth() {
	const [w, setW] = useState(() => window.innerWidth);
	useEffect(() => {
		const on = () => setW(window.innerWidth);
		window.addEventListener("resize", on);
		return () => window.removeEventListener("resize", on);
	}, []);
	return w;
}

/** 根据窗口宽度决定两侧是常驻还是抽屉，并在常驻时保证聊天区不小于 CHAT_MIN */
export function resolveLayout(width: number, p: LayoutPrefs) {
	const sideDocked = width >= SIDE_DOCK_MIN && !p.sideCollapsed;
	const sideW = sideDocked ? p.sideW : 0;
	// 工作区：扣掉左栏后，聊天区 ≥ CHAT_MIN 且侧栏 ≥ PREVIEW.min 才停靠；
	// 放不下就保持全屏弹窗。实际宽度 = 偏好宽度，但不挤占聊天区的 CHAT_MIN。
	const room = width - sideW - CHAT_MIN;
	const previewDocked = room >= PREVIEW.min;
	const previewW = previewDocked ? Math.min(p.previewW, room) : 0;
	return { sideDocked, sideDrawer: width < SIDE_DOCK_MIN, previewDocked, previewW };
}
