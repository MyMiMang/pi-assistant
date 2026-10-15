/**
 * basic 记忆后端：本机 SQLite（memory_items + FTS5 trigram 全文索引，中文按子串检索，无需分词依赖）。
 *  - remember：由模型通过 memory_remember 显式写入（不额外调用大模型抽取，省钱）
 *  - recall：BM25 + 时间衰减；查询太短（<3 字）时退回 LIKE
 *  - reflect：不支持（capabilities.reflect = false，界面置灰）
 *  - bootContext：kind=fact 的条目（资料/偏好），按更新时间倒序
 */
import { db, uid } from "../db.ts";
import type { BankId, MemoryExport, MemoryItem, MemoryProvider, RememberInput } from "./types.ts";

type Row = { id: string; bank: string; text: string; kind: string | null; document_id: string | null; created_at: string; occurred_at: string | null; source_json: string | null; meta_json: string | null };
const toItem = (r: Row, score?: number): MemoryItem => ({
	id: r.id,
	text: r.text,
	kind: (r.kind ?? undefined) as MemoryItem["kind"],
	createdAt: r.created_at,
	occurredAt: r.occurred_at ?? undefined,
	source: r.source_json ? JSON.parse(r.source_json) : undefined,
	meta: { ...(r.meta_json ? JSON.parse(r.meta_json) : {}), ...(r.document_id ? { documentId: r.document_id } : {}) },
	score,
});
const iso = () => new Date().toISOString();
const DAY = 86_400_000;
/** 时间衰减：半衰期 60 天，最低 0.3 */
const decay = (createdAt: string) => Math.max(0.3, 0.5 ** ((Date.now() - Date.parse(createdAt)) / (60 * DAY)));

function index(id: string, bank: string, text: string | null) {
	db.prepare("DELETE FROM memory_fts WHERE id = ?").run(id);
	if (text !== null) db.prepare("INSERT INTO memory_fts(text, id, bank) VALUES(?, ?, ?)").run(text, id, bank);
}
const get = (bank: string, id: string) => db.prepare("SELECT * FROM memory_items WHERE bank = ? AND id = ?").get(bank, id) as Row | undefined;

