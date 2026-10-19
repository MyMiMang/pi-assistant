/** 卡住检测共用规则（src/stuck.ts）：群任务、群对话、单聊帮手共用。纯逻辑，不碰数据库。 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import * as S from "../src/stuck.ts";

test("指纹：忽略数字 / 路径 / 编号 / 标点；太短的泛泛说法不算", () => {
	assert.equal(S.fingerprint("连接 api 超时（第 3 次） /tmp/a.log wi_abc1"), S.fingerprint("连接 api 超时，第 7 次！ /var/b.log wi_zz9"));
	assert.notEqual(S.fingerprint("连接 api 超时"), S.fingerprint("磁盘空间不足"));
	assert.equal(S.fingerprint("失败"), "");
	assert.equal(S.repeatLevel([], "abcd"), null);
	assert.equal(S.repeatLevel(["abcd"], "abcd"), "manager");
	assert.equal(S.repeatLevel(["abcd", "x", "abcd"], "abcd"), "user");
	assert.equal(S.repeatLevel(["abcd"], ""), null);
});

test("卡住检测：超时先管理者，管理者介入后仍没动静再用户；有新动静重新计时", () => {
	const base = { active: true, needsUser: false, stallMs: 100 };
	assert.equal(S.stallStep({ ...base, lastActivityAt: 0, escalation: null, now: 50 }), null);
	assert.equal(S.stallStep({ ...base, lastActivityAt: 0, escalation: null, now: 100 }), "manager");
	const esc = { kind: "stall" as const, level: "manager" as const, at: 100, note: "" };
	assert.equal(S.stallStep({ ...base, lastActivityAt: 0, escalation: esc, now: 150 }), null, "刚叫过管理者，等它处理");
	assert.equal(S.stallStep({ ...base, lastActivityAt: 0, escalation: esc, now: 200 }), "user");
	assert.equal(S.stallStep({ ...base, lastActivityAt: 180, escalation: esc, now: 200 }), null, "管理者之后有动静：重新计时");
	assert.equal(S.stallStep({ ...base, lastActivityAt: 0, escalation: { ...esc, level: "user" }, now: 999 }), null, "已经问过用户不重复");
	assert.equal(S.stallStep({ ...base, active: false, lastActivityAt: 0, escalation: null, now: 999 }), null);
	assert.equal(S.stallStep({ ...base, needsUser: true, lastActivityAt: 0, escalation: null, now: 999 }), null);
});

test("只聊不干活：到阈值先管理者，两倍阈值再用户；有进展清零", () => {
	let s = 0;
	const levels: (string | null)[] = [];
	for (let i = 0; i < 6; i++) {
		const r = S.chatterStep(s, { progressed: false, threshold: 3 });
		s = r.streak;
		levels.push(r.level);
	}
	assert.deepEqual(levels, [null, null, "manager", null, null, "user"]);
	assert.deepEqual(S.chatterStep(5, { progressed: true, threshold: 3 }), { streak: 0, level: null });
});

