import { SubagentModels } from "./Subagents";
import { TaskRow, taskTitle } from "./Tasks";
import { DesktopView } from "./DesktopView";
import { fmtMoney, useFx } from "./usage-fmt";
import { ChevronLeft, ChevronRight, Cpu, Download, File, Folder, HardDrive, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, download } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import type { Attachment } from "../types";
import { AuthImage } from "./Attachments";
import { openFilePreview } from "./FilePreview";
import { openImageViewer } from "./ImageViewer";
import { AgentEditor } from "./AgentEditor";
import { ModelPicker, THINKING_LABEL, useConfiguredModels } from "./ModelPicker";
import { AgentComputer } from "./AgentComputer";
import { AgentImageModel } from "./ImageModels";
import { MemoryTab } from "./MemoryTab";
import { AgentExtensions } from "./AgentExtensions";
import { AgentSkills } from "./AgentSkills";
import { AgentHostTier } from "./HostControl";
import { ResponsiveTabs } from "./ResponsiveTabs";
import { RoutinesTab } from "./RoutinesTab";
import { ProactiveTab } from "./Proactive";
import { Avatar, Badge, fmtSize, fmtTime, Help } from "./ui";
import { RoomAgentActions } from "./RoomCards";

const TABS = [
	["overview", "概览"],
	["models", "模型"],
	["profile", "资料"],
	["capabilities", "能力"],
	["tasks", "任务"],
	["memory", "记忆"],
	["files", "文件"],
	["computer", "电脑"],
] as const;
const TASK_TABS = [["background", "后台任务"], ["routines", "定时任务"], ["proactive", "主动跟进"]] as const;

export default function InfoPane({ agentId }: { agentId: string }) {
	const rawTab = useStore((s) => s.infoTab);
	// 兼容旧内部跳转，不让曾经打开的标签变成空页。
	const tab = rawTab === "settings" ? "profile" : rawTab === "routines" || rawTab === "proactive" ? "tasks" : TABS.some(([k]) => k === rawTab) ? rawTab : "overview";
	const setTab = (k: string) => useStore.getState().set({ infoTab: k });
	const { agents, set, loadTasks } = useStore();
	// 首次打开资料才建草稿，之后切分类保留；不提前捕获尚未编辑的旧资料。
	const [profileFor, setProfileFor] = useState<string | null>(null);
	useEffect(() => { if (tab === "profile") setProfileFor(agentId); }, [tab, agentId]);
	useEffect(() => { void loadTasks(agentId).catch(() => {}); }, [agentId, loadTasks]);
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) return null;
	return (
		<aside className="pa-pane safe-top flex h-full flex-col !gap-0 !p-0">
			<div className="flex items-center justify-end px-3 pt-3">
				<button className="pa-icon-btn ghost" onClick={() => set({ info: false })} aria-label="关闭">
					<X className="pa-ic" />
				</button>
			</div>
			<section className="flex min-w-0 shrink-0 items-center gap-3 px-4 pb-4" data-testid="agent-info-heading">
				<Avatar agentId={agent.id} text={agent.avatar} color={agent.color} size={44} running={agent.status === "running"} />
				<div className="min-w-0 flex-1">
					<h2 className="line-clamp-2 break-words text-base font-semibold">{agent.name}</h2>
					<p className="line-clamp-2 whitespace-normal break-words text-xs text-mut" title={agent.description}>{agent.description || (agent.status === "running" ? t("正在工作") : t("空闲"))}</p>
				</div>
			</section>
			<RoomAgentActions key={agent.id} agentId={agent.id} />
			<ResponsiveTabs tabs={TABS} value={tab} onChange={setTab} className="px-3" testId="info-tabs" />
			<div className={tab === "profile" ? "hidden" : "scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6"} hidden={tab === "profile"} data-testid="agent-info-content" key={`${agentId}:${tab}`}>
				{tab === "overview" && <Overview agentId={agentId} />}
				{tab === "models" && <AgentModels agentId={agentId} />}
				{tab === "capabilities" && <div className="space-y-6 text-sm"><AgentSkills agentId={agentId} /><AgentExtensions agentId={agentId} /></div>}
				{tab === "tasks" && <AgentTasks key={agentId} agentId={agentId} legacyTab={rawTab} />}
				{tab === "memory" && <MemoryTab agentId={agentId} />}
				{tab === "files" && <Files agentId={agentId} />}
				{tab === "computer" && <Computer key={agentId} agentId={agentId} />}
			</div>
			{/* 同一助理切分类保持资料草稿；换助理或关闭面板才结束当前编辑。 */}
			{(tab === "profile" || profileFor === agentId) && <div key={agentId} className={tab === "profile" ? "scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6" : "hidden"} data-testid="agent-info-profile" hidden={tab !== "profile"}>
				<AgentEditor agent={agent} showModel={false} />
			</div>}
		</aside>
	);
}

