import { useEffect, useState } from "react";
import { api } from "../api";

export interface Fx {
	rate: number;
	display: "CNY" | "USD";
}
let fxCache: Promise<Fx> | null = null;
let fxListeners: ((f: Fx) => void)[] = [];
/** 显示币种与汇率（设置 › 用量）；改了以后调用 refreshFx() */
export function useFx(): Fx {
	const [fx, setFx] = useState<Fx>({ rate: 7.1, display: "CNY" });
	useEffect(() => {
		fxCache ??= api<{ fx: Fx }>("/api/usage/settings").then((r) => r.fx).catch(() => ((fxCache = null), { rate: 7.1, display: "CNY" as const }));
		void fxCache.then(setFx);
		fxListeners.push(setFx);
		return () => void (fxListeners = fxListeners.filter((x) => x !== setFx));
	}, []);
	return fx;
}
export function refreshFx(f: Fx) {
	fxCache = Promise.resolve(f);
	for (const l of fxListeners) l(f);
}
/** 美元 → 显示金额；null = 价格未知「—」 */
export function fmtMoney(usd: number | null | undefined, fx: Fx) {
	if (usd === null || usd === undefined) return "—";
	const v = fx.display === "CNY" ? usd * fx.rate : usd;
	const sym = fx.display === "CNY" ? "¥" : "$";
	if (v === 0) return `${sym}0`;
	if (v < 0.01) return `${sym}${v.toFixed(4)}`;
	if (v < 100) return `${sym}${v.toFixed(2)}`;
	return `${sym}${Math.round(v).toLocaleString()}`;
}
export function fmtTok(n: number | null | undefined) {
	const v = n ?? 0;
	if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
	if (v >= 1e4) return `${(v / 1e4).toFixed(v >= 1e6 ? 0 : 1)}万`;
	return String(v);
}
export const fmtPct = (r: number | null | undefined) => (r === null || r === undefined ? "—" : `${Math.round(r * 100)}%`);

export interface MsgUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number | null;
	saved: number | null;
}
