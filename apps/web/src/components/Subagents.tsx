import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { api, getAgentSubagentSettings, setAgentSubagentSettings, type SubagentSettingsResponse } from "../api";
import type { Message } from "../types";
import { Button, Help } from "./ui";
import { SidePanel } from "./SidePanel";
import { ArrowLeft, ArrowUp, Bot, Square } from "lucide-react";
import { useStore } from "../store";
import { Avatar } from "./ui";
import { BotTurn, group, SystemMsg, UserMsg } from "./ChatMessages";
import { useComposerKeys } from "../composer";
import { useConfiguredModels, useModelPicks, ModelPoolButton, ThinkingButton, THINKING_LABEL } from "./ModelPicker";
import type { FastControl } from "./ThinkingSlider";
import { fitThinkingLevel } from "../thinking-slider";
import { LatestWrite, SerialWriteQueue } from "../latest-write";
import { thinkingLevelsFor } from "@pi-assistant/shared";
import { TaskInstructions, TaskRow, taskLive, taskStatus, taskTitle } from "./Tasks";
import type { HelperBrief } from "../member-status";

type Model = { provider: string; id: string; name?: string; providerName?: string; reasoning?: boolean };
const KIND_LABEL: Record<string, string> = { task: "后台任务", routine: "定时任务", heartbeat: "主动巡检", work: "群任务执行" };
interface Subagent { id: string; agent_id: string; conversation_id: string; task: string; status: string; model_provider: string; model_id: string; model_reason: string; thinking: string | null; resolvedThinking?: string; /** 请求级 Fast 覆盖：1 开 / 0 关 / null 跟随所属助理 */ fast?: number | null; resolvedFast?: boolean; last_activity_at: number; error_reason: string | null; result_summary: string | null; attempt?: number; retry_at?: number | null; canResume?: boolean; resumeReason?: string; needsVerify?: boolean; pendingToolNames?: string[]; /** 来源（决策 0014）：后台任务 / 定时任务 / 主动巡检；空 = 主会话派的 */ kind?: "task" | "routine" | "heartbeat" | "work" | null; title?: string | null; /** 派它的上一层帮手（最多一层） */ parent_subagent_id?: string | null }
/** 结果未知的工具名（needsVerify 时给用户看的危险名单；读不到会话时没有具体名字，给一句兜底）。 */
const verifyNames = (r: Subagent) => r.pendingToolNames?.length ? r.pendingToolNames.join("、") : "有工具调用结果未落库";
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
	return <span className={r.status === "stalled" ? "text-amber-600" : ["failed", "timeout", "lost"].includes(r.status) ? "text-red-500" : "text-mut"} data-testid="subagent-state">{taskStatus(r.status).label}{active(r) ? (retryIn > 0 ? ` · 等待重试 ${retryIn} 秒后` : ` · 最后活动 ${seconds} 秒前`) : ""}</span>;
}
/** 聊天里不再渲染子代理指令卡：任务统一走 header 的「子代理」入口 → 任务概览 → 详情。
 *  子代理的完成/失败回报仍由主会话的普通消息（“子代理回报：…”）承担，语义不变。 */
