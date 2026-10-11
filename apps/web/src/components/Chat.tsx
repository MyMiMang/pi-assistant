import { ArrowUp, ChevronRight, Loader2, Menu, PanelRight, Paperclip, Square, Terminal, Wrench, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, upload } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import type { Attachment, Message } from "../types";
import Attachments from "./Attachments";
import { ApprovalCard, QuestionCard, TaskCard } from "./Cards";
import Markdown from "./Markdown";
import { Avatar, Button, cx, fmtSize } from "./ui";

const TOOL_LABEL: Record<string, string> = {
	bash: "运行命令", read: "读取文件", write: "写入文件", edit: "修改文件", ls: "查看目录", find: "查找文件", grep: "搜索内容",
	deliver_file: "发送文件", ask_user: "询问你", spawn_task: "创建后台任务",
};

function ToolStep({ m }: { m: Message }) {
	const [open, setOpen] = useState(false);
	const name = m.meta.toolName as string;
	const args = m.meta.args ?? {};
	const brief = args.command ?? args.path ?? args.title ?? args.question ?? "";
	return (
		<div className="max-w-full text-xs">
			<button onClick={() => setOpen(!open)} className="flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
				{m.status === "running" ? <Loader2 size={13} className="animate-spin text-accent" /> : name === "bash" ? <Terminal size={13} /> : <Wrench size={13} />}
				<span className={cx("shrink-0 font-medium whitespace-nowrap", m.status === "error" && "text-red-500")}>{TOOL_LABEL[name] ?? name}</span>
				<code className="truncate text-zinc-400">{String(brief).slice(0, 80)}</code>
				<ChevronRight size={13} className={cx("shrink-0 transition", open && "rotate-90")} />
			</button>
			{open && (
				<pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-zinc-900 p-3 text-[11px] whitespace-pre-wrap text-zinc-200">
					{JSON.stringify(args, null, 2)}
					{m.meta.result ? `\n\n—— 结果 ——\n${m.meta.result}` : ""}
				</pre>
			)}
		</div>
	);
}

function MessageItem({ m, agent }: { m: Message; agent: { id: string; avatar: string; color: string } }) {
	if (m.role === "system")
		return (
			<div className="flex justify-center py-1">
				<div className={cx("max-w-md rounded-full px-3 py-1 text-center text-xs", m.status === "error" ? "bg-red-50 text-red-600 dark:bg-red-950/40" : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800")}>
					{m.content}
					{m.meta.action === "open-models" && (
						<button className="ml-2 font-medium text-accent" onClick={() => useStore.getState().set({ settings: "models" })}>
							去配置
						</button>
					)}
				</div>
			</div>
		);
	if (m.role === "user")
		return (
			<div className="flex flex-col items-end">
				{m.content && <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] whitespace-pre-wrap text-white sm:max-w-[70%]">{m.content}</div>}
				{m.meta.attachments?.length ? <Attachments items={m.meta.attachments} mine /> : null}
			</div>
		);
	const body =
		m.role === "tool" ? (
			<ToolStep m={m} />
		) : m.role === "card" ? (
			m.meta.kind === "approval" ? <ApprovalCard m={m} /> : m.meta.kind === "question" ? <QuestionCard m={m} /> : <TaskCard m={m} />
		) : (
			<div className="min-w-0 max-w-full">
				{(m.content || m.status === "streaming") && (
					<div className={cx("inline-block max-w-full rounded-2xl rounded-tl-md bg-zinc-100 px-4 py-2.5 text-[15px] dark:bg-zinc-800/80", m.status === "error" && "border border-red-300 dark:border-red-800")}>
						{m.content ? <Markdown text={m.content} /> : null}
						{m.status === "streaming" && <span className="caret text-sm" />}
						{m.status === "error" && <div className="mt-1 text-xs text-red-500">{String(m.meta.error ?? "出错了")}</div>}
						{m.status === "interrupted" && <div className="mt-1 text-xs text-zinc-400">（已中断）</div>}
					</div>
				)}
				{m.meta.attachments?.length ? <Attachments items={m.meta.attachments} /> : null}
			</div>
		);
	return (
		<div className="flex gap-2.5">
			<div className="w-8 shrink-0">{m.role === "assistant" && <Avatar agentId={agent.id} text={agent.avatar} color={agent.color} size={32} />}</div>
			<div className="min-w-0 flex-1">{body}</div>
		</div>
	);
}

export default function Chat({ agentId }: { agentId: string }) {
	const { agents, messages, set, info } = useStore();
	const agent = agents.find((a) => a.id === agentId);
	const list = messages[agentId] ?? [];
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});
	useEffect(() => {
		stick.current = true;
	}, [agentId]);
	if (!agent) return null;
	const running = agent.status === "running";
	// 隐藏紧挨在审批卡片前、仍在等待中的工具步骤，减少重复
	return (
		<div className="flex h-full flex-col">
			<header className="safe-top flex items-center gap-3 border-b border-zinc-200 bg-white/80 px-3 py-2.5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
				<Button variant="ghost" size="icon" className="lg:hidden" onClick={() => set({ drawer: true })} aria-label="打开助理列表">
					<Menu size={20} />
				</Button>
				<Avatar agentId={agent.id} text={agent.avatar} color={agent.color} size={34} running={running} />
				<div className="min-w-0 flex-1">
					<div className="truncate font-semibold">{agent.name}</div>
					<div className="truncate text-xs text-zinc-500">{running ? <span className="text-emerald-600">{t("正在工作")}…</span> : agent.model ? `${agent.model.provider} / ${agent.model.id}` : "未配置模型"}</div>
				</div>
				<Button variant={info ? "default" : "ghost"} size="icon" onClick={() => set({ info: !info })} aria-label="信息面板">
					<PanelRight size={18} />
				</Button>
			</header>
			<div
				ref={scroller}
				className="scrollbar-thin min-h-0 flex-1 overflow-y-auto"
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
			>
				<div className="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-5 sm:px-6">
					{list.map((m) => (
						<MessageItem key={m.id} m={m} agent={agent} />
					))}
				</div>
			</div>
			<Composer agentId={agentId} name={agent.name} running={running} />
		</div>
	);
}

