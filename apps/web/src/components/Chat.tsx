import { SubagentTasks } from "./Subagents";
import { HostControlBar, HostTierPill } from "./HostControl";
import { ModelPicker } from "./ModelPicker";
import { ContextRing } from "./ContextRing";
import { ProactivityPicker } from "./Proactive";
import { ArrowUp, Menu, PanelRight, Square, Users } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, upload } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";
import { resolveLayout, useWindowWidth } from "../layout";
import type { Agent, Attachment, Message } from "../types";
import { AttachButton, AttachTray, pasteFiles, useAttachUploader } from "./Attachments";
import { Avatar, Button, cx, fmtSize } from "./ui";
import { ConversationMenu } from "./Conversations";
import { COMPOSER_LABEL, isSendKey, SEND_HINT } from "../composer";
import { VoiceInput } from "./VoiceInput";

import { group, BotTurn as SharedBotTurn, BotPart as SharedBotPart, UserMsg, SystemMsg, type Part, type Row } from "./ChatMessages";
import { agentSendBody, buildReplyRef, draftSignature, newClientId, resolveAgentReplyTarget, replyDraftKey, type ReplyRef } from "../replies";
import { useReplyDrafts, setReplyDraft, clearReplyDraft } from "../replyDrafts";
import { locateAgentMessage } from "../replies-api";
import { ReplyBar, useComposerInset, useMessageJump, useReplyContext, JumpHint } from "./MessageReply";
import { mergeMessages } from "../selection";
export { Activity, activityOf, Thinking, group, UserMsg, SystemMsg, type Part, type Row } from "./ChatMessages";
// 聊天里不再显示子代理指令卡：任务统一从 header 的「子代理」入口 → 任务概览 → 详情查看。
export function BotPart(props: { p: Part; live: boolean; busy?: boolean; onQuote?: (m: Message) => void; onJump?: (id: string) => void; interaction?: (m: Message) => any }) {
	return <SharedBotPart {...props} />;
}
function BotTurn(props: { row: Extract<Row, { kind: "bot" }> | null; agent: Agent; live: boolean; onQuote?: (m: Message) => void; onJump?: (id: string) => void; interaction?: (m: Message) => any }) {
	return <SharedBotTurn {...props} />;
}

