import { create } from "zustand";
import { getTheme } from "./themes/registry";
import { api } from "./api";
import { loadLayout, type LayoutPrefs, saveLayout } from "./layout";
import { loadSelection, mergeMessages, resolveInitialAgent, saveSelection, selectionKey, storedConversation, type Selection } from "./selection";
import type { Agent, Conversation, Device, Message, Room, SystemInfo, Task } from "./types";

type Theme = "light" | "dark" | "system";
export interface SubagentTab { id: string; task: string; agent_id: string; conversation_id: string; roomId: string | null }
interface State {
	conn: "connecting" | "open" | "closed" | "unauthorized";
	system: SystemInfo | null;
	agents: Agent[];
	desktopVersion: number;
	cloudflareSteps: { step: string; state: "running" | "ok" | "error"; detail?: string }[];
	tunnelSteps: { step: string; state: "running" | "ok" | "error"; detail?: string }[];
	current: string | null;
	subagent: string | null;
	subagentTabs: SubagentTab[];
	openSubagent: (r: Omit<SubagentTab, "roomId">) => void;
	closeSubagent: (id: string) => void;
	/** 群聊 */
	rooms: Room[];
	/** 正在看的群（不为空时主区域显示群聊） */
	room: string | null;
	/** 群消息（按群） */
	roomMsgs: Record<string, Message[]>;
	/** 群里点了成员头像：右侧面板显示这个助理 */
	paneAgent: string | null;
	loadRooms: () => Promise<void>;
	selectRoom: (id: string) => Promise<void>;
	/** 当前对话的消息（按助理） */
	messages: Record<string, Message[]>;
	/** 每个助理的对话列表与当前对话 */
	convs: Record<string, { current: string; items: Conversation[] }>;
	/** 每个助理的消息加载状态：loading / error / 已加载 / 对应对话 / 还有更早的 */
	msgState: Record<string, MsgState>;
	/** 账号隔离的选择存储 key（loadSystem 后确定；空 = 不持久化） */
	selKey: string;
	memoryVersion: number;
	/** Hindsight 状态 / 同步队列变化 */
	hindsightVersion: number;
	/** 统一下载状态的实时更新（id → 最新状态，来自 downloads.changed 事件） */
	downloads: Record<string, import("./components/Downloads").DownloadInfo>;
	hostVersion: number;
	actionsVersion: number;
	channelsVersion: number;
	proactiveVersion: number;
	inbox: boolean;
	routinesVersion: number;
	skillsVersion: number;
	/** 本地 Laya 状态变化（来自 local-laya.changed 事件），驱动安装 / 运行卡片刷新 */
	localLayaVersion: number;
	extVersion: number;
	tasks: Record<string, Task[]>;
	pendingDevices: Device[];
	loginEvents: Record<string, any[]>;
	drawer: boolean;
	info: boolean;
	layout: LayoutPrefs;
	setLayout: (p: Partial<LayoutPrefs>) => void;
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
	loadConversations: (id: string) => Promise<{ current: string; items: Conversation[] }>;
	/** 拉取某个对话的消息；req 用于并发保护（晚返回的旧请求不覆盖新目标） */
	loadMessages: (agentId: string, convId: string, req?: Request) => Promise<void>;
	/** 加载失败后重试当前目标 */
	retryMessages: (agentId: string) => Promise<void>;
	/** 向上翻页加载更早的消息（不截断服务端模型会话） */
	loadMoreMessages: (agentId: string) => Promise<void>;
	switchConversation: (agentId: string, convId: string) => Promise<void>;
	newConversation: (agentId: string) => Promise<void>;
	handle: (e: any) => void;
}

/** 消息加载状态；conv = 当前这批消息属于哪个对话（用于判断能不能和迟到的 history 合并） */
export interface MsgState {
	loading: boolean;
	error: string | null;
	loaded: boolean;
	conv: string | null;
	hasMore: boolean;
}
const MSG_BASE: MsgState = { loading: false, error: null, loaded: false, conv: null, hasMore: false };
/** 每页消息数：首屏只拉最近一批（越小首屏越快），向上滚动再按需加载更早。服务端上限 500。 */
export const PAGE = 50;
/** 群聊首屏 / 每次向上加载的条数（与单聊一致）。 */
export const ROOM_PAGE = 50;

