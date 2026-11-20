import { ChevronDown, ChevronRight, Ellipsis, Folder, FolderPlus, Pencil, Plus, Trash2 } from "lucide-react";
import { useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Agent, AgentFolder } from "../types";
import { ContextMenu } from "./ContextMenu";
import { Button, ErrorBox, Input, Modal } from "./ui";
import { useAgentFolderDrag } from "./useAgentFolderDrag";

const FOLDERS_URL = "/api/agent-folders";
const UNCATEGORIZED = "未分类";
type Dialog = { kind: "new" | "move" } | { kind: "rename" | "dissolve"; folder: AgentFolder };
const expansionKey = (scope: string, id: string) => `pia.sidebar.folder:${scope}:${id}`;
type Selection = { checked: boolean; toggle: () => void };

interface DragEntry {
	start: (e: PointerEvent<HTMLButtonElement>, handle?: boolean) => void;
}

interface Props {
	agents: Agent[];
	current: string | null;
	query: string;
	moveId: string | null;
	onCloseMove: () => void;
	onCreateAgent: (id: string) => void;
	renderAgent: (agent: Agent, selection?: Selection, drag?: DragEntry) => ReactNode;
}

export function SidebarPersonalFolders({ agents, current, query, moveId, onCloseMove, onCreateAgent, renderAgent }: Props) {
	const folders = useStore((s) => s.agentFolders);
	const loadError = useStore((s) => s.agentFoldersError);
	const scope = useStore((s) => s.selKey);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [menu, setMenu] = useState<{ folder: AgentFolder; x: number; y: number } | null>(null);
	const [selected, setSelected] = useState<Set<string> | null>(null);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const inFlight = useRef(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const baseId = useId();
	const searching = !!query;
	const available = folders !== null && !loadError;
	const matches = (a: Agent) => !query || a.name.includes(query) || a.description?.includes(query);
	const folderIds = new Set(folders?.map((f) => f.id));
	const byFolder = new Map<string, Agent[]>();
	for (const a of agents) {
		const key = a.folderId && folderIds.has(a.folderId) ? a.folderId : "";
		const group = byFolder.get(key);
		if (group) group.push(a);
		else byFolder.set(key, [a]);
	}
	const pickable = agents.filter((a) => selected?.has(a.id));
	const moving = moveId ? agents.filter((a) => a.id === moveId) : pickable;
	const activeDialog = moveId ? { kind: "move" } as const : dialog;
	const changeDialog = (next: Dialog | null) => {
		setError("");
		setName(next?.kind === "rename" ? next.folder.name : "");
		setDialog(next);
	};
	const close = () => {
		if (busy) return;
		onCloseMove();
		changeDialog(null);
	};
	const apply = async (write: () => Promise<unknown>, done: () => void, fail = setError) => {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError("");
		try {
			await write();
			await useStore.getState().loadAgents().catch(() => setNotice("操作已保存，但列表刷新失败，请刷新页面重试。"));
			done();
		} catch (e) {
			fail(e instanceof Error ? e.message : "操作失败，请重试");
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	};
	const setOpen = (id: string, open: boolean) => {
		const key = expansionKey(scope, id);
		setExpanded((old) => ({ ...old, [key]: open }));
		try { localStorage.setItem(key, open ? "1" : "0"); } catch { /* 仅本次保留 */ }
	};
	const expand = (id: string) => setOpen(id, true);
	const move = (ids: string[], folderId: string) => api(`${FOLDERS_URL}/move`, { method: "POST", json: { agentIds: ids, folderId: folderId || null } });
	const canDrag = available && !!folders?.length && !selected && !activeDialog && !busy && !searching;
	const drag = useAgentFolderDrag(canDrag, (id, folderId) => {
		const a = agents.find((item) => item.id === id);
		if (!canDrag || !a || (a.folderId ?? "") === folderId || (folderId && !folderIds.has(folderId))) return;
		setNotice("");
		void apply(() => move([id], folderId), () => {}, (detail) => setNotice(`移动失败：${detail}`));
	});
	const row = (a: Agent) => renderAgent(a, selected ? {
		checked: selected.has(a.id), toggle: () => setSelected((old) => {
			if (!old) return old;
			const next = new Set(old);
			if (!next.delete(a.id)) next.add(a.id);
			return next;
		}),
	} : undefined, canDrag ? { start: (e, handle) => drag.start(e, a.id, a.name, handle) } : undefined);
	const folderRow = (id: string, label: string) => {
		const items = byFolder.get(id) ?? [];
		const shown = items.filter(matches);
		if (searching && !shown.length) return null;
		const key = expansionKey(scope, id);
		let stored: string | null = null;
		try { stored = localStorage.getItem(key); } catch { /* 存储受限 */ }
		const open = searching || (expanded[key] ?? (stored === null ? !id || items.some((a) => a.id === current) : stored === "1"));
		const count = searching ? shown.length : items.length;
		const folder = id ? { id, name: label } : null;
		const unread = items.reduce((total, a) => total + (a.id === current ? 0 : a.unread), 0);
		const region = `${baseId}-${id || "uncategorized"}`;
		return (
			<section key={id} data-testid={folder ? "sidebar-agent-folder" : "sidebar-uncategorized"}>
				<div className="flex min-w-0 items-center">
					<button type="button" aria-expanded={open} aria-controls={region} data-folder-drop={canDrag ? id : undefined} disabled={searching} onClick={() => setOpen(id, !open)} className="flex min-h-10 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm text-fg enabled:hover:bg-hover">
						{open ? <ChevronDown size={14} className="shrink-0 text-mut" /> : <ChevronRight size={14} className="shrink-0 text-mut" />}
						<Folder size={16} className="shrink-0 text-mut" />
						<span className="truncate" title={label}>{label}</span><span className="text-xs text-mut2">{count}</span>
						{!open && unread > 0 && <span className="pa-badge" aria-label={`${unread} 条未读`}>{unread > 99 ? "99+" : unread}</span>}
					</button>
					{folder && available && !selected && <button type="button" className="pa-icon-btn ghost shrink-0 !h-10 !w-10" title={`${label}更多操作`} aria-label={`${label}更多操作`} aria-haspopup="menu" onClick={(e) => {
						const { right, bottom } = e.currentTarget.getBoundingClientRect();
						setMenu({ folder, x: right - 168, y: bottom });
					}}><Ellipsis size={16} /></button>}
				</div>
				<div id={region} hidden={!open} className="ml-2 border-l border-line pl-1">
					{open && (shown.length ? shown.map(row) : <p className="px-3 py-2 text-xs text-mut2">暂无助理</p>)}
				</div>
			</section>
		);
	};
	const editing = activeDialog?.kind === "new" || activeDialog?.kind === "rename" ? activeDialog : null;
	const editName = name.trim();
	const nameError = editName === UNCATEGORIZED ? `「${UNCATEGORIZED}」不能用作文件夹名称` : folders?.some((f) => f.name === editName && (editing?.kind !== "rename" || f.id !== editing.folder.id)) ? "已经有同名文件夹" : "";
	const dissolve = activeDialog?.kind === "dissolve" ? activeDialog.folder : null;
	const destinations = [...(folders ?? []), { id: "", name: UNCATEGORIZED }];
	return (
			<>
				<div className="pa-sec-label flex flex-wrap items-center gap-x-1 !py-0">
					<span className="mr-auto shrink-0">我的助理</span>
					<button type="button" disabled={!available} className="inline-flex min-h-10 items-center gap-1 rounded px-1 text-xs text-mut enabled:hover:bg-hover disabled:opacity-50" onClick={() => changeDialog({ kind: "new" })}><FolderPlus size={14} />新建文件夹</button>
					<button type="button" disabled={!available || !folders?.length || !agents.length || !!selected} className="min-h-10 rounded px-1 text-xs text-mut enabled:hover:bg-hover disabled:opacity-50" onClick={() => { setSelected(new Set()); expand(""); setNotice(""); }}>整理助理</button>
				</div>
				{loadError && <div className="px-2 text-xs text-mut">未能加载文件夹。<Button variant="ghost" size="sm" onClick={() => void useStore.getState().loadAgents().catch(() => {})}>重试</Button></div>}
				{selected && <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-xs">
					<span className="mr-auto" role="status">已选 {pickable.length} 个</span>
					<Button size="sm" variant="primary" disabled={!pickable.length || !available} onClick={() => changeDialog({ kind: "move" })}>移动 {pickable.length} 个</Button>
					<Button size="sm" variant="ghost" onClick={() => setSelected(null)}>取消</Button>
				</div>}
				{notice && <p role="status" className="px-2 text-xs text-mut">{notice}</p>}
				{folders?.length ? (
				<div ref={drag.zone} onClickCapture={drag.guardClick} onPointerDownCapture={drag.resetClick}>
					{folders.map((f) => folderRow(f.id, f.name))}{folderRow("", UNCATEGORIZED)}
				</div>
			) : agents.filter(matches).map(row)}
			{drag.dragging && <div aria-hidden="true" className="pa-folder-drag-preview truncate" style={{ left: Math.max(4, Math.min(window.innerWidth - 164, drag.dragging.x + 12)), top: Math.max(4, Math.min(window.innerHeight - 38, drag.dragging.y + 12)) }}>{drag.dragging.name}</div>}
				{editing && <Modal open onClose={close} title={editing.kind === "rename" ? "文件夹改名" : "新建文件夹"} ariaLabel={editing.kind === "rename" ? "文件夹改名" : "新建文件夹"}>
					<form className="space-y-3 p-5" onSubmit={(e) => {
						e.preventDefault();
						if (!editName || nameError) return;
						const rename = editing.kind === "rename";
						void apply(() => api(rename ? `${FOLDERS_URL}/${editing.folder.id}` : FOLDERS_URL, { method: rename ? "PATCH" : "POST", json: { name: editName } }), () => changeDialog(null));
					}}>
						<label className="block text-sm">文件夹名称<Input autoFocus value={name} maxLength={40} disabled={busy} onChange={(e) => { setName(e.target.value); setError(""); }} /></label>
						<ErrorBox text={error || nameError} />
						<div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={close}>取消</Button><Button type="submit" variant="primary" disabled={busy || !editName || !!nameError}>保存</Button></div>
					</form>
				</Modal>}
				<ContextMenu at={menu} onClose={() => setMenu(null)} testId="agent-folder-menu" items={menu ? [
					{ key: "create", label: "新建助理", icon: <Plus size={15} />, run: () => { expand(menu.folder.id); onCreateAgent(menu.folder.id); } },
					{ key: "rename", label: "重命名", icon: <Pencil size={15} />, run: () => changeDialog({ kind: "rename", folder: menu.folder }) },
					{ key: "dissolve", label: "解散文件夹", icon: <Trash2 size={15} />, run: () => changeDialog({ kind: "dissolve", folder: menu.folder }) },
				] : []} />
				{dissolve && <Modal open onClose={close} title="解散文件夹？" ariaLabel="解散文件夹">
					<div className="space-y-3 p-5 text-sm">
						<p>「{dissolve.name}」中的 {byFolder.get(dissolve.id)?.length ?? 0} 个助理将移到未分类。不会删除助理或聊天。</p><ErrorBox text={error} />
						<div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={close}>取消</Button><Button variant="danger" disabled={busy} onClick={() => {
							void apply(() => api(`${FOLDERS_URL}/${dissolve.id}`, { method: "DELETE" }), () => { expand(""); changeDialog(null); });
						}}>解散</Button></div>
					</div>
				</Modal>}
				{activeDialog?.kind === "move" && <Modal open onClose={close} title="选择目标文件夹" ariaLabel="选择目标文件夹">
					<div className="space-y-3 p-5 text-sm">
						<p className="text-mut">{moving.length ? `将 ${moving.length} 个个人助理移动到：` : "没有可移动的助理。"}</p>
						{!available && <p className="text-mut">文件夹列表暂不可用，请重试。</p>}
						<ErrorBox text={error} />
						{destinations.map((f) => <Button key={f.id} variant="outline" className="w-full !justify-start" disabled={busy || !available || moving.every((a) => (a.folderId ?? "") === f.id)} onClick={() => {
							void apply(() => move(moving.map((a) => a.id), f.id), () => {
								expand(f.id); setSelected(null); onCloseMove(); changeDialog(null);
							});
						}}><span className="truncate">{f.name}</span></Button>)}
						<div className="flex justify-end"><Button variant="ghost" disabled={busy} onClick={close}>取消</Button></div>
					</div>
				</Modal>}
			</>
	);
}
