import { DesktopView } from "./DesktopView";
import { ChevronLeft, Download, File, Folder, HardDrive, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, download } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import type { Attachment, ModelInfo } from "../types";
import { AuthImage } from "./Attachments";
import { AgentEditor } from "./AgentEditor";
import { MemoryTab } from "./MemoryTab";
import { AgentExtensions } from "./AgentExtensions";
import { RoutinesTab } from "./RoutinesTab";
import { Avatar, Badge, Button, cx, fmtSize, fmtTime, Input } from "./ui";

const TABS = [
	["overview", "概览"],
	["memory", "记忆"],
	["routines", "定时任务"],
	["files", "文件"],
	["computer", "电脑"],
	["settings", "设置"],
] as const;

export default function InfoPane({ agentId }: { agentId: string }) {
	const tab = useStore((s) => s.infoTab) as (typeof TABS)[number][0];
	const setTab = (k: string) => useStore.getState().set({ infoTab: k });
	const { agents, set } = useStore();
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) return null;
	return (
		<aside className="pa-pane safe-top flex h-full flex-col !gap-0 !p-0">
			<div className="flex items-center justify-end px-3 pt-3">
				<button className="pa-icon-btn ghost" onClick={() => set({ info: false })} aria-label="关闭">
					<X className="pa-ic" />
				</button>
			</div>
			<section className="pa-ov px-5 pb-4">
				<Avatar agentId={agent.id} text={agent.avatar} color={agent.color} size={64} running={agent.status === "running"} />
				<h2>{agent.name}</h2>
				<p>{agent.description || (agent.status === "running" ? t("正在工作") : t("空闲"))}</p>
			</section>
			<div className="flex gap-1 overflow-x-auto px-3" role="tablist">
				{TABS.map(([k, label]) => (
					<button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx("pa-chip sm shrink-0 !border-transparent", tab === k ? "!bg-hover !text-fg font-medium" : "!bg-transparent")}>
						{t(label)}
					</button>
				))}
			</div>
			<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6">
				{tab === "overview" && <Overview agentId={agentId} />}
				{tab === "memory" && <MemoryTab agentId={agentId} />}
				{tab === "routines" && <RoutinesTab agentId={agentId} />}
				{tab === "files" && <Files agentId={agentId} />}
				{tab === "computer" && <Computer agentId={agentId} />}
				{tab === "settings" && <AgentSettings agentId={agentId} />}
			</div>
		</aside>
	);
}

