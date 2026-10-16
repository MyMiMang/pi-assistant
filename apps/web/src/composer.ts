import { useEffect, useMemo, useRef, useSyncExternalStore, type CompositionEvent as ReactCompositionEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * 输入栏按钮里的文字标签：聊天区窄时只留图标，文字信息改由按钮的 title / aria-label 提供。
 * 判断依据是**容器宽度**而不是视口宽度 —— 三个输入栏的 .pa-composer 上都加了 @container，
 * 所以大屏被左右两栏挤压时同样会 compact；max-sm 只在没有容器祖先时兜底。
 */
export const COMPOSER_LABEL = "max-sm:hidden @max-[660px]:hidden";

// ------------------------------------------------------------------ 发送快捷键偏好
/**
 * 发送快捷键：两种，按**设备**保存在 localStorage（和主题 / 语言一样，不进服务端），
 * 单聊 / 群聊 / 子代理共用同一份偏好，刷新后保持。见 docs/design/chat-send-shortcut.md。
 */
export type SendShortcut = "enter" | "shift-enter";
export const SEND_SHORTCUT_KEY = "pia.chat.sendShortcut";
/**
 * 默认 Enter 发送、Shift+Enter 换行。
 * 历史：beta.19 起为了绕开中文输入法回车确认误发送，改成了 Shift+Enter 发送；用户 2026-10-16
 * 明确要求「能修的话改回 Enter 发送」——误发由 IME guard 兜住，不再改快捷键默认值。
 * 用户显式选过 Shift+Enter 时一律保留（读到的值优先，缺省才用默认）。
 */
export const DEFAULT_SEND_SHORTCUT: SendShortcut = "enter";
/** 发送按钮 title / 输入栏提示 / 设置页选项共用的文案（一处定义，三处显示）。 */
const SEND_HINT_ENTER = "Enter 发送，Shift+Enter 换行";
const SEND_HINT_SHIFT_ENTER = "Shift+Enter 发送，Enter 换行";
export const SEND_SHORTCUT_OPTIONS: readonly { value: SendShortcut; label: string }[] = [
	{ value: "enter", label: SEND_HINT_ENTER },
	{ value: "shift-enter", label: SEND_HINT_SHIFT_ENTER },
];
/** 设置页 key：导航 data-tab / 深链 `?settings=chat` / 组件接入用（主整合 owner 在 Settings.tsx 接入）。 */
export const CHAT_SETTINGS_KEY = "chat";

/** 当前偏好对应的提示文案。 */
export function sendHint(shortcut: SendShortcut): string {
	return shortcut === "enter" ? SEND_HINT_ENTER : SEND_HINT_SHIFT_ENTER;
}
/** aria-keyshortcuts 用的按键名（只写真正会发送的那个组合）。 */
export function sendKeyshortcuts(shortcut: SendShortcut): string {
	return shortcut === "enter" ? "Enter" : "Shift+Enter";
}

const isShortcut = (v: unknown): v is SendShortcut => v === "enter" || v === "shift-enter";
/** 未知 / 缺省（含旧版本没有这个设置）→ 默认 Enter 发送；显式的 shift-enter 原样保留。 */
export function normalizeSendShortcut(v: string | null | undefined): SendShortcut {
	return isShortcut(v) ? v : DEFAULT_SEND_SHORTCUT;
}

/** localStorage 子集（可注入假实现，方便单测）。 */
export interface PreferenceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}
function storage(): PreferenceStorage | null {
	try {
		return typeof localStorage !== "undefined" ? localStorage : null;
	} catch {
		return null; // 隐私模式 / 沙箱里读 localStorage 会抛
	}
}
export function loadSendShortcut(store: PreferenceStorage | null = storage()): SendShortcut {
	try {
		return normalizeSendShortcut(store?.getItem(SEND_SHORTCUT_KEY));
	} catch {
		return DEFAULT_SEND_SHORTCUT;
	}
}
/** 写偏好（store 可注入；写失败不抛，隐私模式等场景不影响本次会话） */
export function saveSendShortcut(next: SendShortcut, store: PreferenceStorage | null = storage()): void {
	try {
		store?.setItem(SEND_SHORTCUT_KEY, next);
	} catch {
		/* 存不下也不影响本次会话 */
	}
}

