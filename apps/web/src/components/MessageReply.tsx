/**
 * 消息引用的 UI 组件：可见「引用」按钮、右键 / 长按辅助入口、引用条、已发送引用块、跳转高亮。
 *
 * 交互约束（见 docs/design/message-replies-ui.md）：
 * - 可见按钮是主入口（桌面 + 手机），右键 / 长按只是辅助；命中链接 / 图片 / 输入框不拦截原生菜单。
 * - 长按移动（滚动 / 选择）自动取消，不阻正常文字选择与复制粘贴。
 * - 引用条 Esc 只取消引用（由调用方在 textarea 处理），不清空已输入文字。
 */
import { GitBranch, Quote, RotateCcw, X } from "lucide-react";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { attachmentLabel, isQuotable, type QuotedBlock, type ReplyRef } from "../replies";
import type { LocateResult } from "../replies-api";
import type { Message } from "../types";
import { cx } from "./ui";

/** 右键命中这些元素时不接管，保留浏览器原生菜单（链接、图片下载 / 复制不受影响）。 */
export function shouldUseNativeContextMenu(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el || typeof el.closest !== "function") return true;
	return !!el.closest("a, img, input, textarea, select, video, audio, [contenteditable='true']");
}

/** 每条可引用 / 可分支消息底部的操作行：「引用」文字常显（不只 hover）；「另开新对话」只出现在用户消息上。 */
export function MessageActions({ m, onQuote, onFork, side = "left" }: { m: Message; onQuote?: (m: Message) => void; onFork?: (m: Message) => void; side?: "left" | "right" }) {
	const quoteOk = !!onQuote && isQuotable(m);
	const forkOk = !!onFork && m.role === "user";
	if (!quoteOk && !forkOk) return null;
	return (
		<div className={cx("pa-msg-actions", side)} data-testid="msg-actions">
			{quoteOk && (
				<button type="button" className="pa-quote-btn" onClick={() => onQuote!(m)} title="引用这条消息" aria-label="引用这条消息" data-testid="quote-btn">
					<Quote className="pa-ic" />
					<span className="pa-quote-btn-txt">引用</span>
				</button>
			)}
			{forkOk && (
				<button type="button" className="pa-quote-btn" onClick={() => onFork!(m)} title="从这条消息另开新对话（原文放回输入框，不会自动发送）" aria-label="从这条消息另开新对话" data-testid="fork-btn">
					<GitBranch className="pa-ic" />
					<span className="pa-quote-btn-txt">另开新对话</span>
				</button>
			)}
		</div>
	);
}

/** 输入框上方的引用条：作者 / 目标 + 1–2 行摘录 + 附件名 + 取消。 */
export function ReplyBar({ reply, quoteLabel, mentionLabel, unavailable, onCancel, onJump, jump }: { reply: ReplyRef; quoteLabel: string | null; mentionLabel: string | null; unavailable?: boolean; onCancel: () => void; onJump: (messageId: string) => void; jump?: { s: "loading" | "notfound" | "error"; retry: () => void } | null }) {
	return (
		<div className="pa-quote-bar" data-testid="quote-bar">
			<Quote className="pa-ic pa-quote-bar-ic" />
			<div className="pa-quote-main">
				<div className="pa-quote-head">
					<b>{quoteLabel ?? "引用"}</b>
					{mentionLabel && <span className="pa-quote-mention">{mentionLabel}</span>}
				</div>
				{reply.hasText && (
					<button type="button" className="pa-quote-excerpt" onClick={() => onJump(reply.messageId)} title="跳到原消息" data-testid="quote-jump">
						{reply.excerpt}
					</button>
				)}
				{reply.attachments.length > 0 && (
					<button type="button" className="pa-quote-file" onClick={() => onJump(reply.messageId)} title="跳到原消息" data-testid="quote-file">
						{reply.attachments.map(attachmentLabel).join("、")}
					</button>
				)}
				{unavailable && (
					<div className="pa-quote-warn" data-testid="quote-unavailable">
						该助理已不在群里，请用 @ 指定回复对象
					</div>
				)}
				{jump && (
					<div className="pa-quote-jump" data-testid="quote-jump-state" data-state={jump.s}>
						{jump.s === "loading" ? "正在定位原消息…" : jump.s === "notfound" ? "原消息不在当前会话或已删除" : "定位失败"}
						{jump.s !== "loading" && (
							<button type="button" className="pa-quote-retry" onClick={jump.retry} data-testid="quote-jump-retry">
								<RotateCcw className="pa-ic" /> 重试
							</button>
						)}
					</div>
				)}
			</div>
			<button type="button" className="pa-icon-btn ghost shrink-0" aria-label="取消引用" title="取消引用" onClick={onCancel} data-testid="quote-cancel">
				<X className="pa-ic" />
			</button>
		</div>
	);
}

