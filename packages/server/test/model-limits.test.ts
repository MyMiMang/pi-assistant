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
	assert.deepEqual(resolveLimits({ id: "x" }, undefined, []), { contextWindow: 262144, maxTokens: 131072, source: "default" });
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
	assert.deepEqual(knownLimits("glm-5.3-flash", b.slice(0, 2)), { contextWindow: 128000, maxTokens: 32000 }, "不能套用 glm-5.3 的上限");
	assert.deepEqual(knownLimits("deepseek-v4-flash", b), { contextWindow: 1000000, maxTokens: 384000 }, "输出≥上下文的条目不参与");
	assert.deepEqual(knownLimits("deepseek-v4-flash-0731", b.slice(2, 4)), { contextWindow: 1048576, maxTokens: 384000 }, "只差日期快照算同一模型");
	assert.deepEqual(knownLimits("kimi-k2.6", b), { contextWindow: 262144, maxTokens: 65536 }, "官方输出无效时参考其他托管商");
});

test("已知 / 默认的旧值会按新规则重算，手动和接口识别的不动", () => {
	assert.deepEqual(resolveLimits({ id: "x", contextWindow: 1048576, maxTokens: 384000, limitsSource: "known" }, undefined, []), { contextWindow: 262144, maxTokens: 131072, source: "default" });
	assert.deepEqual(resolveLimits({ id: "x", contextWindow: 9000, maxTokens: 900, limitsSource: "detected" }, undefined, []), { contextWindow: 9000, maxTokens: 900, source: "detected" });
});

test("模型参数库（models.dev 快照）：常见 id 都能匹配，同服务商优先", async () => {
	const { readFileSync } = await import("node:fs");
	const { indexModelDb, providerHint } = await import("../src/pi-adapter/model-limits.ts");
	const db = indexModelDb(JSON.parse(readFileSync(new URL("../model-db.json", import.meta.url), "utf8")).providers);
	const ids = ["deepseek-chat", "deepseek-reasoner", "deepseek/deepseek-v4-flash", "gpt-4o", "gpt-4.1-mini", "claude-sonnet-4-5", "gemini-2.5-pro", "qwen-plus", "qwen3-coder-plus", "glm-4.6", "kimi-k2-0905-preview", "moonshotai/Kimi-K2-Instruct", "MiniMax-M2", "grok-4", "llama-3.3-70b-instruct", "accounts/fireworks/models/deepseek-v4p1-flash", "deepseek-v3:free"];
	const hit = ids.filter((id) => knownLimits(id, db));
	assert.equal(hit.length, ids.length, `未匹配：${ids.filter((x) => !hit.includes(x))}`);
	assert.deepEqual(providerHint("https://api.deepseek.com/v1"), ["deepseek"]);
	assert.deepEqual(knownLimits("deepseek-v4-flash", db, ["deepseek"]), { contextWindow: 1000000, maxTokens: 393216 });
	const syn = [{ provider: "a", id: "m-1", contextWindow: 100000, maxTokens: 9000 }, { provider: "a2", id: "m-1", contextWindow: 100000, maxTokens: 9000 }, { provider: "mine", id: "M-1", contextWindow: 50000, maxTokens: 4000 }];
	assert.deepEqual(knownLimits("m-1", syn, ["mine"]), { contextWindow: 50000, maxTokens: 4000 }, "同服务商优先于多数");
	assert.equal(knownLimits("totally-unknown-xyz", db), null);
});

test("默认 256K / 128K", () => {
	assert.deepEqual(resolveLimits({ id: "totally-unknown-xyz" }, undefined, []), { contextWindow: 262144, maxTokens: 131072, source: "default" });
});

test("从报错学上限：有给值用给值，没有逐级下调；限流不算", async () => {
	const { learnFromError } = await import("../src/pi-adapter/model-limits.ts");
	const cur = { contextWindow: 262144, maxTokens: 131072 };
	assert.deepEqual(learnFromError("400 Invalid max_tokens value, the valid range of max_tokens is [1, 8192]", cur), { maxTokens: 8192, contextWindow: undefined, retry: true });
	assert.equal(learnFromError("max_tokens is too large: 131072. This model supports at most 32768 completion tokens, whereas you provided 131072.", cur)!.maxTokens, 32768);
	assert.equal(learnFromError("max_tokens: 131072 > 64000, which is the maximum allowed number of output tokens for claude-x", cur)!.maxTokens, 64000);
	assert.deepEqual(learnFromError("'max_tokens' or 'max_completion_tokens' is too large: 131072. This model's maximum context length is 65536 tokens and your request has 1200 input tokens", cur), { maxTokens: 64336, contextWindow: 65536, retry: true });
	assert.equal(learnFromError("Error: max_tokens exceeds model limit", cur)!.maxTokens, 65536, "没给值：128K → 64K");
	assert.equal(learnFromError("Error: max_tokens exceeds model limit", { ...cur, maxTokens: 65536 })!.maxTokens, 32768);
	assert.equal(learnFromError("Error: max_tokens exceeds model limit", { ...cur, maxTokens: 8192 }), null, "到底了不再降");
	assert.equal(learnFromError("Rate limit reached for output tokens per minute", cur), null);
	assert.deepEqual(learnFromError("This model's maximum context length is 131072 tokens. However, your messages resulted in 200000 tokens.", cur), { contextWindow: 131072, retry: false });
	assert.equal(learnFromError("401 invalid api key", cur), null);
});

test("会话自动重试：max_tokens 太大被拒 → 调小会话里的模型、记住、让 Pi 重试；降到底不再重试", async () => {
	const { installLimitLearning, setLimitsLearner } = await import("../src/pi-adapter/index.ts");
	const learned: unknown[] = [];
	setLimitsLearner(async (p, m, l) => (learned.push([p, m, l]), true));
	const s = { model: { provider: "cp", id: "m", contextWindow: 262144, maxTokens: 131072 }, _isRetryableError: () => false } as never as Parameters<typeof installLimitLearning>[0];
	installLimitLearning(s);
	const call = (m: unknown) => (s as unknown as { _isRetryableError: (m: unknown) => boolean })._isRetryableError(m);
	const isR = (msg: string) => call({ stopReason: "error", errorMessage: msg, provider: "cp", model: "m" });
	const first = { stopReason: "error", errorMessage: "400 max_tokens is too large, the valid range of max_tokens is [1, 16384]", provider: "cp", model: "m" };
	assert.equal(call(first), true);
	assert.equal(call(first), true, "Pi 对同一条消息问两次：结果一致，不再降");
	assert.equal((s as unknown as { model: { maxTokens: number } }).model.maxTokens, 16384);
	assert.deepEqual(learned, [["cp", "m", { contextWindow: undefined, maxTokens: 16384 }]]);
	assert.equal(isR("Error: max_tokens exceeds model limit"), true, "没给值的新报错：再降一级");
	assert.equal((s as unknown as { model: { maxTokens: number } }).model.maxTokens, 8192);
	assert.equal(isR("Error: max_tokens exceeds model limit"), false, "降到底就交给 Pi 原来的判断，不会无限重试");
	assert.equal(isR("401 bad key"), false);
	setLimitsLearner(null);
});
