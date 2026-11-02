/**
 * 长命令自动转后台（docs/design/background-commands.md）：纯逻辑，不碰 Pi / 数据库 / 界面，便于单测。
 *
 * 把命令执行后端（BashOperations：本机 / 助理电脑的 docker exec）包一层：命令跑满 `afterMs` 还没结束，
 * 就抛出 BgDetached（带作业编号）让上层工具改成返回「已转到后台」，进程本身继续跑；之后由本模块管着：
 * 输出只留末尾 `bufferBytes`、每个作业最多跑 `maxMs`、结束时通知 `hooks.onEnd`、按「所有者」整批结束。
 * 实测（scratchpad/bg-recall/exp.mjs）：工具返回后子进程不会被 Pi 杀；Pi 的 abort 信号只在前台阶段接上，转后台就断开，
 * 之后只有我们自己的 kill（用户点停止 / job_stop / 超时）会结束作业。
 */
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { BashOperations } from "./pi-adapter/index.ts";

/** 可调常量（测试里改小）；maxMs 是每个作业的上限 */
export const bgLimits = { afterMs: 5000, maxMs: 30 * 60_000, bufferBytes: 128 * 1024, resultTail: 6000, maxWaitSeconds: 120 };

export type JobStatus = "running" | "done" | "failed" | "killed" | "timeout" | "interrupted";
export interface BgJob {
	id: string;
	/** 所有者键：同一个对话（或帮手）的作业归在一起，停止时整批结束 */
	owner: string;
	agentId: string;
	conversationId: string | null;
	command: string;
	startedAt: number;
	endedAt?: number;
	status: JobStatus;
	exitCode?: number | null;
	error?: string;
}
interface Rec extends BgJob {
	buf: string;
	decoder: StringDecoder;
	/** 已被丢掉的开头字节数 */
	dropped: number;
	ac: AbortController;
	waiters: Set<() => void>;
	/** 有人正在等它的结果（job_output 等待中）：结束时不再另行通知 */
	waiting: number;
	/** 结束原因是我们主动杀的（用户停止 / job_stop / 退出）：不另行通知 */
	silent: boolean;
	timer?: NodeJS.Timeout;
}
export interface BgOwner {
	key: string;
	agentId: string;
	conversationId: string | null;
}
export interface BgHooks {
	onStart?(job: BgJob): void;
	/** 作业结束（含超时）；用户停止 / job_stop 主动结束的不走这里 */
	onEnd?(job: BgJob, tail: string): void;
	/** 任何结束（含主动结束）后的持久化回调 */
	onFinish?(job: BgJob): void;
}
export const bgHooks: BgHooks = {};

const jobs = new Map<string, Rec>();

/** 命令跑满 afterMs 转后台时，包装后的 exec 抛这个，让上层工具返回「已转后台」 */
export class BgDetached extends Error {
	constructor(readonly job: BgJob) {
		super(`background:${job.id}`);
	}
}

const pub = (r: Rec): BgJob => ({ id: r.id, owner: r.owner, agentId: r.agentId, conversationId: r.conversationId, command: r.command, startedAt: r.startedAt, endedAt: r.endedAt, status: r.status, exitCode: r.exitCode, error: r.error });

function append(r: Rec, data: Buffer | string) {
	// 按流解码：一个汉字被拆在两块输出里也不会变乱码
	r.buf += typeof data === "string" ? data : r.decoder.write(data);
	if (Buffer.byteLength(r.buf) > bgLimits.bufferBytes) {
		const keep = r.buf.slice(-Math.floor(bgLimits.bufferBytes / 2));
		r.dropped += Buffer.byteLength(r.buf) - Buffer.byteLength(keep);
		r.buf = keep;
	}
}

function finish(r: Rec, status: JobStatus, exitCode: number | null | undefined, error?: string) {
	if (r.status !== "running") return;
	r.status = status;
	r.exitCode = exitCode;
	r.error = error;
	r.endedAt = Date.now();
	if (r.timer) clearTimeout(r.timer);
	for (const w of [...r.waiters]) w();
	r.waiters.clear();
	const j = pub(r);
	try {
		bgHooks.onFinish?.(j);
		if (!r.silent && !r.waiting) bgHooks.onEnd?.(j, tailOf(r.id));
	} catch (e) {
		console.warn("[bg-job]", e instanceof Error ? e.message : e);
	}
}

/**
 * 包装执行后端：前台最多 afterMs；没结束就转后台（抛 BgDetached）。
 * 前台阶段 Pi 的中止信号会结束命令（和原来一样）；转后台后信号断开。
 */
