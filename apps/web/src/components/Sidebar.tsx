import { Laptop, Plus, Search, Settings as Cog, Smartphone, Wifi, WifiOff } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import { Avatar, Button, cx, fmtTime, Input, Modal } from "./ui";

const COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6"];

export default function Sidebar() {
	const { agents, current, set, system, conn, tasks } = useStore();
	const [q, setQ] = useState("");
	const [creating, setCreating] = useState(false);
	const running = Object.values(tasks).flat().filter((x) => x.status === "running" || x.status === "queued").length;
	const list = agents.filter((a) => !q || a.name.includes(q));
	return (
		<div className="safe-top flex h-full flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
			<div className="flex items-center gap-2 px-4 pt-4 pb-3">
				<img src="/icon-192.png" className="h-8 w-8 rounded-lg" alt="" />
				<div className="flex-1 text-[15px] font-semibold">胡好好</div>
				<Button variant="ghost" size="icon" title={t("新建助理")} onClick={() => setCreating(true)}>
					<Plus size={18} />
				</Button>
			</div>
			<div className="px-3 pb-2">
				<div className="relative">
					<Search size={15} className="absolute top-2.5 left-2.5 text-zinc-400" />
					<Input placeholder={t("搜索")} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
				</div>
			</div>
			<div className="px-4 pt-2 pb-1 text-xs font-medium tracking-wide text-zinc-400 uppercase">{t("助理")}</div>
			<nav className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2">
				{list.map((a) => (
					<button
						key={a.id}
						onClick={() => set({ current: a.id, drawer: false })}
						className={cx("flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition", a.id === current ? "bg-white shadow-sm dark:bg-zinc-800" : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60")}
					>
						<Avatar text={a.avatar} color={a.color} running={a.status === "running"} />
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="truncate text-sm font-medium">{a.name}</span>
								<span className="ml-auto shrink-0 text-[11px] text-zinc-400">{a.last ? fmtTime(a.last.created_at) : ""}</span>
							</div>
							<div className="flex items-center gap-2">
								<span className="truncate text-xs text-zinc-500">{a.status === "running" ? "正在工作…" : (a.last?.content.replace(/[#*`>\n]/g, " ").slice(0, 40) ?? "")}</span>
								{a.unread > 0 && a.id !== current && <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-medium text-white">{a.unread > 99 ? "99+" : a.unread}</span>}
							</div>
						</div>
					</button>
				))}
				{running > 0 && (
					<>
						<div className="px-2 pt-4 pb-1 text-xs font-medium tracking-wide text-zinc-400 uppercase">{t("后台任务")}</div>
						<div className="px-2.5 text-xs text-zinc-500">{running} 个任务进行中</div>
					</>
				)}
			</nav>
			<div className="safe-bottom border-t border-zinc-200 p-2 dark:border-zinc-800">
				<div className="flex items-center gap-2 px-2 py-1.5 text-xs text-zinc-500">
					{conn === "open" ? <Wifi size={14} className="text-emerald-500" /> : <WifiOff size={14} className="text-amber-500" />}
					{system?.local ? <Laptop size={14} /> : <Smartphone size={14} />}
					<span>{system?.local ? t("本机") : t("远程")}</span>
					<span>·</span>
					<span>{conn === "open" ? "已连接" : "连接中…"}</span>
					{system?.tunnel.state === "online" && <span className="ml-auto text-emerald-600">远程已开启</span>}
				</div>
				<Button variant="ghost" className="w-full justify-start" onClick={() => set({ settings: "models" })}>
					<Cog size={16} /> {t("设置")}
				</Button>
			</div>
			<NewAgent open={creating} onClose={() => setCreating(false)} />
		</div>
	);
}

function NewAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
	const [name, setName] = useState("");
	const [persona, setPersona] = useState("");
	const [color, setColor] = useState(COLORS[1]);
	const create = async () => {
		const a = await api("/api/agents", { method: "POST", json: { name: name || "新助理", persona, color, avatar: (name || "新").slice(0, 1) } });
		useStore.getState().set({ current: a.id });
		await useStore.getState().loadAgents();
		setName("");
		setPersona("");
		onClose();
	};
	return (
		<Modal open={open} onClose={onClose} title={t("新建助理")}>
			<div className="space-y-4 p-5">
				<div className="flex items-center gap-3">
					<Avatar text={(name || "新").slice(0, 1)} color={color} size={48} />
					<Input placeholder="名字，例如：写作助理" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
				</div>
				<div className="flex gap-2">
					{COLORS.map((c) => (
						<button key={c} onClick={() => setColor(c)} className={cx("h-7 w-7 rounded-full ring-offset-2 dark:ring-offset-zinc-900", c === color && "ring-2 ring-zinc-400")} style={{ background: c }} />
					))}
				</div>
				<textarea
					className="h-24 w-full rounded-lg border border-zinc-300 bg-white p-3 text-sm outline-none focus:border-accent dark:border-zinc-700 dark:bg-zinc-900"
					placeholder="人设与偏好（可选）：例如“你擅长中文写作，回答简洁”"
					value={persona}
					onChange={(e) => setPersona(e.target.value)}
				/>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						{t("取消")}
					</Button>
					<Button variant="primary" onClick={create}>
						创建
					</Button>
				</div>
			</div>
		</Modal>
	);
}
