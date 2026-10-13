/**
 * 磁盘占用兜底（DESIGN §16.x 日志与记录上限）：开机时和之后每 6 小时清一次，保证日志、记录不会慢慢塞满用户硬盘。
 *  - 日志文件（数据目录里的 *.log、macOS LaunchAgent 的 ~/Library/Logs/Pi Assistant、助理电脑虚拟机 Lima 的日志）：
 *    超过 20 MB 时把最后 5 MB 存成 `<名字>.old`，原文件就地截断为 0（写日志的进程用追加模式，不需要重开文件）；
 *  - 断点续传留下的 `*.part`：7 天没动过就删；
 *  - 后台任务的会话记录（agents/<id>/tasks/*.jsonl）：60 天没动过就删（任务结果本身在数据库里）；
 *  - 电脑操作记录：见 action-log.ts（2000 条 / 30 天；截图 50 张 / 7 天 / 100 MB）。
 * 用户的工作区、文件、对话会话不在清理范围。
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pruneActions } from "./action-log.ts";
import { config } from "./config.ts";

export const LOG_MAX = 20 * 1024 * 1024;
export const LOG_KEEP = 5 * 1024 * 1024;
const DAY = 86_400_000;
const SKIP = new Set(["workspace", "files", "node_modules", "mcp-packages", "models", "bin"]);

/** 超过上限：尾部存到 .old，原文件截断。返回是否动过 */
export function capLog(f: string, max = LOG_MAX, keep = LOG_KEEP) {
	let size = 0;
	try {
		size = statSync(f).size;
	} catch {
		return false;
	}
	if (size <= max) return false;
	const buf = Buffer.alloc(Math.min(keep, size));
	const fd = openSync(f, "r");
	try {
		readSync(fd, buf, 0, buf.length, size - buf.length);
	} finally {
		closeSync(fd);
	}
	writeFileSync(`${f}.old`, buf);
	truncateSync(f, 0);
	return true;
}

function walk(dir: string, depth: number, visit: (f: string, st: Stats) => void) {
	if (depth < 0 || !existsSync(dir)) return;
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const n of names) {
		const p = join(dir, n);
		let st: Stats;
		try {
			st = statSync(p);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			if (!SKIP.has(n)) walk(p, depth - 1, visit);
		} else visit(p, st);
	}
}

export function housekeeping(o: { dataDir?: string; extraLogDirs?: string[]; now?: number } = {}) {
	const dataDir = o.dataDir ?? config.dataDir;
	const t = o.now ?? Date.now();
	const out = { capped: [] as string[], removed: [] as string[] };
	walk(dataDir, 5, (f, st) => {
		if (/\.log$/.test(f) && capLog(f)) out.capped.push(f);
		else if (/\.part$/.test(f) && t - st.mtimeMs > 7 * DAY) (rmSync(f, { force: true }), out.removed.push(f));
		else if (/[\\/]agents[\\/][^\\/]+[\\/]tasks[\\/][^\\/]+\.jsonl$/.test(f) && t - st.mtimeMs > 60 * DAY) (rmSync(f, { force: true }), out.removed.push(f));
	});
	const extra = o.extraLogDirs ?? [join(homedir(), "Library", "Logs", "Pi Assistant"), join(homedir(), ".pia-vm")];
	for (const d of extra) walk(d, 3, (f) => /\.log$/.test(f) && capLog(f) && out.capped.push(f));
	try {
		pruneActions();
	} catch {}
	if (out.capped.length || out.removed.length) console.log(`[housekeeping] 截断日志 ${out.capped.length} 个，删除过期文件 ${out.removed.length} 个`);
	return out;
}

let timer: NodeJS.Timeout | null = null;
export function startHousekeeping() {
	if (timer) return;
	setTimeout(() => housekeeping(), 30_000).unref();
	timer = setInterval(() => housekeeping(), 6 * 3600_000);
	timer.unref();
}