export function SubagentChat({ id, visible, room }: { id: string; visible: boolean; room?: string }) {
	const onClose = () => useStore.getState().set({ subagent: null });
	const [d, setD] = useState<{ subagent: Subagent; messages: Message[] } | null>(null);
	const [err, setErr] = useState("");
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const ta = useRef<HTMLTextAreaElement>(null);
	// Fast 保存中：1 秒一次的轮询拿到的还是旧值，不能让整份 setD 盖掉正在保存的开关
	const fastSaving = useRef(false);
	const agent = useStore((s) => s.agents.find((a) => a.id === d?.subagent.agent_id));
	const dm = useConfiguredModels();
	// 档位来源与实际选中的子代理模型一致（服务端也按这个模型 clamp）；用并集 helper，和主会话 / 助理默认同一套规则
	const levels: string[] = thinkingLevelsFor(dm.models, d?.subagent ? [{ provider: d.subagent.model_provider, id: d.subagent.model_id }] : []);
	// 用户设了固定档位但当前模型不支持 → 服务端已合法降级，这里如实说明，不静默吞掉用户选择
	const asked = d?.subagent.thinking ?? null;
	const resolved = d?.subagent.resolvedThinking ?? null;
	const clampNote = asked && resolved && asked !== resolved ? `这个模型不支持「${THINKING_LABEL[asked] ?? asked}」，实际按「${THINKING_LABEL[resolved] ?? resolved}」运行` : undefined;
	useEffect(() => {
		if (!visible) return;
		let off = false;
		// 轮询只负责刷消息 / 状态：Fast 还在保存时只保留本地 fast 两个字段，不用轮询到的旧值盖掉用户刚点的开关
		const load = () =>
			void api<NonNullable<typeof d>>(`/api/subagents/${id}`)
				.then((v) => {
					if (off) return;
					if (!fastSaving.current) return setD(v);
					setD((x) => (x ? { ...v, subagent: { ...v.subagent, fast: x.subagent.fast, resolvedFast: x.subagent.resolvedFast } } : v));
				})
				.catch((e) => !off && setErr(String(e)));
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
	// 改 Fast：单个子代理覆盖（null = 跟随所属助理）；只动 fast，不碰思考强度。保存中禁重复，失败回滚并给原因
	const [fastPending, setFastPending] = useState(false);
	const [fastErr, setFastErr] = useState("");
	// 代次守卫：只回滚 / 落地 fast 字段；轮询或切到别的子代理后，迟到的响应不能污染当前会话
	const fastWrites = useRef(new LatestWrite());
	useEffect(() => {
		// 切到别的子代理：作废在飞响应，并清掉上一个子代理的保存中 / 错误提示，避免卡住新会话的开关
		fastWrites.current.invalidate();
		fastSaving.current = false;
		setFastPending(false);
		setFastErr("");
		return () => fastWrites.current.invalidate();
	}, [id]);
	const setFast = async (v: boolean | null) => {
		if (fastPending || !d) return;
		const gen = fastWrites.current.begin();
		const prevFast = d.subagent.fast ?? null;
		const prevResolved = d.subagent.resolvedFast;
		setFastErr(""); setFastPending(true);
		fastSaving.current = true;
		// 乐观：只改 fast 两个字段，保留同一时刻轮询 / 插话带来的消息与状态
		setD((x) => (x ? { ...x, subagent: { ...x.subagent, fast: v === null ? null : v ? 1 : 0, resolvedFast: v === null ? agent?.fast === true : v } } : x));
		try {
			const res = await api<{ subagent: Subagent }>(`/api/subagents/${id}`, { method: "PATCH", json: { fast: v } });
			if (!fastWrites.current.isCurrent(gen)) return;
			setD((x) => (x ? { ...x, subagent: { ...x.subagent, fast: res.subagent.fast ?? null, resolvedFast: res.subagent.resolvedFast } } : x));
		} catch {
			if (!fastWrites.current.isCurrent(gen)) return;
			// 只回滚 fast 字段（不整份替换，避免覆盖新消息 / 新状态）
			setD((x) => (x ? { ...x, subagent: { ...x.subagent, fast: prevFast, resolvedFast: prevResolved } } : x));
			setFastErr("保存失败，已恢复原状态");
		} finally {
			if (fastWrites.current.isCurrent(gen)) {
				fastSaving.current = false;
				setFastPending(false);
			}
		}
	};
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
	// 左上角闪电：按子代理实际模型的协议能力；跟随态显示所属助理的值，点一下变成独立覆盖
	const subModel = d ? dm.models.find((m) => m.provider === d.subagent.model_provider && m.id === d.subagent.model_id) : undefined;
	const fastCap = subModel?.fast ?? { capability: "unsupported" as const, reason: "当前接口暂未接入 Fast" };
	const fast: FastControl | undefined = d
		? {
				on: d.subagent.fast === 1 ? true : d.subagent.fast === 0 ? false : d.subagent.resolvedFast === true,
				capability: fastCap.capability,
				reason: fastCap.reason,
				loading: dm.loading,
				mode: d.subagent.fast === 1 || d.subagent.fast === 0 ? "override" : "follow",
				pending: fastPending,
				error: fastErr || undefined,
				onToggle: () => void setFast(!(d.subagent.fast === 1 ? true : d.subagent.fast === 0 ? false : d.subagent.resolvedFast === true)),
				onFollow: () => void setFast(null),
			}
		: undefined;
	const rows = group(d?.messages ?? []);
	// 按键统一走 composer.ts（发送快捷键偏好 + 输入法防误发），与单聊 / 群聊一致
	const keys = useComposerKeys(send, undefined, id);
	const running = !!d && active(d.subagent);
	const stoppable = !!d && live(d.subagent);
	const queued = d?.subagent.status === "queued";
	const last = rows[rows.length - 1];
	const avatar = agent ?? { id: d?.subagent.agent_id ?? "", avatar: "🔧", color: "#888" };
	return <section className="pa-chat" data-testid="subagent-detail" aria-label="帮手会话" role="tabpanel">
			<header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
				<button className="pa-chip" onClick={onClose} aria-label="返回主会话" title="返回主会话"><ArrowLeft className="pa-ic" /><span className="max-sm:hidden">主会话</span></button>
				<Avatar agentId={avatar.id} text={avatar.avatar} color={avatar.color} size={32} />
				<div className="min-w-0 flex-1"><b className="block truncate text-sm" title={d?.subagent.task}>任务：{d ? taskTitle(d.subagent.task) : "加载中…"}</b><div className="truncate text-xs">{d && <State r={d.subagent} />}<span className="ml-2 text-mut2">{d?.subagent.model_id}</span></div></div>
				{/* 同一主会话（同 agent + 父对话）的其他子代理：直接在这里切换，不用先返回主会话。复用主会话现成的列表/查询/弹层。 */}
				{d && <SubagentTasks agentId={d.subagent.agent_id} conversation={d.subagent.conversation_id} room={room} current={id} testid="subagent-switch" overviewTestid="task-overview-switch" />}
				{d && !stoppable && ["failed", "timeout", "lost", "stopped"].includes(d.subagent.status) && d.subagent.canResume && <button className="pa-chip" onClick={() => void action("resume")} title={d.subagent.needsVerify ? `先核验这些工具的实际结果再继续：${verifyNames(d.subagent)}` : d.subagent.resumeReason ?? "用原任务从断点继续"} data-testid="subagent-resume">继续</button>}
				{d && !stoppable && ["failed", "timeout", "lost"].includes(d.subagent.status) && !d.subagent.canResume && <button className="pa-chip" onClick={() => void action("retry")} data-testid="subagent-retry">重新派</button>}
			</header>
			{d?.subagent.task ? <div className="shrink-0 border-b border-line px-4 py-2"><TaskInstructions text={d.subagent.task} label="查看任务说明（完整指令）" /></div> : null}
			<div ref={scroller} className="pa-scroll" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }}>
				<div className="pa-thread-body">
					{rows.map((r) => r.kind === "day" ? <div key={r.id} className="pa-day">{r.label}</div> : r.kind === "user" ? <UserMsg key={r.m.id} m={r.m} /> : r.kind === "system" ? <SystemMsg key={r.m.id} m={r.m} canContinue={false} /> : <BotTurn key={r.id} row={r} agent={avatar} live={running && r === last} />)}
					{running && last?.kind !== "bot" && <BotTurn row={null} agent={avatar} live />}
					{d?.subagent.error_reason && <p className="text-center text-xs text-red-500">{d.subagent.error_reason}</p>}
				</div>
			</div>
			<div className="pa-composer-wrap">
				{err && <p className="mx-auto mb-2 max-w-[760px] text-xs text-red-500" role="alert">{err}</p>}
				{d?.subagent.needsVerify && <p className="mx-auto mb-2 max-w-[760px] text-xs text-amber-600" role="status" data-testid="subagent-needs-verify">续跑前先核验：{verifyNames(d.subagent)}（这些工具调用已派发但结果没落库，副作用未知，别直接重跑）</p>}
				<div className="pa-composer">
					<textarea ref={ta} rows={1} value={text} onChange={(e) => setText(e.target.value)} aria-label="给帮手发消息" placeholder={stoppable ? "补充要求，或说「停」" : "给帮手发消息…"} {...keys.handlers} />
					<div className="pa-composer-bar">
					{/* 思考强度放在输入栏工具栏（与主会话一致），不再占 header；档位/跟随/持久化契约不变 */}
					<div className="pa-composer-tools">
						<span className="min-w-0 flex-1 truncate text-xs text-mut2">{queued ? "帮手排队中，说「停」可取消" : running ? "帮手正在工作" : "继续这个帮手会话"} · {keys.hint}</span>
						{d && <ThinkingButton testid="subagent-thinking" levels={levels} current={d.subagent.thinking ?? null} effective={d.subagent.resolvedThinking ?? null} modelName={d.subagent.model_id} followLabel="跟随助理默认" onPick={(v) => void setThinking(v)} title={clampNote} placement="up" loading={dm.loading} error={dm.error} onRetry={dm.reload} fast={fast} text={d.subagent.thinking ? undefined : `跟随·${THINKING_LABEL[d.subagent.resolvedThinking ?? ""] ?? d.subagent.resolvedThinking ?? "—"}`} />}
					</div>
					{stoppable && !text.trim() ? <button className="pa-send" onClick={() => void action("stop")} aria-label="停止帮手"><Square size={13} fill="currentColor" /></button> : <button className="pa-send" disabled={sending || !text.trim()} onClick={() => void send()} aria-label="发送给帮手" title={keys.hint} aria-keyshortcuts={keys.keyshortcuts}><ArrowUp className="pa-ic" /></button>}
				</div>
				</div>
				<div className="pa-foot-note">{agent?.name ?? "主会话"} 会收到帮手的完成回报 · {keys.hint}</div>
			</div>
	</section>;
}
/** 「执行」入口 + 帮手概览。 */
type HelperQuery = { agentId?: string; conversation?: string; room?: string };
// 同一个查询只开一个 3 秒轮询：「执行」入口和群成员 / 单聊顶部的工作状态共用同一份帮手列表
const pollers = new Map<string, { rows: Subagent[]; subs: Set<(v: Subagent[]) => void>; timer?: ReturnType<typeof setInterval> }>();
function useSubagentRows({ agentId, conversation, room }: HelperQuery) {
	const key = new URLSearchParams({ ...(agentId ? { agent: agentId } : {}), ...(conversation ? { conversation } : {}), ...(room ? { room } : {}) }).toString();
	const [rows, setRows] = useState<Subagent[]>(() => pollers.get(key)?.rows ?? []);
	useEffect(() => {
		const p = pollers.get(key) ?? { rows: [], subs: new Set() };
		pollers.set(key, p);
		p.subs.add(setRows);
		setRows(p.rows);
		if (!p.timer) {
			const load = () => void api<Subagent[]>(`/api/subagents?${key}`).then((v) => { p.rows = v; p.subs.forEach((f) => f(v)); }).catch(() => {});
			load();
			p.timer = setInterval(load, 3000);
		}
		return () => {
			p.subs.delete(setRows);
			if (!p.subs.size) (clearInterval(p.timer), pollers.delete(key));
		};
	}, [key]);
	return rows;
}
/** 工作状态用的帮手精简信息（member-status.ts）。 */
export function useHelperBriefs(q: HelperQuery): HelperBrief[] {
	return useSubagentRows(q).map((r) => ({ agentId: r.agent_id, kind: r.kind, title: taskTitle(r.title ?? r.task), status: r.status, live: taskLive(r.status) }));
}
export function SubagentTasks({ agentId, conversation, room, current, testid = "subagent-tasks", overviewTestid = "task-overview" }: HelperQuery & { current?: string; testid?: string; overviewTestid?: string }) {
	const rows = useSubagentRows({ agentId, conversation, room });
	const [open, setOpen] = useState(false);
	if (!rows.length) return null;
	const running = rows.filter((r) => taskLive(r.status));
	const finished = rows.filter((r) => !taskLive(r.status));
	const openTask = (r: Subagent) => { setOpen(false); useStore.getState().openSubagent(r); };
	const row = (r: Subagent) => <TaskRow key={r.id} testId="subagent-row" id={r.id} active={r.id === current} title={taskTitle(r.title ?? r.task)} status={r.status} meta={`${r.parent_subagent_id ? "下一层帮手" : KIND_LABEL[r.kind ?? ""] ?? "帮手"} · ${r.model_id || "未指定模型"}`} time={r.last_activity_at} onClick={() => openTask(r)} />;
	return <>
		<button className="pa-chip" onClick={() => setOpen(true)} data-testid={testid} aria-label="执行概览" title="执行概览：所有帮手的运行情况（含后台、定时、巡检）"><Bot className="pa-ic" /><span className="max-sm:hidden">执行</span><span>{running.length || rows.length}</span></button>
		<SidePanel open={open} onClose={() => setOpen(false)} title="任务" testId={overviewTestid}>
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
		</SidePanel>
	</>;
}
/**
 * 助理设置里的子代理模型：可搜索、按服务分组、多选的「候选池」。
 * 一个都不选 = 跟随主会话当前模型；选了就在池内按任务能力挑，失败只在池内换（详见 Help）。
 */
