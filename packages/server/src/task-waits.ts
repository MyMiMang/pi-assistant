/**
 * 任务等待（DESIGN §25「可靠 + 省无效 token 的任务调度」）：
 *
 * 模型不再用 sleep / 轮询去盯任务，而是调用 task_wait 登记一次**持久等待**，然后**由模型自己结束这一轮**。
 * 这是合作式结束、不是强制 yield：工具只写一条记录并返回一句提示，不阻塞、不中断模型；Pi 的 prompt 循环
 * 只有等模型停止输出后才会自然结束、会话变空闲（不是常驻模型循环，也不会无限 hang）。模型是否照做由
 * mock 集成测试证明（会话确实 settle、等待期零模型调用），不能拿之后的 waker triggerTurn 当 yield 证据。
 * 之后由本模块在「事件到点 / 内部任务或子代理结束 / 外部 provider（GitHub Actions run）状态变化」时，
 * 做**一次**结构化增量唤醒（runtime.nudge）。等待期间只在程序里检查，不调用模型。
 *
 * 唤醒投递的可靠性：`fired`（已判定有结果）与 `delivered`（已把唤醒交给 runtime）分开持久化。waker 失败
 * 会有限重试并留痕，重启后继续补投；**不承诺 exactly-once**，崩溃窗口内可能重复投递，唤醒词带等待 id
 * 作为幂等线索，模型据此避免重复已完成的操作。
 *
 * 复用现有链路，不新造大调度框架：
 *  - 状态落 SQLite（tasks / subagents 已有各自的表，这里只加一张 task_waits 记录「在等什么」）；
 *  - 事件来源：bus 的 `task.updated` / `subagent.updated` 快速通道；
 *  - 兜底：cron 式的本地 timer（tickWaits），事件丢了也能到点/按间隔重查；
 *  - 唤醒：复用 runtime().nudge()（和 followup / routine 同一套隐藏触发）。
 *
 * 安全约束：provider 检查只允许内置的、参数经过校验的**固定端点**（GitHub Actions REST API），
 * **不保存也不执行任何用户提供的 shell / eval 回调**。
 */
import { bus } from "./bus.ts";
import { db, now, uid } from "./db.ts";
import { parseWhen } from "./proactive.ts";

export type WaitTargetKind = "task" | "subagent" | "github_run" | "due";
export type WaitStatus = "waiting" | "fired" | "cancelled";

