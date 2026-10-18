import { SubagentModels } from "./Subagents";
import { TaskRow, taskStatus, taskTitle, timeAgo } from "./Tasks";
import { DesktopView } from "./DesktopView";
import { fmtMoney, useFx } from "./usage-fmt";
import { ChevronLeft, ChevronRight, Download, File, Folder, HardDrive, Pause, Play, X } from "lucide-react";
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
import { AgentHostTier, TIER_INFO, useHostControl, type Tier } from "./HostControl";
import { ResponsiveTabs } from "./ResponsiveTabs";
import { RoutinesTab } from "./RoutinesTab";
import { ProactiveTab } from "./Proactive";
import { Avatar, Button, fmtSize, fmtTime } from "./ui";
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
const TASK_TABS = [["background", "执行记录"], ["routines", "定时任务"], ["proactive", "主动跟进"]] as const;

/**
 * 助理设置（classic）：居中 64px 头像 + 单行文字分类；单聊与群成员共用同一套结构。
 * 群专属信息 / 私聊 / 复制入口沿用原组件（普通助理不显示群信息框）。
 * 资料页保留独立草稿与固定底部「保存资料」；其余分类都是即时保存的真实设置。
 */
export default function InfoPane({ agentId }: { agentId: string }) {
	const rawTab = useStore((s) => s.infoTab);
	// 兼容旧内部跳转，不让曾经打开的标签变成空页。
	const tab = rawTab === "settings" ? "profile" : rawTab === "routines" || rawTab === "proactive" ? "tasks" : TABS.some(([k]) => k === rawTab) ? rawTab : "overview";
	const setTab = (k: string) => useStore.getState().set({ infoTab: k });
	const { agents, loadTasks } = useStore();
	// 首次打开资料才建草稿，之后切分类保留；不提前捕获尚未编辑的旧资料。
	const [profileFor, setProfileFor] = useState<string | null>(null);
	useEffect(() => { if (tab === "profile") setProfileFor(agentId); }, [tab, agentId]);
	useEffect(() => { void loadTasks(agentId).catch(() => {}); }, [agentId, loadTasks]);
	const agent = agents.find((a) => a.id === agentId);
	if (!agent) return null;
	return (
		<aside className="pa-pane pa-info flex h-full flex-col !gap-0 !p-0">
			<button className="pa-icon-btn ghost pa-info-close" onClick={() => useStore.getState().set({ info: false })} aria-label="关闭">
				<X className="pa-ic" />
			</button>
			<header className="pa-info-head">
				<div className="pa-info-identity" data-testid="agent-info-heading">
					<Avatar agentId={agent.id} text={agent.avatar} color={agent.color} size={64} running={agent.status === "running"} testId="agent-info-avatar" />
					<h2 className="pa-info-name">{agent.name}</h2>
					<p className={agent.description ? "pa-info-desc" : "pa-info-desc muted"} title={agent.description}>
						{agent.description || (agent.status === "running" ? t("正在工作") : t("空闲"))}
					</p>
				</div>
				<RoomAgentActions key={agent.id} agentId={agent.id} variant="pane" />
			</header>
			<ResponsiveTabs tabs={TABS} value={tab} onChange={setTab} variant="plain" className="pa-info-tabs" testId="info-tabs" />
			<div className={tab === "profile" ? "hidden" : "pa-info-body scrollbar-thin min-h-0 flex-1 overflow-y-auto"} hidden={tab === "profile"} data-testid="agent-info-content" key={`${agentId}:${tab}`}>
				{tab === "overview" && <Overview agentId={agentId} />}
				{tab === "models" && <AgentModels agentId={agentId} />}
				{tab === "capabilities" && <Capabilities agentId={agentId} />}
				{tab === "tasks" && <AgentTasks key={agentId} agentId={agentId} legacyTab={rawTab} />}
				{tab === "memory" && <MemoryTab agentId={agentId} />}
				{tab === "files" && <Files agentId={agentId} />}
				{tab === "computer" && <Computer key={agentId} agentId={agentId} />}
			</div>
			{/* 同一助理切分类保持资料草稿；换助理或关闭面板才结束当前编辑。 */}
			{(tab === "profile" || profileFor === agentId) && (
				<div key={agentId} className={tab === "profile" ? "flex min-h-0 flex-1 flex-col" : "hidden"} hidden={tab !== "profile"} data-testid="agent-info-profile">
					<AgentEditor agent={agent} showModel={false} layout="profile" />
				</div>
			)}
		</aside>
	);
}

