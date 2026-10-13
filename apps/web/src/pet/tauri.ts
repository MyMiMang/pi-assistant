/** 桌宠窗口里调用托盘程序（Tauri）的命令；在普通浏览器里打开 /pet 预览时这些都是空操作 */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
export const tauri = (): Invoke | null => (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke ?? null;
export const inTauri = () => !!tauri();
export const call = (cmd: string, args?: Record<string, unknown>) => tauri()?.(cmd, args).catch(() => {});
/** 在主窗口里打开某个页面（不在 Tauri 里就新开浏览器标签） */
export function openMain(path = "/") {
	const t = tauri();
	if (t) void t("pet_open_main", { path }).catch(() => {});
	else window.open(path, "_blank");
}
