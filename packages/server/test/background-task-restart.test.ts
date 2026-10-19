/**
 * 后台任务（含定时 / 巡检）重启安全判定（决策 0014 第 2 步）：和子代理同一套 subagent-resume 判定。
 * 会话里没有「已派发、结果未落库」的工具调用 → 排队续跑（只发续跑提示，不重发原任务）；
 * 否则标 lost（中断待核验），不自动重放，回报到对话；用户点继续后在原会话里先核验再续。
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
const { tasks } = await import("../src/agent-runtime/background-tasks.ts");
const { getTask } = await import("../src/agent-runtime/rows.ts");
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
function runningTask(id: string, file: string | null, extra: { kind?: string } = {}) {
	db.prepare("INSERT INTO tasks(id, agent_id, conversation_id, title, instructions, status, kind, session_file, created_at, started_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, "bt-test", conv, `任务${id}`, "整理文件", "running", extra.kind ?? null, file, now(), now());
}
const settle = async (id: string, want: string[]) => {
	for (let i = 0; i < 200 && !want.includes(getTask(id)!.status); i++) await new Promise((r) => setTimeout(r, 25));
	return getTask(id)!.status;
};

test("重启：会话里工具调用都有结果 → 自动续跑，发的是续跑提示而不是原任务", async () => {
	runningTask("t-safe", sessionFile(false));
	tasks.recover();
	assert.equal(await settle("t-safe", ["done", "failed"]), "done");
	const t = getTask("t-safe")!;
	assert.equal(t.resume, 0);
	const sm = SessionManager.open(t.session_file!);
	const users = sm.getBranch().flatMap((e) => (e.type === "message" && e.message.role === "user" ? [JSON.stringify(e.message.content)] : []));
	assert.match(users.at(-1)!, /服务刚刚重启/);
});

test("重启：有已派发但结果未落库的工具调用 → 标中断待核验，不自动重放，对话里能看到", () => {
	runningTask("t-unsafe", sessionFile(true));
	tasks.recover();
	const t = getTask("t-unsafe")!;
	assert.equal(t.status, "lost");
	assert.match(t.error ?? "", /服务重启.*bash/);
	assert.ok(listMessages("bt-test", { conversationId: conv }).some((m) => /中断待核验/.test(m.content ?? "")));
});

test("重启：没有落库会话 → 标中断待核验，无法继续（需要重新派活）", () => {
	runningTask("t-nofile", null);
	tasks.recover();
	assert.equal(getTask("t-nofile")!.status, "lost");
	assert.equal(tasks.resume("t-nofile"), false);
});

test("巡检任务中断待核验只记录，不在对话里插消息", () => {
	const before = listMessages("bt-test", { conversationId: conv }).length;
	runningTask("t-hb", sessionFile(true), { kind: "heartbeat" });
	tasks.recover();
	assert.equal(getTask("t-hb")!.status, "lost");
	assert.equal(listMessages("bt-test", { conversationId: conv }).length, before);
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