/** 概览：先看真实执行统计，再看配置摘要（点击去对应分类）和已有任务，不在这里再放一套模型编辑器。 */
function Overview({ agentId }: { agentId: string }) {
	const { agents, tasks } = useStore();
	const agent = agents.find((a) => a.id === agentId)!;
	const list = tasks[agentId] ?? [];
	const fx = useFx();
	const catalog = useConfiguredModels();
	const host = useHostControl();
	const model = catalog.models.find((m) => m.provider === agent.model?.provider && m.id === agent.model?.id);
	const effective = agent.thinking ? THINKING_LABEL[agent.thinking] ?? agent.thinking : "待确认";
	const thinking = !model
		? catalog.loading ? "正在加载档位…" : catalog.error ? "档位加载失败" : "请重新选择模型"
		: !model.thinking?.length ? "该模型无思考强度"
		: agent.thinkingSetting == null ? `跟随默认 · ${effective}`
		: agent.thinkingSetting !== agent.thinking ? `${THINKING_LABEL[agent.thinkingSetting] ?? agent.thinkingSetting} → ${effective}` : effective;
	const allowed = !!host.d && (host.d.settings.agents === "all" || host.d.settings.agents.includes(agentId));
	const tier = (host.d?.tiers?.[agentId] ?? host.d?.settings.defaultTier ?? "bounded") as Tier;
	const hostText = !host.d
		? host.err ? "状态读取失败" : "正在读取…"
		: !host.d.status.enabled ? "未开启"
			: !allowed ? "未授权本助理"
				: host.d.status.paused ? "已暂停" : TIER_INFO[tier].label;
	const done = list.filter((x) => x.status === "done").length;
	const running = list.filter((x) => x.status === "running").length;
	const [u, setU] = useState<{ calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; unknownCalls: number }>({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknownCalls: 0 });
	useEffect(() => {
		api<{ totals: typeof u }>(`/api/usage/summary?range=all&agent=${encodeURIComponent(agentId)}`).then((r) => setU(r.totals)).catch(() => {});
	}, [agentId]);
	const go = (next: string) => useStore.getState().set({ infoTab: next });
	return (
		<div className="text-sm" data-testid="agent-overview">
			<div className="pa-stats">
				<div>
					<b>{done}</b>
					<small>完成执行</small>
				</div>
				<div>
					<b>{fmtK(u.input + u.cacheRead + u.cacheWrite + u.output)}</b>
					<small>Token</small>
				</div>
				<div>
					<b>{u.calls && u.unknownCalls < u.calls ? fmtMoney(u.cost, fx) : "—"}</b>
					<small>花费</small>
				</div>
			</div>
			<h2 className="pa-info-h2">配置摘要</h2>
			<button type="button" className="pa-info-row" data-testid="overview-model-settings" onClick={() => go("models")}>
				<span className="pa-info-row-main"><strong>聊天模型</strong><small>{model?.name ?? agent.model?.id ?? "未选择模型"}{model?.providerName ? ` · ${model.providerName}` : ""}</small></span>
				<ChevronRight size={16} className="pa-arrow" />
			</button>
			<button type="button" className="pa-info-row" onClick={() => go("models")}>
				<span className="pa-info-row-main"><strong>思考强度</strong></span>
				<span className="pa-info-row-value">{thinking}</span>
				<ChevronRight size={16} className="pa-arrow" />
			</button>
			<button type="button" className="pa-info-row" onClick={() => go("computer")}>
				<span className="pa-info-row-main"><strong>你的电脑</strong><small>本助理的操作权限与暂停状态</small></span>
				<span className="pa-info-row-value">{hostText}</span>
				<ChevronRight size={16} className="pa-arrow" />
			</button>
			<h2 className="pa-info-h2">后台任务</h2>
			{list.length === 0 && <p className="text-xs text-mut2">还没有后台任务。执行结束后仍需核验结果是否达到原任务目标。</p>}
			{list.slice(0, 2).map((x) => {
				const st = taskStatus(x.status);
				return (
					<button key={x.id} type="button" className="pa-info-row" onClick={() => useStore.getState().set({ infoTab: "tasks", infoTaskTab: "background" })}>
						<span className="pa-info-row-main">
							<strong>{x.title || taskTitle(x.instructions)}</strong>
							<small>{st.label}{x.finished_at ?? x.created_at ? ` · ${timeAgo(x.finished_at ?? x.created_at)}` : ""}</small>
						</span>
						<ChevronRight size={16} className="pa-arrow" />
					</button>
				);
			})}
			{list.length > 2 && (
				<button type="button" className="pa-info-row" onClick={() => useStore.getState().set({ infoTab: "tasks", infoTaskTab: "background" })}>
					<span className="pa-info-row-main"><strong>全部 {list.length} 个任务</strong><small>{running} 个运行中</small></span>
					<ChevronRight size={16} className="pa-arrow" />
				</button>
			)}
		</div>
	);
}
const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** 文件：按「你上传 / 助理交付」分组，图片与文档都能真实预览、下载；长文件名换行可读。 */
function Files({ agentId }: { agentId: string }) {
	const fileVersion = useStore((s) => s.fileVersion);
	const [files, setFiles] = useState<Attachment[]>([]);
	useEffect(() => {
		api(`/api/agents/${agentId}/files`).then(setFiles).catch(() => {});
	}, [agentId, fileVersion]);
	const groups = [
		{ key: "in" as const, label: "你上传" },
		{ key: "out" as const, label: "助理交付" },
	];
	const isImage = (f: Attachment) => f.mime.startsWith("image/") && f.mime !== "image/svg+xml";
	return (
		<div className="space-y-1" data-testid="agent-files">
			{files.length === 0 && <p className="py-8 text-center text-sm text-mut">还没有文件。你上传的文件和助理交付的成果会显示在这里。</p>}
			{groups.map((g) => {
				const items = files.filter((f) => (f.direction === "in" ? "in" : "out") === g.key);
				if (!items.length) return null;
				const images = items.filter(isImage);
				const docs = items.filter((f) => !isImage(f));
				return (
					<section key={g.key}>
						<h2 className="pa-info-h2">{g.label} · {items.length} 个</h2>
						{images.length > 0 && (
							<div className="mb-2 grid grid-cols-2 gap-2">
								{images.map((f) => (
									<button key={f.fileId} type="button" className="block w-full overflow-hidden rounded-lg border border-line" onClick={() => openImageViewer({ authPath: `/api/files/${f.fileId}?inline=1`, alt: f.name, name: f.name, downloadPath: `/api/files/${f.fileId}` })} aria-label={`预览 ${f.name}`}>
										<AuthImage path={`/api/files/${f.fileId}?inline=1`} alt={f.name} className="aspect-[4/3] w-full cursor-zoom-in object-cover" />
									</button>
								))}
							</div>
						)}
						{docs.map((f) => (
							<div key={f.fileId} className="flex items-center gap-1 border-b border-line last:border-b-0">
								<button
									type="button"
									onClick={() => openFilePreview({ name: f.name, mime: f.mime, size: f.size, url: `/api/files/${f.fileId}`, downloadPath: `/api/files/${f.fileId}` })}
									className="flex min-w-0 flex-1 items-start gap-2.5 whitespace-normal py-2.5 text-left text-sm"
									title={`预览 ${f.name}`}
									aria-label={`预览 ${f.name}`}
									data-testid="info-file-open"
								>
									<File size={16} className="mt-0.5 shrink-0 text-mut2" />
									<span className="min-w-0 flex-1">
										<span className="block break-words [overflow-wrap:anywhere]">{f.name}</span>
										<span className="block text-xs text-mut2">{f.mime.split("/").pop()?.toUpperCase() ?? "文件"} · {fmtSize(f.size)}</span>
									</span>
								</button>
								<button
									type="button"
									className="pa-icon-btn ghost !h-8 !w-8 shrink-0"
									onClick={() => void download(`/api/files/${f.fileId}`, f.name)}
									title={`下载 ${f.name}`}
									aria-label={`下载 ${f.name}`}
									data-testid="info-file-download"
								>
									<Download size={14} />
								</button>
							</div>
						))}
					</section>
				);
			})}
		</div>
	);
}

