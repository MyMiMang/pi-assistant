import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, ClipboardList, Loader2, MessageSquare, Plus, Send } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Room } from "../types";
import { Badge, Help, Modal, Select, cx, fmtTime } from "./ui";

/**
 * 群里的「任务」看板：和群聊是同一份任务责任记录，不是另一套项目管理系统。
 * 数据只来自 /api/rooms/:rid/work-items 与 /api/work-items/:id；打开时拉一次，动作后 / bus 事件再拉，
 * 不做不断轮询。桌面按状态分组，窄屏（390）用同一份纵向列表 + 状态筛选。
 */
interface WorkSummary {
	id: string;
	roomId: string | null;
	title: string;
	status: string;
	statusLabel: string;
	ownerAgentId: string | null;
	ownerName: string;
	latestProgress: string;
	blocker: string | null;
	revision: number;
	updatedAt: number;
	createdAt: number;
	runState: "none" | "queued" | "running" | "submitted" | "finished" | "failed" | "cancelled" | "interrupted";
}
interface WorkRun {
	id: string;
	revision: number;
	ownerAgentId: string;
	ownerName: string;
	execKind: string;
	execId: string | null;
	status: string;
	result: string | null;
	blocker: string | null;
	error: string | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	submittedAt: number | null;
	stale: boolean;
}
interface WorkEvent { id: string; kind: string; actorName: string; revision: number; detail: Record<string, unknown>; createdAt: number }
interface WorkDetail {
	item: WorkSummary & { requirement: string; doneCriteria: string; verification: { verdict?: string; note?: string; byName?: string; at?: number } | null; completedAt: number | null; sourceMessageId: string | null };
	runs: WorkRun[];
	events: WorkEvent[];
}
const RUN_LABEL: Record<string, string> = { none: "还没执行", queued: "排队中", running: "执行中", submitted: "已提交", finished: "执行结束", failed: "执行失败", cancelled: "执行已取消", interrupted: "执行中断" };
const STATUS_TONE: Record<string, "zinc" | "green" | "amber" | "red" | "accent"> = { pending: "zinc", active: "accent", blocked: "amber", review: "amber", done: "green", paused: "zinc", cancelled: "zinc" };
const FILTERS: { value: string; label: string }[] = [
	{ value: "all", label: "全部" },
	{ value: "active", label: "进行中" },
	{ value: "review", label: "待核验" },
	{ value: "blocked", label: "受阻" },
	{ value: "pending", label: "待安排" },
	{ value: "paused", label: "已暂停" },
	{ value: "done", label: "已完成" },
	{ value: "cancelled", label: "已取消" },
];
const OPEN = ["active", "review", "blocked", "pending", "paused"];
const GROUP = ["active", "review", "blocked", "pending", "paused", "done", "cancelled"];

function StatusPill({ s }: { s: WorkSummary }) {
	return <Badge tone={STATUS_TONE[s.status] ?? "zinc"}>{s.statusLabel}</Badge>;
}

/** 结果卡（成员提交时写进群里）：用户可以直接引用它指出问题，管理者据此定位同一个任务。 */
export function WorkResultCard({ meta }: { meta: Record<string, any> }) {
	const open = () => window.dispatchEvent(new CustomEvent("pia:work-item", { detail: { roomId: String(meta.roomId ?? ""), itemId: String(meta.workItemId ?? "") } }));
	const status = String(meta.status ?? "");
	return (
		<div className="pa-card pa-work-result w-full max-w-[560px]" data-testid="work-result-card" data-work-item={meta.workItemId}>
			<div className="pa-card-top">
				<ClipboardList className="pa-ic accent" />
				<b className="min-w-0 truncate">任务提交：{String(meta.title ?? "长期任务")}</b>
				<span className="pa-tag">{status === "blocked" ? "受阻" : "待核验"}</span>
			</div>
			{meta.summary ? <p className="pa-work-result-text">{String(meta.summary)}</p> : null}
			<div className="pa-actions !mt-2">
				<button className="pa-btn sm ghost" onClick={open} data-testid="work-result-open">查看任务</button>
				<button className="pa-btn sm" onClick={open} data-testid="work-result-feedback"><MessageSquare className="pa-ic" />有问题，在群里说</button>
			</div>
		</div>
	);
}

