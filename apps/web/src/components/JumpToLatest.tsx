import { ArrowDown } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * 「回到最新」圆按钮：往上翻离底部超过约一屏时出现在消息区底部正中、输入框上方（不压输入框和它上面的运行状态条）。
 * 只读滚动位置、不改 stick 判断（stick 仍由聊天自己的 onScroll 维护）；点了平滑滚到底，在历史窗口里则走 onLatest（重新拉最新一页）。
 * 翻上去期间来了新消息，按钮上显示条数。单聊、群聊共用。
 */
export function JumpToLatest({ scroller, wrap, count, onLatest }: { scroller: RefObject<HTMLElement | null>; wrap: RefObject<HTMLElement | null>; count: number; onLatest?: () => void }) {
	const [away, setAway] = useState(false);
	const [bottom, setBottom] = useState(96);
	const base = useRef(count);
	useEffect(() => {
		const s = scroller.current;
		if (!s) return;
		// 位置：避开输入框和群聊输入框上方的状态条（谁在说话 / 排队），取它们里最靠上的那个往上 12px。
		// 每次滚动 / 尺寸变化时现量（输入框在聊天记录加载完才出现，不能只在挂载时量一次）。
		const place = () => {
			const host = s.parentElement, w = wrap.current;
			if (!host || !w) return;
			const tops = [w, ...host.querySelectorAll<HTMLElement>(":scope > .pa-room-status")].map((el) => el.getBoundingClientRect().top);
			setBottom(Math.round(host.getBoundingClientRect().bottom - Math.min(...tops) + 12));
		};
		const check = () => {
			setAway(s.scrollHeight - s.scrollTop - s.clientHeight > s.clientHeight);
			place();
		};
		check();
		s.addEventListener("scroll", check, { passive: true });
		const ro = new ResizeObserver(check);
		ro.observe(s);
		if (wrap.current) ro.observe(wrap.current);
		return () => { s.removeEventListener("scroll", check); ro.disconnect(); };
	}, [scroller, wrap]);
	useEffect(() => {
		if (!away) base.current = count; // 贴底时不算新消息
	}, [away, count]);
	if (!away) return null;
	const fresh = Math.max(0, count - base.current);
	const go = () => {
		if (onLatest) return onLatest();
		const s = scroller.current;
		s?.scrollTo({ top: s.scrollHeight, behavior: "smooth" });
	};
	return (
		<button type="button" className="pa-jump-latest" style={{ bottom }} onClick={go} title="回到最新消息" aria-label={fresh ? `回到最新消息，有 ${fresh} 条新消息` : "回到最新消息"} data-testid="jump-latest">
			<ArrowDown className="pa-ic" />
			{fresh > 0 && <span className="pa-jump-latest-n" data-testid="jump-latest-count">{fresh > 99 ? "99+" : fresh}</span>}
		</button>
	);
}