/** 电脑：你的电脑（真实档位 / 暂停 / 全局设置）与助理电脑（共用/单独、桌面、工作区）分开呈现。 */
function Computer({ agentId }: { agentId: string }) {
	const { system, agents, fileVersion } = useStore();
	const agent = agents.find((a) => a.id === agentId)!;
	const host = useHostControl();
	const [pauseBusy, setPauseBusy] = useState(false);
	const [pauseErr, setPauseErr] = useState("");
	const [path, setPath] = useState("");
	const [entries, setEntries] = useState<{ name: string; dir: boolean; size: number; mtime: number }[]>([]);
	useEffect(() => {
		api(`/api/agents/${agentId}/workspace?path=${encodeURIComponent(path)}`).then(setEntries).catch(() => setEntries([]));
	}, [agentId, path, fileVersion]);
	const paused = !!host.d?.status.enabled && host.d.status.paused;
	const togglePause = async () => {
		if (!host.d) return;
		setPauseBusy(true);
		setPauseErr("");
		try {
			await api("/api/host-control/pause", { method: "POST", json: { paused: !host.d.status.paused } });
			await host.load();
		} catch (e) {
			setPauseErr(e instanceof Error ? e.message : String(e));
		} finally {
			setPauseBusy(false);
		}
	};
	return (
		<div className="text-sm" data-testid="agent-computer-tab">
			<h2 className="pa-info-h2">你的电脑</h2>
			<AgentHostTier agentId={agentId} />
			<div className="pa-info-row">
				<span className="pa-info-row-main">
					<strong>{paused ? "已暂停操作你的电脑" : "一键暂停"}</strong>
					<small>暂停对所有助理生效；系统权限弹窗与网站登录 / 验证码仍由你本人完成。</small>
				</span>
				{host.d?.status.enabled ? (
					<Button size="sm" variant="outline" onClick={() => void togglePause()} disabled={pauseBusy} data-testid="agent-host-pause">
						{paused ? <Play size={14} /> : <Pause size={14} />} {paused ? "继续" : "暂停"}
					</Button>
				) : (
					<Button size="sm" variant="outline" onClick={() => useStore.getState().set({ settings: "host" })} data-testid="agent-host-open-settings">
						去开启
					</Button>
				)}
			</div>
			{pauseErr && <p className="text-xs text-red-600" role="alert">{pauseErr}</p>}
			<button type="button" className="pa-info-row" onClick={() => useStore.getState().set({ settings: "host" })}>
				<span className="pa-info-row-main"><strong>全局电脑设置</strong><small>安装连接、系统授权与权限清单</small></span>
				<ChevronRight size={16} className="pa-arrow" />
			</button>
			<h2 className="pa-info-h2">助理电脑</h2>
			<AgentComputer agentId={agentId} />
			<div className="mt-2"><DesktopView agentId={agentId} /></div>
			<details className="pa-info-details" data-testid="agent-workspace-details" open>
				<summary>
					工作区与文件
					<small>{system?.sandbox.mode === "docker" ? "Docker 容器（增强隔离）" : "工作区目录（基础模式，靠审批兜底）"} · {agent.workspace}</small>
				</summary>
				<div className="pa-info-details-body">
					<div className="flex items-center gap-1 text-xs text-mut2">
						<HardDrive size={14} />
						<code className="break-all">{agent.workspace}</code>
					</div>
					<div className="flex items-center gap-1 text-xs text-mut2">
						{path && (
							<button onClick={() => setPath(path.split("/").slice(0, -1).join("/"))} className="rounded p-1 hover:bg-hover" aria-label="返回上级">
								<ChevronLeft size={14} />
							</button>
						)}
						<span className="break-all">/{path}</span>
					</div>
					<div className="space-y-0.5">
						{entries.length === 0 && <div className="text-xs text-mut2">空目录</div>}
						{entries.map((e) => (
							<button
								key={e.name}
								onClick={() => (e.dir ? setPath(path ? `${path}/${e.name}` : e.name) : download(`/api/agents/${agentId}/workspace/file?path=${encodeURIComponent(path ? `${path}/${e.name}` : e.name)}`, e.name))}
								className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover"
							>
								{e.dir ? <Folder size={15} className="text-accent" /> : <File size={15} className="text-mut2" />}
								<span className="min-w-0 flex-1 break-all">{e.name}</span>
								{!e.dir && (
									<>
										<span className="shrink-0 text-xs text-mut2">{fmtSize(e.size)}</span>
										<Download size={13} className="shrink-0 text-mut2" />
									</>
								)}
								{e.dir && <span className="shrink-0 text-xs text-mut2">{fmtTime(e.mtime)}</span>}
							</button>
						))}
					</div>
				</div>
			</details>
		</div>
	);
}

