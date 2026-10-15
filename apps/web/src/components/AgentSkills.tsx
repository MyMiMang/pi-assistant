import { Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { SkillMeta } from "../types";
import { Badge, Help, Input } from "./ui";

const SRC: Record<SkillMeta["source"], string> = { builtin: "内置", user: "我的", external: "导入" };

/** 助理设置里的「技能」：这个助理启用哪些技能。默认一个都不启用（内置也不启用）。 */
export function AgentSkills({ agentId }: { agentId: string }) {
	const version = useStore((s) => s.skillsVersion);
	const [list, setList] = useState<SkillMeta[]>([]);
	const [enabled, setEnabled] = useState<string[]>([]);
	const [q, setQ] = useState("");
	const [err, setErr] = useState("");
	const load = async () => {
		const [all, mine] = await Promise.all([api<SkillMeta[]>("/api/skills"), api<{ enabled: string[] }>(`/api/agents/${agentId}/skills`)]);
		setList(all);
		setEnabled(mine.enabled);
	};
	useEffect(() => {
		void load();
	}, [version, agentId]);
	const enabledSet = new Set(enabled);
	const toggle = async (id: string, v: boolean) => {
		const next = v ? [...enabled, id] : enabled.filter((x) => x !== id);
		setEnabled(next);
		setErr("");
		try {
			const r = await api<{ enabled: string[] }>(`/api/agents/${agentId}/skills`, { method: "PUT", json: { ids: next } });
			setEnabled(r.enabled);
		} catch (e) {
			setErr(`保存失败：${e instanceof Error ? e.message : String(e)}`);
			void load();
		}
	};
	const shown = useMemo(() => {
		const s = q.trim().toLowerCase();
		return s ? list.filter((x) => x.name.toLowerCase().includes(s) || x.description.toLowerCase().includes(s)) : list;
	}, [list, q]);
	if (!list.length)
		return (
			<section data-testid="agent-skills">
				<div className="pa-sec-label mb-1.5 flex items-center gap-1">
					<Sparkles size={13} /> 技能
				</div>
				<div className="text-sm text-mut">技能库还没有技能。可以在 设置 › 技能库 新建或导入。</div>
			</section>
		);
	return (
		<section className="space-y-2" data-testid="agent-skills">
			<div className="pa-sec-label flex items-center gap-1">
				<Sparkles size={13} /> 技能
				<span className="ml-auto text-xs font-normal text-mut" data-testid="agent-skills-count">
					已启用 {enabled.length} / {list.length}
				</span>
			</div>
			<p className="text-xs text-mut">
				这个助理能用哪些技能。 <Help>技能是可复用的做事方法。默认一个都不启用（内置技能也不例外）；没启用的技能，助理连名字和描述都看不到。基础工具不受影响，始终可用。</Help>
			</p>
			{list.length > 6 && (
				<div className="relative">
					<Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mut" />
					<Input className="pl-7" placeholder="搜索技能" value={q} onChange={(e) => setQ(e.target.value)} data-testid="agent-skills-search" />
				</div>
			)}
			{enabled.length === 0 && <div className="rounded-lg bg-hover/60 px-3 py-2 text-xs text-mut" data-testid="agent-skills-empty">未启用技能，基础工具仍可用。</div>}
			{err && <div className="text-xs text-red-500">{err}</div>}
			<ul className="space-y-1">
				{shown.map((s) => (
					<li key={s.id}>
						<label className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-hover">
							<input type="checkbox" className="mt-1" checked={enabledSet.has(s.id)} onChange={(e) => void toggle(s.id, e.target.checked)} data-testid={`agent-skill-${s.name}`} />
							<span className="min-w-0">
								<span className="flex items-center gap-1.5">
									<span className="font-mono text-[13px]">{s.name}</span>
									<Badge tone={s.builtin ? "zinc" : "green"}>{SRC[s.source]}</Badge>
								</span>
								<span className="line-clamp-2 text-xs text-mut">{s.description}</span>
							</span>
						</label>
					</li>
				))}
				{shown.length === 0 && <li className="px-2 py-1.5 text-xs text-mut">没有匹配的技能。</li>}
			</ul>
		</section>
	);
}
