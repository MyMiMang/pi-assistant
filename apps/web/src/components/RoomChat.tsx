import { setComposerDraft, useComposerDrafts } from "../composerDrafts";
import { SubagentTasks } from "./Subagents";
import { RoomWorkButtons } from "./Autonomy";
import { ArrowUp, AtSign, Crown, Loader2, PanelRight, Plus, Settings2, Square, Trash2, Users } from "lucide-react";
import { RoomCost } from "./Usage";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, uploadRoom } from "../api";
import { AttachButton, AttachTray, pasteFiles, useAttachUploader } from "./Attachments";
import { useStore, ROOM_PAGE } from "../store";
import type { Agent, Message, Room, RoomMember } from "../types";
import { Activity, BotPart, type Part, SideToggle, SystemMsg, UserMsg } from "./Chat";
import { Avatar, Button, Help, Modal, cx } from "./ui";
import { useComposerKeys, COMPOSER_LABEL } from "../composer";
import { VoiceInput } from "./VoiceInput";
import { buildReplyRef, draftSignature, liveMentions, newClientId, replyDraftKey, resolveRoomReplyTarget, roomSendBody } from "../replies";
import { useReplyDrafts, setReplyDraft, clearReplyDraft } from "../replyDrafts";
import { locateRoomMessage, type LocateResult } from "../replies-api";
import { ReplyBar, useComposerInset, useMessageJump, useReplyContext, JumpHint } from "./MessageReply";

// ------------------------------------------------------------------ 显示用的成员信息（助理已删除时用群里存的快照）
export function memberOf(room: Room | undefined, agents: Agent[], agentId: string): { id: string; name: string; avatar: string; color: string; deleted: boolean } {
	const a = agents.find((x) => x.id === agentId);
	const m = room?.members.find((x) => x.agentId === agentId);
	return { id: agentId, name: a?.name ?? m?.name ?? "助理", avatar: a?.avatar ?? m?.avatar ?? "?", color: a?.color ?? m?.color ?? "#888", deleted: !a || !!m?.deleted };
}

export function StackedAvatars({ room, size = 22, max = 3 }: { room: Room; size?: number; max?: number }) {
	const ms = room.members.filter((m) => !m.left);
	return (
		<span className="pa-stack" style={{ ["--s" as string]: `${size}px` }}>
			{ms.slice(0, max).map((m) => (
				<span key={m.agentId} className="pa-stack-i">
					<Avatar agentId={m.deleted ? undefined : m.agentId} text={m.avatar} color={m.color} size={size} />
				</span>
			))}
			{ms.length > max && <span className="pa-stack-more" style={{ width: size, height: size }}>+{ms.length - max}</span>}
		</span>
	);
}

// ------------------------------------------------------------------ 分组：同一个助理连续的消息合成一段
type RRow = { kind: "user"; m: Message } | { kind: "system"; m: Message } | { kind: "bot"; id: string; agentId: string; parts: Part[] } | { kind: "day"; label: string; id: string };
function groupRoom(list: Message[]): RRow[] {
	const rows: RRow[] = [];
	let lastTs = 0;
	for (const m of list) {
		if (m.created_at - lastTs > 30 * 60_000) {
			const d = new Date(m.created_at);
			const same = d.toDateString() === new Date().toDateString();
			rows.push({ kind: "day", id: `d${m.id}`, label: `${same ? "今天" : `${d.getMonth() + 1}月${d.getDate()}日`} ${d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` });
		}
		lastTs = m.created_at;
		if (m.role === "user" || (m.role === "system" && !m.agent_id)) {
			rows.push({ kind: m.role === "user" ? "user" : "system", m } as RRow);
			continue;
		}
		if (m.role === "system") {
			rows.push({ kind: "system", m });
			continue;
		}
		let bot = rows[rows.length - 1];
		if (bot?.kind !== "bot" || bot.agentId !== m.agent_id) rows.push((bot = { kind: "bot", id: m.id, agentId: m.agent_id, parts: [] }));
		if (m.role === "tool") {
			const last = bot.parts[bot.parts.length - 1];
			if (last?.kind === "steps") last.items.push(m);
			else bot.parts.push({ kind: "steps", items: [m] });
		} else bot.parts.push({ kind: "msg", m });
	}
	return rows;
}

const STATUS = (reason: string) => (reason === "followup" ? "总结中" : "思考中");

