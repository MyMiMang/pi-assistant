/**
 * 模型选择（单聊输入栏 / 群聊成员 / 子代理共用同一套菜单与状态语义）。
 *
 * 聊天 / 输入栏入口是**两层紧凑弹层**（用户参考 Codex；纯逻辑 `modelMenu.ts` 的 `pickerPanelNext`）：
 * 1) 默认只显示当前强度标题、当前模型名（可点击、带箭头）、Fast 闪电、滑块 / 必要重置；
 * 2) 点模型名才进入完整目录：搜索 →（支持推理时）思考强度 → 常用（最多 5 个快捷入口）→ 按服务分组；
 *    选完模型回到紧凑层并展示新模型 / 真实支持档位 / Fast 状态；「返回」只退一层，不改模型 / 思考 / Fast。
 * 管理型入口（默认模型设置页、组队成员编辑）仍直接打开完整目录，不把模型管理功能藏掉。
 * 「常用」只是快捷入口：不会把条目从原服务分组里移走（同一模型在常用与原渠道各 1 行；分组内按 provider/id 去重，跨分组不合并）。
 * 服务名一律用 provider 目录 / 用户给自定义服务起的名字，绝不按模型 id 猜。
 * 各入口传自己的 Fast 状态（不共用全局 localStorage），Fast 与思考强度是两个独立字段。
 */
import { Brain, Check, ChevronDown, Cpu, Search } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { COMPOSER_LABEL } from "../composer";
import { dedupeGroup, frequentModels, groupModelsByProvider, pickerPanelNext, pickKey, rankPicks, searchModels, type MenuPick, type MenuPicks, type PickerPanelEvent } from "../modelMenu";
import { THINKING_DESC, THINKING_LABEL } from "../thinking-slider";
import { useStore } from "../store";
import type { Provider } from "../types";
import { LatestWrite, SerialWriteQueue } from "../latest-write";
import { cx, useEscLayer } from "./ui";
import { FastButton, ThinkingSlider, type FastControl } from "./ThinkingSlider";

export { THINKING_DESC, THINKING_LABEL };

export { pickKey, rankPicks };
/** 兼容旧名字：菜单选项的频次记录（定义在 ../modelMenu 的纯模块里） */
export type ModelPick = MenuPick;
export type ModelPicks = MenuPicks;

export interface ModelEntry {
	provider: string;
	id: string;
	name: string;
	reasoning?: boolean;
	thinking?: string[];
	providerName?: string;
	/** Pi 模型元数据里的输入模态（`input`）；含 `image` 才算能看图（主题设计等按它判视觉）。 */
	input?: string[];
	/** 菜单里模型名下面的一行说明（组队选模型的理由等） */
	note?: string;
	/** 模型名右侧的小标签（价格档等） */
	badge?: string;
	/** 推荐（组队排序里的 ★） */
	star?: boolean;
	/** 这个模型的 Fast 能力（服务端按实际协议算；不按模型名猜） */
	fast?: { capability: "supported" | "requestable-unverified" | "unsupported"; reason?: string };
}

/** 模型目录的加载状态：`loading` 是这一次还没拿到目录（刷新时保留旧数据，不清空），`error` 是这一次拉取失败。 */
export type ConfiguredModelsStatus = "loading" | "ready" | "error";

/** 已配置的服务的全部模型（含自定义）；每次打开菜单都会重新拉一次，新增渠道后不用刷新页面 */
export function useConfiguredModels() {
	const v = useStore((s) => s.system);
	const [d, setD] = useState<{ providers: Provider[]; models: ModelEntry[] }>({ providers: [], models: [] });
	const [error, setError] = useState(false);
	const [loading, setLoading] = useState(true);
	// 请求代次：只认最后一次请求，迟到的旧响应不覆盖新数据；卸载后也不再 setState
	const gen = useRef(0);
	useEffect(() => () => { gen.current++; }, []);
	const reload = useCallback(() => {
		const token = ++gen.current;
		setLoading(true);
		void Promise.all([api("/api/models/providers"), api("/api/models")])
			.then(([p, m]) => {
				if (token !== gen.current) return;
				const providers = (p.providers ?? p) as Provider[];
				const ok = new Set(providers.filter((x) => x.configured).map((x) => x.id));
				// 刷新时只有成功才替换数据：拉取失败保留上一次目录，不把已显示的档位清空
				setD({ providers, models: (m as ModelEntry[]).filter((x) => ok.has(x.provider)) });
				setError(false);
				setLoading(false);
			})
			.catch(() => {
				if (token !== gen.current) return;
				setError(true);
				setLoading(false);
			});
	}, []);
	useEffect(reload, [reload, v]);
	const status: ConfiguredModelsStatus = loading ? "loading" : error ? "error" : "ready";
	return { ...d, error, loading, status, reload };
}

/** 用户选过哪些模型：服务端持久化（电脑和手机共用），本地乐观更新让「常用」立刻变 */
export function useModelPicks() {
	const [picks, setPicks] = useState<ModelPicks>({});
	useEffect(() => {
		void api<{ picks: ModelPicks }>("/api/models/picks")
			.then((d) => setPicks(d.picks ?? {}))
			.catch(() => {});
	}, []);
	const record = (m: { provider: string; id: string }) => {
		setPicks((p) => ({ ...p, [pickKey(m)]: { count: (p[pickKey(m)]?.count ?? 0) + 1, at: Date.now() } }));
		void api("/api/models/picks", { method: "POST", json: { provider: m.provider, id: m.id } }).catch(() => {});
	};
	return { picks, record };
}

// 弹层定位：菜单用 createPortal 挂到 body、position: fixed 锚定触发器。
// 不能直接用 absolute right-0：在设置弹窗这种块级容器里，按钮 wrapper 会被拉成整行宽，
// 菜单就相对整行右对齐、跑到触发器老远；而 fixed 在 .pa-modal（glass 皮肤的 backdrop-filter、
// 入场动画的 transform 等会创建 containing block 的祖先）里坐标又是相对该祖先的，
// 只有挂到 body 才是真正相对视口。
const POP_GAP = 8;
const POP_MARGIN = 8;

