import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { api, getAgentSubagentSettings, setAgentSubagentSettings, type SubagentSettingsResponse } from "../api";
import type { Message } from "../types";
import { Button, Help, Modal } from "./ui";
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
import { TaskInstructions, TaskRow, taskLive, taskTitle } from "./Tasks";

type Model = { provider: string; id: string; name?: string; providerName?: string; reasoning?: boolean };
interface Subagent { id: string; agent_id: string; conversation_id: string; task: string; status: string; model_provider: string; model_id: string; model_reason: string; thinking: string | null; resolvedThinking?: string; /** 请求级 Fast 覆盖：1 开 / 0 关 / null 跟随所属助理 */ fast?: number | null; resolvedFast?: boolean; last_activity_at: number; error_reason: string | null; result_summary: string | null; attempt?: number; retry_at?: number | null; canResume?: boolean; resumeReason?: string; needsVerify?: boolean; pendingToolNames?: string[] }
const labels: Record<string, string> = { queued: "排队中", running: "运行中", stalled: "暂无进展", done: "已完成", failed: "失败", stopped: "已停止", timeout: "超时", lost: "重启中断" };
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
	return <span className={r.status === "stalled" ? "text-amber-600" : ["failed", "timeout", "lost"].includes(r.status) ? "text-red-500" : "text-mut"} data-testid="subagent-state">{labels[r.status]}{active(r) ? (retryIn > 0 ? ` · 等待重试 ${retryIn} 秒后` : ` · 最后活动 ${seconds} 秒前`) : ""}</span>;
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
	return <section className="pa-chat" data-testid="subagent-detail" aria-label="子代理会话" role="tabpanel">
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
					<textarea ref={ta} rows={1} value={text} onChange={(e) => setText(e.target.value)} aria-label="给子代理发消息" placeholder={stoppable ? "补充要求，或说「停」" : "给子代理发消息…"} {...keys.handlers} />
					<div className="pa-composer-bar">
					{/* 思考强度放在输入栏工具栏（与主会话一致），不再占 header；档位/跟随/持久化契约不变 */}
					<div className="pa-composer-tools">
						<span className="min-w-0 flex-1 truncate text-xs text-mut2">{queued ? "子代理排队中，说「停」可取消" : running ? "子代理正在工作" : "继续这个子代理会话"} · {keys.hint}</span>
						{d && <ThinkingButton testid="subagent-thinking" levels={levels} current={d.subagent.thinking ?? null} effective={d.subagent.resolvedThinking ?? null} modelName={d.subagent.model_id} followLabel="跟随助理默认" onPick={(v) => void setThinking(v)} title={clampNote} placement="up" loading={dm.loading} error={dm.error} onRetry={dm.reload} fast={fast} text={d.subagent.thinking ? undefined : `跟随·${THINKING_LABEL[d.subagent.resolvedThinking ?? ""] ?? d.subagent.resolvedThinking ?? "—"}`} />}
					</div>
					{stoppable && !text.trim() ? <button className="pa-send" onClick={() => void action("stop")} aria-label="停止子代理"><Square size={13} fill="currentColor" /></button> : <button className="pa-send" disabled={sending || !text.trim()} onClick={() => void send()} aria-label="发送给子代理" title={keys.hint} aria-keyshortcuts={keys.keyshortcuts}><ArrowUp className="pa-ic" /></button>}
				</div>
				</div>
				<div className="pa-foot-note">{agent?.name ?? "主会话"} 会收到子代理的完成回报 · {keys.hint}</div>
			</div>
	</section>;
}
/** 「子代理」入口 + 任务概览。 */
export function SubagentTasks({ agentId, conversation, room, current, testid = "subagent-tasks", overviewTestid = "task-overview" }: { agentId?: string; conversation?: string; room?: string; current?: string; testid?: string; overviewTestid?: string }) {
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
	const row = (r: Subagent) => <TaskRow key={r.id} testId="subagent-row" id={r.id} active={r.id === current} title={taskTitle(r.task)} status={r.status} meta={`子代理 · ${r.model_id || "未指定模型"}`} time={r.last_activity_at} onClick={() => openTask(r)} />;
	return <>
		<button className="pa-chip" onClick={() => setOpen(true)} data-testid={testid} aria-label="执行概览" title="执行概览：子代理与后台任务的运行情况"><Bot className="pa-ic" /><span className="max-sm:hidden">执行</span><span>{running.length || rows.length}</span></button>
		<Modal open={open} onClose={() => setOpen(false)} title="任务" testId={overviewTestid}>
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
/** 读取阶段：正在读 / 已按真实数据就绪 / 这一次读失败（不拿默认值冒充真实值）。 */
type LoadPhase = "loading" | "ready" | "error";
type SubagentThinkingState = { mode: "follow" } | { mode: "fixed"; level: string };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
// 同一助理切分类后仍按本端选择顺序写入；重挂的读取也等这些写入落定再取真实值。
const subagentQueues = new Map<string, SerialWriteQueue>();
function subagentQueue(agentId: string) {
	let queue = subagentQueues.get(agentId);
	if (!queue) subagentQueues.set(agentId, (queue = new SerialWriteQueue()));
	return queue;
}

export function SubagentModels({ agentId }: { agentId: string }) {
	const d = useConfiguredModels();
	const { picks, record } = useModelPicks();
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	// 候选池 / 思考强度各一份真实状态 + 各自的读取结果：读不到就说读不到，不拿默认值冒充「已跟随主会话」
	const [pool, setPool] = useState<Model[]>([]);
	const [poolPhase, setPoolPhase] = useState<LoadPhase>("loading");
	const [poolErr, setPoolErr] = useState("");
	const [thinking, setThinking] = useState<SubagentThinkingState | null>(null);
	const [thinkingPhase, setThinkingPhase] = useState<LoadPhase>("loading");
	const [thinkingErr, setThinkingErr] = useState("");
	const [poolSaveErr, setPoolSaveErr] = useState("");
	const [thinkingSaveErr, setThinkingSaveErr] = useState("");
	const [savingUi, setSavingUi] = useState(false);
	// 写入顺序：同一个助理的 PUT 串行发（勾选很快时不会乱序、把后一次选择抹掉）；界面只认最后一次，
	// 失败回滚到「服务端确认过」的快照，不拿乐观值当真相。
	const confirmedPool = useRef<Model[]>([]);
	const confirmedThinking = useRef<SubagentThinkingState>({ mode: "follow" });
	const poolWrites = useRef(new LatestWrite());
	const thinkingWrites = useRef(new LatestWrite());
	const queue = subagentQueue(agentId);
	// 每项独立重试和代次：不能重读并覆盖另一个仍可编辑、正在保存的字段。
	const life = useRef(0);
	const poolReads = useRef(0);
	const thinkingReads = useRef(0);
	const inFlight = useRef(0);
	const mark = (delta: number) => {
		inFlight.current += delta;
		setSavingUi(inFlight.current > 0);
	};
	const loadPool = useCallback(() => {
		const gen = ++poolReads.current;
		setPoolPhase("loading");
		setPoolErr("");
		void queue.run(() => Promise.resolve()).then(() => api<{ pool: Model[] }>(`/api/agents/${agentId}/subagent-model`))
			.then((v) => {
				if (gen !== poolReads.current) return;
				const p = v?.pool ?? [];
				confirmedPool.current = p;
				setPool(p);
				setPoolPhase("ready");
			})
			.catch((e) => {
				if (gen !== poolReads.current) return;
				setPoolErr(errText(e));
				setPoolPhase("error");
			});
	}, [agentId, queue]);
	const loadThinking = useCallback(() => {
		const gen = ++thinkingReads.current;
		setThinkingPhase("loading");
		setThinkingErr("");
		void queue.run(() => Promise.resolve()).then(() => api<SubagentThinkingState>(`/api/agents/${agentId}/subagent-thinking`))
			.then((v) => {
				if (gen !== thinkingReads.current) return;
				const t: SubagentThinkingState = v?.mode === "fixed" && v.level ? { mode: "fixed", level: v.level } : { mode: "follow" };
				confirmedThinking.current = t;
				setThinking(t);
				setThinkingPhase("ready");
			})
			.catch((e) => {
				if (gen !== thinkingReads.current) return;
				setThinkingErr(errText(e));
				setThinkingPhase("error");
			});
	}, [agentId, queue]);
	// 任务上限与摘要共用同一份 hook 状态（不复制服务器默认值）
	const limits = useSubagentLimits(agentId);
	useEffect(() => {
		life.current++;
		poolReads.current++;
		thinkingReads.current++;
		confirmedPool.current = [];
		confirmedThinking.current = { mode: "follow" };
		setPool([]);
		setPoolPhase("loading");
		setPoolErr("");
		setThinking(null);
		setThinkingPhase("loading");
		setThinkingErr("");
		setPoolSaveErr("");
		setThinkingSaveErr("");
		inFlight.current = 0;
		setSavingUi(false);
		loadPool();
		loadThinking();
		return () => {
			life.current++;
			poolReads.current++;
			thinkingReads.current++;
		};
	}, [loadPool, loadThinking]);
	const key = (m: Model) => `${m.provider}/${m.id}`;
	const nameOf = (m: Model) => d.models.find((x) => key(x) === key(m))?.name ?? m.id;
	const savePool = (next: Model[]) => {
		const lifeAt = life.current;
		const gen = poolWrites.current.begin();
		poolReads.current++;
		setPool(next); // 乐观：真正是否保存成功以服务端返回为准
		setPoolSaveErr("");
		mark(1);
		void queue
			.run(() => api<{ pool: Model[] }>(`/api/agents/${agentId}/subagent-model`, { method: "PUT", json: { pool: next } }))
			.then((res) => {
				if (life.current !== lifeAt) return;
				confirmedPool.current = res?.pool ?? next;
				if (poolWrites.current.isCurrent(gen)) {
					setPool(res?.pool ?? next);
					setPoolPhase("ready");
					setPoolSaveErr(""); // 只清这一项的失败；不掩盖思考强度的保存错误
				}
			})
			.catch((e) => {
				if (life.current !== lifeAt || !poolWrites.current.isCurrent(gen)) return;
				setPool(confirmedPool.current);
				setPoolSaveErr(`候选池没保存成功，已恢复为已保存的 ${confirmedPool.current.length} 个模型：${errText(e)}`);
			})
			.finally(() => {
				if (life.current === lifeAt) mark(-1);
			});
	};
	const toggle = (m: { provider: string; id: string }, checked: boolean) => {
		record(m);
		const same = (x: Model) => key(x) === `${m.provider}/${m.id}`;
		savePool(checked ? [...pool.filter((x) => !same(x)), { provider: m.provider, id: m.id }] : pool.filter((x) => !same(x)));
	};
	const saveThinking = (v: string | null) => {
		const c: SubagentThinkingState = v ? { mode: "fixed", level: v } : { mode: "follow" };
		const lifeAt = life.current;
		const gen = thinkingWrites.current.begin();
		thinkingReads.current++;
		setThinking(c); // 乐观
		setThinkingSaveErr("");
		mark(1);
		void queue
			.run(() => api<SubagentThinkingState>(`/api/agents/${agentId}/subagent-thinking`, { method: "PUT", json: c }))
			.then((res) => {
				if (life.current !== lifeAt) return;
				const real: SubagentThinkingState = res?.mode === "fixed" && res.level ? { mode: "fixed", level: res.level } : { mode: "follow" };
				confirmedThinking.current = real;
				if (thinkingWrites.current.isCurrent(gen)) {
					setThinking(real);
					setThinkingSaveErr("");
				}
			})
			.catch((e) => {
				if (life.current !== lifeAt || !thinkingWrites.current.isCurrent(gen)) return;
				setThinking(confirmedThinking.current);
				setThinkingSaveErr(`思考强度没保存成功，已恢复原设置：${errText(e)}`);
			})
			.finally(() => {
				if (life.current === lifeAt) mark(-1);
			});
	};
	const live = pool.filter((m) => d.models.some((x) => key(x) === key(m)));
	// 这个助理的子代理实际会用哪些模型（候选池；空池则跟随主会话）→ 取它们支持档位的**并集**，
	// 不取最低共同集合：候选池里只要有一个模型支持 xhigh/max 就保留，派到别的模型时由服务端 clamp。
	const candidates: Model[] = pool.length ? pool : agent?.model ? [agent.model] : [];
	const levels: string[] = thinkingLevelsFor(d.models, candidates);
	const levelsOf = (m: Model) => d.models.find((x) => key(x) === key(m))?.thinking ?? [];
	const fixedLevel = thinking?.mode === "fixed" ? thinking.level : null;
	// 并集里有这一档 ≠ 每个候选模型都支持：逐个模型核对。摘要只说「运行时按实际模型收敛」，
	// 不声称所有候选模型的实际档位都等于这个值。
	const fixedEverywhere = !!fixedLevel && candidates.length > 0 && candidates.every((m) => levelsOf(m).includes(fixedLevel));
	const label = (l: string) => THINKING_LABEL[l] ?? l;
	// 目录还在读 / 读失败时不冒充「不支持」或「都不支持」：那个状态交给 ThinkingButton 自己的 loading / error 说明
	const catalogReady = !d.loading && !d.error;
	// 用户已保存的固定档位若当前候选池里没有模型支持（比如换了池子），仍然显示出来并说明会被降级，不静默吞掉
	const unsupportedFixed = fixedLevel && catalogReady && !levels.includes(fixedLevel) ? `当前候选池里没有模型支持「${label(fixedLevel)}」，运行时会被收敛到实际模型支持的档位` : undefined;
	// 摘要每一项都来自同一份真实状态：正在读 / 读失败如实写，不写成「跟随」或默认值
	const summary: string[] = [];
	if (poolPhase === "loading") summary.push("候选池 正在读取…");
	else if (poolPhase === "error") summary.push("候选池 读取失败 · 展开重试");
	else summary.push(pool.length ? `候选池 ${pool.length} 个模型 · 派活时按任务挑` : `模型跟随聊天${agent?.model ? ` · 当前 ${nameOf(agent.model)}` : ""}`);
	if (thinkingPhase === "loading") summary.push("思考强度 正在读取…");
	else if (thinkingPhase === "error") summary.push("思考强度 读取失败 · 展开重试");
	else if (thinking?.mode === "fixed") {
		// 并集档位 ≠ 每个候选模型的实际档位：只承诺「运行时按实际模型收敛」，不声称所有模型 effective 同值
		const suffix = unsupportedFixed ? " · 当前池没有模型支持，运行时会收敛" : fixedEverywhere ? "" : " · 运行时按实际模型收敛";
		summary.push(`思考 固定 ${label(thinking.level)}${suffix}`);
	}
	else summary.push(`思考跟随主会话${agent?.thinking ? ` · 当前 ${label(agent.thinking)}` : ""}`);
	if (limits.phase === "loading") summary.push("任务上限 正在读取…");
	else if (limits.phase === "error") summary.push("任务上限 读取失败 · 展开重试");
	else if (limits.d) summary.push(`同时 ${limits.d.settings.maxConcurrent} 个 · 每次 ${limits.d.settings.maxMinutes} 分钟${limits.d.overrides.maxConcurrent === undefined && limits.d.overrides.maxMinutes === undefined ? " · 继承默认" : ""}`);
	if (savingUi || limits.saving) summary.push("保存中…");
	if (poolSaveErr || thinkingSaveErr || (limits.phase === "ready" && limits.err)) summary.push("保存失败 · 展开查看原因");
	const text = pool.length ? `候选池 · ${pool.length} 个` : "跟随主会话";
	return (
		<details className="pa-info-details" data-testid="agent-subagent-details">
			<summary>
				子代理分工
				<small>
					{summary.map((line) => <span key={line} className="block">{line}</span>)}
				</small>
			</summary>
			<div className="pa-info-details-body">
				<section className="space-y-2" data-testid="agent-subagent-model">
					<div className="flex items-center gap-1 font-semibold">子代理模型<Help>不选 = 跟随主会话当前模型。勾选后，派活时在这个候选池内按任务能力挑一个；某个模型不可用（限流 / 服务不可用 / 模型不存在 / 鉴权失败等）时，只在池内自动换下一个，用尽就停下，不会用池外模型，也不会无限重试。最多同时跑几个由下面的「任务上限」按助理决定（未覆盖则用整个安装的默认值）。</Help></div>
					{poolPhase === "error" ? (
						<div className="flex flex-wrap items-center gap-2 text-xs text-red-500" data-testid="agent-subagent-pool-error">
							<span className="min-w-0 [overflow-wrap:anywhere]">候选池读取失败：{poolErr}</span>
							<Button size="sm" variant="outline" onClick={loadPool} data-testid="agent-subagent-pool-retry">重试</Button>
						</div>
					) : poolPhase === "loading" ? (
						<div className="text-xs text-mut" role="status" data-testid="agent-subagent-pool-loading">正在读取候选池…</div>
					) : (
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
					)}
					{live.length > 0 && <div className="flex flex-wrap gap-1">{live.map((m) => <span key={key(m)} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-mut">{nameOf(m)}</span>)}</div>}
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm text-mut">思考强度</span>
						{thinkingPhase === "loading" ? (
							<span className="text-xs text-mut" role="status" data-testid="agent-subagent-thinking-loading-state">正在读取…</span>
						) : thinkingPhase === "error" ? (
							<span className="flex flex-wrap items-center gap-2 text-xs text-red-500" data-testid="agent-subagent-thinking-load-error">
								<span className="min-w-0 [overflow-wrap:anywhere]">读取失败：{thinkingErr}</span>
								<Button size="sm" variant="outline" onClick={loadThinking}>重试</Button>
							</span>
						) : thinking ? (
							<ThinkingButton testid="agent-subagent-thinking" levels={levels} current={thinking.mode === "fixed" ? thinking.level : null} effective={thinking.mode === "fixed" ? fitThinkingLevel(levels, thinking.level) : (agent?.thinking ?? null)} followLabel="跟随主会话" title={unsupportedFixed} onPick={(v) => void saveThinking(v)} loading={d.loading} error={d.error} onRetry={d.reload} />
						) : null}
					</div>
					{unsupportedFixed && <p className="text-xs text-amber-600" data-testid="agent-subagent-thinking-note">{unsupportedFixed}</p>}
					<AgentSubagentLimits state={limits} />
					{(poolSaveErr || thinkingSaveErr) && <div className="space-y-1 text-xs text-red-500 [overflow-wrap:anywhere]" role="alert" data-testid="agent-subagent-save-error">
						{poolSaveErr && <p data-testid="agent-subagent-pool-save-error">{poolSaveErr}</p>}
						{thinkingSaveErr && <p data-testid="agent-subagent-thinking-save-error">{thinkingSaveErr}</p>}
					</div>}
				</section>
			</div>
		</details>
	);
}

/**
 * 子代理的任务上限（并发 / 最长运行）：按助理设置，未覆盖 = 继承整个安装的默认值。
 * 旧版把这两个值当全局放在「模型」页，容易误读成每助理；改为这里显式覆盖，后端 defaults 兼容旧全局只读值。
 */
/** 子代理任务上限的数据与写入（同一个助理一份状态；摘要与展开区共用，不复制第二套）。 */
function useSubagentLimits(agentId: string) {
	const [d, setD] = useState<SubagentSettingsResponse | null>(null);
	const [draft, setDraft] = useState<{ maxConcurrent: string; maxMinutes: string } | null>(null);
	const [err, setErr] = useState("");
	const [phase, setPhase] = useState<LoadPhase>("loading");
	const [saving, setSaving] = useState(false);
	const pending = useRef(false);
	// 读取 / 写回代次：切助理或卸载后，迟到的响应不落到新助理的界面上
	const gen = useRef(0);
	const sync = (r: SubagentSettingsResponse) => {
		setD(r);
		setDraft({ maxConcurrent: String(r.settings.maxConcurrent), maxMinutes: String(r.settings.maxMinutes) });
	};
	const load = useCallback(() => {
		const g = ++gen.current;
		setPhase("loading");
		setErr("");
		void getAgentSubagentSettings(agentId)
			.then((r) => {
				if (g !== gen.current) return;
				sync(r);
				setPhase("ready");
			})
			.catch((e) => {
				if (g !== gen.current) return;
				setErr(errText(e));
				setPhase("error");
			});
	}, [agentId]);
	useEffect(() => {
		setD(null);
		setDraft(null);
		setErr("");
		setPhase("loading");
		pending.current = false;
		setSaving(false);
		load();
		return () => {
			gen.current++;
		};
	}, [load]);
	const save = async (patch: { maxConcurrent?: number | null; maxMinutes?: number | null }) => {
		if (pending.current || phase !== "ready") return;
		const g = ++gen.current;
		pending.current = true;
		setSaving(true);
		try {
			const r = await setAgentSubagentSettings(agentId, patch);
			if (g !== gen.current) return;
			sync(r);
			setErr("");
			setPhase("ready");
		} catch (e) {
			if (g !== gen.current) return;
			// 保存失败：重新拉取生效值回滚，不留下假值。
			setErr(errText(e));
			try {
				const r = await getAgentSubagentSettings(agentId);
				if (g !== gen.current) return;
				sync(r);
				setPhase("ready");
			} catch {
				if (g === gen.current && d) sync(d);
			}
		} finally {
			if (g === gen.current) {
				pending.current = false;
				setSaving(false);
			}
		}
	};
	// 失焦提交：清空 = 继承默认；非法值恢复成生效值，不静默写 0。
	const commit = (key: "maxConcurrent" | "maxMinutes", raw: string) => {
		if (!d) return;
		const trimmed = raw.trim();
		if (trimmed === "") {
			void save({ [key]: null });
			return;
		}
		const n = key === "maxConcurrent" ? Math.round(Number(trimmed)) : Number(trimmed);
		const ok = Number.isFinite(n) && n >= 1 && (key === "maxConcurrent" ? n <= 100 : true);
		if (!ok) {
			setDraft((x) => (x ? { ...x, [key]: String(d.settings[key]) } : x));
			return;
		}
		if (n !== d.settings[key]) void save({ [key]: n });
		else setDraft((x) => (x ? { ...x, [key]: String(n) } : x));
	};
	return { d, draft, setDraft, err, phase, saving, save, commit, retry: load };
}

function AgentSubagentLimits({ state }: { state: ReturnType<typeof useSubagentLimits> }) {
	const { d, draft, setDraft, err, phase, saving, save, commit, retry } = state;
	if (!d || !draft || phase !== "ready")
		return (
			<section data-testid="agent-subagent-limits" className="space-y-2">
				{phase === "loading" ? (
					<div className="text-xs text-mut" role="status" data-testid="agent-subagent-limits-loading">正在读取任务上限…</div>
				) : err ? (
					<div className="flex flex-wrap items-center gap-2 text-xs text-red-500" data-testid="agent-subagent-limits-error">
						<span className="min-w-0 [overflow-wrap:anywhere]">任务上限读取失败：{err}</span>
						<Button size="sm" variant="outline" onClick={retry} data-testid="agent-subagent-limits-retry">重试</Button>
					</div>
				) : null}
			</section>
		);
	const inherit = (k: "maxConcurrent" | "maxMinutes") => d.overrides[k] === undefined;
	const inheritHint = (k: "maxConcurrent" | "maxMinutes") => (inherit(k) ? <span className="text-[11px] text-mut2">默认 {d.defaults[k]}</span> : <button type="button" className="text-[11px] text-accent underline" disabled={saving} onClick={() => void save({ [k]: null })} data-testid={`agent-subagent-inherit-${k}`}>继承默认</button>);
	return (
		<section data-testid="agent-subagent-limits" className="space-y-2">
			<div className="flex items-center gap-1 text-sm font-semibold">
				任务上限{saving && <span className="text-xs font-normal text-mut" role="status">保存中…</span>}
				<Help>只对这个助理生效；留空或点「继承默认」就用整个安装的默认值（默认并发 {d.defaults.maxConcurrent}、最长 {d.defaults.maxMinutes} 分钟）。并发指这个助理同时运行的子代理最多几个，满了自动排队。运行中的任务在聊天顶部的「子代理」里看。</Help>
			</div>
			<label className="flex flex-wrap items-center gap-2 text-sm text-mut">
				最多同时
				<input className="pa-input !w-24" type="number" min={1} max={100} disabled={saving} value={draft.maxConcurrent} aria-label="子代理并发上限" onChange={(e) => setDraft({ ...draft, maxConcurrent: e.target.value })} onBlur={(e) => commit("maxConcurrent", e.target.value)} />
				个子代理{inheritHint("maxConcurrent")}
			</label>
			<label className="flex flex-wrap items-center gap-2 text-sm text-mut">
				最长
				<input className="pa-input !w-24" type="number" min={1} disabled={saving} value={draft.maxMinutes} aria-label="子代理最长运行分钟" onChange={(e) => setDraft({ ...draft, maxMinutes: e.target.value })} onBlur={(e) => commit("maxMinutes", e.target.value)} />
				分钟{inheritHint("maxMinutes")}
			</label>
			{err && <p className="text-xs text-red-500 [overflow-wrap:anywhere]" data-testid="agent-subagent-limits-error">{err}</p>}
		</section>
	);
}
