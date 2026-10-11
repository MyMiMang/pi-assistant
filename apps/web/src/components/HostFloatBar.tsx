/**
 * 托盘悬浮条（/hostbar）：托盘程序在“助理正在操作这台电脑”时弹出的置顶小窗，任何时候一键暂停。
 * 只在本机打开（接口是 localOnly）。网页里也能直接访问 http://127.0.0.1:8787/hostbar 预览。
 */
import { Hand, Pause, Play, SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { avatarText, cx } from "./ui";

interface Bar {
	enabled: boolean;
	paused: boolean;
	active: boolean;
	last: { agent: string; avatar: string; tool: string; summary: string; outcome: string; at: number } | null;
}

export default function HostFloatBar() {
	const [b, setB] = useState<Bar | null>(null);
	const load = () => api<Bar>("/api/host-control/bar").then(setB).catch(() => {});
	useEffect(() => {
		document.documentElement.classList.add("pa-floatbar-root");
		void load();
		const t = setInterval(load, 1500);
		return () => clearInterval(t);
	}, []);
	if (!b) return null;
	const toggle = async () => (await api("/api/host-control/pause", { method: "POST", json: { paused: !b.paused } }), load());
	const text = !b.enabled ? "操作这台电脑：已关闭" : b.paused ? "已暂停：助理不能操作你的电脑" : b.last && b.active ? `${b.last.agent} 正在操作：${b.last.summary || b.last.tool}` : "助理可以操作你的电脑";
	return (
		<div className={cx("pa-floatbar", b.paused && "paused", b.active && !b.paused && "live")} data-testid="float-bar">
			<span className="pa-floatbar-dot" />
			{b.last && b.active ? <span className="pa-floatbar-av">{avatarText(b.last.avatar) || <Hand size={14} />}</span> : <Hand size={14} />}
			<span className="min-w-0 flex-1 truncate" title={text}>
				{text}
			</span>
			{b.enabled && (
				<button className="pa-floatbar-btn" onClick={toggle} data-testid="float-pause">
					{b.paused ? <Play size={13} /> : <Pause size={13} />}
					{b.paused ? "继续" : "暂停"}
				</button>
			)}
			<a className="pa-floatbar-btn ghost" href="/?settings=host" target="_blank" rel="noreferrer" aria-label="打开设置">
				<SquareArrowOutUpRight size={13} />
			</a>
		</div>
	);
}
