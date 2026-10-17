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

test("关闭但请求里本来就有服务配置的档位：如实标 externally-configured，不说本次标准档", () => {
	const text = fastStatusText(meta({ requested: false, status: "externally-configured", observed: null, observedKind: "unknown" }));
	assert.equal(text, "Fast · 请求里已带服务配置的档位");
	assert.ok(!text.includes("标准档"));
	assert.match(fastStatusDetail(meta({ requested: false, status: "externally-configured" })), /关闭只停止本开关附加参数|以服务商账单为准/);
});
