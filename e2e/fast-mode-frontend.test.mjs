/**
 * Fast 消息状态文案（纯函数，node:test；不启动浏览器 / 不构建 / 不连模型）。
 *
 * 事实边界（合同见 docs/design/fast-mode-contract.md）：
 * - 只有终止事件回显才可能是实际档位；created / chunk 只是「服务回显」，来源可能是 requested；
 * - default 不等于按标准档计费、也不等于没走 Fast（Codex OAuth 常见），不能写「被降级为标准档」；
 * - 费用以服务商账单为准，不承诺通用倍率。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fastStatusDetail, fastStatusText } from "../apps/web/src/fast-mode.ts";
import { LatestWrite, SerialWriteQueue } from "../apps/web/src/latest-write.ts";

const meta = (p) => ({ requested: true, status: "injected", capability: "requestable-unverified", api: "openai-completions", observed: null, observedKind: "unknown", ...p });

test("终止事件 priority：只说服务回显 Fast，不保证更快", () => {
	const text = fastStatusText(meta({ observed: "priority", observedKind: "fast" }));
	assert.equal(text, "Fast · 服务回显 priority");
	assert.match(fastStatusDetail(meta({ observed: "priority", observedKind: "fast" })), /不保证实际耗时一定更快/);
});

test("终止事件 default：不称「标准档 / 已降费」，只写实际加速未确认", () => {
	const text = fastStatusText(meta({ observed: "default", observedKind: "standard" }));
	assert.equal(text, "Fast · 服务回显 default（实际加速未确认）");
	assert.ok(!text.includes("标准档"));
	const detail = fastStatusDetail(meta({ observed: "default", observedKind: "standard" }));
	assert.match(detail, /不等于按标准档计费/);
	assert.match(detail, /不等于没走 Fast/);
	assert.match(detail, /以服务商账单为准/);
	assert.ok(!detail.includes("已降费"));
});

test("非终止回显（created / chunk）：标来源未确认，不当实际档位", () => {
	const text = fastStatusText(meta({ reported: "priority", reportedKind: "fast" }));
	assert.equal(text, "Fast · 服务回显 priority（来源未确认）");
	assert.match(fastStatusDetail(meta({ reported: "priority", reportedKind: "fast" })), /不能证明实际用了快档/);
	const def = fastStatusText(meta({ reported: "default", reportedKind: "standard" }));
	assert.equal(def, "Fast · 服务回显 default（实际加速未确认）");
});

test("没有回显：只说已请求，实际未知；关闭且没有外部配置时不占位", () => {
	assert.equal(fastStatusText(meta({})), "Fast · 已请求，服务未回显实际档位");
	assert.equal(fastStatusText(null), null);
	assert.equal(fastStatusText(meta({ requested: false, status: "off" })), null);
});

test("未开启：普通 default/auto/flex 回显和外部普通档位不常驻显示 Fast；旧消息同样处理", () => {
	for (const status of ["off", "externally-configured"]) {
		for (const enabled of [false, undefined]) {
			for (const [tier, kind] of [["default", "standard"], ["auto", "other"], ["flex", "other"]]) {
				assert.equal(fastStatusText(meta({ enabled, requested: false, status, observed: tier, observedKind: kind })), null);
				assert.equal(fastStatusText(meta({ enabled, requested: false, status, reported: tier, reportedKind: kind })), null);
			}
		}
	}
});

test("未开启但服务配置请求了 priority 或服务明确回显快档：保留事实与风险，不冒充用户开启", () => {
	const external = meta({ enabled: false, requested: true, status: "externally-configured", observed: "default", observedKind: "standard" });
	assert.equal(fastStatusText(external), "Fast · 服务配置已带 priority（本开关未开启）");
	assert.match(fastStatusDetail(external), /Fast 开关未开启/);
	assert.match(fastStatusDetail(external), /以服务商账单为准/);
	const off = meta({ enabled: false, requested: false, status: "off", observed: "priority", observedKind: "fast" });
	assert.equal(fastStatusText(off), "服务档位 · 回显 priority（实际加速未确认；Fast 开关未开启）");
	assert.match(fastStatusText(meta({ enabled: false, requested: false, status: "off", reported: "priority", reportedKind: "fast" })), /来源未确认；Fast 开关未开启/);
});

test("消息展示以本次请求快照为准：开着但未发仍说明原因，后来关灯也不擦掉旧 Fast 请求", () => {
	assert.match(fastStatusText(meta({ enabled: true, requested: false, status: "unsupported-api" })), /本次未请求/);
	assert.match(fastStatusText(meta({ enabled: true, requested: false, status: "bad-payload" })), /请求体异常/);
	assert.match(fastStatusText(meta({ enabled: true, requested: false, status: "conflict" })), /已有其他档位/);
	assert.equal(fastStatusText(meta({ enabled: true, observed: "default", observedKind: "standard" })), "Fast · 服务回显 default（实际加速未确认）");
});

test("Fast 保存顺序：同一助理的写入串行，后一次不会越过前一次抵达服务端", async () => {
	const queue = new SerialWriteQueue();
	const sent = [];
	let releaseFirst;
	const first = queue.run(async () => {
		sent.push("A");
		await new Promise((r) => (releaseFirst = r));
		return "A";
	});
	const second = queue.run(async () => {
		sent.push("B");
		return "B";
	});
	// 第一次还没完成：第二次必须还在排队（不能并发，否则服务端可能先处理后发的那个）
	await Promise.resolve();
	assert.deepEqual(sent, ["A"]);
	releaseFirst();
	assert.deepEqual(await Promise.all([first, second]), ["A", "B"]);
	assert.deepEqual(sent, ["A", "B"]);
});

test("Fast 保存顺序：前一次失败不会卡住 / 吞掉后一次写入", async () => {
	const queue = new SerialWriteQueue();
	const sent = [];
	const first = queue.run(async () => {
		sent.push("A");
		throw new Error("模拟第一次保存失败");
	});
	const second = queue.run(async () => {
		sent.push("B");
		return "B";
	});
	await assert.rejects(first, /第一次保存失败/);
	assert.equal(await second, "B");
	assert.deepEqual(sent, ["A", "B"]);
});

test("Fast 保存顺序：搭 LatestWrite 时，前一次迟到失败不回滚、不影响最新一次", async () => {
	const queue = new SerialWriteQueue();
	const w = new LatestWrite("1");
	const firstGen = w.begin();
	const secondGen = w.begin();
	assert.equal(w.isCurrent(firstGen), false, "后一次点击后，前一次已不是最新");
	await assert.rejects(queue.run(async () => Promise.reject(new Error("A 失败"))), /A 失败/);
	assert.deepEqual(w.fail(firstGen), { rollback: false, value: null }, "迟到失败不回滚界面");
	const second = await queue.run(async () => "B");
	assert.equal(second, "B");
	assert.equal(w.confirm(secondGen, "0"), true);
	assert.deepEqual(w.fail(secondGen), { rollback: true, value: "0" }, "最新一次失败回滚到服务端确认值");
});