type LoadPhase = "loading" | "ready" | "error";
type SubagentThinkingState = { mode: "follow" } | { mode: "fixed"; level: string };
type Limits = SubagentSettingsResponse;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// 同一助理的写入串行（切分类重挂也一样）；读取排在此前写入之后，读到的就是真实值。
const subagentQueues = new Map<string, SerialWriteQueue>();
function subagentQueue(agentId: string) {
	let queue = subagentQueues.get(agentId);
	if (!queue) subagentQueues.set(agentId, (queue = new SerialWriteQueue()));
	return queue;
}

/**
 * 助理设置里的「子代理分工」：候选池、思考强度、任务上限。
 * 整段一个读取状态（失败一条错误 + 一个重试）和一条保存错误；保存失败回滚到服务端确认过的值。
 */
export function SubagentModels({ agentId }: { agentId: string }) {
	const d = useConfiguredModels();
	const { picks, record } = useModelPicks();
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const queue = subagentQueue(agentId);
	const [phase, setPhase] = useState<LoadPhase>("loading");
	const [loadErr, setLoadErr] = useState("");
	const [saveErr, setSaveErr] = useState("");
	const [saving, setSaving] = useState(0);
	const [pool, setPool] = useState<Model[]>([]);
	const [thinking, setThinking] = useState<SubagentThinkingState>({ mode: "follow" });
	const [limitsD, setLimitsD] = useState<Limits | null>(null);
	const [draft, setDraft] = useState<{ maxConcurrent: string; maxMinutes: string }>({ maxConcurrent: "", maxMinutes: "" });
	// 服务端确认过的值（失败回滚用）；gen：切助理 / 卸载后迟到的响应作废；writes：界面只认最后一次写入
	const confirmed = useRef<{ pool: Model[]; thinking: SubagentThinkingState }>({ pool: [], thinking: { mode: "follow" } });
	const gen = useRef(0);
	const writes = useRef(0);
	const syncLimits = (r: Limits) => {
		setLimitsD(r);
		setDraft({ maxConcurrent: String(r.settings.maxConcurrent), maxMinutes: String(r.settings.maxMinutes) });
	};
	const load = useCallback(() => {
		const g = ++gen.current;
		setPhase("loading");
		setLoadErr("");
		void queue
			.run(() => Promise.resolve())
			.then(() => Promise.all([api<{ pool: Model[] }>(`/api/agents/${agentId}/subagent-model`), api<SubagentThinkingState>(`/api/agents/${agentId}/subagent-thinking`), getAgentSubagentSettings(agentId)]))
			.then(([p, t, l]) => {
				if (g !== gen.current) return;
				const th: SubagentThinkingState = t?.mode === "fixed" && t.level ? { mode: "fixed", level: t.level } : { mode: "follow" };
				confirmed.current = { pool: p?.pool ?? [], thinking: th };
				setPool(confirmed.current.pool);
				setThinking(th);
				syncLimits(l);
				setPhase("ready");
			})
			.catch((e) => {
				if (g !== gen.current) return;
				setLoadErr(errText(e));
				setPhase("error");
			});
	}, [agentId, queue]);
	useEffect(() => {
		setSaveErr("");
		setSaving(0);
		load();
		return () => void gen.current++;
	}, [load]);
	/** 一次保存：乐观改界面 → 串行 PUT → 成功落确认值，失败回滚并写一条保存错误。 */
	const save = <T,>(label: string, optimistic: () => void, put: () => Promise<T>, done: (r: T) => void, rollback: () => void) => {
		const g = gen.current;
		const w = ++writes.current;
		optimistic();
		setSaveErr("");
		setSaving((n) => n + 1);
		void queue
			.run(put)
			.then((r) => g === gen.current && w === writes.current && done(r))
			.catch((e) => {
				if (g !== gen.current || w !== writes.current) return;
				rollback();
				setSaveErr(`${label}保存失败，已恢复原设置：${errText(e)}`);
			})
			.finally(() => g === gen.current && setSaving((n) => n - 1));
	};
	const savePool = (next: Model[]) =>
		save("候选池", () => setPool(next), () => api<{ pool: Model[] }>(`/api/agents/${agentId}/subagent-model`, { method: "PUT", json: { pool: next } }), (r) => setPool((confirmed.current.pool = r?.pool ?? next)), () => setPool(confirmed.current.pool));
	const saveThinking = (v: string | null) => {
		const c: SubagentThinkingState = v ? { mode: "fixed", level: v } : { mode: "follow" };
		save("思考强度", () => setThinking(c), () => api<SubagentThinkingState>(`/api/agents/${agentId}/subagent-thinking`, { method: "PUT", json: c }), (r) => setThinking((confirmed.current.thinking = r?.mode === "fixed" && r.level ? { mode: "fixed", level: r.level } : { mode: "follow" })), () => setThinking(confirmed.current.thinking));
	};
	const saveLimits = (patch: { maxConcurrent?: number | null; maxMinutes?: number | null }) => {
		const before = limitsD;
		save("任务上限", () => {}, () => setAgentSubagentSettings(agentId, patch), syncLimits, () => before && syncLimits(before));
	};
	// 失焦提交：清空 = 恢复默认；非法值恢复成生效值，不静默写 0。
	const commit = (k: "maxConcurrent" | "maxMinutes", raw: string) => {
		if (!limitsD) return;
		const trimmed = raw.trim();
		if (trimmed === "") return saveLimits({ [k]: null });
		const n = k === "maxConcurrent" ? Math.round(Number(trimmed)) : Number(trimmed);
		const ok = Number.isFinite(n) && n >= 1 && (k === "maxConcurrent" ? n <= 100 : true);
		if (!ok || n === limitsD.settings[k]) return setDraft((x) => ({ ...x, [k]: String(limitsD.settings[k]) }));
		saveLimits({ [k]: n });
	};
	const key = (m: Model) => `${m.provider}/${m.id}`;
	const nameOf = (m: Model) => d.models.find((x) => key(x) === key(m))?.name ?? m.id;
	const toggle = (m: { provider: string; id: string }, checked: boolean) => {
		record(m);
		const same = (x: Model) => key(x) === `${m.provider}/${m.id}`;
		savePool(checked ? [...pool.filter((x) => !same(x)), { provider: m.provider, id: m.id }] : pool.filter((x) => !same(x)));
	};
	const live = pool.filter((m) => d.models.some((x) => key(x) === key(m)));
	// 这个助理的子代理实际会用哪些模型（候选池；空池则跟随主会话）→ 取它们支持档位的**并集**，
	// 不取最低共同集合：候选池里只要有一个模型支持 xhigh/max 就保留，派到别的模型时由服务端 clamp。
	const candidates: Model[] = pool.length ? pool : agent?.model ? [agent.model] : [];
	const levels: string[] = thinkingLevelsFor(d.models, candidates);
	const levelsOf = (m: Model) => d.models.find((x) => key(x) === key(m))?.thinking ?? [];
	const fixedLevel = thinking?.mode === "fixed" ? thinking.level : null;
	// 并集里有这一档 ≠ 每个候选模型都支持：逐个模型核对。摘要只说「按实际模型自动调整」，
	// 不声称所有候选模型的实际档位都等于这个值。
	const fixedEverywhere = !!fixedLevel && candidates.length > 0 && candidates.every((m) => levelsOf(m).includes(fixedLevel));
	const label = (l: string) => THINKING_LABEL[l] ?? l;
	// 目录还在读 / 读失败时不冒充「不支持」或「都不支持」：那个状态交给 ThinkingButton 自己的 loading / error 说明
	const catalogReady = !d.loading && !d.error;
	// 用户已保存的固定档位若当前候选池里没有模型支持（比如换了池子），仍然显示出来并说明会被降级，不静默吞掉
	const unsupportedFixed = fixedLevel && catalogReady && !levels.includes(fixedLevel) ? `当前候选池里没有模型支持「${label(fixedLevel)}」，运行时会自动降到实际模型支持的档位` : undefined;
	const summary: string[] = [];
	if (phase === "loading") summary.push("正在读取…");
	else if (phase === "error") summary.push("读取失败 · 展开重试");
	else {
		summary.push(pool.length ? `候选池 ${pool.length} 个模型 · 派活时按任务挑` : `模型跟随聊天${agent?.model ? ` · 当前 ${nameOf(agent.model)}` : ""}`);
		if (thinking.mode === "fixed") {
			const suffix = unsupportedFixed ? " · 当前池没有模型支持，运行时自动降档" : fixedEverywhere ? "" : " · 按实际模型自动调整";
			summary.push(`思考 固定 ${label(thinking.level)}${suffix}`);
		} else summary.push(`思考跟随主会话${agent?.thinking ? ` · 当前 ${label(agent.thinking)}` : ""}`);
		if (limitsD) summary.push(`同时 ${limitsD.settings.maxConcurrent} 个 · 每次 ${limitsD.settings.maxMinutes} 分钟${limitsD.overrides.maxConcurrent === undefined && limitsD.overrides.maxMinutes === undefined ? " · 用默认值" : ""}`);
	}
	if (saving > 0) summary.push("保存中…");
	if (saveErr) summary.push("保存失败 · 展开查看原因");
	const text = pool.length ? `候选池 · ${pool.length} 个` : "跟随主会话";
	const busy = saving > 0;
	const d2 = limitsD;
	const inherit = (k: "maxConcurrent" | "maxMinutes") => !!d2 && d2.overrides[k] === undefined;
	const inheritHint = (k: "maxConcurrent" | "maxMinutes") => (inherit(k) ? <span className="text-[11px] text-mut2">默认 {d2?.defaults[k]}</span> : <button type="button" className="text-[11px] text-accent underline" disabled={busy} onClick={() => saveLimits({ [k]: null })} data-testid={`agent-subagent-inherit-${k}`}>恢复默认</button>);
	return (
		<details className="pa-info-details" data-testid="agent-subagent-details">
			<summary>
				高级 · 帮手
				<small>
					<span className="block">助理把大活拆给帮手时用的模型</span>
					<span className="block">{summary.join(" · ")}</span>
				</small>
			</summary>
			<div className="pa-info-details-body">
				<section className="space-y-2" data-testid="agent-subagent-model">
					<div className="flex items-center gap-1 font-semibold">帮手模型<Help>不选 = 跟随主会话当前模型。勾选后，派活时在这个候选池内按任务能力挑一个；某个模型不可用（限流 / 服务不可用 / 模型不存在 / 鉴权失败等）时，只在池内自动换下一个，用尽就停下，不会用池外模型，也不会无限重试。最多同时跑几个由下面的「任务上限」按助理决定（未覆盖则用整个安装的默认值）。</Help></div>
					{phase === "loading" ? (
						<div className="text-xs text-mut" role="status" data-testid="agent-subagent-loading">正在读取…</div>
					) : phase === "error" ? (
						<div className="flex flex-wrap items-center gap-2 text-xs text-red-500" data-testid="agent-subagent-load-error">
							<span className="min-w-0 [overflow-wrap:anywhere]">读取失败：{loadErr}</span>
							<Button size="sm" variant="outline" onClick={load} data-testid="agent-subagent-retry">重试</Button>
						</div>
					) : (
						<>
							<ModelPoolButton
								testid="subagent-model"
								models={d.models}
								providers={d.providers}
								value={pool}
								picks={picks}
								text={text}
								placement="down"
								buttonClass="max-w-full"
								ariaLabel="帮手候选池"
								title="勾选这个助理允许帮手用的模型"
								onToggle={toggle}
								onOpen={d.reload}
							/>
							{live.length > 0 && <div className="flex flex-wrap gap-1">{live.map((m) => <span key={key(m)} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-mut">{nameOf(m)}</span>)}</div>}
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-sm text-mut">思考强度</span>
								<ThinkingButton testid="agent-subagent-thinking" levels={levels} current={thinking.mode === "fixed" ? thinking.level : null} effective={thinking.mode === "fixed" ? fitThinkingLevel(levels, thinking.level) : (agent?.thinking ?? null)} followLabel="跟随主会话" title={unsupportedFixed} onPick={(v) => void saveThinking(v)} loading={d.loading} error={d.error} onRetry={d.reload} />
							</div>
							{unsupportedFixed && <p className="text-xs text-amber-600" data-testid="agent-subagent-thinking-note">{unsupportedFixed}</p>}
							{d2 && (
								<section data-testid="agent-subagent-limits" className="space-y-2">
									<div className="flex items-center gap-1 text-sm font-semibold">
										任务上限
										<Help>只对这个助理生效；留空或点「恢复默认」就用整个安装的默认值（默认并发 {d2.defaults.maxConcurrent}、最长 {d2.defaults.maxMinutes} 分钟）。并发指这个助理同时运行的帮手最多几个，满了自动排队。运行中的帮手在聊天顶部的「执行」里看。</Help>
									</div>
									<label className="flex flex-wrap items-center gap-2 text-sm text-mut">
										最多同时
										<input className="pa-input !w-24" type="number" min={1} max={100} disabled={busy} value={draft.maxConcurrent} aria-label="帮手并发上限" onChange={(e) => setDraft({ ...draft, maxConcurrent: e.target.value })} onBlur={(e) => commit("maxConcurrent", e.target.value)} />
										个帮手{inheritHint("maxConcurrent")}
									</label>
									<label className="flex flex-wrap items-center gap-2 text-sm text-mut">
										最长
										<input className="pa-input !w-24" type="number" min={1} disabled={busy} value={draft.maxMinutes} aria-label="帮手最长运行分钟" onChange={(e) => setDraft({ ...draft, maxMinutes: e.target.value })} onBlur={(e) => commit("maxMinutes", e.target.value)} />
										分钟{inheritHint("maxMinutes")}
									</label>
								</section>
							)}
						</>
					)}
					{saveErr && <p className="text-xs text-red-500 [overflow-wrap:anywhere]" role="alert" data-testid="agent-subagent-save-error">{saveErr}</p>}
				</section>
			</div>
		</details>
	);
}