export default function RoomChat({ roomId }: { roomId: string }) {
	const { rooms, agents, roomMsgs, roomWindow, info, set } = useStore();
	const room = rooms.find((r) => r.id === roomId);
	const list = roomMsgs[roomId] ?? [];
	const rows = useMemo(() => groupRoom(list), [list]);
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const [settings, setSettings] = useState(false);
	const [older, setOlder] = useState<"idle" | "loading" | "end" | "error">("idle");
	const [drag, setDrag] = useState(false);
	const composer = useRef<{ addFiles: (f: FileList | File[]) => void }>(null);
	const composerWrap = useRef<HTMLDivElement>(null);
	// ---- 引用回复（draft 按群分桶；右键 / 长按只是辅助入口）
	const rKey = replyDraftKey.room(roomId);
	const quote = useReplyDrafts((s) => s.drafts[rKey] ?? null);
	const onQuote = (m: Message) => setReplyDraft(rKey, buildReplyRef(m, m.role === "user" ? { id: "user", name: "我" } : { id: m.agent_id, name: memberOf(room, agents, m.agent_id).name }));
	const ensureLoaded = (r: LocateResult) => {
		// 用服务端有界上下文窗口替换当前群列表：目标一定在窗口里、窗口内连续无洞；窗口外不预加载。
		stick.current = false; // 跳进历史窗口后不自动贴底，滚动交给 flash 定位目标
		useStore.getState().openRoomHistoryWindow(roomId, { messages: r.context, hasOlder: r.hasOlder, hasNewer: r.hasNewer });
		setOlder(r.hasOlder === false ? "end" : "idle");
	};
	const { jump, retry: retryJump, jumpState } = useMessageJump(scroller, (mid) => locateRoomMessage(roomId, mid), ensureLoaded);
	// 从历史窗口回到最新：重新拉最近一页、清空窗口状态（不改数据、不删消息）
	const returnLatest = async () => {
		setOlder("idle");
		stick.current = true; // 用户主动回最新：跟随到底
		await useStore.getState().returnRoomToLatest(roomId);
	};
	const replyCtx = useReplyContext(onQuote);
	useComposerInset(scroller, composerWrap, stick);
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && stick.current) el.scrollTop = el.scrollHeight;
	});
	useEffect(() => {
		stick.current = true;
		setOlder("idle");
		const open = (e: Event) => (e as CustomEvent).detail === roomId && setSettings(true);
		window.addEventListener("pia:room-settings", open);
		return () => window.removeEventListener("pia:room-settings", open);
	}, [roomId]);
	if (!room) return <div className="flex h-full items-center justify-center text-sm text-mut">群聊不存在或已删除</div>;
	const st = room.state;
	const pendingCard = (agentId: string) => list.some((m) => m.role === "card" && m.agent_id === agentId && m.meta.status === "pending" && (m.meta.kind === "approval" || m.meta.kind === "question"));
	const active = room.members.filter((m) => !m.left);
	const manager = active.find((m) => m.agentId === room.managerId);
	const lastRow = rows[rows.length - 1];
	const speaking = st.current?.agentId;
	const lastPause = room.paused && !st.running ? [...list].reverse().find((m) => m.meta.action === "room-continue")?.id : undefined;
	// 向上加载更早：稳定游标 before=rowid；插入上方后保视觉锚点（滚动位置按高度差回填），不往顶跳。
	// 单次有 loading 保护，到顶（older=end）后不再发空请求；失败可点重试。
	const loadOlder = async () => {
		const first = list[0];
		if (!first?.seq || older === "loading" || older === "end") return;
		setOlder("loading");
		const el = scroller.current;
		const h = el?.scrollHeight ?? 0;
		try {
			const more = await api<Message[]>(`/api/rooms/${roomId}/messages?before=${first.seq}&limit=${ROOM_PAGE}`);
			stick.current = false;
			useStore.setState((s) => ({ roomMsgs: { ...s.roomMsgs, [roomId]: [...more, ...(s.roomMsgs[roomId] ?? [])] } }));
			setOlder(more.length < ROOM_PAGE ? "end" : "idle");
			requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - h));
		} catch {
			setOlder("error");
		}
	};
	const openMember = (agentId: string) => {
		if (!agents.some((a) => a.id === agentId)) return;
		set({ paneAgent: agentId, info: true, infoTab: "overview" });
	};
	return (
		<div
			className="relative flex h-full min-h-0 flex-col"
			data-testid="room-chat"
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
				<StackedAvatars room={room} size={26} />
				<div className="pa-head-txt min-w-0">
					<b className="truncate" data-testid="room-title">{room.name}</b>
					<small className="truncate">
						{st.running && <i className="pa-pulse" />}
						{active.length} 位成员{manager ? ` · 管理者 ${manager.name}` : ""}
						<RoomCost roomId={room.id} />
					</small>
				</div>
				<div className="pa-head-actions">
					<RoomWorkButtons key={room.id} room={room} />
					<SubagentTasks room={room.id} />
					<button className="pa-chip" onClick={() => setSettings(true)} data-testid="room-settings-btn" title="群设置">
						<Settings2 className="pa-ic" />
						<span className="max-sm:hidden">群设置</span>
					</button>
					{useStore.getState().paneAgent && (
						<button className={cx("pa-icon-btn ghost", info && "!bg-hover")} onClick={() => set({ info: !info })} aria-label="信息面板" title="成员信息">
							<PanelRight className="pa-ic" />
						</button>
					)}
				</div>
			</header>
			<div className="pa-room-members scrollbar-thin" data-testid="room-members">
				{active.map((m) => (
					<button key={m.agentId} className="pa-room-member" onClick={() => openMember(m.agentId)} title={`${m.name}${m.agentId === room.managerId ? "（管理者）" : ""}${m.scope === "room" ? " · 群专属" : ""}`}>
						<Avatar agentId={m.deleted ? undefined : m.agentId} text={m.avatar} color={m.color} size={22} running={speaking === m.agentId} />
						<span className="truncate">{m.name}</span>
						{m.agentId === room.managerId && <Crown size={11} className="shrink-0 text-amber-500" />}
					</button>
				))}
			</div>
			<div
				ref={scroller}
				className="pa-scroll"
				onScroll={(e) => {
					const el = e.currentTarget;
					stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
				}}
			>
				<div className="pa-thread-body">
					{list.length >= ROOM_PAGE && older !== "end" && (
						<div className="flex justify-center">
							<button className="pa-chip sm" onClick={loadOlder} disabled={older === "loading"} data-testid="room-load-older">
								{older === "loading" ? <Loader2 className="pa-ic animate-spin" /> : null} {older === "error" ? "加载失败，重试" : "更早的消息"}
							</button>
						</div>
					)}
					{rows.map((r) =>
						r.kind === "day" ? (
							<div key={r.id} className="pa-day">{r.label}</div>
						) : r.kind === "user" ? (
							<UserMsg key={r.m.id} m={r.m} onQuote={onQuote} onJump={jump} interaction={replyCtx.interactionOf(r.m)} />
						) : r.kind === "system" ? (
							<SystemMsg key={r.m.id} m={r.m} canContinue={r.m.id === lastPause} />
						) : (
							<RoomBotTurn key={r.id} row={r} room={room} agents={agents} live={speaking === r.agentId && r === lastRow} onAvatar={openMember} onQuote={onQuote} onJump={jump} interaction={replyCtx.interactionOf} />
						),
					)}
					{speaking && (lastRow?.kind !== "bot" || lastRow.agentId !== speaking) && <RoomBotTurn row={{ kind: "bot", id: "pending", agentId: speaking, parts: [] }} room={room} agents={agents} live onAvatar={openMember} />}
					{roomWindow[roomId] && (
						<div className="pa-history-window" data-testid="history-window">
							<span className="pa-history-note">{roomWindow[roomId]!.newCount > 0 ? `有 ${roomWindow[roomId]!.newCount} 条新消息` : "正在查看历史消息"}</span>
							<div className="pa-history-actions">
								{roomWindow[roomId]!.hasNewer && (
									<button className="pa-chip sm" onClick={() => void useStore.getState().loadNewerRoomMessages(roomId)} data-testid="history-load-newer">
										加载较新消息
									</button>
								)}
								<button className="pa-chip sm" onClick={() => void returnLatest()} data-testid="history-return-latest">
									回到最新
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
			{st.running && (
				<div className="pa-room-status" data-testid="room-status">
					{st.current && (
						<span className="pa-room-st">
							<span className="pa-spinner" />
							{memberOf(room, agents, st.current.agentId).name} {pendingCard(st.current.agentId) ? "等待审批" : STATUS(st.current.reason)}
						</span>
					)}
					{st.queue.map((id, i) => (
						<span key={`${id}${i}`} className="pa-room-st muted">{memberOf(room, agents, id).name} 排队中</span>
					))}
				</div>
			)}
			<RoomComposer room={room} running={st.running} drag={drag} ref={composer} replyKey={rKey} onJump={jump} jumpState={jumpState} onRetryJump={retryJump} wrapRef={composerWrap} />
			<RoomSettings room={room} open={settings} onClose={() => setSettings(false)} />
			{replyCtx.menuEl}
			{jumpState && !quote && <JumpHint s={jumpState.s} onRetry={retryJump} />}
		</div>
	);
}

function RoomBotTurn({ row, room, agents, live, onAvatar, onQuote, onJump, interaction }: { row: Extract<RRow, { kind: "bot" }>; room: Room; agents: Agent[]; live: boolean; onAvatar: (id: string) => void; onQuote?: (m: Message) => void; onJump?: (id: string) => void; interaction?: (m: Message) => any }) {
	const who = memberOf(room, agents, row.agentId);
	const parts = row.parts;
	const last = parts[parts.length - 1];
	const runningTool = parts.flatMap((p) => (p.kind === "steps" ? p.items : [])).find((m) => m.status === "running");
	const streaming = last?.kind === "msg" && last.m.status === "streaming";
	const waitingCard = last?.kind === "msg" && last.m.role === "card" && last.m.meta.status === "pending";
	return (
		<div className="pa-msg bot" data-testid="room-bot" data-agent={who.name}>
			<button className="pa-av-col shrink-0 self-start" onClick={() => onAvatar(row.agentId)} aria-label={who.name}>
				<Avatar agentId={who.deleted ? undefined : who.id} text={who.avatar} color={who.color} size={26} />
			</button>
			<div className="pa-bot-body">
				<div className="pa-room-name" style={{ color: who.color }}>
					{/* 手机上左侧头像列收起，头像放到名字前面（点开同样看成员详情） */}
					<button className="pa-room-inline-av" onClick={() => onAvatar(row.agentId)} aria-label={who.name}>
						<Avatar agentId={who.deleted ? undefined : who.id} text={who.avatar} color={who.color} size={18} />
					</button>
					{who.name}
					{row.agentId === room.managerId && <span className="pa-room-badge">管理者</span>}
					{who.deleted && <span className="pa-room-badge muted">已删除</span>}
				</div>
				{parts.map((p, i) => (
					<BotPart key={p.kind === "msg" ? p.m.id : p.items[0].id} p={p} live={live && i === parts.length - 1 && p.kind === "steps"} onQuote={onQuote} onJump={onJump} interaction={interaction} />
				))}
				{live && !streaming && !waitingCard && <Activity tool={runningTool} />}
			</div>
		</div>
	);
}

// ------------------------------------------------------------------ 输入框：@ 选择（桌面弹出层，手机底部面板）
const ALL = { agentId: "__all", name: "所有人" } as const;
function RoomComposer({ room, running, drag, ref, replyKey, onJump, jumpState, onRetryJump, wrapRef }: { room: Room; running: boolean; drag: boolean; ref: React.Ref<{ addFiles: (f: FileList | File[]) => void }>; replyKey: string; onJump: (id: string) => void; jumpState: { s: "loading" | "notfound" | "error" } | null; onRetryJump: () => void; wrapRef?: React.RefObject<HTMLDivElement | null> }) {
	// 草稿按群分桶（与 1:1 输入框同一份草稿 store）：切群不丢字、不串群
	const text = useComposerDrafts((s) => s.drafts[replyKey] ?? "");
	const setText = (v: string) => setComposerDraft(replyKey, v);
	const [sending, setSending] = useState(false);
	const clientRef = useRef<{ sig: string; id: string } | null>(null);
	const quote = useReplyDrafts((s) => s.drafts[replyKey] ?? null);
	const { files, setFiles, pending, uploading, error: upErr, addFiles, removePending, clear } = useAttachUploader((f) => uploadRoom(room.id, f));
	if (ref && typeof ref === "object") (ref as React.RefObject<{ addFiles: typeof addFiles } | null>).current = { addFiles };
	const [picked, setPicked] = useState<string[]>([]);
	const [q, setQ] = useState<{ at: number; query: string } | null>(null);
	const [hi, setHi] = useState(0);
	const [sheet, setSheet] = useState(false);
	const [err, setErr] = useState("");
	const ta = useRef<HTMLTextAreaElement>(null);
	const isTouch = matchMedia("(pointer: coarse)").matches;
	const narrow = typeof window !== "undefined" && window.innerWidth < 640;
	const members = room.members.filter((m) => !m.left && !m.deleted);
	// 引用 + @ 的目标标签（展示用；最终由后端裁定）
	const liveMentionIds = liveMentions(picked, text, (id) => members.find((m) => m.agentId === id)?.name);
	const target = resolveRoomReplyTarget({
		ref: quote,
		mentions: liveMentionIds.map((id) => ({ agentId: id, name: members.find((m) => m.agentId === id)?.name ?? "" })),
		members: room.members.map((m) => ({ agentId: m.agentId, name: m.name, left: m.left, deleted: m.deleted })),
		managerId: room.managerId,
	});
	useLayoutEffect(() => {
		const el = ta.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [text]);
	const options = useMemo(() => {
		const list: { agentId: string; name: string; m?: RoomMember }[] = [ALL, ...members.map((m) => ({ agentId: m.agentId, name: m.name, m }))];
		const s = (q?.query ?? "").toLowerCase();
		return list.filter((o) => !s || o.name.toLowerCase().includes(s));
	}, [members, q]);
	const detect = (value: string, caret: number) => {
		const before = value.slice(0, caret);
		const m = before.match(/(^|[^A-Za-z0-9_])[@＠]([^\s@＠]{0,20})$/);
		if (m) {
			setQ({ at: caret - m[2].length - 1, query: m[2] });
			setHi(0);
			if (narrow || isTouch) setSheet(true);
		} else {
			setQ(null);
			setSheet(false);
		}
	};
	const choose = (o: { agentId: string; name: string }) => {
		const el = ta.current;
		const at = q?.at ?? (el?.selectionStart ?? text.length);
		const end = q ? at + 1 + q.query.length : at;
		const ins = `@${o.name} `;
		const next = text.slice(0, at) + ins + text.slice(end);
		setText(next);
		if (o.agentId !== ALL.agentId) setPicked((p) => (p.includes(o.agentId) ? p : [...p, o.agentId]));
		setQ(null);
		setSheet(false);
		requestAnimationFrame(() => {
			el?.focus();
			const pos = at + ins.length;
			el?.setSelectionRange(pos, pos);
		});
	};
	const send = async () => {
		if (sending || (!text.trim() && !files.length)) return;
		setSending(true);
		const sentFiles = files;
		// 只保留文字里还在的 @（删掉的不算）
		const mentions = liveMentionIds;
		const sig = draftSignature({ text, attachmentIds: sentFiles.map((f) => f.fileId), replyToId: quote?.messageId });
		if (!clientRef.current || clientRef.current.sig !== sig) clientRef.current = { sig, id: newClientId() };
		const payload = roomSendBody(text, mentions, sentFiles.map((f) => f.fileId), quote?.messageId, clientRef.current.id);
		const snapshot = { text, picked };
		setText("");
		setPicked([]);
		setErr("");
		clear();
		try {
			await api(`/api/rooms/${room.id}/messages`, { method: "POST", json: payload });
			clearReplyDraft(replyKey); // 发送成功才清引用
			clientRef.current = null;
		} catch (e) {
			// 网络失败：还原文字 / @，并**保留引用**
			setText(snapshot.text);
			setPicked(snapshot.picked);
			setFiles(sentFiles);
			setErr((e as Error).message);
		} finally {
			setSending(false);
		}
	};
	const keys = useComposerKeys(send, (e) => {
		// @ 候选列表：上下选、Enter / Tab 确认只选人，不发送（必须排在发送判定之前）
		if (q && !sheet && options.length) {
			if (e.key === "ArrowDown") return (e.preventDefault(), setHi((hi + 1) % options.length), true);
			if (e.key === "ArrowUp") return (e.preventDefault(), setHi((hi - 1 + options.length) % options.length), true);
			if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) return (e.preventDefault(), choose(options[hi]), true);
		}
		if (e.key === "Escape" && q) return (setQ(null), setSheet(false), true);
		if (e.key === "Escape" && quote) return (e.preventDefault(), clearReplyDraft(replyKey), true);
		return false;
	}, room.id);
	const list = (
		<div role="listbox" className="pa-mention-list" data-testid="mention-list">
			{options.length === 0 && <div className="px-3 py-2 text-xs text-mut2">没有匹配的成员</div>}
			{options.map((o, i) => (
				<button
					key={o.agentId}
					role="option"
					aria-selected={i === hi}
					className={cx("pa-mention-opt", i === hi && "hi")}
					onMouseEnter={() => setHi(i)}
					onPointerDown={(e) => e.preventDefault()}
					onClick={() => choose(o)}
					data-testid="mention-opt"
				>
					{o.agentId === ALL.agentId ? <span className="pa-mention-all"><Users size={14} /></span> : <Avatar agentId={o.agentId} text={o.m!.avatar} color={o.m!.color} size={24} />}
					<span className="min-w-0 flex-1 truncate">{o.name}</span>
					{o.agentId === room.managerId && <small className="text-amber-600">管理者</small>}
					{o.agentId === ALL.agentId && <small className="text-mut2">全部成员</small>}
				</button>
			))}
		</div>
	);
	return (
		<div className="pa-composer-wrap" ref={wrapRef}>
			<div className={cx("pa-composer relative @container", drag && "drag")}>
				{q && !sheet && <div className="pa-mention-pop">{list}</div>}
				{drag && <div className="pointer-events-none pb-2 text-center text-sm text-accent">松开即可把文件发到群里</div>}
				{quote && <ReplyBar reply={quote} quoteLabel={target.quoteLabel} mentionLabel={target.mentionLabel} unavailable={target.unavailable} onCancel={() => clearReplyDraft(replyKey)} onJump={onJump} jump={jumpState ? { s: jumpState.s, retry: onRetryJump } : null} />}
				<AttachTray files={files} pending={pending} uploading={uploading} error={upErr} onRemove={(id) => setFiles((x) => x.filter((y) => y.fileId !== id))} onRemovePending={removePending} />
				{err && <div className="pb-2 text-xs text-red-600">{err}</div>}
				<textarea
					ref={ta}
					rows={1}
					value={text}
					data-testid="room-input"
					onChange={(e) => (setText(e.target.value), detect(e.target.value, e.target.selectionStart ?? e.target.value.length))}
					onPaste={(e) => pasteFiles(e, (fs) => void addFiles(fs))}
					{...keys.handlers}
					onBlur={() => !sheet && setTimeout(() => setQ(null), 120)}
					placeholder={running ? "可以随时插话，说「停」全群停下" : `发到群里… 输入 @ 指定助理`}
				/>
				<div className="pa-composer-bar">
					<div className="pa-composer-tools">
						<AttachButton onFiles={(f) => void addFiles(f)} />
						<button className="pa-icon-btn ghost" title="@ 某个助理" aria-label="@ 某个助理" data-testid="mention-btn" onClick={() => {
							const el = ta.current;
							const at = el?.selectionStart ?? text.length;
							setQ({ at, query: "" });
							setHi(0);
							// 按钮打开时没有输入 @：选中后补上
							setText(text.slice(0, at) + "@" + text.slice(at));
							if (narrow || isTouch) setSheet(true);
							requestAnimationFrame(() => (el?.focus(), el?.setSelectionRange(at + 1, at + 1)));
						}}>
							<AtSign className="pa-ic" />
						</button>
						<span className="pa-room-hint truncate @max-[660px]:hidden">不 @ 人时由管理者回答</span>
						<Help>不 @ 人：只有管理者回答，需要时它会分配给其他成员。@ 某个助理：只有它回答。@所有人：每个成员依次回答。</Help>
						<span className={cx("shrink-0 text-[11px] text-mut2", COMPOSER_LABEL)}>{keys.hint}</span>
					</div>
					{/* 麦克风固定贴在发送键左侧（同一行、不换行）；提示 / 「去设置」由组件渲染到独立 status 行，不挤右组 */}
					<VoiceInput
						agentId={room.managerId ?? undefined}
						conversationId={room.id}
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
						<button className="pa-send" onClick={() => api(`/api/rooms/${room.id}/stop`, { method: "POST" })} aria-label="停止" title="停止所有助理" data-testid="room-stop">
							<Square size={13} fill="currentColor" />
						</button>
					) : (
						<button className="pa-send" disabled={(!text.trim() && !files.length) || uploading > 0 || sending} onClick={send} aria-label="发送" title={keys.hint} aria-keyshortcuts={keys.keyshortcuts} data-testid="room-send">
							<ArrowUp className="pa-ic" />
						</button>
					)}
				</div>
			</div>
			{sheet && q && (
				<>
					<div className="fixed inset-0 z-40 bg-black/30" onClick={() => (setSheet(false), setQ(null))} />
					<div className="pa-mention-sheet safe-bottom" data-testid="mention-sheet">
						<div className="pa-sheet-grip" />
						<div className="px-4 pb-1 text-sm font-medium">选择要 @ 的助理</div>
						{list}
					</div>
				</>
			)}
		</div>
	);
}