// 进程内单点状态：三个输入栏订阅同一份值，改一次全部同步；另开标签页通过 storage 事件同步。
let current: SendShortcut = loadSendShortcut();
const listeners = new Set<() => void>();
let watchingStorage = false;
export function getSendShortcut(): SendShortcut {
	return current;
}
export function setSendShortcut(next: SendShortcut) {
	if (next === current) return;
	current = next;
	saveSendShortcut(next);
	listeners.forEach((l) => l());
}
export function subscribeSendShortcut(listener: () => void): () => void {
	listeners.add(listener);
	if (!watchingStorage && typeof addEventListener === "function") {
		watchingStorage = true;
		addEventListener("storage", (e) => {
			// 另一个标签页 / 窗口改了同一个偏好：只同步值，不回写（避免抖动）
			if ((e as StorageEvent).key !== SEND_SHORTCUT_KEY) return;
			const next = normalizeSendShortcut((e as StorageEvent).newValue);
			if (next === current) return;
			current = next;
			listeners.forEach((l) => l());
		});
	}
	return () => void listeners.delete(listener);
}
/** 当前设备的发送快捷键（响应式：设置页改完，三个输入栏的提示 / 行为立刻跟着变）。 */
export function useSendShortcut(): SendShortcut {
	return useSyncExternalStore(subscribeSendShortcut, getSendShortcut, () => DEFAULT_SEND_SHORTCUT);
}

// ------------------------------------------------------------------ 输入法（IME）防误发
/**
 * WebKit（Safari / WKWebView）在回车确认候选时**先**触发 compositionend，**再**派发那次回车的
 * keydown —— keydown 时 isComposing 已经是 false，光看布尔量会误发。这个窗口只做兜底：
 * 组合结束到确认回车本来就在同一个事件循环里（亚毫秒级），所以窗开得小，且最多只吞一次回车，
 * 不用长 timeout 让之后所有回车都失效。时间比较只用同一个时钟的 event.timeStamp，不跨 clock。
 */
export const IME_CONFIRM_WINDOW_MS = 120;

export interface CompositionGuard {
	/** compositionstart */
	compositionStart(): void;
	/** compositionend（传事件 timeStamp，缺省用本地时钟） */
	compositionEnd(timeStamp?: number): void;
	/**
	 * keydown 判定命中「正在组合」且按的就是**回车**时调用：这次回车由浏览器自己确认，
	 * 后面跟的 compositionend 不再粘它。方向键 / 退格这类组合中的按键不能 ack：
	 * 它们不结束组合，若也 ack 了，WebKit 上“鼠标/回车确认”的兼容路径就失效了。
	 */
	noteConfirmKey(): void;
	/** 这次 Enter keydown 是不是「输入法确认选字」（true = 不要发送，交给浏览器处理） */
	isConfirmEnter(timeStamp?: number): boolean;
	composing(): boolean;
	/** 切会话 / 卸载：清干净，避免把上一次组合的状态带到下一次 */
	reset(): void;
}
const validTs = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export function createCompositionGuard(now: () => number = () => performance.now()): CompositionGuard {
	let composing = false;
	// 组合期间是否已经见过 keydown（Chrome / Firefox：keydown 在 compositionend 之前，会带回车确认）
	let ackedByKeyDown = false;
	// 最近一次 compositionend。两个时钟各记一份，比较时只用同源的那一对
	let endEventTs: number | null = null;
	let endLocalTs: number | null = null;
	const clear = () => {
		endEventTs = null;
		endLocalTs = null;
	};
	return {
		compositionStart() {
			composing = true;
			ackedByKeyDown = false;
			clear();
		},
		compositionEnd(timeStamp) {
			composing = false;
			if (ackedByKeyDown) {
				// 确认回车已经在组合中见过：这次 compositionend 不粘任何后续回车
				ackedByKeyDown = false;
				clear();
				return;
			}
			endEventTs = validTs(timeStamp);
			endLocalTs = now();
		},
		noteConfirmKey() {
			if (composing) ackedByKeyDown = true;
		},
		isConfirmEnter(timeStamp) {
			if (endEventTs === null && endLocalTs === null) return false;
			const evTs = validTs(timeStamp);
			// 只用同一个时钟：两个事件都有 timeStamp 就用事件钟，否则两个都用本地钟
			const delta = evTs !== null && endEventTs !== null ? evTs - endEventTs : now() - (endLocalTs ?? now());
			clear();
			// 确认回车紧跟在 compositionend 之后（同刻也算），只吞这一次
			return Math.abs(delta) <= IME_CONFIRM_WINDOW_MS;
		},
		composing: () => composing,
		reset() {
			composing = false;
			ackedByKeyDown = false;
			clear();
		},
	};
}

