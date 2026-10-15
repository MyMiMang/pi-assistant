import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Message } from "../types";
import { Help, Modal } from "./ui";
import { ArrowLeft, ArrowUp, Bot, Square } from "lucide-react";
import { useStore } from "../store";
import { Avatar } from "./ui";
import { BotTurn, group, SystemMsg, UserMsg } from "./ChatMessages";
import { isSendKey, SEND_HINT } from "../composer";
import { useConfiguredModels, useModelPicks, ModelPoolButton, ThinkingButton, THINKING_LABEL } from "./ModelPicker";
import { TaskInstructions, TaskRow, taskLive, taskTitle } from "./Tasks";

type Model = { provider: string; id: string; name?: string; providerName?: string; reasoning?: boolean };
interface Subagent { id: string; agent_id: string; conversation_id: string; task: string; status: string; model_provider: string; model_id: string; model_reason: string; thinking: string | null; resolvedThinking?: string; last_activity_at: number; error_reason: string | null; result_summary: string | null; attempt?: number; retry_at?: number | null; canResume?: boolean; resumeReason?: string }
const labels: Record<string, string> = { queued: "排队中", running: "运行中", stalled: "暂无进展", done: "已完成", failed: "失败", stopped: "已停止", timeout: "超时", lost: "重启中断" };
/** 有实时活动（显示“最后活动 N 秒前”） */
const active = (r: Subagent) => ["running", "stalled"].includes(r.status);
/** 还没到终态：运行中、暂无进展、排队等空位 —— 都可以停止 */
const live = (r: Subagent) => active(r) || r.status === "queued";
function State({ r }: { r: Subagent }) {
	const [ts, setTs] = useState(Date.now());
	useEffect(() => { if (!active(r)) return; const t = setInterval(() => setTs(Date.now()), 1000); return () => clearInterval(t); }, [r.status]);
	const seconds = Math.max(0, Math.round((ts - r.last_activity_at) / 1000));
	// 有界退避重试的等待时间：显示「等待重试 N 秒」，不空转、不误导成已停止
	const retryIn = r.retry_at ? Math.max(0, Math.ceil((r.retry_at - ts) / 1000)) : 0;
	return <span className={r.status === "stalled" ? "text-amber-600" : ["failed", "timeout", "lost"].includes(r.status) ? "text-red-500" : "text-mut"} data-testid="subagent-state">{labels[r.status]}{active(r) ? (retryIn > 0 ? ` · 等待重试 ${retryIn} 秒后` : ` · 最后活动 ${seconds} 秒前`) : ""}</span>;
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
	const dm = useConfiguredModels();
	const levels = dm.models.find((m) => m.provider === d?.subagent.model_provider && m.id === d?.subagent.model_id)?.thinking ?? [];
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
	const action = async (kind: "stop" | "retry" | "resume") => { try { await api(`/api/subagents/${id}/${kind}`, { method: "POST" }); if (kind === "retry") onClose(); else setD(await api<NonNullable<typeof d>>(`/api/subagents/${id}`)); } catch (e) { setErr(String(e)); } };
	// 改思考强度：写单个子代理的覆盖值（null = 跟随助理默认）；运行中后端会立即切换（不动主会话）
	const setThinking = async (v: string | null) => { try { await api(`/api/subagents/${id}`, { method: "PATCH", json: { thinking: v } }); setD(await api<NonNullable<typeof d>>(`/api/subagents/${id}`)); } catch (e) { setErr(String(e)); } };
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
				{d && <ThinkingButton testid="subagent-thinking" levels={levels} current={d.subagent.thinking ?? null} followLabel="跟随助理默认" onPick={(v) => void setThinking(v)} text={d.subagent.thinking ? undefined : `跟随·${THINKING_LABEL[d.subagent.resolvedThinking ?? ""] ?? d.subagent.resolvedThinking ?? "—"}`} />}
				{d && !stoppable && ["failed", "timeout", "lost", "stopped"].includes(d.subagent.status) && d.subagent.canResume && <button className="pa-chip" onClick={() => void action("resume")} title={d.subagent.resumeReason ?? "用原任务从断点继续"} data-testid="subagent-resume">继续</button>}
				{d && !stoppable && ["failed", "timeout", "lost"].includes(d.subagent.status) && !d.subagent.canResume && <button className="pa-chip" onClick={() => void action("retry")} data-testid="subagent-retry">重新派</button>}
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
/** 「子代理」入口 + 任务概览。 */
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
	const running = rows.filter((r) => taskLive(r.status));
	const finished = rows.filter((r) => !taskLive(r.status));
	const openTask = (r: Subagent) => { setOpen(false); useStore.getState().openSubagent(r); };
	const row = (r: Subagent) => <TaskRow key={r.id} testId="subagent-row" id={r.id} title={taskTitle(r.task)} status={r.status} meta={`子代理 · ${r.model_id || "未指定模型"}`} time={r.last_activity_at} onClick={() => openTask(r)} />;
	return <>
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
/**
 * 助理设置里的子代理模型：可搜索、按服务分组、多选的「候选池」。
 * 一个都不选 = 跟随主会话当前模型；选了就在池内按任务能力挑，失败只在池内换（详见 Help）。
 */
export function SubagentModels({ agentId }: { agentId: string }) {
	const d = useConfiguredModels();
	const { picks, record } = useModelPicks();
	const [pool, setPool] = useState<Model[]>([]);
	const [thinking, setThinking] = useState<{ mode: "follow" } | { mode: "fixed"; level: string }>({ mode: "follow" });
	const [err, setErr] = useState("");
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	useEffect(() => { void api<{ pool: Model[] }>(`/api/agents/${agentId}/subagent-model`).then((v) => setPool(v.pool ?? [])).catch((e) => setErr(String(e))); void api<typeof thinking>(`/api/agents/${agentId}/subagent-thinking`).then(setThinking).catch(() => {}); }, [agentId]);
	const key = (m: Model) => `${m.provider}/${m.id}`;
	const save = async (next: Model[]) => {
		const prev = pool;
		setPool(next);
		try { await api(`/api/agents/${agentId}/subagent-model`, { method: "PUT", json: { pool: next } }); setErr(""); }
		catch (e) { setPool(prev); setErr(String(e)); }
	};
	const toggle = (m: { provider: string; id: string }, checked: boolean) => {
		record(m);
		void save(checked ? [...pool.filter((x) => key(x) !== key(m)), { provider: m.provider, id: m.id }] : pool.filter((x) => key(x) !== key(m)));
	};
	const live = pool.filter((m) => d.models.some((x) => key(x) === key(m)));
	const nameOf = (m: Model) => d.models.find((x) => key(x) === key(m))?.name ?? m.id;
	// 这个助理的子代理实际会用哪些模型（候选池；空池则跟随主会话）→ 据此把可选档位 clamp 到它们的交集
	const candidates: Model[] = pool.length ? pool : agent?.model ? [agent.model] : [];
	const levelsOf = (m: Model) => d.models.find((x) => key(x) === key(m))?.thinking ?? [];
	const levels = candidates.length ? candidates.map(levelsOf).reduce((a, b) => (a.length && b.length ? a.filter((x) => b.includes(x)) : [])) : [];
	const saveThinking = async (v: string | null) => {
		const c: { mode: "follow" } | { mode: "fixed"; level: string } = v ? { mode: "fixed", level: v } : { mode: "follow" };
		try { await api(`/api/agents/${agentId}/subagent-thinking`, { method: "PUT", json: c }); setThinking(c); setErr(""); } catch (e) { setErr(String(e)); }
	};
	const text = pool.length ? `候选池 · ${pool.length} 个` : "跟随主会话";
	return <section className="space-y-2" data-testid="agent-subagent-model">
		<div className="flex items-center gap-1 font-semibold">子代理模型<Help>不选 = 跟随主会话当前模型。勾选后，派活时在这个候选池内按任务能力挑一个；某个模型不可用（限流 / 服务不可用 / 模型不存在 / 鉴权失败等）时，只在池内自动换下一个，用尽就停下，不会用池外模型，也不会无限重试。最多同时跑几个由「设置 › 模型 › 子代理」里的并发上限决定。</Help></div>
		<ModelPoolButton
			testid="subagent-model"
			models={d.models}
			providers={d.providers}
			value={pool}
			picks={picks}
			text={text}
			placement="down"
			buttonClass="max-w-full"
			ariaLabel="子代理候选池"
			title="勾选这个助理允许子代理用的模型"
			onToggle={toggle}
			onOpen={d.reload}
		/>
		{live.length > 0 && <div className="flex flex-wrap gap-1">{live.map((m) => <span key={key(m)} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-mut">{nameOf(m)}</span>)}</div>}
		<div className="flex items-center gap-2"><span className="text-sm text-mut">思考强度</span><ThinkingButton testid="agent-subagent-thinking" levels={levels} current={thinking.mode === "fixed" ? thinking.level : null} followLabel="跟随主会话" onPick={(v) => void saveThinking(v)} /></div>
		{err && <p className="text-xs text-red-500">{err}</p>}
	</section>;
}
