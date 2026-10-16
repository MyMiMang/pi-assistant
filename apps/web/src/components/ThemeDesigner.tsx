import { Loader2, Sparkles, Undo2, Upload, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { stripReferenceImages, validateThemeManifest, type ThemeDraftRequest, type ThemeDraftResult, type ThemeImageRef, type ThemeManifestV1, type ThemeModelRef, type ThemeMotion } from "@pi-assistant/shared";
import type { Attachment } from "../types";
import { applyTheme, setAppearance, useStore } from "../store";
import { customSkinId } from "../themes/manifest";
import { buildThemeModelChoice, refVisionStatus, themeModelButtonText, themeModelLabel } from "../themes/model-choice";
import { ModelPickerButton, useConfiguredModels, useModelPicks } from "./ModelPicker";
import { exportCustomTheme, installCustomThemes, newThemeId, saveCustomTheme, unregisterPreviewTheme } from "../themes/custom-store";
import { registerTheme, unregisterTheme } from "../themes/registry";
import { cancelPreview, commitPreview, revisePreview, startPreview, undoPreview, type AppearanceSnapshot, type PreviewEffects, type PreviewSession } from "../themes/preview";
import { DraftTurns } from "../themes/design-session";
import { ThemeImagePicker } from "./ThemeImagePicker";
import { ThemePreview } from "./ThemePreview";
import { Button, Help, Modal, cx } from "./ui";

const PREVIEW_STYLE_ID = "pa-theme-preview";

/* 「动效微调」：同页按需入口（不新造高级模式）。只写有界 typed 值，不写任意 CSS。 */
const MOTION_DURATIONS = ["80ms", "120ms", "180ms", "260ms", "400ms", "600ms"] as const;
const MOTION_EASES = ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "standard", "emphasized", "spring-soft"] as const;
const MOTION_GLOWS = ["none", "subtle", "normal", "strong"] as const;
const MOTION_STYLE_OPTS = ["smooth", "steps"] as const;
const MOTION_SCALES = ["0.8", "1", "1.2", "1.5"] as const;

function MotionRow({ label, value, options, onChange, testid }: { label: string; value: string; options: readonly string[]; onChange: (v: string) => void; testid: string }) {
	// AI 可能给出枚举之外的合法值（如自定义 cubic-bezier() / 非预设时长）：原样列成一个选项，
	// 否则 <select> 找不到匹配项会显示成「默认」，看着像被重置、也可能被用户顺手改掉。
	const custom = value && !options.includes(value) ? value : null;
	return (
		<label className="flex items-center justify-between gap-2 text-xs">
			<span className="text-mut">{label}</span>
			<select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-lg border border-line bg-card px-2 py-1 text-xs" data-testid={testid}>
				<option value="">默认</option>
				{options.map((o) => (
					<option key={o} value={o}>
						{o}
					</option>
				))}
				{custom && (
					<option value={custom}>
						{custom}
					</option>
				)}
			</select>
		</label>
	);
}

function installPreviewStyle(css: string | null) {
	let el = document.getElementById(PREVIEW_STYLE_ID) as HTMLStyleElement | null;
	if (css == null) {
		el?.remove();
		return;
	}
	if (!el) {
		el = document.createElement("style");
		el.id = PREVIEW_STYLE_ID;
		document.head.appendChild(el);
	}
	el.textContent = css;
}

/** 真实 DOM 预览效果：只改运行时状态 + 临时样式，**不写 localStorage**（预览不覆盖已保存主题）。 */
const liveEffects: PreviewEffects = {
	applyAppearance: (snap) => {
		useStore.setState({ theme: snap.theme, skin: snap.skin, accent: snap.accent });
		applyTheme(snap.theme, snap.accent, snap.skin);
	},
	registerTheme,
	// 取消预览时不要把「已保存」的 DIY 主题从注册表移除（见 unregisterPreviewTheme）。
	unregisterTheme: unregisterPreviewTheme,
	setPreviewCss: installPreviewStyle,
	saveTheme: (m) => {
		const r = saveCustomTheme(m);
		if (!r.ok) throw new Error(r.errors.map((e) => `${e.path}：${e.message}`).join("；"));
		installCustomThemes();
	},
};

