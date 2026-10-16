/**
 * 思考强度「离散滑块」的公共渲染件：主会话 / 群聊 / 子代理 / 设置里同一个组件。
 *
 * 组件只负责「怎么显示、怎么把用户确选的档位交出去」；档位从哪来（`getSupportedThinkingLevels` /
 * `thinkingLevelsUnion`）、怎么落库（助理的 thinking、子代理覆盖 thinking|null、助理级 follow|fixed）
 * 都留在原来的调用方，**不新增状态**。语义事实见 `../thinking-slider.ts` 的纯函数。
 *
 * 关键交互（与设计稿一致）：
 * - 拖动中只更新手柄预览，`pointerup` 才提交；`pointercancel` / 窗口失焦 / Esc 关闭不提交半途预览。
 * - 键盘 Arrow / Home / End / PageUp / PageDown 逐次提交，`role="slider"` + `aria-valuetext`。
 * - 「跟随 X」是滑块外的 reset 动作（不是第 8 档）；0 档 / 1 档显示说明，不画滑块。
 * - 预览动效只播一次（320–700ms），播完即停；组件卸载清理计时器，最小化动态效果时完全不播。
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { THINKING_DESC, THINKING_LABEL, THINKING_PREVIEW_MS, THINKING_SLIDER_SHORT, shouldCommitThinking, sliderIndexForKey, sliderIndexFromX, thinkingSliderView, thinkingStars } from "../thinking-slider";
import { watchMoStyle } from "../themes/motion-signals";
import { cx } from "./ui";

/** 最小化动态效果：组件内是否播预览动画（CSS 也有一份，这里用来提前跳过计时器）。 */
function useReducedMotion(): boolean {
	const [reduced, setReduced] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
	useEffect(() => {
		const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
		if (!mq) return;
		const h = () => setReduced(mq.matches);
		mq.addEventListener("change", h);
		return () => mq.removeEventListener("change", h);
	}, []);
	return reduced;
}

/**
 * 跟随主题声明的 `--mo-style`：挂载先读一次，之后主题 / DIY 预览真的改了变量再回读一次。
 * 订阅只在组件挂载（弹层可见）期间存在，卸载 / 关闭即断开；值没变不重渲染。
 * reduce 开关变化时同一套订阅重挂并回读（不另起一套监听），保证 reduce 分支下的 token 立即生效。
 */
function useMoStyle(ref: RefObject<HTMLElement | null>, reduceVersion: boolean): string | null {
	const [moStyle, setMoStyle] = useState<string | null>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		return watchMoStyle(el, setMoStyle);
	}, [ref, reduceVersion]);
	return moStyle;
}

export interface ThinkingSliderProps {
	/** testid 前缀：每个刻度按钮是 `${testid}-${level}`，跟随按钮是 `${testid}-follow`（保持原 e2e 契约） */
	testid: string;
	levels: string[];
	current: string | null;
	/** 跟随 / 降级时实际生效的档位（子代理传 resolvedThinking；不传则按最低支持档显示） */
	effective?: string | null;
	followLabel?: string;
	onPick: (level: string | null) => void;
	/** 弹层右上角显示的短模型名（可选） */
	modelName?: string;
	/** 是否渲染「思考强度 / 当前档位」标题行（嵌在模型菜单里时由外层已有标题，传 false） */
	showHead?: boolean;
	/** 键盘打开（Enter/Space）时把焦点落到手柄 */
	autoFocus?: boolean;
}

