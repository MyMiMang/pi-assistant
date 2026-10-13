import { useEffect, useState } from "react";
import { api } from "../api";
import type { Message } from "../types";
import { Help, Modal } from "./ui";
import Markdown from "./Markdown";
import Attachments from "./Attachments";

type Model = { provider: string; id: string; name?: string; providerName?: string };
interface Subagent { id: string; task: string; status: string; model_provider: string; model_id: string; model_reason: string; last_activity_at: number; error_reason: string | null; result_summary: string | null }
const labels: Record<string, string> = { running: "运行中", stalled: "暂无进展", done: "已完成", failed: "失败", stopped: "已停止", timeout: "超时", lost: "重启中断" };
const active = (r: Subagent) => ["running", "stalled"].includes(r.status);
function State({ r }: { r: Subagent }) {
	const [ts, setTs] = useState(Date.now());
	useEffect(() => { if (!active(r)) return; const t = setInterval(() => setTs(Date.now()), 1000); return () => clearInterval(t); }, [r.status]);
	const seconds = Math.max(0, Math.round((ts - r.last_activity_at) / 1000));
	return <span className={r.status === "stalled" ? "text-amber-600" : ["failed", "timeout", "lost"].includes(r.status) ? "text-red-500" : "text-mut"} data-testid="subagent-state">{labels[r.status]}{active(r) ? ` · 最后活动 ${seconds} 秒前` : ""}</span>;
}
export function SubagentCard({ m }: { m: Message }) {
	const r = m.meta.subagent as Subagent;
	const [open, setOpen] = useState(false);
	if (!r) return null;
	return <div className="pa-card w-full max-w-[560px]" data-testid="subagent-card" data-id={r.id} data-state={r.status}>
		<button className="w-full text-left text-sm" onClick={() => setOpen(true)}><b>子代理：{r.task}</b><div className="mt-1"><State r={r} /></div><div className="mt-1 text-xs text-mut2">{r.model_id} · {r.model_reason}</div>{active(r) && m.meta.currentStep && <div className="mt-1 text-xs text-mut">当前：{({ bash: "运行命令", read: "读取文件", write: "写入文件", edit: "修改文件" } as Record<string, string>)[m.meta.currentStep] ?? m.meta.currentStep}</div>}</button>
		{r.error_reason && <div className="mt-2 text-xs text-red-500">{r.error_reason}</div>}
		{open && <SubagentDetail id={r.id} onClose={() => setOpen(false)} />}
	</div>;
}
function SubagentDetail({ id, onClose }: { id: string; onClose: () => void }) {
	const [d, setD] = useState<{ subagent: Subagent; messages: Message[] } | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => {
		let off = false;
		const load = () => void api<NonNullable<typeof d>>(`/api/subagents/${id}`).then((v) => !off && setD(v)).catch((e) => !off && setErr(String(e)));
		load(); const t = setInterval(load, 1000);
		return () => { off = true; clearInterval(t); };
	}, [id]);
	const action = async (kind: "stop" | "retry") => { try { await api(`/api/subagents/${id}/${kind}`, { method: "POST" }); if (kind === "retry") onClose(); } catch (e) { setErr(String(e)); } };
	return <div className="fixed inset-0 z-[80] bg-black/20" onClick={onClose}>
		<section className="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col bg-panel shadow-xl" onClick={(e) => e.stopPropagation()} data-testid="subagent-detail">
			<header className="flex shrink-0 items-center gap-2 border-b border-line p-4"><b className="min-w-0 flex-1 truncate">{d?.subagent.task ?? "子代理"}</b>{d && (active(d.subagent) ? <button className="pa-chip" onClick={() => void action("stop")} data-testid="subagent-stop">停止</button> : ["failed", "timeout", "lost"].includes(d.subagent.status) && <button className="pa-chip" onClick={() => void action("retry")} data-testid="subagent-retry">重新派</button>)}<button className="pa-chip" onClick={onClose} aria-label="关闭子代理详情">关闭</button></header>
			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
				{d && <><State r={d.subagent} /><p className="text-xs text-mut2">{d.subagent.model_provider} / {d.subagent.model_id} · {d.subagent.model_reason}</p><p className="text-xs text-mut">要补充要求，请回主会话说。</p></>}
				{err && <p className="text-red-500">{err}</p>}
				{d?.messages.map((m) => <div key={m.id} className="rounded-lg border border-line p-3" data-testid="subagent-step">
					{m.role === "tool" ? <details><summary>{m.meta.toolName} · {labels[m.status] ?? m.status}</summary><pre className="pa-pre">{JSON.stringify(m.meta.args, null, 2)}</pre><pre className="pa-pre">{m.meta.result ?? m.content}</pre></details> : <>{m.meta.thinking && <details><summary>思考</summary><pre className="pa-pre">{m.meta.thinking}</pre></details>}<Markdown text={m.content} /></>}
					{m.meta.attachments?.length ? <Attachments items={m.meta.attachments} /> : null}
				</div>)}
				{d?.subagent.error_reason && <p className="text-red-500">{d.subagent.error_reason}</p>}
			</div>
		</section>
	</div>;
}
export function SubagentTasks({ agentId, conversation, room }: { agentId?: string; conversation?: string; room?: string }) {
	const [rows, setRows] = useState<Subagent[]>([]);
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	useEffect(() => {
		let off = false;
		const q = new URLSearchParams({ ...(agentId ? { agent: agentId } : {}), ...(conversation ? { conversation } : {}), ...(room ? { room } : {}) });
		const load = () => void api<Subagent[]>(`/api/subagents?${q}`).then((v) => !off && setRows(v)).catch(() => {});
		load(); const t = setInterval(load, 3000); return () => { off = true; clearInterval(t); };
	}, [agentId, conversation, room]);
	if (!rows.length) return null;
	return <><button className="pa-chip" onClick={() => setOpen(true)} data-testid="subagent-tasks">后台 {rows.filter(active).length} 个任务</button><Modal open={open} onClose={() => setOpen(false)} title="后台子代理"><div className="space-y-2">{rows.map((r) => <button key={r.id} className="w-full rounded-lg border border-line p-3 text-left text-sm" onClick={() => setSelected(r.id)}><b>{r.task}</b><div><State r={r} /></div></button>)}</div></Modal>{selected && <SubagentDetail id={selected} onClose={() => setSelected(null)} />}</>;
}
interface Settings { mode: "follow" | "auto" | "fixed"; allowed: Model[]; model?: Model; maxMinutes: number }
export function SubagentModels({ agentId }: { agentId?: string }) {
	const [d, setD] = useState<{ settings: Settings; models: Model[] } | null>(null);
	const [choice, setChoice] = useState<{ mode: "follow" | "fixed"; model?: Model }>({ mode: "follow" });
	const [err, setErr] = useState("");
	useEffect(() => { void api<NonNullable<typeof d>>("/api/subagents/settings").then(setD); if (agentId) void api<typeof choice>(`/api/agents/${agentId}/subagent-model`).then(setChoice); }, [agentId]);
	if (!d) return null;
	const key = (m?: Model) => m ? `${m.provider}/${m.id}` : "";
	const value = agentId ? choice.mode === "fixed" ? key(choice.model) : "follow" : d.settings.mode === "fixed" ? key(d.settings.model) : d.settings.mode;
	const save = async (s: Settings) => { setD({ ...d, settings: s }); try { await api("/api/subagents/settings", { method: "PUT", json: s }); setD({ ...d, settings: s }); setErr(""); } catch (e) { setD(d); setErr(String(e)); } };
	const change = async (v: string) => {
		const model = d.models.find((m) => key(m) === v);
		if (agentId) { const c = model ? { mode: "fixed" as const, model } : { mode: "follow" as const }; try { await api(`/api/agents/${agentId}/subagent-model`, { method: "PUT", json: c }); setChoice(c); } catch (e) { setErr(String(e)); } }
		else await save({ ...d.settings, mode: model ? "fixed" : v as "follow" | "auto", model });
	};
	return <section className="space-y-2" data-testid={agentId ? "agent-subagent-model" : "subagent-models"}>
		<div className="flex items-center gap-1 font-semibold">子代理模型<Help>{agentId ? "跟随全局设置，或给这个助理指定模型。" : "默认用主会话的模型。自动挑选只在勾选的清单内按任务能力选择；也可以固定用一个模型。最多同时 3 个子代理，只能派一层。"}</Help></div>
		<select className="pa-input" value={value} onChange={(e) => void change(e.target.value)} aria-label="子代理模型"><option value="follow">{agentId ? "跟随全局" : "跟随主会话"}</option>{!agentId && <option value="auto">在允许清单里自动挑</option>}{d.models.map((m) => <option key={key(m)} value={key(m)}>{m.providerName ?? m.provider} / {m.name ?? m.id}</option>)}</select>
		{!agentId && d.settings.mode === "auto" && <div className="space-y-1">{d.models.map((m) => <label className="flex items-center gap-2 text-sm" key={key(m)}><input type="checkbox" checked={d.settings.allowed.some((x) => key(x) === key(m))} onChange={(e) => void save({ ...d.settings, allowed: e.target.checked ? [...d.settings.allowed, m] : d.settings.allowed.filter((x) => key(x) !== key(m)) })} />{m.providerName ?? m.provider} / {m.name ?? m.id}</label>)}</div>}
		{!agentId && <label className="flex items-center gap-2 text-sm text-mut">最长运行<input className="pa-input !w-20" type="number" min="1" defaultValue={d.settings.maxMinutes} aria-label="子代理最长运行分钟" onBlur={(e) => { const n = Number(e.target.value); if (n > 0 && n !== d.settings.maxMinutes) void save({ ...d.settings, maxMinutes: n }); }} />分钟</label>}
		{err && <p className="text-xs text-red-500">{err}</p>}
	</section>;
}
