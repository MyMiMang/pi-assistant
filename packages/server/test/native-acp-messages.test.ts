import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeAcpMessages } from "../src/agent-runtime/native-acp-messages.ts";
import { db, now } from "../src/db.ts";
import { insertMessage, type MessageRow, toMessage } from "../src/messages.ts";

const agentId = "native-steps-test";
db.prepare("INSERT INTO agents(id,name,avatar,color,created_at) VALUES(?,?,?,?,?)").run(agentId, "原生步骤", "测", "#111", now());
const steps = () => (db.prepare("SELECT * FROM messages WHERE agent_id = ? AND role = 'tool' ORDER BY rowid").all(agentId) as unknown as MessageRow[]).map(toMessage);

test("原生步骤：早到更新 / 重复start只有一条App记录，字段补丁不清旧值，终态不回滚", () => {
	const native = nativeAcpMessages((m) => insertMessage({ ...m, agentId }));
	const before = steps().length;
	native.update({ type: "native_tool", id: "run/session/call", title: "写入文件", status: "in_progress", rawInput: { path: "a.txt" }, locations: [{ path: "a.txt", line: 1 }] });
	native.update({ type: "native_tool", id: "run/session/call", title: "写入文件", status: "pending" });
	assert.equal(steps().length, before + 1);
	assert.equal(steps().at(-1)?.meta.executionSource, "native-acp");
	assert.match(JSON.stringify(steps().at(-1)?.meta.args), /a.txt/);
	native.update({ type: "native_tool", id: "run/session/call", title: "已写入文件", status: "completed", rawOutput: "ok", content: [{ type: "text", text: "完成" }] });
	native.update({ type: "native_tool", id: "run/session/call", title: "迟到进展", status: "in_progress" });
	assert.equal(steps().at(-1)?.status, "done");
	assert.equal(steps().at(-1)?.meta.result, "ok");
	assert.equal(steps().at(-1)?.meta.piEntryId, undefined);
	assert.equal(steps().filter((m) => m.meta.toolCallId === "run/session/call").length, 1);
	native.finish(false);
});

test("原生步骤：缺少终态按未确认失败，停止 / 解绑按中断，完成记录不受影响", () => {
	for (const aborted of [false, true]) {
		const native = nativeAcpMessages((m) => insertMessage({ ...m, agentId }));
		native.update({ type: "native_tool", id: `run/${aborted}/done`, title: "读取", status: "completed" });
		native.update({ type: "native_tool", id: `run/${aborted}/pending`, title: "写入", status: "in_progress" });
		native.finish(aborted);
		assert.equal(steps().at(-2)?.status, "done");
		assert.equal(steps().at(-1)?.status, aborted ? "interrupted" : "error");
		assert.match(String(steps().at(-1)?.meta.result), aborted ? /未确认/ : /未报告最终结果/);
		assert.equal(native.has(`run/${aborted}/pending`), false);
	}
});

test("原生步骤展示数据有限长，不把复杂输入或原始输出无限存入消息", () => {
	const native = nativeAcpMessages((m) => insertMessage({ ...m, agentId }));
	native.update({ type: "native_tool", id: "bounded", title: "x".repeat(800), status: "failed", rawInput: { command: "y".repeat(8000) }, rawOutput: "z".repeat(8000), locations: [{ path: "x".repeat(8000) }], content: [{ text: "c".repeat(8000) }] });
	const meta = steps().at(-1)!.meta;
	assert.equal(String(meta.title).length, 500);
	assert.equal(String((meta.args as { input: string }).input).length, 4000);
	assert.equal(String(meta.result).length, 4000);
	assert.equal(String(meta.locations).length, 4000);
	assert.equal(String(meta.nativeContent).length, 4000);
	native.finish(false);
});
