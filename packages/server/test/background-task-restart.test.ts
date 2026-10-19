/**
 * 后台任务（含定时 / 巡检）= 帮手（决策 0014 第 4 步）：旧 tasks 表迁到 subagents（同 id），
 * 重启判定直接走子代理那一套（recoverSubagents）：会话里没有「已派发、结果未落库」的工具调用 → 排队续跑
 * （只发续跑提示，不重发原任务）；否则标 lost（中断待核验），不自动重放；用户点继续后在原会话里先核验再续。
 * 只用临时数据 + Mock 模型 + 内存凭据。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { memoryCredentialStore } from "./in-memory-credentials.ts";
process.env.PIA_MOCK = "1";
const { db, now } = await import("../src/db.ts");
const { initModels } = await import("../src/models.ts");
await initModels(memoryCredentialStore());
const { tasks, getTask } = await import("../src/runtime.ts"); // 接好帮手驱动
const { migrateLegacyTasks } = await import("../src/agent-runtime/background-tasks.ts");
const { recoverSubagents, getSubagent } = await import("../src/subagents.ts");
const { createConversation } = await import("../src/conversations.ts");
const { listMessages } = await import("../src/messages.ts");

db.prepare("INSERT INTO agents(id, name, avatar, color, persona, created_at) VALUES(?,?,'🔧','#888','',?)").run("bt-test", "测试", Date.now());
const conv = createConversation("bt-test").id;

/** 造一个真实落库会话：pending=true 时最后一个工具调用没有结果（重启时结果未知）。 */
function sessionFile(pending: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "pia-bt-sess-"));
	const sm = SessionManager.create(dir, join(dir, "sessions"));
	sm.appendMessage({ role: "user", content: "整理文件" } as never);
	sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "先跑命令" }, { type: "toolCall", id: "c1", name: "bash", arguments: {} }] } as never);
	if (!pending) sm.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "ok" }] } as never);
	return sm.getSessionFile()!;
}
/** 旧版本留下的 tasks 行（迁移前的数据） */
function legacyTask(id: string, file: string | null, extra: { kind?: string; status?: string; result?: string } = {}) {
	const st = extra.status ?? "running";
	db.prepare("INSERT INTO tasks(id, agent_id, conversation_id, title, instructions, status, kind, session_file, result, created_at, started_at, finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, "bt-test", conv, `任务${id}`, "整理文件", st, extra.kind ?? null, file, extra.result ?? null, now(), now(), st === "running" ? null : now());
}
const settle = async (id: string, want: string[]) => {
	for (let i = 0; i < 200 && !want.includes(getTask(id)!.status); i++) await new Promise((r) => setTimeout(r, 25));
	return getTask(id)!.status;
};

test("迁移：旧 tasks 行按同一个 id 变成帮手（带来源 / 标题），已结束的标为已通知，等待改成等帮手，重复迁移不重复写", () => {
	legacyTask("t-safe", sessionFile(false));
	legacyTask("t-unsafe", sessionFile(true));
	legacyTask("t-nofile", null);
	legacyTask("t-hb", sessionFile(true), { kind: "heartbeat" });
	legacyTask("t-old", null, { status: "cancelled" });
	legacyTask("t-done", null, { status: "done", result: "早就做完了" });
	db.prepare("INSERT INTO task_waits(id, agent_id, conversation_id, target_kind, target_ref, reason, status, check_interval_ms, next_check_at, due_at, check_count, created_at, updated_at) VALUES('tw-old','bt-test',?,'task','t-unsafe','等整理','waiting',60000,?,?,0,?,?)").run(conv, now(), now() + 3600_000, now(), now());
	assert.equal(migrateLegacyTasks(), 6);
	assert.equal(migrateLegacyTasks(), 0);
	const done = getSubagent("t-done")!;
	assert.equal(done.kind, "task");
	assert.equal(done.title, "任务t-done");
	assert.equal(done.result_summary, "早就做完了");
	assert.ok(done.notified_at);
	assert.equal(getSubagent("t-hb")!.kind, "heartbeat");
	assert.equal(getTask("t-old")!.status, "cancelled");
	assert.equal((db.prepare("SELECT target_kind FROM task_waits WHERE id = 'tw-old'").get() as { target_kind: string }).target_kind, "subagent");
	// 后台任务列表：不含巡检
	assert.deepEqual(tasks.list("bt-test").map((t) => t.id).sort(), ["t-done", "t-nofile", "t-old", "t-safe", "t-unsafe"]);
});

test("重启：工具调用都有结果 → 自动续跑（续跑提示，不重发原任务）；结果未知 / 没有会话 → 中断待核验", async () => {
	const before = listMessages("bt-test", { conversationId: conv }).length;
	recoverSubagents();
	const unsafe = getTask("t-unsafe")!;
	assert.equal(unsafe.status, "lost");
	assert.match(unsafe.error ?? "", /服务重启.*bash/);
	assert.equal(getTask("t-nofile")!.status, "lost");
	assert.equal(tasks.resume("t-nofile"), false);
	// 巡检的帮手中断只记录，不唤醒主会话、不在对话里插消息
	assert.equal(getSubagent("t-hb")!.status, "lost");
	await settle("t-safe", ["done", "failed"]);
	assert.equal(getTask("t-safe")!.status, "done");
	const sm = SessionManager.open(getTask("t-safe")!.session_file!);
	const users = sm.getBranch().flatMap((e) => (e.type === "message" && e.message.role === "user" ? [JSON.stringify(e.message.content)] : []));
	assert.match(users.at(-1)!, /服务刚刚重启/);
	assert.ok(!listMessages("bt-test", { conversationId: conv }).slice(before).some((m) => /主动巡检|任务t-hb/.test(m.content ?? "")));
});

test("中断待核验后手动继续：在原会话里先核验再续（列出结果未知的工具），跑完回到已完成", async () => {
	assert.equal(tasks.resume("t-unsafe"), true);
	assert.equal(await settle("t-unsafe", ["done", "failed"]), "done");
	const t = getTask("t-unsafe")!;
	assert.equal(t.error, null);
	const sm = SessionManager.open(t.session_file!);
	const users = sm.getBranch().flatMap((e) => (e.type === "message" && e.message.role === "user" ? [JSON.stringify(e.message.content)] : []));
	assert.match(users.at(-1)!, /先核实/);
	assert.match(users.at(-1)!, /bash/);
	// 已经在跑 / 跑完的任务不能再「继续」
	assert.equal(tasks.resume("t-unsafe"), false);
});
