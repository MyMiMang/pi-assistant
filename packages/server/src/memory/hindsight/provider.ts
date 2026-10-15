/**
 * Hindsight 记忆后端。
 *
 * 数据流：本机 SQLite（memory_items，与 basic 同一张表）是“原文账本”，是唯一的真相来源；
 * Hindsight 是建在账本之上的智能层（事实抽取、实体图谱、时间推理、重排序、反思、心智模型）。
 *  - remember / update / forget 先写账本，再进同步队列（memory_sync）→ Hindsight（documentId = 账本 id，幂等）
 *  - Hindsight 没准备好 / 崩溃时：读走 basic（同一账本的全文检索），写照常进队列，恢复后自动补写（不丢）
 *  - 换向量模型：账本里有全部原文，删掉旧库、按新模型重新写入即可（自动）
 *  - 导出 / 导入：用账本的统一格式（pi-assistant-memory/1），可在 basic ⇄ Hindsight 之间迁移
 */
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { bus } from "../../bus.ts";
import { db } from "../../db.ts";
import { basicMemory } from "../basic.ts";
import type { BankId, MemoryItem, MemoryProvider, RememberInput } from "../types.ts";
import { embeddingSignature, hindsightSettings } from "./settings.ts";
import { sidecar } from "./sidecar.ts";

const MENTAL_MODELS = [
	{ id: "user-preferences", name: "用户偏好与习惯", query: "关于用户，有哪些已经确定的偏好、习惯、身份信息和长期约定？用简短条目列出。" },
	{ id: "open-commitments", name: "进行中的事项与约定", query: "目前有哪些进行中的事项、计划、截止时间和答应过用户的事？用简短条目列出。" },
];

