import type { ReactNode } from "react";
import { create } from "zustand";
import { useStore } from "./store";
import { WORKSPACE_LIMIT, WORKSPACE_START, emptyWorkspace, workspaceScope, workspaceStep, type WorkspaceAction, type WorkspaceState } from "./workspace-state";

export type WorkspaceEntry = {
	key: string;
	title: string;
	kind: "start" | "file" | "tasks" | "projects" | "reminders" | "browser" | "settings";
	testId?: string;
	fixed?: boolean;
	content: ReactNode;
	onClose?: () => void;
	/** 注册者的代际令牌，旧实例卸载不能误删后来者。 */
	owner?: symbol;
	returnFocus?: HTMLElement | null;
};
type State = WorkspaceState & { entries: Record<string, WorkspaceEntry>; notice: string };
export const useWorkspace = create<State>(() => ({ ...emptyWorkspace(workspaceScope(useStore.getState())), entries: {}, notice: "" }));

let disposing = false;
function disposeCallbacks(entries: WorkspaceEntry[]) {
	const previous = disposing;
	disposing = true;
	try { for (const entry of entries) entry.onClose?.(); }
	finally { disposing = previous; }
}
function apply(action: WorkspaceAction) {
	const before = useWorkspace.getState();
	const next = workspaceStep(before, action);
	if (next === before) return;
	const entries = Object.fromEntries(next.keys.map((key) => [key, before.entries[key]]));
	const removed = before.keys.filter((key) => !next.keys.includes(key));
	useWorkspace.setState({ ...next, entries, notice: action.type === "scope" || action.type === "close" ? "" : before.notice });
	disposeCallbacks(removed.map((key) => before.entries[key]).filter(Boolean));
	if (action.type === "close" && before.active === action.key) {
		const focus = before.entries[action.key]?.returnFocus;
		if (focus?.isConnected) focus.focus();
	}
}
export const workspaceAction = (action: WorkspaceAction) => apply(action);
export function registerWorkspace(entry: WorkspaceEntry, scope = workspaceScope(useStore.getState())) {
	if (disposing) return false;
	syncWorkspaceScope();
	const before = useWorkspace.getState();
	if (scope !== before.scope) return false;
	const previous = before.entries[entry.key];
	if (!previous && before.keys.length >= WORKSPACE_LIMIT && before.active !== WORKSPACE_START) {
		useWorkspace.setState({ collapsed: false, notice: `工作区已打开 ${WORKSPACE_LIMIT} 项，请先关闭一个标签再打开新内容。` });
		return false;
	}
	// 同owner刷新由update负责；不同owner显式接手，旧cleanup只能操作旧令牌。
	if (!previous || (entry.owner && previous.owner !== entry.owner)) {
		useWorkspace.setState({ entries: { ...before.entries, [entry.key]: { ...entry, returnFocus: previous?.returnFocus ?? (typeof document === "undefined" ? null : document.activeElement as HTMLElement) } } });
	}
	apply({ type: "open", key: entry.key });
	if (previous?.owner && entry.owner && previous.owner !== entry.owner) disposeCallbacks([previous]);
	return true;
}
export function updateWorkspace(entry: WorkspaceEntry, scope: string) {
	const before = useWorkspace.getState();
	if (scope !== before.scope || !before.entries[entry.key] || before.entries[entry.key].owner !== entry.owner) return;
	useWorkspace.setState({ entries: { ...before.entries, [entry.key]: { ...entry, returnFocus: before.entries[entry.key]?.returnFocus } } });
}
export function unregisterWorkspace(key: string, owner: symbol, scope: string) {
	const state = useWorkspace.getState();
	if (scope === state.scope && state.entries[key]?.owner === owner) apply({ type: "close", key });
}
export function syncWorkspaceScope() {
	apply({ type: "scope", scope: workspaceScope(useStore.getState()) });
}
// 清理早于下一次 React paint，含收起/放大时；迟到业务请求不能留住旧内容 DOM。
useStore.subscribe((state, previous) => {
	if (workspaceScope(state) !== workspaceScope(previous)) syncWorkspaceScope();
});