export interface ThemeDesignerProps {
	open: boolean;
	onClose: () => void;
	/** 编辑已有 DIY 主题时传入（「编辑 / 继续用AI修改」走这里）。 */
	initial?: ThemeManifestV1 | null;
	/** 后端接线（主会话接真实当前 agent 模型）。未传 = 未联通，面板如实标注，不做假生成。 */
	onThemeDraft?: (req: ThemeDraftRequest, opts?: { signal?: AbortSignal }) => Promise<ThemeDraftResult>;
	/** 复用附件上传。 */
	uploadFn?: (f: File) => Promise<Attachment>;
	/** 当前助理 id（后端按它选模型；不传则请求会缺少 agentId 被拒绝）。 */
	agentId?: string;
	/** 「没有可用模型」时跳到现有「设置 › 模型服务」页（不额外弹配置框）。 */
	onOpenModels?: () => void;
	onSaved?: (m: ThemeManifestV1) => void;
}

export function ThemeDesigner({ open, onClose, initial, onThemeDraft, uploadFn, agentId, onOpenModels, onSaved }: ThemeDesignerProps) {
	const connected = !!onThemeDraft;
	const [prompt, setPrompt] = useState("");
	const [images, setImages] = useState<ThemeImageRef[]>([]);
	const [session, setSession] = useState<PreviewSession | null>(null);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [text, setText] = useState("");
	const [visionHint, setVisionHint] = useState(false);
	const [renamed, setRenamed] = useState(false);
	const [picked, setPicked] = useState<ThemeModelRef | null>(null);
	const [resolvedModel, setResolvedModel] = useState<ThemeModelRef | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	// 在飞轮次：关闭面板 / 发新一轮 / 保存后真 abort；晚到的响应丢弃，不应用。
	const turns = useRef(new DraftTurns());

	const abortDraft = () => turns.current.cancel();

	const snapshot = useMemo<AppearanceSnapshot>(() => {
		const s = useStore.getState();
		return { theme: s.theme, skin: s.skin, accent: s.accent };
		// 打开面板时快照一次即可（预览期间不改已保存值）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const draft = session?.current ?? initial ?? null;

	// 「使用模型」：默认跟随当前助理（助理未显式选=默认模型，明确标「默认模型 · xxx」）；
	// 直接在面板里换只影响这一次草稿请求（请求带 canonical provider/id 快照），**不改**助理主模型 / 模型池 / 全局默认。
	const { models: configuredModels, providers, error: modelsError, reload: reloadModels } = useConfiguredModels();
	const { picks } = useModelPicks();
	const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
	const agentModel = agent?.model ?? null;
	const agentExplicit = !!(agent?.model_provider && agent?.model_id);
	const choice = useMemo(
		() =>
			buildThemeModelChoice({
				models: configuredModels.map((m) => ({ provider: m.provider, id: m.id, name: m.name, providerName: m.providerName, input: m.input })),
				providers: providers.map((p) => ({ id: p.id, name: p.name })),
				agentModel,
				agentExplicit,
				hasImages: images.length > 0,
			}),
		[configuredModels, providers, agentModel, agentExplicit, images.length],
	);
	const selected = picked ?? choice.initial;
	const visionStatus = refVisionStatus(selected, choice.options);
	const blockedByVision = images.length > 0 && visionStatus !== true;
	const noModel = !selected;
	const needsSetup = choice.options.length === 0;
	const defaultPrefix = !picked && choice.source === "default";

	// 打开面板时回到「跟随当前助理」（不保留上一次面板内的临时选择）。
	useEffect(() => {
		if (open) {
			setPicked(null);
			setResolvedModel(null);
			setText("");
			setRenamed(false);
		}
	}, [open]);

	// 关闭时若还在预览且未保存 → 完整恢复进入前的外观
	const closeAndRestore = () => {
		abortDraft();
		setBusy(false);
		if (session && !session.saved) cancelPreview(session, liveEffects);
		setSession(null);
		setErrors([]);
		setWarnings([]);
		setText("");
		setVisionHint(false);
		setResolvedModel(null);
		onClose();
	};

	useEffect(() => {
		if (open) return;
		// 面板被外部关掉（比如 ESC / 遮罩）时也要恢复 + 取消在飞请求
		abortDraft();
		setBusy(false);
		if (session && !session.saved) cancelPreview(session, liveEffects);
		setSession(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// 卸载兜底：清掉临时样式 + 中止在飞请求，避免残留
	useEffect(
		() => () => {
			turns.current.cancel();
			installPreviewStyle(null);
		},
		[],
	);

	const runDraft = async (previous?: ThemeManifestV1) => {
		if (!onThemeDraft) return;
		const { turnId, signal } = turns.current.begin();
		setBusy(true);
		setErrors([]);
		setWarnings([]);
		setVisionHint(false);
		try {
			const req: ThemeDraftRequest = { turnId, prompt: prompt.trim(), previousManifest: previous };
			if (agentId) req.agentId = agentId;
			// 生成时快照当前选定模型（运行中就算 UI 变了也不会混进本轮）。
			if (selected) req.model = { provider: selected.provider, id: selected.id };
			if (images.length) req.images = images;
			const res = await onThemeDraft(req, { signal });
			// 迟到的响应（用户已关面板 / 又发了新一轮）一律丢弃，不应用、不报错。
			if (!turns.current.isCurrent(turnId)) return;
			if (res.ok) {
				setText(res.text);
				setWarnings(res.warnings ?? []);
				setResolvedModel(res.model ?? null);
				setSession((prev) => (prev ? revisePreview(prev, res.manifest, liveEffects) : startPreview(res.manifest, snapshot, liveEffects)));
			} else {
				setErrors(res.errors.map((e) => (e.path ? `${e.path}：${e.message}` : e.message)));
				setVisionHint(!!res.visionUnsupported);
				setResolvedModel(res.model ?? null);
				setText(res.text ?? "");
				setWarnings(res.warnings ?? []);
			}
		} catch (e) {
			// 取消（abort）导致的 rejection 不当错误报；只有真正的新一轮请求还在等才显示错误
			if (signal.aborted || !turns.current.isCurrent(turnId)) return;
			setErrors([String((e as Error).message ?? e)]);
		} finally {
			if (turns.current.finish(turnId)) setBusy(false);
		}
	};

	const doGenerate = () => {
		// 首次生成用 initial（如果是编辑）作为「上一版」上下文；继续修改用当前预览版
		if (session) void runDraft(session.current);
		else if (initial) void runDraft(initial);
		else void runDraft(undefined);
	};

	const doUndo = () => session && setSession(undoPreview(session, liveEffects));

	/** 手动微调当前草稿（如动效）：立即走同一预览事务，未保存不覆盖原主题。 */
	const applyDraftManifest = (next: ThemeManifestV1) => {
		setSession((prev) => (prev ? revisePreview(prev, next, liveEffects) : startPreview(next, snapshot, liveEffects)));
	};
	const setMotion = (patch: Partial<ThemeMotion>) => {
		if (!draft) return;
		const m: ThemeMotion = { ...(draft.motion ?? {}) };
		for (const [k, v] of Object.entries(patch)) {
			if (v == null || v === "") delete (m as Record<string, unknown>)[k];
			else (m as Record<string, unknown>)[k] = v;
		}
		const next: ThemeManifestV1 = { ...draft };
		if (Object.keys(m).length) next.motion = m;
		else delete next.motion;
		applyDraftManifest(next);
	};

	const doSave = (asNew: boolean) => {
		if (!draft) return;
		abortDraft();
		let m: ThemeManifestV1 = draft;
		if (asNew) m = { ...draft, id: newThemeId(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), name: `${draft.name} 副本` };
		const r = saveCustomTheme(m);
		if (!r.ok) {
			setErrors(r.errors.map((e) => (e.path ? `${e.path}：${e.message}` : e.message)));
			return;
		}
		installPreviewStyle(null);
		installCustomThemes();
		setAppearance({ skin: customSkinId(r.manifest.id), accent: snapshot.accent });
		setSession(null);
		setRenamed(asNew);
		onSaved?.(r.manifest);
		onClose();
	};

	const doImportFile = async (f: File) => {
		setErrors([]);
		try {
			const raw = await f.text();
			const parsed = JSON.parse(raw) as unknown;
			const r = validateThemeManifest(parsed);
			if (!r.ok) {
				setErrors(r.errors.map((e) => (e.path ? `${e.path}：${e.message}` : e.message)));
				return;
			}
			setWarnings(r.warnings ?? []);
			setSession((prev) => (prev ? revisePreview(prev, r.manifest, liveEffects) : startPreview(r.manifest, snapshot, liveEffects)));
		} catch (e) {
			setErrors([`不是合法 JSON：${(e as Error).message}`]);
		}
	};

	const doExport = () => {
		if (!draft) return;
		const json = exportCustomTheme(stripReferenceImages(draft));
		const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
		const a = document.createElement("a");
		a.href = url;
		a.download = `theme-${draft.name || "custom"}.json`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 30_000);
	};

	const goToModels = () => {
		closeAndRestore();
		onOpenModels?.();
	};

	return (
		<Modal open={open} onClose={closeAndRestore} wide fixed title={<span className="flex items-center gap-2">用 AI 设计主题{renamed && <span className="text-xs font-normal text-mut2">已另存为新主题</span>}</span>} testId="theme-designer">
			<div className="flex h-full min-h-0 flex-col gap-3 p-5 sm:flex-row">
				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
					{session && (
						<div className="flex items-center gap-2 text-xs">
							<span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">预览中 · 未保存</span>
							<span className="text-mut2">下面整块界面就是真实预览；取消会完整恢复原来的外观。</span>
						</div>
					)}
					<div className="rounded-xl border border-line px-3 py-2" data-testid="theme-model-row">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-sm text-mut">使用模型</span>
							<ModelPickerButton
								testid="theme-model"
								id="theme-model"
								models={choice.menuOptions}
								providers={providers}
								value={selected}
								picks={picks}
								onPick={(m) => setPicked({ provider: m.provider, id: m.id })}
								text={themeModelButtonText(selected, choice.options, { defaultPrefix })}
								disabled={busy || !connected || needsSetup}
								onOpen={reloadModels}
								placement="down"
								buttonClass="max-w-[260px]"
								title="这次主题设计用哪个模型；不影响助理主模型"
								ariaLabel={`主题设计使用模型：${themeModelButtonText(selected, choice.options, { defaultPrefix })}`}
								header={() => (
									<div className="mb-1 rounded-lg border border-line px-2.5 py-1.5 text-[11px] text-mut" data-testid="theme-model-note">
										只影响这次主题设计，不改助理主模型 / 模型池 / 全局默认。带参考图时只能选支持看图的模型。
									</div>
								)}
							/>
							{needsSetup && (
								<Button size="sm" onClick={goToModels} data-testid="theme-model-configure">
									去「设置 › 模型服务」配置
								</Button>
							)}
							{!needsSetup && defaultPrefix && <span className="text-[11px] text-mut2">（助理未显式选模型，跟随默认）</span>}
						</div>
						{needsSetup && (
							<div className="mt-1 text-xs text-amber-700 dark:text-amber-300" data-testid="theme-model-empty">
								{modelsError ? "模型列表加载失败。" : "还没有配置可用的聊天模型。"}去「设置 › 模型服务」登录 / 选一个默认模型后回来（不会偷偷用别的收费模型）。
							</div>
						)}
						{!needsSetup && noModel && <div className="mt-1 text-xs text-mut">请先选一个这次要用的模型。</div>}
						{blockedByVision && (
							<div className="mt-1 text-xs text-amber-700 dark:text-amber-300" data-testid="theme-model-vision-block">
								{selected ? `「${themeModelButtonText(selected, choice.options)}」不支持看图，已保留你选的参考图。` : ""}换一个支持视觉的聊天模型才能带图生成；也可以去掉图片只用文字描述。
							</div>
						)}
						{resolvedModel && (
							<div className="mt-1 text-[11px] text-mut2" data-testid="theme-resolved-model">
								本轮实际使用：{themeModelLabel(resolvedModel)}
							</div>
						)}
					</div>
					<label className="block text-sm">
						<span className="mb-1 block text-mut">想要什么样的主题？</span>
						<textarea
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							rows={4}
							placeholder="例：奶油底色、薄荷与桃粉点缀，圆角小一点，整体安静可爱；像素风的话装饰用 8bit 边角。"
							className="w-full rounded-xl border border-line bg-card px-3 py-2 text-sm outline-none focus:border-accent"
							data-testid="theme-prompt"
						/>
					</label>
					<ThemeImagePicker uploadFn={uploadFn} value={images} onChange={setImages} disabled={busy} />

					{draft && (
						<details className="rounded-xl border border-line px-3 py-2" data-testid="theme-motion">
							<summary className="flex cursor-pointer items-center gap-2 text-sm text-mut">
								动效微调（可选）
							</summary>
							<div className="mt-1 flex items-center gap-2 text-[11px] text-mut2">
								<span>时长 / 缓动 / 光晕 / 过渡风格，只影响这套主题。</span>
								<Help>系统「减弱动效」始终优先：开启后无论主题怎么写都会去掉位移 / 循环。像素风可选「离散成步（steps）」。留「默认」即用内置值。</Help>
							</div>
							<div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
								<MotionRow label="即时反馈时长" value={draft.motion?.durationFast ?? ""} options={MOTION_DURATIONS} onChange={(v) => setMotion({ durationFast: v || undefined })} testid="theme-motion-fast" />
								<MotionRow label="常规时长" value={draft.motion?.duration ?? ""} options={MOTION_DURATIONS} onChange={(v) => setMotion({ duration: v || undefined })} testid="theme-motion-base" />
								<MotionRow label="折叠 / 展开时长" value={draft.motion?.durationSlow ?? ""} options={MOTION_DURATIONS} onChange={(v) => setMotion({ durationSlow: v || undefined })} testid="theme-motion-slow" />
								<MotionRow label="时长倍率" value={draft.motion?.scale != null ? String(draft.motion.scale) : ""} options={MOTION_SCALES} onChange={(v) => setMotion({ scale: v ? Number(v) : undefined })} testid="theme-motion-scale" />
								<MotionRow label="通用缓出" value={draft.motion?.easeOut ?? ""} options={MOTION_EASES} onChange={(v) => setMotion({ easeOut: v || undefined })} testid="theme-motion-ease-out" />
								<MotionRow label="展开缓动" value={draft.motion?.easeExpand ?? ""} options={MOTION_EASES} onChange={(v) => setMotion({ easeExpand: v || undefined })} testid="theme-motion-ease-expand" />
								<MotionRow label="回弹缓动" value={draft.motion?.easeSpring ?? ""} options={MOTION_EASES} onChange={(v) => setMotion({ easeSpring: v || undefined })} testid="theme-motion-ease-spring" />
								<MotionRow label="光晕强度" value={draft.motion?.glow ?? ""} options={MOTION_GLOWS} onChange={(v) => setMotion({ glow: (v || undefined) as ThemeMotion["glow"] })} testid="theme-motion-glow" />
								<MotionRow label="过渡风格" value={draft.motion?.style ?? ""} options={MOTION_STYLE_OPTS} onChange={(v) => setMotion({ style: (v || undefined) as ThemeMotion["style"] })} testid="theme-motion-style" />
							</div>
						</details>
					)}

					{!connected && (
						<div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300" data-testid="theme-ai-offline">
							AI 生成还没接通（开发阶段）：这里只提供入口与预览 / 导入导出，不会假装生成结果。接通后会复用当前助理的模型，无需新建助理或手写 JSON。
						</div>
					)}
					{visionHint && (
						<div className="rounded-xl border border-line bg-hover px-3 py-2 text-xs text-mut">
							所选模型不支持看图：请在上方切换支持视觉的模型，或去掉参考图只用文字描述。
						</div>
					)}
					{errors.length > 0 && (
						<ul className="rounded-xl border border-red-300/60 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300" data-testid="theme-errors">
							{errors.map((e, i) => (
								<li key={i}>{e}</li>
							))}
						</ul>
					)}
					{warnings.length > 0 && (
						<ul className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300" data-testid="theme-warnings">
							{warnings.map((w, i) => (
								<li key={i}>{w}</li>
							))}
						</ul>
					)}
					{text && <p className="text-sm text-mut">{text}</p>}

					<div className="flex flex-wrap gap-2">
						<Button variant="primary" onClick={doGenerate} disabled={busy || !connected || !prompt.trim() || noModel || blockedByVision} data-testid="theme-generate">
							{busy ? <Loader2 size={15} className="animate-spin" /> : session ? <Wand2 size={15} /> : <Sparkles size={15} />}
							{session ? "继续修改" : "生成主题"}
						</Button>
						{session && (
							<Button onClick={doUndo} disabled={busy || !session.history.length} data-testid="theme-undo">
								<Undo2 size={15} /> 上一版
							</Button>
						)}
						{session && (
							<Button variant="primary" onClick={() => doSave(false)} disabled={busy} data-testid="theme-apply">
								应用并保存
							</Button>
						)}
						{session && (
							<Button onClick={() => doSave(true)} disabled={busy} data-testid="theme-save-as">
								另存为新主题
							</Button>
						)}
						<Button onClick={closeAndRestore} data-testid="theme-cancel">
							取消
						</Button>
					</div>

					<div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
						<Button size="sm" onClick={() => fileRef.current?.click()} data-testid="theme-import">
							<Upload size={14} /> 导入 JSON
						</Button>
						<input ref={fileRef} type="file" accept="application/json,.json" hidden data-testid="theme-import-input" onChange={(e) => (e.target.files?.[0] && void doImportFile(e.target.files[0]), (e.target.value = ""))} />
						<Button size="sm" onClick={doExport} disabled={!draft} data-testid="theme-export">
							导出 JSON
						</Button>
						<Help>
							导出的是主题的 JSON（颜色 / 圆角 / 字体 / 装饰 / 动效），默认**不含**你上传的参考图；只有你显式标成「用作背景 / 装饰素材」的图才会作为素材引用保留（首版导出还不打包图片 zip）。
						</Help>
					</div>
				</div>
				<div className="w-full shrink-0 sm:w-72">
					<div className="mb-1 text-xs text-mut2">预览</div>
					{draft ? (
						<div className={cx("overflow-hidden rounded-xl border border-line")}>
							<ThemePreview theme={{ ...themeDefPreview(draft) }} mode={useStore.getState().theme === "dark" ? "dark" : "light"} />
						</div>
					) : (
						<div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-line text-xs text-mut2">还没有主题，先生成或导入</div>
					)}
				</div>
			</div>
		</Modal>
	);
}

/** 预览用的 ThemeDef（不注册，只喂 ThemePreview）。 */
function themeDefPreview(m: ThemeManifestV1) {
	return {
		id: customSkinId(m.id),
		name: m.name,
		tagline: "",
		accent: { light: m.modes.light["--acc"] ?? "#6a57ff", dark: m.modes.dark["--acc"] ?? "#8b7bff" },
		accents: [] as string[],
		chrome: { light: m.modes.light["--bg"] ?? "#f4f4f6", dark: m.modes.dark["--bg"] ?? "#09090b" },
	};
}