const client = () => new HindsightClient({ baseUrl: sidecar.baseUrl!, apiKey: sidecar.apiKey(), userAgent: "pi-assistant" } as never);
/** recall/reflect 没有显式取消；加一个短超时，避免卡住主模型回合（超时后 recall 退回账本检索） */
const RECALL_TIMEOUT_MS = Number(process.env.PIA_MEMORY_TIMEOUT_MS ?? 20_000);
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${what}超时（${ms}ms）`)), ms);
		t.unref?.();
		p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
	});
}
const row = (id: string) => db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as { id: string; bank: string; text: string; kind: string | null; created_at: string; occurred_at: string | null; meta_json: string | null } | undefined;
const metaOf = (r: { meta_json: string | null }) => (r.meta_json ? (JSON.parse(r.meta_json) as Record<string, unknown>) : {});

/** 入队；同一条目已有未处理的 retain 就不重复排（每次 retain 都要调用模型抽取，重复会白花 token；失败重试后也靠这条去重） */
const insertJob = (bank: string, op: string, itemId: string | null) =>
	db
		.prepare("INSERT INTO memory_sync(bank, item_id, op, created_at) SELECT ?,?,?,? WHERE NOT (? = 'retain' AND EXISTS (SELECT 1 FROM memory_sync WHERE bank = ? AND item_id = ? AND op = 'retain'))")
		.run(bank, itemId, op, Date.now(), op, bank, itemId);
export function enqueue(bank: string, op: "retain" | "delete" | "purge", itemId?: string) {
	insertJob(bank, op, itemId ?? null);
	void flush();
}
export const pendingCount = () => (db.prepare("SELECT COUNT(*) AS n FROM memory_sync").get() as { n: number }).n;
export const lastSyncError = () => (db.prepare("SELECT last_error FROM memory_sync WHERE last_error IS NOT NULL ORDER BY seq LIMIT 1").get() as { last_error: string } | undefined)?.last_error ?? null;

/** 把这个库的全部账本条目排进队列（首次切到 Hindsight / 重建向量时） */
function enqueueAll(bank: string) {
	const ids = db.prepare("SELECT id FROM memory_items WHERE bank = ? ORDER BY created_at").all(bank) as { id: string }[];
	for (const { id } of ids) insertJob(bank, "retain", id);
}

const profiles = new Map<string, { name: string; persona?: string }>();

const bankLocks = new Map<string, Promise<void>>();
/** 确保 Hindsight 里有这个库，且用的是当前向量模型；不是就重建（删库 → 重新排队写入全部原文） */
function ensureRemoteBank(bank: string): Promise<void> {
	const cur = bankLocks.get(bank);
	if (cur) return cur;
	const p = doEnsureRemoteBank(bank).finally(() => bankLocks.delete(bank));
	bankLocks.set(bank, p);
	return p;
}
async function doEnsureRemoteBank(bank: string) {
	const sig = embeddingSignature(hindsightSettings().embedding) + (hindsightSettings().mode === "remote" ? `@${hindsightSettings().remoteUrl}` : "");
	const have = db.prepare("SELECT signature FROM hindsight_banks WHERE bank = ?").get(bank) as { signature: string } | undefined;
	if (have?.signature === sig) return;
	const c = client();
	if (have) await c.deleteBank(bank).catch(() => {});
	const prof = profiles.get(bank) ?? (db.prepare("SELECT profile_json FROM memory_banks WHERE bank = ?").get(bank) as { profile_json: string } | undefined ? JSON.parse((db.prepare("SELECT profile_json FROM memory_banks WHERE bank = ?").get(bank) as { profile_json: string }).profile_json) : { name: bank });
	await c.createBank(bank, {
		reflectMission: [`这是「${prof.name}」的记忆库。`, prof.persona ? `助理设定：${prof.persona}` : "", "用中文回答，保留原文里的人名、地名和专有名词。"].filter(Boolean).join("\n"),
		retainMission: "重点记住：用户的身份、偏好、习惯、约定、计划和截止时间；助理做过的事和结论。不要记录密码、密钥、验证码。",
		enableObservations: true,
	});
	for (const m of MENTAL_MODELS) await c.createMentalModel(bank, m.name, m.query, { id: m.id, trigger: { refresh_after_consolidation: true } } as never).catch(() => {});
	db.prepare("INSERT INTO hindsight_banks(bank, signature, created_at) VALUES(?,?,?) ON CONFLICT(bank) DO UPDATE SET signature = excluded.signature").run(bank, sig, Date.now());
	enqueueAll(bank);
}

let flushing: Promise<void> | null = null;
/** 处理同步队列（按顺序；遇到失败就停下，等下次） */
export function flush(): Promise<void> {
	if (!sidecar.ready) return Promise.resolve();
	flushing ??= (async () => {
		for (;;) {
			const job = db.prepare("SELECT * FROM memory_sync ORDER BY seq LIMIT 1").get() as { seq: number; bank: string; item_id: string | null; op: string } | undefined;
			if (!job || !sidecar.ready) break;
			try {
				const c = client();
				if (job.op === "purge") {
					await c.deleteBank(job.bank).catch(() => {});
					db.prepare("DELETE FROM hindsight_banks WHERE bank = ?").run(job.bank);
				} else {
					await ensureRemoteBank(job.bank);
					if (job.op === "delete") await c.deleteDocument(job.bank, job.item_id!).catch((e: { statusCode?: number }) => (e?.statusCode === 404 ? undefined : Promise.reject(e)));
					else {
						const r = row(job.item_id!);
						if (r && r.bank === job.bank) {
							const m = metaOf(r);
							const tags = [`kind:${m.kind ?? r.kind ?? "fact"}`, ...(m.conversationId ? [`conv:${m.conversationId}`] : [])];
							const metadata: Record<string, string> = { kind: String(m.kind ?? r.kind ?? "fact"), source: String(m.source ?? "") };
							if (m.conversationId) metadata.conversationId = String(m.conversationId);
							await c.retain(job.bank, r.text, { documentId: r.id, timestamp: r.occurred_at ?? r.created_at, metadata, tags, async: true });
						}
					}
				}
				db.prepare("DELETE FROM memory_sync WHERE seq = ?").run(job.seq);
			} catch (e) {
				db.prepare("UPDATE memory_sync SET attempts = attempts + 1, last_error = ? WHERE seq = ?").run(e instanceof Error ? e.message : String(e), job.seq);
				break;
			}
		}
		bus.emit({ type: "memory.sync", pending: pendingCount() });
	})().finally(() => (flushing = null));
	return flushing;
}

/** 换了向量模型 / 远程地址：所有已建的库按新配置重建（删库 → 用账本原文重新写入） */
export async function resyncAll() {
	for (const { bank } of db.prepare("SELECT bank FROM hindsight_banks").all() as { bank: string }[]) await ensureRemoteBank(bank).catch(() => {});
	await flush();
}

/** 就绪时：之前在未就绪期间打开过的库（ensureBank 时 Hindsight 还没起来）现在建库并补写，再处理队列 */
async function onReady() {
	for (const bank of profiles.keys())
		if (!db.prepare("SELECT 1 FROM hindsight_banks WHERE bank = ?").get(bank)) await ensureRemoteBank(bank).catch(() => {});
	await flush();
}

// 恢复后自动补写；另外每分钟兜底一次
bus.on((e) => {
	if (e.type === "memory.hindsight" && (e.status as { state: string }).state === "ready") void onReady();
});
setInterval(() => void flush(), 60_000).unref();

const toItem = (bank: string, r: { id: string; text: string; type?: string | null; document_id?: string | null; mentioned_at?: string | null; occurred_start?: string | null }, score: number): MemoryItem | null => {
	const docId = r.document_id ?? undefined;
	const src = docId ? row(docId) : undefined;
	if (docId && (!src || src.bank !== bank)) return null; // 账本里已删除的，不再返回
	const meta = src ? metaOf(src) : { kind: r.type === "observation" ? "fact" : "experience" };
	return { id: docId ?? `hs_${r.id}`, text: r.text, kind: r.type === "observation" ? "observation" : undefined, createdAt: src?.created_at ?? r.mentioned_at ?? new Date().toISOString(), occurredAt: r.occurred_start ?? undefined, score, meta: { ...meta, hindsightType: r.type } };
};

export const hindsightMemory: MemoryProvider & { status: () => unknown } = {
	id: "hindsight",
	name: "高级记忆（Hindsight）",
	capabilities: { reflect: true, mentalModels: true, temporal: true, graph: true, exportImport: true, mcpEndpoint: false },

	async init() {
		void sidecar.ensure();
	},
	async health() {
		const s = sidecar.status;
		return { ok: s.state === "ready", detail: `${s.detail}${pendingCount() ? `；待同步 ${pendingCount()} 条` : ""}` };
	},
	status: () => ({ ...sidecar.status, pending: pendingCount(), lastError: lastSyncError() }),

	async ensureBank(bank, profile) {
		profiles.set(bank, profile);
		await basicMemory.ensureBank(bank, profile);
		// 第一次在 Hindsight 用这个库：建库并把已有的账本条目（比如之前用 basic 记的）补写过去
		if (sidecar.ready && !db.prepare("SELECT 1 FROM hindsight_banks WHERE bank = ?").get(bank)) void ensureRemoteBank(bank).then(() => flush()).catch(() => {});
	},

	async remember(bank: BankId, input: RememberInput) {
		const r = await basicMemory.remember(bank, input);
		for (const id of r.ids ?? []) enqueue(bank, "retain", id);
		return { ids: r.ids, async: true };
	},

	async recall(bank, query, opts = {}) {
		if (!sidecar.ready) return basicMemory.recall(bank, query, opts);
		try {
			if (!db.prepare("SELECT 1 FROM hindsight_banks WHERE bank = ?").get(bank)) await ensureRemoteBank(bank);
			const res = await withTimeout(client().recall(bank, query, { maxTokens: opts.tokenBudget ?? 2048, budget: "mid", types: ["world", "experience", "observation"] } as never), RECALL_TIMEOUT_MS, "记忆召回");
			const results = ((res as { results?: unknown[] }).results ?? []) as Parameters<typeof toItem>[1][];
			const items = results.map((r, i) => toItem(bank, r, 1 / (1 + i))).filter(Boolean) as MemoryItem[];
			const limit = opts.limit ?? 8;
			// Hindsight 还没抽取完的新条目：用账本全文检索补上
			if (items.length < limit) for (const b of await basicMemory.recall(bank, query, { limit })) if (!items.some((x) => x.id === b.id)) items.push({ ...b, score: (b.score ?? 0) * 0.01 });
			return items.slice(0, limit);
		} catch {
			return basicMemory.recall(bank, query, opts);
		}
	},

	async reflect(bank, query) {
		if (!sidecar.ready) throw new Error("高级记忆暂时不可用（Hindsight 未就绪），稍后再试");
		await ensureRemoteBank(bank);
		const r = await withTimeout(client().reflect(bank, query, { budget: "mid", includeFacts: true } as never), RECALL_TIMEOUT_MS, "记忆反思");
		const memories = ((r.based_on as { memories?: Parameters<typeof toItem>[1][] } | null)?.memories ?? []).map((m, i) => toItem(bank, m, 1 / (1 + i))).filter(Boolean) as MemoryItem[];
		return { answer: r.text, citations: memories };
	},

	list: (bank, opts) => basicMemory.list(bank, opts),

	async forget(bank, target) {
		if (target.all) {
			await basicMemory.forget(bank, target);
			db.prepare("DELETE FROM memory_sync WHERE bank = ?").run(bank);
			enqueue(bank, "purge");
			return;
		}
		const ids = target.id ? [target.id] : target.documentId ? (db.prepare("SELECT id FROM memory_items WHERE bank = ? AND document_id = ?").all(bank, target.documentId) as { id: string }[]).map((x) => x.id) : [];
		await basicMemory.forget(bank, target);
		for (const id of ids) enqueue(bank, "delete", id);
	},

	async update(bank, id, patch) {
		const r = await basicMemory.update!(bank, id, patch);
		if (r) enqueue(bank, "retain", id); // 同一 documentId 重新写入 = 替换
		return r;
	},

	/** 会话开始注入的“自动整理出的认识”：Hindsight 心智模型的内容（读取时不调用大模型）。明确记下的事实由上层按作用域注入 */
	async bootContext(bank) {
		if (!sidecar.ready || !db.prepare("SELECT 1 FROM hindsight_banks WHERE bank = ?").get(bank)) return "";
		try {
			const list = await client().listMentalModels(bank, { detail: "content" } as never);
			return ((list as { items?: { name: string; content?: string | null }[] }).items ?? [])
				.filter((m) => m.content?.trim())
				.map((m) => `- （${m.name}）${m.content!.trim().replace(/\n+/g, "；").slice(0, 600)}`)
				.join("\n");
		} catch {
			return "";
		}
	},

	export: (bank) => basicMemory.export!(bank),
	async import(bank, data) {
		await this.ensureBank(bank, data.profile ?? { name: bank });
		const before = new Set((db.prepare("SELECT id FROM memory_items WHERE bank = ?").all(bank) as { id: string }[]).map((x) => x.id));
		await basicMemory.import!(bank, data);
		for (const { id } of db.prepare("SELECT id FROM memory_items WHERE bank = ?").all(bank) as { id: string }[]) if (!before.has(id)) enqueue(bank, "retain", id);
	},

	async shutdown() {
		await sidecar.stop();
	},
};
