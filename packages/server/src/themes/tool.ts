/**
 * `theme_draft` —— 主题设计专用会话里**唯一**的业务工具。
 *
 * 它只做一件事：把模型产出的 manifest 交给 shared 的 fail-closed 校验器，校验通过就收下，
 * 不通过就把可读错误回给模型（最多允许一次格式修复，再失败就结束本轮，不无限重试 / 不额外付费）。
 *
 * 安全边界：
 *  - 工具参数里**不接受图片**：图片引用由服务端按用户上传的附件 id 规范化后强制写入，模型改不了。
 *  - 不使用任何正则 / 字符串执行模型产出的 CSS；一切以 shared 校验器为准。
 *  - 校验失败时**不产出任何主题**（保持当前主题不变），只返回错误列表。
 */
import { Type } from "typebox";
import {
	DECOR_BACKGROUNDS,
	DECOR_CORNERS,
	DECOR_SHADOWS,
	DECOR_TEXTURES,
	MOTION_DURATION_MAX_MS,
	MOTION_DURATION_MIN_MS,
	MOTION_EASE_NAMES,
	MOTION_GLOW_LEVELS,
	MOTION_SCALE_MAX,
	MOTION_SCALE_MIN,
	MOTION_STYLES,
	OPTIONAL_COLOR_TOKENS,
	OPTIONAL_FONT_TOKENS,
	OPTIONAL_SIZE_TOKENS,
	REQUIRED_COLOR_TOKENS,
	THEME_MANIFEST_VERSION,
	validateThemeManifest,
	type ThemeError,
	type ThemeImageRef,
	type ThemeManifestV1,
} from "@pi-assistant/shared";
import { defineTool, type ToolDefinition } from "../pi-adapter/index.ts";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });
const enumOf = (values: readonly string[]) => Type.Union(values.map((v) => Type.Literal(v)) as [never, ...never[]]);
const TOKEN_MAP = Type.Record(Type.String(), Type.String(), {
	description: `CSS 变量表。必需颜色 token（浅 / 深两套都要齐全）：${REQUIRED_COLOR_TOKENS.join(" ")}。可选：${[...OPTIONAL_COLOR_TOKENS, ...OPTIONAL_SIZE_TOKENS, ...OPTIONAL_FONT_TOKENS].join(" ")}`,
});

const MANIFEST_PARAM = Type.Object({
	manifestVersion: Type.Literal(THEME_MANIFEST_VERSION),
	name: Type.String({ description: "主题名（≤24 字，中文短名）" }),
	author: Type.Optional(Type.String({ description: "作者（一般填“AI 生成”）" })),
	basedOn: Type.Optional(Type.String({ description: "参考的内置主题 id：glass / warm / pixel / noir（仅作来源标注）" })),
	modes: Type.Object({
		light: TOKEN_MAP,
		dark: TOKEN_MAP,
	}),
	decor: Type.Optional(
		Type.Object({
			texture: Type.Optional(enumOf(DECOR_TEXTURES)),
			corner: Type.Optional(enumOf(DECOR_CORNERS)),
			shadow: Type.Optional(enumOf(DECOR_SHADOWS)),
			background: Type.Optional(enumOf(DECOR_BACKGROUNDS)),
		}),
	),
	motion: Type.Optional(
		Type.Object({
			durationFast: Type.Optional(Type.String({ description: `即时反馈时长（${MOTION_DURATION_MIN_MS}..${MOTION_DURATION_MAX_MS}ms，如 .12s / 120ms）` })),
			duration: Type.Optional(Type.String({ description: "常规状态切换时长（同上范围，如 .18s）" })),
			durationSlow: Type.Optional(Type.String({ description: "折叠 / 展开时长（同上范围，如 .26s）" })),
			easeOut: Type.Optional(Type.String({ description: `通用缓出：枚举名 ${MOTION_EASE_NAMES.join(" / ")} 或受限 cubic-bezier(x1,y1,x2,y2)（x∈0..1，y∈-0.5..1.5）` })),
			easeExpand: Type.Optional(Type.String({ description: "展开缓动（同上）" })),
			easeSpring: Type.Optional(Type.String({ description: "轻微回弹缓动（同上；仅装饰用）" })),
			scale: Type.Optional(Type.Number({ minimum: MOTION_SCALE_MIN, maximum: MOTION_SCALE_MAX, description: "整体时长倍率（0.5..2），供七档滑块等组件按主题缩放" })),
			glow: Type.Optional(enumOf(MOTION_GLOW_LEVELS)),
			style: Type.Optional(enumOf(MOTION_STYLES)),
		}),
	),
});

export interface ThemeDraftToolHost {
	/** 上一版（继续修改时）：用来保持 id / createdAt 稳定。 */
	previous?: ThemeManifestV1;
	/** 用户这轮附带的参考图（服务端已规范化的引用，会被强制写入 manifest）。 */
	images: ThemeImageRef[];
	/** 收到一份校验通过的 manifest。 */
	onAccepted(manifest: ThemeManifestV1): void;
	/** 一份 manifest 没通过校验（用于把最后一次错误返回给界面）。 */
	onRejected?(errors: ThemeError[]): void;
	/** 每次调用后回调（用于把 attempts 反映到结果里）。 */
	onAttempt?(): void;
}

/** 最多允许「初次 + 一次格式修复」两次调用；再多说明模型没按规范走，直接结束。 */
export const MAX_THEME_DRAFT_CALLS = 2;

