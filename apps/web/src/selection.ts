/**
 * 助理 / 对话选择的持久化与恢复（纯函数，便于单测）。
 *
 * 背景：以前每次打开（尤其手机）都默认显示列表第一个助理，因为「当前助理」只存在内存里，
 * 刷新 / 重开就丢，`loadAgents` 又用 `agents[0]` 兜底。这里把用户**明确打开过**的助理和
 * 对话记在本地，下次打开恢复；同时按账号隔离、失效回退只做一次、不覆盖有效选择。
 *
 * 约束：
 * - 只持久化公开 id（助理 id、每个助理最近打开的对话 id），不存消息、不存 token / 凭据。
 * - key 由「服务器 id + 设备 id」组成：换服务器 / 换账号读不到对方的 id。
 * - 恢复优先级：内存里仍有效的当前选择 > 地址栏 ?agent= > 上次明确打开 > 第一个（仅一次）。
 * - 群聊（room）不是助理，回退时只在用户自己的助理里挑。
 */

export interface Selection {
	agentId: string | null;
	/** agentId → 最近明确打开的对话 id */
	convs: Record<string, string>;
}

const PREFIX = "pia.sel";
export const EMPTY_SELECTION: Selection = { agentId: null, convs: {} };

const sanitize = (s?: string | null) => String(s ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);

/** 账号隔离的存储 key。serverId / deviceId 缺失时退化为同源本地，仍然不跨账号。 */
export function selectionKey(serverId?: string | null, deviceId?: string | null) {
	return `${PREFIX}.${sanitize(serverId) || "local"}.${sanitize(deviceId) || "device"}`;
}

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem">;

export function loadSelection(key: string, store: ReadStore = localStorage): Selection {
	try {
		const raw = store.getItem(key);
		if (!raw) return { ...EMPTY_SELECTION, convs: {} };
		const j = JSON.parse(raw) as Partial<Selection>;
		const convs: Record<string, string> = {};
		if (j && typeof j.convs === "object" && j.convs) {
			for (const [k, v] of Object.entries(j.convs)) if (typeof v === "string" && v) convs[k] = v;
		}
		return { agentId: typeof j?.agentId === "string" && j.agentId ? j.agentId : null, convs };
	} catch {
		return { ...EMPTY_SELECTION, convs: {} };
	}
}

export function saveSelection(key: string, sel: Selection, store: WriteStore = localStorage) {
	try {
		store.setItem(key, JSON.stringify({ agentId: sel.agentId ?? null, convs: sel.convs ?? {} }));
	} catch {
		/* 隐私模式 / 配额满：不影响使用 */
	}
}

export interface ResolveInput {
	/** 当前全部助理（含群专属） */
	agents: { id: string; scope?: string | null }[];
	/** 内存里当前选择（重连时不要被覆盖） */
	current?: string | null;
	/** 地址栏 ?agent= */
	requested?: string | null;
	/** 上次持久化的选择 */
	stored?: string | null;
}
export interface Resolved {
	agentId: string | null;
	source: "current" | "requested" | "stored" | "first" | "none";
	/** true = 应把结果写回持久化（首次 / 失效回退）；false = 沿用已有有效选择，不要覆盖 */
	persist: boolean;
}

/**
 * 解析要显示的助理。只认确实存在的 id；回退到第一个用户助理只在「什么都没有」时发生一次。
 * 已删除的 stored id 会落到 first 并回写，不会一直卡在坏 id。
 */
export function resolveInitialAgent({ agents, current, requested, stored }: ResolveInput): Resolved {
	const ids = new Set(agents.map((a) => a.id));
	const pick = (id?: string | null) => (id && ids.has(id) ? id : null);
	const cur = pick(current);
	if (cur) return { agentId: cur, source: "current", persist: false };
	const req = pick(requested);
	if (req) return { agentId: req, source: "requested", persist: true };
	const sto = pick(stored);
	if (sto) return { agentId: sto, source: "stored", persist: false };
	const first = agents.find((a) => a.scope !== "room")?.id ?? agents[0]?.id ?? null;
	return first ? { agentId: first, source: "first", persist: true } : { agentId: null, source: "none", persist: false };
}

/** 本地记录的对话选择（仅提示；服务端 current 仍是权威）。 */
export function storedConversation(sel: Selection, agentId: string): string | null {
	return sel.convs[agentId] ?? null;
}

/**
 * 把「已显示但后端这次 history 里还没有」的消息并进来：用户刚发的乐观消息 / 流式消息
 * 不会被迟到的 history 覆盖，后台刷新也不会清空已显示内容。
 * 只在同一对话内合并；调用方负责在不同对话之间清空。
 */
export function mergeMessages<T extends { id: string; created_at: number; seq?: number | null }>(fetched: T[], existing: T[] | undefined): T[] {
	if (!existing?.length) return fetched;
	const seen = new Set(fetched.map((m) => m.id));
	const extra = existing.filter((m) => !seen.has(m.id));
	if (!extra.length) return fetched;
	return [...fetched, ...extra].sort((a, b) => a.created_at - b.created_at || (a.seq ?? 0) - (b.seq ?? 0));
}
