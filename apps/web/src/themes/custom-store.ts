/**
 * 自定义主题库存（每设备本地持久化）+ 运行时样式注入。
 *
 * - 存 localStorage `pia.customThemes`：ThemeManifestV1 数组（含参考图 / 素材图的附件引用与元数据，**不含 base64**）。
 * - 读入时逐条校验，坏数据丢弃（不抛、不阻塞启动），并保留原样在控制台提示。
 * - 内置主题只读：`isBuiltinSkin` 保护，另存走新 id，绝不覆盖 / 删除内置。
 * - 编辑保存：保 `id` / `createdAt`，只改 `updatedAt`。
 * - 样式注入：把每个 manifest 的 CSS 合进一个 `<style id="pa-custom-themes">`，只含 `[data-skin=…]` 作用域规则。
 * - 导出：默认剥掉「仅作参考」的图片（`stripReferenceImages`），不悄悄带原始参考图 / 本地路径。
 */
import { stripReferenceImages, validateThemeManifest, type ThemeManifestV1 } from "@pi-assistant/shared";
import { manifestIdFromSkin, manifestToCss, themeDefFromManifest } from "./manifest.ts";
import { registerTheme, THEMES, unregisterTheme } from "./registry.ts";

export const CUSTOM_THEMES_KEY = "pia.customThemes";
export const CUSTOM_STYLE_ID = "pa-custom-themes";

export interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function safeStorage(): StorageLike | null {
	try {
		return typeof localStorage !== "undefined" ? localStorage : null;
	} catch {
		return null;
	}
}

/** 生成稳定 id（仅作 key，绝不作路径）。 */
export function newThemeId(): string {
	const c = globalThis.crypto as Crypto | undefined;
	if (c?.randomUUID) return c.randomUUID();
	return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 读入并逐条校验（坏数据丢弃）。 */
export function loadCustomThemes(storage: StorageLike | null = safeStorage()): ThemeManifestV1[] {
	if (!storage) return [];
	const raw = storage.getItem(CUSTOM_THEMES_KEY);
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: ThemeManifestV1[] = [];
	const seen = new Set<string>();
	for (const item of parsed) {
		const r = validateThemeManifest(item);
		if (r.ok && !seen.has(r.manifest.id)) {
			seen.add(r.manifest.id);
			out.push(r.manifest);
		}
	}
	return out;
}

function writeAll(list: ThemeManifestV1[], storage: StorageLike | null = safeStorage()) {
	if (!storage) return;
	storage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(list));
}

/** 内置主题 id 保护：不能覆盖 / 删除。 */
export function isBuiltinSkin(skin: string): boolean {
	return THEMES.some((t) => t.id === skin);
}

export type SaveResult = { ok: true; manifest: ThemeManifestV1 } | { ok: false; errors: { path: string; message: string }[] };

/**
 * 新增或更新一个自定义主题。
 * - 编辑已有：保留 `createdAt`，刷新 `updatedAt`（stable id）。
 * - 保存前必须通过校验（fail-closed）。
 * - 拒绝用内置 id 覆盖内置主题。
 */
export function saveCustomTheme(input: unknown, storage: StorageLike | null = safeStorage()): SaveResult {
	const r = validateThemeManifest(input);
	if (!r.ok) return { ok: false, errors: r.errors.map((e) => ({ path: e.path, message: e.message })) };
	const manifest = r.manifest;
	if (isBuiltinSkin(manifest.id)) return { ok: false, errors: [{ path: "id", message: "不能覆盖内置主题，请用「另存为新主题」" }] };
	const list = loadCustomThemes(storage);
	const idx = list.findIndex((m) => m.id === manifest.id);
	const now = new Date().toISOString();
	if (idx >= 0) {
		const next: ThemeManifestV1 = { ...manifest, createdAt: list[idx].createdAt, updatedAt: now };
		list[idx] = next;
		writeAll(list, storage);
		return { ok: true, manifest: next };
	}
	const next: ThemeManifestV1 = { ...manifest, createdAt: manifest.createdAt || now, updatedAt: now };
	list.push(next);
	writeAll(list, storage);
	return { ok: true, manifest: next };
}

