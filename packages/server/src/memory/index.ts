/**
 * 记忆注册中心 + 作用域服务。
 *  - MemoryRegistry：后端注册表；全局设置 `memoryProvider`，助理可单独覆盖（agents.memory_provider）；默认 basic
 *  - 作用域（与后端无关，存在条目 meta 里）：
 *      user          → 记忆库 `user`（所有助理共享的“关于用户”的事实）
 *      agent         → 记忆库 `agent_<id>`
 *      conversation  → 记忆库 `agent_<id>`，meta.conversationId 限定只在该对话可见
 *      task          → 记忆库 `agent_<id>`，meta.taskId 限定任务/子代理范围内可见（短期草稿，默认 7 天）
 *  - 种类：fact（资料，总是注入）/ experience（按日日志）/ note（短期便签，meta.expiresAt 到期后不再可见）
 *  - 来源分层（memory-scope-safety，依据 docs/research/hindsight-integration-audit.md）：
 *      主会话/用户写入 → verified；子代理/后台/群来源写入 → draft（默认进 task 草稿，绝不直接进共享 user 库）；
 *      草稿由主会话核验后 promote 成 verified。写入者身份由服务端按会话上下文注入，工具参数无法伪造。
 * 以后接入 Hindsight / MemOS：实现 MemoryProvider 并 register，ext-memory 与界面都不用改。
 */
import { config } from "../config.ts";
import { db, getSetting } from "../db.ts";
import { basicMemory } from "./basic.ts";
import { hindsightMemory } from "./hindsight/provider.ts";
import type { MemoryExport, MemoryItem, MemoryProvider, ReflectScope } from "./types.ts";

export type { MemoryItem, MemoryProvider, ReflectScope } from "./types.ts";
export type Scope = "user" | "agent" | "conversation" | "task";
export type Kind = "fact" | "experience" | "note";
export type MemoryActor = "main" | "subagent" | "background" | "user" | "group";
export type MemoryStatus = "draft" | "verified" | "promoted" | "legacy";
export const USER_BANK = "user";
export const agentBank = (agentId: string) => `agent_${agentId}`;
const DAY = 86_400_000;

/** 每条记忆的来源信息（写进 meta.origin，服务端注入，工具参数不可伪造） */
export interface MemoryOrigin {
	actor: MemoryActor;
	assistantId: string;
	conversationId?: string | null;
	taskId?: string | null;
	subagentId?: string | null;
	/** 来源说明（agent / user / subagent / background / promotion） */
	source?: string;
	/** 只放安全 ID（如晋升来源记忆 id / taskId），绝不写任务正文或敏感内容 */
	evidenceRef?: string | null;
	/** 晋升合并到已有条目时累积的多条安全证据 id（不覆盖旧的） */
	evidenceRefs?: string[];
	createdAt: string;
	status: MemoryStatus;
	/** 已晋升草稿指向的目标条目 id */
	promotedTo?: string | null;
}

/** 服务端按会话上下文注入的写入者身份 */
export interface WriteContext {
	actor?: MemoryActor;
	taskId?: string | null;
	subagentId?: string | null;
	conversationId?: string | null;
}

/** 读取上下文：决定 task/conversation 作用域与草稿是否可见 */
export interface ReadContext {
	/** undefined = 不按对话过滤（界面列表）；null = 主会话无对话上下文 */
	conversationId: string | null | undefined;
	taskId: string | null;
	/** 主会话/用户（父）视角：能读到本助理下的全部草稿用于核验 */
	parent: boolean;
}

/** reflect 的读取上下文：决定源端 tag 允许集合 */
export interface ReflectContext {
	actor?: MemoryActor;
	conversationId?: string | null;
	taskId?: string | null;
	parent?: boolean;
}

const privileged = (actor?: MemoryActor) => actor === "main" || actor === "user";

const providers = new Map<string, MemoryProvider>([
	[basicMemory.id, basicMemory],
	[hindsightMemory.id, hindsightMemory],
]);
const inited = new Set<string>();
const banks = new Set<string>();