function Composer({ agentId, name, running }: { agentId: string; name: string; running: boolean }) {
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
	const onFiles = async (list: FileList | null) => {
		if (!list) return;
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
	return (
		<div className="safe-bottom border-t border-zinc-200 bg-white px-3 pt-2 dark:border-zinc-800 dark:bg-zinc-950">
			<div
				className="mx-auto max-w-3xl rounded-2xl border border-zinc-300 bg-white shadow-sm focus-within:border-accent dark:border-zinc-700 dark:bg-zinc-900"
				onDragOver={(e) => e.preventDefault()}
				onDrop={(e) => (e.preventDefault(), onFiles(e.dataTransfer.files))}
			>
				{(files.length > 0 || uploading > 0) && (
					<div className="flex flex-wrap gap-2 px-3 pt-3">
						{files.map((f) => (
							<span key={f.fileId} className="flex items-center gap-1.5 rounded-lg bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
								<Paperclip size={12} /> {f.name} <span className="text-zinc-400">{fmtSize(f.size)}</span>
								<button onClick={() => setFiles((x) => x.filter((y) => y.fileId !== f.fileId))} aria-label="移除">
									<X size={12} />
								</button>
							</span>
						))}
						{uploading > 0 && (
							<span className="flex items-center gap-1 text-xs text-zinc-500">
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
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) {
							e.preventDefault();
							void send();
						}
					}}
					placeholder={t("给 {name} 发消息…", { name })}
					className="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] outline-none placeholder:text-zinc-400"
				/>
				<div className="flex items-center gap-1 px-2 pb-2">
					<input ref={fileInput} type="file" multiple hidden onChange={(e) => (onFiles(e.target.files), (e.target.value = ""))} />
					<Button variant="ghost" size="icon" onClick={() => fileInput.current?.click()} aria-label={t("上传")}>
						<Paperclip size={18} />
					</Button>
					<div className="flex-1" />
					{running && (
						<Button variant="outline" size="sm" onClick={() => api(`/api/agents/${agentId}/abort`, { method: "POST" })}>
							<Square size={13} /> {t("停止")}
						</Button>
					)}
					<Button variant="primary" size="icon" className="rounded-full" disabled={!text.trim() && !files.length} onClick={send} aria-label={t("发送")}>
						<ArrowUp size={18} />
					</Button>
				</div>
			</div>
			<div className="py-1.5 text-center text-[11px] text-zinc-400">有后果的操作都会先征求你的同意</div>
		</div>
	);
}
