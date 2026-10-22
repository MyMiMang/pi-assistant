import { Crown, Loader2, Plus, Trash2, Users, UserPlus, ChevronDown, Flag, ClipboardCheck, Lightbulb } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Message, ProjectPlan, ProjectStatus } from "../types";
import { type LabeledModel, modelKey, modelLabel } from "./ModelOptions";
import { useConfiguredModels, type ModelEntry } from "./ModelPicker";
import { DraftModelSettings, useModelDefaults } from "./DraftModelSettings";
import { Avatar, Fold, Help, Select, cx } from "./ui";

export interface PMember {
	agentId?: string;
	name?: string;
	role?: string;
	persona?: string;
	skills?: string[];
	model?: { provider: string; id: string } | null;
	thinking?: string | null;
	modelReason?: string;
	needs?: string[];
	avatar?: string;
	color?: string;
}
export interface Proposal {
	name: string;
	purpose: string;
	manager: number;
	members: PMember[];
}

/** 角色推荐只改变组内顺序/星标，完整目录仍按用户配置的服务分组。 */
interface RankedModel extends LabeledModel {
	score: number;
	tier: string;
	tierLabel: string;
	reason: string;
	reasoning?: boolean;
	excluded?: string;
}
/** 刷新服务或重新打开时重算推荐，异步回包不能把旧角色结果盖回来。 */
function useRankedModels(needs: string[] = [], manager = false) {
	const key = [...needs].sort().join(",");
	const system = useStore((s) => s.system);
	const [version, setVersion] = useState(0);
	const [list, setList] = useState<RankedModel[]>([]);
	const [error, setError] = useState(false);
	const reload = useCallback(() => setVersion((v) => v + 1), []);
	useEffect(() => {
		let off = false;
		void api<RankedModel[]>(`/api/proposals/models?needs=${encodeURIComponent(key)}&manager=${manager ? 1 : 0}`).then((r) => { if (!off) { setList(r); setError(false); } }).catch(() => { if (!off) { setList([]); setError(true); } });
		return () => { off = true; };
	}, [key, manager, system, version]);
	return { list, error, reload };
}
const NEED_LABEL: Record<string, string> = { coding: "写代码", reasoning: "推理", writing_zh: "中文写作", writing: "写作", vision: "看图", long_context: "长文档", tool_use: "用工具", cheap: "便宜", fast: "快" };

