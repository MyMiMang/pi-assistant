import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventConverter, type ClaudeEvent } from "../src/cli-agents/events.ts";

const se = (event: object) => JSON.stringify({ type: "stream_event", event, session_id: "s1" });
function run(lines: string[]): ClaudeEvent[] {
	const c = createEventConverter();
	return lines.flatMap((l) => c.convert(l));
}

test("init：会话 id、工具、模型", () => {
	const ev = run([JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: ["mcp__pia__echo_text"], model: "claude-sonnet-5", mcp_servers: [] })]);
	assert.deepEqual(ev, [{ type: "init", sessionId: "s1", tools: ["mcp__pia__echo_text"], model: "claude-sonnet-5" }]);
});

test("system/status、thinking_tokens、assistant 整块、message_stop 都不产生事件", () => {
	const ev = run([
		JSON.stringify({ type: "system", subtype: "status", status: "requesting" }),
		JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 27 }),
		JSON.stringify({ type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "hi" }], usage: { output_tokens: 0 } } }),
		se({ type: "message_stop" }),
		"",
	]);
	assert.deepEqual(ev, []);
});

test("文字和思考流式", () => {
	const ev = run([
		se({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 992, output_tokens: 0, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 } } }),
		se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
		se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想一想" } }),
		se({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } }),
		se({ type: "content_block_stop", index: 0 }),
		se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
		se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你" } }),
		se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "好" } }),
		se({ type: "content_block_stop", index: 1 }),
		se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 16 } }),
	]);
	assert.deepEqual(ev.map((e) => e.type), ["message_start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "message_end"]);
	assert.deepEqual(ev[0], { type: "message_start", messageId: "msg_1", usage: { input: 992, output: 0, cacheRead: 5, cacheWrite: 7 } });
	assert.equal((ev[2] as { text: string }).text, "想一想");
	assert.equal((ev[5] as { text: string }).text + (ev[6] as { text: string }).text, "你好");
	// 用量：输入取 message_start，输出取 message_delta
	assert.deepEqual(ev[8], { type: "message_end", stopReason: "end_turn", usage: { input: 992, output: 16, cacheRead: 5, cacheWrite: 7 } });
});

test("两个工具并行：参数流式、按块序号配对 id、message_end 为 tool_use", () => {
	const ev = run([
		se({ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 10 } } }),
		se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_A", name: "mcp__pia__echo_text", input: {} } }),
		se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_B", name: "mcp__pia__echo_text", input: {} } }),
		se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"text":' } }),
		se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"text":"b"}' } }),
		se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"a"}' } }),
		se({ type: "content_block_stop", index: 0 }),
		se({ type: "content_block_stop", index: 1 }),
		se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 16 } }),
	]);
	assert.deepEqual(ev.filter((e) => e.type === "tool_call_start"), [
		{ type: "tool_call_start", id: "toolu_A", name: "echo_text" },
		{ type: "tool_call_start", id: "toolu_B", name: "echo_text" },
	]);
	assert.deepEqual(ev.filter((e) => e.type === "tool_call_args_delta").map((e) => (e as { id: string }).id), ["toolu_A", "toolu_B", "toolu_A"]);
	assert.deepEqual(ev.filter((e) => e.type === "tool_call_end"), [
		{ type: "tool_call_end", id: "toolu_A", name: "echo_text", args: { text: "a" } },
		{ type: "tool_call_end", id: "toolu_B", name: "echo_text", args: { text: "b" } },
	]);
	const end = ev[ev.length - 1];
	assert.equal(end.type === "message_end" && end.stopReason, "tool_use");
});

test("工具没有参数 / 参数 JSON 不完整", () => {
	const ev = run([
		se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_C", name: "mcp__pia__now", input: {} } }),
		se({ type: "content_block_stop", index: 0 }),
		se({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_D", name: "web_search", input: {} } }),
		se({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":' } }),
		se({ type: "content_block_stop", index: 1 }),
	]);
	assert.deepEqual(ev.filter((e) => e.type === "tool_call_end"), [
		{ type: "tool_call_end", id: "toolu_C", name: "now", args: {} },
		{ type: "tool_call_end", id: "toolu_D", name: "web_search", args: {}, argsRaw: '{"q":' },
	]);
});

test("心跳、工具结果回显", () => {
	const ev = run([
		JSON.stringify({ type: "tool_progress", tool_use_id: "toolu_A-heartbeat-1", tool_name: "mcp__pia__slow_wait", parent_tool_use_id: "toolu_A", elapsed_time_seconds: 30, heartbeat: true }),
		JSON.stringify({ type: "tool_progress", tool_use_id: "toolu_A", elapsed_time_seconds: 3 }),
		JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_A", type: "tool_result", content: [{ type: "text", text: "ECHO:a" }] }] } }),
		JSON.stringify({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_B", type: "tool_result", is_error: true, content: "The operation timed out." }] } }),
	]);
	assert.deepEqual(ev, [
		{ type: "heartbeat", toolUseId: "toolu_A" },
		{ type: "tool_result", toolUseId: "toolu_A", isError: false, text: "ECHO:a" },
		{ type: "tool_result", toolUseId: "toolu_B", isError: true, text: "The operation timed out." },
	]);
});

test("result：整轮用量取 result.usage（不读 thinking_tokens、不转钱）", () => {
	const ev = run([
		JSON.stringify({
			type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "完成", session_id: "s1", total_cost_usd: 0.007,
			usage: { input_tokens: 1031, cache_creation_input_tokens: 397, cache_read_input_tokens: 3745, output_tokens: 325, output_tokens_details: { thinking_tokens: 0 } },
		}),
	]);
	assert.deepEqual(ev, [{ type: "result", sessionId: "s1", isError: false, text: "完成", usage: { input: 1031, output: 325, cacheRead: 3745, cacheWrite: 397 } }]);
});

test("result 出错：Not logged in 原文保留；没有 result 文字时用 subtype", () => {
	const [a] = run([JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: "s1", terminal_reason: "api_error" })]);
	assert.equal(a.type === "result" && a.isError, true);
	assert.equal(a.type === "result" && a.text, "Not logged in · Please run /login");
	const [b] = run([JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" })]);
	assert.equal(b.type === "result" && b.text, "error_during_execution");
});

test("不是 JSON 的行：原样给出", () => {
	assert.deepEqual(run(["Error: boom", "123"]), [{ type: "unparsed", line: "Error: boom" }, { type: "unparsed", line: "123" }]);
});
