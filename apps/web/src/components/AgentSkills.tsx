import { Loader2, RefreshCw, Search, Settings2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { SkillMeta } from "../types";
import { Badge, Button, ErrorBox, Help, Input } from "./ui";

const SRC: Record<SkillMeta["source"], string> = { builtin: "内置", user: "我的", external: "导入" };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 助理能力页的「技能」：这个助理启用哪些技能。默认一个都不启用（内置也不启用）。 */
export function AgentSkills({ agentId }: { agentId: string }) {
	const version = useStore((s) => s.skillsVersion);
	// null = 还没成功读到过技能库（不是空库）；读失败时保留上一次成功的数据
	const [list, setList] = useState<SkillMeta[] | null>(null);
	const [enabled, setEnabled] = useState<string[]>([]);
	const [q, setQ] = useState("");
	// 读失败和保存失败分开存：保存失败后的自动回滚读取不能把真正的保存错误抹掉
	const [loadErr, setLoadErr] = useState("");
	const [saveErr, setSaveErr] = useState("");
	const [loading, setLoading] = useState(true);
	// 只让最后一次请求落地：切助理 / 版本刷新后，旧的慢请求不能覆盖新状态
	const seq = useRef(0);
	const load = useCallback(async (opts?: { manual?: boolean }) => {
		const my = ++seq.current;
		setLoading(true);
		// 只有用户手动重试（= 重新读服务端真实状态）才顺手清掉“保存失败”；失败后自动回滚不清
		if (opts?.manual) setSaveErr("");
		try {
			const [all, mine] = await Promise.all([api<SkillMeta[]>("/api/skills"), api<{ enabled: string[] }>(`/api/agents/${agentId}/skills`)]);
			if (my !== seq.current) return;
			setList(all);
			setEnabled(mine.enabled);
			setLoadErr("");
		} catch (e) {
			// 读失败不当成空库：显示错误（有旧数据就继续显示旧数据）
			if (my !== seq.current) return;
			setLoadErr(`加载失败：${msg(e)}`);
		} finally {
			if (my === seq.current) setLoading(false);
		}
	}, [agentId]);
	useEffect(() => {
		void load();
		return () => {
			seq.current++;
		};
	}, [load, version]);
	const enabledSet = new Set(enabled);
	const toggle = async (id: string, v: boolean) => {
		const next = v ? [...enabled, id] : enabled.filter((x) => x !== id);
		setEnabled(next);
		setSaveErr("");
		try {
			const r = await api<{ enabled: string[] }>(`/api/agents/${agentId}/skills`, { method: "PUT", json: { ids: next } });
			setEnabled(r.enabled);
		} catch (e) {
			setSaveErr(`保存失败：${msg(e)}`);
			// 自动回滚：只重新读服务端数据，不清掉刚显示的保存错误
			void load();
		}
	};
	const shown = useMemo(() => {
		const s = q.trim().toLowerCase();
		return s && list ? list.filter((x) => x.name.toLowerCase().includes(s) || x.description.toLowerCase().includes(s)) : (list ?? []);
	}, [list, q]);
	return (
		<section className="space-y-2" data-testid="agent-skills">
			<div className="pa-sec-label flex flex-wrap items-center gap-1">
				<Sparkles size={13} /> 技能
				{loading && <Loader2 size={12} className="animate-spin text-mut" aria-hidden />}
				{list && (
					<span className="ml-auto text-xs font-normal text-mut" data-testid="agent-skills-count">
						已启用 {enabled.length} / {list.length}
					</span>
				)}
			</div>
			{loadErr && (
				<div className="flex flex-wrap items-center gap-2">
					<ErrorBox text={loadErr} className="min-w-0 flex-1" />
					<Button size="sm" variant="outline" onClick={() => void load({ manual: true })} disabled={loading} data-testid="agent-skills-retry">
						<RefreshCw size={12} /> 重试
					</Button>
				</div>
			)}
			{saveErr && <ErrorBox text={saveErr} className="min-w-0" />}
			{list === null ? (
				loading ? (
					<div className="text-sm text-mut" data-testid="agent-skills-loading">
						正在加载技能…
					</div>
				) : null
			) : list.length === 0 ? (
				<div className="space-y-2 text-sm text-mut" data-testid="agent-skills-empty-lib">
					<div>技能库还没有技能。</div>
					<Button size="sm" variant="outline" onClick={() => useStore.getState().set({ settings: "skills" })}>打开技能库</Button>
				</div>
			) : (
				<>
					<p className="text-xs text-mut">
						这个助理能用哪些技能。 <Help>技能是可复用的做事方法。默认一个都不启用（内置技能也不例外）；没启用的技能，助理连名字和描述都看不到。基础工具不受影响，始终可用。</Help>
					</p>
					{list.length > 6 && (
						<div className="relative">
							<Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mut" />
							<Input className="pl-7" placeholder="搜索技能" value={q} onChange={(e) => setQ(e.target.value)} data-testid="agent-skills-search" />
						</div>
					)}
					{enabled.length === 0 && (
						<div className="rounded-lg bg-hover/60 px-3 py-2 text-xs text-mut" data-testid="agent-skills-empty">
							未启用技能，基础工具仍可用。
						</div>
					)}
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
				</>
			)}
		</section>
	);
}
