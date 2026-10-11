/**
 * 记忆注册中心 + 作用域服务。
 *  - MemoryRegistry：后端注册表；全局设置 `memoryProvider`，助理可单独覆盖（agents.memory_provider）；默认 basic
 *  - 作用域（与后端无关，存在条目 meta 里）：
 *      user          → 记忆库 `user`（所有助理共享的“关于用户”的事实）
 *      agent         → 记忆库 `agent_<id>`
 *      conversation  → 记忆库 `agent_<id>`，meta.conversationId 限定只在该对话可见
 *  - 种类：fact（资料，总是注入）/ experience（按日日志）/ note（短期便签，meta.expiresAt 到期后不再可见）
 * 以后接入 Hindsight / MemOS：实现 MemoryProvider 并 register，ext-memory 与界面都不用改。
 */
import { config } from "../config.ts";
import { db, getSetting } from "../db.ts";
import { basicMemory } from "./basic.ts";
import { hindsightMemory } from "./hindsight/provider.ts";
import type { MemoryExport, MemoryItem, MemoryProvider } from "./types.ts";

export type { MemoryItem, MemoryProvider } from "./types.ts";
export type Scope = "user" | "agent" | "conversation";
export type Kind = "fact" | "experience" | "note";
export const USER_BANK = "user";
export const agentBank = (agentId: string) => `agent_${agentId}`;
const DAY = 86_400_000;

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
	expiresAt?: number;
	conversationId?: string;
}
function scoped(it: MemoryItem, bank: string): ScopedItem {
	const m = it.meta ?? {};
	const scope = (bank === USER_BANK ? "user" : m.conversationId ? "conversation" : "agent") as Scope;
	const kind = ((m.kind as string) === "log" ? "experience" : ((m.kind as string) ?? it.kind ?? "fact")) as Kind;
	return { ...it, bank, scope, kind, expiresAt: (m.expiresAt as number | undefined) ?? undefined, conversationId: (m.conversationId as string | undefined) ?? undefined };
}
const visible = (it: ScopedItem, conversationId?: string | null) => (!it.expiresAt || it.expiresAt > Date.now()) && (it.scope !== "conversation" || it.conversationId === conversationId);

export interface RememberArgs {
	content: string;
	kind?: Kind | "log";
	scope?: Scope;
	ttlDays?: number;
	source?: string;
}

/** 写入前的简单密钥扫描：疑似密码/令牌的内容不进记忆 */
const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passwd|密码)\s*[:：=]\s*\S{4,})/i;