export function WorkItemsButton({ room }: { room: Room }) {
	const version = useStore((s) => (s as unknown as { workVersion?: number }).workVersion ?? 0);
	const [open, setOpen] = useState(false);
	const [items, setItems] = useState<WorkSummary[]>([]);
	const [counts, setCounts] = useState<Record<string, number>>({});
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState("");
	const [filter, setFilter] = useState("all");
	const [detailId, setDetailId] = useState<string | null>(null);
	const [detail, setDetail] = useState<WorkDetail | null>(null);
	const [detailErr, setDetailErr] = useState("");
	const [creating, setCreating] = useState(false);
	const [more, setMore] = useState<{ before: number; id: string } | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const listGeneration = useRef(0);
	const detailGeneration = useRef(0);
	type WorkPage = { items: WorkSummary[]; counts: Record<string, number>; hasMore: boolean; nextBefore: number | null };
	const pageQuery = useCallback(() => new URLSearchParams({ limit: "100", ...(filter !== "all" ? { status: filter } : {}) }), [filter]);
	const refresh = useCallback(async () => {
		const gen = ++listGeneration.current;
		setLoading(true);
		setLoadingMore(false);
		try {
			const r = await api<WorkPage>(`/api/rooms/${room.id}/work-items?${pageQuery()}`);
			if (gen !== listGeneration.current) return;
			setItems(r.items);
			setCounts(r.counts);
			setMore(r.hasMore && r.nextBefore !== null && r.items.length ? { before: r.nextBefore, id: r.items[r.items.length - 1].id } : null);
			setErr("");
		} catch (e) {
			if (gen === listGeneration.current) setErr(String(e));
		} finally {
			if (gen === listGeneration.current) setLoading(false);
		}
	}, [room.id, pageQuery]);
	const loadMore = async () => {
		if (!more || loadingMore || loading) return;
		const gen = ++listGeneration.current;
		setLoadingMore(true);
		const query = pageQuery(); query.set("before", String(more.before)); query.set("beforeId", more.id);
		try {
			const r = await api<WorkPage>(`/api/rooms/${room.id}/work-items?${query}`);
			if (gen !== listGeneration.current) return;
			setItems((old) => [...old, ...r.items.filter((x) => !old.some((y) => y.id === x.id))]);
			setCounts(r.counts);
			setMore(r.hasMore && r.nextBefore !== null && r.items.length ? { before: r.nextBefore, id: r.items[r.items.length - 1].id } : null);
			setErr("");
		} catch (e) {
			if (gen === listGeneration.current) setErr(String(e));
		} finally {
			if (gen === listGeneration.current) setLoadingMore(false);
		}
	};
	useEffect(() => () => { listGeneration.current++; detailGeneration.current++; }, [room.id]);
	useEffect(() => {
		if (open) void refresh();
	}, [open, version, refresh]);
	const loadDetail = useCallback(async (id: string) => {
		const gen = ++detailGeneration.current;
		setDetailErr("");
		try {
			const d = await api<WorkDetail>(`/api/work-items/${id}`);
			if (gen !== detailGeneration.current) return;
			if (d.item.id !== id || d.item.roomId !== room.id) throw new Error("任务归属不匹配，请重新打开");
			setDetail(d);
		} catch (e) {
			if (gen === detailGeneration.current) setDetailErr(String(e));
		}
	}, [room.id]);
	useEffect(() => {
		setDetail(null);
		if (detailId) void loadDetail(detailId);
		else detailGeneration.current++;
	}, [detailId, loadDetail, version]);
	// 群里的结果卡「查看任务 / 有问题，在群里说」定位到这里
	useEffect(() => {
		const onOpen = (e: Event) => {
			const d = (e as CustomEvent).detail as { roomId?: string; itemId?: string };
			if (d?.itemId && (!d.roomId || d.roomId === room.id)) {
				setOpen(true);
				setDetailId(d.itemId);
			}
		};
		window.addEventListener("pia:work-item", onOpen);
		const reset = (e: Event) => (e as CustomEvent).detail === room.id && (setDetailId(null), setOpen(true));
		window.addEventListener("pia:room-work-items", reset);
		return () => {
			window.removeEventListener("pia:work-item", onOpen);
			window.removeEventListener("pia:room-work-items", reset);
		};
	}, [room.id]);
	const openCount = OPEN.reduce((n, st) => n + (counts[st] ?? 0), 0);
	const shown = useMemo(() => (filter === "all" ? items : items.filter((x) => x.status === filter)), [items, filter]);
	const groups = useMemo(() => GROUP.map((st) => ({ status: st, rows: shown.filter((x) => x.status === st) })).filter((g) => g.rows.length), [shown]);
	// 默认「全部」时已完成 / 已取消折叠；用户明确筛选某个终态时直接展开，避免藏在 <details> 里点不到。
	const closed = filter === "all" ? groups.filter((g) => !OPEN.includes(g.status)) : [];
	const openGroups = groups.filter((g) => OPEN.includes(g.status) || (filter !== "all" && !OPEN.includes(g.status)));
	const row = (x: WorkSummary) => (
		<button key={x.id} className="pa-work-row" onClick={() => setDetailId(x.id)} data-testid="work-item-row" data-status={x.status}>
			<span className="pa-work-row-main">
				<b>{x.title}</b>
				<small>
					{x.ownerName || "未安排负责人"} · 修订 {x.revision} · {RUN_LABEL[x.runState]}
				</small>
				<span className="pa-work-progress">{x.latestProgress || "暂无进度"}</span>
			</span>
			<span className="pa-work-row-side">
				<StatusPill s={x} />
				<small>{fmtTime(x.updatedAt)}</small>
			</span>
		</button>
	);
	return (
		<>
			<button className="pa-chip" onClick={() => setOpen(true)} data-testid="room-work-items" aria-label="长期任务看板" title="任务：长期责任、核验与执行历史">
				<ClipboardList className="pa-ic" />
				<span>任务</span>
				{openCount > 0 && <span>{openCount}</span>}
			</button>
			<Modal open={open} onClose={() => setOpen(false)} title={detail ? "任务详情" : "任务"} wide fixed testId="work-items-overview">
				<div className="pa-work-board scrollbar-thin" data-testid="work-board">
					{detailId ? (
						<WorkDetailPane
							key={detailId}
							room={room}
							id={detailId}
							detail={detail?.item.id === detailId && detail.item.roomId === room.id ? detail : null}
							error={detailErr}
							onBack={() => (setDetailId(null), void refresh())}
							onChanged={() => {
								void refresh();
								void loadDetail(detailId);
							}}
							onSent={() => {
								setOpen(false);
								setDetailId(null);
								setDetail(null);
							}}
						/>
					) : (
						<>
							<div className="pa-work-toolbar">
								<div className="pa-work-filters" role="tablist" aria-label="按状态筛选">
									{FILTERS.map((f) => (
										<button key={f.value} role="tab" aria-selected={filter === f.value} className={cx("pa-chip sm", filter === f.value && "!bg-hover")} onClick={() => setFilter(f.value)} data-testid={`work-filter-${f.value}`}>
											{f.label}
											{f.value !== "all" && counts[f.value] ? <span>{counts[f.value]}</span> : null}
										</button>
									))}
								</div>
								<button className="pa-btn sm primary shrink-0" onClick={() => setCreating(true)} data-testid="work-create-open">
									<Plus className="pa-ic" />新建任务
								</button>
							</div>
							{loading && !items.length ? <p className="pa-work-empty"><Loader2 className="pa-ic animate-spin" /> 正在加载…</p> : null}
							{err ? <p className="pa-work-error" role="alert" data-testid="work-list-error">{err}<button className="underline" onClick={() => void refresh()}>重试</button></p> : null}
							{!loading && !err && !groups.length ? <p className="pa-work-empty" data-testid="work-empty">还没有长期任务。临时问答不用建任务；需要长期负责的事可以在群里让管理者记录，或在这里新建。</p> : null}
							{openGroups.map((g) => (
								<section key={g.status} className="pa-work-group" data-testid={`work-group-${g.status}`}>
									<h4>{items.find((x) => x.status === g.status)?.statusLabel ?? g.status}<span>{g.rows.length}</span></h4>
									<div className="pa-work-rows">{g.rows.map(row)}</div>
								</section>
							))}
							{more && <button className="pa-btn ghost w-full" disabled={loadingMore || loading} onClick={() => void loadMore()} data-testid="work-load-more">{loadingMore ? "正在加载…" : "更早的任务"}</button>}
							{closed.length > 0 && (
								<details className="pa-work-closed" data-testid="work-closed">
									<summary>已完成 / 已取消 {closed.reduce((n, g) => n + g.rows.length, 0)} 个</summary>
									{closed.map((g) => (
										<section key={g.status} className="pa-work-group">
											<h4>{items.find((x) => x.status === g.status)?.statusLabel ?? g.status}<span>{g.rows.length}</span></h4>
											<div className="pa-work-rows">{g.rows.map(row)}</div>
										</section>
									))}
								</details>
							)}
						</>
					)}
				</div>
			</Modal>
			{creating && <CreateWorkItem room={room} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setDetailId(id); void refresh(); }} />}
		</>
	);
}

