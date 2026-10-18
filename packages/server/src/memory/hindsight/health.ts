/**
 * 高级记忆健康状态：记录召回 / 反思 / 注入 / 记忆模型 / 附属进程每次的结果，汇总成一个等级 + 一句人话。
 *  - ok：正常；slow：能用但慢（召回经常超过 8 秒或偶尔超时）；failing：最近连续失败（已在退回基础记忆或换备用模型）
 *  - 等级或那句话变了 → 推送 memory.hindsight（界面角标刷新）
 *  - 主模型失败自动换成备用模型：通知一次
 *  - ok/slow → failing：发一条系统通知（tag memory-health；同一个问题 6 小时内不重复）；不再 failing 时发一条「已恢复」
 * 只在内存里，重启清零（重启本身就是一次重新检查）。
 */
import { bus } from "../../bus.ts";

export type HealthOp = "recall" | "reflect" | "boot" | "model" | "sidecar";
export type HealthLevel = "ok" | "slow" | "failing";
interface Sample {
	ok: boolean;
	ms?: number;
	at: number;
}
export interface OpHealth {
	total: number;
	failed: number;
	slow: number;
	lastMs?: number;
	lastError?: string;
	lastErrorAt?: number;
	lastOkAt?: number;
}
export interface MemoryHealth {
	level: HealthLevel;
	/** 一句人话：出了什么事、现在怎么兜底 */
	summary: string;
	since: number;
	ops: Partial<Record<HealthOp, OpHealth>>;
	/** 记忆模型：当前实际在用的（主模型失败时自动换到备用） */
	model?: { active: string; primary: string; switchedAt?: number; reason?: string };
}

const SLOW_MS = 8000;
const WINDOW = 20;
const NOTIFY_DEDUPE_MS = 6 * 3600_000;

const samples = new Map<HealthOp, Sample[]>();
const ops: Partial<Record<HealthOp, OpHealth>> = {};
let model: MemoryHealth["model"];
let sidecarProblem: string | null = null;
let current: MemoryHealth = { level: "ok", summary: "", since: Date.now(), ops };
let lastNotice: { key: string; at: number } | null = null;
let notifiedFailing = false;

/** 通知出口（默认 push.ts 的 notify；测试替换） */
export let notifier: (n: { title: string; body: string; tag?: string; url?: string }) => void = (n) => void import("../../push.ts").then((m) => m.notify(n)).catch(() => {});
export const setNotifier = (f: typeof notifier) => (notifier = f);

const tail = (op: HealthOp) => samples.get(op) ?? [];
/** 错误压成一句话；连接类错误翻成人话 */
const short = (e: string) => (/fetch failed|ECONNREFUSED|ECONNRESET|socket hang up/i.test(e) ? "连不上高级记忆服务" : e.replace(/\s+/g, " ").slice(0, 160));

function evaluate(): { level: HealthLevel; summary: string } {
	if (sidecarProblem) return { level: "failing", summary: `${sidecarProblem}，已临时改用基础记忆（新记忆排队，恢复后补写）` };
	const s = (op: HealthOp) => tail(op);
	const fails = (op: HealthOp) => s(op).filter((x) => !x.ok).length;
	// 最近 3 次都失败才算 failing（偶发一次不打扰用户）
	const streak = (op: HealthOp, n = 3) => s(op).length >= n && s(op).slice(-n).every((x) => !x.ok);
	if (model?.switchedAt && model.active !== model.primary) {
		return { level: streak("model") ? "failing" : "slow", summary: `主记忆模型 ${model.primary} 连续失败，已自动换成备用模型 ${model.active}` };
	}
	if (streak("model")) return { level: "failing", summary: `记忆模型调用连续失败：${ops.model?.lastError ?? "未知错误"}` };
	if (streak("recall")) return { level: "failing", summary: `记忆召回最近 ${s("recall").length} 次有 ${fails("recall")} 次失败或超时，已临时改用基础记忆` };
	if (streak("reflect", 2)) return { level: "failing", summary: `记忆反思连续失败：${ops.reflect?.lastError ?? "未知错误"}` };
	if (streak("boot")) return { level: "failing", summary: `读取整理好的记忆连续失败：${ops.boot?.lastError ?? "未知错误"}` };
	const r = s("recall");
	const slow = r.filter((x) => x.ok && (x.ms ?? 0) > SLOW_MS).length;
	if (r.length >= 3 && (fails("recall") > 0 || slow * 2 >= r.length)) return { level: "slow", summary: `记忆召回偏慢：最近 ${r.length} 次里 ${slow} 次超过 ${SLOW_MS / 1000} 秒，${fails("recall")} 次超时（超时那次用了基础记忆）` };
	return { level: "ok", summary: "" };
}

