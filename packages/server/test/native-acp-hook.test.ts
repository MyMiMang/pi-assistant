import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachNativeTools, subscribeNativeTools, type NativeToolEvent } from "../src/pi-adapter/cli-models/session-context.ts";
import { renderTranscript } from "../src/pi-adapter/cli-models/convert.ts";

function fixture(id: string) {
	const listeners = new Set<(event: any) => void>();
	let previousCalls = 0;
	const previous = async () => { previousCalls++; };
	const session = { sessionId: id, agent: { onProviderStreamEvent: previous as (data: unknown, model: any) => void | Promise<void> }, subscribe: (fn: (event: any) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
	const detach = attachNativeTools(session);
	const emit = (event: unknown) => { for (const fn of listeners) fn(event); };
	const native = (call: string, status: NativeToolEvent["status"], title: string) => session.agent.onProviderStreamEvent({ type: "native_tool", id: call, status, title }, { provider: "fake" });
	return { session, detach, emit, native, previous, previousCalls: () => previousCalls };
}

test("公开provider钩子组合原钩子，只旁路展示；在实际assistant对象附标题并可JSON持久化 / 换模型读取", async () => {
	const f = fixture("hook-persist");
	const seen: NativeToolEvent[] = [];
	const off = subscribeNativeTools(f.session.sessionId, (event) => seen.push(event));
	try {
		await f.native("read", "in_progress", "读取文件");
		await f.native("read", "completed", "读取文件");
		await f.native("read", "completed", "读取文件");
		await f.native("write", "failed", "写入文件");
		const message = { role: "assistant", content: [{ type: "text", text: "执行结果" }] };
		f.emit({ type: "message_end", message });
		const persisted = JSON.parse(JSON.stringify(message));
		assert.deepEqual(persisted.nativeToolTitles, ["成功：读取文件", "失败：写入文件"]);
		assert.deepEqual(persisted.content, [{ type: "text", text: "执行结果" }]);
		assert.match(renderTranscript([persisted]), /成功：读取文件\n失败：写入文件/);
		assert.equal(seen.length, 4);
		assert.equal(f.previousCalls(), 4);
		const next: Record<string, unknown> = { role: "assistant", content: [] };
		f.emit({ type: "message_end", message: next });
		assert.equal(next.nativeToolTitles, undefined, "同一批标题只附在对应的实际消息一次");
	} finally { off(); f.detach(); }
	assert.equal(f.session.agent.onProviderStreamEvent, f.previous);
});

test("稀疏更新保留标题、按进程区分调用且终态不回滚", async () => {
	const f = fixture("hook-patches");
	const seen: NativeToolEvent[] = [];
	const off = subscribeNativeTools(f.session.sessionId, (event) => seen.push(event));
	try {
		const send = (data: unknown) => f.session.agent.onProviderStreamEvent(data, {});
		await send({ type: "native_tool", runId: "a", id: "1", title: "读取文件", status: "in_progress" });
		await send({ type: "native_tool", runId: "a", id: "1", status: "completed" });
		await send({ type: "native_tool", runId: "a", id: "1", status: "in_progress" });
		await send({ type: "native_tool", runId: "b", id: "1", title: "写入文件", status: "failed" });
		assert.equal(seen[1].title, "读取文件");
		assert.equal(seen[2].status, "completed");
		assert.notEqual(seen[0].id, seen[3].id);
		const message: Record<string, unknown> = { role: "assistant", content: [] };
		f.emit({ type: "message_end", message });
		assert.deepEqual(message.nativeToolTitles, ["成功：读取文件", "失败：写入文件"]);
	} finally {
		off();
		f.detach();
	}
});

test("两会话标题和展示互不串；user结束不消耗assistant标题；settled和解绑清理", async () => {
	const a = fixture("hook-isolation-a"), b = fixture("hook-isolation-b");
	try {
		await a.native("same-id", "completed", "A结果");
		await b.native("same-id", "failed", "B结果");
		a.emit({ type: "message_end", message: { role: "user", content: "x" } });
		const am: Record<string, unknown> = { role: "assistant", content: [] }, bm: Record<string, unknown> = { role: "assistant", content: [] };
		a.emit({ type: "message_end", message: am }); b.emit({ type: "message_end", message: bm });
		assert.deepEqual(am.nativeToolTitles, ["成功：A结果"]);
		assert.deepEqual(bm.nativeToolTitles, ["失败：B结果"]);
		await a.native("old", "completed", "旧轮结果");
		a.emit({ type: "agent_settled" });
		const next: Record<string, unknown> = { role: "assistant", content: [] };
		a.emit({ type: "message_end", message: next });
		assert.equal(next.nativeToolTitles, undefined);
	} finally { a.detach(); b.detach(); }
});
