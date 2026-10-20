import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, Loader2, MessageSquare, Pause, Plus } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { Room } from "../types";
import { Modal, cx, fmtTime, useConfirm } from "./ui";
import { CreateWorkItem, DecisionBox, RUN_LABEL, StatusPill, WorkDetailPane, type BoardGroup, type WorkDetail, type WorkSummary } from "./WorkItemDetail";

/**
 * 群里的「任务」看板：和群聊是同一份任务责任记录，不是另一套项目管理系统。
 * 数据只来自 /api/rooms/:rid/work-items 与 /api/work-items/:id；打开时拉一次，动作后 / bus 事件再拉，不做不断轮询。
 * 分组：等你决定（高亮置顶，直接回答）· 卡住 · 进行中 · 已完成 / 已停止（默认折叠）。窄屏（390）同一份纵向列表 + 筛选。
 * 顶部有「全部暂停」（自主推进的入口在群聊顶部，见 Autonomy.tsx）：停群不停任务，要停全部任务用这里。
 */
const FILTERS: { value: "all" | BoardGroup; label: string }[] = [
	{ value: "all", label: "全部" },
	{ value: "doing", label: "进行中" },
	{ value: "stuck", label: "卡住" },
	{ value: "decision", label: "等你决定" },
	{ value: "done", label: "已完成" },
	{ value: "stopped", label: "已停止" },
];
const ORDER: BoardGroup[] = ["decision", "stuck", "doing", "done", "stopped"];
const LABEL: Record<BoardGroup, string> = { decision: "等你决定", stuck: "卡住", doing: "进行中", done: "已完成", stopped: "已停止" };
const FOLDED: BoardGroup[] = ["done", "stopped"];

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
			<div className="pa-actions">
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
	const [groups, setGroups] = useState<Partial<Record<BoardGroup, number>>>({});
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState("");
	const [filter, setFilter] = useState<"all" | BoardGroup>("all");
	const [detailId, setDetailId] = useState<string | null>(null);
	const [detail, setDetail] = useState<WorkDetail | null>(null);
	const [detailErr, setDetailErr] = useState("");
	const [creating, setCreating] = useState(false);
	const [more, setMore] = useState<{ before: number; id: string } | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const [dlg, ask] = useConfirm();
	const listGeneration = useRef(0);
	const detailGeneration = useRef(0);
	type WorkPage = { items: WorkSummary[]; groups: Record<BoardGroup, number>; hasMore: boolean; nextBefore: number | null };
	const pageQuery = useCallback(() => new URLSearchParams({ limit: "100", ...(filter !== "all" ? { group: filter } : {}) }), [filter]);
	const apply = (r: WorkPage, append: boolean) => {
		setItems((old) => (append ? [...old, ...r.items.filter((x) => !old.some((y) => y.id === x.id))] : r.items));
		setGroups(r.groups ?? {});
		setMore(r.hasMore && r.nextBefore !== null && r.items.length ? { before: r.nextBefore, id: r.items[r.items.length - 1].id } : null);
		setErr("");
	};
	const refresh = useCallback(async () => {
		const gen = ++listGeneration.current;
		setLoading(true);
		setLoadingMore(false);
		try {
			const r = await api<WorkPage>(`/api/rooms/${room.id}/work-items?${pageQuery()}`);
			if (gen === listGeneration.current) apply(r, false);
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
			if (gen === listGeneration.current) apply(r, true);
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
	const openCount = (groups.decision ?? 0) + (groups.stuck ?? 0) + (groups.doing ?? 0);
	const sections = useMemo(() => ORDER.map((g) => ({ g, rows: items.filter((x) => x.board === g) })).filter((s) => s.rows.length), [items]);
	// 默认「全部」时已完成 / 已停止折叠；用户明确筛选某个终态时直接展开，避免藏在折叠里点不到。
	const folded = filter === "all" ? sections.filter((s) => FOLDED.includes(s.g)) : [];
	const shown = sections.filter((s) => !folded.includes(s));
	const pauseAll = async () => {
		if (!(await ask({ title: "暂停这个群的全部任务？", body: `会中止 ${openCount} 个未完成任务正在进行的执行。之后可以在每个任务上点继续。停群不会停任务，要停任务用这里。`, ok: "全部暂停", danger: true }))) return;
		try {
			await api(`/api/rooms/${room.id}/work-items/pause-all`, { method: "POST" });
			void refresh();
		} catch (e) {
			setErr(String(e));
		}
	};
	const row = (x: WorkSummary) => (
		<div key={x.id} className={cx("pa-work-item", x.board === "decision" && "decision")}>
			<button className="pa-work-row" onClick={() => setDetailId(x.id)} data-testid="work-item-row" data-status={x.status} data-board={x.board}>
				<span className="pa-work-row-main">
					<b>{x.title}</b>
					<small>{x.ownerName || "未安排负责人"} · 修订 {x.revision} · {RUN_LABEL[x.runState]}</small>
					<span className="pa-work-progress">{x.board === "stuck" && x.escalation ? x.escalation.note : x.blocker && x.board === "stuck" ? `受阻：${x.blocker}` : x.latestProgress || "暂无进度"}</span>
				</span>
				<span className="pa-work-row-side"><StatusPill s={x} /><small>{fmtTime(x.updatedAt)}</small></span>
			</button>
			{x.board === "decision" ? <DecisionBox item={x} onDone={() => void refresh()} compact /> : null}
		</div>
	);
	const section = (s: { g: BoardGroup; rows: WorkSummary[] }) => (
		<section key={s.g} className={cx("pa-work-group", s.g === "decision" && "decision")} data-testid={`work-group-${s.g}`}>
			<h4>{LABEL[s.g]}<span>{groups[s.g] ?? s.rows.length}</span></h4>
			<div className="pa-work-rows">{s.rows.map(row)}</div>
		</section>
	);
	return (
		<>
			<button className={cx("pa-chip", (groups.decision ?? 0) > 0 && "pa-work-chip-alert")} onClick={() => setOpen(true)} data-testid="room-work-items" aria-label="长期任务看板" title="任务：长期责任、核验与执行历史">
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
										<button key={f.value} role="tab" aria-selected={filter === f.value} className={cx("pa-chip sm", filter === f.value && "!bg-hover", f.value === "decision" && (groups.decision ?? 0) > 0 && "pa-work-chip-alert")} onClick={() => setFilter(f.value)} data-testid={`work-filter-${f.value}`}>
											{f.label}
											{f.value !== "all" && groups[f.value] ? <span>{groups[f.value]}</span> : null}
										</button>
									))}
								</div>
								<div className="flex shrink-0 gap-1">
									{openCount > 0 ? <button className="pa-btn sm ghost" onClick={() => void pauseAll()} data-testid="work-pause-all"><Pause className="pa-ic" />全部暂停</button> : null}
									<button className="pa-btn sm primary" onClick={() => setCreating(true)} data-testid="work-create-open"><Plus className="pa-ic" />新建任务</button>
								</div>
							</div>
							{loading && !items.length ? <p className="pa-work-empty"><Loader2 className="pa-ic animate-spin" /> 正在加载…</p> : null}
							{err ? <p className="pa-work-error" role="alert" data-testid="work-list-error">{err}<button className="underline" onClick={() => void refresh()}>重试</button></p> : null}
							{!loading && !err && !sections.length ? <p className="pa-work-empty" data-testid="work-empty">还没有长期任务。临时问答不用建任务；需要长期负责的事可以在群里让管理者记录，或在这里新建。</p> : null}
							{shown.map(section)}
							{more && <button className="pa-btn ghost w-full" disabled={loadingMore || loading} onClick={() => void loadMore()} data-testid="work-load-more">{loadingMore ? "正在加载…" : "更早的任务"}</button>}
							{folded.length > 0 && (
								<details className="pa-work-closed" data-testid="work-closed">
									<summary>已完成 / 已停止 {folded.reduce((n, s) => n + (groups[s.g] ?? s.rows.length), 0)} 个</summary>
									{folded.map(section)}
								</details>
							)}
						</>
					)}
				</div>
			</Modal>
			{dlg}
			{creating && <CreateWorkItem room={room} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setDetailId(id); void refresh(); }} />}
		</>
	);
}