export interface TaskWait {
	id: string;
	agent_id: string;
	conversation_id: string | null;
	target_kind: WaitTargetKind;
	target_ref: string | null;
	reason: string;
	status: WaitStatus;
	check_interval_ms: number;
	next_check_at: number | null;
	due_at: number | null;
	last_checked_at: number | null;
	check_count: number;
	last_state: string | null;
	last_error: string | null;
	fired_reason: string | null;
	outcome: string | null;
	/** 唤醒投递状态：waiting 时为 null；fired 后 pending → delivered / failed */
	delivery_status: "pending" | "delivered" | "failed" | null;
	delivery_attempts: number;
	delivered_at: number | null;
	last_delivery_error: string | null;
	next_delivery_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface RegisterWaitInput {
	taskId?: string;
	subagentId?: string;
	githubRun?: { repo: string; runId?: number; branch?: string };
	/** 纯时间等待，或其它等待的兜底截止时间（时间戳） */
	dueAt?: number;
	/** 兜底检查间隔（毫秒，默认 5 分钟，最小 1 分钟） */
	checkIntervalMs?: number;
	reason: string;
}

export const WAIT_MIN_INTERVAL_MS = 60_000;
export const WAIT_DEFAULT_INTERVAL_MS = 5 * 60_000;
/** 各类等待的兜底截止时间（超过就唤醒，不再干等） */
const DEFAULT_DUE_MS: Record<WaitTargetKind, number> = {
	task: 6 * 3600_000,
	subagent: 2 * 3600_000,
	github_run: 30 * 60_000,
	due: 0,
};

const SUBAGENT_TERMINAL = new Set(["done", "failed", "stopped", "timeout", "lost"]);
const TASK_TERMINAL = new Set(["done", "failed", "cancelled"]);

db.exec(`CREATE TABLE IF NOT EXISTS task_waits (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation_id TEXT,
 target_kind TEXT NOT NULL, target_ref TEXT, reason TEXT NOT NULL, status TEXT NOT NULL,
 check_interval_ms INTEGER NOT NULL, next_check_at INTEGER, due_at INTEGER,
 last_checked_at INTEGER, check_count INTEGER NOT NULL DEFAULT 0,
 last_state TEXT, last_error TEXT, fired_reason TEXT, outcome TEXT,
 delivery_status TEXT, delivery_attempts INTEGER NOT NULL DEFAULT 0, delivered_at INTEGER,
 last_delivery_error TEXT, next_delivery_at INTEGER,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_waits_agent ON task_waits(agent_id, created_at);
CREATE INDEX IF NOT EXISTS task_waits_due ON task_waits(status, next_check_at);
`);

/** 缺列迁移（新列只追加，不动老数据） */
{
	const cols = (db.prepare("PRAGMA table_info(task_waits)").all() as { name: string }[]).map((c) => c.name);
	const added = new Set<string>();
	for (const [name, ddl] of [
		["outcome", "TEXT"],
		["last_error", "TEXT"],
		["delivery_status", "TEXT"],
		["delivery_attempts", "INTEGER NOT NULL DEFAULT 0"],
		["delivered_at", "INTEGER"],
		["last_delivery_error", "TEXT"],
		["next_delivery_at", "INTEGER"],
	] as const) if (!cols.includes(name)) { db.exec(`ALTER TABLE task_waits ADD COLUMN ${name} ${ddl}`); added.add(name); }
	// 升级前的 fired 行没有投递记录：旧实现只在内存里投递过一次，无从判断是否送达。
	// 保守地视为已送达，避免升级瞬间把所有历史 fired 重新唤醒一遍（新的 fired 行才会写 pending）。
	if (added.has("delivery_status")) db.prepare("UPDATE task_waits SET delivery_status = 'delivered', delivered_at = COALESCE(delivered_at, updated_at) WHERE status = 'fired' AND delivery_status IS NULL").run();
}

// 索引依赖新增列，必须在旧表补列后创建。
db.exec("CREATE INDEX IF NOT EXISTS task_waits_delivery ON task_waits(status, delivery_status, next_delivery_at)");

// ---------------------------------------------------------------- provider（固定、安全的外部检查）
export interface GithubRunRef { repo: string; runId?: number; branch?: string }
export interface ProviderState {
	state: "pending" | "completed" | "unknown";
	conclusion?: string | null;
	title?: string;
	url?: string;
	detail?: string;
}
export type WaitProviderRunner = (ref: GithubRunRef) => Promise<ProviderState>;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const isSafeRepo = (s: string) => REPO_RE.test(s);
const isSafeRunId = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) < 1e15;
const isSafeBranch = (s: string) => /^[A-Za-z0-9_.\/-]{1,120}$/.test(s);

