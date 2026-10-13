/** 助理电脑设置（settings 表 key = "desktop"）与固定镜像 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { getSetting, setSetting } from "../db.ts";

export const IDLE_CHOICES = [5, 10, 30, 0] as const; // 0 = 从不
export interface DesktopSettings {
	/** 「给助理安装电脑」开关；关着时什么都不下载 */
	enabled: boolean;
	/** auto = 自带运行时（macOS Lima / Windows WSL2 / Linux 本机引擎）；docker = 用已装的 Docker */
	backend: "auto" | "docker";
	/** 空闲自动关机（分钟），0 = 从不 */
	idleMinutes: number;
	/** 镜像加速地址（替换 ghcr.io），例如 ghcr.nju.edu.cn；空 = 官方 */
	mirror: string;
	/** GitHub 下载加速前缀（macOS 虚拟机组件 limactl / nerdctl 用），例如 https://ghfast.top/ ；空 = 直连。下载内容按固定摘要校验 */
	fileMirror: string;
	/**
	 * 用“单独的电脑”的助理（DESIGN §15.4）：默认所有助理共用一台电脑（同一个家目录、浏览器登录状态、已装的应用），
	 * 列在这里的助理有自己的电脑（自己的家目录），和其他助理完全分开。
	 */
	separate: string[];
	/** 旧版（每个助理一台电脑）的数据已经处理过：已有自己电脑数据的助理默认保留为单独的电脑，登录状态不丢 */
	legacyMigrated: boolean;
}
const DEFAULTS: DesktopSettings = { enabled: false, backend: "auto", idleMinutes: 10, mirror: "", fileMirror: "", separate: [], legacyMigrated: false };
export const desktopSettings = (): DesktopSettings => ({ ...DEFAULTS, ...getSetting<Partial<DesktopSettings>>("desktop", {}) });

export function updateDesktopSettings(b: Partial<DesktopSettings>) {
	const cur = desktopSettings();
	if (b.enabled !== undefined) cur.enabled = !!b.enabled;
	if (b.backend !== undefined) {
		if (!["auto", "docker"].includes(b.backend)) throw new Error("运行方式不正确");
		cur.backend = b.backend;
	}
	if (b.idleMinutes !== undefined) {
		if (!(IDLE_CHOICES as readonly number[]).includes(Number(b.idleMinutes))) throw new Error("空闲关机时间只能选 5 / 10 / 30 分钟或从不");
		cur.idleMinutes = Number(b.idleMinutes);
	}
	if (b.mirror !== undefined) cur.mirror = normalizeMirror(b.mirror);
	if (b.fileMirror !== undefined) cur.fileMirror = normalizeFileMirror(b.fileMirror);
	setSetting("desktop", cur);
	return cur;
}
/** 开 / 关某个助理的“单独的电脑” */
export function setSeparate(agentId: string, on: boolean) {
	const cur = desktopSettings();
	const set = new Set(cur.separate);
	if (on) set.add(agentId);
	else set.delete(agentId);
	cur.separate = [...set];
	setSetting("desktop", cur);
	return cur;
}
export function markLegacyMigrated(separate: string[]) {
	const cur = desktopSettings();
	cur.separate = [...new Set([...cur.separate, ...separate])];
	cur.legacyMigrated = true;
	setSetting("desktop", cur);
	return cur;
}
export function normalizeMirror(s: string) {
	const m = s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
	if (m && !/^(localhost|[a-z0-9.-]+\.[a-z]{2,})(:\d+)?(\/[a-z0-9._-]+)*$/.test(m)) throw new Error("镜像加速地址格式不正确，例如 ghcr.nju.edu.cn");
	return m;
}

/** GitHub 加速前缀：https://host[/path]/，原始地址直接拼在后面 */
export function normalizeFileMirror(s: string) {
	let m = s.trim();
	if (!m) return "";
	if (!/^https?:\/\//.test(m)) m = `https://${m}`;
	if (!/^https?:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:\d+)?(\/[A-Za-z0-9._~-]+)*\/?$/.test(m)) throw new Error("下载加速地址格式不正确，例如 https://ghfast.top/");
	return m.endsWith("/") ? m : `${m}/`;
}

export interface PinnedImage {
	repository: string;
	version: string;
	digest: string | null;
	downloadBytes: number;
	diskBytes: number;
}
export const pinned: PinnedImage = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "desktop-image.json"), "utf8"));
/** PIA_DESKTOP_IMAGE 指定的自定义 / 本地开发镜像：不下载，直接用 */
export const customImage = () => (process.env.PIA_DESKTOP_IMAGE ? config.desktopImage : null);
/** 容器实际使用的本地镜像名 */
export const localImage = () => customImage() ?? `${pinned.repository}:${pinned.version}`;

/** 拉取地址：按 digest 固定（内容寻址，引擎自动校验）；还没发布 digest 时按版本 tag。加速地址只替换注册表主机。 */
export function pullRef(mirror = desktopSettings().mirror, p: PinnedImage = pinned) {
	const [host, ...rest] = p.repository.split("/");
	const repo = `${mirror || host}/${rest.join("/")}`;
	return p.digest ? `${repo}@${p.digest}` : `${repo}:${p.version}`;
}
/** 我们自己的镜像仓库名（含加速地址），硬性保护用 */
export function imageRepos() {
	const out = [pinned.repository, pullRef().replace(/[@:][^/]*$/, "")];
	const c = customImage();
	if (c) out.push(c.replace(/:[A-Za-z0-9_.-]+$/, ""));
	return out;
}
