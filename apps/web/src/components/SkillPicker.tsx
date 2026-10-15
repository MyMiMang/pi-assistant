/**
 * 输入栏的「技能」入口：只列**当前助理已启用**的技能，点选只挂在本条草稿上（可取消，不立即发送、不执行脚本）。
 * 未分配的技能名字 / 描述不会出现在这里；空态提示去该助理设置里启用，不自动全局启用。
 * 发送 payload 只带 canonical id，服务端重新按分配表校验（见 docs/design/context-compact-skill-pick.md）。
 */
import { Check, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import { setSkillDraft, skillNameOf, useSkillDrafts, EMPTY_SKILLS } from "../skillDrafts";
import { COMPOSER_LABEL } from "../composer";
import { Help, cx } from "./ui";

interface EnabledSkill {
	id: string;
	name: string;
	description: string;
	source: "builtin" | "user" | "external";
}

/** 技能入口按钮 + 多选菜单。 */
export function SkillPicker({ agentId, draftKey }: { agentId: string; draftKey: string }) {
	const version = useStore((s) => s.skillsVersion);
	const selected = useSkillDrafts((s) => s.drafts[draftKey] ?? EMPTY_SKILLS);
	const [open, setOpen] = useState(false);
	const [list, setList] = useState<EnabledSkill[] | null>(null);
	const [q, setQ] = useState("");
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let alive = true;
		void api<{ enabledSkills?: EnabledSkill[] }>(`/api/agents/${agentId}/skills`)
			.then((r) => alive && setList(Array.isArray(r.enabledSkills) ? r.enabledSkills : []))
			.catch(() => alive && setList([]));
		return () => {
			alive = false;
		};
	}, [agentId, version]);
	useEffect(() => {
		if (!open) return;
		const h = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
		const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		document.addEventListener("pointerdown", h);
		addEventListener("keydown", k);
		return () => {
			document.removeEventListener("pointerdown", h);
			removeEventListener("keydown", k);
		};
	}, [open]);
	const shown = useMemo(() => {
		const s = q.trim().toLowerCase();
		const l = list ?? [];
		return s ? l.filter((x) => x.name.toLowerCase().includes(s) || x.description.toLowerCase().includes(s)) : l;
	}, [list, q]);
	const toggle = (id: string) => setSkillDraft(draftKey, selected.includes(id) ? [] : [id]);
	const empty = list !== null && list.length === 0;
	return (
		<div className="relative" ref={ref}>
			<button className={cx("pa-chip sm", selected.length > 0 && "!border-accent !text-accent")} onClick={() => setOpen(!open)} title="选用技能：只在这一次发给助理" aria-label={`选用技能${selected.length ? `（已选 ${selected.length}）` : ""}`} aria-expanded={open} data-testid="skill-picker">
				<Sparkles className="pa-ic" />
				<span className={COMPOSER_LABEL}>技能{selected.length > 0 ? `·${selected.length}` : ""}</span>
			</button>
			{open && (
				<div className="pa-pop absolute bottom-full left-0 z-30 mb-2 rounded-xl border border-line bg-card p-1.5 shadow-lg [--pop-w:20rem]" data-testid="skill-menu">
					<div className="px-2.5 pb-1 pt-0.5 text-xs text-mut">
						这次让助理用哪个技能 <Help>只列这个助理已启用的技能，一次选一个。点选只影响这一条消息，不会改设置、也不会马上发送。技能是可复用的做事方法，助理会按它的说明来做。</Help>
					</div>
					{empty ? (
						<div className="space-y-2 px-2.5 py-2" data-testid="skill-empty">
							<p className="text-xs text-mut">还没有给这个助理启用技能。</p>
							<button className="pa-btn sm" onClick={() => (setOpen(false), useStore.getState().set({ info: true, infoTab: "settings" }))} data-testid="skill-empty-goto">
								去启用技能
							</button>
						</div>
					) : (
						<>
							{(list?.length ?? 0) > 6 && (
								<div className="relative mb-1">
									<Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mut" />
									<input className="pa-input !h-8 w-full !pl-7 !text-xs" placeholder="搜索技能" value={q} onChange={(e) => setQ(e.target.value)} autoFocus data-testid="skill-search" />
								</div>
							)}
							<ul className="scrollbar-thin max-h-64 overflow-y-auto" data-testid="skill-list">
								{shown.map((s) => {
									const on = selected.includes(s.id);
									return (
										<li key={s.id}>
											<button className={cx("flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover", on && "bg-hover")} onClick={() => toggle(s.id)} data-testid={`skill-${s.id}`} aria-pressed={on}>
												<span className="mt-0.5 w-4 shrink-0">{on && <Check size={14} className="text-accent" />}</span>
												<span className="min-w-0 flex-1">
													<span className="block truncate font-mono text-[13px]">{s.name}</span>
													<span className="line-clamp-2 block text-xs text-mut">{s.description}</span>
												</span>
											</button>
										</li>
									);
								})}
								{shown.length === 0 && <li className="px-2.5 py-2 text-xs text-mut">没有匹配的技能。</li>}
							</ul>
							{selected.length > 0 && (
								<button className="mt-1 w-full border-t border-line px-2.5 pt-1.5 text-left text-xs text-accent" onClick={() => setSkillDraft(draftKey, [])} data-testid="skill-clear">
									清除选择
								</button>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

/** 已选技能的 chip 行（挂在输入框上方，和引用条 / 附件共存）。 */
export function SkillChips({ draftKey }: { draftKey: string }) {
	const selected = useSkillDrafts((s) => s.drafts[draftKey] ?? EMPTY_SKILLS);
	if (!selected.length) return null;
	return (
		<div className="flex flex-wrap items-center gap-1.5 pb-1.5" data-testid="skill-chips">
			<span className="text-xs text-mut">本次技能</span>
			{selected.map((id) => (
				<span key={id} className="inline-flex max-w-[12rem] items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent" data-testid={`skill-chip-${id}`}>
					<span className="truncate font-mono">{skillNameOf(id)}</span>
					<button className="shrink-0 opacity-70 hover:opacity-100" aria-label={`取消技能 ${skillNameOf(id)}`} onClick={() => setSkillDraft(draftKey, selected.filter((x) => x !== id))} data-testid={`skill-chip-remove-${id}`}>
						<X size={12} />
					</button>
				</span>
			))}
		</div>
	);
}