function CreateWorkItem({ room, onClose, onCreated }: { room: Room; onClose: () => void; onCreated: (id: string) => void }) {
	const [title, setTitle] = useState("");
	const [requirement, setRequirement] = useState("");
	const [done, setDone] = useState("");
	const [owner, setOwner] = useState("");
	const [start, setStart] = useState(true);
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const members = room.members.filter((m) => !m.left && !m.deleted);
	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setErr("");
		try {
			const d = await api<WorkDetail>(`/api/rooms/${room.id}/work-items`, { method: "POST", json: { title, requirement, doneCriteria: done, ownerAgentId: owner || null, start } });
			onCreated(d.item.id);
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open onClose={onClose} title="新建任务" testId="work-create">
			<div className="space-y-3 p-4">
				<label className="pa-work-field"><span>任务名字</span><input className="pa-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：完成这周的竞品报告" autoFocus data-testid="work-create-title" /></label>
				<label className="pa-work-field"><span>要做成什么</span><textarea className="pa-input min-h-20" value={requirement} onChange={(e) => setRequirement(e.target.value)} placeholder="目标、范围、约束" data-testid="work-create-requirement" /></label>
				<label className="pa-work-field"><span>完成标准</span><textarea className="pa-input min-h-16" value={done} onChange={(e) => setDone(e.target.value)} placeholder="怎么检查算做完" data-testid="work-create-done" /></label>
				<div className="pa-work-field"><span>负责人</span>
					<Select value={owner} options={[{ value: "", label: "先不指定（待安排）", hint: "" }, ...members.map((m) => ({ value: m.agentId, label: m.name, hint: m.agentId === room.managerId ? "管理者" : "" }))]} onChange={setOwner} ariaLabel="任务负责人" testId="work-create-owner" />
				</div>
				<label className="flex items-center gap-2 text-sm text-mut"><input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} data-testid="work-create-start" />创建后马上派给负责人开始</label>
				<p className="text-xs text-mut2">只记录责任不会唤醒模型；勾选开始才会按群现有的串行调度派一次执行。执行结束也不会自动完成，要核验。</p>
				{err ? <p className="pa-work-error" role="alert" data-testid="work-create-error">{err}</p> : null}
				<div className="flex justify-end gap-2">
					<button className="pa-btn ghost" onClick={onClose}>取消</button>
					<button className="pa-btn primary" disabled={busy || !title.trim()} onClick={() => void submit()} data-testid="work-create-submit">{busy ? "保存中…" : "创建"}</button>
				</div>
			</div>
		</Modal>
	);
}

