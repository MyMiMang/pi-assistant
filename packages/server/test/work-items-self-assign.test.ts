import assert from "node:assert/strict";
import { test } from "node:test";
import { db, room, rooms, row } from "./work-items-harness.ts";
import { workItemTools } from "../src/work-items/tools.ts";

/** 管理者不能默认把活都揽到自己身上（有其他成员时要写 selfReason）；群成员规则里名字以名单为准。 */
type Tool = { execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
function toolsOf(roomId: string, agentId: string) {
	const m = new Map<string, Tool>();
	workItemTools(roomId, agentId)({ registerTool: (t: unknown) => m.set((t as { name: string }).name, t as Tool) });
	return m;
}
const say = async (t: Tool | undefined, p: Record<string, unknown>) => (await t!.execute("x", p)).content[0]!.text;
const base = { requirement: "写一份可检查的结果", doneCriteria: "结果里能看到检查点" };
const count = (roomId: string) => (db.prepare("SELECT COUNT(*) n FROM work_items WHERE room_id = ?").get(roomId) as { n: number }).n;

test("管理者把任务派给自己且群里有其他成员：不创建，提示带成员名单和角色；带 selfReason 才创建并记原因", async () => {
	const t = toolsOf(room.id, "wm");
	db.prepare("UPDATE agents SET persona = ? WHERE id = 'wa'").run("你在群里的角色：写手\n负责写报告");
	const before = count(room.id);
	const msg = await say(t.get("work_create"), { title: "自揽", ...base, owner: "经理", start: false });
	assert.match(msg, /先别派给自己/);
	assert.match(msg, /甲：写手/);
	assert.match(msg, /乙/);
	assert.match(msg, /selfReason/);
	assert.equal(count(room.id), before, "没有创建");
	const ok = await say(t.get("work_create"), { title: "自揽", ...base, owner: "经理", selfReason: "群里没有写作成员", start: false });
	assert.match(ok, /已记录任务/);
	assert.equal(count(room.id), before + 1);
	const id = /编号 (wi_\w+)/.exec(ok)![1]!;
	assert.ok(db.prepare("SELECT 1 FROM work_item_events WHERE work_item_id = ? AND kind = 'self_owner_reason'").get(id), "原因记进任务事件");
	const given = await say(t.get("work_create"), { title: "给成员", ...base, owner: "甲", start: false });
	assert.match(given, /已记录任务/, "派给别的成员不拦");
});

test("只有管理者一人：派给自己不拦", async () => {
	const solo = rooms.createRoom({ name: "独自一群", memberIds: ["wm"], managerId: "wm" });
	const out = await say(toolsOf(solo.id, "wm").get("work_create"), { title: "自己做", ...base, owner: "经理", start: false });
	assert.match(out, /已记录任务/);
});

test("改派给管理者自己：同样规则", async () => {
	const t = toolsOf(room.id, "wm");
	const made = await say(t.get("work_create"), { title: "改派用", ...base, owner: "乙", start: false });
	const id = /编号 (wi_\w+)/.exec(made)![1]!;
	const msg = await say(t.get("work_update"), { workItemId: id, action: "assign", owner: "经理" });
	assert.match(msg, /先别派给自己/);
	assert.equal(row(id).ownerName, "乙", "负责人没变");
	const ok = await say(t.get("work_update"), { workItemId: id, action: "assign", owner: "经理", selfReason: "乙已经掉线且无人接手" });
	assert.match(ok, /已改派/);
	assert.equal(row(id).ownerAgentId, "wm");
	assert.ok(db.prepare("SELECT 1 FROM work_item_events WHERE work_item_id = ? AND kind = 'self_owner_reason'").get(id));
});

test("群成员规则：名单以当前名字为准，带「以名单为准」的硬规则；改名后重新取规则只有新名字", () => {
	const other = rooms.createRoom({ name: "第二个群", memberIds: ["wm", "wb"], managerId: "wm" });
	const before = rooms.roomRules(other.id, "wm").join("\n");
	assert.match(before, /- 乙/);
	assert.match(before, /成员的名字一律以这份名单为准；历史消息里出现的其他称呼（比如改名前的旧名字）都不算，称呼时统一用名单里的名字。/);
	db.prepare("UPDATE agents SET name = '乙乙' WHERE id = 'wb'").run();
	const after = rooms.roomRules(other.id, "wm").join("\n");
	assert.match(after, /- 乙乙/);
	assert.doesNotMatch(after, /- 乙[^乙]/);
	db.prepare("UPDATE agents SET name = '乙' WHERE id = 'wb'").run();
});
