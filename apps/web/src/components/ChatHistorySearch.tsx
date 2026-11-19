import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { fmtClock, fmtFullTime } from "../clock";
import type { JumpOutcome } from "./MessageReply";
import { Button, Input, Modal } from "./ui";

type Scope = { agentId: string; conversationId: string | null } | { roomId: string };
type SearchItem = { id: string; speaker: string; createdAt: number | string; snippet: string };
type SearchPage = { items: SearchItem[]; nextCursor: string | null };

const TITLE = "搜索聊天记录";
const EMPTY: SearchPage = { items: [], nextCursor: null };

type Navigation = { onJump: (id: string) => Promise<JumpOutcome>; onLatest: () => void; onCancel: () => void };

export function ChatHistorySearch({ scope, ...navigation }: { scope: Scope } & Navigation) {
	const isRoom = "roomId" in scope;
	const path = isRoom
		? `/api/rooms/${encodeURIComponent(scope.roomId)}/messages/search`
		: `/api/agents/${encodeURIComponent(scope.agentId)}/messages/search`;
	const conversationId = isRoom ? null : scope.conversationId;
	// 会话 / 群一换就卸载旧弹层，不让搜索状态或请求跨范围串用。
	return <SearchButton key={JSON.stringify([path, conversationId])} path={path} conversationId={conversationId} disabled={!isRoom && !conversationId} {...navigation} />;
}

function SearchButton({ path, conversationId, disabled, onJump, onLatest, onCancel }: { path: string; conversationId: string | null; disabled: boolean } & Navigation) {
	const [open, setOpen] = useState(false);
	const [started, setStarted] = useState(false);
	const [viewing, setViewing] = useState(false);
	const [notice, setNotice] = useState("");
	const trigger = useRef<HTMLButtonElement>(null);
	const picked = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const attempt = useRef(0);
	const close = useCallback(() => {
		attempt.current++;
		onCancel();
		setNotice("");
		setOpen(false);
		trigger.current?.focus({ preventScroll: true });
	}, [onCancel]);
	const show = () => {
		setStarted(true);
		setOpen(true);
		requestAnimationFrame(() => (picked.current?.isConnected ? picked.current : inputRef.current)?.focus({ preventScroll: true }));
	};
	const jump = async (mid: string, button: HTMLButtonElement) => {
		const ticket = ++attempt.current;
		picked.current = button;
		setNotice("正在定位原消息…");
		const result = await onJump(mid);
		if (ticket !== attempt.current) return;
		setNotice(result === "notfound" ? "原消息已删除或不可见，请选择其他结果。" : result === "error" ? "定位失败，请重试或选择其他结果。" : "");
		if (result === "ok") {
			setViewing(true);
			setOpen(false);
			trigger.current?.focus({ preventScroll: true });
		}
	};
	return (
		<>
			<button ref={trigger} type="button" className="pa-chip disabled:opacity-50" data-testid="chat-history-search-open"
				aria-label={TITLE} title={TITLE} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={show}>
				<Search className="pa-ic" aria-hidden="true" />
			</button>
			{started && <Modal open={open} keepMounted onClose={close} title={TITLE} ariaLabel={TITLE} testId="chat-history-search">
				<SearchPanel path={path} conversationId={conversationId} jump={jump} notice={notice} inputRef={inputRef} />
			</Modal>}
			{viewing && <div className="absolute inset-x-0 top-full z-20 mx-auto flex w-fit items-center gap-2 rounded-b-xl border border-line bg-card px-2 py-1 shadow-sm">
				<Button type="button" size="sm" variant="outline" data-testid="chat-search-back" onClick={show}>返回搜索结果</Button>
				<Button type="button" size="sm" variant="outline" data-testid="chat-search-latest" onClick={() => { onLatest(); setViewing(false); trigger.current?.focus({ preventScroll: true }); }}>回到最新</Button>
			</div>}
		</>
	);
}

type PickHit = (id: string, button: HTMLButtonElement) => void;