/** 已发送消息里展示的引用块（点它跳回原消息）。 */
export function QuotedMessage({ block, onJump, mine }: { block: QuotedBlock; onJump: (messageId: string) => void; mine?: boolean }) {
	return (
		<button type="button" className={cx("pa-quoted", mine && "mine")} onClick={() => block.messageId && onJump(block.messageId)} data-testid="quoted-block">
			<span className="pa-quoted-author">
				{block.authorName}
				{block.edited && <span className="pa-quoted-tag">已编辑</span>}
			</span>
			{block.unavailable ? <span className="pa-quoted-excerpt">原消息已删除</span> : block.excerpt && <span className="pa-quoted-excerpt">{block.excerpt}{block.truncated ? "…" : ""}</span>}
			{block.attachments.map((a) => (
				<span key={a.name} className="pa-quoted-file">
					{attachmentLabel(a)}
				</span>
			))}
		</button>
	);
}

/** 跳转提示：从已发送引用块跳转、没有 draft 引用条时单独显示 loading / 失败 + 重试。 */
export function JumpHint({ s, onRetry }: { s: "loading" | "notfound" | "error"; onRetry: () => void }) {
	return (
		<div className="pa-jump-hint" role="status" data-testid="quote-jump-state" data-state={s}>
			{s === "loading" ? "正在定位原消息…" : s === "notfound" ? "原消息不在当前会话或已删除" : "定位失败"}
			{s !== "loading" && (
				<button type="button" className="pa-quote-retry" onClick={onRetry} data-testid="quote-jump-retry">
					<RotateCcw className="pa-ic" /> 重试
				</button>
			)}
		</div>
	);
}

/** 桌面右键小菜单（「引用」+「另开新对话」，不替换原生菜单）。 */
export function ReplyContextMenu({ open, at, canFork, onFork, onQuote, onClose }: { open: boolean; at: { x: number; y: number }; canFork?: boolean; onFork?: () => void; onQuote: () => void; onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDoc = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && onClose();
		// 捕获阶段吃掉 Esc：只关这一层菜单，不把底下的弹窗一起关掉
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("pointerdown", onDoc, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("scroll", onClose, true);
		window.addEventListener("resize", onClose);
		return () => {
			document.removeEventListener("pointerdown", onDoc, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", onClose, true);
			window.removeEventListener("resize", onClose);
		};
	}, [open, onClose]);
	if (!open) return null;
	const w = 168;
	const left = Math.max(8, Math.min(at.x, window.innerWidth - w - 8));
	const h = canFork && onFork ? 92 : 56;
	const top = Math.max(8, Math.min(at.y, window.innerHeight - h));
	return createPortal(
		<div ref={ref} role="menu" className="pa-reply-menu" style={{ left, top, width: w }} data-testid="reply-menu">
			<button
				type="button"
				role="menuitem"
				className="pa-reply-menu-item"
				onClick={() => {
					onQuote();
					onClose();
				}}
				data-testid="reply-menu-quote"
			>
				<Quote className="pa-ic" /> 引用
			</button>
			{canFork && onFork && (
				<button
					type="button"
					role="menuitem"
					className="pa-reply-menu-item"
					onClick={() => {
						onFork();
						onClose();
					}}
					data-testid="reply-menu-fork"
				>
					<GitBranch className="pa-ic" /> 另开新对话
				</button>
			)}
		</div>,
		document.body,
	);
}

/**
 * 手机长按辅助入口：阈值触发；移动 > 10px（滚动 / 选择）、多指、长按瞬间已有非折叠选区都不触发。
 * 不调用 preventDefault，所以不打断正常文字选择 / 复制粘贴。
 */
export function useLongPress(onLongPress: () => void, opts?: { delay?: number; move?: number }) {
	const timer = useRef<number | undefined>(undefined);
	const start = useRef<{ x: number; y: number } | null>(null);
	const cancel = () => {
		if (timer.current !== undefined) (clearTimeout(timer.current), (timer.current = undefined));
		start.current = null;
	};
	useEffect(() => () => cancel(), []);
	const props = {
		onPointerDown: (e: React.PointerEvent) => {
			if (e.pointerType === "mouse" || e.button !== 0) return;
			if (shouldUseNativeContextMenu(e.target)) return;
			start.current = { x: e.clientX, y: e.clientY };
			timer.current = window.setTimeout(() => {
				timer.current = undefined;
				if (!start.current) return;
				const sel = window.getSelection();
				if (sel && !sel.isCollapsed) return; // 正在选字：让位给系统选择
				onLongPress();
			}, opts?.delay ?? 500);
		},
		onPointerMove: (e: React.PointerEvent) => {
			if (!start.current) return;
			if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > (opts?.move ?? 10)) cancel();
		},
		onPointerUp: cancel,
		onPointerCancel: cancel,
		onPointerLeave: cancel,
	};
	return props;
}

/** 找当前滚动区里某个 mid 的锚点。 */
function findMid(root: HTMLElement | null, mid: string): HTMLElement | null {
	if (!root) return null;
	return Array.from(root.querySelectorAll<HTMLElement>("[data-mid]")).find((el) => el.dataset.mid === mid) ?? null;
}

