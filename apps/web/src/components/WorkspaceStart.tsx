import { Brain, Files, Globe, PanelsTopLeft, UserRound } from "lucide-react";
import { useStore } from "../store";
import { registerWorkspace, useWorkspace, workspaceAction } from "../workspace";
import { WORKSPACE_START } from "../workspace-state";
import { BrowserWorkspace } from "./BrowserWorkspace";
import { openAgentDetails } from "./InfoPane";
import { Input, Select } from "./ui";
import { useState } from "react";

export function openWorkspaceStart() {
	registerWorkspace({ key: WORKSPACE_START, kind: "start", title: "新标签", content: <WorkspaceStart /> });
}

/** 不探测页面、更不启动浏览器；只有显式点「网页」才挂载既有查看器。 */
function WorkspaceStart() {
	const current = useStore(s => s.current);
	const room = useStore(s => s.rooms.find(r => r.id === s.room));
	const agents = useStore(s => s.agents);
	const [chosen, setChosen] = useState("");
	const [query, setQuery] = useState("");
	const ids = room ? room.members.filter(m => !m.left && !m.deleted).map(m => m.agentId) : current ? [current] : [];
	const choices = ids.flatMap(id => { const agent = agents.find(a => a.id === id); return agent ? [[id, agent.name] as const] : []; });
	const target = choices.find(([id]) => id === chosen) ?? choices[0];
	const openBrowser = () => {
		const key = `browser:${room ? `room:${room.id}` : current ?? "none"}`;
		registerWorkspace({ key, kind: "browser", title: "网页", testId: "workspace-browser", fixed: true, content: <BrowserWorkspace agentIds={ids} workspaceKey={key} /> });
	};
	const shortcuts = [
		{ id: "files", available: !!target, icon: Files, title: "文件", description: "查看该助理的上传和交付", keywords: "文档", open: () => target && openAgentDetails(target[0], "files") },
		{ id: "browser", available: !!ids.length, icon: Globe, title: "网页", description: "查看助理已打开的网页", keywords: "浏览器", open: openBrowser },
		{ id: "agent", available: !!target, icon: UserRound, title: "助理详情", description: target?.[1] ?? "", keywords: "概览", open: () => target && openAgentDetails(target[0]) },
		{ id: "model", available: !!target, icon: Brain, title: "模型设置", description: "调整模型、思考和快速模式", keywords: "大脑 Fast", open: () => target && openAgentDetails(target[0], "models") },
	].filter(entry => entry.available);
	const phrase = query.trim().toLowerCase();
	const matches = shortcuts.filter(({ title, description, keywords }) => `${title} ${description} ${keywords}`.toLowerCase().includes(phrase));
	return <div className="pa-workspace-start" data-testid="workspace-start">
		<h2 className="text-lg font-semibold">从这里打开工作内容</h2>
		<p className="text-sm text-mut">选择一项，在聊天旁查看或编辑。</p>
		{room && choices.length > 1 && <div className="flex flex-wrap items-center gap-2 text-sm">查看成员
			<Select ariaLabel="查看成员" value={target?.[0] ?? ""} onChange={setChosen} options={choices.map(([value, label]) => ({ value, label }))} />
		</div>}
		{shortcuts.length > 0 && <>
			<Input type="search" aria-label="筛选工作区入口" placeholder="筛选入口：文件、网页、助理详情、模型设置" value={query} onChange={event => setQuery(event.target.value)} />
			{matches.length > 0 && <div className="pa-workspace-shortcuts">
				{matches.map(({ id, icon: Icon, title, description, open }) => <button key={id} type="button" data-testid={`workspace-${id}-open`} onClick={open}><Icon size={17} aria-hidden="true" /> <span><b>{title}</b><small>{description}</small></span></button>)}
			</div>}
			<p role="status" className={matches.length ? "sr-only" : "text-sm text-mut"}>{matches.length ? "" : "没有匹配的入口。"}</p>
		</>}
		{!shortcuts.length && <p className="text-sm text-mut">当前没有可查看的助理。</p>}
	</div>;
}

/** 放在当前聊天自己的标题栏；展开时控制都归右栏。 */
export function WorkspaceButton() {
	const active = useWorkspace(s => s.active);
	const collapsed = useWorkspace(s => s.collapsed);
	if (active && !collapsed) return null;
	return <button type="button" className="pa-icon-btn ghost shrink-0" data-testid="workspace-reopen" aria-label="打开工作区" title={active ? "恢复工作区" : "打开工作区"}
		onClick={() => active ? workspaceAction({ type: "reopen" }) : openWorkspaceStart()}><PanelsTopLeft size={16} /></button>;
}