export function registerMemoryProvider(p: MemoryProvider) {
	providers.set(p.id, p);
}
export const listMemoryProviders = () => [...providers.values()].map((p) => ({ id: p.id, name: p.name, capabilities: p.capabilities }));
export const globalMemoryProviderId = () => {
	const id = getSetting<string>("memoryProvider", "basic");
	return providers.has(id) ? id : "basic";
};
/** 是否有助理（或全局默认）在用 Hindsight */
export function hindsightInUse() {
	if (globalMemoryProviderId() === "hindsight") return true;
	return !!db.prepare("SELECT 1 FROM agents WHERE memory_provider = 'hindsight' LIMIT 1").get();
}
export function providerFor(agentId: string): MemoryProvider {
	const row = db.prepare("SELECT memory_provider FROM agents WHERE id = ?").get(agentId) as { memory_provider: string | null } | undefined;
	return providers.get(row?.memory_provider ?? "") ?? providers.get(globalMemoryProviderId())!;
}
async function ready(p: MemoryProvider, bank: string, agentId: string) {
	if (!inited.has(p.id)) {
		await p.init({ dataDir: config.dataDir, log: (m) => console.log(`[memory:${p.id}] ${m}`) });
		inited.add(p.id);
	}
	const key = `${p.id}:${bank}`;
	if (!banks.has(key)) {
		const a = db.prepare("SELECT name, persona FROM agents WHERE id = ?").get(agentId) as { name: string; persona: string } | undefined;
		await p.ensureBank(bank, bank === USER_BANK ? { name: "用户（所有助理共享）", language: "zh" } : { name: a?.name ?? bank, persona: a?.persona, language: "zh" });
		banks.add(key);
	}
	return p;
}

export interface ScopedItem extends MemoryItem {
	bank: string;
	scope: Scope;
	kind: Kind;
	status: MemoryStatus;
	origin?: MemoryOrigin;
	expiresAt?: number;
	conversationId?: string;
	taskId?: string;
}
function scoped(it: MemoryItem, bank: string): ScopedItem {
	const m = it.meta ?? {};
	const origin = m.origin as MemoryOrigin | undefined;
	const taskId = (m.taskId as string | undefined) ?? origin?.taskId ?? undefined;
	const scope = (bank === USER_BANK ? "user" : m.conversationId ? "conversation" : taskId ? "task" : "agent") as Scope;
	const kind = ((m.kind as string) === "log" ? "experience" : ((m.kind as string) ?? it.kind ?? "fact")) as Kind;
	return {
		...it,
		bank,
		scope,
		kind,
		status: origin?.status ?? "legacy",
		origin,
		expiresAt: (m.expiresAt as number | undefined) ?? undefined,
		conversationId: (m.conversationId as string | undefined) ?? undefined,
		taskId,
	};
}
/** 条目对某个读取上下文是否可见；task/草稿按 taskId 隔离，父视角可读全部草稿 */
export function memoryVisible(it: ScopedItem, ctx: ReadContext): boolean {
	if (it.expiresAt && it.expiresAt <= Date.now()) return false;
	if (it.status === "promoted") return false;
	if (it.scope === "conversation" && ctx.conversationId !== undefined && it.conversationId !== ctx.conversationId) return false;
	if (it.scope === "task" && !ctx.parent && it.taskId !== ctx.taskId) return false;
	if (it.status === "draft" && !ctx.parent && (it.taskId ?? null) !== (ctx.taskId ?? null)) return false;
	return true;
}
const readCtx = (conversationId: string | null | undefined, o?: { taskId?: string | null; parent?: boolean }): ReadContext => {
	const taskId = o?.taskId ?? null;
	return { conversationId, taskId, parent: o?.parent ?? !taskId };
};
export function isParentView(o?: { taskId?: string | null; parent?: boolean }) {
	return o?.parent ?? !o?.taskId;
}