/** 窄屏底部弹窗的 bottom 偏移（与 app.css 里 .pa-pop 的媒体查询一致：6rem） */
const POP_SHEET_BOTTOM = 96;

/**
 * 按触发器位置算弹层坐标：默认放在 placement 一侧，放不下且另一侧更宽裕就翻转；水平/垂直都收在视口内。
 *
 * 高度上限只按「这一侧真正能用的空间」算，锚定也按这一侧锚（往上 = 锚 bottom，往下 = 锚 top），
 * **不再用测出来的自然高度反推 top**：两层弹层切换时新面板会先带着上一层的 maxHeight 渲染一帧，
 * 那时量到的自然高度是被裁过的（例：紧凑层 170 → 目录层量到 242 → 目录被永久限高在 314），
 * 于是完整模型目录只剩「常用 4 条 + 一个服务标题」。自然高度现在只用来决定往上还是往下。
 */
function popoverStyle(anchor: HTMLElement, panel: HTMLElement, placement: "up" | "down", naturalHeight: number): CSSProperties {
	const r = anchor.getBoundingClientRect();
	const vw = document.documentElement.clientWidth;
	const vh = document.documentElement.clientHeight;
	const w = panel.offsetWidth || panel.getBoundingClientRect().width || 320;
	const h = naturalHeight || panel.offsetHeight;
	const roomBelow = vh - POP_MARGIN - (r.bottom + POP_GAP);
	const roomAbove = r.top - POP_GAP - POP_MARGIN;
	let below = placement !== "up";
	if (placement === "up" ? h > roomAbove && roomBelow > roomAbove : h > roomBelow && roomAbove > roomBelow) below = !below;
	const left = Math.max(POP_MARGIN, Math.min(r.left, vw - POP_MARGIN - w));
	// 窄屏：.pa-pop 的媒体查询会把菜单固定成底部弹窗（left/right 8px、bottom 6rem），
	// 这时 top/left/bottom 会被 !important 覆盖，只需给个高度上限；上限用弹窗上方真正剩下的空间。
	if (vw <= 640) {
		const top = Math.max(POP_MARGIN, below ? r.bottom + POP_GAP : r.top - POP_GAP - h);
		return { position: "fixed", top, left, zIndex: 70, visibility: "visible", maxHeight: Math.max(200, Math.round(Math.min(vh * 0.72, vh - POP_SHEET_BOTTOM - POP_MARGIN))) };
	}
	// 宽屏：限高，超出视口的部分交给菜单内部滚动，弹层本身不被裁、也不出屏
	const maxHeight = Math.max(120, below ? roomBelow : roomAbove);
	return below
		? { position: "fixed", top: r.bottom + POP_GAP, left, zIndex: 70, visibility: "visible", maxHeight }
		: { position: "fixed", bottom: vh - r.top + POP_GAP, left, zIndex: 70, visibility: "visible", maxHeight };
}

/**
 * 面板的自然高度（不受上一次定位留下的 maxHeight 限制）。
 * 量之前临时去掉上限、量完立刻还原：同一个同步块里读一次布局，中间不会重绘。
 */
function naturalHeightOf(panel: HTMLElement): number {
	const prev = panel.style.maxHeight;
	panel.style.maxHeight = "none";
	const h = panel.offsetHeight;
	panel.style.maxHeight = prev;
	return h;
}

/** 定位 style 是否没变（避免每次 ResizeObserver / resize 都 setState 触发重渲染） */
function samePopStyle(a: CSSProperties, b: CSSProperties) {
	return a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.maxHeight === b.maxHeight && a.visibility === b.visibility;
}

