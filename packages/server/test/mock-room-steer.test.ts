/** Mock 群聊：管理者忙时用户在群里说「可以」（以 steer 插话送达）也要确认方案，不能当成新的立项（group-collab-ui 第 5 步的偶发失败）。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { roomReply, roomSteerPrompt } from "../src/pi-adapter/mock-room-provider.ts";

type M = Parameters<typeof roomReply>[2];
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as unknown as M;
const sys = "群里有这些助理：\n- 组长（管理者）（你）\n- 甲\n成员的名字一律以这份名单为准";

test("忙时插话的「可以」：换成群消息抬头交给 roomReply，管理者用 room_project_start 确认", () => {
	const history = [
		user("（群聊「验收群」里的新消息 · 你是 组长（管理者））\n【用户】立项：写一份周报模板"),
		{ role: "toolResult", toolName: "room_plan", content: [{ type: "text", text: "方案卡已发给用户（项目编号 pj_abc123）。" }] } as unknown as M,
		user("（你工作时用户发来的新消息）\n（用户在群里说）可以"),
	];
	const u = roomSteerPrompt("（用户在群里说）可以", sys, history);
	assert.equal(u, "（群聊「验收群」里的新消息 · 你是 组长（管理者））\n【用户】可以");
	const reply = roomReply(u!, sys, history[2], history) as unknown as { content: { type: string; name?: string; arguments?: { projectId?: string } }[] };
	const call = reply.content.find((b) => b.type === "toolCall");
	assert.equal(call?.name, "room_project_start");
	assert.equal(call?.arguments?.projectId, "pj_abc123");
});

test("不是群会话（名单里没有「（你）」）不当群消息处理", () => {
	assert.equal(roomSteerPrompt("（用户在群里说）可以", "你是一个助理", [user("（群聊「x」里的新消息 · 你是 a）")]), null);
	assert.equal(roomSteerPrompt("普通的话", sys, []), null);
});