// ------------------------------------------------------------------ 主体
export default function Chat({ agentId }: { agentId: string }) {
	const { agents, messages, msgState, set, info, convs } = useStore();
	const agent = agents.find((a) => a.id === agentId);
	const list = messages[agentId] ?? [];
	const st = msgState[agentId];
	const mainList = list;
	const rows = useMemo(() => group(mainList), [mainList]);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [drag, setDrag] = useState(false);
	const composer = useRef<{ addFiles: (f: FileList | File[]) => void }>(null);
	const composerWrap = useRef<HTMLDivElement>(null);
	// ---- 引用回复：draft 按「助理 + 对话」分桶；右键 / 长按只是辅助入口
	const convId = convs[agentId]?.current ?? null;
	const rKey = replyDraftKey.agent(agentId, convId);
	const quote = useReplyDrafts((s) => s.drafts[rKey] ?? null);
	const onQuote = (m: Message) => setReplyDraft(rKey, buildReplyRef(m, m.role === "user" ? { id: "user", name: "我" } : { id: agentId, name: agent?.name ?? "助理" }));
	const onInsert = (msgs: Message[]) => useStore.setState((s) => ({ messages: { ...s.messages, [agentId]: mergeMessages(msgs, s.messages[agentId]) } }));
	const { jump, retry: retryJump, jumpState } = useMessageJump(scroller, (mid) => locateAgentMessage(convId, mid), onInsert);
	const replyCtx = useReplyContext(onQuote);
	useComposerInset(scroller, composerWrap, stick);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});
	useEffect(() => {
		stick.current = true;
	}, [agentId]);
	if (!agent) return null;
	const running = agent.status === "running";
	const replyLabel = resolveAgentReplyTarget(quote, agent.name).quoteLabel;
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
				<SideToggle />
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
					{agent.scope === "room" && agent.room_id && (
						<button className="pa-chip" data-testid="back-to-room" onClick={() => void useStore.getState().selectRoom(agent.room_id!)} title="这是群专属助理，返回它所在的群">
							<Users className="pa-ic" />
							<span className="max-sm:hidden">回到群聊</span>
						</button>
					)}
					<SubagentTasks agentId={agent.id} conversation={useStore.getState().convs[agent.id]?.current} />
					<ConversationMenu agentId={agent.id} />
					{/* 「电脑」入口在右侧信息面板的电脑 tab 里，这里不再重复放一个 */}
					<button className={cx("pa-icon-btn ghost", info && "!bg-hover")} onClick={() => set({ info: !info })} aria-label="信息面板" title={info ? "收起信息面板" : "打开信息面板"}>
						<PanelRight className="pa-ic" />
					</button>
				</div>
			</header>
			<HostControlBar />
			<div
				ref={scroller}
				className="pa-scroll"
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
				}}
			>
				<div className="pa-thread-body">
					{st?.hasMore && (
						<button className="mx-auto my-2 block rounded-lg border border-line px-3 py-1 text-xs text-mut hover:bg-hover disabled:opacity-60" disabled={st.loading} onClick={() => void useStore.getState().loadMoreMessages(agentId)} data-testid="load-more">
							{st.loading ? "加载中…" : "加载更早的消息"}
						</button>
					)}
					{!list.length && !st?.error && (st?.loading || !st?.loaded) && <ThreadSkeleton />}
					{!list.length && st?.error && (
						<div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-sm text-mut" data-testid="thread-error">
							<p>聊天记录加载失败：{st.error}</p>
							<Button size="sm" variant="outline" onClick={() => void useStore.getState().retryMessages(agentId)} data-testid="thread-retry">
								重试
							</Button>
						</div>
					)}
					{!list.length && st?.loaded && !st.error && (
						<div className="px-4 py-10 text-center text-sm text-mut2" data-testid="thread-empty">
							还没有消息，在下面输入开始对话
						</div>
					)}
					{rows.map((r) =>
						r.kind === "day" ? (
							<div key={r.id} className="pa-day">
								{r.label}
							</div>
						) : r.kind === "user" ? (
							<UserMsg key={r.m.id} m={r.m} reaction={reactions.get(r.m.id)} onQuote={onQuote} onJump={jump} interaction={replyCtx.interactionOf(r.m)} />
						) : r.kind === "system" ? (
							<SystemMsg key={r.m.id} m={r.m} />
						) : (
							<BotTurn key={r.id} row={r} agent={agent} live={running && r === lastRow} onQuote={onQuote} onJump={jump} interaction={replyCtx.interactionOf} />
						),
					)}
					{pendingTurn && <BotTurn row={null} agent={agent} live />}
				</div>
			</div>
			{replyCtx.menuEl}
			{jumpState && !quote && <JumpHint s={jumpState.s} onRetry={retryJump} />}
			<Composer ref={composer} agentId={agentId} name={agent.name} model={agent.model?.id} running={running} drag={drag} replyKey={rKey} replyLabel={replyLabel} onJump={jump} jumpState={jumpState} onRetryJump={retryJump} wrapRef={composerWrap} />
		</div>
	);
}

// ------------------------------------------------------------------ 加载骨架：切助理 / 切对话时先给可见反馈，不再是白屏
function ThreadSkeleton() {
	return (
		<div className="flex flex-col gap-3 px-4 py-6" data-testid="thread-loading" aria-busy="true">
			<span className="text-xs text-mut2">正在加载聊天记录…</span>
			{[70, 52, 84, 44].map((w, i) => (
				<div key={i} className="h-4 animate-pulse rounded bg-hover" style={{ width: `${w}%` }} />
			))}
		</div>
	);
}