/** 删除一个自定义主题（内置不可删）。返回是否删掉了。 */
export function deleteCustomTheme(id: string, storage: StorageLike | null = safeStorage()): boolean {
	if (isBuiltinSkin(id)) return false;
	const list = loadCustomThemes(storage);
	const next = list.filter((m) => m.id !== id);
	if (next.length === list.length) return false;
	writeAll(next, storage);
	return true;
}

/** 导出：默认剥掉「仅作参考」的图片，只保留用户显式选定的主题素材（默认不含任何图片）。 */
export function exportCustomTheme(manifest: ThemeManifestV1, opts: { includeAssets?: boolean } = {}): string {
	const out = opts.includeAssets ? manifest : stripReferenceImages(manifest);
	return JSON.stringify(out, null, 2);
}

export type ImportResult = { ok: true; manifest: ThemeManifestV1; renamed: boolean } | { ok: false; errors: { path: string; message: string }[] };

/**
 * 导入 JSON：校验后落库。若 id 与已有自定义主题冲突，**分配新 id**（导入不覆盖已有主题），
 * 并保留文件里的 `createdAt`（无则用当前时间）。
 */
export function importCustomTheme(json: string, storage: StorageLike | null = safeStorage()): ImportResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (e) {
		return { ok: false, errors: [{ path: "", message: `不是合法 JSON：${(e as Error).message}` }] };
	}
	const r = validateThemeManifest(parsed);
	if (!r.ok) return { ok: false, errors: r.errors.map((e) => ({ path: e.path, message: e.message })) };
	let manifest = r.manifest;
	const exists = loadCustomThemes(storage).some((m) => m.id === manifest.id) || isBuiltinSkin(manifest.id);
	let renamed = false;
	if (exists) {
		manifest = { ...manifest, id: newThemeId() };
		renamed = true;
	}
	const saved = saveCustomTheme(manifest, storage);
	return saved.ok ? { ok: true, manifest: saved.manifest, renamed } : { ok: false, errors: saved.errors };
}

/** 把已保存的自定义主题注册进注册表并注入 CSS（幂等）。 */
export function installCustomThemes(storage: StorageLike | null = safeStorage()): ThemeManifestV1[] {
	const list = loadCustomThemes(storage);
	for (const m of list) registerTheme(themeDefFromManifest(m));
	applyCustomStyles(list);
	return list;
}

/** 重新注入所有自定义主题的 CSS（保存 / 删除后调用）。 */
export function refreshCustomStyles(storage: StorageLike | null = safeStorage()) {
	applyCustomStyles(loadCustomThemes(storage));
}

/**
 * 取消预览时移除运行时注册：**仅当该 skin 不是已保存的 DIY 主题**时才移除。
 * 编辑已有主题再取消，注册必须保留 —— 否则 applyTheme 找不到主题会回退到默认主题，
 * 用户会看到自己的主题“消失”（预览事务的 saved 标记只记本轮是否保存，不够）。
 */
export function unregisterPreviewTheme(skin: string, storage: StorageLike | null = safeStorage()): void {
	const id = manifestIdFromSkin(skin);
	if (id && loadCustomThemes(storage).some((m) => m.id === id)) return;
	unregisterTheme(skin);
}

function applyCustomStyles(list: ThemeManifestV1[]) {
	if (typeof document === "undefined") return;
	let el = document.getElementById(CUSTOM_STYLE_ID) as HTMLStyleElement | null;
	if (!el) {
		el = document.createElement("style");
		el.id = CUSTOM_STYLE_ID;
		document.head.appendChild(el);
	}
	el.textContent = list.map(manifestToCss).join("\n");
}

/** 删除后收尾：从注册表移除、重刷 CSS。 */
export function removeCustomThemeEverywhere(id: string, storage: StorageLike | null = safeStorage()): boolean {
	if (!deleteCustomTheme(id, storage)) return false;
	unregisterTheme(`custom-${id}`);
	refreshCustomStyles(storage);
	return true;
}
