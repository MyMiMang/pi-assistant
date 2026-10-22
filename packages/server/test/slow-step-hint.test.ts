/** 前端纯逻辑：一步跑太久时的提示（apps/web/src/slowStep.ts）。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { slowStepHint } from "../../../apps/web/src/slowStep.ts";

test("一步跑超过 1 分钟才提示，提到权限弹窗和「停」；不在跑就不提示", () => {
	const t0 = 1_000_000;
	assert.equal(slowStepHint(undefined, t0 + 600_000), null, "不在跑");
	assert.equal(slowStepHint(t0, t0 + 59_000), null, "不到 1 分钟");
	const h = slowStepHint(t0, t0 + 3 * 60_000 + 5_000);
	assert.match(h ?? "", /已经 3 分钟了/);
	assert.match(h ?? "", /权限弹窗/);
	assert.match(h ?? "", /「停」/);
});
