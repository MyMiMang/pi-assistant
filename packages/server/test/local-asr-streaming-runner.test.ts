/**
 * `online-zipformer` 运行族：权重角色校验（fail closed）+ 生成的 sidecar 是**原生流式**（from_transducer），
 * 且**不改动**离线路径（脚本里不出现 OfflineRecognizer）。
 *
 * 不执行 Python、不下载权重；只校验生成源码与角色规则。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { asrModelSpec } from "../src/local-asr/catalog.ts";
import { ONLINE_ZIPFORMER_MODEL, ONLINE_ZIPFORMER_MODEL_ID } from "../src/local-asr/manifest.ts";
import { asrRunnerFamily, hasAsrRunnerFamily, runnerRolesOf } from "../src/local-asr/runner.ts";

test("online-zipformer 族已注册，角色齐全（encoder/decoder/joiner/tokens）", () => {
	assert.equal(hasAsrRunnerFamily("online-zipformer"), true);
	const family = asrRunnerFamily("online-zipformer");
	assert.deepEqual([...family.requiredRoles].sort(), ["decoder", "encoder", "joiner", "tokens"]);
	const roles = runnerRolesOf(ONLINE_ZIPFORMER_MODEL, family);
	assert.equal(roles.ok, true);
});

test("角色缺失 → fail closed（不假装支持）", () => {
	const family = asrRunnerFamily("online-zipformer");
	const broken = { ...ONLINE_ZIPFORMER_MODEL, fileRoles: { encoder: ONLINE_ZIPFORMER_MODEL.fileRoles?.encoder ?? "", decoder: "d.onnx", tokens: "tokens.txt" } };
	const roles = runnerRolesOf(broken, family);
	assert.equal(roles.ok, false);
});

test("生成的流式 sidecar 用 OnlineRecognizer.from_transducer，且不含 OfflineRecognizer", () => {
	const spec = asrModelSpec(ONLINE_ZIPFORMER_MODEL_ID);
	assert.ok(spec);
	const family = asrRunnerFamily("online-zipformer");
	const src = family.serveScript({ roles: spec.manifest.fileRoles ?? {}, sampleRate: spec.manifest.sampleRate, maxAudioBytes: 8 * 1024 * 1024 });
	assert.match(src, /sherpa_onnx\.OnlineRecognizer\.from_transducer/);
	assert.match(src, /enable_endpoint_detection=True/);
	assert.match(src, /\/v1\/stream\/start/);
	assert.match(src, /\/v1\/stream\/append/);
	assert.match(src, /\/v1\/stream\/end/);
	assert.match(src, /\/v1\/stream\/cancel/);
	assert.doesNotMatch(src, /OfflineRecognizer/);
});

test("权重自检：三个 onnx + tokens；含脚本 / 非预期格式 → 拒绝", () => {
	const family = asrRunnerFamily("online-zipformer");
	const good = ONLINE_ZIPFORMER_MODEL.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
	assert.deepEqual(family.assertWeights(good), []);
	const bad = [...good, { path: "run.py", size: 1, sha256: "x" }];
	assert.ok(family.assertWeights(bad).some((p) => p.includes("脚本")));
});
