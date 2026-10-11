import { InboxButton } from "./Proactive";
import { Laptop, Moon, PanelLeftClose, Plus, Search, Settings as Cog, Smartphone, Sun, WifiOff } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { setAppearance, useStore } from "../store";
import { AgentEditor } from "./AgentEditor";
import { Avatar, cx, fmtTime, Modal } from "./ui";
import { BRAND } from "@pi-assistant/shared";


export default function Sidebar() {
	const { agents, current, set, system, conn, tasks, theme } = useStore();
	const [q, setQ] = useState("");
	const [creating, setCreating] = useState(false);
	const running = Object.values(tasks).flat().filter((x) => x.status === "running" || x.status === "queued").length;
	const list = agents.filter((a) => !q || a.name.includes(q) || a.description?.includes(q));
	const dark = document.documentElement.dataset.mode === "dark";
	return (
		<aside className="pa-sidebar safe-top h-full">
			<div className="pa-brand">
				<span className="pa-logo">π</span>
				<span className="pa-brand-name">{BRAND.name}</span>
				<button className="pa-icon-btn ghost pa-theme-toggle" title="切换浅色 / 深色" onClick={() => setAppearance({ theme: dark ? "light" : "dark" })} data-mode-now={theme}>
					{dark ? <Moon className="pa-ic" /> : <Sun className="pa-ic" />}
				</button>
				<button className="pa-icon-btn ghost pa-side-collapse" title="收起助理列表" aria-label="收起助理列表" onClick={() => useStore.getState().setLayout({ sideCollapsed: true })}>
					<PanelLeftClose className="pa-ic" />
				</button>
			</div>
			<button className="pa-new-btn" title={t("新建助理")} onClick={() => setCreating(true)}>
				<Plus className="pa-ic" />
				<span>{t("新建助理")}</span>
			</button>
			<label className="pa-search">
				<Search className="pa-ic" />
				<input className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-mut2" placeholder={t("搜索")} value={q} onChange={(e) => setQ(e.target.value)} />
			</label>
			<div className="pa-sec-label">我的助理</div>
			<nav className="pa-agents scrollbar-thin min-h-0 flex-1 overflow-y-auto">
				{list.map((a) => (
					<button key={a.id} onClick={() => set({ current: a.id, drawer: false })} className={cx("pa-agent", a.id === current && "active")}>
						<Avatar agentId={a.id} text={a.avatar} color={a.color} size={32} running={a.status === "running"} />
						<span className="pa-agent-txt">
							<b className="truncate">{a.name}</b>
							<small>{a.status === "running" ? "正在工作…" : a.description || (a.last?.content.replace(/[#*`>\n]/g, " ").slice(0, 40) ?? "")}</small>
						</span>
						{a.unread > 0 && a.id !== current ? <span className="pa-badge">{a.unread > 99 ? "99+" : a.unread}</span> : <span className="shrink-0 text-[11px] text-mut2">{a.last ? fmtTime(a.last.created_at) : ""}</span>}
					</button>
				))}
				{running > 0 && (
					<>
						<div className="pa-sec-label">{t("后台任务")}</div>
						<div className="px-2.5 text-xs text-mut">{running} 个任务进行中</div>
					</>
				)}
			</nav>
			<div className="pa-side-foot safe-bottom">
				<span className="pa-me">{system?.local ? <Laptop size={14} /> : <Smartphone size={14} />}</span>
				<span className="pa-me-txt">
					<b>{system?.local ? t("本机") : t("远程")}</b>
					<small>{system?.tunnel.state === "online" ? "远程访问已开启" : system?.local ? "这台电脑" : "通过远程入口"}</small>
				</span>
				<span className="pa-conn">
					{conn === "open" ? <i /> : <WifiOff size={12} className="text-amber-500" />}
					{conn === "open" ? "已连接" : "连接中…"}
				</span>
				<InboxButton />
				<button className="pa-icon-btn ghost" title={t("设置")} aria-label={t("设置")} onClick={() => set({ settings: "models" })}>
					<Cog className="pa-ic" />
				</button>
			</div>
			<NewAgent open={creating} onClose={() => setCreating(false)} />
		</aside>
	);
}

function NewAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
	return (
		<Modal open={open} onClose={onClose} title={t("新建助理")}>
			<div className="p-5">
				{open && (
					<AgentEditor
						onCancel={onClose}
						onDone={(a) => {
							void useStore.getState().selectAgent(a.id);
							onClose();
						}}
					/>
				)}
			</div>
		</Modal>
	);
}
