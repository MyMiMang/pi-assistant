import { create } from "zustand";
import { getTheme } from "./themes/registry";
import { api } from "./api";
import type { Agent, Device, Message, SystemInfo, Task } from "./types";

type Theme = "light" | "dark" | "system";
interface State {
	conn: "connecting" | "open" | "closed" | "unauthorized";
	system: SystemInfo | null;
	agents: Agent[];
	desktopVersion: number;
	cloudflareSteps: { step: string; state: "running" | "ok" | "error"; detail?: string }[];
	current: string | null;
	messages: Record<string, Message[]>;
	tasks: Record<string, Task[]>;
	pendingDevices: Device[];
	loginEvents: Record<string, any[]>;
	drawer: boolean;
	info: boolean;
	/** 右侧信息面板当前页 */
	infoTab: string;
	settings: string | null;
	/** 明暗：浅色 / 深色 / 跟随系统 */
	theme: Theme;
	/** 主题（见 themes/registry.ts） */
	skin: string;
	/** 强调色；空 = 主题默认 */
	accent: string;
	fileVersion: number;
	set: (p: Partial<State>) => void;
	loadSystem: () => Promise<void>;
	loadAgents: () => Promise<void>;
	selectAgent: (id: string) => Promise<void>;
	loadTasks: (id: string) => Promise<void>;
	handle: (e: any) => void;
}

const isVisible = () => document.visibilityState === "visible";
let readTimer: number | undefined;

