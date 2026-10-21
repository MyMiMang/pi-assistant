import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { SYSTEM_RULES, USER_TALK_RULE } from "../src/agent-runtime/system-rules.ts";

test("跟用户说话的规矩：单聊 / 群聊 / 后台共用的系统规则里都有，只管写给用户看的话", () => {
	const rules = SYSTEM_RULES("小助", "/tmp/ws", "");
	assert.ok(rules.includes(USER_TALK_RULE), "所有会话共用的系统规则里带上说话方式");
	assert.ok(SYSTEM_RULES("小助", "/tmp/ws", "", true).includes(USER_TALK_RULE), "完全权限档位也带上");
	// 只管对用户说的话，不影响思考、工具调用和给帮手 / 成员的交代
	assert.match(USER_TALK_RULE, /只管你最后写给用户看的话/);
	assert.match(USER_TALK_RULE, /思考、调用工具、写文件、给帮手或其他成员交代任务时照常用精确、专业的表达/);
	// 核心要求：先想清楚、先说结论、不甩工具名和代码、不打官腔、汇报三件事
	for (const re of [/开口前先想清楚/, /先说结论/, /不要出现工具名、函数名/, /不打官腔/, /做到哪了、接下来做什么、需要用户做什么/]) assert.match(USER_TALK_RULE, re);
});
