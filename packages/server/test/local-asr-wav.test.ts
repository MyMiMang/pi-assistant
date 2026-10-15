/**
 * WAV 校验 + 权重清单校验 + 「用户自行导入」路径安全。
 *
 * 边界：全部在临时目录里用**假文件**（几十字节），不下载任何权重、不联网、不读用户文件、不碰钥匙串。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkWav } from "../src/local-asr/wav.ts";
import { assertSafeImportDir, copyManifestFiles } from "../src/local-asr/deps.ts";
import { verifyAsrWeights } from "../src/local-asr/weights.ts";
import { ASR_MAX_AUDIO_BYTES, ASR_MAX_AUDIO_SECONDS } from "../src/local-asr/manifest.ts";
import { sha256File } from "../src/managed-weights/verify.ts";

/** 生成 16-bit PCM WAV（用于校验测试，不是任何真实录音）。 */
function makeWav(opts: { seconds: number; rate?: number; channels?: number; bits?: number }): Uint8Array {
	const rate = opts.rate ?? 16000;
	const channels = opts.channels ?? 1;
	const bits = opts.bits ?? 16;
	const frames = Math.round(rate * opts.seconds);
	const dataBytes = frames * channels * (bits / 8);
	const buf = new Uint8Array(44 + dataBytes);
	const dv = new DataView(buf.buffer);
	const tag = (off: number, s: string) => {
		for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
	};
	tag(0, "RIFF");
	dv.setUint32(4, 36 + dataBytes, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true);
	dv.setUint16(22, channels, true);
	dv.setUint32(24, rate, true);
	dv.setUint32(28, rate * channels * (bits / 8), true);
	dv.setUint16(32, channels * (bits / 8), true);
	dv.setUint16(34, bits, true);
	tag(36, "data");
	dv.setUint32(40, dataBytes, true);
	return buf;
}

const limits = { maxBytes: ASR_MAX_AUDIO_BYTES, maxSeconds: ASR_MAX_AUDIO_SECONDS, expectSampleRate: 16000, expectChannels: 1 };

test("WAV 校验：合法 16k mono 16bit 通过，时长按数据长度算", () => {
	const res = checkWav(makeWav({ seconds: 2.5 }), limits);
	assert.equal(res.ok, true, res.problems.join("；"));
	assert.equal(res.info?.sampleRate, 16000);
	assert.equal(res.info?.channels, 1);
	assert.equal(res.info?.bitsPerSample, 16);
	assert.ok(Math.abs((res.info?.seconds ?? 0) - 2.5) < 0.01);
});

test("WAV 校验：采样率 / 声道 / 位深不符一律拒绝（不做重采样，也不引入 ffmpeg）", () => {
	assert.equal(checkWav(makeWav({ seconds: 1, rate: 44100 }), limits).ok, false);
	assert.match(checkWav(makeWav({ seconds: 1, rate: 44100 }), limits).problems.join(""), /采样率/);
	assert.equal(checkWav(makeWav({ seconds: 1, channels: 2 }), limits).ok, false);
	assert.match(checkWav(makeWav({ seconds: 1, channels: 2 }), limits).problems.join(""), /声道/);
	assert.equal(checkWav(makeWav({ seconds: 1, bits: 8 }), limits).ok, false);
	assert.match(checkWav(makeWav({ seconds: 1, bits: 8 }), limits).problems.join(""), /16-bit/);
});

test("WAV 校验：截断 / 非 RIFF / 超时长 / 超字节数都被拒（长帧有界）", () => {
	const ok = makeWav({ seconds: 1 });
	const truncated = ok.slice(0, ok.length - 10);
	const bad = checkWav(truncated, limits);
	assert.equal(bad.ok, false);
	assert.ok(bad.problems.length > 0);

	assert.equal(checkWav(new Uint8Array([1, 2, 3]), limits).ok, false);
	assert.match(checkWav(new Uint8Array(60), limits).problems.join(""), /RIFF/);

	// 超时长：用极小上限逼出拒绝（不构造大 buffer）
	const longRes = checkWav(makeWav({ seconds: 3 }), { ...limits, maxSeconds: 1 });
	assert.equal(longRes.ok, false);
	assert.match(longRes.problems.join(""), /过长/);

	const bigRes = checkWav(makeWav({ seconds: 1 }), { ...limits, maxBytes: 100 });
	assert.equal(bigRes.ok, false);
	assert.match(bigRes.problems.join(""), /过大/);
});