export function themeDraftTool(host: ThemeDraftToolHost): ToolDefinition {
	let calls = 0;
	let lastErrors: string[] = [];
	return defineTool({
		name: "theme_draft",
		label: "提交主题草稿",
		description:
			"提交一套外观主题（Typed ThemeManifest v1）。manifest 里必须给齐必需颜色 token 的 light / dark 两套；只允许白名单 CSS 变量，值只能是颜色 / 尺寸 / 字体名列表，装饰只允许 enum；动效（motion）可选，只能是有界的时长 / 缓动 / 倍率 / 光晕 / 风格。校验失败会返回错误列表，你最多可以按错误修一次再提交。不要提交图片（图片由用户上传的参考图决定）。",
		promptSnippet: "theme_draft: 提交一套主题（颜色 token + 装饰 enum + 动效 token），校验通过才会应用",
		parameters: Type.Object({
			manifest: MANIFEST_PARAM,
			text: Type.Optional(Type.String({ description: "给用户看的一两句话：这套主题的想法 / 配色说明（简体中文）" })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		async execute(_id, p) {
			calls += 1;
			host.onAttempt?.();
			if (calls > MAX_THEME_DRAFT_CALLS) {
				return text(`已达格式修复上限（最多 ${MAX_THEME_DRAFT_CALLS} 次）。请停止调用工具，直接用一句话告诉用户这次没生成成功、以及上一条错误。`);
			}
			const raw = (p as { manifest: Record<string, unknown> }).manifest ?? {};
			// id / 时间戳 / 图片引用由服务端决定，模型给的一律覆盖（防止模型乱填 id 或塞入图片）
			const now = new Date().toISOString();
			const candidate: Record<string, unknown> = {
				...raw,
				manifestVersion: THEME_MANIFEST_VERSION,
				id: host.previous?.id ?? crypto.randomUUID(),
				createdAt: host.previous?.createdAt ?? now,
				updatedAt: now,
			};
			if (host.previous?.basedOn && !candidate.basedOn) candidate.basedOn = host.previous.basedOn;
			if (host.images.length) candidate.images = host.images;
			else delete candidate.images;
			const r = validateThemeManifest(candidate);
			if (!r.ok) {
				lastErrors = r.errors.map((e) => `${e.path || "(根)"}：${e.message}${e.expected ? `（期望：${e.expected}）` : ""}`);
				host.onRejected?.(r.errors);
				return text(`manifest 校验没通过，请按下面每一条修正后**再调用一次** theme_draft：\n${lastErrors.map((x) => `- ${x}`).join("\n")}`);
			}
			lastErrors = [];
			host.onAccepted(r.manifest);
			const warn = r.warnings.length ? `\n提醒（不阻止）：\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "";
			return text(`已收到合法主题「${r.manifest.name}」。${warn}`);
		},
	}) as ToolDefinition;
}

/** 设计会话的系统提示：只讲主题规范与工具用法，不涉及任何聊天 / 文件 / 电脑权限。 */
export function themeDesignSystemPrompt(): string {
	return [
		"你是 Pi Assistant 的外观主题设计器。用户会用一句自然语言描述想要的感觉，你据此产出**一套**外观主题。",
		`调用 theme_draft 工具提交主题；不要在正文里粘贴 JSON。工具会用同一套 schema 校验，通过后界面会实时预览。`,
		`必需颜色 token（light / dark 两套都必须齐全）：${REQUIRED_COLOR_TOKENS.join(" ")}。`,
		`可选 token：${OPTIONAL_COLOR_TOKENS.join(" ")}（颜色）、${OPTIONAL_SIZE_TOKENS.join(" ")}（px 0..64 或 rem/em 0..4）、${OPTIONAL_FONT_TOKENS.join(" ")}（字体名列表）。`,
		"颜色只允许 #rgb / #rrggbb / #rrggbbaa、rgb()/rgba()/hsl()/hsla() 或 transparent；值里禁止 url()、@、;、{}、<>、\\。",
		`装饰只允许 enum：texture ${DECOR_TEXTURES.join("/")}；corner ${DECOR_CORNERS.join("/")}；shadow ${DECOR_SHADOWS.join("/")}；background ${DECOR_BACKGROUNDS.join("/")}。`,
		`可选动效（motion，模式无关；不写就用内置默认）：durationFast/duration/durationSlow 是时长（${MOTION_DURATION_MIN_MS}..${MOTION_DURATION_MAX_MS}ms，如 .12s / 180ms）；easeOut/easeExpand/easeSpring 是缓动，只能填枚举名 ${MOTION_EASE_NAMES.join("/")} 或受限 cubic-bezier(x1,y1,x2,y2)（x 在 0..1，y 在 -0.5..1.5）；scale 是 0.5..2 的时长倍率；glow 是 ${MOTION_GLOW_LEVELS.join("/")}；style 是 ${MOTION_STYLES.join("/")}。`,
		"动效是有界的（时长 / 缓动 / 倍率 / 光晕 / 风格），不是任意 CSS：不要尝试写 @keyframes、url()、steps()、animation 简写或自定义属性。系统「减弱动效」始终优先，你的动效值不会绕过它。",
		"颜色要保证正文可读（对比度低只提醒、不阻止，但请尽量让 --fg/--mut/--mut2 与 --bg 有足够对比）。",
		"如果用户带了参考图，图片只是视觉参考（配色 / 风格 / 材质），不要描述图片里不该描述的内容；你无法读取任何本地文件。",
		"不要臆造图片引用、不要输出 CSS 之外的内容；除 theme_draft 外你没有任何工具，也不能读写文件、执行命令或访问网络。",
		"用户说“继续修改”时会给你上一版 manifest，请在其基础上改，不要推翻重来。",
		"提交成功后，用一句简体中文说明这套主题的想法（配色 / 风格），不要贴代码。",
	].join("\n");
}
