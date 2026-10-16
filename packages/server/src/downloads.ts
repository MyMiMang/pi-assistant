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
/** 组件自己投影给统一登记的状态（本地安装管理器等）：无 trackDownload 时首屏也能显示真实阶段。 */
export interface DownloadStatus {
	state: DownloadState;
	received?: number;
	total?: number | null;
	detail?: string | null;
	error?: string | null;
}
export interface DownloadDef {
	id: string;
	name: string;
	/** 分组（设置页按组显示）：记忆 / 远程访问 / 操作电脑 / 渠道 / 扩展 / 助理电脑… */
	group: string;
	/** 大约大小（字节），还没开始下载时显示“约 xx MB” */
	size?: number;
	/** 已经在本地了吗（文件存在等） */
	installed: () => boolean;
	/** 开始 / 重试下载（没有则界面不显示"下载"按钮，由使用它的功能自动触发） */
	start?: () => Promise<unknown>;
	/** 取消进行中的下载（可选）。同一 job 的取消走这里，不另建 controller。 */
	cancel?: () => Promise<unknown> | unknown;
	/** 直接投影组件自身的状态（安装管理器的 phase/received/total/error），比内部计数权威；用于两个入口同状态 */
	status?: () => DownloadStatus;
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
	canCancel: boolean;
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

/**
 * 把组件**自己的状态变化**转发给统一下载面板（投影 → `downloads.changed`）。
 *
 * 用途：本地 Laya / 本地 ASR 这类有自己阶段状态机的组件，在自己的 bus 事件里调用它，
 * 而不是每项再起一个永久 `setInterval` 轮询。`force=true` 用于首 / 终事件（立即推送，不走 500ms 节流）。
 * 只读 `def.status()`，不复制组件状态、不构造组件。
 */
export function notifyDownload(id: string, force = false): void {
	emit(id, force);
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
	// 组件投影（若有）比内部 trackDownload 计数权威：两个入口读同一个 job，状态一致。
	const proj = d.status?.() ?? null;
	const src: { state: DownloadState; received: number; total: number | null; detail: string | null; error: string | null } | null = proj
		? { state: proj.state, received: proj.received ?? 0, total: proj.total ?? null, detail: proj.detail ?? null, error: proj.error ?? null }
		: l
			? { state: l.state, received: l.received, total: l.total, detail: l.detail, error: l.error }
			: null;
	const state: DownloadState = installed ? "ready" : (src?.state ?? "missing");
	const total = src?.total ?? null;
	const received = src?.received ?? 0;
	return {
		id,
		name: d.name,
		group: d.group,
		state,
		received,
		total,
		percent: state === "ready" ? 100 : total ? Math.min(100, Math.floor((received / total) * 100)) : null,
		size: d.size ?? null,
		detail: state === "downloading" ? (src?.detail ?? null) : null,
		error: state === "error" ? (src?.error ?? null) : null,
		canStart: !!d.start,
		canCancel: !!d.cancel,
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

/** 取消进行中的下载 / 安装（仅登记了 cancel 的条目） */
export async function cancelDownload(id: string) {
	const d = defs.get(id);
	if (!d?.cancel) throw new Error("这个组件不支持取消");
	await d.cancel();
	return downloadInfo(id);
}

/**
 * 把“带阶段状态的组件”（本地安装管理器等）接进统一下载进度（Laya / 本地 ASR 共用，勿另写循环）：
 * 轮询 `read()`；`active` 时已知总字节→字节进度，未知→不定进度（界面 indeterminate）+ 阶段文字。
 * 同一 id 只会有一个跟踪循环；结束（成功 / 失败 / 取消）自动停止。组件应同时提供 `def.status` 投影首屏状态。
 */
export interface StatusSnapshot {
	/** 仍在进行（下载 / 安装中） */
	active: boolean;
	/** 阶段文字（用于界面 detail，不要求百分比） */
	detail?: string | null;
	received?: number;
	total?: number | null;
	error?: string | null;
}
const follows = new Set<string>();
export function followStatus(id: string, read: () => StatusSnapshot, intervalMs = 500): void {
	if (follows.has(id)) return;
	follows.add(id);
	void trackDownload(id, (p) =>
		new Promise<void>((res, rej) => {
			const tick = (): boolean => {
				const s = read();
				if (s.active) {
					p.bytes(s.received ?? 0, s.total ?? null);
					if (s.detail) p.detail(s.detail);
					return true;
				}
				if (s.error) rej(new Error(s.error));
				else res();
				return false;
			};
			if (tick()) {
				const t = setInterval(() => {
					if (!tick()) clearInterval(t);
				}, intervalMs);
			}
		}),
	)
		.catch(() => {})
		.finally(() => follows.delete(id));
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

/**
 * 大文件下载到磁盘：断点续传（`<dest>.part` + Range）、按顺序换下载源、下载完校验摘要（sha256 / sha512）再原子改名。
 * 已存在且校验通过的 dest 直接返回（重复调用很便宜：用 `<dest>.ok` 记录已校验过的摘要，不重复算哈希）。
 * 摘要不对：删掉 .part 从头再下一次；仍不对就报错（可能是下载源被篡改）。
 */
export interface FileSpec {
	urls: string[];
	dest: string;
	algo: "sha256" | "sha512";
	digest: string;
	size?: number;
}
export async function downloadFile(spec: FileSpec, p?: Progress, opts: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<string> {
	const { createHash } = await import("node:crypto");
	const { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	const f = opts.fetchImpl ?? fetch;
	const okFile = `${spec.dest}.ok`;
	if (existsSync(spec.dest) && existsSync(okFile) && readFileSync(okFile, "utf8").trim() === spec.digest) return spec.dest;
	mkdirSync(dirname(spec.dest), { recursive: true });
	const part = `${spec.dest}.part`;
	const hashOf = (file: string) =>
		new Promise<string>((res, rej) => {
			const h = createHash(spec.algo);
			createReadStream(file).on("data", (c) => h.update(c)).on("error", rej).on("end", () => res(h.digest("hex")));
		});
	// 之前下完但没记录 .ok（例如进程被杀）：校验一遍
	if (existsSync(spec.dest)) {
		if ((await hashOf(spec.dest)) === spec.digest) return (writeFileSync(okFile, spec.digest), spec.dest);
		rmSync(spec.dest, { force: true });
	}
	let lastErr: unknown = null;
	for (let round = 0; round < 2; round++) {
		for (const url of spec.urls) {
			for (let attempt = 0; attempt < 3; attempt++) {
				if (opts.signal?.aborted) throw new Error("已取消");
				try {
					let have = existsSync(part) ? statSync(part).size : 0;
					if (spec.size && have > spec.size) (rmSync(part, { force: true }), (have = 0));
					if (!spec.size || have < spec.size) {
						const res = await f(url, { redirect: "follow", headers: have ? { Range: `bytes=${have}-` } : {}, signal: opts.signal ?? AbortSignal.timeout(60 * 60_000) });
						if (res.status === 416 && have) {
							/* 服务器说已经全有了：直接校验 */
						} else {
							if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
							if (have && res.status !== 206) have = 0; // 不支持续传：从头写
							const len = Number(res.headers.get("content-length")) || null;
							const total = spec.size ?? (len ? have + len : null);
							const out = createWriteStream(part, { flags: have ? "a" : "w" });
							try {
								let got = have;
								p?.bytes(got, total);
								for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
									if (!out.write(c)) await new Promise((r) => out.once("drain", r));
									got += c.byteLength;
									p?.bytes(got, total);
								}
							} finally {
								await new Promise<void>((r) => out.end(r));
							}
						}
					}
					p?.detail("正在校验…");
					const got = await hashOf(part);
					if (got !== spec.digest) {
						rmSync(part, { force: true });
						throw new Error("文件校验失败（摘要不匹配），已丢弃");
					}
					renameSync(part, spec.dest);
					writeFileSync(okFile, spec.digest);
					return spec.dest;
				} catch (e) {
					lastErr = e;
					if (opts.signal?.aborted) throw new Error("已取消");
					if (/ENOSPC/.test(String((e as Error)?.message ?? e))) throw new Error("磁盘空间不足，下载中断（已下载的部分保留，腾出空间后重试会接着下）");
					if (/校验失败/.test(String(e))) break; // 换下一个源
					await new Promise((r) => setTimeout(r, process.env.PIA_TEST_FAST ? 10 : 2000 * (attempt + 1)));
				}
			}
		}
	}
	throw new Error(`下载失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
