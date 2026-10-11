import { ArrowUp, Check, ChevronRight, Globe, Hand, Loader2, Menu, Monitor, PanelRight, Paperclip, Square, Terminal, X, FileText, FolderSearch, PenLine, Send, Sparkles, Eye } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, upload } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import type { Agent, Attachment, Message } from "../types";
import Attachments from "./Attachments";
import { ApprovalCard, QuestionCard, TaskCard } from "./Cards";
import Markdown from "./Markdown";
import { Avatar, cx, fmtSize } from "./ui";

// ------------------------------------------------------------------ 工具 → 文案
const TOOL_LABEL: Record<string, string> = {
	bash: "运行命令", read: "读取文件", write: "写入文件", edit: "修改文件", ls: "查看目录", find: "查找文件", grep: "搜索内容",
	deliver_file: "发送文件", ask_user: "询问你", spawn_task: "创建后台任务", computer_screenshot: "查看屏幕", request_handoff: "请你接手",
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
	if (n === "computer_screenshot") return { text: "正在查看屏幕…", icon: <Eye className="pa-ic" /> };
	if (n === "request_handoff") return { text: "等你接手…", icon: <Hand className="pa-ic" /> };
	if (n.startsWith("mcp") || n.includes("cua")) return { text: "正在操作电脑…", icon: <Monitor className="pa-ic" /> };
	if (!n) return { text: "正在思考…", icon: <Sparkles className="pa-ic" /> };
	return { text: `正在${TOOL_LABEL[n] ?? "处理"}…`, icon: <Sparkles className="pa-ic" /> };
}
const brief = (args: Record<string, any> = {}) => String(args.command ?? args.path ?? args.url ?? args.title ?? args.question ?? args.pattern ?? "").slice(0, 80);
const secs = (ms: number) => (ms < 1000 ? "<1 秒" : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`);

// ------------------------------------------------------------------ 消息分组
type Part = { kind: "msg"; m: Message } | { kind: "steps"; items: Message[] };
type Row = { kind: "user"; m: Message } | { kind: "system"; m: Message } | { kind: "bot"; id: string; parts: Part[] } | { kind: "day"; label: string; id: string };

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

function group(list: Message[]): Row[] {
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

// ------------------------------------------------------------------ 步骤列表：进行中展开，完成后自动收起
function Steps({ items, live }: { items: Message[]; live: boolean }) {
	const [open, setOpen] = useState(live);
	const [detail, setDetail] = useState<string | null>(null);
	const wasLive = useRef(live);
	useEffect(() => {
		if (live) setOpen(true);
		else if (wasLive.current) setOpen(false); // 完成后自动收起
		wasLive.current = live;
	}, [live]);
	const errors = items.filter((m) => m.status === "error").length;
	const took = Math.max(0, (items[items.length - 1].updated_at ?? 0) - items[0].created_at);
	return (
		<div className={cx("pa-steps", open && "open")} data-testid="steps">
			<button className="pa-steps-head" onClick={() => setOpen(!open)}>
				{live ? <span className="pa-spinner" /> : errors ? <X className="pa-ic text-red-500" /> : <Check className="pa-ic ok" />}
				<span>{live ? `正在进行 · 第 ${items.length} 步` : `已完成 ${items.length} 个步骤`}</span>
				{!live && <small>用时 {secs(took)}</small>}
				<ChevronRight className="pa-ic pa-chev" />
			</button>
			<ol className="pa-steps-list">
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
	);
}

function Activity({ tool }: { tool?: Message }) {
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

function BotPart({ p, live }: { p: Part; live: boolean }) {
	if (p.kind === "steps") return <Steps items={p.items} live={live} />;
	const m = p.m;
	if (m.role === "card") return m.meta.kind === "approval" ? <ApprovalCard m={m} /> : m.meta.kind === "question" ? <QuestionCard m={m} /> : <TaskCard m={m} />;
	return (
		<>
			{(m.content || m.status === "streaming") && (
				<div className={cx("pa-bubble prose-wrap", m.status === "error" && "error")}>
					{m.content ? <Markdown text={m.content} /> : null}
					{m.status === "streaming" && <span className="caret text-sm" />}
					{m.status === "error" && <div className="mt-1 text-xs text-red-500">{String(m.meta.error ?? "出错了")}</div>}
					{m.status === "interrupted" && <div className="mt-1 text-xs text-mut2">（已中断）</div>}
				</div>
			)}
			{m.meta.attachments?.length ? <Attachments items={m.meta.attachments} /> : null}
		</>
	);
}

function BotTurn({ row, agent, live }: { row: Extract<Row, { kind: "bot" }> | null; agent: Agent; live: boolean }) {
	const parts = row?.parts ?? [];
	const last = parts[parts.length - 1];
	const runningTool = parts.flatMap((p) => (p.kind === "steps" ? p.items : [])).find((m) => m.status === "running");
	const streaming = last?.kind === "msg" && last.m.status === "streaming";
	const waitingCard = last?.kind === "msg" && last.m.role === "card" && last.m.meta.status === "pending";
	return (
		<div className="pa-msg bot">
			<Avatar agentId={agent.id} text={agent.avatar} color={agent.color} size={26} />
			<div className="pa-bot-body">
				{parts.map((p, i) => (
					<BotPart key={p.kind === "msg" ? p.m.id : p.items[0].id} p={p} live={live && i === parts.length - 1 && p.kind === "steps"} />
				))}
				{live && !streaming && !waitingCard && <Activity tool={runningTool} />}
			</div>
		</div>
	);
}

function UserMsg({ m, reaction }: { m: Message; reaction?: "eyes" | "done" }) {
	return (
		<div className="pa-msg user">
			{m.content && (
				<div className="pa-bubble relative">
					{m.content}
					{reaction && <span className={cx("pa-reaction", reaction === "done" && "done")} title={reaction === "done" ? "已完成" : "收到，正在处理"}>{reaction === "done" ? "✓" : "👀"}</span>}
				</div>
			)}
			{m.meta.attachments?.length ? <Attachments items={m.meta.attachments} mine /> : null}
		</div>
	);
}

function SystemMsg({ m }: { m: Message }) {
	return (
		<div className="flex justify-center py-1">
			<div className={cx("max-w-md rounded-full px-3 py-1 text-center text-xs", m.status === "error" ? "bg-red-500/10 text-red-600" : "bg-hover text-mut")}>
				{m.content}
				{m.meta.action === "open-models" && (
					<button className="ml-2 font-medium text-accent" onClick={() => useStore.getState().set({ settings: "models" })}>
						去配置
					</button>
				)}
			</div>
		</div>
	);
}

// ------------------------------------------------------------------ 主体
export default function Chat({ agentId }: { agentId: string }) {
	const { agents, messages, set, info } = useStore();
	const agent = agents.find((a) => a.id === agentId);
	const list = messages[agentId] ?? [];
	const mainList = list;
	const rows = useMemo(() => group(mainList), [mainList]);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [drag, setDrag] = useState(false);
	const composer = useRef<{ addFiles: (f: FileList | File[]) => void }>(null);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});
	useEffect(() => {
		stick.current = true;
	}, [agentId]);
	if (!agent) return null;
	const running = agent.status === "running";
	// 反应：最后一条用户消息在处理中 👀；小任务（≤3 步且无错误）完成后 ✓
	const reactions = new Map<string, "eyes" | "done">();
	rows.forEach((r, i) => {
		if (r.kind !== "user") return;
		const next = rows.slice(i + 1).find((x) => x.kind === "user");
		const isLastUser = !next;
		if (isLastUser && running) return void reactions.set(r.m.id, "eyes");
		const bot = rows.slice(i + 1, next ? rows.indexOf(next) : undefined).find((x) => x.kind === "bot") as Extract<Row, { kind: "bot" }> | undefined;
		if (!bot) return;
		const steps = bot.parts.flatMap((p) => (p.kind === "steps" ? p.items : []));
		const failed = bot.parts.some((p) => p.kind === "msg" && p.m.status === "error") || steps.some((s) => s.status === "error");
		if (!failed && steps.length > 0 && steps.length <= 3) reactions.set(r.m.id, "done");
	});
	const lastRow = rows[rows.length - 1];
	const pendingTurn = running && lastRow?.kind !== "bot"; // 刚发出、还没有任何输出：先显示“正在思考…”
	return (
		<div
			className="relative flex h-full min-h-0 flex-col"
			onDragOver={(e) => {
				if (e.dataTransfer.types.includes("Files")) (e.preventDefault(), setDrag(true));
			}}
			onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
			onDrop={(e) => {
				e.preventDefault();
				setDrag(false);
				if (e.dataTransfer.files.length) composer.current?.addFiles(e.dataTransfer.files);
			}}
		>
			<header className="pa-chat-head safe-top">
				<button className="pa-icon-btn ghost lg:hidden" onClick={() => set({ drawer: true })} aria-label="打开助理列表">
					<Menu className="pa-ic" />
				</button>
				<Avatar agentId={agent.id} text={agent.avatar} color={agent.color} size={30} running={running} />
				<div className="pa-head-txt min-w-0">
					<b className="truncate">{agent.name}</b>
					<small className="truncate">
						{running && <i className="pa-pulse" />}
						{running ? `${t("正在工作")} · ` : ""}
						{agent.model ? agent.model.id : "未配置模型"}
					</small>
				</div>
				<div className="pa-head-actions">
					<button className="pa-chip max-sm:!hidden" onClick={() => set({ info: true, infoTab: "computer" })}>
						<Monitor className="pa-ic" />
						<span>电脑</span>
					</button>
					<button className={cx("pa-icon-btn ghost", info && "!bg-hover")} onClick={() => set({ info: !info })} aria-label="信息面板">
						<PanelRight className="pa-ic" />
					</button>
				</div>
			</header>
			<div
				ref={scroller}
				className="pa-scroll scrollbar-thin"
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
				}}
			>
				<div className="pa-thread-body">
					{rows.map((r) =>
						r.kind === "day" ? (
							<div key={r.id} className="pa-day">
								{r.label}
							</div>
						) : r.kind === "user" ? (
							<UserMsg key={r.m.id} m={r.m} reaction={reactions.get(r.m.id)} />
						) : r.kind === "system" ? (
							<SystemMsg key={r.m.id} m={r.m} />
						) : (
							<BotTurn key={r.id} row={r} agent={agent} live={running && r === lastRow} />
						),
					)}
					{pendingTurn && <BotTurn row={null} agent={agent} live />}
				</div>
			</div>
			<Composer ref={composer} agentId={agentId} name={agent.name} model={agent.model?.id} running={running} drag={drag} />
		</div>
	);
}

// ------------------------------------------------------------------ 悬浮输入框：拖拽文件 / 粘贴图片
function Composer({ agentId, name, model, running, drag, ref }: { agentId: string; name: string; model?: string; running: boolean; drag: boolean; ref: React.Ref<{ addFiles: (f: FileList | File[]) => void }> }) {
	const [text, setText] = useState("");
	const [files, setFiles] = useState<Attachment[]>([]);
	const [uploading, setUploading] = useState(0);
	const ta = useRef<HTMLTextAreaElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const isTouch = matchMedia("(pointer: coarse)").matches;
	useLayoutEffect(() => {
		const el = ta.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [text]);
	const send = async () => {
		if (!text.trim() && !files.length) return;
		const body = { text, attachments: files.map((f) => f.fileId) };
		setText("");
		setFiles([]);
		await api(`/api/agents/${agentId}/messages`, { method: "POST", json: body });
	};
	const addFiles = async (list: FileList | File[]) => {
		for (const f of Array.from(list)) {
			setUploading((n) => n + 1);
			try {
				const info = await upload(agentId, f);
				setFiles((x) => [...x, info]);
			} finally {
				setUploading((n) => n - 1);
			}
		}
	};
	if (ref && typeof ref === "object") (ref as React.RefObject<{ addFiles: typeof addFiles } | null>).current = { addFiles };
	return (
		<div className="pa-composer-wrap">
			<div className={cx("pa-composer", drag && "drag")}>
				{drag && <div className="pointer-events-none pb-2 text-center text-sm text-accent">松开即可把文件发给 {name}</div>}
				{(files.length > 0 || uploading > 0) && (
					<div className="flex flex-wrap gap-2 pb-2">
						{files.map((f) => (
							<span key={f.fileId} className="pa-chip sm !h-7">
								<Paperclip size={12} /> <span className="max-w-[160px] truncate">{f.name}</span> <span className="text-mut2">{fmtSize(f.size)}</span>
								<button onClick={() => setFiles((x) => x.filter((y) => y.fileId !== f.fileId))} aria-label="移除">
									<X size={12} />
								</button>
							</span>
						))}
						{uploading > 0 && (
							<span className="flex items-center gap-1 text-xs text-mut">
								<Loader2 size={12} className="animate-spin" /> 上传中…
							</span>
						)}
					</div>
				)}
				<textarea
					ref={ta}
					rows={1}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onPaste={(e) => {
						const imgs = Array.from(e.clipboardData.files);
						if (imgs.length) {
							e.preventDefault();
							void addFiles(imgs.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `粘贴的图片-${Date.now()}${i ? `-${i}` : ""}.${f.type.split("/")[1] || "png"}`, { type: f.type }))));
						}
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) {
							e.preventDefault();
							void send();
						}
					}}
					placeholder={t("给 {name} 发消息…", { name })}
				/>
				<div className="pa-composer-bar">
					<input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))} />
					<button className="pa-icon-btn ghost" onClick={() => fileInput.current?.click()} aria-label={t("上传")} title="添加文件（也可以拖进来或直接粘贴图片）">
						<Paperclip className="pa-ic" />
					</button>
					<button className="pa-chip sm" onClick={() => useStore.getState().set({ info: true, infoTab: "computer" })}>
						<Monitor className="pa-ic" />
						<span>助理电脑</span>
					</button>
					<span className="flex-1" />
					{model && <span className="pa-model max-sm:hidden">{model}</span>}
					{running && !text.trim() && !files.length ? (
						<button className="pa-send" onClick={() => api(`/api/agents/${agentId}/abort`, { method: "POST" })} aria-label={t("停止")} title={t("停止")}>
							<Square size={13} fill="currentColor" />
						</button>
					) : (
						<button className="pa-send" disabled={!text.trim() && !files.length} onClick={send} aria-label={t("发送")}>
							<ArrowUp className="pa-ic" />
						</button>
					)}
				</div>
			</div>
			<div className="pa-foot-note">发送、删除、付款等操作都会先请你批准</div>
		</div>
	);
}