/** 每个助理的最新请求代号：晚返回的旧请求不能覆盖新目标 */
const reqGen: Record<string, number> = {};
const aborters: Record<string, AbortController | undefined> = {};
interface Request {
	gen: number;
	signal: AbortSignal;
}
/** 开一次新请求：中止同一助理上一个还没回来的请求，并拿到新的代号 */
function newRequest(agentId: string): Request {
	aborters[agentId]?.abort();
	const c = new AbortController();
	aborters[agentId] = c;
	return { gen: (reqGen[agentId] = (reqGen[agentId] ?? 0) + 1), signal: c.signal };
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/**
 * 向更早分页的查询串：优先用服务端给的稳定游标 `(before=created_at, beforeSeq=rowid)`，
 * 避免同一毫秒的多条消息在边界被跳过 / 重复；旧服务端没返回 seq 时退回 `before=created_at`。
 */
function olderParams(limit: number, conv: string, oldest: { created_at: number; seq?: number | null }): string {
	const q = new URLSearchParams({ limit: String(limit), conversation: conv, before: String(oldest.created_at) });
	if (typeof oldest.seq === "number") q.set("beforeSeq", String(oldest.seq));
	return q.toString();
}
/** 只写公开 id；不存消息、不存 token / 凭据 */
function persistSelection(key: string, patch: { agentId?: string | null; conv?: { agentId: string; convId: string } }) {
	if (!key) return;
	const cur = loadSelection(key);
	const next: Selection = { agentId: patch.agentId !== undefined ? patch.agentId : cur.agentId, convs: patch.conv ? { ...cur.convs, [patch.conv.agentId]: patch.conv.convId } : cur.convs };
	saveSelection(key, next);
}

const isVisible = () => document.visibilityState === "visible";
let readTimer: number | undefined;

export const useStore = create<State>((set, get) => ({
	conn: "connecting",
	system: null,
	agents: [],
	current: null,
	subagent: null,
	subagentTabs: [],
	openSubagent: (r) => set((s) => ({ subagent: r.id, subagentTabs: s.subagentTabs.some((t) => t.id === r.id) ? s.subagentTabs : [...s.subagentTabs, { id: r.id, task: r.task, agent_id: r.agent_id, conversation_id: r.conversation_id, roomId: s.room }], drawer: false })),
	closeSubagent: (id) => set((s) => ({ subagentTabs: s.subagentTabs.filter((t) => t.id !== id), subagent: s.subagent === id ? null : s.subagent })),
	rooms: [],
	room: new URLSearchParams(location.search).get("room"),
	roomMsgs: {},
	paneAgent: null,
	messages: {},
	convs: {},
	msgState: {},
	selKey: "",
	memoryVersion: 0,
	hindsightVersion: 0,
	downloads: {},
	hostVersion: 0,
	actionsVersion: 0,
	channelsVersion: 0,
	proactiveVersion: 0,
	inbox: false,
	routinesVersion: 0,
	skillsVersion: 0,
	localLayaVersion: 0,
	extVersion: 0,
	tasks: {},
	pendingDevices: [],
	loginEvents: {},
	cloudflareSteps: [],
	tunnelSteps: [],
	desktopVersion: 0,
	drawer: false,
	info: loadLayout().info,
	layout: loadLayout(),
	infoTab: "overview",
	settings: new URLSearchParams(location.search).get("settings"),
	theme: (localStorage.getItem("pia.theme") as Theme) || (getTheme(localStorage.getItem("pia.skin")).defaultMode ?? "system"),
	skin: getTheme(localStorage.getItem("pia.skin")).id,
	accent: localStorage.getItem("pia.accent") ?? "",
	fileVersion: 0,
	set: (p) => {
		set(p);
		// 右侧面板开关按设备记住（只在宽屏常驻时有意义；窄屏打开的抽屉不记）
		if (p.info !== undefined && window.innerWidth >= 1200) {
			const layout = { ...get().layout, info: p.info };
			set({ layout });
			saveLayout(layout);
		}
	},
	setLayout: (p) => {
		const layout = { ...get().layout, ...p };
		set({ layout });
		saveLayout(layout);
	},
	async loadSystem() {
		const system = await api<SystemInfo>("/api/system");
		// 选择按账号隔离：服务器 id + 设备 id 决定存储 key，换账号读不到对方的 id
		set({ system, selKey: selectionKey(system.serverId, system.deviceId) });
	},
	async loadAgents() {
		const agents = await api<Agent[]>("/api/agents");
		const st = get();
		const stored = loadSelection(st.selKey).agentId;
		const requested = new URLSearchParams(location.search).get("agent");
		const r = resolveInitialAgent({ agents, current: st.current, requested, stored });
		set({ agents, current: r.agentId });
		// 首次打开 / 上次的助理已删除 → 只回退一次并记下；有效选择不覆盖
		if (r.persist) persistSelection(st.selKey, { agentId: r.agentId });
	},
	async loadRooms() {
		const rooms = await api<Room[]>("/api/rooms");
		set({ rooms, room: get().room && !rooms.some((r) => r.id === get().room) ? null : get().room });
	},
	async selectRoom(id) {
		set({ room: id, drawer: false, paneAgent: null, ...(get().room !== id ? { subagent: null } : {}) });
		// 首屏只拉最近一批：群历史可能很长，一次性 200 条 + 大 meta 在手机网络上很慢。更早的消息由「更早的消息」按需加载。
		const msgs = await api<Message[]>(`/api/rooms/${id}/messages?limit=${ROOM_PAGE}`);
		set((s) => ({ roomMsgs: { ...s.roomMsgs, [id]: msgs }, rooms: s.rooms.map((r) => (r.id === id ? { ...r, unread: 0 } : r)) }));
		void api(`/api/rooms/${id}/read`, { method: "POST" }).catch(() => {});
	},
	async selectAgent(id) {
		set((s) => ({ current: id, drawer: false, room: null, ...(s.current !== id || s.room ? { subagent: null } : {}) }));
		persistSelection(get().selKey, { agentId: id });
		const req = newRequest(id);
		set((s) => ({ msgState: { ...s.msgState, [id]: { ...MSG_BASE, ...(s.msgState[id] ?? {}), loading: true, error: null, loaded: false } } }));
		try {
			const c = await get().loadConversations(id);
			if (reqGen[id] !== req.gen) return; // 期间又切走了：丢弃这次结果
			// 服务端 current 是权威；只有它不在列表里才退回本地记录（仍须属于这个助理）
			const stored = storedConversation(loadSelection(get().selKey), id);
			const target = c.items.some((x) => x.id === c.current) ? c.current : stored && c.items.some((x) => x.id === stored) ? stored : c.current;
			if (target !== c.current) {
				set((s) => ({ convs: { ...s.convs, [id]: { ...c, current: target } } }));
				void api(`/api/agents/${id}/conversations/${target}/select`, { method: "POST" }).catch(() => {});
			}
			await get().loadMessages(id, target, req);
		} catch (e) {
			if (reqGen[id] !== req.gen) return;
			set((s) => ({ msgState: { ...s.msgState, [id]: { ...MSG_BASE, ...(s.msgState[id] ?? {}), loading: false, error: errText(e), loaded: false } } }));
		}
		void get().loadTasks(id);
		void api(`/api/agents/${id}/read`, { method: "POST" }).catch(() => {});
	},
	async loadConversations(id) {
		const c = await api<{ current: string; items: Conversation[] }>(`/api/agents/${id}/conversations`);
		set((s) => ({ convs: { ...s.convs, [id]: c } }));
		return c;
	},
	async loadMessages(agentId, convId, req) {
		const r = req ?? newRequest(agentId);
		set((s) => ({ msgState: { ...s.msgState, [agentId]: { ...MSG_BASE, ...(s.msgState[agentId] ?? {}), loading: true, error: null, loaded: false } } }));
		try {
			const msgs = await api<Message[]>(`/api/agents/${agentId}/messages?limit=${PAGE}&conversation=${convId}`, { signal: r.signal });
			if (reqGen[agentId] !== r.gen) return; // 晚返回的旧请求不覆盖新目标
			set((s) => {
				// 同一对话：并进本地还没落库的乐观 / 流式消息；换了对话：直接替换，不混
				const sameConv = s.msgState[agentId]?.conv === convId;
				const list = sameConv ? mergeMessages(msgs, s.messages[agentId]) : msgs;
				return { messages: { ...s.messages, [agentId]: list }, msgState: { ...s.msgState, [agentId]: { loading: false, error: null, loaded: true, conv: convId, hasMore: msgs.length >= PAGE } } };
			});
		} catch (e) {
			if (reqGen[agentId] !== r.gen) return;
			set((s) => ({ msgState: { ...s.msgState, [agentId]: { ...MSG_BASE, ...(s.msgState[agentId] ?? {}), loading: false, error: errText(e), loaded: false } } }));
		}
	},
	async retryMessages(agentId) {
		const conv = get().convs[agentId]?.current;
		if (!conv) return get().selectAgent(agentId);
		await get().loadMessages(agentId, conv);
	},
	async loadMoreMessages(agentId) {
		const st = get().msgState[agentId];
		const list = get().messages[agentId] ?? [];
		if (!st || st.loading || !st.hasMore || !st.conv || !list.length) return;
		const gen = reqGen[agentId] ?? 0;
		const conv = st.conv;
		set((s) => ({ msgState: { ...s.msgState, [agentId]: { ...(s.msgState[agentId] ?? MSG_BASE), loading: true, error: null } } }));
		try {
			const older = await api<Message[]>(`/api/agents/${agentId}/messages?${olderParams(PAGE, conv, list[0])}`);
			if ((reqGen[agentId] ?? 0) !== gen) return;
			set((s) => ({ messages: { ...s.messages, [agentId]: mergeMessages(older, s.messages[agentId]) }, msgState: { ...s.msgState, [agentId]: { ...(s.msgState[agentId] ?? MSG_BASE), loading: false, error: null, loaded: true, conv, hasMore: older.length >= PAGE } } }));
		} catch (e) {
			if ((reqGen[agentId] ?? 0) !== gen) return;
			set((s) => ({ msgState: { ...s.msgState, [agentId]: { ...(s.msgState[agentId] ?? MSG_BASE), loading: false, error: errText(e) } } }));
		}
	},
	async switchConversation(agentId, convId) {
		set({ subagent: null });
		persistSelection(get().selKey, { conv: { agentId, convId } });
		const req = newRequest(agentId);
		// 立即切到目标并进入 loading：不显示旧对话内容（避免旧 chat flash）
		set((s) => ({
			convs: { ...s.convs, [agentId]: { ...(s.convs[agentId] ?? { items: [] }), current: convId } },
			messages: { ...s.messages, [agentId]: [] },
			msgState: { ...s.msgState, [agentId]: { ...MSG_BASE, conv: convId, loading: true } },
		}));
		try {
			await api(`/api/agents/${agentId}/conversations/${convId}/select`, { method: "POST" });
			await get().loadMessages(agentId, convId, req);
		} catch (e) {
			if (reqGen[agentId] !== req.gen) return;
			set((s) => ({ msgState: { ...s.msgState, [agentId]: { ...MSG_BASE, conv: convId, loading: false, error: errText(e) } } }));
		}
	},
	async newConversation(agentId) {
		const c = await api<Conversation>(`/api/agents/${agentId}/conversations`, { method: "POST", json: {} });
		await get().switchConversation(agentId, c.id);
		void get().loadConversations(agentId);
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
		const patchRooms = (fn: (l: Message[]) => Message[], only?: string | null) => {
			const all = get().roomMsgs;
			const next: Record<string, Message[]> = {};
			let hit = false;
			for (const [k, l] of Object.entries(all)) {
				if (only && k !== only) continue;
				const n = fn(l);
				if (n !== l) (next[k] = n), (hit = true);
			}
			if (hit) set({ roomMsgs: { ...all, ...next } });
		};
		switch (e.type) {
			case "message.created": {
				const m = e.message as Message;
				if (m.subagent_id) break;
				if (m.room_id) {
					const rid = m.room_id;
					if (get().roomMsgs[rid]) patchRooms((l) => (l.some((x) => x.id === m.id) ? l : [...l, m]), rid);
					const viewing = get().room === rid && isVisible();
					set({ rooms: get().rooms.map((r) => (r.id === rid ? { ...r, unread: viewing ? 0 : r.unread + (m.role === "assistant" || m.role === "card" ? 1 : 0), last: (m.role === "user" || m.role === "assistant") && m.content ? { content: m.content, role: m.role, agent_id: m.agent_id, created_at: m.created_at } : r.last, updated_at: m.created_at } : r)) });
					if (viewing) {
						clearTimeout(readTimer);
						readTimer = window.setTimeout(() => api(`/api/rooms/${rid}/read`, { method: "POST" }).catch(() => {}), 400);
					}
					break;
				}
				if (m.task_id) break;
				const cur = get().convs[m.agent_id]?.current;
				if (!cur || !m.conversation_id || m.conversation_id === cur) patchMsgs(m.agent_id, (l) => (l.some((x) => x.id === m.id) ? l : [...l, m]));
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
				if (e.taskId || e.subagentId) break;
				{
					// 原生思考增量进 meta.thinking（折叠显示），正文增量进 content
					const add = (m: Message) => (e.thinking ? { ...m, meta: { ...m.meta, thinking: String(m.meta?.thinking ?? "") + e.delta } } : { ...m, content: m.content + e.delta });
					patchRooms((l) => (l.some((m) => m.id === e.id) ? l.map((m) => (m.id === e.id ? add(m) : m)) : l));
					patchMsgs(e.agentId, (l) => l.map((m) => (m.id === e.id ? add(m) : m)));
				}
				break;
			case "message.updated": {
				const m = e.message as Message;
				if (m.subagent_id) break;
				if (m.room_id) {
					patchRooms((l) => (l.some((x) => x.id === m.id) ? l.map((x) => (x.id === m.id ? { ...m, seq: x.seq } : x)) : l), m.room_id);
					break;
				}
				if (m.task_id) break;
				patchMsgs(m.agent_id, (l) => l.map((x) => (x.id === m.id ? m : x)));
				if (m.role === "assistant" && m.status === "done")
					set({ agents: get().agents.map((a) => (a.id === m.agent_id ? { ...a, last: { content: m.content, role: m.role, created_at: m.created_at } } : a)) });
				break;
			}
			case "message.deleted":
				patchRooms((l) => (l.some((m) => m.id === e.id) ? l.filter((m) => m.id !== e.id) : l));
				if (!e.taskId) patchMsgs(e.agentId, (l) => l.filter((m) => m.id !== e.id));
				break;
			case "rooms.changed":
				void get().loadRooms();
				break;
			case "room.state":
				set({ rooms: get().rooms.map((r) => (r.id === e.roomId ? { ...r, state: e.state } : r)) });
				break;
			case "room.read":
				set({ rooms: get().rooms.map((r) => (r.id === e.roomId ? { ...r, unread: 0 } : r)) });
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
			case "tunnel.setup": {
				const cur = get().tunnelSteps.filter((x) => x.step !== e.step);
				set({ tunnelSteps: [...cur, { step: e.step, state: e.state, detail: e.detail }] });
				break;
			}
			case "settings.changed":
				void get().loadSystem();
				break;
			case "conversations.changed": {
				const prev = get().convs[e.agentId]?.current;
				if (!get().convs[e.agentId] && e.agentId !== get().current) break;
				void get()
					.loadConversations(e.agentId)
					.then((c) => {
						// 其他设备切换/新建了对话：跟着切过去
						if (c.current !== prev && e.agentId === get().current) void get().switchConversation(e.agentId, c.current);
					});
				break;
			}
			case "memory.changed":
				set({ memoryVersion: get().memoryVersion + 1 });
				break;
			case "proactive.changed":
				set({ proactiveVersion: get().proactiveVersion + 1 });
				break;
			case "channels.changed":
			case "email.changed":
				set({ channelsVersion: get().channelsVersion + 1 });
				break;
			case "host.changed":
				set({ hostVersion: get().hostVersion + 1 });
				break;
			case "action.logged":
				set({ actionsVersion: get().actionsVersion + 1 });
				break;
			case "downloads.changed": {
				const it = (e as unknown as { item: { id: string } | null }).item;
				if (it) set({ downloads: { ...get().downloads, [it.id]: it as never } });
				break;
			}
			case "memory.hindsight":
			case "memory.sync":
				set({ hindsightVersion: get().hindsightVersion + 1 });
				break;
			case "routines.changed":
				set({ routinesVersion: get().routinesVersion + 1 });
				break;
			case "skills.changed":
				set({ skillsVersion: get().skillsVersion + 1 });
				break;
			case "local-laya.changed":
				set({ localLayaVersion: get().localLayaVersion + 1 });
				break;
			case "mcp.changed":
			case "packages.changed":
				set({ extVersion: get().extVersion + 1 });
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
