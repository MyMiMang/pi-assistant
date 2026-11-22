import assert from "node:assert/strict";
import { test } from "node:test";
import { directoryEffort, validDirectoryLevels } from "../src/pi-adapter/relay-directory-effort.ts";

const api = "openai-completions", router = "https://openrouter.ai/api/v1", vercel = "https://ai-gateway.vercel.sh/v1";
test("逐型号目录离散档位保留线路值，不推断其他协议或端点", () => {
 const row = { reasoning: { mandatory: false, supported_efforts: ["xhigh", "high", "none"] } };
 assert.deepEqual(directoryEffort(api, router, row), { reasoning: true, levels: { xhigh: "xhigh", high: "high", off: "none" } });
 assert.deepEqual(directoryEffort(api, vercel, { reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["max", "low"] }] }), { reasoning: true, levels: { max: "max", low: "low" } });
 assert.deepEqual(directoryEffort(api, router, { reasoning: { ...row.reasoning, mandatory: true } }), { reasoning: true, levels: { xhigh: "xhigh", high: "high" } });
 assert.deepEqual(directoryEffort("openai-responses", router, row), {});
 assert.deepEqual(directoryEffort(api, "https://example.invalid/api/v1", row), {});
});
test("仅布尔、参数名、未确认字段与非法枚举不生成档位", () => {
 for (const row of [{ reasoning: true }, { supported_parameters: ["reasoning_effort"] }, { thinkingLevelMap: { max: "max" } }, { reasoning: { supported_efforts: null } }, { reasoning: { supported_efforts: ["high", "wild"] } }, { reasoning: { supported_efforts: ["high", "high"] } }, { type: "image", reasoning: { supported_efforts: ["high"] } }]) assert.deepEqual(directoryEffort(api, router, row), {});
 assert.deepEqual(directoryEffort(api, vercel, { reasoning_options: [{ type: "budget_tokens" }, { type: "toggle" }] }), {});
 assert.equal(validDirectoryLevels(api, router, { high: "max" }), false);
 assert.equal(validDirectoryLevels(api, router, { high: "high", off: "none" }), true);
});
