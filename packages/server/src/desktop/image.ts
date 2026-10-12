/**
 * 下载助理电脑镜像：引擎自己拉取（分层下载，断了重试时已完成的层不会重下；按 digest 内容寻址校验），
 * 我们解析输出给出进度。加速地址拉下来后再打上固定的本地名字，容器统一用本地名字。
 */
import { spawn } from "node:child_process";
import { downloadInfo } from "../downloads.ts";
import { backend, engine } from "./backend.ts";
import { cancelVmDownload, imageMarked, markImage, vmPhase } from "./lima.ts";
import { customImage, localImage, pinned, pullRef } from "./settings.ts";

export interface InstallState {
	phase: "idle" | "downloading" | "done" | "error";
	/** 0–1，按层估算 */
	progress: number;
	layersDone: number;
	layersTotal: number;
	error?: string;
	startedAt?: number;
	/** 当前在做什么（macOS：下载虚拟机组件 / 开机 / 下载桌面镜像） */
	detail?: string;
}
let state: InstallState = { phase: "idle", progress: 0, layersDone: 0, layersTotal: 0 };
let current: Promise<void> | null = null;
let child: import("node:child_process").ChildProcess | null = null;
let pulling = false;
/** macOS 虚拟机后端：前 40% 是虚拟机组件下载，40–50% 是第一次开机，后 50% 是桌面镜像 */
export const installState = (): InstallState => {
	if (state.phase !== "downloading" || backend().id !== "lima") return state;
	if (pulling) return { ...state, progress: 0.5 + state.progress * 0.5, detail: "正在下载桌面镜像" };
	const d = downloadInfo("desktop-vm");
	if (d?.state === "downloading") return { ...state, progress: ((d.percent ?? 0) / 100) * 0.4, detail: d.detail ?? "正在下载虚拟机组件" };
	const ph = vmPhase();
	return { ...state, progress: 0.4 + (ph.phase === "running" ? 0.1 : 0.05), detail: ph.detail ?? "正在准备虚拟机" };
};

export async function imagePresent() {
	// 虚拟机后端：关机时不为了查镜像而开机，看下载完成时写下的标记
	if (backend().id === "lima" && !(await backend().engineRunning())) return imageMarked(localImage());
	try {
		await engine(["image", "inspect", localImage()], { timeout: 8000 });
		if (backend().id === "lima") markImage(localImage());
		return true;
	} catch {
		if (backend().id === "lima") markImage(null);
		return false;
	}
}

/** 解析 docker/podman pull 的逐行输出，更新层计数（纯函数，单测覆盖） */
export function parsePullLine(line: string, layers: Map<string, boolean>) {
	const m = /^([a-f0-9]{12}): (.+)$/.exec(line.trim());
	if (m) {
		const [, id, what] = m;
		if (/Pull complete|Already exists/i.test(what)) layers.set(id, true);
		else if (!layers.has(id)) layers.set(id, false);
		return;
	}
	const p = /^Copying blob (?:sha256:)?([a-f0-9]{12})/.exec(line.trim()); // podman
	if (p) return void layers.set(p[1], /done|skipped|already exists/i.test(line));
	// nerdctl：layer-sha256:<64位>:  downloading |+++| 1.2 MiB/30.0 MiB
	const n = /^layer-sha256:([a-f0-9]{12})[a-f0-9]*:\s+(\w+)/.exec(line.trim());
	if (n) layers.set(n[1], /^(done|exists)$/i.test(n[2]) || layers.get(n[1]) === true);
}

export function startInstall(): Promise<void> {
	if (current) return current;
	if (customImage()) {
		state = { phase: "done", progress: 1, layersDone: 0, layersTotal: 0 };
		return Promise.resolve();
	}
	state = { phase: "downloading", progress: 0, layersDone: 0, layersTotal: 0, startedAt: Date.now() };
	current = (async () => {
		const d = await backend().detect();
		if (!d.ok) throw new Error(d.reason);
		await backend().ensureEngine();
		if (await imagePresent()) return;
		pulling = true;
		const ref = pullRef();
		const layers = new Map<string, boolean>();
		const cli = backend().cli();
		for (let attempt = 0; ; attempt++) {
			try {
				await new Promise<void>((res, rej) => {
					const p = (child = spawn(cli[0], [...cli.slice(1), "pull", ref], { stdio: ["ignore", "pipe", "pipe"] }));
					let tail = "";
					const onData = (b: Buffer) => {
						const s = String(b);
						tail = (tail + s).slice(-2000);
						for (const l of s.split(/\r?\n|\r/)) parsePullLine(l, layers);
						const done = [...layers.values()].filter(Boolean).length;
						state = { ...state, layersDone: done, layersTotal: layers.size, progress: layers.size ? Math.min(0.99, done / layers.size) : 0 };
					};
					p.stdout!.on("data", onData);
					p.stderr!.on("data", onData);
					p.on("error", rej);
					p.on("exit", (code) => (code === 0 ? res() : rej(new Error(tail.trim().split("\n").pop() || `下载失败（${code}）`))));
				});
				break;
			} catch (e) {
				// 网络断开：已下载的层保留，自动重试 3 次
				if (attempt >= 2 || state.phase !== "downloading") throw e;
				await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
			}
		}
		if (ref !== localImage()) await engine(["tag", ref, localImage()]);
		if (backend().id === "lima") markImage(localImage());
	})()
		.then(() => {
			state = { ...state, phase: "done", progress: 1 };
		})
		.catch((e) => {
			state = { ...state, phase: "error", error: e instanceof Error ? e.message : String(e) };
		})
		.finally(() => {
			current = null;
			child = null;
			pulling = false;
		});
	return current;
}
export function cancelInstall() {
	state = { ...state, phase: "idle" };
	child?.kill();
	cancelVmDownload();
}
export const pinnedInfo = () => ({ ref: pullRef(), local: localImage(), version: pinned.version, digest: pinned.digest, downloadBytes: pinned.downloadBytes, diskBytes: pinned.diskBytes, custom: !!customImage() });
