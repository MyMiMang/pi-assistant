import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERJECTION_RULE, isStopCommand } from "../src/interject.ts";

test("停止指令：整条消息就是停止词才算", () => {
	for (const t of ["停", "停止", "停下。", "别做了", "不用做了！", "取消", "算了吧", "stop", "/stop", "STOP!", " 先停下 ", "请停止"]) assert.equal(isStopCommand(t), true, t);
	for (const t of ["停止这个服务", "帮我取消明天的会议", "不要停", "stop the server", "", "停车场在哪", "继续"]) assert.equal(isStopCommand(t), false, t);
});
test("系统提示里有插话处理规则", () => {
	assert.match(INTERJECTION_RULE, /你工作时用户发来的新消息/);
	assert.match(INTERJECTION_RULE, /停/);
});