function Overview({ agentId }: { agentId: string }) {
	const { agents, tasks, system } = useStore();
	const agent = agents.find((a) => a.id === agentId)!;
	const list = tasks[agentId] ?? [];
	const [usage, setUsage] = useState<{ agent_id: string; input: number; output: number; cost: number }[]>([]);
	useEffect(() => {
		api("/api/usage").then(setUsage).catch(() => {});
	}, [agentId]);
	const u = usage.filter((x) => x.agent_id === agentId).reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output, cost: a.cost + b.cost }), { input: 0, output: 0, cost: 0 });
	return (
		<div className="space-y-5 text-sm">
			<div className="pa-stats !mt-0">
				<div>
					<b>{list.filter((x) => x.status === "done").length}</b>
					<small>完成任务</small>
				</div>
				<div>
					<b>{fmtK(u.input + u.output)}</b>
					<small>tokens</small>
				</div>
				<div>
					<b>{u.cost ? `$${u.cost.toFixed(2)}` : "—"}</b>
					<small>花费</small>
				</div>
			</div>
			<section className="pa-info">
				<div className="pa-pane-label">设置</div>
				<div className="pa-row">
					<span>模型</span>
					<b className="truncate">{agent.model ? agent.model.id : "未配置"}</b>
				</div>
				<div className="pa-row">
					<span>沙箱</span>
					<b>{system?.sandbox.mode === "docker" ? "Docker 容器" : "工作区目录"}</b>
				</div>
				<div className="pa-row">
					<span>控制本机</span>
					<b className="off">已关闭</b>
				</div>
			</section>
			<section>
				<div className="pa-pane-label">{t("后台任务")}</div>
				{list.length === 0 && <div className="text-xs text-zinc-500">还没有后台任务</div>}
				<div className="space-y-1.5">
					{list.slice(0, 20).map((x) => (
						<div key={x.id} className="flex items-center gap-2 rounded-lg bg-hover px-3 py-2">
							<span className="min-w-0 flex-1 truncate">{x.title}</span>
							<Badge tone={x.status === "done" ? "green" : x.status === "failed" ? "red" : x.status === "running" ? "accent" : "zinc"}>
								{{ queued: "排队", running: "进行中", done: "完成", failed: "失败", cancelled: "取消" }[x.status] ?? x.status}
							</Badge>
						</div>
					))}
				</div>
			</section>
		</div>
	);
}
const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function Files({ agentId }: { agentId: string }) {
	const fileVersion = useStore((s) => s.fileVersion);
	const [files, setFiles] = useState<Attachment[]>([]);
	useEffect(() => {
		api(`/api/agents/${agentId}/files`).then(setFiles).catch(() => {});
	}, [agentId, fileVersion]);
	const images = files.filter((f) => f.mime.startsWith("image/") && f.mime !== "image/svg+xml");
	return (
		<div className="space-y-4">
			{images.length > 0 && (
				<div className="grid grid-cols-3 gap-1.5">
					{images.map((f) => (
						<AuthImage key={f.fileId} path={`/api/files/${f.fileId}?inline=1`} alt={f.name} className="aspect-square w-full rounded-lg object-cover" />
					))}
				</div>
			)}
			<div className="space-y-1">
				{files.length === 0 && <div className="text-sm text-zinc-500">还没有文件。助理发给你的文件和你上传的文件都会出现在这里。</div>}
				{files.map((f) => (
					<button key={f.fileId} onClick={() => download(`/api/files/${f.fileId}`, f.name)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
						<File size={16} className="shrink-0 text-zinc-400" />
						<span className="min-w-0 flex-1 truncate">{f.name}</span>
						<Badge>{f.direction === "in" ? "上传" : "交付"}</Badge>
						<span className="text-xs text-zinc-400">{fmtSize(f.size)}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function Computer({ agentId }: { agentId: string }) {
	const { system, agents, fileVersion } = useStore();
	const agent = agents.find((a) => a.id === agentId)!;
	const [path, setPath] = useState("");
	const [entries, setEntries] = useState<{ name: string; dir: boolean; size: number; mtime: number }[]>([]);
	useEffect(() => {
		api(`/api/agents/${agentId}/workspace?path=${encodeURIComponent(path)}`).then(setEntries).catch(() => setEntries([]));
	}, [agentId, path, fileVersion]);
	return (
		<div className="space-y-3 text-sm">
			<DesktopView agentId={agentId} />
			<div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-900">
				<div className="flex items-center gap-2 font-medium">
					<HardDrive size={16} /> 工作区
				</div>
				<div className="mt-1 text-xs text-zinc-500">
					{system?.sandbox.mode === "docker" ? "Docker 容器（增强隔离）" : "工作区目录（基础模式，靠审批兜底）"}
					<br />
					<code className="break-all">{agent.workspace}</code>
				</div>
			</div>
			<div className="flex items-center gap-1 text-xs text-zinc-500">
				{path && (
					<button onClick={() => setPath(path.split("/").slice(0, -1).join("/"))} className="rounded p-1 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="返回上级">
						<ChevronLeft size={14} />
					</button>
				)}
				<span>/{path}</span>
			</div>
			<div className="space-y-0.5">
				{entries.length === 0 && <div className="text-xs text-zinc-500">空目录</div>}
				{entries.map((e) => (
					<button
						key={e.name}
						onClick={() => (e.dir ? setPath(path ? `${path}/${e.name}` : e.name) : download(`/api/agents/${agentId}/workspace/file?path=${encodeURIComponent(path ? `${path}/${e.name}` : e.name)}`, e.name))}
						className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
					>
						{e.dir ? <Folder size={15} className="text-accent" /> : <File size={15} className="text-zinc-400" />}
						<span className="min-w-0 flex-1 truncate">{e.name}</span>
						{!e.dir && (
							<>
								<span className="text-xs text-zinc-400">{fmtSize(e.size)}</span>
								<Download size={13} className="text-zinc-400" />
							</>
						)}
						{e.dir && <span className="text-xs text-zinc-400">{fmtTime(e.mtime)}</span>}
					</button>
				))}
			</div>
		</div>
	);
}

function AgentSettings({ agentId }: { agentId: string }) {
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	if (!agent) return null;
	return (
		<div className="space-y-6">
			<AgentEditor agent={agent} />
			<AgentExtensions agentId={agentId} />
		</div>
	);
}