export const basicMemory: MemoryProvider = {
	id: "basic",
	name: "基础记忆（本机 SQLite）",
	capabilities: { reflect: false, mentalModels: false, temporal: false, graph: false, exportImport: true, mcpEndpoint: false },

	async init() {},
	async health() {
		return { ok: true, detail: `${(db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as { n: number }).n} 条记忆` };
	},
	async ensureBank(bank, profile) {
		db.prepare("INSERT INTO memory_banks(bank, profile_json, created_at) VALUES(?,?,?) ON CONFLICT(bank) DO UPDATE SET profile_json = excluded.profile_json").run(bank, JSON.stringify(profile), iso());
	},

	async remember(bank: BankId, input: RememberInput) {
		const text = input.content.trim();
		if (!text) throw new Error("记忆内容不能为空");
		const meta = input.meta ?? {};
		const dup = input.dedupe === false ? undefined : (db.prepare("SELECT id FROM memory_items WHERE bank = ? AND text = ?").get(bank, text) as { id: string } | undefined);
		if (dup) {
			db.prepare("UPDATE memory_items SET meta_json = ?, created_at = ? WHERE id = ?").run(JSON.stringify(meta), iso(), dup.id);
			return { ids: [dup.id] };
		}
		const id = uid("mem");
		const kind = (meta.kind as string | undefined) ?? "fact";
		db.prepare("INSERT INTO memory_items(id, bank, text, kind, document_id, created_at, occurred_at, source_json, meta_json) VALUES(?,?,?,?,?,?,?,?,?)").run(
			id,
			bank,
			text,
			kind,
			input.documentId ?? null,
			iso(),
			input.timestamp ?? null,
			input.context ? JSON.stringify({ context: input.context }) : null,
			JSON.stringify(meta),
		);
		index(id, bank, text);
		return { ids: [id] };
	},

	async recall(bank, query, opts = {}) {
		const limit = Math.min(opts.limit ?? 8, 50);
		const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 12);
		if (!terms.length) return [];
		let rows: (Row & { rank?: number })[] = [];
		const long = terms.filter((t) => [...t].length >= 3);
		if (long.length) {
			try {
				const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
				rows = db.prepare("SELECT m.*, bm25(memory_fts) AS rank FROM memory_fts f JOIN memory_items m ON m.id = f.id WHERE memory_fts MATCH ? AND f.bank = ? ORDER BY rank LIMIT ?").all(match, bank, limit * 3) as typeof rows;
			} catch {
				rows = [];
			}
		}
		if (!rows.length) {
			const likes = terms.map(() => "text LIKE ?").join(" OR ");
			rows = db.prepare(`SELECT * FROM memory_items WHERE bank = ? AND (${likes}) ORDER BY created_at DESC LIMIT ?`).all(bank, ...terms.map((t) => `%${t}%`), limit * 3) as Row[];
		}
		return rows
			.map((r) => toItem(r, (r.rank !== undefined ? -r.rank : 1) * decay(r.created_at)))
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
			.slice(0, limit);
	},

	async list(bank, opts = {}) {
		const limit = Math.min(opts.limit ?? 200, 1000);
		const offset = Number(opts.cursor ?? 0) || 0;
		const rows = (opts.q?.trim()
			? db.prepare("SELECT * FROM memory_items WHERE bank = ? AND text LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(bank, `%${opts.q.trim()}%`, limit + 1, offset)
			: db.prepare("SELECT * FROM memory_items WHERE bank = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").all(bank, limit + 1, offset)) as Row[];
		return { items: rows.slice(0, limit).map((r) => toItem(r)), cursor: rows.length > limit ? String(offset + limit) : undefined };
	},

	async forget(bank, target) {
		const ids = target.all
			? (db.prepare("SELECT id FROM memory_items WHERE bank = ?").all(bank) as { id: string }[])
			: target.documentId
				? (db.prepare("SELECT id FROM memory_items WHERE bank = ? AND document_id = ?").all(bank, target.documentId) as { id: string }[])
				: target.id
					? [{ id: target.id }]
					: [];
		for (const { id } of ids) {
			db.prepare("DELETE FROM memory_items WHERE bank = ? AND id = ?").run(bank, id);
			index(id, bank, null);
		}
	},

	async bootContext(bank) {
		const rows = db.prepare("SELECT * FROM memory_items WHERE bank = ? AND kind = 'fact' ORDER BY created_at DESC LIMIT 80").all(bank) as Row[];
		return rows.map((r) => `- [${r.id}] ${r.text}`).join("\n");
	},

	async export(bank) {
		const profile = db.prepare("SELECT profile_json FROM memory_banks WHERE bank = ?").get(bank) as { profile_json: string } | undefined;
		const rows = db.prepare("SELECT * FROM memory_items WHERE bank = ? ORDER BY created_at").all(bank) as Row[];
		return { format: "pi-assistant-memory/1", bank, profile: profile ? JSON.parse(profile.profile_json) : undefined, items: rows.map((r) => ({ ...toItem(r), documentId: r.document_id ?? undefined })) } satisfies MemoryExport;
	},
	async import(bank, data) {
		for (const it of data.items) await this.remember(bank, { content: it.text, timestamp: it.occurredAt, documentId: it.documentId, meta: { ...(it.meta ?? {}), kind: it.kind ?? (it.meta?.kind as string) ?? "fact" } });
	},

	async update(bank, id, patch) {
		const cur = get(bank, id);
		if (!cur) return null;
		const text = patch.text?.trim() || cur.text;
		const meta = { ...(cur.meta_json ? JSON.parse(cur.meta_json) : {}), ...(patch.meta ?? {}) };
		const kind = patch.kind ?? (meta.kind as string) ?? cur.kind;
		db.prepare("UPDATE memory_items SET text = ?, kind = ?, meta_json = ? WHERE id = ?").run(text, kind, JSON.stringify({ ...meta, kind }), id);
		index(id, bank, text);
		return toItem(get(bank, id)!);
	},

	async shutdown() {},
};