export function withBackground(ops: BashOperations, owner: BgOwner): BashOperations {
	return {
		exec: async (command, cwd, o) => {
			const id = `job_${randomBytes(3).toString("hex")}`;
			const r: Rec = { id, owner: owner.key, agentId: owner.agentId, conversationId: owner.conversationId, command, startedAt: Date.now(), status: "running", buf: "", decoder: new StringDecoder("utf8"), dropped: 0, ac: new AbortController(), waiters: new Set(), waiting: 0, silent: false };
			let attached = false;
			const onAbort = () => r.ac.abort();
			o.signal?.addEventListener("abort", onAbort, { once: true });
			if (o.signal?.aborted) r.ac.abort();
			// 作业上限：模型给的超时（秒）与 maxMs 取小，由执行后端自己计时结束
			const limitSec = Math.min(o.timeout ?? Infinity, bgLimits.maxMs / 1000);
			const run = ops.exec(command, cwd, {
				...o,
				signal: r.ac.signal,
				timeout: limitSec,
				onData: (d) => {
					append(r, d);
					if (!attached) o.onData(d);
				},
			});
			// 转后台后的结局
			const settle = (res: { exitCode: number | null } | Error) => {
				if (res instanceof Error) {
					if (r.ac.signal.aborted) return finish(r, "killed", null);
					if (res.message.startsWith("timeout:")) return finish(r, "timeout", null, `超过 ${Math.round(limitSec / 60)} 分钟上限，已结束`);
					return finish(r, "failed", null, res.message);
				}
				// docker exec 后端超时是 SIGKILL（退出码 137）而不是抛错：按用时判成超时
				if (res.exitCode !== 0 && Date.now() - r.startedAt >= limitSec * 1000 - 500 && !r.ac.signal.aborted) return finish(r, "timeout", null, `超过 ${Math.round(limitSec / 60)} 分钟上限，已结束`);
				finish(r, res.exitCode === 0 ? "done" : "failed", res.exitCode);
			};
			let timer: NodeJS.Timeout | undefined;
			try {
				const early = await Promise.race([
					run.then((x) => ({ x }), (e: unknown) => ({ e: e instanceof Error ? e : new Error(String(e)) })),
					new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), bgLimits.afterMs))),
				]);
				if (early) {
					if ("e" in early) throw early.e; // 前台就结束（含中止 / 超时）：和原来一样交给 Pi 处理
					return early.x;
				}
			} finally {
				clearTimeout(timer);
				o.signal?.removeEventListener("abort", onAbort);
			}
			// 跑满了：转后台
			attached = true;
			jobs.set(id, r);
			bgHooks.onStart?.(pub(r));
			void run.then(settle, (e: unknown) => settle(e instanceof Error ? e : new Error(String(e))));
			throw new BgDetached(pub(r));
		},
	};
}

// ---------------------------------------------------------------- 查询 / 结束

export const getJob = (owner: string, id: string): BgJob | undefined => {
	const r = jobs.get(id);
	return r && r.owner === owner ? pub(r) : undefined;
};
export const listJobs = (owner: string): BgJob[] => [...jobs.values()].filter((r) => r.owner === owner).map(pub);
export const runningJobs = (owner: string): BgJob[] => listJobs(owner).filter((j) => j.status === "running");
export function anyRunning(agentId: string) {
	return [...jobs.values()].some((r) => r.agentId === agentId && r.status === "running");
}

/** 取作业输出末尾（含被丢掉开头的提示） */
export function tailOf(id: string, max = bgLimits.resultTail): string {
	const r = jobs.get(id);
	if (!r) return "";
	const t = r.buf.length > max ? `…（前面的输出已省略）\n${r.buf.slice(-max)}` : r.buf;
	return r.dropped && r.buf.length <= max ? `…（更早的 ${r.dropped} 字节输出已丢弃）\n${t}` : t;
}

/** 结束一个作业（主动：用户 / 助理）。返回是否真的结束了一个在跑的作业 */
export function killJob(owner: string, id: string): boolean {
	const r = jobs.get(id);
	if (!r || r.owner !== owner || r.status !== "running") return false;
	r.silent = true;
	r.ac.abort();
	// 执行后端收到 abort 会结束进程；不等它，立刻标记（后端晚到的结果会被忽略）
	finish(r, "killed", null);
	return true;
}
/** 整批结束某个所有者名下在跑的作业（用户点停止 / 会话释放）。返回结束了几个 */
export function killOwner(owner: string): number {
	let n = 0;
	for (const r of [...jobs.values()]) if (r.owner === owner && killJob(owner, r.id)) n++;
	return n;
}

/** 等作业结束（最多 seconds 秒）；返回当前状态。等待期间结束时不再另行通知 */
export async function waitJob(owner: string, id: string, seconds: number, signal?: AbortSignal): Promise<BgJob | undefined> {
	const found = jobs.get(id);
	if (!found || found.owner !== owner) return undefined;
	const r: Rec = found;
	const ms = Math.max(0, Math.min(seconds, bgLimits.maxWaitSeconds)) * 1000;
	if (r.status === "running" && ms > 0) {
		r.waiting++;
		try {
			await new Promise<void>((resolve) => {
				const t = setTimeout(done, ms);
				function done() {
					clearTimeout(t);
					signal?.removeEventListener("abort", done);
					r.waiters.delete(done);
					resolve();
				}
				r.waiters.add(done);
				signal?.addEventListener("abort", done, { once: true });
			});
		} finally {
			r.waiting--;
		}
	}
	return pub(r);
}

/** 给模型看的一行状态 */
export function jobLine(j: BgJob): string {
	const sec = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
	const dur = sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
	const st = { running: "还在运行", done: `已结束（退出码 0）`, failed: j.exitCode != null ? `已结束（退出码 ${j.exitCode}）` : `失败${j.error ? `：${j.error}` : ""}`, killed: "已被结束", timeout: j.error ?? "超时结束", interrupted: "被中断（服务重启）" }[j.status];
	return `${j.id}（${dur}）${st}：${j.command.length > 120 ? `${j.command.slice(0, 120)}…` : j.command}`;
}

/** 测试用：清空所有作业（先结束在跑的） */
export function resetJobs() {
	for (const r of jobs.values()) if (r.status === "running") (r.silent = true, r.ac.abort(), finish(r, "killed", null));
	jobs.clear();
}
