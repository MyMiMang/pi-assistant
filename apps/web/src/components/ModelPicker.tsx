/**
 * 输入框工具栏：每个助理的模型选择（可搜索，所有已配置的服务 + 自定义服务）和思考强度（只列出模型支持的档位，不支持推理时隐藏）。
 * 改动保存到助理（PATCH /api/agents/:id），下一条消息起生效（服务端用 Pi 的 setModel / setThinkingLevel 原地切换）。
 */
import { Brain, Check, ChevronDown, Cpu, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Provider } from "../types";
import { cx } from "./ui";

export interface ModelEntry {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	thinking: string[];
}
export const THINKING_LABEL: Record<string, string> = { off: "关闭", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" };
export const THINKING_DESC: Record<string, string> = { off: "不思考，回答最快", minimal: "几乎不思考", low: "简单推理", medium: "平衡（默认）", high: "深入推理，更慢更贵", xhigh: "非常深入", max: "最大推理预算" };

/** 已配置的服务的全部模型（含自定义） */
export function useConfiguredModels() {
	const v = useStore((s) => s.agents.length);
	const [d, setD] = useState<{ providers: Provider[]; models: ModelEntry[] } | null>(null);
	useEffect(() => {
		void Promise.all([api("/api/models/providers"), api("/api/models")]).then(([p, m]) => {
			const providers = (p.providers ?? p) as Provider[];
			const ok = new Set(providers.filter((x) => x.configured).map((x) => x.id));
			setD({ providers, models: (m as ModelEntry[]).filter((x) => ok.has(x.provider)) });
		});
	}, [v]);
	return d;
}

function usePopover() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
		const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", h);
		document.addEventListener("keydown", k);
		return () => (document.removeEventListener("mousedown", h), document.removeEventListener("keydown", k));
	}, [open]);
	return { open, setOpen, ref };
}

async function patchAgent(agentId: string, body: Record<string, unknown>) {
	const a = await api(`/api/agents/${agentId}`, { method: "PATCH", json: body });
	useStore.setState((s) => ({ agents: s.agents.map((x) => (x.id === agentId ? { ...x, ...a } : x)) }));
}

export function ModelPicker({ agentId }: { agentId: string }) {
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const d = useConfiguredModels();
	const { open, setOpen, ref } = usePopover();
	const [q, setQ] = useState("");
	const cur = agent?.model;
	const curEntry = d?.models.find((m) => m.provider === cur?.provider && m.id === cur?.id);
	const groups = useMemo(() => {
		if (!d) return [];
		const k = q.trim().toLowerCase();
		const list = d.models.filter((m) => !k || `${m.name} ${m.id} ${m.provider}`.toLowerCase().includes(k));
		const by = new Map<string, ModelEntry[]>();
		for (const m of list) by.set(m.provider, [...(by.get(m.provider) ?? []), m]);
		return [...by.entries()].map(([p, ms]) => ({ provider: p, name: d.providers.find((x) => x.id === p)?.name ?? p, models: ms }));
	}, [d, q]);
	if (!agent) return null;
	return (
		<div className="relative min-w-0" ref={ref}>
			<button className="pa-chip sm !shrink max-w-[220px] max-sm:max-w-[120px]" onClick={() => setOpen(!open)} title="选择这个助理用的模型" data-testid="model-picker">
				<Cpu className="pa-ic" />
				<span className="truncate">{curEntry?.name ?? cur?.id ?? "选择模型"}</span>
				<ChevronDown size={12} />
			</button>
			{open && (
				<div className="absolute bottom-full right-0 z-30 mb-2 flex max-h-[60vh] w-80 flex-col rounded-xl border border-line bg-card p-1.5 shadow-lg max-sm:fixed max-sm:inset-x-3 max-sm:bottom-24 max-sm:w-auto" data-testid="model-menu">
					<label className="mb-1 flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5">
						<Search size={14} className="text-mut" />
						<input autoFocus className="min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="搜索模型或服务…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="model-search" />
					</label>
					<div className="min-h-0 flex-1 overflow-y-auto">
						{!d && <div className="p-3 text-sm text-mut">加载中…</div>}
						{d && !groups.length && <div className="p-3 text-sm text-mut">{d.models.length ? "没有匹配的模型" : "还没有配置模型服务：在 设置 › 模型 里添加"}</div>}
						{groups.map((g) => (
							<div key={g.provider} className="py-1">
								<div className="px-2.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wide text-mut">{g.name}</div>
								{g.models.map((m) => {
									const sel = m.provider === cur?.provider && m.id === cur?.id;
									return (
										<button
											key={m.id}
											className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", sel && "bg-hover")}
											onClick={() => (setOpen(false), setQ(""), void patchAgent(agentId, { model: { provider: m.provider, id: m.id } }))}
											data-testid="model-option"
										>
											<span className="min-w-0 flex-1 truncate">{m.name}</span>
											{m.reasoning && <Brain size={12} className="shrink-0 text-mut" aria-label="支持推理" />}
											{sel && <Check size={14} className="shrink-0 text-accent" />}
										</button>
									);
								})}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

export function ThinkingPicker({ agentId }: { agentId: string }) {
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const d = useConfiguredModels();
	const { open, setOpen, ref } = usePopover();
	const entry = d?.models.find((m) => m.provider === agent?.model?.provider && m.id === agent?.model?.id);
	const levels = entry?.thinking ?? [];
	if (!agent || !entry || levels.length <= 1) return null; // 模型不支持推理：隐藏
	const cur = agent.thinking && levels.includes(agent.thinking) ? agent.thinking : levels[0];
	return (
		<div className="relative" ref={ref}>
			<button className="pa-chip sm" onClick={() => setOpen(!open)} title="思考强度" data-testid="thinking-picker">
				<Brain className="pa-ic" />
				<span><span className="max-sm:hidden">思考·</span>{THINKING_LABEL[cur] ?? cur}</span>
				<ChevronDown size={12} />
			</button>
			{open && (
				<div className="absolute bottom-full right-0 z-30 mb-2 w-56 rounded-xl border border-line bg-card p-1.5 shadow-lg" data-testid="thinking-menu">
					<div className="px-2.5 pb-1 pt-0.5 text-xs text-mut">思考强度（{entry.name} 支持的档位）</div>
					{levels.map((l) => (
						<button key={l} className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover", l === cur && "bg-hover")} onClick={() => (setOpen(false), void patchAgent(agentId, { thinking: l }))} data-testid={`thinking-${l}`}>
							<span className="flex-1">
								<span className="text-sm">{THINKING_LABEL[l] ?? l}</span>
								<span className="block text-xs text-mut">{THINKING_DESC[l] ?? ""}</span>
							</span>
							{l === cur && <Check size={14} className="text-accent" />}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
