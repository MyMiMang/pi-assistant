import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKSPACE_LIMIT, WORKSPACE_START, emptyWorkspace, workspaceScope, workspaceStep } from "../../../apps/web/src/workspace-state.ts";

const open = (state: ReturnType<typeof emptyWorkspace>, key: string) => workspaceStep(state, { type: "open", key });
test("文件/任务切换按对象去重，收起/展开不丢标签与当前对象", () => {
	let state = open(open(emptyWorkspace("a:c1"), "file:1"), "tasks:1");
	state = open(state, "file:1");
	assert.deepEqual(state.keys, ["file:1", "tasks:1"]);
	state = workspaceStep(state, { type: "expand" });
	state = workspaceStep(state, { type: "collapse" });
	assert.equal(state.active, "file:1");
	assert.equal(state.expanded, false);
	assert.equal(state.collapsed, true);
	state = workspaceStep(state, { type: "reopen" });
	assert.equal(state.collapsed, false);
	assert.equal(state.expanded, false);
	assert.deepEqual(workspaceStep(state, { type: "restore" }).keys, state.keys);
});
test("关闭当前项选择相邻标签，关闭非当前项保持选择，最后一项释放放大状态", () => {
	let state = ["a", "b", "c"].reduce(open, emptyWorkspace("a:c1"));
	state = open(state, "b");
	state = workspaceStep(state, { type: "close", key: "a" });
	assert.equal(state.active, "b");
	state = workspaceStep(state, { type: "close", key: "b" });
	assert.equal(state.active, "c");
	state = workspaceStep(state, { type: "expand" });
	state = workspaceStep(state, { type: "close", key: "c" });
	assert.equal(state.active, null);
	assert.equal(state.expanded, false);
	assert.deepEqual(state.keys, []);
});
test("作用域切换（包括隐藏状态）清空所有对象，同scope更新保持引用", () => {
	let state = workspaceStep(open(emptyWorkspace("a:c1"), "file:1"), { type: "collapse" });
	assert.equal(workspaceStep(state, { type: "scope", scope: "a:c1" }), state);
	state = workspaceStep(state, { type: "scope", scope: "a:c2" });
	assert.deepEqual(state, emptyWorkspace("a:c2"));
});
test("实例数有界，重新激活不增长，超过上限拒绝且保留全部已打开内容", () => {
	let state = emptyWorkspace("a:c1");
	for (let i = 0; i < WORKSPACE_LIMIT; i++) state = open(state, String(i));
	state = open(state, "0");
	assert.equal(state.keys.length, WORKSPACE_LIMIT);
	const full = state;
	state = open(state, "new");
	assert.equal(state, full);
	assert.equal(state.keys.length, WORKSPACE_LIMIT);
	assert.equal(state.keys.includes("0"), true);
	assert.equal(state.active, "0");
});
test("起始标签由真实入口就地替换，已打开的业务标签不重复", () => {
	const full = [...Array.from({ length: WORKSPACE_LIMIT - 1 }, (_, i) => `file:${i}`), WORKSPACE_START].reduce(open, emptyWorkspace("scope"));
	const next = open(full, "settings:agent:one");
	assert.equal(next.keys.length, WORKSPACE_LIMIT);
	assert.equal(next.keys.at(-1), "settings:agent:one");
	assert.equal(next.active, "settings:agent:one");
	const existing = open(full, "file:0");
	assert.equal(existing.keys.length, WORKSPACE_LIMIT - 1);
	assert.equal(existing.active, "file:0");
	assert.ok(!existing.keys.includes(WORKSPACE_START));
});
test("群/助理/对话身份分离，显示名字不参与归属", () => {
	const selection = { room: null, current: "a", convs: { a: { current: "c1" } } };
	assert.equal(workspaceScope(selection), "agent:a:conversation:c1");
	assert.equal(workspaceScope({ ...selection, room: "r1" }), "room:r1");
	assert.notEqual(workspaceScope(selection), workspaceScope({ ...selection, convs: { a: { current: "c2" } } }));
});
