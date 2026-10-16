/**
 * 「默认本地语音」准备状态归一化的**纯逻辑单测**（不碰网络 / 不读真实设置）。
 *
 * 覆盖用户点名（fresh auto-prep ready / fail / cancel retry、existing prefs 不被改）：
 *  - 认不出 / 缺字段 → `ok:false`、`state:"unknown"`（UI 什么都不显示，不猜已就绪）；
 *  - 状态别名收敛；进度从 received/total 或 percent 算；统一下载进度可合并；
 *  - **首次联网明示**：`firstUseOnline` 未知时**绝不说可离线**；
 *  - 取消 / 重试的可用条件；opt-out 只读展示（不代用户改）。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canCancelPrepare,
	canRetryPrepare,
	emptyVoicePrepareView,
	firstUseNote,
	mergePrepareDownload,
	normalizeVoicePrepareView,
	voicePrepareLabel,
	voicePrepareTone,
} from "../../../apps/web/src/voice-pref.ts";

test("normalizeVoicePrepareView：结构不认识 → ok:false / unknown（不瞎猜）", () => {
	for (const raw of [null, undefined, 42, "ready", {}, { foo: 1 }]) {
		const v = normalizeVoicePrepareView(raw);
		assert.equal(v.ok, false);
		assert.equal(v.state, "unknown");
		assert.equal(voicePrepareLabel(v), "");
	}
	assert.equal(emptyVoicePrepareView().ok, false);
});

test("normalizeVoicePrepareView：状态别名收敛", () => {
	assert.equal(normalizeVoicePrepareView({ state: "preparing" }).state, "preparing");
	assert.equal(normalizeVoicePrepareView({ status: "downloading" }).state, "preparing");
	assert.equal(normalizeVoicePrepareView({ state: "installed" }).state, "ready");
	assert.equal(normalizeVoicePrepareView({ state: "error" }).state, "failed");
	assert.equal(normalizeVoicePrepareView({ state: "canceled" }).state, "cancelled");
	assert.equal(normalizeVoicePrepareView({ state: "not_installed" }).state, "not_ready");
	// 也接受包一层 default（契约未定，两种形态都兼容）
	assert.equal(normalizeVoicePrepareView({ default: { state: "ready" } }).state, "ready");
});

test("normalizeVoicePrepareView：进度 / 默认模型 / downloadId 归一化", () => {
	const v = normalizeVoicePrepareView({ state: "preparing", defaultModelId: "streaming-zipformer-bilingual-zh-en-int8", receivedBytes: 51_000_000, totalBytes: 198_270_793, firstUseOnline: true, estimatedBytes: 285_000_000 });
	assert.equal(v.ok, true);
	assert.equal(v.downloadId, "asr:streaming-zipformer-bilingual-zh-en-int8");
	assert.equal(v.percent, 26);
	assert.equal(v.firstUseOnline, true);
	assert.match(voicePrepareLabel(v), /正在准备/);
	assert.match(voicePrepareLabel(v), /26%/);
	assert.equal(voicePrepareTone(v), "amber");
});

test("mergePrepareDownload：并入统一下载注册表实时进度", () => {
	const base = normalizeVoicePrepareView({ state: "not_ready", downloadId: "asr:x" });
	const live = { state: "downloading" as const, received: 40, total: 200, percent: 20, error: null };
	const merged = mergePrepareDownload(base, live);
	assert.equal(merged.state, "preparing");
	assert.equal(merged.percent, 20);
	const failed = mergePrepareDownload(base, { state: "error", received: 0, total: null, percent: null, error: "断了" });
	assert.equal(failed.state, "failed");
	assert.equal(failed.error, "断了");
});

test("取消 / 重试的可用条件", () => {
	assert.equal(canCancelPrepare(normalizeVoicePrepareView({ state: "preparing" })), true);
	assert.equal(canCancelPrepare(normalizeVoicePrepareView({ state: "ready" })), false);
	assert.equal(canRetryPrepare(normalizeVoicePrepareView({ state: "failed" })), true);
	assert.equal(canRetryPrepare(normalizeVoicePrepareView({ state: "cancelled" })), true);
	assert.equal(canRetryPrepare(normalizeVoicePrepareView({ state: "preparing" })), false);
});

test("首次联网说明：未知时绝不说可离线", () => {
	const unknown = normalizeVoicePrepareView({ state: "ready" });
	assert.equal(unknown.firstUseOnline, null);
	assert.equal(firstUseNote(unknown), "", "未说明就什么都不写，不声称离线可用");
	const online = normalizeVoicePrepareView({ state: "preparing", firstUseOnline: true, estimatedBytes: 290_000_000 });
	assert.match(firstUseNote(online), /首次使用需联网/);
	const bundled = normalizeVoicePrepareView({ state: "ready", firstUseOnline: false });
	assert.match(firstUseNote(bundled), /离线/);
});

test("opt-out 与 source 只读展示（不代用户改）", () => {
	const v = normalizeVoicePrepareView({ state: "not_ready", optedOut: true, source: { location: "cloud", provider: "openai", model: "whisper-1" } });
	assert.equal(v.optedOut, true);
	assert.deepEqual(v.source, { location: "cloud", provider: "openai", model: "whisper-1" });
	// 结构不对的 source 不假装
	assert.equal(normalizeVoicePrepareView({ state: "ready", source: { location: "x" } }).source, null);
});