function MemberEditor({ m, catalog, defaults, onChange, onRemove, manager, onManager, locked }: { m: PMember; catalog: ReturnType<typeof useConfiguredModels>; defaults: ReturnType<typeof useModelDefaults>; onChange: (m: PMember) => void; onRemove?: () => void; manager?: boolean; onManager?: () => void; locked: boolean }) {
	const agents = useStore((s) => s.agents);
	const existing = m.agentId ? agents.find((a) => a.id === m.agentId) : null;
	const [open, setOpen] = useState(false);
	const ranked = useRankedModels(m.needs, !!manager);
	const byKey = new Map(catalog.models.map((m) => [modelKey(m), m]));
	const recommended = ranked.list.find((m) => !m.excluded && byKey.has(modelKey(m)));
	const models: ModelEntry[] = ranked.list.flatMap<ModelEntry>((r) => {
		const m = byKey.get(modelKey(r));
		if (!m) return [];
		byKey.delete(modelKey(r));
		return [{ ...m, star: recommended === r, badge: r.tierLabel, note: r.excluded }];
	}).concat([...byKey.values()]);
	const cur = m.model ? models.find((x) => modelKey(x) === modelKey(m.model!)) : null;
	const reload = () => { catalog.reload(); ranked.reload(); };
	return (
		<div className="pa-pm" data-testid="proposal-member">
			<div className="flex min-w-0 items-center gap-2">
				<Avatar agentId={existing?.id} text={existing?.avatar ?? (m.avatar || m.name || "?")} color={existing?.color ?? m.color ?? "#6366f1"} size={28} />
				{existing ? (
					<b className="min-w-0 flex-1 truncate text-sm">{existing.name}<small className="ml-1 font-normal text-mut2">已有助理</small></b>
				) : (
					<input className="pa-input !h-8 min-w-0 flex-1 !px-2 text-sm" value={m.name ?? ""} disabled={locked} onChange={(e) => onChange({ ...m, name: e.target.value })} aria-label="成员名字" data-testid="pm-name" />
				)}
				{onManager && (
					<button className={cx("pa-icon-btn ghost shrink-0", manager && "!text-amber-500")} disabled={locked} onClick={onManager} title={manager ? "管理者" : "设为管理者"} aria-label="设为管理者" data-testid="pm-manager">
						<Crown className="pa-ic" />
					</button>
				)}
				{onRemove && !locked && (
					<button className="pa-icon-btn ghost shrink-0" onClick={onRemove} title="移除" aria-label="移除成员" data-testid="pm-remove">
						<Trash2 className="pa-ic" />
					</button>
				)}
			</div>
			{!existing && (
				<>
					<input className="pa-input mt-1.5 !h-8 !px-2 text-xs" placeholder="负责什么" value={m.role ?? ""} disabled={locked} onChange={(e) => onChange({ ...m, role: e.target.value })} aria-label="角色" />
					<div className="mt-1.5 flex min-w-0 items-center gap-1.5">
						<DraftModelSettings
							id="pm"
							models={models}
							providers={catalog.providers}
							value={m.model ?? null}
							thinking={m.thinking ?? null}
							defaults={defaults}
							disabled={locked}
							loading={catalog.loading}
							error={catalog.error}
							reload={reload}
							onModel={(model) => {
								const r = model && ranked.list.find((y) => modelKey(y) === modelKey(model));
								onChange({ ...m, model, modelReason: model ? r ? `你选的：${r.reason}` : "你选的" : undefined });
							}}
							onThinking={(thinking) => onChange({ ...m, thinking })}
						/>
						{m.modelReason && <Help>{cur ? `${modelLabel(cur)}：` : ""}{m.modelReason}{m.needs?.length ? `。这个角色需要：${m.needs.map((n) => NEED_LABEL[n] ?? n).join("、")}` : ""}。按服务分组，组内按适合程度排序，★ 是推荐。</Help>}
					</div>
					{ranked.error && <p className="mt-1 text-xs text-mut" role="status">推荐没加载出来，仍可手动选择。<button type="button" className="ml-1 underline" disabled={locked} onClick={ranked.reload}>重试推荐</button></p>}
					{m.modelReason && <div className="mt-1 truncate text-[11px] text-mut2" data-testid="pm-reason" title={m.modelReason}>{m.modelReason}</div>}
					<button className="mt-1 flex items-center gap-1 text-[11px] text-mut2 hover:text-fg" onClick={() => setOpen(!open)}>
						<ChevronDown size={12} className={cx("transition-transform", open && "rotate-180")} /> 人设
					</button>
					{open && <textarea className="pa-input mt-1 !h-24 resize-y !p-2 text-xs" disabled={locked} value={m.persona ?? ""} onChange={(e) => onChange({ ...m, persona: e.target.value })} aria-label="人设" />}
				</>
			)}
		</div>
	);
}

