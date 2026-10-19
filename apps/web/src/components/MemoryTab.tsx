import { Brain, Download, Pencil, Plus, Search, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, download } from "../api";
import { useStore } from "../store";
import type { MemoryEntry, MemoryProviderInfo } from "../types";
import { Badge, Button, cx, Help, Input, Select, useConfirm } from "./ui";

const KIND: Record<MemoryEntry["kind"], string> = { fact: "事实", experience: "日志", note: "便签" };
const SCOPE: Record<MemoryEntry["scope"], string> = { user: "共享·关于你", agent: "仅此助理", conversation: "仅当前对话", task: "任务草稿" };
const SCOPE_TONE: Record<MemoryEntry["scope"], "accent" | "zinc" | "amber"> = { user: "accent", agent: "zinc", conversation: "amber", task: "amber" };
const SOURCE_LABEL: Record<string, string> = { agent: "助理记下", user: "你添加", subagent: "帮手草稿", background: "后台草稿", group: "群聊", promotion: "确认后保存" };
/** 默认先露出最近几条，其余收进「其余 N 条」；搜索或筛选时全部平铺。 */
const SHOWN = 6;

/** 助理信息面板 › 记忆：查看 / 搜索 / 添加 / 编辑 / 删除 / 导出（与记忆后端无关） */
export function MemoryTab({ agentId }: { agentId: string }) {
	const version = useStore((s) => s.memoryVersion);
	const conv = useStore((s) => s.convs[agentId]?.current);
	const [data, setData] = useState<{ provider: MemoryProviderInfo; agentProvider: string | null; items: MemoryEntry[] } | null>(null);
	const [provs, setProvs] = useState<{ global: string; providers: MemoryProviderInfo[] } | null>(null);
	const [provSaving, setProvSaving] = useState(false);
	const [provErr, setProvErr] = useState("");
	const [hs, setHs] = useState<{ state: string; detail: string; pending: number } | null>(null);
	const [ask, setAsk] = useState("");
	const [answer, setAnswer] = useState<{ answer: string; citations: { id: string; text: string }[] } | null>(null);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);
	const [q, setQ] = useState("");
	const [filter, setFilter] = useState<"" | MemoryEntry["kind"]>("");
	const [draftOnly, setDraftOnly] = useState(false);
	const [edit, setEdit] = useState<{ id?: string; text: string; kind: MemoryEntry["kind"]; scope: MemoryEntry["scope"] } | null>(null);
	const [err, setErr] = useState("");
	const [confirmDlg, askConfirm] = useConfirm();
	const [delBusy, setDelBusy] = useState("");
	const [delErr, setDelErr] = useState("");
	const delRef = useRef(false);
	const load = () => api(`/api/agents/${agentId}/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setData);
	useEffect(() => {
		const t = setTimeout(() => void load(), q ? 250 : 0);
		return () => clearTimeout(t);
	}, [agentId, version, q]);
	const hsVersion = useStore((s) => s.hindsightVersion);
	useEffect(() => {
		void api("/api/memory/providers").then(setProvs);
	}, [agentId]);
	const effective = data?.agentProvider ?? provs?.global ?? "basic";
	useEffect(() => {
		if (effective === "hindsight") void api("/api/memory/hindsight").then((j) => setHs(j.status));
	}, [effective, hsVersion]);
	const setProvider = async (id: string | null) => {
		setProvErr("");
		setProvSaving(true);
		try {
			await api(`/api/agents/${agentId}/memory-provider`, { method: "PUT", json: { id } });
			await load();
		} catch (e) {
			// 不重新加载：Select 的值来自 data.agentProvider，保存失败时自然回到原值
			setProvErr(`切换失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setProvSaving(false);
		}
	};
	const doImport = async (f: File) => {
		setNote("");
		try {
			const r = await api(`/api/agents/${agentId}/memory/import`, { method: "POST", json: JSON.parse(await f.text()) });
			setNote(`已导入 ${r.count} 条`);
			void load();
		} catch (e) {
			setNote(e instanceof Error ? e.message : String(e));
		}
	};
	const reflect = async () => {
		if (!ask.trim()) return;
		setBusy(true);
		setAnswer(null);
		try {
			setAnswer(await api(`/api/agents/${agentId}/memory/reflect`, { method: "POST", json: { query: ask } }));
		} catch (e) {
			setAnswer({ answer: e instanceof Error ? e.message : String(e), citations: [] });
		} finally {
			setBusy(false);
		}
	};
	const items = (data?.items ?? []).filter((m) => !filter || m.kind === filter).filter((m) => !draftOnly || m.status === "draft").filter((m) => m.scope !== "conversation" || m.conversationId === conv);
	const save = async () => {
		if (!edit?.text.trim()) return;
		setErr("");
		try {
			if (edit.id) await api(`/api/agents/${agentId}/memory/${edit.id}`, { method: "PATCH", json: { text: edit.text, kind: edit.kind, scope: edit.scope } });
			else await api(`/api/agents/${agentId}/memory`, { method: "POST", json: { text: edit.text, kind: edit.kind, scope: edit.scope, conversationId: conv } });
			setEdit(null);
			void load();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	};
	const del = async (m: MemoryEntry) => {
		if (delRef.current) return;
		const ok = await askConfirm({ title: "删除这条记忆？", body: m.text.length > 120 ? `${m.text.slice(0, 120)}…` : m.text, ok: "删除", danger: true });
		if (!ok || delRef.current) return;
		delRef.current = true;
		setDelBusy(m.id);
		setDelErr("");
		try {
			await api(`/api/agents/${agentId}/memory/${m.id}`, { method: "DELETE" });
			void load();
		} catch (e) {
			setDelErr(`删除失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			delRef.current = false;
			setDelBusy("");
		}
	};
	const flat = !!q.trim() || !!filter || draftOnly;
	const row = (m: MemoryEntry) => (
		<li key={m.id} className="pa-memory-item" data-kind={m.kind}>
			<div className="pa-memory-scope">
				<Badge tone={SCOPE_TONE[m.scope]}>{SCOPE[m.scope]}</Badge>
				<span>{KIND[m.kind]}</span>
				{m.status === "draft" && <Badge tone="amber">待确认</Badge>}
				<span>{new Date(m.createdAt).toLocaleDateString("zh-CN")}</span>
				{m.expiresAt && <span>· {new Date(m.expiresAt).toLocaleDateString("zh-CN")} 到期</span>}
				{m.source && <span>· {SOURCE_LABEL[m.source] ?? m.source}</span>}
			</div>
			<div className="pa-memory-text">{m.text}</div>
			<div className="pa-memory-actions">
				<Button size="sm" variant="ghost" onClick={() => setEdit({ id: m.id, text: m.text, kind: m.kind, scope: m.scope })} data-testid={`memory-edit-${m.id}`}>
					<Pencil size={12} /> 编辑
				</Button>
				<Button size="sm" variant="ghost" className="text-red-600 dark:text-red-400" aria-label="删除记忆" disabled={delBusy === m.id} onClick={() => void del(m)} data-testid={`memory-delete-${m.id}`}>
					<Trash2 size={12} /> 删除
				</Button>
				{m.status === "draft" && <Help>这条是帮手或后台任务记下的，助理在原对话里确认后才会长期保存。</Help>}
			</div>
		</li>
	);
	return (
		<div className="space-y-3" data-testid="memory-tab">
			{confirmDlg}
			<p className="pa-info-lead !mt-0">它记得的关于你和工作的事 <Help>在聊天里说“记住……”它就会记下；也可以点 + 手动添加。“共享·关于你”的记忆所有助理都能用。</Help></p>
			{note && <div className="text-xs text-mut">{note}</div>}
			{data?.provider.capabilities.reflect && (
				<div className="pa-card space-y-2 !p-3">
					<div className="flex gap-2">
						<Input placeholder="问问记忆（例如：我有哪些习惯？）" value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void reflect()} />
						<Button size="icon" variant="outline" aria-label="反思" disabled={busy} onClick={() => void reflect()}>
							<Sparkles size={15} />
						</Button>
					</div>
					{busy && <div className="text-xs text-mut">正在回想…</div>}
					{answer && (
						<div className="text-sm leading-relaxed" data-testid="reflect-answer">
							{answer.answer}
							{answer.citations.length > 0 && <div className="mt-1 text-xs text-mut">依据：{[...new Set(answer.citations.map((c) => c.text))].slice(0, 4).join("；")}</div>}
						</div>
					)}
				</div>
			)}
			<div className="flex gap-2">
				<div className="relative min-w-0 flex-1">
					<Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-mut" />
					<Input className="!pl-8" placeholder="搜索记忆" value={q} onChange={(e) => setQ(e.target.value)} />
				</div>
				<Button size="icon" variant="outline" aria-label="添加记忆" onClick={() => setEdit({ text: "", kind: "fact", scope: "user" })}>
					<Plus size={16} />
				</Button>
			</div>
			<div className="flex flex-wrap gap-1">
				{(["", "fact", "experience", "note"] as const).map((k) => (
					<button key={k} className={cx("pa-chip sm", filter === k && "!bg-hover !text-fg font-medium")} onClick={() => setFilter(k)}>
						{k ? KIND[k] : "全部"}
					</button>
				))}
				<button className={cx("pa-chip sm", draftOnly && "!bg-hover !text-fg font-medium")} onClick={() => setDraftOnly((v) => !v)} title="只看帮手或后台记下、还没确认的">
					待确认
				</button>
			</div>
			{edit && (
				<div className="pa-card space-y-2 !p-3">
					<textarea className="w-full rounded-lg border border-line bg-card p-2 text-sm outline-none focus:border-accent" rows={3} autoFocus placeholder="例如：我叫邓邓，喜欢简洁的回答" value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
					<div className="flex flex-wrap items-center gap-2 text-xs">
						<Select
							value={edit.kind}
							ariaLabel="记忆类型"
							testId="memory-kind"
							className="!h-8 !px-2 !text-xs"
							options={Object.entries(KIND).map(([k, v]) => ({ value: k, label: v }))}
							onChange={(v) => setEdit({ ...edit, kind: v as MemoryEntry["kind"] })}
						/>
						<Select
							value={edit.scope}
							ariaLabel="记忆作用域"
							testId="memory-scope"
							className="!h-8 !px-2 !text-xs"
							options={Object.entries(SCOPE).map(([k, v]) => ({ value: k, label: v }))}
							onChange={(v) => setEdit({ ...edit, scope: v as MemoryEntry["scope"] })}
						/>
						<span className="ml-auto flex gap-1.5">
							<Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
								取消
							</Button>
							<Button size="sm" variant="primary" onClick={save}>
								保存
							</Button>
						</span>
					</div>
					{err && <div className="text-xs text-red-500">{err}</div>}
				</div>
			)}
			{items.length === 0 && !edit && (
				<div className="py-8 text-center text-sm text-mut">
					还没有记忆
					<div className="mt-1 text-xs">在聊天里说“记住……”，或点 + 手动添加</div>
				</div>
			)}
			<ul data-testid="memory-list">{(flat ? items : items.slice(0, SHOWN)).map(row)}</ul>
			{!flat && items.length > SHOWN && (
				<details className="pa-info-details" data-testid="memory-more">
					<summary>显示全部 {items.length} 条<small>其余 {items.length - SHOWN} 条</small></summary>
					<ul className="max-h-96 overflow-y-auto">{items.slice(SHOWN).map(row)}</ul>
				</details>
			)}
			<details className="pa-info-details" data-testid="memory-options" open={!!provErr || undefined}>
				<summary>高级<small>记忆服务 · {data?.agentProvider ? (provs?.providers.find((p) => p.id === data.agentProvider)?.name ?? data.agentProvider) : "跟随全局"} · 导入 / 导出</small></summary>
				<div className="pa-info-details-body space-y-2">
				<div className="flex flex-wrap items-center gap-2 text-xs text-mut">
					<Brain size={14} className="shrink-0" />
					<Select
						value={data?.agentProvider ?? ""}
						ariaLabel="此助理的记忆后端"
						testId="memory-provider"
						placeholder="跟随全局"
						menuMinWidth={260}
						className="!h-8 min-w-0 max-w-full flex-1 !px-2 !text-xs"
						disabled={provSaving}
						options={[
							{ value: "", label: `跟随全局（${provs?.providers.find((p) => p.id === provs.global)?.name ?? "…"}）` },
							...(provs?.providers ?? []).map((p) => ({ value: p.id, label: p.name })),
						]}
						onChange={(v) => void setProvider(v || null)}
					/>
					{provSaving && <span className="shrink-0 text-mut">保存中…</span>}
					<button className="inline-flex shrink-0 items-center gap-1 hover:text-fg" onClick={() => fileRef.current?.click()} title="导入（本应用导出的记忆 JSON，可来自另一个后端或另一台电脑）">
						<Upload size={13} /> 导入
					</button>
					<input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-testid="memory-import" onChange={(e) => e.target.files?.[0] && void doImport(e.target.files[0])} />
					<button className="inline-flex shrink-0 items-center gap-1 hover:text-fg" onClick={() => download(`/api/agents/${agentId}/memory/export`, `memory-${agentId}.json`)} title="导出（JSON，可迁移到其他记忆后端）">
						<Download size={13} /> 导出
					</button>
				</div>
				{provErr && (
					<div className="text-xs text-red-500" data-testid="memory-provider-error">
						{provErr}
					</div>
				)}
				{effective === "hindsight" && hs && (
					<div className="flex items-center gap-2 text-xs text-mut" data-testid="hindsight-status">
						<span className={cx("inline-block h-2 w-2 shrink-0 rounded-full", hs.state === "ready" ? "bg-green-500" : hs.state === "error" || hs.state === "down" ? "bg-red-500" : "animate-pulse bg-amber-500")} />
						<span className="truncate">{hs.state === "ready" ? "高级记忆运行中" : hs.detail}{hs.pending ? ` · 待同步 ${hs.pending} 条` : ""}</span>
					</div>
				)}
				</div>
			</details>
			{delErr && <div className="text-sm text-red-600" data-testid="memory-delete-error">{delErr}</div>}
		</div>
	);
}
