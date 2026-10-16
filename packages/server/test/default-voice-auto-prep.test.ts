/**
 * 默认本地语音：目录标记解析 + 自动准备资格 + 标记读写（纯逻辑 / 临时数据目录，不下载、不联网、不起 worker）。
 *
 * 覆盖用户要求：默认只由 catalog 数据决定（唯一标记、fail closed）；**不覆盖**已选来源；
 * unset（key 不存在）才自动准备；显式清空 / 取消 / 改选其它 → 记 intent，不 restart。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { asrModelSpec, defaultVoiceCandidates, resolveCatalogDefaultVoice } from "../src/local-asr/catalog.ts";
import { clearDefaultOptOut, defaultVoiceEligible, readDefaultInit, readDefaultOptOut, writeDefaultInit, writeDefaultOptOut } from "../src/local-asr/default-voice-prep.ts";
import { ONLINE_ZIPFORMER_MODEL_ID } from "../src/local-asr/manifest.ts";

test("目录里恰好一个默认本地语音标记，且解析为原生流式 zipformer（数据驱动，非硬编码）", () => {
	const cands = defaultVoiceCandidates();
	assert.equal(cands.filter((c) => c.defaultVoice).length, 1);
	assert.deepEqual(resolveCatalogDefaultVoice(), { ok: true, id: ONLINE_ZIPFORMER_MODEL_ID });
	const spec = asrModelSpec(ONLINE_ZIPFORMER_MODEL_ID);
	assert.equal(spec?.streaming, true);
	assert.equal(spec?.adapter?.protocol, "asr-stream-v1");
	assert.equal(spec?.family, "online-zipformer");
	// 许可：本地自用放行、不随包分发、整体 unresolved（不假称 bundle 商用 clear）。
	assert.equal(spec?.license.selfServe, true);
	assert.equal(spec?.license.redistribution, false);
	assert.equal(spec?.license.decision, "unresolved");
	// 不影响 SenseVoice 原选项：目录里仍在。
	assert.ok(asrModelSpec("sensevoice-small-int8"));
});

test("自动准备资格：只有 unset（key 不存在）且无 init / optout 才启动", () => {
	const base = { sourceKeyPresent: false, source: null, init: null, optout: null, defaultModelId: ONLINE_ZIPFORMER_MODEL_ID };
	assert.equal(defaultVoiceEligible(base).eligible, true);
	// 显式清空（key 存在且为 null）→ 不自动准备
	assert.equal(defaultVoiceEligible({ ...base, sourceKeyPresent: true }).eligible, false);
	// 已选云 / 本地 → 一律不动
	assert.equal(defaultVoiceEligible({ ...base, source: { location: "cloud", provider: "p", model: "m" } }).eligible, false);
	assert.equal(defaultVoiceEligible({ ...base, source: { location: "local", provider: "local-paraformer", model: "paraformer-zh-2023-09-14-int8" } }).eligible, false);
	// 已启动过一次 / 已取消过 → 不 restart
	assert.equal(defaultVoiceEligible({ ...base, init: { at: "2026-10-17T00:00:00.000Z", modelId: ONLINE_ZIPFORMER_MODEL_ID, sourceVersionAtStart: 0 } }).eligible, false);
	assert.equal(defaultVoiceEligible({ ...base, optout: { at: "2026-10-17T00:00:00.000Z", reason: "cancelled" } }).eligible, false);
	// 目录没有默认标记 → fail closed
	assert.equal(defaultVoiceEligible({ ...base, defaultModelId: null }).eligible, false);
});

test("标记读写与清空（走临时数据目录，不碰真实用户库）", () => {
	assert.equal(readDefaultInit(), null);
	writeDefaultInit({ at: "2026-10-17T00:00:00.000Z", modelId: ONLINE_ZIPFORMER_MODEL_ID, sourceVersionAtStart: 3 });
	assert.deepEqual(readDefaultInit(), { at: "2026-10-17T00:00:00.000Z", modelId: ONLINE_ZIPFORMER_MODEL_ID, sourceVersionAtStart: 3 });

	assert.equal(readDefaultOptOut(), null);
	writeDefaultOptOut("user_cleared");
	assert.equal(readDefaultOptOut()?.reason, "user_cleared");
	clearDefaultOptOut();
	assert.equal(readDefaultOptOut(), null);
});