function refresh() {
	const { level, summary } = evaluate();
	const prev = current;
	if (level === prev.level && summary === prev.summary && model === prev.model) return;
	current = { level, summary, since: level === prev.level ? prev.since : Date.now(), ops, model };
	bus.emit({ type: "memory.hindsight", health: current });
	// 换到了备用模型（或又换了一个）：记忆还能用，但告诉用户一声
	if (model?.switchedAt && model.active !== prev.model?.active && level !== "failing") {
		notifier({ title: "高级记忆已换用备用模型", body: summary, tag: "memory-health", url: "/?settings=memory" });
	}
	if (level === "failing") {
		const key = summary.replace(/\d+/g, "#");
		// 同一个问题 6 小时内只提醒一次；问题变了（另一个错误）马上提醒
		if (!lastNotice || lastNotice.key !== key || Date.now() - lastNotice.at > NOTIFY_DEDUPE_MS) {
			lastNotice = { key, at: Date.now() };
			notifiedFailing = true;
			notifier({ title: "高级记忆出问题了", body: summary, tag: "memory-health", url: "/?settings=memory" });
		}
	} else if (prev.level === "failing" && notifiedFailing) {
		notifiedFailing = false;
		lastNotice = null;
		notifier({ title: "高级记忆已恢复", body: "记忆召回和整理恢复正常。", tag: "memory-health", url: "/?settings=memory" });
	}
}

/** 记一次结果 */
export function recordHealth(op: HealthOp, r: { ok: boolean; ms?: number; error?: unknown }) {
	const o = (ops[op] ??= { total: 0, failed: 0, slow: 0 });
	o.total++;
	if (r.ms !== undefined) o.lastMs = r.ms;
	if (r.ok) {
		o.lastOkAt = Date.now();
		if ((r.ms ?? 0) > SLOW_MS) o.slow++;
	} else {
		o.failed++;
		o.lastError = short(r.error instanceof Error ? r.error.message : String(r.error ?? "失败"));
		o.lastErrorAt = Date.now();
	}
	const l = samples.get(op) ?? [];
	l.push({ ok: r.ok, ms: r.ms, at: Date.now() });
	if (l.length > WINDOW) l.shift();
	samples.set(op, l);
	refresh();
}

/** 附属进程状态：error / down 时 problem 写一句话，恢复传 null */
export function setSidecarProblem(problem: string | null) {
	if (problem === sidecarProblem) return;
	sidecarProblem = problem;
	if (problem) recordHealth("sidecar", { ok: false, error: problem });
	else refresh();
}

/** 记忆模型实际在用哪个（网关切换备用模型时调用） */
export function setActiveModel(m: { active: string; primary: string; reason?: string } | null) {
	if (!m) {
		if (!model) return;
		model = undefined;
	} else {
		if (model && model.active === m.active && model.primary === m.primary) return;
		model = { ...m, switchedAt: m.active !== m.primary ? Date.now() : undefined };
	}
	refresh();
}

export const memoryHealth = (): MemoryHealth => current;

/** 计时包装：成功/失败都记一笔，错误原样抛出 */
export async function timed<T>(op: HealthOp, run: () => Promise<T>): Promise<T> {
	const t0 = Date.now();
	try {
		const r = await run();
		recordHealth(op, { ok: true, ms: Date.now() - t0 });
		return r;
	} catch (e) {
		recordHealth(op, { ok: false, ms: Date.now() - t0, error: e });
		throw e;
	}
}

/** 测试用：清零 */
export function resetHealth() {
	samples.clear();
	for (const k of Object.keys(ops)) delete ops[k as HealthOp];
	model = undefined;
	sidecarProblem = null;
	lastNotice = null;
	notifiedFailing = false;
	current = { level: "ok", summary: "", since: Date.now(), ops };
}
