/**
 * 思考强度「离散滑块」的纯逻辑：档位视图、收敛、键盘 / 指针映射、星点能量布局。
 *
 * 为什么单独一个模块、不写在组件里：滑块的行为（哪些档、到哪一档、键盘进了几档、
 * 拖动到哪一格、跟随 / 不支持的显示）是纯函数，界面只是渲染；放在一起才能用 node:test
 * 直接跑七档 / 子集 / 并集 / 跟随 / 降级等分支，不依赖浏览器与真实模型。
 *
 * 语义事实来源仍是 Pi SDK（`ModelThinkingLevel`）与 shared 的 `THINKING_LEVEL_ORDER` /
 * `thinkingLevelsUnion`：这里**不发明档位**，也不改服务端 clamp；`fitThinkingLevel` 只是把
 * 服务端 clampThinkingLevel 的「取不超过目标的最高支持档，否则最低支持档」在界面复述一遍，
 * 用于显示「实际会运行的档位」，绝不代替服务端收敛。
 */
import { THINKING_LEVEL_ORDER, type ThinkingLevel } from "@pi-assistant/shared";

/** 档位中文名（与原来的下拉列表一致；界面 / 测试 / 服务端说明共用一套文案）。 */
export const THINKING_LABEL: Record<string, string> = { off: "关闭", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大" };

/** 档位的一句话说明（只用于 title / 帮助，不写「最快 / 更贵」这类绝对说法）。 */
export const THINKING_DESC: Record<string, string> = { off: "不思考，回答最快", minimal: "几乎不思考", low: "简单推理", medium: "平衡（默认）", high: "深入推理，更慢更贵", xhigh: "非常深入", max: "最大推理预算" };

/** 每档的星点数量：密度随档位递进，off 完全静态（0 点）。 */
export const THINKING_STAR_COUNT: Record<string, number> = { off: 0, minimal: 1, low: 3, medium: 5, high: 8, xhigh: 12, max: 16 };

/** 切换 / 拖动时的「一次」预览时长（毫秒）；off 不播放。与设计稿一致：320–700ms。 */
export const THINKING_PREVIEW_MS: Record<string, number> = { off: 0, minimal: 320, low: 400, medium: 480, high: 560, xhigh: 620, max: 700 };

/** 只保留 Pi 合法档位，并按 Pi 顺序去重排序（界面顺序的唯一口径）。 */
export function orderedThinkingLevels(levels: readonly string[] | null | undefined): string[] {
	const set = new Set(levels ?? []);
	return THINKING_LEVEL_ORDER.filter((l) => set.has(l));
}

/**
 * 合法降级：取不超过 `wanted` 的最高支持档；都不超过时取最低支持档。
 * 与服务端 `clampThinkingLevel` 同语义（空集合返回 null）。`wanted` 为空（跟随但还读不到
 * 实际档位）时按最低支持档显示，不猜更高。
 */
export function fitThinkingLevel(levels: readonly string[], wanted: string | null | undefined): string | null {
	const list = orderedThinkingLevels(levels);
	if (!list.length) return null;
	const wi = wanted == null ? -1 : THINKING_LEVEL_ORDER.indexOf(wanted as ThinkingLevel);
	if (wi < 0) return list[0];
	let best: string | null = null;
	for (const l of list) if (THINKING_LEVEL_ORDER.indexOf(l as ThinkingLevel) <= wi) best = l;
	return best ?? list[0];
}

export interface ThinkingSliderView {
	/** unsupported：这个模型没有可调档位；fixed：只有一档；slider：真实的离散滑块 */
	kind: "unsupported" | "fixed" | "slider";
	/** 已按 Pi 顺序整理的可见档位 */
	levels: string[];
	/** 当前应显示的档位下标（slider 时有效） */
	index: number;
	/** 当前应显示的档位（unsupported 时为 null） */
	level: string | null;
	/** 是否处于「跟随 X」（current === null 且给了 followLabel） */
	following: boolean;
	/** 用户显式保存过、但当前支持集合里没有的档位（需要规范化提示） */
	unsupportedPick: string | null;
	/** 实际会运行的档位（跟随或降级后）；unsupported 时为 null */
	effective: string | null;
}

/**
 * 由「支持档位 + 当前值 + 是否有跟随」推出弹层要显示什么。
 * - `current === null` 且给了 `followLabel`：跟随；显示 `effective`（实际生效）或最低支持档。
 * - 显式 `current` 不在支持集合里：不静默假装保留，`unsupportedPick` 记下原值，
 *   滑块选中降级后的档位，由弹层给出「按降级后的档运行」说明。
 */
export function thinkingSliderView(input: { levels: readonly string[]; current: string | null; followLabel?: string; effective?: string | null }): ThinkingSliderView {
	const levels = orderedThinkingLevels(input.levels);
	const following = input.current === null && !!input.followLabel;
	if (!levels.length) return { kind: "unsupported", levels: [], index: 0, level: null, following, unsupportedPick: null, effective: null };
	if (levels.length === 1) return { kind: "fixed", levels, index: 0, level: levels[0], following, unsupportedPick: null, effective: levels[0] };
	const wanted = following ? (input.effective ?? null) : input.current;
	const effective = fitThinkingLevel(levels, wanted);
	const unsupportedPick = !following && input.current != null && !levels.includes(input.current) ? input.current : null;
	const index = Math.max(0, levels.indexOf(effective ?? levels[0]));
	return { kind: "slider", levels, index, level: levels[index], following, unsupportedPick, effective: levels[index] };
}

/** 键盘把当前下标移到哪一档；返回 null 表示这个键不归滑块管（交回给页面 / 弹层）。 */
export function sliderIndexForKey(key: string, index: number, count: number): number | null {
	if (count <= 0) return null;
	const last = count - 1;
	switch (key) {
		case "ArrowRight":
		case "ArrowUp":
			return Math.min(last, index + 1);
		case "ArrowLeft":
		case "ArrowDown":
			return Math.max(0, index - 1);
		case "Home":
		case "PageDown":
			return 0;
		case "End":
		case "PageUp":
			return last;
		default:
			return null;
	}
}

/** 指针 X（视口坐标）落在轨道哪一格；轨道外自动收到两端，不产生越界档位。 */
export function sliderIndexFromX(clientX: number, left: number, width: number, count: number): number {
	if (count <= 1) return 0;
	const t = width <= 0 ? 0 : (clientX - left) / width;
	return Math.max(0, Math.min(count - 1, Math.round(t * (count - 1))));
}

/**
 * 用户确选的档位是否应当提交（写库）。
 * - 拖到/选到与当前生效值相同：不写、不关弹层（避免无意义写入）；
 * - 跟随态下选任一档（哪怕数值等于当前生效值）：是真正的变化（从跟随变显式），要提交；
 * - 待规范化（显式值不被支持）时选到降级目标：也当作显式选择提交。
 * 这是「保存失败不留假值」的前半：组件只把用户确选值交给调用方，本地不自作持久化。
 */
export function shouldCommitThinking(next: string | null, view: { level: string | null; following: boolean; unsupportedPick: string | null }): boolean {
	if (next == null) return !view.following;
	if (view.following || view.unsupportedPick) return true;
	return next !== view.level;
}

export interface ThinkingStar {
	/** 相对手柄中心的像素偏移 */
	x: number;
	y: number;
	size: number;
	opacity: number;
	far: boolean;
	line: boolean;
	/** 预览动画里这颗星的延迟（毫秒） */
	delay: number;
	dx: number;
	dy: number;
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function hashString(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * 某一档的星点布局：数量由密度决定，位置用「档位 + 种子」确定性生成，
 * 同一档每次渲染完全一致（不随机跳、不依赖时钟），off 返回空数组。
 */
export function thinkingStars(level: string, seed: string): ThinkingStar[] {
	const n = THINKING_STAR_COUNT[level] ?? 0;
	if (!n) return [];
	const rnd = mulberry32(hashString(`${level}#${seed}`));
	const out: ThinkingStar[] = [];
	for (let i = 0; i < n; i++) {
		const t = (i + 0.5) / n;
		const ang = i * 2.3999632 + rnd() * 0.5;
		const rad = 13 * Math.sqrt(t) + rnd() * 2.5;
		const size = 1.5 + (n > 10 ? 0.5 : 1.1) * (1 - t) + rnd() * 0.5;
		const opacity = Math.max(0.3, Math.min(1, 0.6 + 0.4 * (1 - t) - rnd() * 0.15));
		out.push({
			x: Number((Math.cos(ang) * rad).toFixed(1)),
			y: Number((Math.sin(ang) * rad).toFixed(1)),
			size: Number(size.toFixed(2)),
			opacity: Number(opacity.toFixed(2)),
			far: i % 3 === 0,
			line: i % 5 === 3,
			delay: Math.round((i * 60) / n),
			dx: Number(((rnd() * 2 - 1) * (1 + t * 2)).toFixed(2)),
			dy: Number(((rnd() * 2 - 1) * (1 + t * 2)).toFixed(2)),
		});
	}
	return out;
}
