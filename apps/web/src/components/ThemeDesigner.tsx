import { Loader2, Sparkles, Undo2, Upload, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { stripReferenceImages, validateThemeManifest, type ThemeDraftRequest, type ThemeDraftResult, type ThemeImageRef, type ThemeManifestV1 } from "@pi-assistant/shared";
import type { Attachment } from "../types";
import { applyTheme, setAppearance, useStore } from "../store";
import { customSkinId } from "../themes/manifest";
import { exportCustomTheme, installCustomThemes, newThemeId, saveCustomTheme } from "../themes/custom-store";
import { registerTheme, unregisterTheme } from "../themes/registry";
import { cancelPreview, commitPreview, revisePreview, startPreview, undoPreview, type AppearanceSnapshot, type PreviewEffects, type PreviewSession } from "../themes/preview";
import { ThemeImagePicker } from "./ThemeImagePicker";
import { ThemePreview } from "./ThemePreview";
import { Button, Help, Modal, cx } from "./ui";

const PREVIEW_STYLE_ID = "pa-theme-preview";

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
	unregisterTheme,
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
	onThemeDraft?: (req: ThemeDraftRequest) => Promise<ThemeDraftResult>;
	/** 复用附件上传。 */
	uploadFn?: (f: File) => Promise<Attachment>;
	onSaved?: (m: ThemeManifestV1) => void;
}

export function ThemeDesigner({ open, onClose, initial, onThemeDraft, uploadFn, onSaved }: ThemeDesignerProps) {
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
	const fileRef = useRef<HTMLInputElement>(null);
	const turnSeq = useRef(0);

	const snapshot = useMemo<AppearanceSnapshot>(() => {
		const s = useStore.getState();
		return { theme: s.theme, skin: s.skin, accent: s.accent };
		// 打开面板时快照一次即可（预览期间不改已保存值）
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const draft = session?.current ?? initial ?? null;

	// 关闭时若还在预览且未保存 → 完整恢复进入前的外观
	const closeAndRestore = () => {
		if (session && !session.saved) cancelPreview(session, liveEffects);
		setSession(null);
		setErrors([]);
		setWarnings([]);
		setText("");
		setVisionHint(false);
		onClose();
	};

	useEffect(() => {
		if (open) return;
		// 面板被外部关掉（比如 ESC / 遮罩）时也要恢复
		if (session && !session.saved) cancelPreview(session, liveEffects);
		setSession(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// 卸载兜底：清掉临时样式，避免残留
	useEffect(() => () => installPreviewStyle(null), []);

	const runDraft = async (previous?: ThemeManifestV1) => {
		if (!onThemeDraft) return;
		setBusy(true);
		setErrors([]);
		setWarnings([]);
		setVisionHint(false);
		try {
			const req: ThemeDraftRequest = { turnId: `t${++turnSeq.current}`, prompt: prompt.trim(), previousManifest: previous };
			if (images.length) req.images = images;
			const res = await onThemeDraft(req);
			if (res.ok) {
				setText(res.text);
				setWarnings(res.warnings ?? []);
				setSession((prev) => (prev ? revisePreview(prev, res.manifest, liveEffects) : startPreview(res.manifest, snapshot, liveEffects)));
			} else {
				setErrors(res.errors.map((e) => (e.path ? `${e.path}：${e.message}` : e.message)));
				setVisionHint(!!res.visionUnsupported);
				setText(res.text ?? "");
				setWarnings(res.warnings ?? []);
			}
		} catch (e) {
			setErrors([String((e as Error).message ?? e)]);
		} finally {
			setBusy(false);
		}
	};

	const doGenerate = () => {
		// 首次生成用 initial（如果是编辑）作为「上一版」上下文；继续修改用当前预览版
		if (session) void runDraft(session.current);
		else if (initial) void runDraft(initial);
		else void runDraft(undefined);
	};

	const doUndo = () => session && setSession(undoPreview(session, liveEffects));

	const doSave = (asNew: boolean) => {
		if (!draft) return;
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

					{!connected && (
						<div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300" data-testid="theme-ai-offline">
							AI 生成还没接通（开发阶段）：这里只提供入口与预览 / 导入导出，不会假装生成结果。接通后会复用当前助理的模型，无需新建助理或手写 JSON。
						</div>
					)}
					{visionHint && (
						<div className="rounded-xl border border-line bg-hover px-3 py-2 text-xs text-mut">
							当前助理模型不支持看图：可以换一个支持视觉的模型，或只用文字描述（不会偷偷换到别的视觉服务 / 收费模型）。
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
						<Button variant="primary" onClick={doGenerate} disabled={busy || !connected || !prompt.trim()} data-testid="theme-generate">
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
							导出的是主题的 JSON（颜色 / 圆角 / 装饰），默认**不含**你上传的参考图；只有你显式标成「用作背景 / 装饰素材」的图才会作为素材引用保留（首版导出还不打包图片 zip）。
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