function SearchPanel({ path, conversationId, jump, notice, inputRef }: { path: string; conversationId: string | null; jump: PickHit; notice: string; inputRef: React.Ref<HTMLInputElement> }) {
	const [input, setInput] = useState("");
	const [composing, setComposing] = useState(false);
	const q = input.trim();
	return (
		<div className="space-y-3 p-4">
			<p className="text-sm text-mut">{conversationId === null ? "只搜索当前群聊" : "只搜索当前对话"}，最新消息排在前面。</p>
			<Input ref={inputRef} type="search" className="w-full" data-testid="chat-history-search-input" aria-label="聊天记录关键词"
				placeholder="输入关键词" autoComplete="off" autoFocus value={input}
				onChange={(e) => setInput(e.currentTarget.value)} onCompositionStart={() => setComposing(true)}
				onCompositionEnd={(e) => { setInput(e.currentTarget.value); setComposing(false); }} />
			{/* 更换关键词即丢弃旧页；同一关键词两侧的空白不触发重复请求。 */}
			{!composing && q && <SearchResults key={q} path={path} conversationId={conversationId} q={q} jump={jump} />}
			{notice && <p role="status" className="text-sm text-mut" data-testid="chat-search-notice">{notice}</p>}
		</div>
	);
}

function SearchResults({ path, conversationId, q, jump }: { path: string; conversationId: string | null; q: string; jump: PickHit }) {
	const [page, setPage] = useState<SearchPage>(EMPTY);
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
	const pending = useRef<AbortController | null>(null);
	const load = useCallback(async (cursor: string | null) => {
		if (pending.current) return;
		const controller = new AbortController();
		pending.current = controller;
		setStatus("loading");
		const params = new URLSearchParams({ q });
		if (conversationId !== null) params.set("conversationId", conversationId);
		if (cursor !== null) params.set("cursor", cursor);
		try {
			const result = await api<SearchPage>(`${path}?${params}`, { signal: controller.signal });
			if (controller.signal.aborted) return;
			// 服务器按倒序返回，按游标接在末尾，保留同一时间点的服务器顺序。
			setPage((prev) => ({ items: cursor === null ? result.items : [...prev.items, ...result.items], nextCursor: result.nextCursor }));
			setStatus("ready");
		} catch {
			if (!controller.signal.aborted) setStatus("error");
		} finally {
			if (pending.current === controller) pending.current = null;
		}
	}, [path, conversationId, q]);

	useEffect(() => {
		const timer = setTimeout(() => void load(null), 250);
		return () => {
			clearTimeout(timer);
			pending.current?.abort();
			pending.current = null;
		};
	}, [load]);

	const count = page.items.length;
	return (
		<>
			{count > 0 && <ul className="max-h-[min(48dvh,28rem)] divide-y divide-line overflow-y-auto overscroll-contain" aria-label="聊天记录搜索结果">
				{page.items.map((item) => {
					const date = new Date(item.createdAt);
					const ts = date.getTime();
					return <li key={item.id}><button type="button" data-testid="chat-history-search-hit" data-message-id={item.id}
						className="block w-full rounded-md py-2.5 pr-2 text-left hover:bg-hover focus-visible:-outline-offset-2" onClick={(e) => jump(item.id, e.currentTarget)}>
						<div className="flex items-baseline justify-between gap-2 text-xs text-mut">
							<span className="min-w-0 truncate font-semibold text-fg" title={item.speaker}>{item.speaker}</span>
							{Number.isFinite(ts) && <time className="shrink-0" dateTime={date.toISOString()} title={fmtFullTime(ts)}>{fmtClock(ts, "今天 ")}</time>}
						</div>
						<p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">{item.snippet}</p>
					</button></li>;
				})}
			</ul>}
			<div className="flex items-center justify-between gap-2 text-sm text-mut">
				<span role="status">{status === "loading" ? (count ? "正在加载更多…" : "正在搜索…")
					: status === "error" ? (count ? "加载更多失败，请重试。" : "搜索失败，请重试。")
					: count ? `${page.nextCursor === null ? "共" : "已显示"} ${count} 条结果` : "没有找到匹配的消息。"}</span>
				{(page.nextCursor !== null || status === "error") && <Button type="button" size="sm" variant="outline"
					disabled={status === "loading"} onClick={() => void load(page.nextCursor)}>{status === "error" ? "重试" : "加载更多"}</Button>}
			</div>
		</>
	);
}