export interface RememberArgs {
	content: string;
	kind?: Kind | "log";
	scope?: Scope;
	ttlDays?: number;
	source?: string;
	/** 服务端注入的写入者身份（工具参数里没有这些字段，模型伪造不了） */
	actor?: MemoryActor;
	taskId?: string | null;
	subagentId?: string | null;
	/** 晋升时用：来源记忆 id（只存安全 ID） */
	evidenceRef?: string | null;
	promotedFrom?: string | null;
}

const taskDraftTtlDays = () => {
	const n = Number(getSetting<number>("memoryTaskDraftTtlDays", 7));
	return Number.isFinite(n) && n > 0 ? n : 7;
};

/** 写入前的简单密钥扫描：疑似密码/令牌的内容不进记忆 */
const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passwd|密码)\s*[:：=]\s*\S{4,})/i;

const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();

/** 不过滤状态的原始条目（晋升/驳回需要看到已 promoted 的草稿） */
async function rawItems(agentId: string): Promise<ScopedItem[]> {
	const p = providerFor(agentId);
	const out: ScopedItem[] = [];
	for (const bank of [USER_BANK, agentBank(agentId)]) {
		await ready(p, bank, agentId);
		out.push(...(await p.list(bank, { limit: 1000 })).items.map((i) => scoped(i, bank)));
	}
	return out;
}

/** 条目是否由该写入者拥有（用于直接删除/更新） */
function ownedBy(hit: ScopedItem, ctx: WriteContext): boolean {
	const o = hit.origin;
	if (!o) return false; // legacy：没有写入者，按他人/共享处理
	if (o.status === "promoted") return false; // 已晋升的共享条目
	const actor = ctx.actor ?? "main";
	if (actor === "subagent") return o.actor === "subagent" && !!ctx.subagentId && o.subagentId === ctx.subagentId;
	if (actor === "background" || actor === "group") return (o.actor === "background" || o.actor === "group") && !!ctx.taskId && o.taskId === ctx.taskId;
	return false;
}
/** 能否直接删除/更新：主会话/用户（含无 ctx 的内部可信调用）可改任何条目；其余只能改本任务/本人写入的草稿 */
export function canMutate(hit: ScopedItem, ctx: WriteContext): boolean {
	// ctx.actor 缺省视为可信主会话（与 ownedBy 的 ctx.actor ?? "main" 一致）；模型侧调用一律显式注入 actor。
	if (privileged(ctx.actor ?? "main")) return true;
	return ownedBy(hit, ctx);
}

/**
 * 本轮召回用的查询：只取「这一轮真正要做的事」，不拿整段提示词的开头。
 *  - 群聊：去掉「（群聊「…」里的新消息 · 你是 …）」头和派活/任务说明，取最后一条【用户】消息（没有就取最后一条消息）
 *  - 后台子代理任务：取任务本身（去掉“必要上下文”）
 *  - 其他：原样
 * 最长 200 字（取末尾：最近的话最相关）。
 */
export function recallQuery(prompt: string, max = 200): string {
	let t = (prompt ?? "").trim();
	if (t.startsWith("（群聊「")) {
		const body = t.split("\n").slice(1).join("\n").split(/\n——\n/)[0] ?? "";
		const msgs = body.split("\n").filter((l) => /^【[^】]+】/.test(l));
		const pick = [...msgs].reverse().find((l) => l.startsWith("【用户】")) ?? msgs.at(-1) ?? "";
		t = pick.replace(/^【[^】]+】/, "").trim();
	} else if (/^（后台(?:子代理|帮手)任务）/.test(t)) t = t.replace(/^（后台(?:子代理|帮手)任务）/, "").split("\n\n必要上下文")[0].trim(); // 旧消息里是「子代理」
	return t.length > max ? t.slice(-max) : t;
}