export const useStore = create<State>((set, get) => ({
	conn: "connecting",
	system: null,
	agents: [],
	current: null,
	messages: {},
	tasks: {},
	pendingDevices: [],
	loginEvents: {},
	cloudflareSteps: [],
	desktopVersion: 0,
	drawer: false,
	info: window.innerWidth >= 1280,
	infoTab: "overview",
	settings: new URLSearchParams(location.search).get("settings"),
	theme: (localStorage.getItem("pia.theme") as Theme) || (getTheme(localStorage.getItem("pia.skin")).defaultMode ?? "system"),
	skin: getTheme(localStorage.getItem("pia.skin")).id,
	accent: localStorage.getItem("pia.accent") ?? "",
	fileVersion: 0,
	set: (p) => set(p),
	async loadSystem() {
		set({ system: await api<SystemInfo>("/api/system") });
	},
	async loadAgents() {
		const agents = await api<Agent[]>("/api/agents");
		const cur = get().current;
		set({ agents, current: cur && agents.some((a) => a.id === cur) ? cur : (new URLSearchParams(location.search).get("agent") ?? agents[0]?.id ?? null) });
	},
	async selectAgent(id) {
		set({ current: id, drawer: false });
		const msgs = await api<Message[]>(`/api/agents/${id}/messages?limit=300`);
		set((s) => ({ messages: { ...s.messages, [id]: msgs } }));
		void get().loadTasks(id);
		void api(`/api/agents/${id}/read`, { method: "POST" }).catch(() => {});
	},
	async loadTasks(id) {
		const tasks = await api<Task[]>(`/api/agents/${id}/tasks`);
		set((s) => ({ tasks: { ...s.tasks, [id]: tasks } }));
	},
	handle(e) {
		const s = get();
		const patchMsgs = (agentId: string, fn: (l: Message[]) => Message[]) => {
			const list = s.messages[agentId];
			if (list) set({ messages: { ...get().messages, [agentId]: fn(get().messages[agentId] ?? list) } });
		};
		switch (e.type) {
			case "message.created": {
				const m = e.message as Message;
				if (m.task_id) break;
				patchMsgs(m.agent_id, (l) => (l.some((x) => x.id === m.id) ? l : [...l, m]));
				set({
					agents: get().agents.map((a) =>
						a.id === m.agent_id
							? { ...a, last: m.role === "user" || m.role === "assistant" ? { content: m.content, role: m.role, created_at: m.created_at } : a.last, unread: a.unread + (m.role === "assistant" || m.role === "card" ? 1 : 0) }
							: a,
					),
				});
				if (m.agent_id === get().current && isVisible()) {
					clearTimeout(readTimer);
					readTimer = window.setTimeout(() => api(`/api/agents/${m.agent_id}/read`, { method: "POST" }).catch(() => {}), 400);
				}
				break;
			}
			case "message.delta":
				if (e.taskId) break;
				patchMsgs(e.agentId, (l) => l.map((m) => (m.id === e.id ? { ...m, content: m.content + e.delta } : m)));
				break;
			case "message.updated": {
				const m = e.message as Message;
				if (m.task_id) break;
				patchMsgs(m.agent_id, (l) => l.map((x) => (x.id === m.id ? m : x)));
				if (m.role === "assistant" && m.status === "done")
					set({ agents: get().agents.map((a) => (a.id === m.agent_id ? { ...a, last: { content: m.content, role: m.role, created_at: m.created_at } } : a)) });
				break;
			}
			case "message.deleted":
				if (!e.taskId) patchMsgs(e.agentId, (l) => l.filter((m) => m.id !== e.id));
				break;
			case "agent.status":
				set({ agents: get().agents.map((a) => (a.id === e.agentId ? { ...a, status: e.status } : a)) });
				break;
			case "agent.read":
				set({ agents: get().agents.map((a) => (a.id === e.agentId ? { ...a, unread: 0 } : a)) });
				break;
			case "agents.changed":
				void get().loadAgents();
				break;
			case "task.updated": {
				const t = e.task;
				const list = get().tasks[t.agent_id] ?? [];
				set({ tasks: { ...get().tasks, [t.agent_id]: list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list] } });
				break;
			}
			case "file.created":
				set({ fileVersion: get().fileVersion + 1 });
				break;
			case "device.pending":
				if (get().system?.local) set({ pendingDevices: [...get().pendingDevices, e.device] });
				break;
			case "login.event":
				set({ loginEvents: { ...get().loginEvents, [e.flowId]: [...(get().loginEvents[e.flowId] ?? []), e.event] } });
				break;
			case "tunnel.status":
				if (get().system) set({ system: { ...get().system!, tunnel: e.status } });
				break;
			case "desktop.changed":
				set({ desktopVersion: get().desktopVersion + 1 });
				break;
			case "cloudflare.progress": {
				const cur = get().cloudflareSteps.filter((x) => x.step !== e.step);
				set({ cloudflareSteps: [...cur, { step: e.step, state: e.state, detail: e.detail }] });
				break;
			}
			case "settings.changed":
				void get().loadSystem();
				break;
		}
	},
}));

/** 应用主题到 <html>：data-skin（主题）、data-mode（明暗）、.dark（Tailwind dark: 变体）、可选的自选强调色。 */
export function applyTheme(theme: Theme, accent: string, skin = useStore.getState().skin) {
	const def = getTheme(skin);
	const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
	const el = document.documentElement;
	el.dataset.skin = def.id;
	el.dataset.mode = dark ? "dark" : "light";
	el.classList.toggle("dark", dark);
	if (accent) {
		el.dataset.userAccent = "";
		el.style.setProperty("--user-acc", accent);
	} else {
		delete el.dataset.userAccent;
		el.style.removeProperty("--user-acc");
	}
	document.querySelector('meta[name="theme-color"]')?.setAttribute("content", def.chrome[dark ? "dark" : "light"]);
}
/** 保存并应用（按设备持久化在 localStorage） */
export function setAppearance(p: { theme?: Theme; skin?: string; accent?: string }) {
	const s = useStore.getState();
	const next = { theme: p.theme ?? s.theme, skin: p.skin ?? s.skin, accent: p.accent ?? (p.skin && p.skin !== s.skin ? "" : s.accent) };
	localStorage.setItem("pia.theme", next.theme);
	localStorage.setItem("pia.skin", next.skin);
	localStorage.setItem("pia.accent", next.accent);
	s.set(next);
	applyTheme(next.theme, next.accent, next.skin);
}