/** 提议卡片：建群（propose_room）/ 加成员（room_propose_member）。可以直接在卡片上改，点确认才创建 */
export function ProposalCard({ m }: { m: Message }) {
	const meta = m.meta;
	const isRoom = meta.kind === "room-proposal";
	const catalog = useConfiguredModels();
	const defaults = useModelDefaults();
	const agents = useStore((s) => s.agents);
	const [p, setP] = useState<Proposal>(() => meta.proposal ?? { name: "", purpose: "", manager: 0, members: [] });
	const [mem, setMem] = useState<PMember>(() => meta.member ?? {});
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const pending = meta.status === "pending";
	const done = meta.status === "confirmed";
	const confirm = async () => {
		setBusy(true);
		setErr("");
		try {
			const r = await api<{ room?: { id: string } }>(`/api/proposals/${m.id}/confirm`, { method: "POST", json: isRoom ? { proposal: p } : { member: mem } });
			if (r.room) {
				await useStore.getState().loadRooms();
				void useStore.getState().selectRoom(r.room.id);
			}
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const dismiss = () => api(`/api/proposals/${m.id}/dismiss`, { method: "POST" });
	const setMember = (i: number, x: PMember) => setP({ ...p, members: p.members.map((y, j) => (j === i ? x : y)) });
	const remove = (i: number) => setP({ ...p, members: p.members.filter((_, j) => j !== i), manager: i === p.manager ? 0 : i < p.manager ? p.manager - 1 : p.manager });
	const userAgents = agents.filter((a) => a.scope !== "room" && !p.members.some((x) => x.agentId === a.id));
	return (
		<div className={cx("pa-card w-full max-w-[560px]", done && "approved")} data-testid={isRoom ? "room-proposal" : "member-proposal"}>
			<div className="pa-card-top">
				{isRoom ? <Users className="pa-ic" /> : <UserPlus className="pa-ic" />}
				<b>{isRoom ? "建群提议" : "提议加成员"}</b>
				<span className="pa-tag">{done ? "已创建" : meta.status === "dismissed" ? "已取消" : "确认前不会创建"}</span>
			</div>
			{isRoom ? (
				<div className="space-y-2">
					<input className="pa-input !h-9 font-medium" value={p.name} disabled={!pending} onChange={(e) => setP({ ...p, name: e.target.value })} aria-label="群名" data-testid="proposal-name" />
					<textarea className="pa-input !h-20 resize-y !p-2 text-xs" value={p.purpose} disabled={!pending} onChange={(e) => setP({ ...p, purpose: e.target.value })} aria-label="群说明" placeholder="群说明：目标、分工（所有成员都会看到）" />
					<div className="flex items-center gap-1 text-xs text-mut">
						成员 {p.members.length} 位
						<Help>点 👑 设管理者：你不 @ 人时由它回答并派活。新成员是群专属助理，只在这个群里出现；模型只能从你已配置的服务里选。</Help>
					</div>
					<div className="grid gap-2 sm:grid-cols-2">
						{p.members.map((x, i) => (
							<MemberEditor key={i} m={x} catalog={catalog} defaults={defaults} locked={!pending || busy} manager={i === p.manager} onManager={() => setP({ ...p, manager: i })} onChange={(y) => setMember(i, y)} onRemove={p.members.length > 1 ? () => remove(i) : undefined} />
						))}
					</div>
					{pending && (
						<div className="flex flex-wrap items-center gap-2">
							<button className="pa-chip sm" data-testid="proposal-add" onClick={() => setP({ ...p, members: [...p.members, { name: `成员${p.members.length + 1}`, role: "", persona: "", model: null }] })}>
								<Plus className="pa-ic" /> 新成员
							</button>
							{userAgents.length > 0 && (
								<Select value="" options={userAgents.map((a) => ({ value: a.id, label: a.name }))} placeholder="拉入已有助理…" ariaLabel="拉入已有助理" testId="proposal-existing" className="max-w-full !h-8 text-xs" disabled={busy} onChange={(agentId) => setP({ ...p, members: [...p.members, { agentId }] })} />
							)}
						</div>
					)}
				</div>
			) : (
				<div className="space-y-2">
					{meta.reason && <p className="text-xs text-mut">{meta.reason}</p>}
					<MemberEditor m={mem} catalog={catalog} defaults={defaults} locked={!pending || busy} onChange={setMem} />
				</div>
			)}
			{err && <p className="mt-2 text-xs text-red-600">{err}</p>}
			{pending ? (
				<div className="pa-actions">
					<button className="pa-btn ghost" disabled={busy} onClick={dismiss} data-testid="proposal-dismiss">不用了</button>
					<button className="pa-btn primary" disabled={busy || (isRoom && !p.members.length)} onClick={confirm} data-testid="proposal-confirm">
						{busy && <Loader2 className="pa-ic animate-spin" />} {isRoom ? "确认创建" : "确认加入"}
					</button>
				</div>
			) : done && isRoom && meta.roomId ? (
				<div className="pa-actions">
					<button className="pa-btn primary" onClick={() => void useStore.getState().selectRoom(meta.roomId)} data-testid="proposal-open">打开群聊</button>
				</div>
			) : null}
		</div>
	);
}

/** 群专属助理（信息面板顶部）：私聊 /「复制到我的助理」 */
export function RoomAgentActions({ agentId, variant }: { agentId: string; variant?: "pane" }) {
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const room = useStore((s) => s.rooms.find((r) => r.id === agent?.room_id));
	const [open, setOpen] = useState(false);
	const [mem, setMem] = useState(false);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState("");
	if (!agent || agent.scope !== "room") return null;
	const pane = variant === "pane";
	const copy = async () => {
		setBusy(true);
		try {
			const r = await api<{ id: string; name: string; copiedMemories: number }>(`/api/agents/${agentId}/copy`, { method: "POST", json: { memory: mem } });
			await useStore.getState().loadAgents();
			setDone(`已复制为「${r.name}」${mem ? `，带上 ${r.copiedMemories} 条记忆` : ""}`);
			setOpen(false);
		} catch (e) {
			setDone((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className={cx("text-sm", pane ? "pa-group-box" : "mx-4 mb-3 rounded-xl border border-line p-3")} data-testid="room-agent-actions">
			<div className={cx("flex min-w-0 items-center gap-1", pane ? "pa-group-context" : "text-xs text-mut")}>
				<span className="min-w-0 flex-1 whitespace-normal break-words">群专属助理{room ? ` · ${room.name}` : ""}</span>
				<Help>只在这个群里出现，不在侧边栏。同一助理在私聊与所属群中共用这些设置。复制到我的助理后是一个独立的新助理，互不影响。</Help>
			</div>
			<div className={cx("flex flex-wrap gap-2", pane ? "pa-group-chips" : "mt-2")}>
				<button className="pa-chip sm" onClick={() => void useStore.getState().selectAgent(agentId)} data-testid="room-agent-chat">私聊</button>
				<button className="pa-chip sm" onClick={() => setOpen(!open)} data-testid="copy-to-mine">复制到我的助理</button>
			</div>
			{open && (
				<div className="mt-2 space-y-2">
					<label className="flex items-center gap-2 text-xs">
						<input type="checkbox" checked={mem} onChange={(e) => setMem(e.target.checked)} data-testid="copy-memory" /> 同时复制记忆
					</label>
					<button className="pa-btn primary" disabled={busy} onClick={copy} data-testid="copy-confirm">
						{busy && <Loader2 className="pa-ic animate-spin" />} 复制
					</button>
				</div>
			)}
			{done && <p className="mt-2 text-xs text-mut" data-testid="copy-done">{done}</p>}
		</div>
	);
}

/** 旧版群目标确认卡（不再产生新卡；历史里的卡照常显示、可确认）：用户可改目标和完成标准，确认后服务端建一个进行中的项目。 */
export function RoomGoalCard({ m }: { m: Message }) {
	const meta = m.meta;
	const [goal, setGoal] = useState(String(meta.goal ?? ""));
	const [doneCriteria, setDone] = useState(String(meta.doneCriteria ?? ""));
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const pending = meta.status === "pending";
	const done = meta.status === "confirmed";
	const confirm = async () => {
		setBusy(true);
		setErr("");
		try {
			await api(`/api/proposals/${m.id}/confirm`, { method: "POST", json: { goal, doneCriteria } });
			await useStore.getState().loadRooms();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className={cx("pa-card pa-plan w-full max-w-[560px]", done && "approved")} data-testid="room-goal">
			<div className="pa-card-top">
				<Flag className="pa-ic" />
				<b>开始项目</b>
				<span className="pa-tag">{done ? "已开始" : meta.status === "dismissed" ? "已取消" : "确认前不会开始"}</span>
			</div>
			<div className="space-y-2">
				<label className="block text-xs text-mut">目标<textarea className="pa-input mt-1 !h-16 resize-y !p-2 text-sm" value={goal} disabled={!pending || busy} onChange={(e) => setGoal(e.target.value)} data-testid="room-goal-goal" /></label>
				<label className="block text-xs text-mut">完成标准<textarea className="pa-input mt-1 !h-16 resize-y !p-2 text-sm" value={doneCriteria} disabled={!pending || busy} onChange={(e) => setDone(e.target.value)} data-testid="room-goal-done" /></label>
				{pending && <p className="text-xs text-mut2">确认后项目开始：成员之间可以直接配合，管理者在任务提交、卡住或定时检查时出来协调；只有需要你拍板的事才会问你。</p>}
			</div>
			{err && <p className="mt-2 text-xs text-red-600">{err}</p>}
			{pending && (
				<div className="pa-actions">
					<button className="pa-btn ghost" disabled={busy} onClick={() => void api(`/api/proposals/${m.id}/dismiss`, { method: "POST" })} data-testid="room-goal-dismiss">先不用</button>
					<button className="pa-btn primary" disabled={busy || !goal.trim() || !doneCriteria.trim()} onClick={confirm} data-testid="room-goal-confirm">{busy && <Loader2 className="pa-ic animate-spin" />} 确认开始</button>
				</div>
			)}
		</div>
	);
}

export const PROJECT_STATUS: Record<ProjectStatus, string> = { proposed: "待确认", active: "进行中", done: "已完成", stopped: "已停下", dismissed: "先不做" };
const PLAN_CARD_STATUS: Record<string, string> = { pending: "待你确认", confirmed: "已确认", dismissed: "先不做", superseded: "已被新方案取代" };

/** 一份方案的正文（方案卡和项目面板共用）：大白话小标题，每行一条；full 时带上假设 / 需要你提供 / 规模。 */
export function PlanBody({ plan, full }: { plan: ProjectPlan; full?: boolean }) {
	const [more, setMore] = useState(false);
	const assumptions = (plan.assumptions ?? []).filter(Boolean);
	const rows = (title: string, items: ReactNode[]) => (items.length ? <PlanSection title={title}><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></PlanSection> : null);
	return (
		<div className="pa-plan-body">
			{plan.goal && <PlanSection title="要做成什么"><p>{plan.goal}</p></PlanSection>}
			{plan.doneCriteria && <PlanSection title="怎样算完成"><p>{plan.doneCriteria}</p></PlanSection>}
			{full && assumptions.length > 0 && (
				<div className="pa-plan-assume" data-testid="room-plan-assumptions">
					<h4><Lightbulb className="pa-ic accent" />我们的理解<Help>管理者按常理替你定下的细节。哪条不对，直接在群里说，管理者会改了再给你看。</Help></h4>
					<ol>{assumptions.slice(0, 3).map((x, i) => <li key={i}>{x}</li>)}</ol>
					{assumptions.length > 3 && (
						<Fold title="其余几条" count={assumptions.length - 3} open={more} onToggle={() => setMore(!more)}>
							<ol start={4}>{assumptions.slice(3).map((x, i) => <li key={i}>{x}</li>)}</ol>
						</Fold>
					)}
				</div>
			)}
			{rows("分工", (plan.roles ?? []).map((r) => <><b>{r.member}</b>：{r.does}</>))}
			{rows("分几步", (plan.stages ?? []).map((s, i) => <><b>{i + 1}. {s.name}</b>{s.output ? `：交出${s.output}` : ""}</>))}
			{rows("会请你看一眼的地方", (plan.checkpoints ?? []).filter(Boolean))}
			{plan.deliverables && <PlanSection title="最后交给你"><p>{plan.deliverables}</p></PlanSection>}
			{full && plan.needs && <PlanSection title="需要你提供"><p>{plan.needs}</p></PlanSection>}
			{full && plan.scale && <PlanSection title="规模"><p>{plan.scale}</p></PlanSection>}
		</div>
	);
}
export function PlanSection({ title, children }: { title: string; children: ReactNode }) {
	return <section><h4>{title}</h4>{children}</section>;
}

/** 方案卡（管理者 room_plan 发出）：用户点「就这么干」开始项目、「先不做」放下；想改直接在群里说。 */
export function RoomPlanCard({ m }: { m: Message }) {
	const meta = m.meta;
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const status = String(meta.status ?? "pending");
	const pending = status === "pending";
	const act = async (what: "confirm" | "dismiss") => {
		setBusy(true);
		setErr("");
		try {
			await api(`/api/rooms/${meta.roomId}/projects/${meta.projectId}/${what}`, { method: "POST" });
			await useStore.getState().loadRooms();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className={cx("pa-card pa-plan w-full max-w-[560px]", !pending && "settled")} data-testid="room-plan" data-status={status} data-project={meta.projectId}>
			<div className="pa-card-top">
				<ClipboardCheck className="pa-ic accent" />
				<b>{meta.revision ? "改过的方案" : "方案"}：{String(meta.title ?? "")}</b>
				<span className="pa-tag" data-testid="room-plan-status">{PLAN_CARD_STATUS[status] ?? status}</span>
			</div>
			{meta.plan && <PlanBody plan={meta.plan as ProjectPlan} full />}
			{err && <p className="mt-2 text-xs text-red-600" role="alert">{err}</p>}
			{pending && (
				<>
					<p className="pa-plan-hint">想改哪里，直接在群里说；管理者改好会再给你看。</p>
					<div className="pa-actions">
						<button className="pa-btn ghost" disabled={busy} onClick={() => void act("dismiss")} data-testid="room-plan-dismiss">先不做</button>
						<button className="pa-btn primary" disabled={busy} onClick={() => void act("confirm")} data-testid="room-plan-confirm">{busy && <Loader2 className="pa-ic animate-spin" />} 就这么干</button>
					</div>
				</>
			)}
		</div>
	);
}