// ------------------------------------------------------------------ 新建群聊 / 群设置
function AgentChecklist({ agents, selected, manager, onToggle, onManager }: { agents: { id: string; name: string; avatar: string; color: string; scope?: string }[]; selected: string[]; manager: string | null; onToggle: (id: string) => void; onManager: (id: string) => void }) {
	return (
		<div className="pa-room-pick scrollbar-thin" data-testid="room-pick">
			{agents.map((a) => {
				const on = selected.includes(a.id);
				return (
					<div key={a.id} className={cx("pa-room-pick-row", on && "on")} data-name={a.name}>
						<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
							<input type="checkbox" checked={on} onChange={() => onToggle(a.id)} data-testid="room-pick-agent" />
							<Avatar agentId={a.id} text={a.avatar} color={a.color} size={24} />
							<span className="min-w-0 truncate text-sm">{a.name}</span>
							{a.scope === "room" && <small className="shrink-0 text-mut2">群专属</small>}
						</label>
						{on && (
							<button className={cx("pa-chip sm shrink-0", manager === a.id ? "!border-amber-400 !text-amber-600" : "")} onClick={() => onManager(a.id)} data-testid="room-pick-manager" title="设为管理者">
								<Crown className="pa-ic" />
								<span className="max-[420px]:hidden">{manager === a.id ? "管理者" : "设为管理者"}</span>
							</button>
						)}
					</div>
				);
			})}
		</div>
	);
}

