/** 消息时间显示：今天 / 昨天 / 今年更早 / 往年 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtClock, fmtFullTime } from "../../../apps/web/src/clock.ts";

test("fmtClock：今天只显示时分（可带前缀），昨天、今年更早、往年逐级带上日期", () => {
	const now = new Date(2026, 10, 15, 21, 0).getTime();
	assert.equal(fmtClock(new Date(2026, 10, 15, 9, 5).getTime(), "", now), "09:05");
	assert.equal(fmtClock(new Date(2026, 10, 15, 13, 36).getTime(), "今天 ", now), "今天 13:36");
	assert.equal(fmtClock(new Date(2026, 10, 14, 23, 59).getTime(), "今天 ", now), "昨天 23:59");
	assert.equal(fmtClock(new Date(2026, 0, 3, 8, 0).getTime(), "", now), "1月3日 08:00");
	assert.equal(fmtClock(new Date(2025, 11, 31, 18, 30).getTime(), "", now), "2025年12月31日 18:30");
	assert.equal(fmtFullTime(new Date(2026, 10, 15, 13, 36, 5).getTime()), "2026年11月15日 13:36:05");
});
