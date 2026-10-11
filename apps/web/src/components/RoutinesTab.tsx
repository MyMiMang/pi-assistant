import { AlarmClock, Copy, Pause, Pencil, Play, Plus, RotateCw, Trash2, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import type { Routine, RoutineRun } from "../types";
import { Badge, Button, cx, fmtTime, Input } from "./ui";

const PRESETS: [string, string][] = [
	["每天 08:00", "0 8 * * *"],
	["工作日 09:00", "0 9 * * 1-5"],
	["每周一 10:00", "0 10 * * 1"],
	["每小时", "0 * * * *"],
	["每 30 分钟", "*/30 * * * *"],
];
const RUN_TONE: Record<string, "green" | "red" | "amber" | "zinc" | "accent"> = { done: "green", failed: "red", skipped: "amber", cancelled: "zinc", running: "accent" };
const RUN_LABEL: Record<string, string> = { done: "完成", failed: "失败", skipped: "跳过", cancelled: "取消", running: "运行中" };
const TRIGGER_LABEL: Record<string, string> = { schedule: "到点", catchup: "补跑", webhook: "Webhook", manual: "手动" };

type Draft = { id?: string; name: string; prompt: string; trigger: "cron" | "webhook"; cron: string; quiet: boolean };

/** 助理信息面板 › 定时任务 */
export function RoutinesTab({ agentId }: { agentId: string }) {
	const version = useStore((s) => s.routinesVersion);
	const tunnelUrl = useStore((s) => s.system?.tunnel.url);
	const [list, setList] = useState<Routine[]>([]);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [preview, setPreview] = useState<{ ok: boolean; text?: string; error?: string } | null>(null);
	const [runs, setRuns] = useState<Record<string, RoutineRun[]>>({});
	const [err, setErr] = useState("");
	const load = () => api<Routine[]>(`/api/agents/${agentId}/routines`).then(setList);
	useEffect(() => {
		void load();
		for (const id of Object.keys(runs)) void api<RoutineRun[]>(`/api/routines/${id}/runs`).then((r) => setRuns((x) => ({ ...x, [id]: r })));
	}, [agentId, version]);
	useEffect(() => {
		if (!draft) return;
		const t = setTimeout(() => void api("/api/routines/preview", { method: "POST", json: { trigger: draft.trigger, cron: draft.cron, quietHours: draft.quiet } }).then(setPreview), 200);
		return () => clearTimeout(t);
	}, [draft?.cron, draft?.trigger, draft?.quiet]);
	const save = async () => {
		if (!draft) return;
		setErr("");
		const body = { name: draft.name, prompt: draft.prompt, trigger: draft.trigger, cron: draft.trigger === "cron" ? draft.cron : null, quiet: draft.quiet ? { start: "23:00", end: "07:00" } : null };
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
		<div className="space-y-3" data-testid="routines-tab">
			<div className="flex items-center gap-2">
				<p className="flex-1 text-xs leading-relaxed text-mut">到点或收到 Webhook 时，用保存的指令唤醒助理在后台执行（电脑开着就行，不需要打开页面），结果发到聊天并推送。</p>
				<Button size="sm" variant="outline" onClick={() => setDraft({ name: "", prompt: "", trigger: "cron", cron: "0 8 * * *", quiet: true })}>
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
							<div className="flex flex-wrap gap-1">
								{PRESETS.map(([l, c]) => (
									<button key={c} className={cx("pa-chip sm", draft.cron === c && "!border-accent !text-accent")} onClick={() => setDraft({ ...draft, cron: c })}>
										{l}
									</button>
								))}
							</div>
							<Input className="font-mono" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} aria-label="cron 表达式" />
							<label className="flex items-center gap-2 text-xs">
								<input type="checkbox" checked={draft.quiet} onChange={(e) => setDraft({ ...draft, quiet: e.target.checked })} /> 免打扰 23:00–07:00（落在时段内的执行顺延到 07:00）
							</label>
						</>
					)}
					{preview && <div className={cx("text-xs", preview.ok ? "text-mut" : "text-red-500")}>{preview.ok ? preview.text : preview.error}</div>}
					{err && <div className="text-xs text-red-500">{err}</div>}
					<div className="flex justify-end gap-1.5">
						<Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
							取消
						</Button>
						<Button size="sm" variant="primary" disabled={!draft.name.trim() || !draft.prompt.trim() || (draft.trigger === "cron" && !preview?.ok)} onClick={save}>
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
					<li key={r.id} className="pa-card !p-3 text-sm" data-testid="routine-item">
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
											<code className="font-mono">{r.cron}</code> · {r.status === "active" && r.next_run_at ? `下次 ${fmtTime(r.next_run_at)}` : "—"}
											{r.quiet && " · 免打扰"}
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
						<div className="mt-2 flex justify-end gap-0.5">
							<Button size="sm" variant="ghost" onClick={() => api(`/api/routines/${r.id}/run`, { method: "POST" }).then(load)} title="立即运行一次">
								<RotateCw size={13} /> 运行
							</Button>
							<Button size="sm" variant="ghost" onClick={() => api(`/api/routines/${r.id}/${r.status === "active" ? "pause" : "resume"}`, { method: "POST" }).then(load)}>
								{r.status === "active" ? <Pause size={13} /> : <Play size={13} />} {r.status === "active" ? "暂停" : "恢复"}
							</Button>
							<Button size="sm" variant="ghost" aria-label="编辑" onClick={() => setDraft({ id: r.id, name: r.name, prompt: r.prompt, trigger: r.trigger, cron: r.cron ?? "0 8 * * *", quiet: !!r.quiet })}>
								<Pencil size={13} />
							</Button>
							<Button
								size="sm"
								variant="ghost"
								aria-label="删除定时任务"
								onClick={async () => {
									if (!confirm(`删除定时任务「${r.name}」？`)) return;
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