test("权重校验：假文件摘要正确 → ok；bitflip / 缺文件 / 符号链接越界 → 失败", async () => {
	const dir = mkdtempSync(join(tmpdir(), "asr-w-"));
	try {
		const onnx = Buffer.from("fake-onnx-graph");
		const tokens = Buffer.from("fake tokens\n");
		writeFileSync(join(dir, "model.int8.onnx"), onnx);
		writeFileSync(join(dir, "tokens.txt"), tokens);
		const files = [
			{ path: "model.int8.onnx", size: onnx.length, sha256: createHash("sha256").update(onnx).digest("hex") },
			{ path: "tokens.txt", size: tokens.length, sha256: createHash("sha256").update(tokens).digest("hex") },
		];
		const ok = await verifyAsrWeights(dir, files);
		assert.equal(ok.ok, true, ok.problems.join("；"));
		assert.equal(ok.checked, 2);

		writeFileSync(join(dir, "tokens.txt"), Buffer.from("fake tokenz\n"));
		const flip = await verifyAsrWeights(dir, files);
		assert.equal(flip.ok, false);
		assert.match(flip.problems.join(""), /SHA256 不符|大小不符/);

		// 缺文件
		rmSync(join(dir, "model.int8.onnx"));
		assert.equal((await verifyAsrWeights(dir, files)).ok, false);

		// 符号链接指向目录外
		const outside = mkdtempSync(join(tmpdir(), "asr-o-"));
		try {
			writeFileSync(join(outside, "real"), "x");
			symlinkSync(join(outside, "real"), join(dir, "model.int8.onnx"));
			const sym = await verifyAsrWeights(dir, [{ path: "model.int8.onnx", size: 1, sha256: createHash("sha256").update("x").digest("hex") }]);
			assert.equal(sym.ok, false);
			assert.match(sym.problems.join(""), /符号链接越界|大小不符/);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("导入路径校验：必须是绝对真实目录，拒绝相对路径 / 符号链接 / 自己的目录 / 敏感目录", () => {
	const home = mkdtempSync(join(tmpdir(), "asr-home-"));
	const selfRoot = join(home, "Library", "local-asr");
	const good = mkdtempSync(join(tmpdir(), "asr-src-"));
	try {
		mkdirSync(selfRoot, { recursive: true });
		mkdirSync(join(selfRoot, "weights"), { recursive: true });
		assert.equal(assertSafeImportDir(good, { home, selfRoot }), good);

		assert.throws(() => assertSafeImportDir("relative/dir", { home, selfRoot }), /绝对路径/);
		assert.throws(() => assertSafeImportDir(join(good, "nope"), { home, selfRoot }), /不存在/);
		assert.throws(() => assertSafeImportDir(selfRoot, { home, selfRoot }), /自己的目录/);
		assert.throws(() => assertSafeImportDir(join(selfRoot, "weights"), { home, selfRoot }), /自己的目录/);

		mkdirSync(join(home, ".ssh"), { recursive: true });
		assert.throws(() => assertSafeImportDir(join(home, ".ssh"), { home, selfRoot }), /敏感位置/);

		const link = join(good, "link");
		symlinkSync(good, link);
		assert.throws(() => assertSafeImportDir(link, { home, selfRoot }), /符号链接/);
	} finally {
		rmSync(good, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
});

test("导入复制：只复制清单内文件，缺文件 / 大小不符 / 符号链接文件都拒绝（不读其它文件）", async () => {
	const src = mkdtempSync(join(tmpdir(), "asr-cp-"));
	const dest = mkdtempSync(join(tmpdir(), "asr-dst-"));
	try {
		writeFileSync(join(src, "model.int8.onnx"), "graph");
		writeFileSync(join(src, "tokens.txt"), "tok");
		writeFileSync(join(src, "SECRET.txt"), "should-not-be-read");
		const files = [
			{ path: "model.int8.onnx", size: 5, sha256: await sha256File(join(src, "model.int8.onnx")) },
			{ path: "tokens.txt", size: 3, sha256: await sha256File(join(src, "tokens.txt")) },
		];
		const res = copyManifestFiles(src, dest, files);
		assert.equal(res.copied, 2);
		assert.equal(res.bytes, 8);
		assert.equal((await verifyAsrWeights(dest, files)).ok, true);

		// 清单外文件不会被复制
		assert.throws(() => copyManifestFiles(src, join(dest, "x"), [{ path: "SECRET.txt", size: 20, sha256: "a".repeat(64) }]), /大小不符/);

		assert.throws(() => copyManifestFiles(src, join(dest, "y"), [{ path: "missing.onnx", size: 1, sha256: "a".repeat(64) }]), /缺少文件/);

		symlinkSync(join(src, "model.int8.onnx"), join(src, "link.onnx"));
		assert.throws(() => copyManifestFiles(src, join(dest, "z"), [{ path: "link.onnx", size: 5, sha256: "a".repeat(64) }]), /符号链接/);

		assert.throws(() => copyManifestFiles(src, join(dest, "w"), [{ path: "../escape.onnx", size: 5, sha256: "a".repeat(64) }]), /不安全/);
	} finally {
		rmSync(src, { recursive: true, force: true });
		rmSync(dest, { recursive: true, force: true });
	}
});
