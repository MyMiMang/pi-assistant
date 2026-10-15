/**
 * 主题预览事务：真实全应用临时预览 → 继续提意见 / 上一版 → 应用并保存 / 取消。
 *
 * 关键保证：
 * - 预览只改 DOM（applyAppearance + 临时 `<style>`），**不动已保存的 pia.skin / accent**，所以「未保存不可覆盖原主题」。
 * - 取消：清掉临时样式、恢复进入预览前的外观快照（appearance 与 accent / mode 完整恢复）。
 * - 应用并保存：先落库（saveTheme），再正式切换 skin 并清掉临时样式（避免临时样式和正式样式打架）。
 * - 未保存的草稿在取消时从注册表移除；已保存的主题不移除。
 *
 * DOM 相关动作全部走注入的 `effects`，核心状态迁移是纯函数 → 可在 Node 里用假 effects 单测。
 */
import type { ThemeManifestV1 } from "@pi-assistant/shared";
import { customSkinId, manifestToCss, themeDefFromManifest } from "./manifest.ts";
import type { ThemeDef } from "./registry.ts";

export interface AppearanceSnapshot {
	theme: "light" | "dark" | "system";
	skin: string;
	accent: string;
}

export interface PreviewEffects {
	/** 应用外观到 <html>（预览或恢复）。 */
	applyAppearance(snap: AppearanceSnapshot): void;
	registerTheme(def: ThemeDef): void;
	unregisterTheme(skin: string): void;
	/** 注入 / 清除临时预览样式（null = 清除）。 */
	setPreviewCss(css: string | null): void;
	/** 落库保存（含持久样式注入）。 */
	saveTheme(manifest: ThemeManifestV1): void;
}

export interface PreviewSession {
	current: ThemeManifestV1;
	/** 上一版栈（不含 current），用于「上一版」。 */
	history: ThemeManifestV1[];
	/** 进入预览前的外观快照，取消时恢复。 */
	snapshot: AppearanceSnapshot;
	saved: boolean;
}

/** 开始预览一份草稿（草稿可以还没保存）。 */
export function startPreview(manifest: ThemeManifestV1, snapshot: AppearanceSnapshot, effects: PreviewEffects): PreviewSession {
	effects.registerTheme(themeDefFromManifest(manifest));
	effects.setPreviewCss(manifestToCss(manifest));
	effects.applyAppearance({ theme: snapshot.theme, skin: customSkinId(manifest.id), accent: "" });
	return { current: manifest, history: [], snapshot, saved: false };
}

/** 迭代：把当前版压进历史，换成新版（继续提意见 / 换一版 AI 草稿）。 */
export function revisePreview(session: PreviewSession, manifest: ThemeManifestV1, effects: PreviewEffects): PreviewSession {
	effects.registerTheme(themeDefFromManifest(manifest));
	effects.setPreviewCss(manifestToCss(manifest));
	effects.applyAppearance({ theme: session.snapshot.theme, skin: customSkinId(manifest.id), accent: "" });
	return { ...session, current: manifest, history: [...session.history, session.current] };
}

/** 上一版：回到历史里的上一份草稿。 */
export function undoPreview(session: PreviewSession, effects: PreviewEffects): PreviewSession {
	if (!session.history.length) return session;
	const prev = session.history[session.history.length - 1];
	effects.registerTheme(themeDefFromManifest(prev));
	effects.setPreviewCss(manifestToCss(prev));
	effects.applyAppearance({ theme: session.snapshot.theme, skin: customSkinId(prev.id), accent: "" });
	return { ...session, current: prev, history: session.history.slice(0, -1) };
}

/** 应用并保存：落库 → 正式切换 → 清临时样式。 */
export function commitPreview(session: PreviewSession, effects: PreviewEffects): PreviewSession {
	effects.saveTheme(session.current);
	effects.setPreviewCss(null);
	effects.applyAppearance({ theme: session.snapshot.theme, skin: customSkinId(session.current.id), accent: session.snapshot.accent });
	return { ...session, saved: true };
}

/** 取消：清临时样式、移除未保存的注册、完整恢复进入预览前的外观。 */
export function cancelPreview(session: PreviewSession, effects: PreviewEffects): PreviewSession {
	effects.setPreviewCss(null);
	if (!session.saved) effects.unregisterTheme(customSkinId(session.current.id));
	effects.applyAppearance(session.snapshot);
	return session;
}
