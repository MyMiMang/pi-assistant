import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { bindSession } from "../src/agent-runtime/bind-session.ts";
import { db, now } from "../src/db.ts";
import { type MessageRow, toMessage } from "../src/messages.ts";
import { emitNativeTool } from "../src/pi-adapter/cli-models/session-context.ts";

let count = 0;
function fixture() {
	const id = `bind-native-${++count}`;
	db.prepare("INSERT INTO agents(id,name,avatar,color,created_at) VALUES(?,?,?,?,?)").run(id, "原生正文", "测", "#111", now());
	let emit!: (event: unknown) => void;
	const entries: unknown[] = [];
	const session = { sessionId: id, subscribe: (fn: typeof emit) => { emit = fn; return () => {}; }, sessionManager: { getEntries: () => entries } };
	let settled: boolean | undefined;
	const unbind = bindSession(session as never, id, null, null, (aborted) => { settled = aborted; });
	const rows = () => (db.prepare("SELECT * FROM messages WHERE agent_id = ? ORDER BY rowid").all(id) as unknown as MessageRow[]).map(toMessage);
	return {
		id, rows, entries, unbind, settled: () => settled,
		start: () => emit({ type: "message_start", message: { role: "assistant" } }),
		text: (delta: string) => emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }),
		end: (text: string, fields = {}) => {
			const message = { role: "assistant", content: [{ type: "text", text }], provider: "native-test", model: "fake", stopReason: "stop", ...fields };
			emit({ type: "message_end", message });
			return message;
		},
		finish: (aborted = false) => emit({ type: "agent_settled", aborted }),
		bridge: () => {
			emit({ type: "tool_execution_start", toolCallId: "bridge-call", toolName: "read", args: { path: "bridge.txt" } });
			emit({ type: "tool_execution_end", toolCallId: "bridge-call", toolName: "read", result: { content: [{ type: "text", text: "bridge-ok" }] } });
		},
		tool: (call: string, status: "pending" | "in_progress" | "completed" | "failed" = "in_progress") => emitNativeTool(id, { type: "native_tool", id: `${id}/${call}`, title: `处理 ${call}`, status }),
	};
}

test("原生正文→步骤→正文：end整段不重复，末片段独占Pi锚点，usage只写一次", async () => {
	const f = fixture();
	try {
		f.start(); f.text("先读取。"); f.tool("read"); f.tool("read", "completed"); f.text("再汇报。");
		const message = f.end("先读取。再汇报。", { usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
		f.entries.push({ id: "real-assistant-entry", type: "message", message });
		await Promise.resolve();
		const rows = f.rows();
		assert.deepEqual(rows.map((m) => [m.role, m.content, m.status]), [["assistant", "先读取。", "done"], ["tool", "", "done"], ["assistant", "再汇报。", "done"]]);
		assert.equal(rows[0].meta.piEntryId, undefined);
		assert.equal(rows[1].meta.piEntryId, undefined);
		assert.equal(rows[2].meta.piEntryId, "real-assistant-entry");
		assert.equal(rows.filter((m) => m.meta.usage).length, 1);
		assert.equal(rows.some((m) => m.meta.groupId || m.meta.fragmentOffset), false);
		f.finish();
	} finally { f.unbind(); }
});

test("同一条Pi回复连续两个原生步骤：三个正文片段不重叠，步骤补丁不额外切正文", () => {
	const f = fixture();
	try {
		f.start(); f.text("第一段"); f.tool("one"); f.text("第二段");
		f.tool("one", "completed"); f.text("继续第二段"); f.tool("two"); f.text("第三段");
		f.tool("two", "completed"); f.end("第一段第二段继续第二段第三段"); f.finish();
		assert.deepEqual(f.rows().map((m) => [m.role, m.content]), [["assistant", "第一段"], ["tool", ""], ["assistant", "第二段继续第二段"], ["tool", ""], ["assistant", "第三段"]]);
	} finally { f.unbind(); }
});

test("原生正文之后只剩步骤：最终entry仍锚定最后正文，不添加重复正文或空回复", async () => {
	const f = fixture();
	try {
		f.start(); f.text("开始检查。"); f.tool("check", "completed");
		const message = f.end("开始检查。");
		f.entries.push({ id: "last-fragment", type: "message", message });
		await Promise.resolve();
		assert.equal(f.rows().length, 2);
		assert.equal(f.rows()[0].content, "开始检查。");
		assert.equal(f.rows()[0].meta.piEntryId, "last-fragment");
		f.finish();
	} finally { f.unbind(); }
});

test("纯原生步骤可见：不报未收到回复；新轮全空仍报错；原生与桥各保存一条", () => {
	const f = fixture();
	try {
		f.start(); f.tool("only", "completed"); f.end(""); f.finish();
		assert.equal(f.rows().length, 1);
		assert.equal(f.rows()[0].role, "tool");
		f.start(); f.tool("native-plus-bridge", "completed"); f.end(""); f.bridge(); f.finish();
		assert.equal(f.rows().filter((m) => m.role === "tool").length, 3);
		assert.equal(f.rows().filter((m) => m.meta.toolCallId === "bridge-call").length, 1);
		assert.equal(f.rows().filter((m) => m.meta.toolName === "read").length, 1);
		f.start(); f.end(""); f.finish();
		assert.equal(f.rows().at(-1)?.status, "error");
		assert.match(String(f.rows().at(-1)?.meta.error), /未收到回复/);
	} finally { f.unbind(); }
});

test("新Pi MCP回复重置正文模式，同时原生步骤映射保持整轮可更新", () => {
	const f = fixture();
	try {
		f.start(); f.text("工具前"); f.tool("pending"); f.end("工具前"); f.bridge();
		f.start(); f.end("只有最终文本，无delta");
		assert.equal(f.rows().at(-1)?.content, "只有最终文本，无delta", "新的Pi回复按其最终正文落库，不沿用native片段模式");
		f.tool("pending", "completed");
		assert.equal(f.rows().filter((m) => m.meta.toolCallId === `${f.id}/pending`).length, 1);
		assert.equal(f.rows().find((m) => m.meta.toolCallId === `${f.id}/pending`)?.status, "done");
		f.finish();
	} finally { f.unbind(); }
});

test("原生停止、意外结束和解绑都收尾运行步骤，后续事件不复活解绑记录", () => {
	for (const mode of ["stop", "exit", "unbind"] as const) {
		const f = fixture();
		f.start(); f.tool("running");
		if (mode === "unbind") f.unbind();
		else { f.end("", mode === "stop" ? { stopReason: "aborted" } : {}); f.finish(mode === "stop"); }
		assert.equal(f.rows().find((m) => m.role === "tool")?.status, mode === "exit" ? "error" : "interrupted");
		if (mode !== "unbind") { assert.equal(f.settled(), mode === "stop"); f.unbind(); }
		f.tool("running", "completed");
		assert.equal(f.rows().find((m) => m.role === "tool")?.status, mode === "exit" ? "error" : "interrupted");
	}
});
