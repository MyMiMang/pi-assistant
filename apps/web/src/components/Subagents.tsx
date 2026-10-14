import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Message } from "../types";
import { Help, Modal } from "./ui";
import { ArrowLeft, ArrowUp, Bot, Check, Square, X } from "lucide-react";
import { useStore } from "../store";
import { Avatar, cx } from "./ui";
import { BotTurn, group, SystemMsg, UserMsg } from "./ChatMessages";
import { isSendKey, SEND_HINT } from "../composer";
import { ModelPickerButton } from "./ModelPicker";
import { TaskInstructions, TaskRow, taskLive, taskTitle } from "./Tasks";

type Model = { provider: string; id: string; name?: string; providerName?: string; reasoning?: boolean };
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
/** 聊天里不再渲染子代理指令卡：任务统一走 header 的「子代理」入口 → 任务概览 → 详情。
 *  子代理的完成/失败回报仍由主会话的普通消息（“子代理回报：…”）承担，语义不变。 */
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
				<button className="pa-chip" onClick={onClose} aria-label="返回主会话" title="返回主会话"><ArrowLeft className="pa-ic" /><span className="max-sm:hidden">主会话</span></button>
				<Avatar agentId={avatar.id} text={avatar.avatar} color={avatar.color} size={32} />
				<div className="min-w-0 flex-1"><b className="block truncate text-sm" title={d?.subagent.task}>任务：{d ? taskTitle(d.subagent.task) : "加载中…"}</b><div className="truncate text-xs">{d && <State r={d.subagent} />}<span className="ml-2 text-mut2">{d?.subagent.model_id}</span></div></div>
				{d && (stoppable ? <button className="pa-chip" onClick={() => void action("stop")} data-testid="subagent-stop">停止</button> : ["failed", "timeout", "lost"].includes(d.subagent.status) && <button className="pa-chip" onClick={() => void action("retry")} data-testid="subagent-retry">重新派</button>)}
			</header>
			{d?.subagent.task ? <div className="shrink-0 border-b border-line px-4 py-2"><TaskInstructions text={d.subagent.task} label="查看任务说明（完整指令）" /></div> : null}
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
/** 「子代理」入口 + 任务概览。withMain 时在它旁边带上「主会话」——助理 header 里的一对。 */
export function SubagentTasks({ agentId, conversation, room, withMain }: { agentId?: string; conversation?: string; room?: string; withMain?: boolean }) {
	const [rows, setRows] = useState<Subagent[]>([]);
	const [open, setOpen] = useState(false);
	const selected = useStore((s) => s.subagent);
	useEffect(() => {
		let off = false;
		const q = new URLSearchParams({ ...(agentId ? { agent: agentId } : {}), ...(conversation ? { conversation } : {}), ...(room ? { room } : {}) });
		const load = () => void api<Subagent[]>(`/api/subagents?${q}`).then((v) => !off && setRows(v)).catch(() => {});
		load(); const t = setInterval(load, 3000); return () => { off = true; clearInterval(t); };
	}, [agentId, conversation, room]);
	if (!rows.length) return null;
	const running = rows.filter((r) => taskLive(r.status));
	const finished = rows.filter((r) => !taskLive(r.status));
	const openTask = (r: Subagent) => { setOpen(false); useStore.getState().openSubagent(r); };
	const row = (r: Subagent) => <TaskRow key={r.id} testId="subagent-row" id={r.id} title={taskTitle(r.task)} status={r.status} meta={`子代理 · ${r.model_id || "未指定模型"}`} time={r.last_activity_at} onClick={() => openTask(r)} />;
	return <>
		{withMain && <button className={cx("pa-chip", !selected && "active")} aria-current={!selected ? "page" : undefined} data-testid="subagent-main" title="回到主会话" onClick={() => useStore.getState().set({ subagent: null })}>主会话</button>}
		<button className="pa-chip" onClick={() => setOpen(true)} data-testid="subagent-tasks" aria-label="任务列表" title="任务"><Bot className="pa-ic" /><span className="max-sm:hidden">子代理</span><span>{running.length || rows.length}</span></button>
		<Modal open={open} onClose={() => setOpen(false)} title="任务" testId="task-overview">
			<div className="space-y-3 p-4" data-testid="task-list">
				{running.length > 0 ? <div className="space-y-2">{running.map(row)}</div> : <p className="px-1 text-xs text-mut2">现在没有运行中的任务。</p>}
				{finished.length > 0 && (
					<details className="group" data-testid="task-finished">
						<summary className="flex cursor-pointer list-none items-center gap-1 px-1 py-1 text-xs text-mut2 hover:text-mut [&::-webkit-details-marker]:hidden">
							<span className="transition group-open:rotate-90">›</span>已结束 {finished.length} 个
						</summary>
						<div className="mt-2 space-y-2">{finished.map(row)}</div>
					</details>
				)}
			</div>
		</Modal>
	</>;
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
	const cur = d.models.find((m) => key(m) === value);
	const save = async (s: Settings) => { setD({ ...d, settings: s }); try { await api("/api/subagents/settings", { method: "PUT", json: s }); setD({ ...d, settings: s }); setErr(""); } catch (e) { setD(d); setErr(String(e)); } };
	const change = async (v: string) => {
		const model = d.models.find((m) => key(m) === v);
		if (agentId) { const c = model ? { mode: "fixed" as const, model } : { mode: "follow" as const }; try { await api(`/api/agents/${agentId}/subagent-model`, { method: "PUT", json: c }); setChoice(c); } catch (e) { setErr(String(e)); } }
		else await save({ ...d.settings, mode: model ? "fixed" : v as "follow" | "auto", model });
	};
	return <section className="space-y-2" data-testid={agentId ? "agent-subagent-model" : "subagent-models"}>
		<div className="flex items-center gap-1 font-semibold">子代理模型<Help>{agentId ? "跟随全局设置，或给这个助理指定模型。" : "默认用主会话的模型。自动挑选只在勾选的清单内按任务能力选择；也可以固定用一个模型。最多同时跑几个由「设置 › 模型 › 子代理并发上限」决定（默认 10 个，按助理算），满了自动排队；只能派一层。"}</Help></div>
		<ModelPickerButton
			testid="subagent-model"
			models={d.models.map((m) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id, providerName: m.providerName, reasoning: m.reasoning }))}
			providers={[]}
			value={choice.mode === "fixed" && agentId ? (choice.model ?? null) : !agentId && d.settings.mode === "fixed" ? (d.settings.model ?? null) : null}
			placement="down"
			buttonClass="max-w-full"
			ariaLabel="子代理模型"
			title="子代理用哪个模型"
			text={value.startsWith("follow") ? (agentId ? "跟随全局" : "跟随主会话") : value === "auto" ? "在允许清单里自动挑" : cur ? `${cur.providerName ?? cur.provider} / ${cur.name ?? cur.id}` : "选择模型"}
			onPick={(m) => void change(key(m))}
			header={(close) => (
				<>
					<button type="button" className="mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" data-testid="subagent-model-follow" onClick={() => (close(), void change("follow"))}>
						<span className="min-w-0 flex-1 truncate">{agentId ? "跟随全局" : "跟随主会话"}</span>
						{value === "follow" && <Check size={14} className="shrink-0 text-accent" />}
					</button>
					{!agentId && (
						<button type="button" className="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" data-testid="subagent-model-auto" onClick={() => (close(), void change("auto"))}>
							<span className="min-w-0 flex-1 truncate">在允许清单里自动挑</span>
							{value === "auto" && <Check size={14} className="shrink-0 text-accent" />}
						</button>
					)}
				</>
			)}
		/>
		{!agentId && d.settings.mode === "auto" && <div className="space-y-1">{d.models.map((m) => <label className="flex items-center gap-2 text-sm" key={key(m)}><input type="checkbox" checked={d.settings.allowed.some((x) => key(x) === key(m))} onChange={(e) => void save({ ...d.settings, allowed: e.target.checked ? [...d.settings.allowed, m] : d.settings.allowed.filter((x) => key(x) !== key(m)) })} />{m.providerName ?? m.provider} / {m.name ?? m.id}</label>)}</div>}
		{!agentId && <label className="flex items-center gap-2 text-sm text-mut">最长运行<input className="pa-input !w-20" type="number" min="1" defaultValue={d.settings.maxMinutes} aria-label="子代理最长运行分钟" onBlur={(e) => { const n = Number(e.target.value); if (n > 0 && n !== d.settings.maxMinutes) void save({ ...d.settings, maxMinutes: n }); }} />分钟</label>}
		{err && <p className="text-xs text-red-500">{err}</p>}
	</section>;
}
