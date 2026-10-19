/**
 * 默认本地语音**准备状态归一化**单测（纯函数；不碰网络 / 真实下载 / 真实数据）。
 *
 * 形状以冻结契约为准（`docs/design/default-stream-contract.md` §1.1）：
 * `defaultVoice: DefaultVoicePrepView`。**认不出就是 ok:false**，绝不默认「已就绪」；
 * 首次联网未知（null）时绝不说可离线。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { canCancelPrepare, canInstallPrepare, emptyVoicePrepareView, firstUseNote, mergePrepareDownload, normalizeVoicePrepareView, preparePercent, voicePrepareLabel, voicePrepareTone } from "../../../apps/web/src/voice-pref.ts";

/** 契约 §1.1 的完整形状（与后端 `defaultVoicePrepView()` 一致）。 */
const contractView = (over: Record<string, unknown> = {}) => ({
	defaultModelId: "streaming-zipformer-bilingual-zh-en-int8",
	kind: "unconfigured",
	label: "还没选语音识别来源；默认提供本地流式听写",
	prep: {
		state: "preparing",
		jobId: "asr:streaming-zipformer-bilingual-zh-en-int8",
		phase: "weights",
		phaseLabel: "下载权重",
		received: 1_000,
		total: 4_000,
		percent: 25,
		attempt: 1,
		startedAt: "2026-10-17T00:00:00.000Z",
		finishedAt: null,
		error: null,
		errorCode: null,
		retryable: false,
		...((over.prep as Record<string, unknown>) ?? {}),
	},
	firstRunNeedsNetwork: true,
	approxBytes: 300_000_000,
	offlineAfterReady: true,
	requiresUserAction: true,
	micPermissionRequested: false,
	notes: ["首次需联网"],
	...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "prep")),
});

test("normalizeVoicePrepareView：认不出（缺 prep / 非法 state）→ ok:false / unknown，不瞎猜", () => {
	assert.equal(normalizeVoicePrepareView(null).ok, false);
	assert.equal(normalizeVoicePrepareView({ kind: "default" }).ok, false);
	assert.equal(normalizeVoicePrepareView({ prep: { state: "ready-ish" } }).ok, false);
	assert.equal(normalizeVoicePrepareView({ prep: {} }).state, "unknown");
	assert.deepEqual(normalizeVoicePrepareView(undefined), emptyVoicePrepareView());
});

test("normalizeVoicePrepareView：精确解析契约字段（含包着 defaultVoice 的整份 source 视图）", () => {
	const v = normalizeVoicePrepareView(contractView());
	assert.equal(v.ok, true);
	assert.equal(v.state, "preparing");
	assert.equal(v.kind, "unconfigured");
	assert.equal(v.defaultModelId, "streaming-zipformer-bilingual-zh-en-int8");
	assert.equal(v.jobId, "asr:streaming-zipformer-bilingual-zh-en-int8");
	assert.equal(v.phase, "weights");
	assert.equal(v.phaseLabel, "下载权重");
	assert.equal(v.percent, 25);
	assert.equal(v.retryable, false);
	assert.equal(v.firstRunNeedsNetwork, true);
	assert.equal(v.approxBytes, 300_000_000);
	assert.equal(v.offlineAfterReady, true);
	assert.deepEqual(v.notes, ["首次需联网"]);
	// 整份 `GET /api/audio/asr/source` 返回也接受
	const wrapped = normalizeVoicePrepareView({ source: null, options: [], version: 3, defaultVoice: contractView() });
	assert.equal(wrapped.ok, true);
	assert.equal(wrapped.percent, 25);
});

test("normalizeVoicePrepareView：六个契约状态都认；kind 非枚举时给 null", () => {
	for (const state of ["not_applicable", "not_prepared", "preparing", "ready", "failed", "cancelled"] as const) {
		const v = normalizeVoicePrepareView(contractView({ prep: { state } }));
		assert.equal(v.ok, true, `${state} 应被认识`);
		assert.equal(v.state, state);
	}
	assert.equal(normalizeVoicePrepareView(contractView({ kind: "weird" })).kind, null);
	assert.equal(normalizeVoicePrepareView(contractView({ defaultModelId: null })).defaultModelId, null);
});

test("normalizeVoicePrepareView：jobId 缺失时回落到 `asr:<modelId>`（与统一下载同一 job）", () => {
	const v = normalizeVoicePrepareView(contractView({ prep: { jobId: null } }));
	assert.equal(v.jobId, "asr:streaming-zipformer-bilingual-zh-en-int8");
});

