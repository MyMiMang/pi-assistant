import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bindSession } from "../src/agent-runtime/bind-session.ts";
import { db, now } from "../src/db.ts";
import { compactWithFallback, refusalWillRetry } from "../src/pi-adapter/compaction-fallback.ts";

test("整理结束：无须整理不插红字，其他失败和成功照旧", () => {
	const agentId = "bind-compact";
	db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(agentId, "整理测试", "A", "#111", now());
	let emit!: (event: unknown) => void;
	const session = { subscribe: (fn: typeof emit) => { emit = fn; return () => {}; } };
	const unbind = bindSession(session as never, agentId, null, null, () => {});
	const rows = () => db.prepare("SELECT content, status FROM messages WHERE agent_id = ? ORDER BY rowid").all(agentId) as { content: string; status: string }[];
	for (const errorMessage of ["Compaction failed: Nothing to compact (session too small)", "Compaction failed: Already compacted"]) {
		emit({ type: "compaction_end", reason: "manual", aborted: false, errorMessage });
	}
	assert.equal(rows().length, 0);
	emit({ type: "compaction_end", reason: "manual", aborted: false, errorMessage: "Summarization failed: 400" });
	assert.equal(rows().length, 1);
	assert.equal(rows()[0].status, "error");
	assert.match(rows()[0].content, /整理上下文失败/);
	emit({ type: "compaction_end", reason: "manual", aborted: true, errorMessage: "aborted" });
	assert.equal(rows().length, 1);
	emit({ type: "compaction_end", reason: "manual", aborted: false, result: { tokensBefore: 150000, summary: "摘要" } });
	assert.equal(rows().length, 2);
	assert.match(rows()[1].content, /已整理上下文/);
	unbind();
});

// 在假 compact 内同步发 Pi 的结束事件，覆盖第一次事件早于 catch 的真实时序。
test("回退中的首次 400 不插红字；成功只插成功消息，最终失败照常显示", async () => {
	const agentId = "bind-compact-retry";
	db.prepare("INSERT INTO agents(id, name, avatar, color, created_at) VALUES(?,?,?,?,?)").run(agentId, "回退测试", "A", "#111", now());
	let emit!: (event: unknown) => void;
	let calls = 0;
	let failBackup = false;
	const refusal = "Compaction failed: Summarization failed: 400 内容审计";
	const rows = () => db.prepare("SELECT content, status FROM messages WHERE agent_id = ? ORDER BY rowid").all(agentId) as { content: string; status: string }[];
	const session = {
		sessionId: "bind-retry-session", model: { provider: "primary", id: "chat" },
		subscribe: (fn: typeof emit) => { emit = fn; return () => {}; },
		compact: async () => {
			if (++calls === 1) {
				const before = rows().length;
				assert.equal(refusalWillRetry(session.sessionId, refusal), true);
				emit({ type: "compaction_end", reason: "manual", aborted: false, errorMessage: refusal });
				assert.equal(rows().length, before, "第一次拒绝不插消息");
				throw new Error(refusal);
			}
			assert.equal(refusalWillRetry(session.sessionId, refusal), false);
			if (failBackup) {
				emit({ type: "compaction_end", reason: "manual", aborted: false, errorMessage: refusal });
				throw new Error(refusal);
			}
			const result = { tokensBefore: 150000, summary: "摘要" };
			emit({ type: "compaction_end", reason: "manual", aborted: false, result });
			return result;
		},
	};
	const unbind = bindSession(session as never, agentId, null, null, () => {});
	try {
		await compactWithFallback(session as never, undefined, { provider: "backup", id: "summary" });
		assert.equal(calls, 2);
		assert.equal(rows().length, 1);
		assert.match(rows()[0].content, /已整理上下文/);
		assert.notEqual(rows()[0].status, "error");
		calls = 0;
		failBackup = true;
		await assert.rejects(compactWithFallback(session as never, undefined, { provider: "backup", id: "summary" }), /400 内容审计/);
		assert.equal(calls, 2);
		assert.equal(rows().length, 2, "最终失败只增加一条错误");
		assert.equal(rows()[1].status, "error");
		assert.match(rows()[1].content, /整理上下文失败/);
		assert.equal(refusalWillRetry(session.sessionId, refusal), false);
	} finally {
		unbind();
	}
});