function WorkDetailPane({ room, id, detail, error, onBack, onChanged, onSent }: { room: Room; id: string; detail: WorkDetail | null; error: string; onBack: () => void; onChanged: () => void; onSent: () => void }) {
	const [err, setErr] = useState("");
	const [note, setNote] = useState("");
	const [feedback, setFeedback] = useState("");
	const [busy, setBusy] = useState("");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState({ title: "", requirement: "", doneCriteria: "" });
	const [owner, setOwner] = useState("");
	const members = room.members.filter((m) => !m.left && !m.deleted);
	useEffect(() => {
		if (!detail) return;
		setDraft({ title: detail.item.title, requirement: detail.item.requirement, doneCriteria: detail.item.doneCriteria });
		setOwner(detail.item.ownerAgentId ?? "");
	}, [detail?.item.id, detail?.item.revision]);
	const act = async (action: string, extra: Record<string, unknown> = {}) => {
		if (busy) return;
		setBusy(action);
		setErr("");
		try {
			await api(`/api/work-items/${id}/${action}`, { method: "POST", json: extra });
			setNote("");
			onChanged();
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy("");
		}
	};
	const patch = async (body: Record<string, unknown>) => {
		if (busy) return;
		setBusy("edit");
		setErr("");
		try {
			await api(`/api/work-items/${id}`, { method: "PATCH", json: body });
			setEditing(false);
			onChanged();
		} catch (e) {
			setErr(String(e)); // 失败保留草稿，不把用户写的内容清掉
		} finally {
			setBusy("");
		}
	};
	const sendFeedback = async () => {
		if (busy || !feedback.trim()) return;
		setBusy("feedback");
		setErr("");
		try {
			await api(`/api/work-items/${id}/feedback`, { method: "POST", json: { text: feedback } });
			setFeedback("");
			onSent();
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy("");
		}
	};
	if (!detail) {
		return <div className="p-4"><button className="pa-chip" onClick={onBack} data-testid="work-detail-back"><ArrowLeft className="pa-ic" />返回</button>{error ? <p className="pa-work-error" role="alert">{error}</p> : <p className="pa-work-empty"><Loader2 className="pa-ic animate-spin" />正在加载…</p>}</div>;
	}
	const it = detail.item;
	const canContinue = ["active", "blocked", "paused"].includes(it.status);
	return (
		<div className="pa-work-detail" data-testid="work-detail">
			<div className="pa-work-detail-head">
				<button className="pa-chip sm" onClick={onBack} data-testid="work-detail-back"><ArrowLeft className="pa-ic" />返回</button>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2"><b className="min-w-0 break-words" data-testid="work-detail-title">{it.title}</b><StatusPill s={it} /></div>
					<small>{it.ownerName || "未安排负责人"} · 第 {it.revision} 次修订 · {RUN_LABEL[it.runState]} · {fmtTime(it.updatedAt)}</small>
				</div>
			</div>
			{err && !editing ? <p className="pa-work-error" role="alert" data-testid="work-action-error">{err}</p> : null}
			<section className="pa-work-block"><h4>要做成什么</h4><p>{it.requirement || "（没有写）"}</p></section>
			<section className="pa-work-block"><h4>完成标准</h4><p>{it.doneCriteria || "（没有写）"}</p></section>
			<section className="pa-work-block"><h4>最近进度</h4><p>{it.latestProgress || "暂无"}</p>{it.blocker ? <p className="pa-work-warn"><AlertTriangle className="pa-ic" />受阻：{it.blocker}</p> : null}</section>
			{it.verification && it.verification.verdict === "pass" ? <section className="pa-work-block"><h4>验收结论</h4><p>{it.verification.note}<br /><small>{it.verification.byName} · {it.verification.at ? fmtTime(it.verification.at) : ""}</small></p></section> : null}
			<section className="pa-work-actions">
				{it.status === "pending" && it.ownerAgentId ? <button className="pa-btn sm primary" disabled={!!busy} onClick={() => void act("start")} data-testid="work-action-start">开始</button> : null}
				{canContinue ? <button className="pa-btn sm" disabled={!!busy} onClick={() => void act("continue")} data-testid="work-action-continue">继续 / 安排下一次执行</button> : null}
				{!["done", "cancelled"].includes(it.status) ? <button className="pa-btn sm ghost" disabled={!!busy} onClick={() => void act("pause")} data-testid="work-action-pause">暂停</button> : null}
				{!["done", "cancelled"].includes(it.status) ? <button className="pa-btn sm ghost" disabled={!!busy} onClick={() => void act("cancel")} data-testid="work-action-cancel">取消</button> : null}
				<button className="pa-btn sm ghost" disabled={!!busy} onClick={() => setEditing(!editing)} data-testid="work-action-edit">编辑要求 / 改派</button>
			</section>
			{["done", "cancelled"].includes(it.status) ? (
				<section className="pa-work-block"><h4>这个任务已经{it.status === "done" ? "完成" : "取消"}</h4>
					<p className="text-sm text-mut">要在这个任务上继续改，请在下面「在群里说」里明确说“重开，改成……”；管理者会恢复原任务、保留原来的验收历史。随便发一条消息不会自动复活。</p>
				</section>
			) : null}
			{it.status === "review" ? (
				<section className="pa-work-block pa-work-verify"><h4>核验</h4>
					<Help>核验必须写检查结论：你实际看到了什么、为什么通过或退回。普通文字回复不算验收；只有这里通过才完成。</Help>
					<textarea className="pa-input min-h-20" value={note} onChange={(e) => setNote(e.target.value)} placeholder="检查结论：看到了哪个产物、哪一处符合 / 不符合完成标准" data-testid="work-verify-note" />
					<div className="flex gap-2">
						<button className="pa-btn sm primary" disabled={!!busy || !note.trim()} onClick={() => void act("verify", { verdict: "pass", note })} data-testid="work-verify-pass"><CheckCircle2 className="pa-ic" />通过，完成</button>
						<button className="pa-btn sm" disabled={!!busy || !note.trim()} onClick={() => void act("verify", { verdict: "return", note })} data-testid="work-verify-return">退回修改</button>
					</div>
				</section>
			) : null}
			{editing ? (
				<section className="pa-work-block" data-testid="work-edit">
					<label className="pa-work-field"><span>任务名字</span><input className="pa-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
					<label className="pa-work-field"><span>要做成什么</span><textarea className="pa-input min-h-20" value={draft.requirement} onChange={(e) => setDraft({ ...draft, requirement: e.target.value })} data-testid="work-edit-requirement" /></label>
					<label className="pa-work-field"><span>完成标准</span><textarea className="pa-input min-h-16" value={draft.doneCriteria} onChange={(e) => setDraft({ ...draft, doneCriteria: e.target.value })} /></label>
					<div className="pa-work-field"><span>负责人</span><Select value={owner} options={[{ value: "", label: "未安排" }, ...members.map((m) => ({ value: m.agentId, label: m.name, hint: m.agentId === room.managerId ? "管理者" : "" }))]} onChange={setOwner} ariaLabel="任务负责人" /></div>
					{err ? <p className="pa-work-error" role="alert" data-testid="work-action-error">{err}</p> : null}
					<div className="flex justify-end gap-2"><button className="pa-btn ghost sm" onClick={() => setEditing(false)}>取消</button><button className="pa-btn primary sm" disabled={!!busy} onClick={() => void patch({ ...draft, ownerAgentId: owner || null })} data-testid="work-edit-save">保存</button></div>
				</section>
			) : null}
			<section className="pa-work-block pa-work-feedback">
				<h4><MessageSquare className="pa-ic" />有问题？在群里说</h4>
				<p className="text-xs text-mut2">会自动带上这个任务；管理者据此定位同一任务、更新要求并退回重做。不用先手动改看板状态。</p>
				<textarea className="pa-input min-h-16" value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="例如：这版缺少检查点，改成每条结论都附来源" data-testid="work-feedback-text" />
				<button className="pa-btn sm primary self-end" disabled={!!busy || !feedback.trim()} onClick={() => void sendFeedback()} data-testid="work-feedback-send"><Send className="pa-ic" />在群里说</button>
			</section>
			<section className="pa-work-block">
				<h4>执行历史</h4>
				{detail.runs.length === 0 ? <p className="text-xs text-mut2">还没有执行。任务责任和单次执行是分开的。</p> : (
					<div className="pa-work-runs">
						{detail.runs.map((r) => (
							<div key={r.id} className="pa-work-run" data-testid="work-run">
								<div className="flex flex-wrap items-center gap-2"><b>第 {r.revision} 次修订</b><span className="pa-tag">{r.status}</span>{r.stale ? <span className="pa-tag warn">旧修订 · 仅历史</span> : null}<small>{r.ownerName} · {fmtTime(r.createdAt)}</small></div>
								{r.result ? <p>{r.result.slice(0, 400)}</p> : null}
								{r.blocker ? <p className="pa-work-warn">受阻：{r.blocker}</p> : null}
								{r.error ? <p className="pa-work-error">{r.error}</p> : null}
							</div>
						))}
					</div>
				)}
				{detail.events.length > 0 ? (
					<details className="pa-work-events"><summary>变更记录 {detail.events.length}</summary>
						<ul>{detail.events.slice(0, 20).map((e) => <li key={e.id}>{fmtTime(e.createdAt)} · {e.actorName} · {e.kind} · 第 {e.revision} 次修订</li>)}</ul>
					</details>
				) : null}
			</section>
		</div>
	);
}