export const memory = {
	/** 一轮结束：后端支持就自动写入这一轮（只进助理自己的库；非主会话来源记成草稿，与 remember 同一套分层） */
	async retainTurn(agentId: string, conversationId: string | null, turn: { user: string; assistant: string; actor?: MemoryActor; taskId?: string | null }) {
		const p = providerFor(agentId);
		if (!p.retainTurn) return;
		const user = recallQuery(turn.user, 4000);
		if (!user || turn.assistant.trim().length < 2 || SECRET_RE.test(user) || SECRET_RE.test(turn.assistant)) return;
		const actor = turn.actor ?? "main";
		const bank = agentBank(agentId);
		await ready(p, bank, agentId);
		await p.retainTurn(bank, { user, assistant: turn.assistant, conversationId, taskId: turn.taskId ?? null, actor, status: privileged(actor) ? "verified" : "draft", assistantId: agentId });
	},

	async remember(agentId: string, conversationId: string | null, a: RememberArgs) {
		if (SECRET_RE.test(a.content)) throw new Error("内容看起来包含密码或密钥，出于安全不写入记忆");
		const actor: MemoryActor = a.actor ?? "main";
		const priv = privileged(actor);
		const kind: Kind = a.kind === "log" ? "experience" : (a.kind ?? "fact");
		let scope: Scope = a.scope ?? (kind === "fact" ? "user" : "agent");
		// 分层：非主/用户来源不能直接写共享 user 库 → 降级为 task 草稿（没有任务上下文时退为 agent 草稿）
		if (!priv && scope === "user") scope = a.taskId ? "task" : "agent";
		const taskId = a.taskId ?? null;
		if (scope === "task" && !taskId) scope = "agent";
		if (scope === "conversation" && !conversationId) throw new Error("当前没有对话，不能保存对话级记忆");
		if (scope === "task" && !conversationId && !taskId) throw new Error("当前没有任务上下文，不能保存任务级记忆");
		const bank = scope === "user" ? USER_BANK : agentBank(agentId);
		const status: MemoryStatus = priv ? "verified" : "draft";
		const ttl = a.ttlDays ?? (kind === "note" ? 7 : scope === "task" ? taskDraftTtlDays() : undefined);
		const origin: MemoryOrigin = {
			actor,
			assistantId: agentId,
			conversationId: scope === "conversation" ? conversationId : null,
			taskId: taskId ?? null,
			subagentId: a.subagentId ?? null,
			source: a.source ?? (priv ? "user" : actor),
			evidenceRef: a.evidenceRef ?? null,
			createdAt: new Date().toISOString(),
			status,
			promotedTo: null,
		};
		const p = await ready(providerFor(agentId), bank, agentId);
		const r = await p.remember(bank, {
			content: a.content,
			timestamp: new Date().toISOString(),
			// 已确认写入保持账本同文本去重；草稿不去重，避免不同任务的同文本草稿被并成一行、跨任务串位
			dedupe: priv,
			meta: {
				kind,
				source: origin.source,
				...(scope === "conversation" ? { conversationId } : {}),
				...(taskId ? { taskId } : {}),
				...(ttl ? { expiresAt: Date.now() + ttl * DAY } : {}),
				origin,
			},
		});
		return { id: r.ids?.[0] ?? "", bank, scope, kind, status, async: !!r.async };
	},

	async recall(agentId: string, conversationId: string | null, query: string, limit = 8, opts?: { taskId?: string | null; parent?: boolean }): Promise<ScopedItem[]> {
		const p = providerFor(agentId);
		const ctx = readCtx(conversationId, opts);
		// 两个库同时查（以前一个接一个，慢的时候两段时间叠加）
		const banksOut = await Promise.all(
			[agentBank(agentId), USER_BANK].map(async (bank) => {
				await ready(p, bank, agentId);
				return (await p.recall(bank, query, { limit: limit * 2 })).map((i) => scoped(i, bank)).filter((i) => memoryVisible(i, ctx));
			}),
		);
		const out = banksOut.flat();
		return out.sort((x, y) => (y.score ?? 0) - (x.score ?? 0)).slice(0, limit);
	},

	async list(agentId: string, conversationId?: string | null, q?: string, opts?: { taskId?: string | null; parent?: boolean }): Promise<ScopedItem[]> {
		const p = providerFor(agentId);
		const ctx = readCtx(conversationId, opts);
		const out: ScopedItem[] = [];
		for (const bank of [USER_BANK, agentBank(agentId)]) {
			await ready(p, bank, agentId);
			out.push(...(await p.list(bank, { limit: 500, q })).items.map((i) => scoped(i, bank)));
		}
		// 过期便签不再显示；对话级/任务级/草稿按读取上下文过滤（父视角可看全部草稿）
		return out.filter((i) => memoryVisible(i, ctx));
	},

	/** 列出本助理下待核验的 task 草稿（父视角） */
	async listDrafts(agentId: string): Promise<ScopedItem[]> {
		return (await memory.list(agentId, undefined, undefined, { parent: true })).filter((i) => i.status === "draft");
	},

	/** 本轮注入给模型的记忆块 */
	async context(agentId: string, conversationId: string | null, prompt: string, budgetChars = 6000, opts?: { taskId?: string | null; parent?: boolean }): Promise<string> {
		const p = providerFor(agentId);
		const ctx = readCtx(conversationId, opts);
		const all = await memory.list(agentId, conversationId, undefined, opts);
		const vis = all.filter((i) => memoryVisible(i, ctx));
		// 明确记下的事实按作用域筛选（别的对话/任务的记忆不会混进来）；草稿单独标注，不混进长期事实
		const facts = vis.filter((i) => i.kind === "fact" && i.status !== "draft");
		const drafts = vis.filter((i) => i.status === "draft");
		const insights: string[] = [];
		if (p.capabilities.mentalModels && p.bootContext)
			for (const bank of [USER_BANK, agentBank(agentId)]) {
				await ready(p, bank, agentId);
				const b = (await p.bootContext(bank).catch(() => "")).trim();
				if (b) insights.push(...b.split("\n"));
			}
		const notes = vis.filter((i) => i.kind === "note" && i.status !== "draft");
		const logs = vis.filter((i) => i.kind === "experience" && i.status !== "draft" && Date.now() - Date.parse(i.createdAt) < 3 * DAY).slice(0, 15);
		const seen = new Set([...facts, ...drafts, ...notes, ...logs].map((x) => x.id));
		const q = recallQuery(prompt);
		const related = q ? (await memory.recall(agentId, conversationId, q, 5, opts)).filter((i) => !seen.has(i.id)) : [];
		const day = (t: string | number) => new Date(t).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
		const line = (i: ScopedItem) => `- [${i.id}] (${i.scope}${i.status === "draft" ? "/草稿待核验" : ""}) ${i.text}`;
		const parts: string[] = [];
		let used = 0;
		const add = (title: string, lines: string[]) => {
			const keep: string[] = [];
			for (const l of lines) {
				if (used + l.length > budgetChars) break;
				used += l.length;
				keep.push(l);
			}
			if (keep.length) parts.push(`## ${title}\n${keep.join("\n")}`);
		};
		add("关于用户与长期事实", facts.map(line));
		add("自动整理出的认识", insights);
		// 父视角只给草稿入口/计数，不把草稿全文塞进每轮 prompt；子代理视角可读自己的任务草稿
		if (ctx.parent) {
			const pending = drafts.length;
			if (pending) add("待核验的任务草稿", [`- 有 ${pending} 条帮手/后台草稿待核验（用 memory_review 查看并晋升，不要直接当成事实）`]);
		} else {
			add("本任务草稿（未核验）", drafts.map(line));
		}
		add("短期便签", notes.map((i) => `${line(i)}${i.expiresAt ? `（${day(i.expiresAt)} 到期）` : ""}`));
		add("最近几天的日志", logs.map((i) => `- [${i.id}] ${day(i.createdAt)} ${i.text}`));
		add("可能相关的较早记忆", related.map(line));
		return parts.join("\n\n");
	},

	async forget(agentId: string, id: string, ctx: WriteContext = {}) {
		const p = providerFor(agentId);
		const items = await memory.list(agentId, undefined, undefined, { taskId: ctx.taskId ?? null, parent: privileged(ctx.actor) || !ctx.taskId });
		const hit = items.find((i) => i.id === id);
		if (!hit) return false;
		if (!canMutate(hit, ctx)) throw new Error("只能删除本任务/本人写入的草稿；共享或他人写入的记忆需要主会话或用户确认");
		await p.forget(hit.bank, { id });
		return true;
	},

	async update(agentId: string, id: string, patch: { text?: string; kind?: Kind; scope?: Scope }, conversationId?: string | null, ctx: WriteContext = {}) {
		const p = providerFor(agentId);
		const hit = (await memory.list(agentId, undefined, undefined, { taskId: ctx.taskId ?? null, parent: privileged(ctx.actor) || !ctx.taskId })).find((i) => i.id === id);
		if (!hit) return null;
		if (!canMutate(hit, ctx)) throw new Error("只能修改本任务/本人写入的草稿；共享或他人写入的记忆需要主会话或用户确认");
		const scope = patch.scope ?? hit.scope;
		const kind = patch.kind ?? hit.kind;
		const targetBank = scope === "user" ? USER_BANK : agentBank(agentId);
		const status: MemoryStatus = privileged(ctx.actor) ? "verified" : hit.status;
		const origin: MemoryOrigin = { ...(hit.origin ?? { actor: (ctx.actor ?? "main"), assistantId: agentId, createdAt: new Date().toISOString(), source: "user", status: hit.status }), status, createdAt: hit.origin?.createdAt ?? new Date().toISOString() };
		if (targetBank !== hit.bank || !p.update || (scope === "conversation") !== (hit.scope === "conversation")) {
			await p.forget(hit.bank, { id });
			const r = await memory.remember(agentId, scope === "conversation" ? (hit.conversationId ?? conversationId ?? null) : null, { content: patch.text ?? hit.text, kind, scope, source: "user", actor: ctx.actor, taskId: ctx.taskId, subagentId: ctx.subagentId });
			return r.id;
		}
		// 保留原 meta（taskId/conversationId/expiresAt）再改，避免编辑草稿后 TTL/对话/任务标签丢失导致 Hindsight 重打 tag 时作用域漂移
		await p.update(hit.bank, id, { text: patch.text, kind: kind as never, meta: { ...(hit.meta ?? {}), kind, origin } });
		return id;
	},

	/**
	 * 把一条 task 草稿晋升为共享/长期记忆（只有主会话/用户能做）。
	 * 幂等：草稿已是 promoted 直接返回；去重：目标库已有同文本条目则不新增、只补证据（不覆盖）。
	 */
	async promote(agentId: string, draftId: string, opts: { scope?: "user" | "agent"; actor?: MemoryActor; conversationId?: string | null; taskId?: string | null } = {}) {
		const actor: MemoryActor = opts.actor ?? "main";
		if (!privileged(actor)) throw new Error("只有主会话或用户能把草稿晋升为长期记忆");
		const p = providerFor(agentId);
		const all = await rawItems(agentId);
		const draft = all.find((i) => i.id === draftId);
		if (!draft) throw new Error("找不到要晋升的草稿");
		if (draft.origin?.assistantId && draft.origin.assistantId !== agentId) throw new Error("只能晋升本助理的草稿");
		if (draft.origin?.status === "promoted") return { id: draft.origin.promotedTo ?? draftId, promoted: false, deduped: true };
		if (!draft.origin || draft.status === "legacy") throw new Error("只能晋升带来源的草稿");
		const scope = opts.scope ?? "agent";
		const bank = scope === "user" ? USER_BANK : agentBank(agentId);
		await ready(p, bank, agentId);
		const target = (await p.list(bank, { limit: 1000 })).items.map((i) => scoped(i, bank)).filter((i) => i.status !== "promoted");
		// 只与目标库里「已确认」的条目去重；绝不与别的草稿互相合并，否则同文本不同事实会互相吞掉
		const exist = target.find((i) => (i.status === "verified" || i.status === "legacy") && norm(i.text) === norm(draft.text));
		const markPromoted = async (toId: string | null) => {
			if (!p.update) return;
			await p.update(draft.bank, draft.id, { meta: { kind: draft.kind, ...(draft.meta ?? {}), origin: { ...draft.origin, status: "promoted", promotedTo: toId } } });
		};
		if (exist) {
			// 命中已有事实：不新增、不覆盖正文；把草稿 id 累积到证据（保留旧证据，不丢失）
			const evidenceRefs = [...new Set([...(exist.origin?.evidenceRefs ?? []), ...(exist.origin?.evidenceRef ? [exist.origin.evidenceRef] : []), draft.id])];
			const merged: MemoryOrigin = { ...(exist.origin ?? { actor: "user", assistantId: agentId, createdAt: new Date().toISOString(), status: exist.status, source: "user" }), evidenceRef: exist.origin?.evidenceRef ?? draft.id, evidenceRefs };
			if (p.update) await p.update(exist.bank, exist.id, { meta: { kind: exist.kind, ...(exist.meta ?? {}), origin: merged } });
			await markPromoted(exist.id);
			return { id: exist.id, promoted: false, deduped: true };
		}
		if (bank === draft.bank && p.update) {
			// 草稿本就在目标库（agent 级晋升）：原地转正，改 status/清掉 taskId，不新建也不隐藏，否则账本按同文本去重会把草稿行当成新条目又标成 promoted 而消失
			const origin: MemoryOrigin = { ...draft.origin, status: "verified", source: "promotion", taskId: null, conversationId: null, evidenceRef: draft.origin.evidenceRef ?? draft.id };
			const meta = { ...(draft.meta ?? {}), taskId: undefined, conversationId: undefined, expiresAt: undefined, origin };
			await p.update(draft.bank, draft.id, { meta });
			return { id: draft.id, promoted: true, deduped: false };
		}
		const r = await memory.remember(agentId, opts.conversationId ?? null, {
			content: draft.text,
			kind: draft.kind,
			scope,
			source: "promotion",
			actor: "user",
			taskId: opts.taskId ?? null,
			evidenceRef: draft.id,
		});
		await markPromoted(r.id);
		return { id: r.id, promoted: true, deduped: false };
	},

	/** 驳回草稿：标记 promoted（不再可见）但不写入。只有主会话/用户能做。 */
	async rejectDraft(agentId: string, draftId: string, ctx: WriteContext = {}) {
		if (!privileged(ctx.actor)) throw new Error("只有主会话或用户能驳回草稿");
		const p = providerFor(agentId);
		const draft = (await rawItems(agentId)).find((i) => i.id === draftId);
		if (!draft) throw new Error("找不到草稿");
		if (!p.update || !draft.origin) return false;
		// 驳回后清掉 task/conversation 归属：重打 tag 时不再命中「本任务草稿」范围，避免已驳回草稿继续进入 reflect 证据
		const origin = { ...draft.origin, status: "promoted" as const, promotedTo: null, taskId: null, conversationId: null };
		await p.update(draft.bank, draft.id, { meta: { ...(draft.meta ?? {}), taskId: undefined, conversationId: undefined, origin } });
		return true;
	},

	async reflect(agentId: string, query: string, ctx: ReflectContext = {}) {
		const p = providerFor(agentId);
		if (!p.reflect) return null;
		// 反思按库进行：助理自己的库 + 所有助理共享的「关于你」库都问一遍，取依据更多的那个回答，依据合并。
		// 源端隔离：请求里显式限定允许进入反思的记忆范围（provenance tag），服务端按 tag 过滤，
		// 绝不先把整库（含兄弟任务草稿）送给模型、再在下游把输出删掉。
		const actor = ctx.actor ?? "main";
		const privilegedView = privileged(actor) || ctx.parent === true;
		const taskId = ctx.taskId ?? null;
		const conversationId = ctx.conversationId ?? null;
		const leaf = (tags: string[]) => ({ tags, match: "all_strict" as const });
		// 官方 tag 语义（安装包 0.10.3 engine/search/tags.py 已核实）：any/all 含无 tag 条目，any_strict/all_strict/exact 不含；
		// {tags: [], match: "exact"} 即官方「untagged/global」范围，用来保留旧版本（无 provenance tag）的记忆。
		const legacyLane = { tags: [], match: "exact" as const };
		// 共享 user 库由主会话/用户写入（子代理写 user 会被降级为草稿），但仍显式限定：已验证 user + 无 tag 旧条目，
		// 万一库里出现异常 tag 的草稿也不会被非核验视角读到（比整库 all 更 fail closed）。
		const userScope: ReflectScope = privilegedView
			? { all: true }
			: { tagGroups: [{ or: [{ and: [leaf(["scope:user"]), leaf(["status:verified"])] }, legacyLane] }] };
		let agentScope: ReflectScope;
		if (privilegedView) agentScope = { all: true };
		else {
			// 允许集合：已验证的助理级事实 + 本对话的已验证条目 + 本任务自己的草稿（只看 status=draft，
			// 已驳回/已晋升的不再进证据）+ 无 tag 的旧条目（保留旧忆）；兄弟草稿有 task tag，不会命中。
			const groups: unknown[] = [{ and: [leaf(["scope:agent"]), leaf(["status:verified"])] }];
			if (conversationId) groups.push({ and: [leaf(["scope:conversation"]), leaf([`conv:${conversationId}`])] });
			if (taskId) groups.push({ and: [leaf([`task:${taskId}`]), leaf(["status:draft"])] });
			groups.push(legacyLane);
			agentScope = { tagGroups: [{ or: groups }] };
		}
		const banks: [string, ReflectScope][] = [[agentBank(agentId), agentScope], [USER_BANK, userScope]];
		for (const [b] of banks) await ready(p, b, agentId);
		const rs = await Promise.all(banks.map(([b, s]) => p.reflect!(b, query, s).catch((e: unknown) => ({ error: e }))));
		const ok = rs.filter((r): r is Exclude<(typeof rs)[number], { error: unknown }> => !("error" in r));
		if (!ok.length) throw (rs[0] as { error: unknown }).error;
		const best = ok.reduce((a, b) => ((b.citations?.length ?? 0) > (a.citations?.length ?? 0) ? b : a));
		return { answer: best.answer, citations: ok.flatMap((r) => r.citations ?? []) };
	},

	capabilities: (agentId: string) => providerFor(agentId).capabilities,

	async exportAgent(agentId: string) {
		const p = providerFor(agentId);
		if (!p.export) throw new Error("当前记忆后端不支持导出");
		return { agent: await p.export(agentBank(agentId)), user: await p.export(USER_BANK) };
	},

	/** 导入（统一格式）：写进当前后端；agent / user 两个库分别导入 */
	async importAgent(agentId: string, data: { agent?: MemoryExport; user?: MemoryExport } | MemoryExport) {
		const p = providerFor(agentId);
		if (!p.import) throw new Error("当前记忆后端不支持导入");
		const parts = "format" in data ? { agent: data } : data;
		let n = 0;
		for (const [bank, part] of [[agentBank(agentId), parts.agent], [USER_BANK, parts.user]] as const) {
			if (!part) continue;
			if (part.format !== "pi-assistant-memory/1" || !Array.isArray(part.items)) throw new Error("文件格式不对（需要 Pi Assistant 导出的记忆 JSON）");
			await ready(p, bank, agentId);
			await p.import(bank, { ...part, bank });
			n += part.items.length;
		}
		return n;
	},

	/** 删除助理：清空它自己的记忆库（共享 user 库保留） */
	async purgeAgent(agentId: string) {
		await providerFor(agentId).forget(agentBank(agentId), { all: true }).catch(() => {});
	},
};
