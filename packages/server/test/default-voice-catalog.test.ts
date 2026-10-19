/**
 * 默认本地语音：目录标记解析（纯逻辑，不下载、不联网、不起 worker）。
 * 本地语音是可选模块：不再有启动时自动准备（决策 0013），默认只由 catalog 数据决定（唯一标记、fail closed）。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { asrModelSpec, defaultVoiceCandidates, resolveCatalogDefaultVoice } from "../src/local-asr/catalog.ts";
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