export const memory = {
	async remember(agentId: string, conversationId: string | null, a: RememberArgs) {
		if (SECRET_RE.test(a.content)) throw new Error("内容看起来包含密码或密钥，出于安全不写入记忆");
		const kind: Kind = a.kind === "log" ? "experience" : (a.kind ?? "fact");
		const scope: Scope = a.scope ?? (kind === "fact" ? "user" : "agent");
		if (scope === "conversation" && !conversationId) throw new Error("当前没有对话，不能保存对话级记忆");
		const bank = scope === "user" ? USER_BANK : agentBank(agentId);
		const p = await ready(providerFor(agentId), bank, agentId);
		const ttl = a.ttlDays ?? (kind === "note" ? 7 : undefined);
		const r = await p.remember(bank, {
			content: a.content,
			timestamp: new Date().toISOString(),
			meta: { kind, source: a.source ?? "user", ...(scope === "conversation" ? { conversationId } : {}), ...(ttl ? { expiresAt: Date.now() + ttl * DAY } : {}) },
		});
		return { id: r.ids?.[0] ?? "", bank, scope, kind, async: !!r.async };
	},

	async recall(agentId: string, conversationId: string | null, query: string, limit = 8): Promise<ScopedItem[]> {
		const p = providerFor(agentId);
		const out: ScopedItem[] = [];
		for (const bank of [agentBank(agentId), USER_BANK]) {
			await ready(p, bank, agentId);
			out.push(...(await p.recall(bank, query, { limit: limit * 2 })).map((i) => scoped(i, bank)).filter((i) => visible(i, conversationId)));
		}
		return out.sort((x, y) => (y.score ?? 0) - (x.score ?? 0)).slice(0, limit);
	},

	async list(agentId: string, conversationId?: string | null, q?: string): Promise<ScopedItem[]> {
		const p = providerFor(agentId);
		const out: ScopedItem[] = [];
		for (const bank of [USER_BANK, agentBank(agentId)]) {
			await ready(p, bank, agentId);
			out.push(...(await p.list(bank, { limit: 500, q })).items.map((i) => scoped(i, bank)));
		}
		// 过期便签不再显示；对话级记忆只在指定对话（或不指定时全部）显示
		return out.filter((i) => (!i.expiresAt || i.expiresAt > Date.now()) && (conversationId === undefined || i.scope !== "conversation" || i.conversationId === conversationId));
	},

	/** 本轮注入给模型的记忆块 */
	async context(agentId: string, conversationId: string | null, prompt: string, budgetChars = 6000): Promise<string> {
		const p = providerFor(agentId);
		const all = await memory.list(agentId, conversationId);
		const vis = all.filter((i) => visible(i, conversationId));
		// 明确记下的事实按作用域筛选（别的对话的对话级事实不会混进来）；有心智模型的后端（Hindsight）再补上自动整理出的认识
		const facts = vis.filter((i) => i.kind === "fact");
		const insights: string[] = [];
		if (p.capabilities.mentalModels && p.bootContext)
			for (const bank of [USER_BANK, agentBank(agentId)]) {
				await ready(p, bank, agentId);
				const b = (await p.bootContext(bank).catch(() => "")).trim();
				if (b) insights.push(...b.split("\n"));
			}
		const notes = vis.filter((i) => i.kind === "note");
		const logs = vis.filter((i) => i.kind === "experience" && Date.now() - Date.parse(i.createdAt) < 3 * DAY).slice(0, 15);
		const seen = new Set([...facts, ...notes, ...logs].map((x) => x.id));
		const related = prompt.trim() ? (await memory.recall(agentId, conversationId, prompt.slice(0, 200), 5)).filter((i) => !seen.has(i.id)) : [];
		const day = (t: string | number) => new Date(t).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
		const line = (i: ScopedItem) => `- [${i.id}] (${i.scope}) ${i.text}`;
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
		add("短期便签", notes.map((i) => `${line(i)}${i.expiresAt ? `（${day(i.expiresAt)} 到期）` : ""}`));
		add("最近几天的日志", logs.map((i) => `- [${i.id}] ${day(i.createdAt)} ${i.text}`));
		add("可能相关的较早记忆", related.map(line));
		return parts.join("\n\n");
	},

	async forget(agentId: string, id: string) {
		const p = providerFor(agentId);
		const items = await memory.list(agentId);
		const hit = items.find((i) => i.id === id);
		if (!hit) return false;
		await p.forget(hit.bank, { id });
		return true;
	},

	async update(agentId: string, id: string, patch: { text?: string; kind?: Kind; scope?: Scope }, conversationId?: string | null) {
		const p = providerFor(agentId);
		const hit = (await memory.list(agentId)).find((i) => i.id === id);
		if (!hit) return null;
		const scope = patch.scope ?? hit.scope;
		const kind = patch.kind ?? hit.kind;
		const targetBank = scope === "user" ? USER_BANK : agentBank(agentId);
		if (targetBank !== hit.bank || !p.update || (scope === "conversation") !== (hit.scope === "conversation")) {
			await p.forget(hit.bank, { id });
			const r = await memory.remember(agentId, scope === "conversation" ? (hit.conversationId ?? conversationId ?? null) : null, { content: patch.text ?? hit.text, kind, scope, source: "user" });
			return r.id;
		}
		await p.update(hit.bank, id, { text: patch.text, kind: kind as never, meta: { kind } });
		return id;
	},

	async reflect(agentId: string, query: string) {
		const p = providerFor(agentId);
		if (!p.reflect) return null;
		// 反思按库进行：助理自己的库 + 所有助理共享的「关于你」库都问一遍，
		// 取依据更多的那个回答，依据合并（共享事实通常记在 user 库里）
		const banks = [agentBank(agentId), USER_BANK];
		for (const b of banks) await ready(p, b, agentId);
		const rs = await Promise.all(banks.map((b) => p.reflect!(b, query).catch((e: unknown) => ({ error: e }))));
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