export function ThinkingSlider({ testid, levels, current, effective, followLabel, onPick, modelName, showHead = true, autoFocus = false }: ThinkingSliderProps) {
	const view = thinkingSliderView({ levels, current, followLabel, effective });
	const reduced = useReducedMotion();
	const [idx, setIdx] = useState(view.index);
	const [pulse, setPulse] = useState<{ level: string; key: number } | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	// `--mo-style` 是主题声明的字符串（smooth / steps），不能直接当 animation-timing-function。
	// 这里把主题定义里的值安全映射成真实 data 属性，CSS 再按属性走 steps 分支（不读硬编码调色板、不写 JS 颜色）。
	const moStyle = useMoStyle(rootRef, reduced);
	const handleRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);
	const idxRef = useRef(idx);
	idxRef.current = idx;
	const timer = useRef<number | null>(null);
	const seq = useRef(0);

	// 外部（保存成功 / 换模型 / 切换跟随）改变了生效档位：同步回手柄位置
	const levelsKey = view.levels.join("|");
	useEffect(() => {
		setIdx(view.index);
	}, [view.index, levelsKey]);

	useLayoutEffect(() => {
		if (autoFocus && view.kind === "slider") handleRef.current?.focus();
	}, [autoFocus, view.kind]);

	const firePulse = useCallback(
		(level: string) => {
			if (reduced || !(THINKING_PREVIEW_MS[level] > 0)) return;
			seq.current += 1;
			setPulse({ level, key: seq.current });
		},
		[reduced],
	);

	// 预览只在切换时播一次；到点清除并释放计时器（组件卸载也会清理，不留后台 rAF / timer）
	useEffect(() => {
		if (!pulse) return;
		const ms = (THINKING_PREVIEW_MS[pulse.level] ?? 0) + 120;
		timer.current = window.setTimeout(() => {
			setPulse(null);
			timer.current = null;
		}, ms);
		return () => {
			if (timer.current) {
				window.clearTimeout(timer.current);
				timer.current = null;
			}
		};
	}, [pulse]);

	const label = (l: string | null) => (l ? (THINKING_LABEL[l] ?? l) : "—");
	const count = view.levels.length;

	const commit = useCallback(
		(i: number, force = false) => {
			if (view.kind !== "slider" || !count) return;
			const clamped = Math.max(0, Math.min(count - 1, i));
			const next = view.levels[clamped];
			if (!force && !shouldCommitThinking(next, view)) return; // 值和已生效的一致：不写、不关弹层
			setIdx(clamped);
			firePulse(next);
			onPick(next);
		},
		[count, firePulse, onPick, view.kind, view.level, view.levels, view.following, view.unsupportedPick],
	);

	const cancelDrag = useCallback(() => {
		if (!dragging.current) return;
		dragging.current = false;
		setIdx(view.index); // 丢掉半途预览，不提交
	}, [view.index]);

	useEffect(() => {
		if (view.kind !== "slider") return;
		const blur = () => cancelDrag();
		window.addEventListener("blur", blur);
		return () => window.removeEventListener("blur", blur);
	}, [cancelDrag, view.kind]);

	const startDrag = (clientX: number) => {
		const r = innerRef.current?.getBoundingClientRect();
		if (!r) return;
		dragging.current = true;
		const i = sliderIndexFromX(clientX, r.left, r.width, count);
		if (i !== idxRef.current) {
			setIdx(i);
			firePulse(view.levels[i]);
		}
	};
	const moveDrag = (clientX: number) => {
		if (!dragging.current) return;
		const r = innerRef.current?.getBoundingClientRect();
		if (!r) return;
		const i = sliderIndexFromX(clientX, r.left, r.width, count);
		if (i !== idxRef.current) {
			setIdx(i);
			firePulse(view.levels[i]);
		}
	};
	const endDrag = (clientX: number | null, cancelled: boolean) => {
		if (!dragging.current) return;
		dragging.current = false;
		if (cancelled || clientX == null) {
			setIdx(view.index);
			return;
		}
		const r = innerRef.current?.getBoundingClientRect();
		if (!r) return;
		commit(sliderIndexFromX(clientX, r.left, r.width, count));
	};

	const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		const next = sliderIndexForKey(e.key, idxRef.current, count);
		if (next == null) return;
		e.preventDefault();
		e.stopPropagation();
		commit(next);
	};

	if (view.kind === "unsupported") {
		return (
			<div className="pa-think" ref={rootRef} data-pa-mo-style={moStyle ?? undefined} data-testid={`${testid}-body`}>
				{showHead && <Head title="思考强度" current="不支持" modelName={modelName} />}
				{followLabel && <FollowRow testid={testid} label={followLabel} following={view.following} effective={view.effective} onPick={onPick} />}
				<p className="pa-think-empty" data-testid={`${testid}-unsupported`}>
					<b>{modelName ?? "这个模型"}</b> 不支持调整思考强度。
				</p>
				<p className="pa-think-note">这里不显示滑块，避免让用户以为能调。</p>
			</div>
		);
	}

	if (view.kind === "fixed") {
		return (
			<div className="pa-think" ref={rootRef} data-pa-mo-style={moStyle ?? undefined} data-testid={`${testid}-body`}>
				{showHead && <Head title="思考强度" current={label(view.level)} modelName={modelName} />}
				{followLabel && <FollowRow testid={testid} label={followLabel} following={view.following} effective={view.effective} onPick={onPick} />}
				<p className="pa-think-empty" data-testid={`${testid}-fixed`}>
					这个模型只有一档 <b>{label(view.level)}</b>，不需要调整。
				</p>
			</div>
		);
	}

	const level = view.levels[idx];
	const pos = count > 1 ? idx / (count - 1) : 0;
	const stars = thinkingStars(level, testid);
	const curText = view.following ? `跟随·${label(view.effective)}` : view.unsupportedPick ? `${label(view.unsupportedPick)} → ${label(view.level)}` : label(level);

	return (
		<div className="pa-think" ref={rootRef} data-pa-mo-style={moStyle ?? undefined} data-testid={`${testid}-body`}>
			{showHead && <Head title="思考强度" current={curText} modelName={modelName} />}
			{followLabel && <FollowRow testid={testid} label={followLabel} following={view.following} effective={view.effective} onPick={onPick} />}

			{view.unsupportedPick && (
				<p className="pa-think-norm" role="note">
					换模型后，<b>{label(view.unsupportedPick)}</b> 不在当前模型支持的档位里；运行时按 <b>{label(view.effective)}</b> 收敛（合法降级，不静默假装保留）。
					<button type="button" className="pa-think-mini" aria-label={`按${label(view.effective)}运行`} onClick={() => commit(count ? view.levels.indexOf(view.effective ?? "") : 0, true)}>
						按「{label(view.effective)}」运行
					</button>
				</p>
			)}

			<div className="pa-think-track" onPointerDown={(e: ReactPointerEvent) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); startDrag(e.clientX); }} onPointerMove={(e: ReactPointerEvent) => moveDrag(e.clientX)} onPointerUp={(e: ReactPointerEvent) => { endDrag(e.clientX, false); (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); }} onPointerCancel={(e: ReactPointerEvent) => { endDrag(null, true); (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); }}>
				<div ref={innerRef} className="pa-think-track-inner" style={{ "--pa-think-pos": pos, "--pa-think-n": count - 1 } as CSSProperties}>
					<div className="pa-think-rail" />
					<div className="pa-think-fill" />
					{view.levels.map((l, i) => (
						<Fragment key={l}>
							<button type="button" className="pa-think-step" tabIndex={-1} data-testid={`${testid}-${l}`} aria-label={label(l)} title={`${label(l)}${THINKING_DESC[l] ? ` · ${THINKING_DESC[l]}` : ""}`} style={{ "--pa-think-i": i, "--pa-think-n": count - 1 } as CSSProperties} />
							<i className={cx("pa-think-tick", i === idx && "on")} style={{ "--pa-think-i": i, "--pa-think-n": count - 1 } as CSSProperties} aria-hidden="true" />
						</Fragment>
					))}
					<div ref={handleRef} className={cx("pa-think-handle", view.following && "following")} role="slider" tabIndex={0} aria-label="思考强度" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={count - 1} aria-valuenow={idx} aria-valuetext={`思考强度：${label(level)}`} style={{ "--pa-think-pos": pos } as CSSProperties} onKeyDown={onKeyDown}>
						<span key={pulse?.key ?? 0} className={cx("pa-think-energy", pulse && `pa-think-pulse pa-think-a-${pulse.level}`)} style={{ "--pa-think-dur": THINKING_PREVIEW_MS[level] ?? 0 } as CSSProperties} aria-hidden="true">
							{stars.map((s, i) => (
								<i key={i} className={cx("pa-think-star", s.far && "far")} data-ln={s.line ? "1" : undefined} style={{ "--x": s.x, "--y": s.y, "--s": s.size, "--o": s.opacity, "--dx": s.dx, "--dy": s.dy, "--d": s.delay } as CSSProperties} />
							))}
						</span>
						<span className="pa-think-handle-label">{THINKING_SLIDER_SHORT[level] ?? label(level)}</span>
					</div>
				</div>
			</div>
			<div className="pa-think-labels" style={{ "--pa-think-n": count - 1 } as CSSProperties} aria-hidden="true">
				{view.levels.map((l, i) => (
					<span key={l} className={cx(i === idx && "on")} style={{ "--pa-think-i": i, "--pa-think-n": count - 1 } as CSSProperties}>
						{label(l)}
					</span>
				))}
			</div>
			<p className="pa-think-note">这个模型支持 {count} 档（Pi 的 7 档里的子集）。较高强度通常更慢，并可能增加用量；具体取决于模型。</p>
		</div>
	);
}

function Head({ title, current, modelName }: { title: string; current: string; modelName?: string }) {
	return (
		<div className="pa-think-head">
			<span className="pa-think-title">{title}</span>
			<span className="pa-think-sub">
				<b className="pa-think-cur">{current}</b>
				{modelName ? ` · ${modelName}` : ""}
			</span>
		</div>
	);
}

function FollowRow({ testid, label, following, effective, onPick }: { testid: string; label: string; following: boolean; effective: string | null; onPick: (level: string | null) => void }) {
	return (
		<button type="button" className={cx("pa-think-follow", following && "on")} aria-pressed={following} data-testid={`${testid}-follow`} onClick={() => { if (!following) onPick(null); }}>
			<span className="pa-think-follow-label">{following ? "✓ " : ""}{label}</span>
			<span className="pa-think-follow-badge">当前实际：{effective ? (THINKING_LABEL[effective] ?? effective) : "—"}</span>
		</button>
	);
}