/** 模型：聊天模型是第一区（主模型整行、思考单行、Fast 小开关），画图与子代理保留真实摘要 + 展开全部配置。 */
function AgentModels({ agentId }: { agentId: string }) {
	return (
		<div className="text-sm" data-testid="agent-models-tab">
			<div className="pa-info-sechead">
				<strong>聊天模型</strong>
				<small>修改后自动保存</small>
			</div>
			<ModelPicker agentId={agentId} layout="settings" allowThinkingFollow />
			<div className="mt-3">
				<AgentImageModel agentId={agentId} />
			</div>
			<SubagentModels agentId={agentId} />
		</div>
	);
}

/** 能力：技能与扩展同页两个区，各自保留搜索、启用数、全局管理与错误重试。 */
function Capabilities({ agentId }: { agentId: string }) {
	return (
		<div className="text-sm" data-testid="agent-capabilities-tab">
			<AgentSkills agentId={agentId} />
			<div className="mt-5 border-t border-line pt-4">
				<AgentExtensions agentId={agentId} />
			</div>
		</div>
	);
}

function AgentTasks({ agentId, legacyTab }: { agentId: string; legacyTab: string }) {
	const selected = useStore((s) => s.infoTaskTab);
	const tab = legacyTab === "routines" || legacyTab === "proactive" ? legacyTab : selected;
	const list = useStore((s) => s.tasks[agentId]) ?? [];
	return <div className="text-sm" data-testid="agent-tasks-tab">
		<ResponsiveTabs tabs={TASK_TABS} value={tab} variant="tabs" className="pa-info-subtabs" testId="agent-task-tabs" onChange={(k) => useStore.getState().set({ infoTab: "tasks", infoTaskTab: k as typeof selected })} />
		{tab === "routines" && <RoutinesTab agentId={agentId} />}
		{tab === "proactive" && <ProactiveTab agentId={agentId} />}
		{tab === "background" && <section className="space-y-2" data-testid="agent-background-tasks">
			<h2 className="pa-info-h2">后台任务</h2>
			{!list.length && <p className="text-sm text-mut">还没有后台任务。</p>}
			{list.slice(0, 20).map((x) => <TaskRow key={x.id} title={x.title || taskTitle(x.instructions)} status={x.status} />)}
			{!!list.length && <p className="text-xs text-mut2">执行结束只代表这次执行结束；是否达到原任务目标仍需核验。</p>}
		</section>}
	</div>;
}