function flash(root: HTMLElement | null, mid: string) {
	const el = findMid(root, mid);
	if (!el) return false;
	el.scrollIntoView({ block: "center", behavior: "smooth" });
	el.classList.remove("pa-msg-flash");
	void el.offsetWidth; // 重启动画
	el.classList.add("pa-msg-flash");
	window.setTimeout(() => el.classList.remove("pa-msg-flash"), 2400);
	return true;
}

export interface JumpState {
	mid: string;
	s: "loading" | "notfound" | "error";
}

/**
 * 跳回原消息：已加载直接滚 + 高亮；未加载经后端 bounded locate 插入后再定位；
 * 失败给明确提示 + 重试，不白屏 / 不死 loading。
 */
export function useMessageJump(scroller: RefObject<HTMLElement | null>, locate: (mid: string) => Promise<LocateResult>, onInsert: (msgs: Message[]) => void) {
	const [jumpState, setJumpState] = useState<JumpState | null>(null);
	const run = async (mid: string) => {
		if (flash(scroller.current, mid)) {
			setJumpState(null);
			return;
		}
		setJumpState({ mid, s: "loading" });
		const r = await locate(mid);
		if (r.message) {
			onInsert(r.context.length ? r.context : [r.message]);
			requestAnimationFrame(() => requestAnimationFrame(() => (setJumpState(null), flash(scroller.current, mid))));
		} else {
			setJumpState({ mid, s: r.retryable ? "error" : "notfound" });
		}
	};
	const jump = (mid: string) => void run(mid);
	const retry = () => jumpState && void run(jumpState.mid);
	const clear = () => setJumpState(null);
	return { jump, retry, jumpState, clear };
}

/**
 * composer 高度变化 → 同步聊天区底部留白（引用条多一行时最后一条消息不被遮）。
 * 只有用户本来就贴底（stick）时才跟随滚动，未贴底不抢滚动。
 */
export function useComposerInset(scroller: RefObject<HTMLElement | null>, wrap: RefObject<HTMLElement | null>, stick: RefObject<boolean>) {
	useLayoutEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const apply = () => {
			const s = scroller.current;
			if (!s) return;
			s.style.paddingBottom = `${Math.round(el.getBoundingClientRect().height + 24)}px`;
			if (stick.current) s.scrollTop = s.scrollHeight;
		};
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(el);
		return () => ro.disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
}

export interface MessageInteraction {
	onContextMenu: (e: React.MouseEvent) => void;
	onPointerDown: (e: React.PointerEvent) => void;
	onPointerMove: (e: React.PointerEvent) => void;
	onPointerUp: () => void;
	onPointerCancel: () => void;
	onPointerLeave: () => void;
}

/**
 * 一个聊天区共用一个右键菜单 + 长按控制器（避免每条消息一个 hook）。
 * 返回：interactionOf(m) 给消息元素展开；menuEl 挂到聊天区里。
 */
export function useReplyContext(onQuote: (m: Message) => void, onFork?: (m: Message) => void, canFork?: (m: Message) => boolean) {
	const [menu, setMenu] = useState<{ m: Message; x: number; y: number } | null>(null);
	const lp = useRef<{ timer?: number; start?: { x: number; y: number } }>({});
	const cancel = () => {
		if (lp.current.timer !== undefined) (clearTimeout(lp.current.timer), (lp.current.timer = undefined));
		lp.current.start = undefined;
	};
	useEffect(() => () => cancel(), []);
	const interactionOf = (m: Message): MessageInteraction => ({
		onContextMenu: (e) => {
			if (shouldUseNativeContextMenu(e.target)) return; // 链接 / 图片 / 输入框走原生菜单
			e.preventDefault();
			setMenu({ m, x: e.clientX, y: e.clientY });
		},
		onPointerDown: (e) => {
			if (e.pointerType === "mouse" || e.button !== 0) return;
			if (shouldUseNativeContextMenu(e.target)) return;
			lp.current.start = { x: e.clientX, y: e.clientY };
			lp.current.timer = window.setTimeout(() => {
				lp.current.timer = undefined;
				if (!lp.current.start) return;
				const sel = window.getSelection();
				if (sel && !sel.isCollapsed) return; // 正在选字：让位给系统选择
				setMenu({ m, x: e.clientX, y: e.clientY });
			}, 500);
		},
		onPointerMove: (e) => {
			const s = lp.current.start;
			if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) cancel(); // 滚动 / 滑动选择
		},
		onPointerUp: cancel,
		onPointerCancel: cancel,
		onPointerLeave: cancel,
	});
	const menuEl = (
		<ReplyContextMenu
			open={!!menu}
			at={menu ?? { x: 0, y: 0 }}
			canFork={!!menu && !!canFork?.(menu.m)}
			onFork={() => menu && onFork?.(menu.m)}
			onQuote={() => menu && onQuote(menu.m)}
			onClose={() => setMenu(null)}
		/>
	);
	return { interactionOf, menuEl };
}

