/**
 * 「默认本地语音」纯语义：默认解析（数据驱动、fail closed）+ 「不覆盖用户已选」+ 归一化视图。
 *
 * 边界：不下载任何权重、不联网、不读用户文件、不起 worker；只跑纯函数。
 * 本文件为新增件，未接入现有链路（接线步骤见 docs/design/default-local-voice.md §8 第 7 项）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultVoiceView, resolveDefaultVoiceId, shouldAdoptDefault, type DefaultVoiceCandidate } from "../src/local-asr/default-voice.ts";

const streaming: DefaultVoiceCandidate = { id: "streaming-default", streaming: true, defaultVoice: true, selfServe: true };

test("默认模型由数据决定：唯一标记 + 原生流式 + 本地下载放行 → 解析成功", () => {
	const specs: DefaultVoiceCandidate[] = [{ id: "offline-a", streaming: false }, streaming, { id: "offline-b" }];
	assert.deepEqual(resolveDefaultVoiceId(specs), { ok: true, id: "streaming-default" });
});

test("没有标记 / 多个标记 / 非流式 / 未放行 一律 fail closed（绝不猜、不回落第一个本地模型）", () => {
	assert.equal(resolveDefaultVoiceId([{ id: "a" }, { id: "b" }]).ok, false);
	assert.equal(resolveDefaultVoiceId([streaming, { id: "c", streaming: true, defaultVoice: true, selfServe: true }]).ok, false);
	assert.equal(resolveDefaultVoiceId([{ id: "a", streaming: false, defaultVoice: true, selfServe: true }]).ok, false);
	assert.equal(resolveDefaultVoiceId([{ id: "a", streaming: true, defaultVoice: true, selfServe: false }]).ok, false);
	assert.equal(resolveDefaultVoiceId([]).ok, false);
});

test("只有从未配置（null）才允许采用默认：已选过本地或云端都不覆盖", () => {
	assert.equal(shouldAdoptDefault(null), true);
	assert.equal(shouldAdoptDefault(undefined), true);
	assert.equal(shouldAdoptDefault({ location: "local", provider: "local-paraformer", model: "paraformer-zh-2023-09-14-int8" }), false);
	assert.equal(shouldAdoptDefault({ location: "cloud", provider: "openai", model: "whisper-1" }), false);
});

test("视图：未配置 → 提示默认；正在用默认 → default；用户自选 → user-chosen（canAdopt 只是显式入口，不自动改）", () => {
	const resolved = { ok: true as const, id: "streaming-default" };
	const fresh = defaultVoiceView({ current: null, resolved });
	assert.equal(fresh.kind, "unconfigured");
	assert.equal(fresh.defaultModelId, "streaming-default");
	assert.equal(fresh.canAdopt, true);

	const usingDefault = defaultVoiceView({ current: { location: "local", provider: "local-online-zipformer", model: "streaming-default" }, resolved });
	assert.equal(usingDefault.kind, "default");
	assert.equal(usingDefault.canAdopt, false);

	const chosenLocal = defaultVoiceView({ current: { location: "local", provider: "local-paraformer", model: "paraformer-zh-2023-09-14-int8" }, resolved });
	assert.equal(chosenLocal.kind, "user-chosen");
	assert.match(chosenLocal.label, /paraformer-zh-2023-09-14-int8/);

	const chosenCloud = defaultVoiceView({ current: { location: "cloud", provider: "openai", model: "whisper-1" }, resolved });
	assert.equal(chosenCloud.kind, "user-chosen");
	assert.match(chosenCloud.label, /云端/);
});

test("目录里没有默认标记时：视图仍给出用户已选事实，不编造默认模型", () => {
	const view = defaultVoiceView({ current: { location: "cloud", provider: "p", model: "m" }, resolved: { ok: false, reason: "没有标记" } });
	assert.equal(view.kind, "user-chosen");
	assert.equal(view.defaultModelId, null);
	assert.equal(view.canAdopt, false);
});
