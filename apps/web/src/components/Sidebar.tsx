import { InboxButton } from "./Proactive";
import { Laptop, Moon, Pencil, Trash2, PanelLeftClose, Plus, Search, Settings as Cog, Smartphone, Sun, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { t } from "../i18n";
import { setAppearance, useStore } from "../store";
import { AgentEditor } from "./AgentEditor";
import { Avatar, Button, cx, fmtTime, Modal } from "./ui";
import { BRAND } from "@pi-assistant/shared";


export default function Sidebar() {
	const { agents, current, set, system, conn, tasks, theme } = useStore();
	const [q, setQ] = useState("");
	const [creating, setCreating] = useState(false);
	const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
	const [del, setDel] = useState<string | null>(null);
	const press = useRef<{ t: number; fired: boolean } | null>(null);
	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		const key = (e: KeyboardEvent) => e.key === "Escape" && close();
		window.addEventListener("pointerdown", close);
		window.addEventListener("resize", close);
		window.addEventListener("keydown", key);
		return () => (window.removeEventListener("pointerdown", close), window.removeEventListener("resize", close), window.removeEventListener("keydown", key));
	}, [menu]);
	const openMenu = (id: string, x: number, y: number) => setMenu({ id, x: Math.min(x, window.innerWidth - 180), y: Math.min(y, window.innerHeight - 100) });
	const running = Object.values(tasks).flat().filter((x) => x.status === "running" || x.status === "queued").length;
	const list = agents.filter((a) => !q || a.name.includes(q) || a.description?.includes(q));
	const dark = document.documentElement.dataset.mode === "dark";
	return (
		<aside className="pa-sidebar safe-top h-full">
			<div className="pa-brand">
				<img className="pa-logo" src="/icon.svg" alt="" />
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
					<button
						key={a.id}
						data-testid="sidebar-agent"
						onClick={() => {
							if (press.current?.fired) return void (press.current = null);
							set({ current: a.id, drawer: false });
						}}
						onContextMenu={(e) => {
							e.preventDefault();
							if (press.current?.fired) return;
							openMenu(a.id, e.clientX, e.clientY);
						}}
						onPointerDown={(e) => {
							if (e.pointerType === "mouse") return;
							const { clientX, clientY } = e;
							const st = { t: 0, fired: false };
							st.t = window.setTimeout(() => {
								st.fired = true;
								navigator.vibrate?.(10);
								openMenu(a.id, clientX, clientY);
							}, 500);
							press.current = st;
						}}
						onPointerMove={(e) => e.pointerType !== "mouse" && press.current && !press.current.fired && (clearTimeout(press.current.t), (press.current = null))}
						onPointerUp={() => press.current && !press.current.fired && (clearTimeout(press.current.t), (press.current = null))}
						onPointerCancel={() => press.current && (clearTimeout(press.current.t), (press.current = null))}
						style={{ WebkitTouchCallout: "none", userSelect: "none" }}
						className={cx("pa-agent", a.id === current && "active")}
					>
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
			{menu && createPortal(
				<div
					role="menu"
					data-testid="agent-menu"
					className="fixed z-50 min-w-40 rounded-lg border border-line bg-panel p-1 text-sm shadow-lg"
					style={{ left: menu.x, top: menu.y }}
					onPointerDown={(e) => e.stopPropagation()}
				>
					<button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left hover:bg-hover" onClick={() => {
						void useStore.getState().selectAgent(menu.id);
						set({ info: true, infoTab: "settings", drawer: false });
						setMenu(null);
					}}>
						<Pencil size={14} /> 编辑
					</button>
					<button role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-red-600 hover:bg-hover" onClick={() => (setDel(menu.id), setMenu(null))}>
						<Trash2 size={14} /> 删除助理
					</button>
				</div>,
				document.body,
			)}
			<DeleteAgent id={del} onClose={() => setDel(null)} />
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

function DeleteAgent({ id, onClose }: { id: string | null; onClose: () => void }) {
	const agent = useStore((s) => s.agents.find((a) => a.id === id));
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const go = async () => {
		if (!id) return;
		setBusy(true);
		setErr("");
		try {
			await api(`/api/agents/${id}`, { method: "DELETE" });
			const s = useStore.getState();
			const wasCurrent = s.current === id;
			await s.loadAgents();
			if (wasCurrent) {
				const next = useStore.getState().agents[0];
				if (next) s.selectAgent(next.id);
				else s.set({ current: null });
			}
			onClose();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open={!!id} onClose={onClose} title={`删除助理「${agent?.name ?? ""}」？`} testId="delete-agent-dialog">
			<div className="space-y-4 p-5 text-sm">
				<p>它的对话、定时任务和记忆会一起清掉；它的文件和工作区会先挪进回收站，删错了还能找回来。</p>
				{err && <p className="text-red-600">{err}</p>}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>取消</Button>
					<Button variant="danger" disabled={busy} onClick={go} data-testid="confirm-delete-agent">确认删除</Button>
				</div>
			</div>
		</Modal>
	);
}
