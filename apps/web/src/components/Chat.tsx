import { SubagentTasks } from "./Subagents";
import { HostControlBar, HostTierButton } from "./HostControl";
import { ModelPicker } from "./ModelPicker";
import { ContextRing } from "./ContextRing";
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
import { ChatProjectsButton } from "./ChatProjects";
import { COMPOSER_LABEL, useComposerKeys } from "../composer";
import { VoiceInput } from "./VoiceInput";

import { group, BotTurn as SharedBotTurn, BotPart as SharedBotPart, UserMsg, SystemMsg, type Part, type Row } from "./ChatMessages";
import { agentSendBody, buildReplyRef, draftSignature, newClientId, resolveAgentReplyTarget, replyDraftKey, type ReplyRef } from "../replies";
import { useReplyDrafts, setReplyDraft, clearReplyDraft } from "../replyDrafts";
import { canFork, forkErrorMessage, forkFromMessage, newForkClientId } from "../fork-api";
import { setComposerDraft, useComposerDrafts } from "../composerDrafts";
import { locateAgentMessage, type LocateResult } from "../replies-api";
import { ReplyBar, useComposerInset, useMessageJump, useReplyContext, JumpHint } from "./MessageReply";
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
	/** 上一次「贴顶部自动加载」时的滚动位置：同一次停在顶部只自动加载一页（见 onScroll）。 */
	const lastAutoTop = useRef<number | null>(null);
	const [drag, setDrag] = useState(false);
	const composer = useRef<{ addFiles: (f: FileList | File[]) => void }>(null);
	const composerWrap = useRef<HTMLDivElement>(null);
	// ---- 引用回复：draft 按「助理 + 对话」分桶；右键 / 长按只是辅助入口
	const convId = convs[agentId]?.current ?? null;
	const rKey = replyDraftKey.agent(agentId, convId);
	const quote = useReplyDrafts((s) => s.drafts[rKey] ?? null);
	const onQuote = (m: Message) => setReplyDraft(rKey, buildReplyRef(m, m.role === "user" ? { id: "user", name: "我" } : { id: agentId, name: agent?.name ?? "助理" }));
	// 引用/搜索 jump 到未加载的旧消息：用服务端有界上下文窗口替换当前列表（窗口内连续无洞、不把沿途历史全加载），
	// 再滚到目标。窗口外的新消息不跨 gap 合入，只计数提示（见 store.handle）。
	const openWindow = (r: LocateResult) => {
		if (!convId) return;
		// 跳进历史窗口后不再自动贴底（新消息不拉到底，滚动交给 flash 定位目标）
		stick.current = false;
		useStore.getState().openHistoryWindow(agentId, convId, { messages: r.context, hasOlder: r.hasOlder, hasNewer: r.hasNewer });
	};
	const { jump, retry: retryJump, jumpState } = useMessageJump(scroller, (mid) => locateAgentMessage(convId, mid), openWindow);
	const [forkNotice, setForkNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
	// 「从这条消息另开新对话」：用 Pi 公开 fork 在服务端建分支对话；切到新对话并把正文放回输入框（不自动发）。
	const onFork = async (m: Message) => {
		if (!convId || !canFork(m)) return;
		setForkNotice(null);
		try {
			const r = await forkFromMessage(convId, m.id, newForkClientId());
			// 先把正文写进新对话的草稿桶再切过去：切对话不丢字、不串到原对话
			setComposerDraft(replyDraftKey.agent(agentId, r.conversationId), r.draft ?? "");
			await useStore.getState().loadConversations(agentId);
			await useStore.getState().switchConversation(agentId, r.conversationId);
			setForkNotice({ kind: "ok", text: r.draft ? "已从这条消息另开新对话，原文放回输入框了，改完自己发。" : "已从这条消息另开新对话。" });
		} catch (e) {
			setForkNotice({ kind: "error", text: forkErrorMessage(e) });
		}
	};
	const replyCtx = useReplyContext(onQuote, onFork, canFork);
	useComposerInset(scroller, composerWrap, stick);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});
	// 向上加载更早的消息：插入上方后按高度差回填滚动位置，保视觉锚点不跳；
	// 正在往上翻时不因为加载而被拉到底（先解 stick）。失败保留错误提示，可重试。
	const loadEarlier = async () => {
		const cur = useStore.getState().msgState[agentId];
		if (!cur?.hasMore || cur.loading) return;
		const el = scroller.current;
		const h = el?.scrollHeight ?? 0;
		stick.current = false;
		await useStore.getState().loadMoreMessages(agentId);
		requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - h));
	};
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
					<ChatProjectsButton conversationId={convId} version={`${list.length}:${list[list.length - 1]?.id ?? ""}:${list[list.length - 1]?.updated_at ?? 0}`} />
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
					// 滑到接近顶部自动加载更早。
					// 关键：同一次「停在顶部」只加载一页。内容插入上方后，浏览器滚动锚定会再次派发 scroll（位置几乎没变），
					// 没有位置判断的话，用户停在顶部就会被一页页把整段历史自动拉完（几十万条的会话直接打爆手机内存 / DOM）。
					if (el.scrollTop >= 200) {
						lastAutoTop.current = null; // 离开顶部 = 重新武装；下一次滑到顶才再自动加载一页
						return;
					}
					if (el.scrollHeight > el.clientHeight + 400 && (lastAutoTop.current === null || Math.abs(el.scrollTop - lastAutoTop.current) > 8)) {
						lastAutoTop.current = el.scrollTop;
						void loadEarlier();
					}
				}}
			>
				<div className="pa-thread-body">
					{st?.hasMore && (
						<button className="mx-auto my-2 block rounded-lg border border-line px-3 py-1 text-xs text-mut hover:bg-hover disabled:opacity-60" disabled={st.loading} onClick={() => void loadEarlier()} data-testid="load-more">
							{st.loading ? "加载中…" : "加载更早的消息"}
						</button>
					)}
					{list.length > 0 && st?.error && (
						<div className="mx-auto my-2 flex items-center gap-2 text-xs text-mut" data-testid="thread-more-error">
							<span>加载更早的消息失败：{st.error}</span>
							<button className="rounded-lg border border-line px-2 py-0.5 hover:bg-hover" onClick={() => void loadEarlier()} data-testid="load-more-retry">
								重试
							</button>
						</div>
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
							<UserMsg key={r.m.id} m={r.m} reaction={reactions.get(r.m.id)} onQuote={onQuote} onFork={onFork} onJump={jump} interaction={replyCtx.interactionOf(r.m)} />
						) : r.kind === "system" ? (
							<SystemMsg key={r.m.id} m={r.m} />
						) : (
							<BotTurn key={r.id} row={r} agent={agent} live={running && r === lastRow} onQuote={onQuote} onJump={jump} interaction={replyCtx.interactionOf} />
						),
					)}
					{pendingTurn && <BotTurn row={null} agent={agent} live />}
					{st?.window && (
						<div className="pa-history-window" data-testid="history-window">
							<span className="pa-history-note">{st.window.newCount > 0 ? `有 ${st.window.newCount} 条新消息` : "正在查看历史消息"}</span>
							<div className="pa-history-actions">
								{st.window.hasNewer && (
									<button className="pa-chip sm" onClick={() => void useStore.getState().loadNewerMessages(agentId)} disabled={st.loading} data-testid="history-load-newer">
										{st.loading ? "加载中…" : "加载较新消息"}
									</button>
								)}
								<button className="pa-chip sm" onClick={() => { stick.current = true; void useStore.getState().returnToLatest(agentId); }} data-testid="history-return-latest">
									回到最新
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
			{replyCtx.menuEl}
			{jumpState && !quote && <JumpHint s={jumpState.s} onRetry={retryJump} />}
			{forkNotice && (
				<div className={cx("pa-fork-notice", forkNotice.kind === "error" && "error")} role="status" data-testid="fork-notice">
					<span>{forkNotice.text}</span>
					<button type="button" aria-label="关闭提示" onClick={() => setForkNotice(null)}>
						×
					</button>
				</div>
			)}
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
	const [sending, setSending] = useState(false);
	const [sendErr, setSendErr] = useState("");
	// 草稿按「助理 + 对话」分桶（replyKey 复用回复草稿的键）：切对话 / fork 切换不丢字、不串对话
	const draftKey = replyKey;
	const text = useComposerDrafts((s) => s.drafts[draftKey] ?? "");
	const setText = (v: string) => setComposerDraft(draftKey, v);
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
	// 按键统一走 composer.ts 的判定（发送快捷键偏好 + 输入法防误发）；这里只补页面自己的 Esc。
	const keys = useComposerKeys(send, (e) => {
		if (e.key === "Escape" && quote) {
			// 只取消引用，不清空已输入文字（菜单 / 弹窗的 Esc 由它们自己处理顶层）
			e.preventDefault();
			clearReplyDraft(replyKey);
			return true;
		}
		return false;
	}, replyKey);
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
					{...keys.handlers}
					placeholder={running ? t("可以随时补充或改要求，说「停」就停下") : t("给 {name} 发消息…", { name })}
				/>
				<div className="pa-composer-bar">
					<div className="pa-composer-tools">
					<AttachButton label={t("上传")} onFiles={(f) => void addFiles(f)} />
					<HostTierButton agentId={agentId} labelClass={COMPOSER_LABEL} />
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
						<button className="pa-send" disabled={sending || (!text.trim() && !files.length)} onClick={send} aria-label={t("发送")} title={keys.hint} aria-keyshortcuts={keys.keyshortcuts}>
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
