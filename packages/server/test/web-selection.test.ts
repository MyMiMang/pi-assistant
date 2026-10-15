/**
 * 助理选择持久化 / 恢复的纯逻辑单测（不碰服务端、不碰钥匙串、不读写用户数据）。
 * 覆盖：fresh 首次、stored 有效、已删除 id 回退、deeplink 优先、账号隔离、乐观消息合并。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSelection, mergeMessages, resolveInitialAgent, saveSelection, selectionKey, storedConversation } from "../../../apps/web/src/selection.ts";

const agents = [{ id: "a1" }, { id: "a2", scope: "user" as const }, { id: "r1", scope: "room" as const }];

test("fresh：没有任何记录时稳定回退到第一个用户助理，并只记一次", () => {
	const r = resolveInitialAgent({ agents, current: null, requested: null, stored: null });
	assert.equal(r.agentId, "a1");
	assert.equal(r.source, "first");
	assert.equal(r.persist, true);
});

test("stored 有效：恢复上次明确打开的助理，不覆盖", () => {
	const r = resolveInitialAgent({ agents, current: null, requested: null, stored: "a2" });
	assert.equal(r.agentId, "a2");
	assert.equal(r.source, "stored");
	assert.equal(r.persist, false);
});

test("已删除 id：回退到第一个并回写一次，不会卡在坏 id", () => {
	const r = resolveInitialAgent({ agents, current: null, requested: null, stored: "gone" });
	assert.equal(r.agentId, "a1");
	assert.equal(r.source, "first");
	assert.equal(r.persist, true);
});

test("deeplink 优先于本地记录；无效 deeplink 不生效", () => {
	const ok = resolveInitialAgent({ agents, current: null, requested: "a2", stored: "a1" });
	assert.equal(ok.agentId, "a2");
	assert.equal(ok.source, "requested");
	const bad = resolveInitialAgent({ agents, current: null, requested: "nope", stored: "a1" });
	assert.equal(bad.agentId, "a1");
	assert.equal(bad.source, "stored");
});

test("内存里已有效的当前选择优先，重连不跳走", () => {
	const r = resolveInitialAgent({ agents, current: "a2", requested: "a1", stored: "a1" });
	assert.equal(r.agentId, "a2");
	assert.equal(r.source, "current");
	assert.equal(r.persist, false);
});

test("只有一个群专属助理时不把群当用户助理，但仍能兜底显示", () => {
	const only = [{ id: "r1", scope: "room" as const }];
	const r = resolveInitialAgent({ agents: only, current: null, requested: null, stored: null });
	assert.equal(r.agentId, "r1");
	assert.equal(r.persist, true);
});

test("选择按账号隔离：不同 serverId / deviceId 读不到对方的 id", () => {
	const mem = new Map<string, string>();
	const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
	const k1 = selectionKey("srv1", "dev1");
	const k2 = selectionKey("srv1", "dev2");
	const k3 = selectionKey("srv2", "dev1");
	assert.notEqual(k1, k2);
	assert.notEqual(k1, k3);
	saveSelection(k1, { agentId: "a2", convs: { a2: "c9" } }, store);
	assert.equal(loadSelection(k1, store).agentId, "a2");
	assert.equal(storedConversation(loadSelection(k1, store), "a2"), "c9");
	assert.equal(loadSelection(k2, store).agentId, null);
	assert.equal(loadSelection(k3, store).agentId, null);
});

test("只持久化公开 id，不存消息 / token 字段", () => {
	const mem = new Map<string, string>();
	const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
	const key = selectionKey("s", "d");
	saveSelection(key, { agentId: "a1", convs: { a1: "c1" } }, store);
	const raw = mem.get(key)!;
	assert.ok(raw.includes("a1") && raw.includes("c1"));
	assert.ok(!raw.includes("messages") && !raw.includes("token"));
});

test("mergeMessages：迟到的 history 不覆盖已显示的乐观 / 流式消息", () => {
	const fetched = [{ id: "m1", created_at: 1 }];
	const existing = [
		{ id: "m1", created_at: 1 },
		{ id: "m2", created_at: 2 }, // 用户刚发出、后端 history 还没带上
	];
	const merged = mergeMessages(fetched, existing);
	assert.deepEqual(merged.map((m) => m.id), ["m1", "m2"]);
});

test("mergeMessages：后台刷新不清空已显示内容（history 为空时保留本地）", () => {
	const existing = [{ id: "m1", created_at: 1 }, { id: "m2", created_at: 2 }];
	assert.deepEqual(mergeMessages([], existing).map((m) => m.id), ["m1", "m2"]);
});