export function NewRoom({ open, onClose }: { open: boolean; onClose: () => void }) {
	const agents = useStore((s) => s.agents).filter((a) => a.scope !== "room");
	const [name, setName] = useState("");
	const [purpose, setPurpose] = useState("");
	const [sel, setSel] = useState<string[]>([]);
	const [mgr, setMgr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	useEffect(() => {
		if (open) (setName(""), setPurpose(""), setSel([]), setMgr(null), setErr(""));
	}, [open]);
	const toggle = (id: string) => {
		const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
		setSel(next);
		if (!next.includes(mgr ?? "")) setMgr(next[0] ?? null);
	};
	const builtin = async () => {
		setBusy(true);
		try {
			const a = await api<Agent>("/api/rooms/builtin-manager", { method: "POST", json: {} });
			await useStore.getState().loadAgents();
			setSel((s) => [a.id, ...s]);
			setMgr(a.id);
		} finally {
			setBusy(false);
		}
	};
	const create = async () => {
		setBusy(true);
		setErr("");
		try {
			const r = await api<Room>("/api/rooms", { method: "POST", json: { name, purpose, memberIds: sel, managerId: mgr } });
			await useStore.getState().loadRooms();
			void useStore.getState().selectRoom(r.id);
			onClose();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open={open} onClose={onClose} title="新建群聊" testId="new-room">
			<div className="space-y-3 p-5">
				<input className="pa-input" placeholder="群名（可不填）" value={name} onChange={(e) => setName(e.target.value)} data-testid="room-name" />
				<div className="flex items-center gap-1 text-sm font-medium">
					选择助理 <Help>管理者：你不 @ 人时由它回答并分配任务。其他助理只有被你或管理者 @ 时才说话，省 token。</Help>
				</div>
				<AgentChecklist agents={agents} selected={sel} manager={mgr} onToggle={toggle} onManager={setMgr} />
				<button className="pa-chip sm" onClick={builtin} disabled={busy} data-testid="builtin-manager">
					<Plus className="pa-ic" /> 添加内置管理者「管家」
				</button>
				<textarea className="pa-input !h-20 resize-y !p-2 text-sm" placeholder="群说明（可不填）：这个群做什么、有什么规矩，所有成员都会看到" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
				{err && <p className="text-sm text-red-600">{err}</p>}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>取消</Button>
					<Button variant="primary" disabled={busy || !sel.length} onClick={create} data-testid="room-create">创建</Button>
				</div>
			</div>
		</Modal>
	);
}

function RoomSettings({ room, open, onClose }: { room: Room; open: boolean; onClose: () => void }) {
	const allAgents = useStore((s) => s.agents);
	const candidates = allAgents.filter((a) => a.scope !== "room" || a.room_id === room.id);
	const [name, setName] = useState(room.name);
	const [purpose, setPurpose] = useState(room.purpose);
	const [sel, setSel] = useState<string[]>([]);
	const [mgr, setMgr] = useState<string | null>(room.managerId);
	const [caps, setCaps] = useState(room.caps);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");
	const [del, setDel] = useState(false);
	useEffect(() => {
		if (!open) return;
		setName(room.name);
		setPurpose(room.purpose);
		setSel(room.members.filter((m) => !m.left && !m.deleted).map((m) => m.agentId));
		setMgr(room.managerId);
		setCaps(room.caps);
		setErr("");
	}, [open]);
	const toggle = (id: string) => {
		const next = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
		setSel(next);
		if (!next.includes(mgr ?? "")) setMgr(next[0] ?? null);
	};
	const save = async () => {
		setBusy(true);
		setErr("");
		try {
			await api(`/api/rooms/${room.id}`, { method: "PATCH", json: { name, purpose, memberIds: sel, managerId: mgr, caps } });
			onClose();
		} catch (e) {
			setErr((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const builtin = async () => {
		setBusy(true);
		try {
			const a = await api<Agent>("/api/rooms/builtin-manager", { method: "POST", json: { roomId: room.id } });
			await useStore.getState().loadAgents();
			setSel((s) => [...s, a.id]);
			setMgr(a.id);
		} finally {
			setBusy(false);
		}
	};
	const num = (k: "maxTurns" | "perAgent" | "maxDepth", label: string, help: string) => (
		<label className="flex items-center justify-between gap-2 text-sm">
			<span className="flex min-w-0 items-center gap-1">{label}<Help>{help}</Help></span>
			<input type="number" min={k === "maxDepth" ? 0 : 1} max={30} className="pa-input !h-8 !w-20 !px-2" value={caps[k]} onChange={(e) => setCaps({ ...caps, [k]: Number(e.target.value) })} data-testid={`cap-${k}`} />
		</label>
	);
	return (
		<Modal open={open} onClose={onClose} title="群设置" testId="room-settings">
			<div className="space-y-3 p-5">
				<input className="pa-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="群名" data-testid="room-settings-name" />
				<textarea className="pa-input !h-20 resize-y !p-2 text-sm" placeholder="群说明：所有成员每次发言前都会看到" value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="群说明" />
				<div className="text-sm font-medium">成员与管理者</div>
				<AgentChecklist agents={candidates} selected={sel} manager={mgr} onToggle={toggle} onManager={setMgr} />
				{!candidates.some((a) => a.name === "管家") && (
					<button className="pa-chip sm" onClick={builtin} disabled={busy}>
						<Plus className="pa-ic" /> 添加内置管理者「管家」
					</button>
				)}
				<details className="rounded-xl border border-line p-3">
					<summary className="cursor-pointer text-sm font-medium">发言上限</summary>
					<div className="mt-3 space-y-2">
						<label className="flex items-center justify-between gap-2 text-sm">
							<span className="flex items-center gap-1">成员做完后管理者总结<Help>派出去的成员都回复后，管理者再说一次，汇总结果或继续分配。</Help></span>
							<input type="checkbox" checked={caps.followup} onChange={(e) => setCaps({ ...caps, followup: e.target.checked })} data-testid="cap-followup" />
						</label>
						{num("maxTurns", "每轮最多发言", "你发一条消息后，所有助理加起来最多说几次。到上限会暂停，回复“继续”或点继续。")}
						{num("perAgent", "每人每轮最多", "同一个助理一轮里最多说几次。")}
						{num("maxDepth", "管理者最多派活几次", "管理者分配 → 成员做完 → 管理者再分配，最多几层。")}
					</div>
				</details>
				{err && <p className="text-sm text-red-600">{err}</p>}
				<div className="flex items-center justify-between gap-2">
					<Button variant="ghost" className="!text-red-600" onClick={() => setDel(true)} data-testid="room-delete">
						<Trash2 size={14} /> 删除群聊
					</Button>
					<div className="flex gap-2">
						<Button variant="ghost" onClick={onClose}>取消</Button>
						<Button variant="primary" disabled={busy || !sel.length} onClick={save} data-testid="room-save">保存</Button>
					</div>
				</div>
			</div>
			<DeleteRoom room={room} open={del} onClose={() => setDel(false)} onDone={onClose} />
		</Modal>
	);
}

function DeleteRoom({ room, open, onClose, onDone }: { room: Room; open: boolean; onClose: () => void; onDone: () => void }) {
	const agents = useStore((s) => s.agents);
	const scoped = agents.filter((a) => a.scope === "room" && a.room_id === room.id);
	const [keep, setKeep] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const go = async () => {
		setBusy(true);
		try {
			await api(`/api/rooms/${room.id}`, { method: "DELETE", json: { keepAgents: keep } });
			const s = useStore.getState();
			await Promise.all([s.loadRooms(), s.loadAgents()]);
			s.set({ room: null, paneAgent: null });
			const first = useStore.getState().agents.find((a) => a.scope !== "room");
			if (first) void s.selectAgent(first.id);
			onClose();
			onDone();
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open={open} onClose={onClose} title={`删除群聊「${room.name}」？`} testId="delete-room-dialog">
			<div className="space-y-3 p-5 text-sm">
				<p>群消息会一起删掉。成员里的「我的助理」不受影响。</p>
				{scoped.length > 0 && (
					<div className="space-y-2">
						<div className="font-medium">这些群专属助理会被删除：</div>
						{scoped.map((a) => (
							<label key={a.id} className="flex items-center gap-2">
								<Avatar agentId={a.id} text={a.avatar} color={a.color} size={22} />
								<span className="min-w-0 flex-1 truncate">{a.name}</span>
								<input type="checkbox" checked={keep.includes(a.id)} onChange={(e) => setKeep(e.target.checked ? [...keep, a.id] : keep.filter((x) => x !== a.id))} data-testid="keep-agent" />
								<span className="shrink-0 text-xs text-mut">保留为我的助理</span>
							</label>
						))}
					</div>
				)}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>取消</Button>
					<Button variant="danger" disabled={busy} onClick={go} data-testid="confirm-delete-room">确认删除</Button>
				</div>
			</div>
		</Modal>
	);
}
