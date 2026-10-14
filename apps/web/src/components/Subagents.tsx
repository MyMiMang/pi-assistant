import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Message } from "../types";
import { Help, Modal } from "./ui";
import { ArrowLeft, ArrowUp, Bot, Square, X } from "lucide-react";
import { useStore, type SubagentTab } from "../store";
import { Avatar } from "./ui";
import { BotTurn, group, SystemMsg, UserMsg } from "./ChatMessages";
import { isSendKey, SEND_HINT } from "../composer";

type Model = { provider: string; id: string; name?: string; providerName?: string };
interface Subagent { id: string; agent_id: string; conversation_id: string; task: string; status: string; model_provider: string; model_id: string; model_reason: string; last_activity_at: number; error_reason: string | null; result_summary: string | null }
const labels: Record<string, string> = { queued: "排队中", running: "运行中", stalled: "暂无进展", done: "已完成", failed: "失败", stopped: "已停止", timeout: "超时", lost: "重启中断" };
/** 有实时活动（显示“最后活动 N 秒前”） */
const active = (r: Subagent) => ["running", "stalled"].includes(r.status);
/** 还没到终态：运行中、暂无进展、排队等空位 —— 都可以停止 */
const live = (r: Subagent) => active(r) || r.status === "queued";
function State({ r }: { r: Subagent }) {
	const [ts, setTs] = useState(Date.now());
	useEffect(() => { if (!active(r)) return; const t = setInterval(() => setTs(Date.now()), 1000); return () => clearInterval(t); }, [r.status]);
	const seconds = Math.max(0, Math.round((ts - r.last_activity_at) / 1000));
	return <span className={r.status === "stalled" ? "text-amber-600" : ["failed", "timeout", "lost"].includes(r.status) ? "text-red-500" : "text-mut"} data-testid="subagent-state">{labels[r.status]}{active(r) ? ` · 最后活动 ${seconds} 秒前` : ""}</span>;
}
export function SubagentCard({ m }: { m: Message }) {
	const r = m.meta.subagent as Subagent;
	if (!r) return null;
	return <div className="pa-card w-full max-w-[560px]" data-testid="subagent-card" data-id={r.id} data-state={r.status}>
		<button className="w-full min-w-0 whitespace-normal text-left text-sm" onClick={() => useStore.getState().openSubagent(r)}><b className="block break-words" title={r.task}>子代理：{r.task}</b><div className="mt-1"><State r={r} /></div><div className="mt-1 break-words text-xs text-mut2">{r.model_id} · {r.model_reason}</div>{active(r) && m.meta.currentStep && <div className="mt-1 text-xs text-mut">当前：{({ bash: "运行命令", read: "读取文件", write: "写入文件", edit: "修改文件" } as Record<string, string>)[m.meta.currentStep] ?? m.meta.currentStep}</div>}</button>
		{r.error_reason && <div className="mt-2 text-xs text-red-500">{r.error_reason}</div>}
	</div>;
}
export function SubagentTabs({ tabs }: { tabs: SubagentTab[] }) {
	const selected = useStore((s) => s.subagent);
	const set = useStore((s) => s.set);
	if (!tabs.length) return null;
	return <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 py-2 text-sm" aria-label="会话分页" data-testid="subagent-tabs" role="tablist">
		<button role="tab" aria-selected={!selected} className={`pa-chip shrink-0 ${!selected ? "active" : ""}`} onClick={() => set({ subagent: null })}>主会话</button>
		{tabs.map((t) => <div key={t.id} className={`flex shrink-0 items-center rounded-lg border ${selected === t.id ? "border-accent bg-hover" : "border-transparent"}`}><button role="tab" aria-selected={selected === t.id} className="flex max-w-[220px] items-center gap-1 px-2 py-1.5 text-left" title={t.task} onClick={() => set({ subagent: t.id })}><Bot className="pa-ic shrink-0" /><span className="truncate">{t.task}</span></button><button className="pa-icon-btn pa-ghost !h-6 !w-6 shrink-0 mr-1" aria-label={`关闭分页：${t.task}`} title="关闭分页，后台任务继续运行" onClick={() => useStore.getState().closeSubagent(t.id)}><X size={12} /></button></div>)}
	</nav>;
}
export function SubagentChat({ id, visible }: { id: string; visible: boolean }) {
	const onClose = () => useStore.getState().set({ subagent: null });
	const [d, setD] = useState<{ subagent: Subagent; messages: Message[] } | null>(null);
	const [err, setErr] = useState("");
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const ta = useRef<HTMLTextAreaElement>(null);
	const agent = useStore((s) => s.agents.find((a) => a.id === d?.subagent.agent_id));
	useEffect(() => {
		if (!visible) return;
		let off = false;
		const load = () => void api<NonNullable<typeof d>>(`/api/subagents/${id}`).then((v) => !off && setD(v)).catch((e) => !off && setErr(String(e)));
		load(); const t = setInterval(load, 1000);
		return () => { off = true; clearInterval(t); };
	}, [id, visible]);
	useLayoutEffect(() => {
		if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
	}, [d]);
	useLayoutEffect(() => {
		if (ta.current) { ta.current.style.height = "auto"; ta.current.style.height = `${Math.min(ta.current.scrollHeight, 200)}px`; }
	}, [text]);
	const action = async (kind: "stop" | "retry") => { try { await api(`/api/subagents/${id}/${kind}`, { method: "POST" }); if (kind === "retry") onClose(); } catch (e) { setErr(String(e)); } };
	const send = async () => {
		if (!text.trim() || sending) return;
		setSending(true); setErr("");
		try {
			await api(`/api/subagents/${id}/messages`, { method: "POST", json: { text } });
			setText(""); stick.current = true;
			setD(await api<NonNullable<typeof d>>(`/api/subagents/${id}`));
		} catch (e) { setErr(String(e)); }
		finally { setSending(false); }
	};
	const rows = group(d?.messages ?? []);
	const running = !!d && active(d.subagent);
	const stoppable = !!d && live(d.subagent);
	const queued = d?.subagent.status === "queued";
	const last = rows[rows.length - 1];
	const avatar = agent ?? { id: d?.subagent.agent_id ?? "", avatar: "🔧", color: "#888" };
	return <section className="pa-chat" data-testid="subagent-detail" aria-label="子代理会话" role="tabpanel">
			<header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
				<button className="pa-icon-btn pa-ghost" onClick={onClose} aria-label="返回主会话" title="返回主会话"><ArrowLeft className="pa-ic" /></button>
				<Avatar agentId={avatar.id} text={avatar.avatar} color={avatar.color} size={32} />
				<div className="min-w-0 flex-1"><b className="block truncate text-sm" title={d?.subagent.task}>子代理：{d?.subagent.task ?? "加载中…"}</b><div className="truncate text-xs">{d && <State r={d.subagent} />}<span className="ml-2 text-mut2">{d?.subagent.model_id}</span></div></div>
				{d && (stoppable ? <button className="pa-chip" onClick={() => void action("stop")} data-testid="subagent-stop">停止</button> : ["failed", "timeout", "lost"].includes(d.subagent.status) && <button className="pa-chip" onClick={() => void action("retry")} data-testid="subagent-retry">重新派</button>)}
			</header>
			<div ref={scroller} className="pa-scroll scrollbar-thin" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
				<div className="pa-thread-body">
					{rows.map((r) => r.kind === "day" ? <div key={r.id} className="pa-day">{r.label}</div> : r.kind === "user" ? <UserMsg key={r.m.id} m={r.m} /> : r.kind === "system" ? <SystemMsg key={r.m.id} m={r.m} canContinue={false} /> : <BotTurn key={r.id} row={r} agent={avatar} live={running && r === last} />)}
					{running && last?.kind !== "bot" && <BotTurn row={null} agent={avatar} live />}
					{d?.subagent.error_reason && <p className="text-center text-xs text-red-500">{d.subagent.error_reason}</p>}
				</div>
			</div>
			<div className="pa-composer-wrap">
				{err && <p className="mx-auto mb-2 max-w-[760px] text-xs text-red-500" role="alert">{err}</p>}
				<div className="pa-composer">
					<textarea ref={ta} rows={1} value={text} onChange={(e) => setText(e.target.value)} aria-label="给子代理发消息" placeholder={stoppable ? "补充要求，或说「停」" : "给子代理发消息…"} onKeyDown={(e) => { if (isSendKey(e)) { e.preventDefault(); void send(); } }} />
					<div className="pa-composer-bar"><span className="min-w-0 flex-1 truncate text-xs text-mut2">{queued ? "子代理排队中，说「停」可取消" : running ? "子代理正在工作" : "继续这个子代理会话"} · {SEND_HINT}</span>{stoppable && !text.trim() ? <button className="pa-send" onClick={() => void action("stop")} aria-label="停止子代理"><Square size={13} fill="currentColor" /></button> : <button className="pa-send" disabled={sending || !text.trim()} onClick={() => void send()} aria-label="发送给子代理" title={SEND_HINT} aria-keyshortcuts="Shift+Enter"><ArrowUp className="pa-ic" /></button>}</div>
				</div>
				<div className="pa-foot-note">{agent?.name ?? "主会话"} 会收到子代理的完成回报 · {SEND_HINT}</div>
			</div>
	</section>;
}
export function SubagentTasks({ agentId, conversation, room }: { agentId?: string; conversation?: string; room?: string }) {
	const [rows, setRows] = useState<Subagent[]>([]);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		let off = false;
		const q = new URLSearchParams({ ...(agentId ? { agent: agentId } : {}), ...(conversation ? { conversation } : {}), ...(room ? { room } : {}) });
		const load = () => void api<Subagent[]>(`/api/subagents?${q}`).then((v) => !off && setRows(v)).catch(() => {});
		load(); const t = setInterval(load, 3000); return () => { off = true; clearInterval(t); };
	}, [agentId, conversation, room]);
	if (!rows.length) return null;
	return <><button className="pa-chip" onClick={() => setOpen(true)} data-testid="subagent-tasks" aria-label="选择子代理" title="子代理"><Bot className="pa-ic" /><span className="max-sm:hidden">子代理</span><span>{rows.filter(live).length || rows.length}</span></button><Modal open={open} onClose={() => setOpen(false)} title="后台子代理"><div className="space-y-2">{rows.map((r) => <button key={r.id} className="w-full min-w-0 whitespace-normal rounded-lg border border-line p-3 text-left text-sm" onClick={() => { setOpen(false); useStore.getState().openSubagent(r); }}><b className="block break-words" title={r.task}>{r.task}</b><div><State r={r} /></div></button>)}</div></Modal></>;
}
interface Settings { mode: "follow" | "auto" | "fixed"; allowed: Model[]; model?: Model; maxMinutes: number; maxConcurrent: number }
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
		<div className="flex items-center gap-1 font-semibold">子代理模型<Help>{agentId ? "跟随全局设置，或给这个助理指定模型。" : "默认用主会话的模型。自动挑选只在勾选的清单内按任务能力选择；也可以固定用一个模型。最多同时跑几个由「设置 › 模型 › 子代理并发上限」决定（默认 10 个，按助理算），满了自动排队；只能派一层。"}</Help></div>
		<select className="pa-input" value={value} onChange={(e) => void change(e.target.value)} aria-label="子代理模型"><option value="follow">{agentId ? "跟随全局" : "跟随主会话"}</option>{!agentId && <option value="auto">在允许清单里自动挑</option>}{d.models.map((m) => <option key={key(m)} value={key(m)}>{m.providerName ?? m.provider} / {m.name ?? m.id}</option>)}</select>
		{!agentId && d.settings.mode === "auto" && <div className="space-y-1">{d.models.map((m) => <label className="flex items-center gap-2 text-sm" key={key(m)}><input type="checkbox" checked={d.settings.allowed.some((x) => key(x) === key(m))} onChange={(e) => void save({ ...d.settings, allowed: e.target.checked ? [...d.settings.allowed, m] : d.settings.allowed.filter((x) => key(x) !== key(m)) })} />{m.providerName ?? m.provider} / {m.name ?? m.id}</label>)}</div>}
		{!agentId && <label className="flex items-center gap-2 text-sm text-mut">最长运行<input className="pa-input !w-20" type="number" min="1" defaultValue={d.settings.maxMinutes} aria-label="子代理最长运行分钟" onBlur={(e) => { const n = Number(e.target.value); if (n > 0 && n !== d.settings.maxMinutes) void save({ ...d.settings, maxMinutes: n }); }} />分钟</label>}
		{err && <p className="text-xs text-red-500">{err}</p>}
	</section>;
}
