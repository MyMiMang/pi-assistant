import { ArrowLeft, Maximize2, Minimize2, PanelRightClose, Plus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { PREVIEW, clampPreview } from "../layout";
import { useStore } from "../store";
import { workspaceScope } from "../workspace-state";
import { registerWorkspace, unregisterWorkspace, updateWorkspace, useWorkspace, workspaceAction, type WorkspaceEntry } from "../workspace";
import { Resizer } from "./Resizer";
import { ResponsiveTabs } from "./ResponsiveTabs";
import { openWorkspaceStart } from "./WorkspaceStart";

function collapseWorkspace() {
	workspaceAction({ type: "collapse" });
	requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('[data-testid="workspace-reopen"]')]
		.find(el => el.getClientRects().length && !el.closest('[inert]'))?.focus());
}

export function activateWorkspace(key: string) {
	if (!useWorkspace.getState().entries[key]) return false;
	workspaceAction({ type: "open", key });
	return true;
}
/** 唯一注册外壳：调用方内容进入固定宿主，切换布局不移动 portal 或重挂内容。 */
export function SidePanel({ open, onClose, title, panelKey, kind = "tasks", testId, fixed, children }: {
	open: boolean; onClose: () => void; title: string; panelKey: string; kind?: WorkspaceEntry["kind"];
	testId?: string; wide?: boolean; fixed?: boolean; children: ReactNode;
}) {
	const owner = useRef(Symbol()).current;
	const latest = useRef<WorkspaceEntry>(null!);
	latest.current = { key: panelKey, title, kind, testId, fixed, content: children, onClose, owner };
	const registeredScope = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (!open) return;
		const scope = workspaceScope(useStore.getState());
		if (!registerWorkspace(latest.current, scope)) { latest.current.onClose?.(); return; }
		registeredScope.current = scope;
		return () => { registeredScope.current = null; unregisterWorkspace(panelKey, owner, scope); };
	}, [open, panelKey, owner]);
	useLayoutEffect(() => { if (open && registeredScope.current) updateWorkspace(latest.current, registeredScope.current); });
	return null;
}

/** 工作区显示时，窄屏/放大布局保留但禁用背后的聊天。 */
export const useSidePanelShown = () => useWorkspace((s) => !!s.active && !s.collapsed);

export function SidePanelDock({ docked, width }: { docked: boolean; width: number }) {
	const state = useWorkspace();
	const { active, entries, keys, collapsed, expanded } = state;
	const setLayout = useStore((s) => s.setLayout);
	const visible = !!active && !collapsed;
	const full = expanded || !docked;
	const mode = full ? (docked ? "expanded" : "mobile") : "docked";
	const tabs = useMemo(() => keys.map((key) => [key, entries[key].title] as const), [keys, entries]);
	const root = useRef<HTMLElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!visible || !full) return;
		returnFocus.current = document.activeElement as HTMLElement;
		root.current?.focus();
		return () => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); };
	}, [visible, full]);
	// 内层 useEscLayer 在 document capture 消费，宿主只在 window bubble 处理剩余 Esc。
	useEffect(() => {
		if (!visible) return;
		const dismiss = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('.pa-modal, [data-testid=image-viewer], [role="menu"]')) return;
			const target = document.activeElement as HTMLElement | null;
			if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "")) return;
			collapseWorkspace();
		};
		window.addEventListener("keydown", dismiss);
		return () => window.removeEventListener("keydown", dismiss);
	}, [visible]);
	useEffect(() => {
		if (!visible || !full) return;
		const trap = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || event.defaultPrevented || document.querySelector(".pa-modal, [data-testid=image-viewer]")) return;
			if ((event.target as HTMLElement)?.closest('.pa-help-pop')) return;
			const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length > 0 && el.tabIndex >= 0);
			const index = items.indexOf(document.activeElement as HTMLElement);
			event.preventDefault();
			if (!items.length) root.current?.focus();
			else items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length].focus();
		};
		document.addEventListener("keydown", trap);
		return () => document.removeEventListener("keydown", trap);
	}, [visible, full]);
	return (
		<aside ref={root} tabIndex={-1} className="pa-workspace" data-testid="right-workspace" data-mode={mode} data-collapsed={collapsed ? "1" : "0"} data-scope={state.scope}
			aria-label="工作区" hidden={!visible} role={full ? "dialog" : "complementary"} aria-modal={full || undefined} style={{ ["--workspace-w" as string]: `${width}px` }}>
			{docked && !expanded && <Resizer side="left" value={width} onChange={(v) => setLayout({ previewW: clampPreview(v) })} onReset={() => setLayout({ previewW: PREVIEW.def })} onCollapse={collapseWorkspace} label="调整侧栏宽度" />}
			<header className="pa-workspace-header">
				<div className="min-w-0 flex-1"><ResponsiveTabs tabs={tabs} value={active ?? ""} onChange={(key) => workspaceAction({ type: "open", key })} testId="workspace-tabs" /></div>
				<button type="button" className="pa-icon-btn ghost" title="关闭当前标签并释放内容" aria-label="关闭当前标签" data-testid="workspace-close-tab" onClick={() => { if (active) workspaceAction({ type: "close", key: active }); }}><X size={16} /></button>
				<button type="button" className="pa-icon-btn ghost" title="新标签" aria-label="新标签" data-testid="workspace-new-tab" onClick={openWorkspaceStart}><Plus size={17} /></button>
				{docked && <button type="button" className="pa-icon-btn ghost" title={expanded ? "恢复并排" : "放大工作区"} aria-label={expanded ? "恢复并排" : "放大工作区"} data-testid={expanded ? "workspace-restore" : "workspace-expand"} onClick={() => workspaceAction({ type: expanded ? "restore" : "expand" })}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>}
				<button type="button" className="pa-icon-btn ghost" title={docked ? "收起工作区（保留内容）" : "返回聊天（保留内容）"} aria-label={docked ? "收起工作区" : "返回聊天"} data-testid={docked ? "workspace-collapse" : "workspace-back-chat"} onClick={collapseWorkspace}>{docked ? <PanelRightClose size={17} /> : <ArrowLeft size={17} />}</button>
			</header>
			{state.notice && <p className="border-b border-line px-3 py-2 text-sm text-mut" role="alert" data-testid="workspace-limit-notice">{state.notice}</p>}
			<div className="pa-workspace-content" data-testid="workspace-content">
				{keys.map((key) => {
					const entry = entries[key];
					return <section key={key} hidden={active !== key} className={`pa-workspace-instance ${entry.fixed ? "fixed-content" : "scroll-content"}`} data-workspace-key={key} data-testid={entry.testId} data-docked={!full ? "1" : undefined} role="tabpanel" aria-label={entry.title}>{entry.content}</section>;
				})}
			</div>
		</aside>
	);
}