function ghHeaders(): Record<string, string> {
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
	return { Accept: "application/vnd.github+json", "User-Agent": "pi-assistant", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
interface GhRun { status?: string; conclusion?: string | null; display_title?: string; html_url?: string; head_branch?: string }
const mapRun = (r: GhRun): ProviderState => ({ state: r.status === "completed" ? "completed" : "pending", conclusion: r.conclusion ?? null, title: r.display_title, url: r.html_url, detail: r.head_branch ? `分支 ${r.head_branch}` : undefined });

const bodyMessage = (s: string): string => {
	try {
		const m = (JSON.parse(s) as { message?: string }).message;
		if (m) return m.slice(0, 200);
	} catch {
		// 不是 JSON 就当纯文本
	}
	return s ? s.slice(0, 200) : "";
};
/** 把 GitHub 的限流 / 认证失败翻译成用户能看懂的提示；绝不回显 token。 */
function githubError(status: number, remaining: string | null, reset: string | null, body: string): Error {
	const hint = bodyMessage(body);
	const resetAt = reset && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : null;
	if (status === 401) return new Error(`GitHub 认证失败（token 无效或已过期）${hint ? `：${hint}` : ""}。请检查 GITHUB_TOKEN/GH_TOKEN。`);
	if (status === 429 || (status === 403 && remaining === "0")) return new Error(`GitHub 接口限流（${remaining === "0" ? "配额已用完" : "请求过多"}${resetAt ? `，约 ${resetAt} 重置` : ""}）；匿名访问公开仓库只有每小时 60 次，配 GITHUB_TOKEN/GH_TOKEN 可提高限额。`);
	if (status === 403) return new Error(`GitHub 拒绝访问（403）${hint ? `：${hint}` : ""}；私有仓库需要有效 token，或该 token 没有 actions:read 权限。`);
	return new Error(`GitHub API ${status}${hint ? `：${hint}` : ""}`);
}

/**
 * 内置的 GitHub Actions run 检查：只请求**固定**的 api.github.com 端点，owner/repo、run id、分支先校验；
 * 不执行任何用户提供的命令 / eval 回调。公开仓库免登录；私有仓库用**进程已有的** GITHUB_TOKEN / GH_TOKEN（只读）。
 * 不读取凭据文件、不打印 token；限流 / 认证失败会给出明确提示，交由等待的 `last_error` 记录，不会静默。
 */
export async function runGithubRun(ref: GithubRunRef): Promise<ProviderState> {
	if (!isSafeRepo(ref.repo)) throw new Error("仓库格式应为 owner/repo");
	if (ref.runId !== undefined && !isSafeRunId(ref.runId)) throw new Error("run_id 应为正整数");
	if (ref.branch !== undefined && !isSafeBranch(ref.branch)) throw new Error("分支名包含不允许的字符");
	const url = ref.runId !== undefined
		? `https://api.github.com/repos/${ref.repo}/actions/runs/${ref.runId}`
		: `https://api.github.com/repos/${ref.repo}/actions/runs?per_page=1${ref.branch ? `&branch=${encodeURIComponent(ref.branch)}` : ""}`;
	const res = await fetch(url, { headers: ghHeaders(), signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw githubError(res.status, res.headers.get("x-ratelimit-remaining"), res.headers.get("x-ratelimit-reset"), await res.text().catch(() => ""));
	const data = (await res.json()) as GhRun & { workflow_runs?: GhRun[] };
	const r = ref.runId !== undefined ? data : data.workflow_runs?.[0];
	if (!r) return { state: "unknown", detail: "没有找到对应的 workflow run" };
	return mapRun(r);
}

let providerRunner: WaitProviderRunner = runGithubRun;
export function setWaitProviderRunner(fn: WaitProviderRunner) { providerRunner = fn; }
export function resetWaitProviderRunner() { providerRunner = runGithubRun; }

// ---------------------------------------------------------------- 唤醒（由 runtime 注入，测试注入假实现）
export interface WaitWake { wait: TaskWait; prompt: string; outcome: ProviderState & { at: number } }
export type WaitWaker = (w: WaitWake) => void | Promise<void>;
let waker: WaitWaker | null = null;
export function setWaitWaker(fn: WaitWaker | null) { waker = fn; }
/** 本进程已经派发过的唤醒（防止 tick 与 bus 事件并发重复唤醒；真正去重仍以 DB 的 fired 状态为准） */
const waking = new Set<string>();

const changed = (agentId: string) => bus.emit({ type: "task-waits.changed", agentId });
export const listWaits = (agentId?: string, opts: { status?: WaitStatus } = {}) => {
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (agentId) (where.push("agent_id = ?"), args.push(agentId));
	if (opts.status) (where.push("status = ?"), args.push(opts.status));
	return db.prepare(`SELECT * FROM task_waits ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT 100`).all(...args) as unknown as TaskWait[];
};
export const getWait = (id: string) => db.prepare("SELECT * FROM task_waits WHERE id = ?").get(id) as TaskWait | undefined;

/**
 * 跨机制去重：这个子代理的终态唤醒是否已由一条 task_wait 负责（复用 task_waits 的持久投递状态）。
 *  - `none`：没有等待（或等待已取消 / 投递彻底失败）→ 走子代理自身的自动 notify。
 *  - `pending`：等待已登记或正在投递 → notify 让位，等它送达后再收尾，避免「终态唤醒两次」。
 *  - `delivered`：等待已送达 → notify 只收尾（标记事件已投递），不再唤醒。
 * 只看 waiting / fired：取消掉的等待不再拥有唤醒，交回 notify，保证不丢也不重。
 */
export function subagentWakeOwner(subagentId: string, agentId: string): "none" | "pending" | "delivered" {
	const rows = db.prepare("SELECT status, delivery_status FROM task_waits WHERE target_kind = 'subagent' AND target_ref = ? AND agent_id = ? AND status IN ('waiting','fired')").all(subagentId, agentId) as { status: string; delivery_status: string | null }[];
	let pending = false;
	for (const r of rows) {
		if (r.status === "fired" && r.delivery_status === "delivered") return "delivered";
		// waiting 一定还没投递；fired 里 pending / 还没写过投递状态（旧数据）都算待投递；failed 不再拥有唤醒
		if (r.status === "waiting" || r.delivery_status === null || r.delivery_status === "pending") pending = true;
	}
	return pending ? "pending" : "none";
}

/** 登记一次等待（同一个会话对同一个目标只留一条 waiting，避免重复等待重复唤醒）。 */
export function registerWait(agentId: string, conversationId: string | null, input: RegisterWaitInput): TaskWait {
	const reason = (input.reason ?? "").trim();
	if (!reason) throw new Error("请说明在等什么、唤醒后要做什么");
	const targets: WaitTargetKind[] = [];
	if (input.taskId) targets.push("task");
	if (input.subagentId) targets.push("subagent");
	if (input.githubRun) targets.push("github_run");
	if (targets.length > 1) throw new Error("一次只等一件事：task_id / subagent_id / github_run 只能给一个");
	if (!targets.length && input.dueAt === undefined) throw new Error("请指定要等的东西（task_id / subagent_id / github_run）或到点时间");
	if (input.githubRun && !isSafeRepo(input.githubRun.repo)) throw new Error("仓库格式应为 owner/repo");
	const kind: WaitTargetKind = targets[0] ?? "due";
	const ref = kind === "task" ? input.taskId! : kind === "subagent" ? input.subagentId! : kind === "github_run" ? JSON.stringify({ repo: input.githubRun!.repo, runId: input.githubRun!.runId ?? null, branch: input.githubRun!.branch ?? null }) : null;
	const interval = Math.max(WAIT_MIN_INTERVAL_MS, Math.round(input.checkIntervalMs ?? WAIT_DEFAULT_INTERVAL_MS));
	const t = now();
	const dueAt = input.dueAt ?? t + DEFAULT_DUE_MS[kind];
	// 去重：同一会话 + 同一目标已有 waiting → 复用（更新原因/截止）
	const dup = db.prepare("SELECT * FROM task_waits WHERE status = 'waiting' AND agent_id = ? AND COALESCE(conversation_id,'') = ? AND target_kind = ? AND COALESCE(target_ref,'') = ? ORDER BY created_at DESC LIMIT 1").get(agentId, conversationId ?? "", kind, ref ?? "") as TaskWait | undefined;
	const nextCheck = kind === "due" ? dueAt : kind === "github_run" ? Math.min(dueAt, t + interval) : t;
	if (dup) {
		db.prepare("UPDATE task_waits SET reason = ?, due_at = ?, check_interval_ms = ?, next_check_at = ?, updated_at = ? WHERE id = ?").run(reason, dueAt, interval, nextCheck, t, dup.id);
		changed(agentId);
		return getWait(dup.id)!;
	}
	const id = uid("tw");
	db.prepare(
		"INSERT INTO task_waits(id, agent_id, conversation_id, target_kind, target_ref, reason, status, check_interval_ms, next_check_at, due_at, check_count, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)",
	).run(id, agentId, conversationId, kind, ref, reason.slice(0, 2000), "waiting", interval, Math.min(dueAt, t + interval), dueAt, t, t);
	changed(agentId);
	return getWait(id)!;
}

export function cancelWait(id: string, reason = "已取消"): boolean {
	const r = db.prepare("UPDATE task_waits SET status = 'cancelled', fired_reason = ?, updated_at = ? WHERE id = ? AND status = 'waiting'").run(reason, now(), id);
	if (r.changes) { const w = getWait(id); if (w) changed(w.agent_id); }
	return r.changes > 0;
}
/** 任务被取消 / 会话被停止：连带取消它的等待，不再唤醒。 */
export function cancelWaitsForTask(taskId: string, reason = "任务已取消"): number {
	return Number(db.prepare("UPDATE task_waits SET status = 'cancelled', fired_reason = ?, updated_at = ? WHERE status = 'waiting' AND target_kind = 'task' AND target_ref = ?").run(reason, now(), taskId).changes);
}
export function cancelWaitsForConversation(conversationId: string, reason = "用户停止了任务"): number {
	return Number(db.prepare("UPDATE task_waits SET status = 'cancelled', fired_reason = ?, updated_at = ? WHERE status = 'waiting' AND conversation_id = ?").run(reason, now(), conversationId).changes);
}

// ---------------------------------------------------------------- 状态读取
type Outcome = ProviderState & { at: number };
function taskOutcome(id: string): Outcome | null {
	const t = db.prepare("SELECT status, result, error, finished_at FROM tasks WHERE id = ?").get(id) as { status: string; result: string | null; error: string | null } | undefined;
	if (!t) return { state: "unknown", detail: `任务 ${id} 不存在（可能已被删除）`, at: now() };
	if (!TASK_TERMINAL.has(t.status)) return null;
	if (t.status === "done") return { state: "completed", detail: (t.result ?? "").slice(0, 1500) || "任务完成", at: now() };
	return { state: "unknown", conclusion: t.status, detail: t.error ?? (t.status === "cancelled" ? "任务已取消" : "任务失败"), at: now() };
}
function subagentOutcome(id: string): Outcome | null {
	const r = db.prepare("SELECT status, result_summary, error_reason FROM subagents WHERE id = ?").get(id) as { status: string; result_summary: string | null; error_reason: string | null } | undefined;
	if (!r) return { state: "unknown", detail: `子代理 ${id} 不存在`, at: now() };
	if (!SUBAGENT_TERMINAL.has(r.status)) return null;
	if (r.status === "done") return { state: "completed", detail: (r.result_summary ?? "").slice(0, 1500) || "子代理完成", at: now() };
	return { state: "unknown", conclusion: r.status, detail: r.error_reason ?? `子代理已结束（${r.status}）`, at: now() };
}
function githubRef(w: TaskWait): GithubRunRef | null {
	try { const r = JSON.parse(w.target_ref ?? "{}") as { repo?: string; runId?: number | null; branch?: string | null }; return r.repo ? { repo: r.repo, runId: r.runId ?? undefined, branch: r.branch ?? undefined } : null; } catch { return null; }
}

/** 现在这个等待对应目标的即时状态：null = 还没结束（继续等）。 */
export async function currentOutcome(w: TaskWait): Promise<Outcome | null> {
	if (w.target_kind === "task") return taskOutcome(w.target_ref!);
	if (w.target_kind === "subagent") return subagentOutcome(w.target_ref!);
	if (w.target_kind === "github_run") {
		const ref = githubRef(w);
		if (!ref) return { state: "unknown", detail: "等待记录里的 GitHub run 参数无效", at: now() };
		const r = await providerRunner(ref);
		return { ...r, at: now() };
	}
	return null;
}

/** 更新「最后检查」信息（等待未变化时也留痕，供用户查询）。 */
function markChecked(id: string, lastState: string | null, error: string | null, nextCheckAt: number, t = now()) {
	db.prepare("UPDATE task_waits SET last_checked_at = ?, check_count = check_count + 1, last_state = ?, last_error = ?, next_check_at = ?, updated_at = ? WHERE id = ?").run(t, lastState, error, nextCheckAt, t, id);
}

/** 触发一次唤醒：原子地只从 waiting 转 fired 一次（重复事件 / tick 并发只会有一个 changes=1）。
 *  转为 fired 后异步投递；投递结果单独记 delivery_status，失败由 tick 重试，不把失败当已送达。 */
export function fireWait(id: string, reason: string, outcome: Outcome): boolean {
	const t = now();
	const n = db.prepare("UPDATE task_waits SET status = 'fired', fired_reason = ?, outcome = ?, last_checked_at = ?, updated_at = ?, delivery_status = 'pending', delivery_attempts = 0, next_delivery_at = ? WHERE id = ? AND status = 'waiting'").run(reason, JSON.stringify(outcome), outcome.at, t, t, id).changes;
	if (!n) return false;
	const w = getWait(id);
	if (!w) return false;
	changed(w.agent_id);
	void dispatchWake(id);
	return true;
}

/** 唤醒投递最多尝试几次；超过后记为 failed 并保留 fired 记录等待人工处理，不再无限重试。 */
export const MAX_DELIVERY_ATTEMPTS = 5;

function parseOutcome(w: TaskWait): Outcome {
	try { return w.outcome ? (JSON.parse(w.outcome) as Outcome) : { state: "unknown", detail: "（无结果信息）", at: now() }; }
	catch { return { state: "unknown", detail: "（结果信息无法解析）", at: now() }; }
}
function markDelivered(id: string, attempts: number) {
	const t = now();
	db.prepare("UPDATE task_waits SET delivery_status = 'delivered', delivery_attempts = ?, delivered_at = ?, last_delivery_error = NULL, updated_at = ? WHERE id = ?").run(attempts, t, t, id);
}
function markDeliveryFailed(id: string, agentId: string, attempts: number, err: unknown) {
	const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
	const t = now();
	if (attempts >= MAX_DELIVERY_ATTEMPTS) {
		db.prepare("UPDATE task_waits SET delivery_status = 'failed', delivery_attempts = ?, last_delivery_error = ?, updated_at = ? WHERE id = ?").run(attempts, msg, t, id);
		console.warn(`[task-waits] 唤醒投递连续失败 ${attempts} 次，已保留 fired 记录待处理（等待 ${id}）：${msg}`);
	} else {
		// 退避重试，由下次 tick 补投；等待 id 不变，重复送达可幂等处理
		db.prepare("UPDATE task_waits SET delivery_status = 'pending', delivery_attempts = ?, last_delivery_error = ?, next_delivery_at = ?, updated_at = ? WHERE id = ?").run(attempts, msg, t + Math.min(5 * 60_000, 30_000 * 2 ** (attempts - 1)), t, id);
	}
	changed(agentId);
}

/** 真正把一次已 fired 的唤醒交给 runtime；成功/失败分别落库（可在重启后由 tick 补投）。 */
export function dispatchWake(id: string): Promise<void> {
	const w = getWait(id);
	if (!w || w.status !== "fired" || w.delivery_status === "delivered" || w.delivery_status === "failed") return Promise.resolve();
	if (waking.has(id)) return Promise.resolve();
	if (!waker) return Promise.resolve(); // 没装 waker（如仅查状态的进程）：保持 pending，交给能投递的进程 / 下次 tick
	waking.add(id);
	const attempt = (w.delivery_attempts ?? 0) + 1;
	let result: void | Promise<void>;
	try {
		const outcome = parseOutcome(w);
		result = waker({ wait: w, prompt: wakePrompt(w, w.fired_reason ?? "有结果了", outcome), outcome });
	} catch (e) {
		result = Promise.reject(e);
	}
	return Promise.resolve(result)
		.then(() => markDelivered(id, attempt))
		.catch((e) => markDeliveryFailed(id, w.agent_id, attempt, e))
		.finally(() => waking.delete(id));
}

/** 结构化增量唤醒词：只在这一个目标的结果之外加一句说明，不重载会话历史
 *  （这是发在**已有会话**里的一条用户不可见消息，会话历史照常存在，只是不再叠加一份重复历史）。 */
export function wakePrompt(w: TaskWait, reason: string, o: Outcome): string {
	const target = w.target_kind === "task" ? `后台任务 ${w.target_ref}` : w.target_kind === "subagent" ? `子代理 ${w.target_ref}` : w.target_kind === "github_run" ? `GitHub Actions（${w.target_ref}）` : `到点`;
	const lines = [
		"（系统通知：你之前登记的任务等待有结果了）",
		`- 等待 id：${w.id}（同一 id 可能因重试/重启补投重复送达，请以它为准去重，不要重复已完成的操作）`,
		`- 在等：${target}`,
		`- 状态：${reason}`,
		`- 结果：${o.detail ?? o.conclusion ?? "（无更多信息）"}`,
		...(o.url ? [`- 链接：${o.url}`] : []),
		`- 你当初登记的目的：${w.reason}`,
		"请只根据上面的增量信息继续（不要重新等待、也不要重复已完成的操作）；信息不明确时先核实再行动。",
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------- 手动查询 / 刷新（用户问“现在怎么样了”）
/** 立即检查一次这个等待，并返回最新状态（用户查询要及时，不等下一个 tick）。 */
export async function refreshWait(id: string): Promise<{ wait: TaskWait; outcome: Outcome | null; fired: boolean }> {
	const w = getWait(id);
	if (!w) throw new Error("等待记录不存在");
	if (w.status !== "waiting") return { wait: w, outcome: w.outcome ? (JSON.parse(w.outcome) as Outcome) : null, fired: false };
	let outcome: Outcome | null = null;
	let error: string | null = null;
	try { outcome = await currentOutcome(w); } catch (e) { error = e instanceof Error ? e.message : String(e); }
	const t = now();
	if (outcome && outcome.state !== "pending") {
		const fired = fireWait(id, outcome.state === "completed" ? "已完成" : `已结束（${outcome.conclusion ?? outcome.state}）`, outcome);
		return { wait: getWait(id)!, outcome, fired };
	}
	markChecked(id, outcome ? outcome.state : error ? "error" : "pending", error, t + w.check_interval_ms, t);
	return { wait: getWait(id)!, outcome, fired: false };
}

// ---------------------------------------------------------------- 调度
/** 每个 tick 最多做多少次 provider 检查，避免外部接口被高频打（等待未变化时只是程序检查，不花模型 token）。 */
const MAX_PROVIDER_CHECKS_PER_TICK = 5;
let ticking = false;

export async function tickWaits(at = now()): Promise<string[]> {
	if (ticking) return [];
	ticking = true;
	const fired: string[] = [];
	try {
		// 0) 补投递：已 fired 但唤醒没送达的（waker 失败重试 / 进程崩溃后恢复），按退避时间重投
		const undelivered = db.prepare("SELECT id FROM task_waits WHERE status = 'fired' AND delivery_status = 'pending' AND (next_delivery_at IS NULL OR next_delivery_at <= ?)").all(at) as unknown as { id: string }[];
		for (const r of undelivered) void dispatchWake(r.id);
		const waiting = db.prepare("SELECT * FROM task_waits WHERE status = 'waiting' ORDER BY COALESCE(next_check_at, due_at, created_at)").all() as unknown as TaskWait[];
		let providerChecks = 0;
		for (const w of waiting) {
			// 1) 到截止时间：无论何种目标都唤醒（兜底，防止事件永久丢失）
			if (w.due_at !== null && w.due_at <= at) {
				let o: Outcome | null = null;
				try { o = await currentOutcome(w); } catch { o = null; }
				const reason = w.target_kind === "due" ? "到点了" : o && o.state === "completed" ? "已完成（已在截止时间前完成）" : o && o.state === "unknown" ? `已结束（${o.conclusion ?? "未知"}）` : "等待超时，需要你确认一下";
				const outcome: Outcome = w.target_kind === "due" ? { state: "completed", detail: "约定的时间到了", at } : o ?? { state: "unknown", detail: "等待超时，事件或检查都没拿到结果", at };
				if (fireWait(w.id, reason, outcome)) fired.push(w.id);
				continue;
			}
			const dueCheck = w.next_check_at === null || w.next_check_at <= at;
			if (!dueCheck) continue;
			// 2) 任务 / 子代理：事件丢了就在这里兜底重查
			if (w.target_kind === "task" || w.target_kind === "subagent") {
				const o = w.target_kind === "task" ? taskOutcome(w.target_ref!) : subagentOutcome(w.target_ref!);
				if (o && o.state !== "pending") {
					const reason = o.state === "completed" ? "已完成" : `已结束（${o.conclusion ?? "未知"}）`;
					if (fireWait(w.id, reason, o)) fired.push(w.id);
				} else markChecked(w.id, o ? o.state : "pending", null, at + w.check_interval_ms, at);
				continue;
			}
			// 3) 外部 provider：按间隔检查，状态变化才唤醒
			if (w.target_kind === "github_run") {
				if (providerChecks >= MAX_PROVIDER_CHECKS_PER_TICK) continue;
				providerChecks++;
				try {
					const o = await currentOutcome(w);
					if (o && o.state === "completed") {
						if (fireWait(w.id, "已完成", o)) fired.push(w.id);
					} else if (o && o.state === "unknown") {
						if (fireWait(w.id, `无法确认状态（${o.detail ?? "未知"}）`, o)) fired.push(w.id);
					} else markChecked(w.id, "pending", null, at + w.check_interval_ms, at);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					markChecked(w.id, "error", msg, at + w.check_interval_ms, at);
				}
			}
		}
	} finally {
		ticking = false;
	}
	return fired;
}

// ---------------------------------------------------------------- 事件快速通道
bus.on((e) => {
	const ev = e as unknown as { type: string; task?: { id: string; status: string; result?: string | null; error?: string | null }; subagent?: { id: string; status: string; result_summary?: string | null; error_reason?: string | null } };
		if (ev.type === "task.updated" && ev.task && TASK_TERMINAL.has(ev.task.status)) {
		// 任务被用户取消：连带取消等它的等待，不再唤醒（其它终态才唤醒）
		if (ev.task.status === "cancelled") {
			cancelWaitsForTask(ev.task.id, "任务已取消");
			return;
		}
		for (const w of listWaits(undefined, { status: "waiting" })) {
			if (w.target_kind !== "task" || w.target_ref !== ev.task.id) continue;
			const o = taskOutcome(ev.task.id);
			if (o) fireWait(w.id, o.state === "completed" ? "已完成" : `已结束（${o.conclusion ?? "未知"}）`, o);
		}
	}
	if (ev.type === "subagent.updated" && ev.subagent && SUBAGENT_TERMINAL.has(ev.subagent.status)) {
		for (const w of listWaits(undefined, { status: "waiting" })) {
			if (w.target_kind !== "subagent" || w.target_ref !== ev.subagent.id) continue;
			const o = subagentOutcome(ev.subagent.id);
			if (o) fireWait(w.id, o.state === "completed" ? "已完成" : `已结束（${o.conclusion ?? "未知"}）`, o);
		}
	}
});

// ---------------------------------------------------------------- 启动
let timer: NodeJS.Timeout | null = null;
/** 重启后：waiting 立刻重查一次；已 fired 但未送达的唤醒也立刻重试补投。 */
export function resumeWaits(): number {
	const t = now();
	const recheck = Number(db.prepare("UPDATE task_waits SET next_check_at = ? WHERE status = 'waiting' AND target_kind != 'due'").run(t).changes);
	const redeliver = Number(db.prepare("UPDATE task_waits SET next_delivery_at = ? WHERE status = 'fired' AND delivery_status = 'pending'").run(t).changes);
	return recheck + redeliver;
}
export function startWaitScheduler() {
	if (timer) return;
	// 重启恢复：status='waiting' 的记录都还在，先重置检查时间，第一次 tick 会把早已到点 / 早已结束的等待唤醒
	resumeWaits();
	void tickWaits().catch(console.error);
	timer = setInterval(() => void tickWaits().catch((e) => console.warn("[task-waits]", e)), 20_000);
	timer.unref();
}
export function stopWaitScheduler() {
	if (timer) clearInterval(timer);
	timer = null;
}

// 便于上层工具做参数解析
export const parseDue = (s: string, from = now()) => parseWhen(s, from);