// ------------------------------------------------------------------ 悬浮输入框：拖拽文件 / 粘贴图片
function Composer({ agentId, name, model, running, drag, ref, replyKey, replyLabel, onJump, jumpState, onRetryJump, wrapRef }: { agentId: string; name: string; model?: string; running: boolean; drag: boolean; ref: React.Ref<{ addFiles: (f: FileList | File[]) => void }>; replyKey: string; replyLabel: string | null; onJump: (id: string) => void; jumpState: { s: "loading" | "notfound" | "error" } | null; onRetryJump: () => void; wrapRef?: React.RefObject<HTMLDivElement | null> }) {
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	const [sendErr, setSendErr] = useState("");
	// 幂等：同一份草稿（文字 + 附件 + 引用）重试复用同一 clientId；草稿一变就换新的，避免重复唤醒
	const clientRef = useRef<{ sig: string; id: string } | null>(null);
	const { files, setFiles, pending, uploading, error: upErr, addFiles, removePending, clear } = useAttachUploader((f) => upload(agentId, f));
	const quote = useReplyDrafts((s) => s.drafts[replyKey] ?? null);
	const ta = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		const el = ta.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [text]);
	const send = async () => {
		if (sending || (!text.trim() && !files.length)) return;
		setSending(true);
		setSendErr("");
		// 幂等：同一份草稿（文字 + 附件 + 引用）重试复用同一 clientId，避免重复唤醒；草稿一变就换新的
		const sig = draftSignature({ text, attachmentIds: files.map((f) => f.fileId), replyToId: quote?.messageId });
		if (!clientRef.current || clientRef.current.sig !== sig) clientRef.current = { sig, id: newClientId() };
		const body = agentSendBody(text, files.map((f) => f.fileId), useStore.getState().convs[agentId]?.current, quote?.messageId, clientRef.current.id);
		const snapshot = { text, files };
		setText("");
		clear();
		try {
			await api(`/api/agents/${agentId}/messages`, { method: "POST", json: body });
			clearReplyDraft(replyKey); // 发送成功才清引用
			clientRef.current = null; // 下次是一份新草稿
		} catch (e) {
			// 网络失败：还原文字 / 附件，且**保留引用**
			setText(snapshot.text);
			setFiles(snapshot.files);
			setSendErr((e as Error).message);
		} finally {
			setSending(false);
		}
	};
	if (ref && typeof ref === "object") (ref as React.RefObject<{ addFiles: typeof addFiles } | null>).current = { addFiles };
	return (
		<div className="pa-composer-wrap" ref={wrapRef}>
			<div className={cx("pa-composer @container", drag && "drag")}>
				{drag && <div className="pointer-events-none pb-2 text-center text-sm text-accent">松开即可把文件发给 {name}</div>}
				{quote && <ReplyBar reply={quote} quoteLabel={replyLabel} mentionLabel={null} onCancel={() => clearReplyDraft(replyKey)} onJump={onJump} jump={jumpState ? { s: jumpState.s, retry: onRetryJump } : null} />}
				{sendErr && <div className="pb-2 text-xs text-red-600" data-testid="send-error">{sendErr}</div>}
				<AttachTray files={files} pending={pending} uploading={uploading} error={upErr} onRemove={(id) => setFiles((x) => x.filter((y) => y.fileId !== id))} onRemovePending={removePending} />
				<textarea
					ref={ta}
					rows={1}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onPaste={(e) => pasteFiles(e, (fs) => void addFiles(fs))}
					onKeyDown={(e) => {
						if (e.key === "Escape" && quote) {
							// 只取消引用，不清空已输入文字（菜单 / 弹窗的 Esc 由它们自己处理顶层）
							e.preventDefault();
							clearReplyDraft(replyKey);
							return;
						}
						if (isSendKey(e)) {
							e.preventDefault();
							void send();
						}
					}}
					placeholder={running ? t("可以随时补充或改要求，说「停」就停下") : t("给 {name} 发消息…", { name })}
				/>
				<div className="pa-composer-bar">
					<div className="pa-composer-tools">
					<AttachButton label={t("上传")} onFiles={(f) => void addFiles(f)} />
					<HostTierPill agentId={agentId} />
					<ProactivityPicker agentId={agentId} />
					<span className="flex-1" />
					<ContextRing agentId={agentId} running={!!running} />
					<ModelPicker agentId={agentId} />
					</div>
					{/* 麦克风固定贴在发送键左侧（同一行、不换行）；提示 / 「去设置」由组件渲染到独立 status 行，不挤右组 */}
					<VoiceInput
						agentId={agentId}
						conversationId={useStore.getState().convs[agentId]?.current}
						textareaRef={ta}
						value={text}
						replyTo={quote?.messageId ?? null}
						onChange={(next, cursor) => {
							setText(next);
							requestAnimationFrame(() => {
								const el = ta.current;
								if (el) {
									el.focus();
									el.setSelectionRange(cursor, cursor);
								}
							});
						}}
					/>
					{running && !text.trim() && !files.length ? (
						<button className="pa-send" onClick={() => api(`/api/agents/${agentId}/abort?conversation=${useStore.getState().convs[agentId]?.current ?? ""}`, { method: "POST" })} aria-label={t("停止")} title={t("停止")}>
							<Square size={13} fill="currentColor" />
						</button>
					) : (
						<button className="pa-send" disabled={sending || (!text.trim() && !files.length)} onClick={send} aria-label={t("发送")} title={SEND_HINT} aria-keyshortcuts="Shift+Enter">
							<ArrowUp className="pa-ic" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

/** 左栏开关：窄屏打开抽屉；宽屏下左栏收起时显示，点击展开 */
export function SideToggle() {
	const width = useWindowWidth();
	const layout = useStore((s) => s.layout);
	const { sideDocked, sideDrawer } = resolveLayout(width, layout);
	if (sideDocked) return null;
	return (
		<button
			className="pa-icon-btn ghost"
			onClick={() => (sideDrawer ? useStore.getState().set({ drawer: true }) : useStore.getState().setLayout({ sideCollapsed: false }))}
			aria-label={sideDrawer ? "打开助理列表" : "展开助理列表"}
			title={sideDrawer ? "打开助理列表" : "展开助理列表"}
		>
			<Menu className="pa-ic" />
		</button>
	);
}
