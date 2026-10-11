/**
 * 布局偏好（按设备保存在 localStorage）：左右栏宽度、左栏是否收起、右侧信息面板是否打开。
 * 规则：右侧面板默认收起；聊天区至少 CHAT_MIN 宽；窗口窄于 DOCK_MIN 或放不下时，右侧面板变成覆盖式抽屉。
 */
import { useEffect, useState } from "react";

export const SIDE = { min: 200, max: 420, def: 264 };
export const PANE = { min: 280, max: 560, def: 340 };
export const CHAT_MIN = 520;
export const DOCK_MIN = 1200;
/** 左栏常驻的最小窗口宽度（更窄时左栏是抽屉） */
export const SIDE_DOCK_MIN = 1024;

export interface LayoutPrefs {
	sideW: number;
	paneW: number;
	sideCollapsed: boolean;
	info: boolean;
}
const KEY = "pia.layout";
const clamp = (v: number, r: { min: number; max: number }) => Math.round(Math.min(r.max, Math.max(r.min, v)));

export function loadLayout(): LayoutPrefs {
	try {
		const j = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<LayoutPrefs>;
		return { sideW: clamp(j.sideW ?? SIDE.def, SIDE), paneW: clamp(j.paneW ?? PANE.def, PANE), sideCollapsed: !!j.sideCollapsed, info: !!j.info };
	} catch {
		return { sideW: SIDE.def, paneW: PANE.def, sideCollapsed: false, info: false };
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
export const clampPane = (v: number) => clamp(v, PANE);

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
	const paneDocked = width >= DOCK_MIN && width - sideW - p.paneW >= CHAT_MIN;
	return { sideDocked, sideDrawer: width < SIDE_DOCK_MIN, paneDocked };
}