test("normalizeVoicePrepareView：模块对应模型（modelId / modelName）跟所选走；旧后端没给 → 回落默认，jobId 跟它", () => {
	const v = normalizeVoicePrepareView(contractView({ modelId: "whisper-small-int8", modelName: "Whisper Small（本地）", prep: { jobId: null } }));
	assert.equal(v.modelId, "whisper-small-int8");
	assert.equal(v.modelName, "Whisper Small（本地）");
	assert.equal(v.jobId, "asr:whisper-small-int8");
	const old = normalizeVoicePrepareView(contractView({}));
	assert.equal(old.modelId, "streaming-zipformer-bilingual-zh-en-int8");
	assert.equal(old.modelName, null);
});

test("mergePrepareDownload：并入统一下载注册表实时进度（同一个 job）", () => {
	const base = normalizeVoicePrepareView(contractView({ prep: { total: null, percent: null, received: null } }));
	const live = mergePrepareDownload(base, { state: "downloading", received: 500, total: 2000, percent: null, error: null });
	assert.equal(live.state, "preparing");
	assert.equal(live.percent, 25);
	const err = mergePrepareDownload(base, { state: "error", received: 0, total: null, percent: null, error: "断网" });
	assert.equal(err.state, "failed");
	assert.equal(err.error, "断网");
	const unchanged = mergePrepareDownload(base, undefined);
	assert.deepEqual(unchanged, base);
});

test("安装 / 取消 / 重试 / 百分比的可用条件（可选模块：未安装可点安装）", () => {
	const preparing = normalizeVoicePrepareView(contractView());
	assert.equal(canCancelPrepare(preparing), true);
	assert.equal(canInstallPrepare(preparing), false);
	assert.equal(preparePercent(preparing), 25);
	const failed = normalizeVoicePrepareView(contractView({ prep: { state: "failed", error: "下载失败", retryable: true, percent: null, total: null } }));
	assert.equal(canCancelPrepare(failed), false);
	assert.equal(canInstallPrepare(failed), true);
	assert.equal(preparePercent(failed), null);
	const ready = normalizeVoicePrepareView(contractView({ prep: { state: "ready" } }));
	assert.equal(canCancelPrepare(ready), false);
	assert.equal(canInstallPrepare(ready), false);
	const notInstalled = normalizeVoicePrepareView(contractView({ prep: { state: "not_prepared", percent: null } }));
	assert.equal(canInstallPrepare(notInstalled), true, "未安装：给「安装本地语音」");
	assert.equal(canCancelPrepare(notInstalled), false);
	// 没有 jobId 时不给操作入口
	assert.equal(canInstallPrepare(normalizeVoicePrepareView(contractView({ defaultModelId: null, prep: { jobId: null, state: "failed" } }))), false);
});

test("标签 / 色调：按状态给人话，简单直接", () => {
	assert.match(voicePrepareLabel(normalizeVoicePrepareView(contractView())), /正在安装本地语音/);
	assert.equal(voicePrepareLabel(normalizeVoicePrepareView(contractView({ prep: { state: "ready" } }))), "本地语音已安装");
	assert.equal(voicePrepareLabel(normalizeVoicePrepareView(contractView({ prep: { state: "failed" } }))), "本地语音安装失败");
	assert.equal(voicePrepareLabel(normalizeVoicePrepareView(contractView({ prep: { state: "not_prepared" } }))), "本地语音未安装");
	assert.equal(voicePrepareTone(normalizeVoicePrepareView(contractView())), "amber");
	assert.equal(voicePrepareTone(normalizeVoicePrepareView(contractView({ prep: { state: "ready" } }))), "green");
	assert.equal(voicePrepareTone(normalizeVoicePrepareView(contractView({ prep: { state: "failed" } }))), "red");
});

test("首次联网说明：未知时绝不说可离线（绝不写“首次断网可用”）", () => {
	assert.match(firstUseNote(normalizeVoicePrepareView(contractView())), /默认不安装；安装需联网下载约 \d+ MB/);
	assert.equal(firstUseNote(normalizeVoicePrepareView(contractView({ firstRunNeedsNetwork: false }))), "已随应用内置，可离线使用。");
	assert.equal(firstUseNote(normalizeVoicePrepareView(contractView({ firstRunNeedsNetwork: null }))), "");
	assert.equal(firstUseNote(emptyVoicePrepareView()), "");
});
