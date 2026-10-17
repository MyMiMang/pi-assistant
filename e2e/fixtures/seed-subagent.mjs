/**
 * e2e 专用：往**本次 mkdtemp 的隔离数据目录**里种一条子代理记录（真实表结构 + 真实路由）。
 *
 * 为什么需要：子代理 UI（对话面板里的思考 / Fast 开关）只有已存在的子代理才能打开，
 * 而正常的创建路径会真的派发子代理子进程 / 模型请求。测试只需要一条可读的数据库记录，
 * 因此用本树 test fixture 直接写 `subagents` 表；**不 spawn 子代理、不发模型请求、不碰真实数据**。
 *
 * 只允许写 `run.data`（makeTempRun 建的目录）里的 `data.db`，路径不在临时目录内直接拒绝。
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export function seedSubagent(run, { id, agentId, conversationId, provider, modelId, task, status = "done", fast = null, thinking = null, resultSummary = "" }) {
	const dbPath = join(run.data, "data.db");
	if (!dbPath.startsWith(run.data)) throw new Error("seedSubagent 只允许写本次临时数据目录");
	const db = new DatabaseSync(dbPath);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const now = Date.now();
		db.prepare(
			`INSERT INTO subagents(id, agent_id, conversation_id, task, context, model_provider, model_id, model_reason, status, last_activity_at, created_at, finished_at, result_summary, fast, thinking)
			 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		).run(id, agentId, conversationId, task, "", provider, modelId, "e2e 隔离数据（未派发真实子代理）", status, now, now, status === "done" ? now : null, resultSummary, fast, thinking);
	} finally {
		db.close();
	}
}
