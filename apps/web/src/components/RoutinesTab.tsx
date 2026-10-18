import { AlarmClock, Copy, Pause, Pencil, Play, Plus, RotateCw, Trash2, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Routine, RoutineRun } from "../types";
import { parseSchedule, scheduleCron, scheduleError, scheduleLabel, type Schedule } from "../routine-schedule";
import { Badge, Button, cx, fmtTime, Help, Input, useConfirm } from "./ui";
const RUN_TONE: Record<string, "green" | "red" | "amber" | "zinc" | "accent"> = { done: "green", failed: "red", skipped: "amber", cancelled: "zinc", running: "accent" };
const RUN_LABEL: Record<string, string> = { done: "完成", failed: "失败", skipped: "跳过", cancelled: "取消", running: "运行中" };
const TRIGGER_LABEL: Record<string, string> = { schedule: "到点", catchup: "补跑", webhook: "Webhook", manual: "手动" };

type Draft = { id?: string; name: string; prompt: string; trigger: "cron" | "webhook"; cron: string; quiet: boolean; quietWindow?: Routine["quiet"] };

/** 助理信息面板 › 定时任务 */
export function RoutinesTab({ agentId }: { agentId: string }) {
	const version = useStore((s) => s.routinesVersion);
	const tunnelUrl = useStore((s) => s.system?.tunnel.url);
	const [list, setList] = useState<Routine[]>([]);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [schedule, setSchedule] = useState<Schedule>(() => parseSchedule("0 8 * * *"));
	const [confirmDialog, askConfirm] = useConfirm();
	const localError = draft?.trigger === "cron" ? scheduleError(schedule) : null;
	const openDraft = (next: Draft) => {
		setSchedule(parseSchedule(next.cron));
		setPreview(null);
		setErr("");
		setDraft(next);
	};
	const changeSchedule = (next: Schedule) => {
		setSchedule(next);
		setPreview(null);
		if (draft) setDraft({ ...draft, cron: scheduleCron(next) ?? draft.cron });
	};
	const [preview, setPreview] = useState<{ ok: boolean; text?: string; error?: string } | null>(null);
	const [runs, setRuns] = useState<Record<string, RoutineRun[]>>({});
	const [err, setErr] = useState("");
	const load = () => api<Routine[]>(`/api/agents/${agentId}/routines`).then(setList);
	useEffect(() => {
		void load();
		for (const id of Object.keys(runs)) void api<RoutineRun[]>(`/api/routines/${id}/runs`).then((r) => setRuns((x) => ({ ...x, [id]: r })));
	}, [agentId, version]);
	useEffect(() => {
		setPreview(null);
		if (!draft || localError) return;
		let active = true;
		const t = setTimeout(() => void api<{ ok: boolean; text?: string; error?: string }>("/api/routines/preview", { method: "POST", json: { trigger: draft.trigger, cron: draft.cron, quietHours: draft.quiet } }).then((value) => { if (active) setPreview(value); }).catch((e) => { if (active) setPreview({ ok: false, error: String(e) }); }), 200);
		return () => { active = false; clearTimeout(t); };
	}, [draft?.id, draft?.cron, draft?.trigger, draft?.quiet, localError]);
	const save = async () => {
		if (!draft || localError || (draft.trigger === "cron" && !preview?.ok)) return;
		setErr("");
		const body = { name: draft.name, prompt: draft.prompt, trigger: draft.trigger, cron: draft.trigger === "cron" ? draft.cron : null, quiet: draft.quiet ? (draft.quietWindow ?? { start: "23:00", end: "07:00" }) : null };
		try {
			if (draft.id) await api(`/api/routines/${draft.id}`, { method: "PATCH", json: body });
			else await api(`/api/agents/${agentId}/routines`, { method: "POST", json: body });
			setDraft(null);
			void load();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
	};
	const toggleRuns = async (id: string) => {
		if (runs[id]) return setRuns(({ [id]: _, ...rest }) => rest);
		setRuns({ ...runs, [id]: await api<RoutineRun[]>(`/api/routines/${id}/runs`) });
	};
	const hookUrl = (r: Routine) => (r.webhookPath ? `${tunnelUrl ?? location.origin}${r.webhookPath}` : "");
	return (
		<div className="min-w-0 space-y-3" data-testid="routines-tab">
			{confirmDialog}
			<div className="flex items-center gap-2">
				<p className="flex-1 text-xs text-mut">到点自动让助理做事。 <Help>到点或收到 Webhook 时，用保存的指令唤醒助理在后台执行（电脑开着就行，不需要打开页面），结果发到聊天并推送。</Help></p>
				<Button size="sm" variant="outline" onClick={() => openDraft({ name: "", prompt: "", trigger: "cron", cron: "0 8 * * *", quiet: true })}>
					<Plus size={14} /> 新建
				</Button>
			</div>
			{draft && (
				<div className="pa-card space-y-2.5 !p-3" data-testid="routine-form">
					<Input placeholder="名称，例如：每日简报" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
					<textarea className="w-full rounded-lg border border-line bg-card p-2 text-sm outline-none focus:border-accent" rows={3} placeholder="到点时让助理做什么（完整写清楚，执行时看不到当前对话）" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
					<div className="flex gap-1">
						{(["cron", "webhook"] as const).map((k) => (
							<button key={k} className={cx("pa-chip sm", draft.trigger === k && "!bg-hover !text-fg font-medium")} onClick={() => setDraft({ ...draft, trigger: k })}>
								{k === "cron" ? "定时" : "Webhook 触发"}
							</button>
						))}
					</div>
					{draft.trigger === "cron" && (
						<>
							<label className="block space-y-1 text-xs">执行频率
								<select aria-label="执行频率" className="w-full rounded-lg border border-line bg-card p-2 text-sm" value={schedule.kind} onChange={(e) => changeSchedule({ ...schedule, kind: e.target.value as Schedule["kind"] })}>
									<option value="daily">每天</option><option value="weekdays">工作日（周一至周五）</option><option value="weekly">每周</option><option value="interval">每隔一段时间</option><option value="advanced">高级：cron 表达式</option>
								</select>
							</label>
							{schedule.kind === "advanced" ? <><Input className="font-mono" value={draft.cron} onChange={(e) => { setPreview(null); setDraft({ ...draft, cron: e.target.value }); }} aria-label="cron 表达式" /><p className="text-xs text-mut">保留原有表达式；格式为“分 时 日 月 周”。时间按任务时区计算，默认北京时间。</p></> : schedule.kind === "interval" ? <div className="flex min-w-0 items-center gap-2 text-xs">
								<span className="shrink-0">每隔</span><Input className="min-w-0 flex-1" type="number" min={schedule.unit === "minutes" ? 5 : 1} max={schedule.unit === "minutes" ? 60 : 24} aria-label="间隔数值" value={schedule.every} onChange={(e) => changeSchedule({ ...schedule, every: e.target.value })} />
								<select className="rounded-lg border border-line bg-card p-2" aria-label="间隔单位" value={schedule.unit} onChange={(e) => changeSchedule({ ...schedule, unit: e.target.value as Schedule["unit"], every: e.target.value === "hours" ? "1" : "30" })}><option value="minutes">分钟</option><option value="hours">小时</option></select>
							</div> : <div className="flex flex-wrap items-center gap-2">
								{schedule.kind === "weekly" && <select className="rounded-lg border border-line bg-card p-2 text-sm" aria-label="星期" value={schedule.weekday} onChange={(e) => changeSchedule({ ...schedule, weekday: e.target.value })}>{["日", "一", "二", "三", "四", "五", "六"].map((day, i) => <option key={day} value={i}>星期{day}</option>)}</select>}
								<Input className="min-w-0 flex-1" type="time" aria-label="执行时间" value={schedule.time} onChange={(e) => changeSchedule({ ...schedule, time: e.target.value })} />
							</div>}
							{localError && <p role="alert" className="text-xs text-red-500">{localError}</p>}
							<label className="flex items-center gap-2 text-xs">
								<input type="checkbox" checked={draft.quiet} onChange={(e) => setDraft({ ...draft, quiet: e.target.checked })} /> 免打扰 {draft.quietWindow?.start ?? "23:00"}–{draft.quietWindow?.end ?? "07:00"}（时段内的执行顺延到结束）
							</label>
						</>
					)}
					{preview && <div className={cx("text-xs", preview.ok ? "text-mut" : "text-red-500")}>{preview.ok ? preview.text : preview.error}</div>}
					{err && <div className="text-xs text-red-500">{err}</div>}
					<div className="flex justify-end gap-1.5">
						<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
							取消
						</Button>
						<Button size="sm" variant="primary" disabled={!draft.name.trim() || !draft.prompt.trim() || (draft.trigger === "cron" && (!!localError || !preview?.ok))} onClick={save}>
							保存
						</Button>
					</div>
				</div>
			)}
			{list.length === 0 && !draft && (
				<div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-mut">
					<AlarmClock size={26} className="opacity-60" />
					还没有定时任务
					<span className="text-xs">也可以直接在聊天里说“每天早上 8 点给我一份简报”</span>
				</div>
			)}
			<ul className="space-y-2">
				{list.map((r) => (
					<li key={r.id} className="pa-info-routine text-sm" data-testid="routine-item">
						<div className="flex items-start gap-2">
							{r.trigger === "webhook" ? <Webhook size={16} className="mt-0.5 text-mut" /> : <AlarmClock size={16} className="mt-0.5 text-mut" />}
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<b className="truncate">{r.name}</b>
									<Badge tone={r.status === "active" ? "green" : "zinc"}>{r.status === "active" ? "运行中" : "已暂停"}</Badge>
									{r.created_by === "agent" && <Badge tone="accent">助理创建</Badge>}
								</div>
								<div className="mt-0.5 line-clamp-2 text-xs text-mut">{r.prompt}</div>
								<div className="mt-1 text-xs text-mut">
									{r.trigger === "cron" ? (
										<>
											<span className="[overflow-wrap:anywhere]">{scheduleLabel(r.cron ?? "")}</span> · {r.status === "active" && r.next_run_at ? `下次执行 ${new Date(r.next_run_at).toLocaleString("zh-CN", { timeZone: r.tz, month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false })}` : "暂无下次执行"}
											{r.quiet && ` · 免打扰 ${r.quiet.start}–${r.quiet.end}`}
										</>
									) : (
										<span className="flex items-center gap-1">
											<code className="truncate font-mono">{hookUrl(r).replace(/\/[^/]+$/, "/••••")}</code>
											<button className="pa-icon-btn ghost !h-6 !w-6" aria-label="复制 Webhook 地址" onClick={() => navigator.clipboard.writeText(hookUrl(r))}>
												<Copy size={12} />
											</button>
										</span>
									)}
								</div>
								{r.lastRun && (
									<button className="mt-1 flex items-center gap-1 text-xs text-mut hover:text-fg" onClick={() => toggleRuns(r.id)}>
										上次：<Badge tone={RUN_TONE[r.lastRun.status]}>{RUN_LABEL[r.lastRun.status] ?? r.lastRun.status}</Badge> {fmtTime(r.lastRun.started_at)} · {runs[r.id] ? "收起历史" : "运行历史"}
									</button>
								)}
							</div>
						</div>
						{runs[r.id] && (
							<ul className="mt-2 space-y-1 border-t border-line pt-2 text-xs">
								{runs[r.id].map((x) => (
									<li key={x.id} className="flex gap-2">
										<Badge tone={RUN_TONE[x.status]}>{RUN_LABEL[x.status] ?? x.status}</Badge>
										<span className="shrink-0 text-mut">{fmtTime(x.started_at)} · {TRIGGER_LABEL[x.trigger] ?? x.trigger}</span>
										<span className="min-w-0 truncate">{x.result ?? x.error ?? ""}</span>
									</li>
								))}
							</ul>
						)}
						<div className="mt-2 flex flex-wrap justify-end gap-0.5">
							<Button size="sm" variant="ghost" onClick={() => api(`/api/routines/${r.id}/run`, { method: "POST" }).then(load)} title="立即运行一次">
								<RotateCw size={13} /> 运行
							</Button>
							<Button size="sm" variant="ghost" onClick={() => api(`/api/routines/${r.id}/${r.status === "active" ? "pause" : "resume"}`, { method: "POST" }).then(load)}>
								{r.status === "active" ? <Pause size={13} /> : <Play size={13} />} {r.status === "active" ? "暂停" : "恢复"}
							</Button>
							<Button size="sm" variant="ghost" aria-label="编辑" onClick={() => openDraft({ id: r.id, name: r.name, prompt: r.prompt, trigger: r.trigger, cron: r.cron ?? "0 8 * * *", quiet: !!r.quiet, quietWindow: r.quiet })}>
								<Pencil size={13} />
							</Button>
							<Button
								size="sm"
								variant="ghost"
								aria-label="删除定时任务"
								onClick={async () => {
									if (!(await askConfirm({ title: `删除定时任务「${r.name}」？`, danger: true, ok: "删除" }))) return;
									await api(`/api/routines/${r.id}`, { method: "DELETE" });
									void load();
								}}
							>
								<Trash2 size={13} />
							</Button>
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}