function Overview({ agentId }: { agentId: string }) {
	const { agents, tasks } = useStore();
	const agent = agents.find((a) => a.id === agentId)!;
	const list = tasks[agentId] ?? [];
	const fx = useFx();
	const catalog = useConfiguredModels();
	const model = catalog.models.find((m) => m.provider === agent.model?.provider && m.id === agent.model?.id);
	const effective = agent.thinking ? THINKING_LABEL[agent.thinking] ?? agent.thinking : "待确认";
	const thinking = !model
		? catalog.loading ? "正在加载档位…" : catalog.error ? "档位加载失败" : "请重新选择模型"
		: !model.thinking?.length ? "该模型无思考强度"
		: agent.thinkingSetting == null ? `跟随默认 · ${effective}`
		: agent.thinkingSetting !== agent.thinking ? `${THINKING_LABEL[agent.thinkingSetting] ?? agent.thinkingSetting} → ${effective}` : effective;
	const [u, setU] = useState<{ calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; unknownCalls: number }>({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 });
	useEffect(() => {
		api<{ totals: typeof u }>(`/api/usage/summary?range=all&agent=${encodeURIComponent(agentId)}`).then((r) => setU(r.totals)).catch(() => {});
	}, [agentId]);
	return (
		<div className="space-y-5 text-sm">
			<button type="button" className="flex w-full min-w-0 items-center gap-3 rounded-xl border border-line p-3 text-left hover:bg-hover" data-testid="overview-model-settings" onClick={() => useStore.getState().set({ infoTab: "models" })}>
				<Cpu size={18} className="shrink-0 text-mut" />
				<span className="min-w-0 flex-1">
					<span className="block text-xs text-mut">模型与思考强度</span>
					<span className="block whitespace-normal break-words text-sm">{model?.name ?? agent.model?.id ?? "未选择模型"}</span>
					<span className="block whitespace-normal break-words text-xs text-mut2">{thinking}{agent.fast ? " · Fast 已开启" : ""}</span>
				</span>
				<ChevronRight size={16} className="shrink-0 text-mut" />
			</button>
			<div className="pa-stats !mt-0">
				<div>
					<b>{list.filter((x) => x.status === "done").length}</b>
					<small>完成任务</small>
				</div>
				<div>
					<b>{fmtK(u.input + u.cacheRead + u.cacheWrite + u.output)}</b>
					<small>tokens</small>
				</div>
				<div>
					<b>{u.calls && u.unknownCalls < u.calls ? fmtMoney(u.cost, fx) : "—"}</b>
					<small>花费</small>
				</div>
			</div>
			<button type="button" className="flex w-full items-center justify-between gap-2 rounded-xl border border-line p-3 text-left text-sm hover:bg-hover" onClick={() => useStore.getState().set({ infoTab: "tasks", infoTaskTab: "background" })}>
				<span>后台任务<span className="ml-2 text-mut">{list.filter((x) => x.status === "running").length} 个运行中 · {list.length} 个任务</span></span><ChevronRight size={16} className="shrink-0 text-mut" />
			</button>
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
						<AuthImage
							key={f.fileId}
							path={`/api/files/${f.fileId}?inline=1`}
							alt={f.name}
							className="aspect-square w-full cursor-zoom-in rounded-lg object-cover"
							onClick={() => openImageViewer({ authPath: `/api/files/${f.fileId}?inline=1`, alt: f.name, name: f.name, downloadPath: `/api/files/${f.fileId}` })}
						/>
					))}
				</div>
			)}
			<div className="space-y-1">
				{files.length === 0 && <div className="text-sm text-zinc-500">还没有文件。</div>}
				{files.map((f) => (
					<div key={f.fileId} className="flex items-center gap-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
						<button
							type="button"
							onClick={() => openFilePreview({ name: f.name, mime: f.mime, size: f.size, url: `/api/files/${f.fileId}`, downloadPath: `/api/files/${f.fileId}` })}
							className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left text-sm"
							title={`预览 ${f.name}`}
							aria-label={`预览 ${f.name}`}
							data-testid="info-file-open"
						>
							<File size={16} className="shrink-0 text-zinc-400" />
							<span className="min-w-0 flex-1 truncate">{f.name}</span>
							<Badge>{f.direction === "in" ? "上传" : "交付"}</Badge>
							<span className="text-xs text-zinc-400">{fmtSize(f.size)}</span>
						</button>
						<button
							type="button"
							className="pa-icon-btn ghost !h-7 !w-7 shrink-0"
							onClick={() => void download(`/api/files/${f.fileId}`, f.name)}
							title={`下载 ${f.name}`}
							aria-label={`下载 ${f.name}`}
							data-testid="info-file-download"
						>
							<Download size={14} />
						</button>
					</div>
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
		<div className="space-y-5 text-sm">
			<AgentHostTier agentId={agentId} />
			<section className="space-y-3 border-t border-line pt-4">
				<h3 className="text-sm font-semibold">助理电脑</h3>
				<AgentComputer agentId={agentId} />
				<DesktopView agentId={agentId} />
			</section>
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

function AgentModels({ agentId }: { agentId: string }) {
	return (
		<div className="space-y-5 text-sm" data-testid="agent-models-tab">
			<section className="min-w-0 space-y-3 rounded-xl border border-line p-3" data-testid="member-model-settings">
				<div className="flex items-center gap-1.5 font-semibold">对话模型<Help>同一助理的私聊和群聊共用。这里的模型、思考强度和 Fast 立即保存，后续请求生效；不会中断已经发出的请求。</Help></div>
				<ModelPicker agentId={agentId} buttonClass="max-w-full" allowThinkingFollow layout="settings" />
				<p className="text-xs text-mut2">立即保存，后续请求生效；私聊和群聊共用。</p>
			</section>
			<div className="border-t border-line pt-4"><AgentImageModel agentId={agentId} /></div>
			<div className="border-t border-line pt-4"><SubagentModels agentId={agentId} /></div>
		</div>
	);
}

function AgentTasks({ agentId, legacyTab }: { agentId: string; legacyTab: string }) {
	const selected = useStore((s) => s.infoTaskTab);
	const tab = legacyTab === "routines" || legacyTab === "proactive" ? legacyTab : selected;
	const list = useStore((s) => s.tasks[agentId]) ?? [];
	return <div className="space-y-4 text-sm" data-testid="agent-tasks-tab">
		<ResponsiveTabs tabs={TASK_TABS} value={tab} testId="agent-task-tabs" onChange={(k) => useStore.getState().set({ infoTab: "tasks", infoTaskTab: k as typeof selected })} />
		{tab === "routines" && <RoutinesTab agentId={agentId} />}
		{tab === "proactive" && <ProactiveTab agentId={agentId} />}
		{tab === "background" && <section className="space-y-2" data-testid="agent-background-tasks">
			{!list.length && <p className="text-sm text-mut">还没有后台任务。</p>}
			{list.slice(0, 20).map((x) => <TaskRow key={x.id} title={x.title || taskTitle(x.instructions)} status={x.status} />)}
		</section>}
	</div>;
}
