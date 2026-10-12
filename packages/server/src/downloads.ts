/**
 * 下载管理（统一的“下载状态 + 进度”）：App 自己下载的所有东西（cloudflared、uv、Hindsight 运行环境与模型、
 * Cua Driver、个人微信安装包、Pi 扩展包、助理电脑镜像……）都在这里登记，设置页用同一个组件显示：
 *   未下载 / 下载中（已下多少、总共多少、百分比）/ 已下载 / 出错（可重试）
 *
 * 用法：
 *   registerDownload({ id, name, group, size, installed: () => existsSync(...), start: () => ensureXxx() })
 *   await trackDownload(id, async (p) => { const buf = await fetchWithProgress(url, p); ... })
 * 进度变化经 bus 推 `downloads.changed`（每个条目最多每 500ms 一次），接口：GET /api/downloads、POST /api/downloads/:id。
 * 其他模块（例如助理电脑虚拟机镜像，分支 wip/assistant-computer-vm）只需 registerDownload + trackDownload 即可接入。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bus } from "./bus.ts";

export type DownloadState = "missing" | "downloading" | "ready" | "error";
export interface DownloadDef {
	id: string;
	name: string;
	/** 分组（设置页按组显示）：记忆 / 远程访问 / 操作电脑 / 渠道 / 扩展 / 助理电脑… */
	group: string;
	/** 大约大小（字节），还没开始下载时显示“约 xx MB” */
	size?: number;
	/** 已经在本地了吗（文件存在等） */
	installed: () => boolean;
	/** 开始 / 重试下载（没有则界面不显示“下载”按钮，由使用它的功能自动触发） */
	start?: () => Promise<unknown>;
	/** 不需要 / 不适用于这台电脑时隐藏 */
	hidden?: () => boolean;
}
export interface DownloadInfo {
	id: string;
	name: string;
	group: string;
	state: DownloadState;
	received: number;
	total: number | null;
	percent: number | null;
	size: number | null;
	detail: string | null;
	error: string | null;
	canStart: boolean;
}
export interface Progress {
	/** 已收到 / 总字节（总数未知传 null） */
	bytes(received: number, total: number | null): void;
	/** 阶段说明（例如“正在解压…”“安装 Python 依赖…”） */
	detail(text: string): void;
}

const defs = new Map<string, DownloadDef>();
const live = new Map<string, { state: "downloading" | "error"; received: number; total: number | null; detail: string | null; error: string | null }>();
const lastEmit = new Map<string, number>();
const timers = new Map<string, NodeJS.Timeout>();

export function registerDownload(def: DownloadDef) {
	defs.set(def.id, def);
}
export function unregisterDownload(id: string) {
	defs.delete(id);
	live.delete(id);
}

function emit(id: string, force = false) {
	const now = Date.now();
	const fire = () => {
		timers.delete(id);
		lastEmit.set(id, Date.now());
		bus.emit({ type: "downloads.changed", item: downloadInfo(id) });
	};
	if (force || now - (lastEmit.get(id) ?? 0) > 500) {
		clearTimeout(timers.get(id));
		fire();
	} else if (!timers.has(id)) timers.set(id, setTimeout(fire, 500));
}

export function downloadInfo(id: string): DownloadInfo | null {
	const d = defs.get(id);
	if (!d) return null;
	const l = live.get(id);
	let installed = false;
	try {
		installed = d.installed();
	} catch {
		/* 当作没装 */
	}
	const state: DownloadState = l?.state === "downloading" ? "downloading" : installed ? "ready" : l?.state === "error" ? "error" : "missing";
	const total = l?.total ?? null;
	const received = l?.received ?? 0;
	return {
		id,
		name: d.name,
		group: d.group,
		state,
		received,
		total,
		percent: state === "ready" ? 100 : total ? Math.min(100, Math.floor((received / total) * 100)) : null,
		size: d.size ?? null,
		detail: state === "downloading" ? (l?.detail ?? null) : null,
		error: state === "error" ? (l?.error ?? null) : null,
		canStart: !!d.start,
	};
}

export function listDownloads(): DownloadInfo[] {
	return [...defs.values()].filter((d) => !d.hidden?.()).map((d) => downloadInfo(d.id)!);
}

/** 包住一次下载：期间状态为 downloading，成功后看 installed()，失败记错误（可重试）。未登记的 id 也能用（只是不在列表里显示） */
export async function trackDownload<T>(id: string, fn: (p: Progress) => Promise<T>): Promise<T> {
	const cur = { state: "downloading" as const, received: 0, total: null as number | null, detail: null as string | null, error: null };
	live.set(id, cur);
	emit(id, true);
	const p: Progress = {
		bytes: (r, t) => {
			cur.received = r;
			cur.total = t;
			emit(id);
		},
		detail: (t) => {
			cur.detail = t;
			emit(id);
		},
	};
	try {
		const r = await fn(p);
		live.delete(id);
		emit(id, true);
		return r;
	} catch (e) {
		live.set(id, { ...cur, state: "error", error: e instanceof Error ? e.message : String(e) });
		emit(id, true);
		throw e;
	}
}

/** 开始 / 重试（并发调用由各模块自己的 ensureXxx 合并） */
export async function startDownload(id: string) {
	const d = defs.get(id);
	if (!d?.start) throw new Error("这个组件会在用到时自动下载");
	void d.start().catch(() => {});
	return downloadInfo(id);
}

/** fetch 并按字节报告进度，返回完整内容（适合几百 MB 以内、需要校验 SHA256 的文件） */
export async function fetchWithProgress(url: string, p: Progress | undefined, init: RequestInit & { timeoutMs?: number } = {}): Promise<Buffer> {
	const res = await fetch(url, { redirect: "follow", ...init, signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 30 * 60_000) });
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
	const total = Number(res.headers.get("content-length")) || null;
	const chunks: Buffer[] = [];
	let got = 0;
	p?.bytes(0, total);
	for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
		chunks.push(Buffer.from(c));
		got += c.byteLength;
		p?.bytes(got, total);
	}
	return Buffer.concat(chunks);
}

/** 把 Web ReadableStream 包一层进度计数（流式写盘时用） */
export async function* countBytes(body: AsyncIterable<Uint8Array>, total: number | null, p?: Progress) {
	let got = 0;
	for await (const c of body) {
		got += c.byteLength;
		p?.bytes(got, total);
		yield c;
	}
}

/** 目录总大小（字节），用于“由别的进程下载”的东西（uv sync、Hindsight 拉模型）估算进度 */
export function dirSize(dir: string): number {
	let n = 0;
	const walk = (d: string) => {
		let list: import("node:fs").Dirent[];
		try {
			list = readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of list) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) n += statSync(p).size;
		}
	};
	walk(dir);
	return n;
}
/** 在 fn 执行期间每秒量一次目录大小作为进度（total 用估计值，可能不准，界面显示“约”） */
export async function watchDir<T>(dirs: string[], p: Progress, estimate: number | null, fn: () => Promise<T>): Promise<T> {
	const base = dirs.reduce((a, d) => a + dirSize(d), 0);
	const t = setInterval(() => {
		const got = Math.max(0, dirs.reduce((a, d) => a + dirSize(d), 0) - base);
		p.bytes(got, estimate && got < estimate ? estimate : null);
	}, 1000);
	try {
		return await fn();
	} finally {
		clearInterval(t);
	}
}