/** 按钮 + 弹层的通用状态：open、触发器 ref、弹层 ref、弹层内联定位 style。 */
export function usePopover(placement: "up" | "down" = "down", opts?: { /** 返回 false = 只退一层，不关整个弹层 */ onEscape?: () => void | boolean; /** 层级 / 视图变化时重新量面板并贴回触发器（两层弹层切换时尺寸不同） */ layoutKey?: unknown }) {
	const [open, setOpen] = useState(false);
	const layoutKey = opts?.layoutKey;
	const ref = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const natural = useRef(0);
	const onEscape = useRef(opts?.onEscape);
	onEscape.current = opts?.onEscape;
	const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: 0, left: 0, zIndex: 70, visibility: "hidden" });
	// Esc 只关最上层（菜单里悬停出的说明气泡打开时，先关气泡、不误关菜单）；见 `ui.tsx` 的 useEscLayer
	useEscLayer(open, () => {
		// onEscape 返回 false = 只退一层（例如完整目录 → 紧凑弹层），不关整个弹层
		const keepOpen = onEscape.current?.() === false;
		if (!keepOpen) setOpen(false);
	});
	useEffect(() => {
		if (!open) return;
		// 菜单 portal 到了 body，点击判断要同时看触发器和菜单本身
		const inside = (t: EventTarget | null) => !!ref.current?.contains(t as Node) || !!menuRef.current?.contains(t as Node);
		const h = (e: MouseEvent) => {
			// 点外部关闭，但不抢走被点元素的焦点（编辑不中断）；只关闭本层
			if (!inside(e.target)) setOpen(false);
		};
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [open]);
	useLayoutEffect(() => {
		if (!open) return;
		const anchor = ref.current;
		const panel = menuRef.current;
		if (!anchor || !panel) return;
		natural.current = naturalHeightOf(panel); // 自然高度只用来决定往上还是往下（高度上限按可用空间算）
		const place = () => {
			const a = ref.current;
			const p = menuRef.current;
			if (!a || !p) return;
			const next = popoverStyle(a, p, placement, natural.current);
			setStyle((prev) => (samePopStyle(prev, next) ? prev : next));
		};
		place();
		// 设置弹窗内容滚动、窗口缩放、菜单自己变高都要重新贴回触发器
		const ro = new ResizeObserver(place);
		ro.observe(panel);
		addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			ro.disconnect();
			removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [open, placement, layoutKey]);
	return { open, setOpen, ref, menuRef, style };
}

// 同一助理的模型/强度共用写入队列；不乐观改设置，失败保留服务端已确认值。
const modelQueues = new Map<string, SerialWriteQueue>();
async function patchAgent(agentId: string, body: Record<string, unknown>) {
	let queue = modelQueues.get(agentId);
	if (!queue) modelQueues.set(agentId, (queue = new SerialWriteQueue()));
	return queue.run(async () => {
		const a = await api<Record<string, unknown>>(`/api/agents/${agentId}`, { method: "PATCH", json: body });
		// 响应的 model/thinking 是有效值，model_provider/id 和 thinkingSetting 是存储值。
		// 这些字段必须一起同步，但不能用整份响应覆盖并发修改的 Fast 等无关字段。
		const fields = "model" in body ? ["model", "model_provider", "model_id", "thinking", "thinkingSetting"] : ["thinking", "thinkingSetting"];
		const changed = Object.fromEntries(fields.map((k) => [k, a[k]]));
		useStore.setState((s) => ({ agents: s.agents.map((x) => (x.id === agentId ? { ...x, ...changed } : x)) }));
	});
}

/**
 * 只改助理的请求级 Fast：先乐观置值（界面立即反馈），失败回滚到**服务端确认过的值**并返回错误。
 * 不碰 thinking / 模型字段（后端也是独立 UPDATE）。
 *
 * 同一个助理可能有多个入口同时在飞（单聊输入栏 / 另一个窗口 / 以后的设置页），所以每个助理共用一份
 * `LatestWrite`：只认最后一次写入的响应，迟到的成功不盖新开关，迟到的失败不把界面推回旧值，
 * 回滚也落在服务端确认值上（不把未确认的乐观值当真相）。每个助理一份，别的助理互不影响。
 *
 * 顺序：同一个助理的 PATCH 走 `SerialWriteQueue` 串行发出（服务端 PATCH 是同步原子 UPDATE，没有 await 到写库），
 * 这样两次点击按顺序抵达；界面仍在点击时立即乐观更新（可随时表达新意图）。跨设备仍以服务端最后处理为准，
 * 不假装有 CAS。
 */
const fastWriters = new Map<string, LatestWrite>();
const fastQueues = new Map<string, SerialWriteQueue>();
function fastWriter(agentId: string, confirmed: boolean): LatestWrite {
	const existing = fastWriters.get(agentId);
	if (existing) return existing;
	// 首次写入前，store 里的值来自服务端（`GET /api/agents`），可以当已确认的起点
	const created = new LatestWrite(confirmed ? "1" : "0");
	fastWriters.set(agentId, created);
	return created;
}

async function patchAgentFast(agentId: string, next: boolean) {
	const w = fastWriter(agentId, useStore.getState().agents.find((a) => a.id === agentId)?.fast === true);
	const gen = w.begin();
	// 乐观：界面立即跟手（可随时表达新意图），请求排进这个助理自己的串行队列
	useStore.setState((s) => ({ agents: s.agents.map((x) => (x.id === agentId ? { ...x, fast: next } : x)) }));
	let queue = fastQueues.get(agentId);
	if (!queue) fastQueues.set(agentId, (queue = new SerialWriteQueue()));
	return queue.run(async () => {
		try {
			const a = await api(`/api/agents/${agentId}`, { method: "PATCH", json: { fast: next } });
			// 迟到的成功：用户已经又改了一次，这次结果不代表当前意图，不写确认值也不动界面
			if (!w.isCurrent(gen)) return;
			const confirmed = a.fast === true;
			w.confirm(gen, confirmed ? "1" : "0");
			// 只合并 fast：同一时间用户可能改了 thinking / 模型，整份覆盖会把那些更新的值写回旧的
			useStore.setState((s) => ({ agents: s.agents.map((x) => (x.id === agentId ? { ...x, fast: confirmed } : x)) }));
		} catch (e) {
			const r = w.fail(gen);
			// 不是最后一次：这次失败已经被用户的新选择取代，不回滚也不报错（否则会误导成最新一次也失败）
			if (!r.rollback) return;
			// 回滚取服务端当前真值：别的设备 / WS 刷新可能已经让本地「确认值」过时，不能拿旧值盖回去。
			// 读不到（网络 / 服务异常）时才退回本端上一次确认值。
			let truth: boolean | null = null;
			try {
				const fresh = (await api<{ id: string; fast?: boolean }[]>("/api/agents")).find((x) => x.id === agentId);
				if (fresh) truth = fresh.fast === true;
			} catch {}
			// 重读也会等待网络；这期间的新点击已作废本次失败，不能再覆盖最新乐观值。
			if (!w.isCurrent(gen)) return;
			const value = truth ?? (r.value === "1");
			if (truth !== null) w.confirm(gen, truth ? "1" : "0");
			// 仍是最后一次才回滚，且只回滚 fast 字段（不碰 thinking / 模型 / 消息）
			useStore.setState((s) => ({ agents: s.agents.map((x) => (x.id === agentId ? { ...x, fast: value } : x)) }));
			throw e;
		}
	});
}

// ------------------------------------------------------------------ 共用的下拉菜单
export interface ThinkingChoice {
	levels: string[];
	current: string | null;
	effective?: string | null;
	followLabel?: string;
	onPick: (level: string | null) => void;
}

/**
 * 独立的「思考强度」按钮（复用同一套档位文案与样式）。
 * current = null 表示跟随默认；传 followLabel 时弹层里多一个「跟随…」的 reset 动作（子代理用）。
 * 弹层内容是离散滑块（`ThinkingSlider`），保留原 `testid` 与 `onPick(level | null)` 口径。
 * effective：跟随 / 降级时实际会运行的档位（子代理传 resolvedThinking）；modelName：弹层右上角短模型名。
 */
export function ThinkingButton({ testid, levels, current, effective, followLabel, onPick, text, title, ariaLabel, buttonClass, placement = "down", modelName, loading, error, onRetry, fast, disabled }: { testid: string; levels: string[]; current: string | null; effective?: string | null; followLabel?: string; onPick: (level: string | null) => void; text?: string; title?: string; ariaLabel?: string; buttonClass?: string; placement?: "up" | "down"; modelName?: string; disabled?: boolean; /** 模型目录正在加载（还没拿到目录时不要画「不支持」和假档位） */ loading?: boolean; /** 模型目录这一次加载失败（给一句短说明和重试，不冒充「不支持」） */ error?: boolean; /** 重试加载模型目录（复用 useConfiguredModels 的 reload） */ onRetry?: () => void; /** 左上角闪电（请求级 Fast）；不传 = 这个上下文不能设（显示不可用原因） */ fast?: FastControl }) {
	const btnRef = useRef<HTMLButtonElement>(null);
	const openedByKeyboard = useRef(false);
	// Esc 关闭后焦点回到芯片；点外部关闭不抢焦点
	const { open, setOpen, ref, menuRef, style } = usePopover(placement, { onEscape: () => btnRef.current?.focus() });
	const label = text ?? (current ? (THINKING_LABEL[current] ?? current) : (followLabel ?? "思考"));
	// 目录还没回来（且手上没有可用的旧档位）时只显示「正在加载 / 加载失败」，已成功且 levels 为空才是真不支持
	const pending = (loading || error) && levels.length === 0;
	return (
		<div className="relative min-w-0" ref={ref}>
			<button ref={btnRef} type="button" disabled={disabled} className={cx("pa-chip sm !shrink min-w-0", buttonClass)} onClick={(e) => { openedByKeyboard.current = e.detail === 0; setOpen(!open); }} title={title ?? "思考强度"} aria-label={ariaLabel ?? `思考强度：${label}`} data-testid={testid}>
				<Brain className="pa-ic" />
				<span className="truncate">
					<span className="max-sm:hidden">思考·</span>
					{label}
				</span>
				<ChevronDown size={12} />
			</button>
			{open &&
				createPortal(
					<div ref={menuRef} style={style} className="pa-pop pa-think-pop flex flex-col rounded-xl border border-line bg-card p-3 shadow-lg" data-testid={`${testid}-menu`}>
						{/* 小屏（≤640 走底部弹窗）时自身可滚动，弹层不被裁 */}
						<div className="min-h-0 flex-1 overflow-y-auto">
							{pending ? (
								<div className="pa-think flex flex-col gap-2" data-testid={`${testid}-model-state`}>
									<div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-mut uppercase"><Brain size={12} /> 思考强度</div>
									{loading ? (
										<p className="pa-think-empty" data-testid={`${testid}-loading`} role="status" aria-live="polite">正在加载模型档位…</p>
									) : (
										<p className="pa-think-empty" data-testid={`${testid}-error`} role="alert">
											模型目录没加载出来。
											{onRetry && <button type="button" className="pa-think-mini ml-2" data-testid={`${testid}-retry`} onClick={() => onRetry()}>重试</button>}
										</p>
									)}
									<p className="pa-think-note">加载完会显示这个模型支持的档位。</p>
								</div>
							) : (
								<ThinkingSlider testid={testid} levels={levels} current={current} effective={effective} followLabel={followLabel} modelName={modelName} autoFocus={openedByKeyboard.current} fast={fast} onPick={(l) => { setOpen(false); onPick(l); }} />
							)}
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}

/**
 * 完整模型目录的尺寸：桌面给足宽度（默认 420px，可被主题 `--pa-model-menu-w` 覆盖），窄屏交给 .pa-pop 的底部弹窗规则。
 *
 * 为什么必须内联：app.css 的 `.pa-pop { width: max-content; max-width: min(var(--pop-w, 20rem), calc(100vw - 16px)) }`
 * 是未分层规则，会盖掉 Tailwind 的 `w-80`（utilities 层）——目录宽度因此跟着「最宽的那段文字」走，
 * 而条目文字全是 truncate，实测只有 210–230px（即使长名字也顶到 320px 封顶）：长模型名互相挤压、只看得见半列。
 * 紧凑层（.pa-compact-pop 340）是「只放当前模型 / 滑块 / Fast」的，不受这里影响。
 */
const MODEL_MENU_WIDTH = "min(var(--pa-model-menu-w, 420px), calc(100vw - 16px))";
const modelMenuSize: CSSProperties = { width: MODEL_MENU_WIDTH, maxWidth: MODEL_MENU_WIDTH };

function Option({ m, sel, id, onPick }: { m: ModelEntry; sel: boolean; id: string; onPick: (m: ModelEntry) => void }) {
	return (
		<button className={cx("flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", sel && "bg-hover")} onClick={() => onPick(m)} data-testid={`${id}-option`} data-model={pickKey(m)} title={m.name}>
			<span className="min-w-0 flex-1">
				<span className="block truncate">
					{m.star ? "★ " : ""}
					{m.name}
				</span>
				{(m.badge || m.note) && (
					<span className="block truncate text-[11px] text-mut">
						{m.badge ? `${m.badge} · ` : ""}
						{m.note ?? ""}
					</span>
				)}
			</span>
			{m.reasoning && <Brain size={12} className="mt-1 shrink-0 text-mut" aria-label="支持推理" />}
			{sel && <Check size={14} className="mt-0.5 shrink-0 text-accent" />}
		</button>
	);
}

export interface ModelMenuProps {
	/** 菜单 / 搜索 / 选项的 testid 前缀（聊天用 model，群聊成员用 pm-model，子代理用 subagent-model） */
	id: string;
	models: ModelEntry[];
	providers: Provider[];
	value?: { provider: string; id: string } | null;
	thinking?: ThinkingChoice | null;
	/** 左上角闪电（请求级 Fast）：主会话 / 群成员 / 子代理各传自己的状态 */
	fast?: FastControl;
	picks?: ModelPicks;
	onPick: (m: ModelEntry) => void;
	/** false 时按传入顺序平铺（组队排序用），不按服务分组 */
	groupByProvider?: boolean;
	/** 菜单顶部固定内容（子代理的「跟随 / 自动挑」等） */
	header?: ReactNode;
	/** 弹层定位由 ModelPickerButton 的 usePopover 提供（portal 到 body + fixed 锚定触发器） */
	panelRef?: RefObject<HTMLDivElement | null>;
	panelStyle?: CSSProperties;
	/** 目录第一次还没加载完：不要显示「还没有配置模型服务」这种误判 */
	loading?: boolean;
	/** 目录这一次加载失败：给「没加载出来 + 重试」，不冒充「还没有配置模型服务」 */
	error?: boolean;
	onRetry?: () => void;
	/** 从紧凑弹层进入完整目录时，给一个明确的返回动作（返回不改模型 / 思考 / Fast） */
	onBack?: () => void;
}

export function ModelMenu({ id, models, providers, value, thinking, fast, picks, onPick, groupByProvider = true, header, panelRef, panelStyle, loading, error, onRetry, onBack }: ModelMenuProps) {
	const [q, setQ] = useState("");
	const [openGroups, setOpenGroups] = useState<string[]>(() => (value?.provider ? [value.provider] : models[0] ? [models[0].provider] : []));
	const nameOf = (p: string) => providers.find((x) => x.id === p)?.name ?? models.find((m) => m.provider === p)?.providerName ?? p;
	// 来自实际选中值（不是候选池 / 搜索词）：只有真实单模型才把名字写进滑块头部，没有值就不伪一个模型名
	const picked = value ? models.find((m) => m.provider === value.provider && m.id === value.id) : undefined;
	const pickedName = picked?.name ?? value?.id;
	const shown = searchModels(models, q, nameOf);
	// 「常用」是快捷入口：只在顶部多列一份，不从下面的服务分组里摘掉（去重只在同一分组内做）
	const frequent = frequentModels(models, picks, q, 5);
	const groups = groupByProvider ? groupModelsByProvider(shown, nameOf, value?.provider) : shown.length ? [{ provider: "", name: "", models: dedupeGroup(shown) }] : [];
	const isOpen = (p: string) => !groupByProvider || !!q.trim() || openGroups.includes(p);
	return (
		<div ref={panelRef} style={{ ...panelStyle, ...modelMenuSize }} className="pa-pop flex flex-col rounded-xl border border-line bg-card p-1.5 shadow-lg" data-testid={`${id}-menu`}>
			{onBack && (
				<button type="button" className="pa-menu-back" onClick={onBack} data-testid={`${id}-back`} aria-label="返回思考与模型">
					‹ 返回
				</button>
			)}
			<label className="mb-1 flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5">
				<Search size={14} className="text-mut" />
				<input autoFocus className="min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="搜索模型或服务…" value={q} onChange={(e) => setQ(e.target.value)} data-testid={`${id}-search`} />
			</label>
			{header}
			{thinking && (thinking.levels.length > 1 || !!fast) && (
				<div className="mb-1 rounded-lg border border-line px-2.5 py-1.5" data-testid={`${id}-thinking`}>
					{/* 与输入栏 / 子代理同一个离散滑块；头部由滑块自己画（当前档 + 实际模型名），外面不再重复一行「思考强度」 */}
					<ThinkingSlider testid="thinking" levels={thinking.levels} current={thinking.current} effective={thinking.effective} followLabel={thinking.followLabel} modelName={pickedName} fast={fast} onPick={thinking.onPick} />
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{!models.length &&
					(loading ? <div className="p-3 text-sm text-mut" data-testid={`${id}-loading`} role="status">正在加载模型…</div> : error ? (
						<div className="p-3 text-sm text-mut" data-testid={`${id}-error`} role="alert">
							模型目录没加载出来。
							{onRetry && <button type="button" className="pa-think-mini ml-2" data-testid={`${id}-retry`} onClick={() => onRetry()}>重试</button>}
						</div>
					) : <div className="p-3 text-sm text-mut">还没有配置模型服务：在 设置 › 模型 里添加</div>)}
				{!!models.length && !shown.length && <div className="p-3 text-sm text-mut">没有匹配的模型</div>}
				{frequent.length > 0 && (
					<div className="py-1" data-testid={`${id}-frequent`}>
						<div className="px-2.5 pb-0.5 text-[11px] font-semibold tracking-wide text-mut uppercase">常用</div>
						{frequent.map((m) => (
							<Option key={pickKey(m)} m={m} sel={pickKey(m) === (value ? pickKey(value) : "")} id={id} onPick={onPick} />
						))}
					</div>
				)}
				{groups.map((g) => (
					<div key={g.provider || "flat"} className="py-1">
						{groupByProvider ? (
							<button className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1 text-left" onClick={() => setOpenGroups((l) => (l.includes(g.provider) ? l.filter((x) => x !== g.provider) : [...l, g.provider]))} aria-expanded={isOpen(g.provider)} data-testid={`${id}-group-${g.provider}`}>
								<ChevronDown size={12} className={cx("shrink-0 text-mut transition-transform", !isOpen(g.provider) && "-rotate-90")} />
								<span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-mut uppercase">{g.name}</span>
								<span className="shrink-0 text-[11px] text-mut2">{g.models.length}</span>
							</button>
						) : null}
						{isOpen(g.provider) &&
							g.models.map((m) => <Option key={pickKey(m)} m={m} sel={pickKey(m) === (value ? pickKey(value) : "")} id={id} onPick={onPick} />)}
					</div>
				))}
			</div>
		</div>
	);
}

export interface ModelPickerButtonProps {
	/** 按钮的 testid */
	testid: string;
	/** 菜单 / 搜索 / 选项的 testid 前缀；不传就用按钮 testid */
	id?: string;
	models: ModelEntry[];
	providers: Provider[];
	value?: { provider: string; id: string } | null;
	thinking?: ThinkingChoice | null;
	/** 左上角闪电（请求级 Fast）：主会话 / 群成员 / 子代理各传自己的状态 */
	fast?: FastControl;
	picks?: ModelPicks;
	onPick: (m: ModelEntry) => void;
	/** 按钮上的文字（一般是「模型名 · 思考档位」）；不传就只显示图标 */
	text?: string;
	icon?: ReactNode;
	title?: string;
	ariaLabel?: string;
	buttonClass?: string;
	/** true：聊天输入栏那种窄容器里只留图标 */
	hideTextInNarrow?: boolean;
	groupByProvider?: boolean;
	placement?: "up" | "down";
	/** 菜单顶部固定内容（子代理的「跟随 / 自动挑」、群聊的「默认模型」）；回调里可 close() 关掉菜单 */
	header?: (close: () => void) => ReactNode;
	disabled?: boolean;
	/** 打开菜单时调用（用于重新拉一次模型列表） */
	onOpen?: () => void;
	/** 模型目录第一次还没加载完（菜单里不误报「还没有配置模型服务」） */
	loading?: boolean;
	/** 模型目录这一次加载失败：紧凑层给「加载失败 + 重试」，不冒充「不支持思考强度」 */
	error?: boolean;
	/** 重试拉模型目录（复用 useConfiguredModels 的 reload） */
	onRetry?: () => void;
	/** 输入栏 / 聊天入口：默认打开紧凑弹层（强度 + 模型名 + 闪电 + 滑块），点模型名才进完整目录 */
	compact?: boolean;
}

/** 共用的「模型按钮 + 菜单」；聊天 / 群聊成员 / 子代理都用它，避免各写一套 */
export function ModelPickerButton({ testid, id = testid, models, providers, value, thinking, fast, picks, onPick, text, icon, title, ariaLabel, buttonClass, hideTextInNarrow, groupByProvider, placement, header, disabled, onOpen, loading, error = false, onRetry, compact = false }: ModelPickerButtonProps) {
	const btnRef = useRef<HTMLButtonElement>(null);
	// 键盘（Enter / Space）打开时把焦点落进紧凑层的模型名，鼠标打开不抢焦点
	const openedByKeyboard = useRef(false);
	// 两层：compact = 默认紧凑弹层；list = 完整模型目录（搜索 / 服务分组 / 常用，全部保留）
	const [layer, setLayer] = useState<"compact" | "list">("compact");
	// 返回 / 选完模型后把焦点放回模型名（键盘不丢位置）；初次打开不抢焦点
	const [focusModel, setFocusModel] = useState(false);
	// 没有 thinking 信息的入口（默认模型设置页等）不做两层，保持原来的「直接打开目录」
	const twoLevel = compact && !!thinking;
	// 所有层级切换都走同一个纯函数，避免各入口各写一套状态
	const applyPanel = (event: PickerPanelEvent) => {
		const n = pickerPanelNext({ open, layer, focusModel }, event, twoLevel);
		setOpen(n.open);
		setLayer(n.layer);
		setFocusModel(n.focusModel);
		return n;
	};
	const { open, setOpen, ref, menuRef, style } = usePopover(placement ?? "up", {
		layoutKey: layer,
		onEscape: () => {
			// 目录里 Esc 只退一层；紧凑层再按 Esc 才关闭；关闭后焦点回触发器
			const n = applyPanel("escape");
			if (n.open) return false;
			btnRef.current?.focus();
		},
	});
	useEffect(() => {
		if (!open) {
			setLayer("compact");
			setFocusModel(false);
		}
	}, [open]);
	const list = (
		<ModelMenu
			id={id}
			models={models}
			providers={providers}
			value={value}
			// 两层入口的目录层只做「选模型」：思考强度 / Fast 已经在紧凑层，不在这里再摆一整套；
			// 管理型入口（默认模型设置页 / 组队成员编辑）仍保留菜单里的强度块
			thinking={twoLevel || !thinking ? null : { ...thinking, onPick: (l) => (applyPanel("close"), thinking.onPick(l)) }}
			fast={twoLevel ? undefined : fast}
			picks={picks}
			groupByProvider={groupByProvider}
			panelRef={menuRef}
			panelStyle={style}
			header={header?.(() => setOpen(false))}
			loading={loading}
			error={error}
			onRetry={onRetry}
			onBack={twoLevel ? () => applyPanel("back") : undefined}
			onPick={(m) => {
				// 选完模型回到紧凑层（展示新模型 / 真实档位 / Fast 状态）；不替调用方改别的值
				applyPanel("pick");
				onPick(m);
			}}
		/>
	);
	return (
		<div className="relative min-w-0" ref={ref}>
			<button
				ref={btnRef}
				type="button"
				className={cx("pa-chip sm !shrink min-w-0", buttonClass)}
				disabled={disabled}
				onClick={(e) => {
					if (open) applyPanel("close");
					else {
						openedByKeyboard.current = e.detail === 0;
						onOpen?.();
						applyPanel("open");
					}
				}}
				title={title}
				aria-label={ariaLabel}
				data-testid={testid}
			>
				{icon ?? <Cpu className="pa-ic" />}
				{text ? <span className={cx("truncate", hideTextInNarrow && COMPOSER_LABEL)}>{text}</span> : null}
				<ChevronDown size={12} />
			</button>
			{open &&
				createPortal(
					twoLevel && layer === "compact" ? (
						<div ref={menuRef} style={style} className="pa-pop pa-compact-pop rounded-xl border border-line bg-card shadow-lg" data-testid={`${testid}-compact`}>
							<ThinkingSlider
								// 与旧菜单内的滑块保持同一 testid 契约（thinking-*），选用 / 档位 e2e 不因两层改造失效
								testid="thinking"
								levels={thinking.levels}
								current={thinking.current}
								effective={thinking.effective}
								followLabel={thinking.followLabel}
								modelName={value ? (models.find((m) => pickKey(m) === pickKey(value))?.name ?? value.id) : undefined}
								onModelClick={() => applyPanel("openList")}
								// 返回 / 选完模型后回模型名；键盘打开时也直接落在这里（鼠标打开不抢焦点）
								autoFocusModel={focusModel || openedByKeyboard.current}
								loading={loading}
								error={error}
								onRetry={onRetry}
								fast={fast}
								onPick={(l) => { thinking.onPick(l); applyPanel("close"); }}
							/>
						</div>
					) : (
						list
					),
					document.body,
				)}
		</div>
	);
}

// ------------------------------------------------------------------ 候选池：多选（勾选后不关菜单）
function PoolOption({ m, checked, id, onToggle }: { m: ModelEntry; checked: boolean; id: string; onToggle: (m: ModelEntry, checked: boolean) => void }) {
	return (
		<label className={cx("flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", checked && "bg-hover")} data-testid={`${id}-option`} data-model={pickKey(m)}>
			<input type="checkbox" className="mt-1 shrink-0 accent-[var(--acc)]" checked={checked} onChange={(e) => onToggle(m, e.target.checked)} data-testid={`${id}-check`} />
			<span className="min-w-0 flex-1">
				<span className="block truncate">
					{m.star ? "★ " : ""}
					{m.name}
				</span>
				{(m.badge || m.note) && (
					<span className="block truncate text-[11px] text-mut">
						{m.badge ? `${m.badge} · ` : ""}
						{m.note ?? ""}
					</span>
				)}
			</span>
			{m.reasoning && <Brain size={12} className="mt-1 shrink-0 text-mut" aria-label="支持推理" />}
		</label>
	);
}

export interface ModelPoolMenuProps {
	id: string;
	models: ModelEntry[];
	providers: Provider[];
	value: { provider: string; id: string }[];
	picks?: ModelPicks;
	onToggle: (m: ModelEntry, checked: boolean) => void;
	/** 弹层定位由 ModelPoolButton 的 usePopover 提供（portal 到 body + fixed 锚定触发器） */
	panelRef?: RefObject<HTMLDivElement | null>;
	panelStyle?: CSSProperties;
}

/** 候选池多选菜单：搜索 + 常用 + 按服务分组，勾选不关菜单（复用 ModelMenu 的分组/搜索/常用规则）。 */
export function ModelPoolMenu({ id, models, providers, value, picks, onToggle, panelRef, panelStyle }: ModelPoolMenuProps) {
	const [q, setQ] = useState("");
	const [openGroups, setOpenGroups] = useState<string[]>(() => (models[0] ? [models[0].provider] : []));
	const nameOf = (p: string) => providers.find((x) => x.id === p)?.name ?? models.find((m) => m.provider === p)?.providerName ?? p;
	const selKeys = new Set(value.map(pickKey));
	const shown = searchModels(models, q, nameOf);
	// 同 ModelMenu：常用只是快捷入口，候选池里选过的模型也要留在原服务分组
	const frequent = frequentModels(models, picks, q, 5);
	const groups = groupModelsByProvider(shown, nameOf);
	const isOpen = (p: string) => !!q.trim() || openGroups.includes(p);
	return (
		<div ref={panelRef} style={{ ...panelStyle, ...modelMenuSize }} className="pa-pop flex flex-col rounded-xl border border-line bg-card p-1.5 shadow-lg" data-testid={`${id}-menu`}>
			<label className="mb-1 flex items-center gap-2 rounded-lg bg-hover px-2.5 py-1.5">
				<Search size={14} className="text-mut" />
				<input autoFocus className="min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="搜索模型或服务…" value={q} onChange={(e) => setQ(e.target.value)} data-testid={`${id}-search`} />
			</label>
			<div className="px-2.5 pb-1 text-[11px] text-mut2">{value.length ? `已选 ${value.length} 个；派活时在池内按任务挑，失败只在池内换` : "一个都不选 = 跟随主会话当前模型"}</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{!models.length && <div className="p-3 text-sm text-mut">还没有配置模型服务：在 设置 › 模型 里添加</div>}
				{!!models.length && !shown.length && <div className="p-3 text-sm text-mut">没有匹配的模型</div>}
				{frequent.length > 0 && (
					<div className="py-1" data-testid={`${id}-frequent`}>
						<div className="px-2.5 pb-0.5 text-[11px] font-semibold tracking-wide text-mut uppercase">常用</div>
						{frequent.map((m) => (
							<PoolOption key={pickKey(m)} m={m} checked={selKeys.has(pickKey(m))} id={id} onToggle={onToggle} />
						))}
					</div>
				)}
				{groups.map((g) => (
					<div key={g.provider} className="py-1">
						<button className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1 text-left" onClick={() => setOpenGroups((l) => (l.includes(g.provider) ? l.filter((x) => x !== g.provider) : [...l, g.provider]))} aria-expanded={isOpen(g.provider)} data-testid={`${id}-group-${g.provider}`}>
							<ChevronDown size={12} className={cx("shrink-0 text-mut transition-transform", !isOpen(g.provider) && "-rotate-90")} />
							<span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-mut uppercase">{g.name}</span>
							<span className="shrink-0 text-[11px] text-mut2">{g.models.filter((m) => selKeys.has(pickKey(m))).length || g.models.length}</span>
						</button>
						{isOpen(g.provider) && g.models.map((m) => <PoolOption key={pickKey(m)} m={m} checked={selKeys.has(pickKey(m))} id={id} onToggle={onToggle} />)}
					</div>
				))}
			</div>
		</div>
	);
}

export interface ModelPoolButtonProps {
	testid: string;
	id?: string;
	models: ModelEntry[];
	providers: Provider[];
	value: { provider: string; id: string }[];
	picks?: ModelPicks;
	onToggle: (m: ModelEntry, checked: boolean) => void;
	text: string;
	title?: string;
	ariaLabel?: string;
	buttonClass?: string;
	placement?: "up" | "down";
	onOpen?: () => void;
}

/** 共用的「候选池按钮 + 多选菜单」：勾选后菜单不关，方便一次选好几个。 */
export function ModelPoolButton({ testid, id = testid, models, providers, value, picks, onToggle, text, title, ariaLabel, buttonClass, placement, onOpen }: ModelPoolButtonProps) {
	const { open, setOpen, ref, menuRef, style } = usePopover(placement ?? "down");
	return (
		<div className="relative min-w-0" ref={ref}>
			<button className={cx("pa-chip sm !shrink min-w-0", buttonClass)} onClick={() => { if (!open) onOpen?.(); setOpen(!open); }} title={title} aria-label={ariaLabel} data-testid={testid}>
				<Cpu className="pa-ic" />
				<span className="truncate">{text}</span>
				<ChevronDown size={12} />
			</button>
			{open && createPortal(<ModelPoolMenu id={id} models={models} providers={providers} value={value} picks={picks} onToggle={onToggle} panelRef={menuRef} panelStyle={style} />, document.body)}
		</div>
	);
}

// ------------------------------------------------------------------ 单聊输入栏：一个按钮同时管模型和思考强度
export function ModelPicker({ agentId, hideTextInNarrow = true, buttonClass, allowThinkingFollow = false, layout = "compact" }: { agentId: string; hideTextInNarrow?: boolean; buttonClass?: string; allowThinkingFollow?: boolean; layout?: "compact" | "settings" }) {
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const d = useConfiguredModels();
	const { picks, record } = useModelPicks();
	// Fast 的保存态（乐观 / 失败回滚）；放在 early return 之前，保证 hook 顺序稳定
	const [fastPending, setFastPending] = useState(false);
	const [fastError, setFastError] = useState("");
	const [modelPending, setModelPending] = useState(false);
	const [modelError, setModelError] = useState("");
	const modelScope = useRef(0);
	// 组件本地的退化守卫：切到别的助理（或卸载）后，上一个助理的迟到失败 / 保存中不能落在新助理的界面上；
	// 只清自己这个入口的状态，不动全局写入顺序（那是 patchAgentFast 里按助理一份的 LatestWrite）
	const scope = useRef(0);
	useEffect(() => {
		scope.current += 1;
		setFastPending(false);
		setFastError("");
		modelScope.current += 1;
		setModelPending(false);
		setModelError("");
		return () => { scope.current += 1; modelScope.current += 1; };
	}, [agentId]);
	const saveModel = (body: Record<string, unknown>, picked?: ModelEntry) => {
		const gen = ++modelScope.current;
		setModelError("");
		setModelPending(true);
		void patchAgent(agentId, body).then(() => { if (picked) record(picked); }).catch((e) => {
			if (modelScope.current === gen) setModelError(`保存失败，请重试：${e instanceof Error ? e.message : "连接失败"}`);
		}).finally(() => { if (modelScope.current === gen) setModelPending(false); });
	};
	if (!agent) return null;
	const cur = agent.model;
	const entry = d?.models.find((m) => m.provider === cur?.provider && m.id === cur?.id);
	const levels = entry?.thinking ?? [];
	const curThinking = agent.thinking && levels.includes(agent.thinking) ? agent.thinking : levels[0];
	const reasoning = levels.length > 1;
	const text = `${entry?.name ?? cur?.id ?? "选择模型"}${reasoning ? ` · ${THINKING_LABEL[curThinking] ?? curThinking}` : ""}`;
	// 请求级 Fast：按这个助理的开关 + 当前实际模型的协议能力；保存中禁重复、失败回滚并给原因
	const fastCap = entry?.fast ?? { capability: "unsupported" as const, reason: "当前接口暂未接入 Fast" };
	const fast: FastControl = {
		on: agent.fast === true,
		capability: fastCap.capability,
		reason: fastCap.reason,
		loading: d.loading,
		unavailable: d.error ? "模型目录没加载出来，请重试" : undefined,
		pending: fastPending,
		error: fastError || undefined,
		onToggle: () => {
			if (fastPending) return;
			const s = ++scope.current;
			setFastError("");
			setFastPending(true);
			void patchAgentFast(agentId, !(agent.fast === true))
				.catch(() => { if (scope.current === s) setFastError("保存失败，已恢复原状态"); })
				.finally(() => { if (scope.current === s) setFastPending(false); });
		},
	};
	const thinking: ThinkingChoice = { levels, current: allowThinkingFollow ? agent.thinkingSetting ?? null : curThinking ?? "", effective: curThinking, followLabel: allowThinkingFollow ? "跟随默认" : undefined, onPick: (l) => saveModel({ thinking: l }) };
	return (
		<div className="min-w-0 space-y-2" data-testid="agent-model-settings" aria-busy={modelPending || undefined}>
		{layout === "settings" && <div className="text-xs text-mut">主模型</div>}
		<ModelPickerButton
			testid="model-picker"
			id="model"
			models={d?.models ?? []}
			providers={d?.providers ?? []}
			value={cur ?? null}
			thinking={layout === "settings" ? undefined : thinking}
			fast={layout === "settings" ? undefined : fast}
			compact={layout === "compact"}
			picks={picks}
			onPick={(m) => saveModel({ model: { provider: m.provider, id: m.id } }, m)}
			text={layout === "settings" ? entry?.name ?? cur?.id ?? "选择模型" : text}
			hideTextInNarrow={layout === "compact" && hideTextInNarrow}
			loading={d.loading}
			error={d.error}
			onRetry={d.reload}
			onOpen={d.reload}
			buttonClass={buttonClass ?? "max-w-[220px] max-sm:max-w-[120px]"}
			disabled={modelPending}
			title={layout === "settings" ? "选择这个助理用的主模型" : "选择这个助理用的模型和思考强度"}
			ariaLabel={`模型：${entry?.name ?? cur?.id ?? "未选择"}${layout === "compact" && reasoning ? `，思考强度 ${THINKING_LABEL[curThinking] ?? curThinking}` : ""}`}
		/>
		{layout === "settings" && <>
			<div className="flex flex-wrap items-center justify-between gap-2 pt-2">
				<span className="text-sm text-mut">思考强度</span>
				<ThinkingButton testid="agent-thinking" {...thinking} disabled={modelPending} modelName={entry?.name ?? cur?.id} buttonClass="max-w-full" loading={d.loading} error={d.error} onRetry={d.reload} text={!levels.length && d.loading ? "正在加载…" : !levels.length && d.error ? "加载失败" : !entry ? "待选择模型" : !levels.length ? "不可调" : thinking.current === null ? `跟随默认${curThinking ? ` · ${THINKING_LABEL[curThinking] ?? curThinking}` : ""}` : thinking.current !== curThinking && curThinking ? `${THINKING_LABEL[thinking.current] ?? thinking.current} → ${THINKING_LABEL[curThinking] ?? curThinking}` : THINKING_LABEL[curThinking] ?? curThinking ?? "待选择模型"} />
			</div>
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0 text-sm text-mut">Fast 快速模式<span className="ml-2 text-xs text-mut2">{d.loading ? "加载中" : d.error ? "暂不可用，请重试" : fastCap.capability === "unsupported" ? "暂不可用" : fast.on ? "已开启" : "已关闭"}</span></div>
				<FastButton testid="agent-model" fast={fast} />
			</div>
			{fastError && <p className="text-xs text-red-600 dark:text-red-400" role="alert">{fastError}</p>}
		</>}
		{modelPending && <span className="block text-xs text-mut" role="status">保存中…</span>}
		{modelError && <p className="mt-1 max-w-[340px] whitespace-normal break-words text-xs text-red-600 dark:text-red-400" role="alert" data-testid="model-save-error">{modelError}</p>}
		</div>
	);
}
