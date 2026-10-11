import { Brain, Download, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, download } from "../api";
import { useStore } from "../store";
import type { MemoryEntry, MemoryProviderInfo } from "../types";
import { Badge, Button, cx, Input } from "./ui";

const KIND: Record<MemoryEntry["kind"], string> = { fact: "事实", experience: "日志", note: "便签" };
const SCOPE: Record<MemoryEntry["scope"], string> = { user: "共享·关于你", agent: "仅此助理", conversation: "仅当前对话" };
const SCOPE_TONE: Record<MemoryEntry["scope"], "accent" | "zinc" | "amber"> = { user: "accent", agent: "zinc", conversation: "amber" };

/** 助理信息面板 › 记忆：查看 / 搜索 / 添加 / 编辑 / 删除 / 导出（与记忆后端无关） */
export function MemoryTab({ agentId }: { agentId: string }) {
	const version = useStore((s) => s.memoryVersion);
	const conv = useStore((s) => s.convs[agentId]?.current);
	const [data, setData] = useState<{ provider: MemoryProviderInfo; items: MemoryEntry[] } | null>(null);
	const [q, setQ] = useState("");
	const [filter, setFilter] = useState<"" | MemoryEntry["kind"]>("");
	const [edit, setEdit] = useState<{ id?: string; text: string; kind: MemoryEntry["kind"]; scope: MemoryEntry["scope"] } | null>(null);
	const [err, setErr] = useState("");
	const load = () => api(`/api/agents/${agentId}/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(setData);
	useEffect(() => {
		const t = setTimeout(() => void load(), q ? 250 : 0);
		return () => clearTimeout(t);
	}, [agentId, version, q]);
	const items = (data?.items ?? []).filter((m) => !filter || m.kind === filter).filter((m) => m.scope !== "conversation" || m.conversationId === conv);
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
	return (
		<div className="space-y-3" data-testid="memory-tab">
			<div className="flex items-center gap-2 text-xs text-mut">
				<Brain size={14} /> 记忆后端：{data?.provider.name ?? "…"}
				<button className="ml-auto inline-flex items-center gap-1 hover:text-fg" onClick={() => download(`/api/agents/${agentId}/memory/export`, `memory-${agentId}.json`)} title="导出（JSON，可迁移到其他记忆后端）">
					<Download size={13} /> 导出
				</button>
			</div>
			<div className="flex gap-2">
				<div className="relative flex-1">
					<Search size={14} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-mut" />
					<Input className="!pl-8" placeholder="搜索记忆" value={q} onChange={(e) => setQ(e.target.value)} />
				</div>
				<Button size="icon" variant="outline" aria-label="添加记忆" onClick={() => setEdit({ text: "", kind: "fact", scope: "user" })}>
					<Plus size={16} />
				</Button>
			</div>
			<div className="flex gap-1">
				{(["", "fact", "experience", "note"] as const).map((k) => (
					<button key={k} className={cx("pa-chip sm", filter === k && "!bg-hover !text-fg font-medium")} onClick={() => setFilter(k)}>
						{k ? KIND[k] : "全部"}
					</button>
				))}
			</div>
			{edit && (
				<div className="pa-card space-y-2 !p-3">
					<textarea className="w-full rounded-lg border border-line bg-card p-2 text-sm outline-none focus:border-accent" rows={3} autoFocus placeholder="例如：我叫邓邓，喜欢简洁的回答" value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
					<div className="flex flex-wrap gap-2 text-xs">
						<select className="rounded-md border border-line bg-card px-2 py-1" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as MemoryEntry["kind"] })}>
							{Object.entries(KIND).map(([k, v]) => (
								<option key={k} value={k}>
									{v}
								</option>
							))}
						</select>
						<select className="rounded-md border border-line bg-card px-2 py-1" value={edit.scope} onChange={(e) => setEdit({ ...edit, scope: e.target.value as MemoryEntry["scope"] })}>
							{Object.entries(SCOPE).map(([k, v]) => (
								<option key={k} value={k}>
									{v}
								</option>
							))}
						</select>
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
			<ul className="space-y-1.5">
				{items.map((m) => (
					<li key={m.id} className="group rounded-xl bg-hover/60 px-3 py-2 text-sm">
						<div className="whitespace-pre-wrap">{m.text}</div>
						<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-mut">
							<Badge tone={SCOPE_TONE[m.scope]}>{SCOPE[m.scope]}</Badge>
							<span>{KIND[m.kind]}</span>
							<span>{new Date(m.createdAt).toLocaleDateString("zh-CN")}</span>
							{m.expiresAt && <span>· {new Date(m.expiresAt).toLocaleDateString("zh-CN")} 到期</span>}
							{m.source === "agent" && <span>· 助理记下</span>}
							<span className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100 max-sm:opacity-100">
								<button className="pa-icon-btn ghost !h-6 !w-6" aria-label="编辑" onClick={() => setEdit({ id: m.id, text: m.text, kind: m.kind, scope: m.scope })}>
									<Pencil size={12} />
								</button>
								<button
									className="pa-icon-btn ghost !h-6 !w-6"
									aria-label="删除记忆"
									onClick={async () => {
										if (!confirm("删除这条记忆？")) return;
										await api(`/api/agents/${agentId}/memory/${m.id}`, { method: "DELETE" });
										void load();
									}}
								>
									<Trash2 size={12} />
								</button>
							</span>
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
