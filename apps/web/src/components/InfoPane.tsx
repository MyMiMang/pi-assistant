import { DesktopView } from "./DesktopView";
import { CalendarClock, ChevronLeft, Download, File, Folder, HardDrive, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, download } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import type { Attachment, ModelInfo } from "../types";
import { AuthImage } from "./Attachments";
import { AgentEditor } from "./AgentEditor";
import { Avatar, Badge, Button, cx, fmtSize, fmtTime, Input } from "./ui";

const TABS = [
	["overview", "概览"],
	["routines", "定时任务"],
	["files", "文件"],
	["computer", "电脑"],
	["settings", "设置"],
] as const;

export default function InfoPane({ agentId }: { agentId: string }) {
	const [tab, setTab] = useState<(typeof TABS)[number][0]>("overview");
	const { agents, set } = useStore();
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) return null;
	return (
		<div className="safe-top flex h-full flex-col">
			<div className="flex items-center gap-3 px-4 pt-4 pb-3">
				<Avatar agentId={agent.id} text={agent.avatar} color={agent.color} size={40} running={agent.status === "running"} />
				<div className="min-w-0 flex-1">
					<div className="truncate font-semibold">{agent.name}</div>
					<div className="text-xs text-zinc-500">{agent.status === "running" ? t("正在工作") : t("空闲")}</div>
				</div>
				<Button variant="ghost" size="icon" onClick={() => set({ info: false })} aria-label="关闭">
					<X size={18} />
				</Button>
			</div>
			<div className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-3 dark:border-zinc-800">
				{TABS.map(([k, label]) => (
					<button key={k} onClick={() => setTab(k)} className={cx("shrink-0 border-b-2 px-2.5 py-2 text-sm", tab === k ? "border-accent font-medium text-accent" : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")}>
						{t(label)}
					</button>
				))}
			</div>
			<div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
				{tab === "overview" && <Overview agentId={agentId} />}
				{tab === "routines" && (
					<div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-zinc-500">
						<CalendarClock size={28} className="text-zinc-400" />
						定时任务将在 Phase 2 推出
						<span className="text-xs">例如“每天早上 8 点给我一份摘要”</span>
					</div>
				)}
				{tab === "files" && <Files agentId={agentId} />}
				{tab === "computer" && <Computer agentId={agentId} />}
				{tab === "settings" && <AgentSettings agentId={agentId} />}
			</div>
		</div>
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
			<section className="grid grid-cols-2 gap-2">
				<Stat label="模型" value={agent.model ? agent.model.id : "未配置"} />
				<Stat label="沙箱" value={system?.sandbox.mode === "docker" ? "Docker 容器" : "工作区目录"} />
				<Stat label="输入 tokens" value={u.input.toLocaleString()} />
				<Stat label="输出 tokens" value={u.output.toLocaleString()} />
			</section>
			<section>
				<div className="mb-2 font-medium">{t("后台任务")}</div>
				{list.length === 0 && <div className="text-xs text-zinc-500">还没有后台任务</div>}
				<div className="space-y-1.5">
					{list.slice(0, 20).map((x) => (
						<div key={x.id} className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
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
const Stat = ({ label, value }: { label: string; value: string }) => (
	<div className="rounded-xl bg-zinc-50 p-3 dark:bg-zinc-900">
		<div className="text-xs text-zinc-500">{label}</div>
		<div className="mt-0.5 truncate font-medium">{value}</div>
	</div>
);

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
	return <AgentEditor agent={agent} />;
}
