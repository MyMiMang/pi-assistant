/** 统一工作区纯状态：只存当前会话，业务内容由 SidePanel 注册持有。 */
export const WORKSPACE_LIMIT = 12;
export type WorkspaceState = { scope: string; keys: string[]; active: string | null; collapsed: boolean; expanded: boolean };
export const emptyWorkspace = (scope: string): WorkspaceState => ({ scope, keys: [], active: null, collapsed: false, expanded: false });
export type WorkspaceAction =
	| { type: "open"; key: string }
	| { type: "close"; key: string }
	| { type: "scope"; scope: string }
	| { type: "collapse" | "reopen" | "expand" | "restore" };
export function workspaceStep(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
	if (action.type === "scope") return action.scope === state.scope ? state : emptyWorkspace(action.scope);
	if (action.type === "open") {
		if (!state.keys.includes(action.key) && state.keys.length >= WORKSPACE_LIMIT) return state;
		const keys = state.keys.includes(action.key) ? state.keys : [...state.keys, action.key];
		return { ...state, keys, active: action.key, collapsed: false };
	}
	if (action.type === "close") {
		const index = state.keys.indexOf(action.key);
		if (index < 0) return state;
		const keys = state.keys.filter((key) => key !== action.key);
		const active = state.active === action.key ? keys[Math.min(index, keys.length - 1)] ?? null : state.active;
		return { ...state, keys, active, expanded: !!active && state.expanded, collapsed: !!active && state.collapsed };
	}
	if (!state.active) return state;
	if (action.type === "collapse") return { ...state, collapsed: true };
	if (action.type === "reopen") return { ...state, collapsed: false };
	return { ...state, expanded: action.type === "expand" };
}
export function workspaceScope(selection: { room: string | null; current: string | null; convs: Record<string, { current?: string | null }> }): string {
	return selection.room ? `room:${selection.room}` : `agent:${selection.current ?? ""}:conversation:${selection.convs[selection.current ?? ""]?.current ?? ""}`;
}
