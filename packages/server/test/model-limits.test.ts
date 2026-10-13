import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLimits, knownLimits, resolveLimits } from "../src/pi-adapter/model-limits.ts";

test("从模型列表接口识别：OpenRouter / vLLM / new-api / Gemini / Anthropic 字段", () => {
	assert.deepEqual(detectLimits({ id: "x", context_length: 131072, top_provider: { max_completion_tokens: 16384 } }), { contextWindow: 131072, maxTokens: 16384 });
	assert.deepEqual(detectLimits({ id: "x", max_model_len: 32768 }), { contextWindow: 32768, maxTokens: undefined });
	assert.deepEqual(detectLimits({ name: "models/gemini", inputTokenLimit: 1048576, outputTokenLimit: 65536 }), { contextWindow: 1048576, maxTokens: 65536 });
	assert.deepEqual(detectLimits({ id: "c", max_input_tokens: 200000, max_tokens: 64000 }), { contextWindow: 200000, maxTokens: 64000 });
	assert.deepEqual(detectLimits({ id: "x", context_window: "65536", max_tokens: 65536 }), { contextWindow: 65536, maxTokens: undefined }, "输出 ≥ 上下文视为无效");
	assert.deepEqual(detectLimits({ id: "x" }), { contextWindow: undefined, maxTokens: undefined });
});

test("已知模型：先匹配 Pi 内置目录（去厂商前缀），再查常见模型表", () => {
	const builtin = [{ id: "deepseek-chat", contextWindow: 128000, maxTokens: 8192 }, { id: "gpt-4o", contextWindow: 128000, maxTokens: 16384 }];
	assert.deepEqual(knownLimits("deepseek-ai/deepseek-chat", builtin), { contextWindow: 128000, maxTokens: 8192 });
	assert.deepEqual(knownLimits("openai/gpt-4o", builtin), { contextWindow: 128000, maxTokens: 16384 });
	assert.ok(knownLimits("kimi-k2-0905-preview", [])!.contextWindow >= 256000);
	assert.ok(knownLimits("doubao-seed-1.6", []));
	assert.equal(knownLimits("totally-unknown-thing", []), null);
});

test("综合顺序：用户 > 识别 > 已知 > 默认；输出不超过上下文", () => {
	assert.deepEqual(resolveLimits({ id: "x" }, undefined, []), { contextWindow: 128000, maxTokens: 8192, source: "default" });
	assert.deepEqual(resolveLimits({ id: "x" }, { contextWindow: 32768 }, []), { contextWindow: 32768, maxTokens: 8192, source: "detected" });
	assert.deepEqual(resolveLimits({ id: "x" }, { contextWindow: 8192 }, []), { contextWindow: 8192, maxTokens: 2048, source: "detected" });
	assert.deepEqual(resolveLimits({ id: "glm-4.6", contextWindow: 50000, maxTokens: 1000, limitsSource: "user" }, { contextWindow: 9 }, []), { contextWindow: 50000, maxTokens: 1000, source: "user" });
});

test("已知模型：只认同一个模型，不做前缀模糊匹配；官方优先，否则取多数", () => {
	const b = [
		{ provider: "baseten", id: "zai-org/GLM-5.3", contextWindow: 1048576, maxTokens: 262144 },
		{ provider: "zai", id: "glm-5.3", contextWindow: 1000000, maxTokens: 131072 },
		{ provider: "x", id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000 },
		{ provider: "a", id: "deepseek-ai/DeepSeek-V4-Flash-0731", contextWindow: 1048576, maxTokens: 384000 },
		{ provider: "b", id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 },
		{ provider: "c", id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 1000000 },
		{ provider: "moonshotai", id: "kimi-k2.6", contextWindow: 262144, maxTokens: 262144 },
		{ provider: "o", id: "kimi-k2.6", contextWindow: 262144, maxTokens: 65536 },
	];
	assert.deepEqual(knownLimits("glm-5.3", b), { contextWindow: 1000000, maxTokens: 131072 }, "官方 zai 优先");
	assert.deepEqual(knownLimits("glm-5.3-flash", b.slice(0, 2)), { contextWindow: 128000, maxTokens: 32768 }, "不能套用 glm-5.3 的上限");
	assert.deepEqual(knownLimits("deepseek-v4-flash", b), { contextWindow: 1000000, maxTokens: 384000 }, "输出≥上下文的条目不参与");
	assert.deepEqual(knownLimits("deepseek-v4-flash-0731", b.slice(2, 4)), { contextWindow: 1048576, maxTokens: 384000 }, "只差日期快照算同一模型");
	assert.deepEqual(knownLimits("kimi-k2.6", b), { contextWindow: 262144, maxTokens: 65536 }, "官方输出无效时参考其他托管商");
});

test("已知 / 默认的旧值会按新规则重算，手动和接口识别的不动", () => {
	assert.deepEqual(resolveLimits({ id: "x", contextWindow: 1048576, maxTokens: 384000, limitsSource: "known" }, undefined, []), { contextWindow: 128000, maxTokens: 8192, source: "default" });
	assert.deepEqual(resolveLimits({ id: "x", contextWindow: 9000, maxTokens: 900, limitsSource: "detected" }, undefined, []), { contextWindow: 9000, maxTokens: 900, source: "detected" });
});