export type ComposerKeyAction = "send" | "block" | "native";
/** 判定只需要这些字段（纯数据，方便单测；由 toComposerKeyEvent 从 React 事件里取）。 */
export interface ComposerKeyEvent {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
	repeat: boolean;
	isComposing: boolean;
	keyCode: number;
	defaultPrevented: boolean;
	timeStamp: number;
}
export function toComposerKeyEvent(e: ReactKeyboardEvent<HTMLTextAreaElement>): ComposerKeyEvent {
	const n = e.nativeEvent;
	return {
		key: e.key,
		shiftKey: e.shiftKey,
		ctrlKey: e.ctrlKey,
		altKey: e.altKey,
		metaKey: e.metaKey,
		repeat: e.repeat,
		isComposing: !!n.isComposing,
		keyCode: n.keyCode,
		defaultPrevented: e.defaultPrevented,
		timeStamp: n.timeStamp,
	};
}

/**
 * 输入栏按键的统一判定（单聊 / 群聊 / 子代理共用一处，避免三个页面各写一套条件）：
 *   - "send"   ：按偏好确实要发送 → 调用方 preventDefault 后发送
 *   - "block"  ：按住不放的自动重复 → 只 preventDefault，不连发
 *   - "native" ：交给浏览器原生处理（组合中 / 功能键组合 / 已被别人处理 / 非发送组合）
 *
 * 页面自己的按键处理（Esc 取消引用、@ 候选上下键、技能菜单等）必须排在调用它之前。
 */
export function decideComposerKey(e: ComposerKeyEvent, shortcut: SendShortcut, guard: CompositionGuard): ComposerKeyAction {
	// 1) 选字中：交给浏览器原生处理，绝不 preventDefault（否则会打断候选 / 丢掉这次选字）
	if (guard.composing() || e.isComposing || e.keyCode === 229) {
		if (e.key === "Enter") guard.noteConfirmKey();
		return "native";
	}
	// 2) 功能键组合不抢（Ctrl / Alt / Meta；Mac 上 Cmd+… 保持原生）
	if (e.ctrlKey || e.altKey || e.metaKey) return "native";
	// 3) 已经被别人处理（弹窗 / 菜单 / @ 候选）就别插手
	if (e.defaultPrevented) return "native";
	if (e.key !== "Enter") return "native";
	// 4) WebKit：compositionend 刚结束 → 这次回车是确认选字，不是发送（只吞一次）
	if (guard.isConfirmEnter(e.timeStamp)) return "native";
	// 5) 偏好：Enter 发送，或 Shift+Enter 发送（另一个组合留给浏览器换行）
	if (shortcut === "enter" ? e.shiftKey : !e.shiftKey) return "native";
	// 6) 按住不放：只发一次（否则自动重复会连发，或把空草稿刷成换行）
	if (e.repeat) return "block";
	return "send";
}

export interface ComposerKeyHandlers {
	onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
	onCompositionStart: () => void;
	onCompositionEnd: (e: ReactCompositionEvent<HTMLTextAreaElement>) => void;
}
export interface ComposerKeys {
	shortcut: SendShortcut;
	/** 发送按钮 title / 输入栏提示文案 */
	hint: string;
	/** aria-keyshortcuts */
	keyshortcuts: string;
	handlers: ComposerKeyHandlers;
}
/**
 * 三个输入栏的统一按键入口：
 *   const keys = useComposerKeys(send, ownKeyDown, resetKey);
 *   <textarea {...keys.handlers} title={keys.hint} aria-keyshortcuts={keys.keyshortcuts} />
 * ownKeyDown 是页面自己的判断（Esc / @ 候选…），返回 true 表示已处理；
 * resetKey 变化（切会话 / 切助理）时清掉组合状态，不把上一次的输入法状态带过来。
 */
export function useComposerKeys(onSend: () => void, ownKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean, resetKey?: string | null): ComposerKeys {
	const shortcut = useSendShortcut();
	const guardRef = useRef<CompositionGuard | null>(null);
	if (!guardRef.current) guardRef.current = createCompositionGuard();
	const sendRef = useRef(onSend);
	sendRef.current = onSend;
	const ownRef = useRef(ownKeyDown);
	ownRef.current = ownKeyDown;
	useEffect(() => {
		guardRef.current?.reset();
	}, [resetKey]);
	const handlers = useMemo<ComposerKeyHandlers>(
		() => ({
			onKeyDown: (e) => {
				if (ownRef.current?.(e)) return;
				const guard = guardRef.current;
				if (!guard) return;
				const action = decideComposerKey(toComposerKeyEvent(e), shortcut, guard);
				if (action === "block") e.preventDefault();
				else if (action === "send") {
					e.preventDefault();
					sendRef.current();
				}
			},
			onCompositionStart: () => guardRef.current?.compositionStart(),
			onCompositionEnd: (e) => guardRef.current?.compositionEnd(e.timeStamp),
		}),
		[shortcut],
	);
	return { shortcut, hint: sendHint(shortcut), keyshortcuts: sendKeyshortcuts(shortcut), handlers };
}
