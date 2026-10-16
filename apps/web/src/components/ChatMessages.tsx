import { AlarmClock, Brain, Puzzle, Check, ChevronRight, Globe, Hand, Loader2, Monitor, Terminal, X, FileText, FolderSearch, PenLine, Send, Sparkles, Eye } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import type { Agent, Message } from "../types";
import Attachments from "./Attachments";
import { ApprovalCard, QuestionCard, TaskCard } from "./Cards";
import Markdown from "./Markdown";
import { splitThinking } from "../thinking";
import { fmtMoney, fmtTok, type MsgUsage, useFx } from "./usage-fmt";
import { Avatar, cx } from "./ui";
import { ProposalCard } from "./RoomCards";
import { MessageActions, QuotedMessage, type MessageInteraction } from "./MessageReply";
import { quotedBlock } from "../replies";

// ------------------------------------------------------------------ 工具 → 文案
const TOOL_LABEL: Record<string, string> = {
	bash: "运行命令", read: "读取文件", write: "写入文件", edit: "修改文件", ls: "查看目录", find: "查找文件", grep: "搜索内容",
	deliver_file: "发送文件", ask_user: "询问你", spawn_task: "创建后台任务", spawn_subagent: "派子代理", subagent_message: "补充子代理要求", subagent_stop: "停止子代理", computer_screenshot: "查看屏幕", request_handoff: "请你接手",
	web_fetch: "打开网页", web_search: "搜索网页", browser: "操作浏览器",
};
/** 进行中的活动文案（来自 Pi tool_execution 事件 → 工具步骤消息） */
export function activityOf(name: string | undefined, args: Record<string, any> = {}): { text: string; icon: ReactNode; detail?: string } {
	const n = name ?? "";
	const url = args.url ?? args.href;
	if (url || /web|browser|fetch|navigate|open_url/i.test(n)) return { text: "正在打开网页…", icon: <Globe className="pa-ic" />, detail: url ? String(url).replace(/^https?:\/\//, "").slice(0, 48) : undefined };
	if (n === "read") return { text: "正在读取文件…", icon: <FileText className="pa-ic" />, detail: args.path };
	if (n === "write" || n === "edit") return { text: n === "write" ? "正在写入文件…" : "正在修改文件…", icon: <PenLine className="pa-ic" />, detail: args.path };
	if (n === "ls" || n === "find" || n === "grep") return { text: "正在查找文件…", icon: <FolderSearch className="pa-ic" />, detail: args.pattern ?? args.path };
	if (n === "bash") return { text: "正在运行命令…", icon: <Terminal className="pa-ic" />, detail: String(args.command ?? "").slice(0, 48) };
	if (n === "deliver_file") return { text: "正在整理文件发给你…", icon: <Send className="pa-ic" />, detail: args.path };
	if (n === "spawn_task") return { text: "正在安排后台任务…", icon: <Sparkles className="pa-ic" />, detail: args.title };
	if (n === "ask_user") return { text: "等你回复…", icon: <Hand className="pa-ic" /> };
	if (n === "memory_remember") return { text: "正在记下来…", icon: <Brain className="pa-ic" />, detail: String(args.content ?? "").slice(0, 48) };
	if (n === "memory_recall" || n === "memory_reflect") return { text: "正在回忆…", icon: <Brain className="pa-ic" />, detail: args.query };
	if (n === "memory_forget") return { text: "正在忘掉一条记忆…", icon: <Brain className="pa-ic" /> };
	if (n.startsWith("routine_")) return { text: "正在设置定时任务…", icon: <AlarmClock className="pa-ic" />, detail: args.name };
	if (n.startsWith("skill_")) return { text: "正在整理技能…", icon: <Puzzle className="pa-ic" />, detail: args.name };
	if (n === "computer_screenshot") return { text: "正在查看屏幕…", icon: <Eye className="pa-ic" /> };
	if (n === "request_handoff") return { text: "等你接手…", icon: <Hand className="pa-ic" /> };
	if (n.startsWith("mcp") || n.includes("cua")) return { text: "正在操作电脑…", icon: <Monitor className="pa-ic" /> };
	if (!n) return { text: "正在思考…", icon: <Sparkles className="pa-ic" /> };
	return { text: `正在${TOOL_LABEL[n] ?? "处理"}…`, icon: <Sparkles className="pa-ic" /> };
}
const brief = (args: Record<string, any> = {}) => String(args.command ?? args.path ?? args.url ?? args.title ?? args.question ?? args.pattern ?? "").slice(0, 80);
const secs = (ms: number) => (ms < 1000 ? "<1 秒" : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`);

// ------------------------------------------------------------------ 消息分组
export type Part = { kind: "msg"; m: Message } | { kind: "steps"; items: Message[] };
export type Row = { kind: "user"; m: Message } | { kind: "system"; m: Message } | { kind: "bot"; id: string; parts: Part[] } | { kind: "day"; label: string; id: string };

function dayLabel(ts: number) {
	const d = new Date(ts);
	const today = new Date();
	const y = new Date(today);
	y.setDate(today.getDate() - 1);
	const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === today.toDateString()) return `今天 ${hm}`;
	if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
	return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

export function group(list: Message[]): Row[] {
	const rows: Row[] = [];
	let lastTs = 0;
	for (const m of list) {
		if (m.created_at - lastTs > 30 * 60_000) rows.push({ kind: "day", label: dayLabel(m.created_at), id: `d${m.id}` });
		lastTs = m.created_at;
		if (m.role === "user" || m.role === "system") {
			rows.push({ kind: m.role, m } as Row);
			continue;
		}
		let bot = rows[rows.length - 1];
		if (bot?.kind !== "bot") rows.push((bot = { kind: "bot", id: m.id, parts: [] }));
		const parts = bot.parts;
		if (m.role === "tool") {
			const last = parts[parts.length - 1];
			if (last?.kind === "steps") last.items.push(m);
			else parts.push({ kind: "steps", items: [m] });
		} else parts.push({ kind: "msg", m });
	}
	return rows;
}

// ------------------------------------------------------------------ 步骤列表：进行中默认展开（用户可随时收起），完成后自动收起
function Steps({ items, live, busy }: { items: Message[]; live: boolean; busy?: boolean }) {
	const [open, setOpen] = useState(live);
	const [detail, setDetail] = useState<string | null>(null);
	// 记录用户是否手动开合过：手动收起运行中的步骤后，后续流式更新不能把它重新弹开；
	// 用户手动展开后，完成时的自动收起也不再覆盖他的选择。
	const userToggled = useRef(false);
	const wasLive = useRef(live);
	useEffect(() => {
		if (live && !wasLive.current && !userToggled.current) setOpen(true); // 新变成进行中：自动展开
		else if (!live && wasLive.current && !userToggled.current) setOpen(false); // 完成后自动收起
		wasLive.current = live;
	}, [live]);
	const toggle = () => {
		userToggled.current = true;
		setOpen((v) => !v);
	};
	const errors = items.filter((m) => m.status === "error").length;
	const failed = items.filter((m) => m.status === "error").slice(-1)[0];
	const took = Math.max(0, (items[items.length - 1].updated_at ?? 0) - items[0].created_at);
	// 单个步骤失败 ≠ 整个任务停：汇总里写清成功/失败个数，并把失败的那一步点名
	const head = live ? `正在进行 · 第 ${items.length} 步` : errors ? `${items.length} 个步骤 · ${items.length - errors} 成功 · ${errors} 失败` : `${items.length} 个步骤 · 全部成功`;
	return (
		<div className={cx("pa-steps", open && "open")} data-testid="steps">
			<button className="pa-steps-head" onClick={toggle} aria-expanded={open}>
				{live ? <span className="pa-spinner" /> : errors ? <X className="pa-ic text-red-500" /> : <Check className="pa-ic ok" />}
				<span>{head}</span>
				{!live && failed && <small className="text-red-500" data-testid="steps-failed">· {TOOL_LABEL[failed.meta.toolName as string] ?? String(failed.meta.toolName ?? "")}失败{busy ? "（这一步失败，任务继续）" : ""}</small>}
				{!live && <small>用时 {secs(took)}</small>}
				<ChevronRight className="pa-ic pa-chev" />
			</button>
			{/* 折叠动画靠 grid 0fr↔1fr（外层单一子元素），展开时显示完整内容、不再用固定 max-height 截断 */}
			<div className="pa-steps-list" data-testid="steps-list">
				<ol>
				{items.map((m) => {
					const name = m.meta.toolName as string;
					const running = m.status === "running";
					return (
						<li key={m.id} className="flex-wrap" onClick={() => setDetail(detail === m.id ? null : m.id)} style={{ cursor: "pointer" }}>
							<i className={cx("pa-st-dot", m.status === "error" && "err")}>{running ? <Loader2 className="pa-ic animate-spin" /> : m.status === "error" ? <X className="pa-ic" /> : <Check className="pa-ic" />}</i>
							<span className="pa-step-txt">{TOOL_LABEL[name] ?? name}</span>
							<code>{brief(m.meta.args)}</code>
							<small>{running ? "…" : secs(Math.max(0, m.updated_at - m.created_at))}</small>
							{detail === m.id && (
								<pre className="pa-pre w-full" onClick={(e) => e.stopPropagation()}>
									{JSON.stringify(m.meta.args ?? {}, null, 2)}
									{m.meta.result ? `\n\n—— 结果 ——\n${m.meta.result}` : ""}
								</pre>
							)}
						</li>
					);
				})}
				</ol>
			</div>
		</div>
	);
}

export function Activity({ tool }: { tool?: Message }) {
	const a = activityOf(tool?.meta.toolName, tool?.meta.args);
	return (
		<div className="pa-activity" data-testid="activity">
			<span className="pa-spinner" />
			{a.icon}
			<span className="pa-act-txt">
				<span className="pa-shimmer">{a.text}</span>
			</span>
			{a.detail && <span className="pa-act-url truncate">{a.detail}</span>}
		</div>
	);
}

/** 可折叠的「思考」：默认收起；思考中显示动态提示 */
export function Thinking({ text, live }: { text: string; live: boolean }) {
	return (
		<details className="pa-thinking" data-testid="thinking">
			<summary>
				<Brain className="pa-ic" />
				<span className={live ? "pa-shimmer" : undefined}>{live ? "思考中…" : "思考"}</span>
			</summary>
			<div className="pa-thinking-body">{text}</div>
		</details>
	);
}

export function BotPart({ p, live, busy, renderSubagent, onQuote, onJump, interaction }: { p: Part; live: boolean; busy?: boolean; renderSubagent?: (m: Message) => ReactNode; onQuote?: (m: Message) => void; onJump?: (id: string) => void; interaction?: (m: Message) => MessageInteraction }) {
	if (p.kind === "steps") return <Steps items={p.items} live={live} busy={busy} />;
	const m = p.m;
	if (m.role === "card")
		return m.meta.kind === "subagent" ? renderSubagent?.(m) ?? null : m.meta.kind === "approval" ? <ApprovalCard m={m} /> : m.meta.kind === "question" ? <QuestionCard m={m} /> : m.meta.kind === "room-proposal" || m.meta.kind === "member-proposal" ? <ProposalCard m={m} /> : <TaskCard m={m} />;
	// 思考：原生 reasoning（meta.thinking）+ 正文里的 <think>…</think>（旧消息 / 流式中），折叠显示，不当正文
	const split = splitThinking(m.content);
	const thinking = [String(m.meta.thinking ?? "").trim(), split.thinking].filter(Boolean).join("\n\n");
	const body = split.text;
	const quoted = onJump ? quotedBlock(m) : null;
	return (
		<>
			{thinking && <Thinking text={thinking} live={m.status === "streaming" && !body} />}
			<div className="pa-bot-msg" data-mid={m.id} {...(interaction ? interaction(m) : undefined)}>
				{quoted && <QuotedMessage block={quoted} onJump={onJump!} />}
				{(body || (m.status === "streaming" && !thinking)) && (
					<div className={cx("pa-bubble prose-wrap", m.status === "error" && "error")}>
						{body ? <Markdown text={body} /> : null}
						{m.status === "streaming" && <span className="caret text-sm" />}
						{m.status === "error" && <div className="mt-1 text-xs text-red-500">{String(m.meta.error ?? "出错了")}</div>}
						{m.status === "interrupted" && <div className="mt-1 text-xs text-mut2">（已中断）</div>}
					</div>
				)}
				<MessageActions m={m} onQuote={onQuote} side="left" />
			</div>
			{m.meta.attachments?.length ? <Attachments items={m.meta.attachments} /> : null}
			{m.meta.usage && m.status === "done" ? <UsageLine u={m.meta.usage as MsgUsage} model={String(m.meta.model ?? "")} /> : null}
		</>
	);
}

/** 每条回复的用量：桌面上悬停显示，手机上常驻（很淡） */
function UsageLine({ u, model }: { u: MsgUsage; model: string }) {
	const fx = useFx();
	const inTok = u.input + u.cacheRead + u.cacheWrite;
	const detail = `${model}\n输入 ${fmtTok(u.input)} · 读缓存 ${fmtTok(u.cacheRead)} · 写缓存 ${fmtTok(u.cacheWrite)}\n输出 ${fmtTok(u.output)}${u.reasoning ? `（推理 ${fmtTok(u.reasoning)}）` : ""}\n费用 ${fmtMoney(u.cost, fx)}${u.saved ? ` · 缓存省下 ${fmtMoney(u.saved, fx)}` : ""}`;
	return (
		<div className="pa-usage" title={detail} data-testid="msg-usage">
			{fmtTok(inTok)} → {fmtTok(u.output)} token{inTok ? ` · 命中 ${Math.round((u.cacheRead / inTok) * 100)}%` : ""} · {fmtMoney(u.cost, fx)}
		</div>
	);
}

export function BotTurn({ row, agent, live, renderSubagent, onQuote, onJump, interaction }: { row: Extract<Row, { kind: "bot" }> | null; agent: Pick<Agent, "id" | "avatar" | "color">; live: boolean; renderSubagent?: (m: Message) => ReactNode; onQuote?: (m: Message) => void; onJump?: (id: string) => void; interaction?: (m: Message) => MessageInteraction }) {
	const all = row?.parts ?? [];
	// 子代理指令卡不再显示（任务走 header 的「子代理」入口）；整轮只有它时这一轮也不占位
	const parts = renderSubagent ? all : all.filter((p) => !(p.kind === "msg" && p.m.role === "card" && p.m.meta.kind === "subagent"));
	const last = parts[parts.length - 1];
	const runningTool = parts.flatMap((p) => (p.kind === "steps" ? p.items : [])).find((m) => m.status === "running");
	const streaming = last?.kind === "msg" && last.m.status === "streaming";
	const waitingCard = last?.kind === "msg" && last.m.role === "card" && last.m.meta.status === "pending";
	if (!parts.length && !live) return null;
	return (
		<div className="pa-msg bot">
			<div className="pa-av-col">
				<Avatar agentId={agent.id} text={agent.avatar} color={agent.color} size={26} />
			</div>
			<div className="pa-bot-body">
				{parts.map((p, i) => (
					<BotPart renderSubagent={renderSubagent} onQuote={onQuote} onJump={onJump} interaction={interaction} busy={live} key={p.kind === "msg" ? p.m.id : p.items[0].id} p={p} live={live && i === parts.length - 1 && p.kind === "steps"} />
				))}
				{live && !streaming && !waitingCard && <Activity tool={runningTool} />}
			</div>
		</div>
	);
}

export function UserMsg({ m, reaction, onQuote, onFork, onJump, interaction }: { m: Message; reaction?: "eyes" | "done"; onQuote?: (m: Message) => void; onFork?: (m: Message) => void; onJump?: (id: string) => void; interaction?: MessageInteraction }) {
	const quoted = onJump ? quotedBlock(m) : null;
	return (
		<div className="pa-msg user" data-mid={m.id} {...interaction}>
			{quoted && <QuotedMessage block={quoted} onJump={onJump!} mine />}
			{m.content && (
				<div className="pa-bubble relative">
					{m.content}
					{reaction && <span className={cx("pa-reaction", reaction === "done" && "done")} title={reaction === "done" ? "已完成" : "收到，正在处理"}>{reaction === "done" ? "✓" : "👀"}</span>}
				</div>
			)}
			{m.meta.attachments?.length ? <Attachments items={m.meta.attachments} mine /> : null}
			<Delivery state={m.meta.delivery} />
			<MessageActions m={m} onQuote={onQuote} onFork={onFork} side="right" />
		</div>
	);
}

/** 工作途中发的消息：显示它有没有送进正在进行的任务 */
const DELIVERY: Record<string, [string, string]> = {
	queued: ["等当前这一步做完送达…", "助理正在工作，这条会在它当前这一步做完后立刻送到，不用等整个任务结束"],
	delivered: ["已送达正在进行的任务", "助理已经读到这条，会决定是补充进去、换方向还是停下"],
	stop: ["已停止", "这条是停止指令：正在进行的任务、命令和电脑操作都已停下"],
	stopped: ["任务已停止，未送达", "送达前任务就停了，助理没看到这条；需要的话再发一次"],
};
function Delivery({ state }: { state?: string }) {
	const d = state ? DELIVERY[state] : undefined;
	if (!d) return null;
	return (
		<div className="pa-delivery" title={t(d[1])} data-testid="delivery" data-state={state}>
			{state === "queued" ? <Loader2 className="pa-ic animate-spin" /> : <Check className="pa-ic" />}
			{t(d[0])}
		</div>
	);
}

export function SystemMsg({ m, canContinue = true }: { m: Message; canContinue?: boolean }) {
	return (
		<div className="flex justify-center py-1">
			<div className={cx("max-w-md px-3 py-1 text-center text-xs", m.meta.kind === "compaction" ? "rounded-xl" : "rounded-full", m.status === "error" ? "bg-red-500/10 text-red-600" : "bg-hover text-mut")}>
				{m.content}
				{m.meta.kind === "compaction" && m.meta.summary && (
					<details className="mt-1 text-left">
						<summary className="cursor-pointer text-accent">查看摘要</summary>
						<div className="mt-1 whitespace-pre-wrap rounded-lg bg-card p-2 text-[11px] leading-relaxed">{m.meta.summary}</div>
					</details>
				)}
				{m.meta.action === "room-continue" && m.room_id && canContinue && (
					<button className="ml-2 font-medium text-accent" data-testid="room-continue" onClick={() => api(`/api/rooms/${m.room_id}/continue`, { method: "POST" })}>
						继续
					</button>
				)}
				{m.meta.action === "room-settings" && m.room_id && (
					<button className="ml-2 font-medium text-accent" onClick={() => window.dispatchEvent(new CustomEvent("pia:room-settings", { detail: m.room_id }))}>
						群设置
					</button>
				)}
				{m.meta.action === "open-models" && (
					<button className="ml-2 font-medium text-accent" onClick={() => useStore.getState().set({ settings: "models" })}>
						去配置
					</button>
				)}
			</div>
		</div>
	);
}

