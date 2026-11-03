/** 前端纯逻辑：群里只显示说的话（apps/web/src/room-group.ts）。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupRoom } from "../../../apps/web/src/room-group.ts";

let n = 0;
const T0 = Date.now();
const mk = (role: string, agent: string, content = "", extra: Record<string, unknown> = {}) =>
	({ id: `m${++n}`, agent_id: agent, task_id: null, role, content, meta: {}, status: "done", created_at: T0 + n * 1000, updated_at: T0 + n * 1000, ...extra }) as never;
const bots = (rows: ReturnType<typeof groupRoom>) => rows.filter((r) => r.kind === "bot") as Extract<ReturnType<typeof groupRoom>[number], { kind: "bot" }>[];

test("只有思考 / 工具步骤、没有文字的消息不单独显示，步骤并进同一成员下一条有文字的消息", () => {
	const list = [mk("user", ""), mk("assistant", "a", ""), mk("tool", "a", "", { meta: { toolName: "bash" } }), mk("assistant", "a", ""), mk("tool", "a", "", { meta: { toolName: "read" } }), mk("assistant", "a", "做好了")];
	list[0] = mk("user", "", "开工");
	const rows = bots(groupRoom(list as never));
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0].parts.map((p) => p.kind), ["steps", "msg"]);
	const steps = rows[0].parts[0] as { items: unknown[] };
	assert.equal(steps.items.length, 2);
});

test("别的成员插进来也不打断：A 的步骤等 A 说话才并进去；还没说话的步骤不显示", () => {
	const list = [mk("tool", "a", ""), mk("assistant", "b", "我先说"), mk("tool", "a", ""), mk("assistant", "a", "我也说了"), mk("tool", "b", "")];
	const rows = bots(groupRoom(list as never));
	assert.deepEqual(rows.map((r) => r.agentId), ["b", "a"]);
	assert.deepEqual(rows[0].parts.map((p) => p.kind), ["msg"]);
	assert.equal((rows[1].parts[0] as { items: unknown[] }).items.length, 2);
});

test("正在发言的那位照旧显示过程；出错的空消息要让用户看到", () => {
	const list = [mk("assistant", "a", ""), mk("tool", "a", ""), mk("assistant", "b", "", { status: "error" })];
	const rows = bots(groupRoom(list as never, "a"));
	assert.equal(rows.length, 2);
	assert.deepEqual(rows[0].parts.map((p) => p.kind), ["msg", "steps"]);
	assert.equal(bots(groupRoom(list as never)).length, 1);
});

test("用户和系统消息照常显示，同一成员被隐藏的过程消息不会把前后两段话拆成两行", () => {
	const list = [mk("assistant", "a", "第一句"), mk("tool", "a", ""), mk("assistant", "a", ""), mk("assistant", "a", "第二句"), mk("system", "", "已暂停")];
	const rows = groupRoom(list as never);
	assert.deepEqual(rows.map((r) => r.kind), ["day", "bot", "system"]);
	assert.deepEqual((rows[1] as { parts: { kind: string }[] }).parts.map((p) => p.kind), ["msg", "steps", "msg"]);
});

test("行的 id 不随「正在发言」变：说完时过程消息隐藏，整行不换 key（不重新挂载）", () => {
	const list = [mk("tool", "a", ""), mk("card", "a", "", { meta: { kind: "room-plan" } }), mk("tool", "a", ""), mk("assistant", "a", "好的")];
	const during = bots(groupRoom(list as never, "a"));
	const after = bots(groupRoom(list as never, null));
	assert.equal(during.length, 1);
	assert.equal(during[0].id, after[0].id);
});
