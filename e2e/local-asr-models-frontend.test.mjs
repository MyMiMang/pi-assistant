/**
 * 本地语音多模型前端「纯逻辑」夹具测试（node:test，不启动服务、不碰 DOM / 真实数据）。
 * 运行：node --import tsx --test e2e/local-asr-models-frontend.test.mjs
 *
 * 覆盖：catalog 归一（对齐 backendowner 的 LocalAsrCatalog DTO）、安装进度 indeterminate、
 * 显式「使用」的 intent/stale 守卫、展示格式化、统一下载进度合并。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { beginAsrIntent, emptyAsrIntent, invalidateAsrIntent, isCurrentAsrIntent, mergeLiveDownload, formatBytes, tierLabel, isIndeterminate, installPercent, memoryAdvice } = await import("../apps/web/src/local-asr-intent.ts");
const { normalizeLocalAsrCatalog, normalizeLocalAsrModel, emptyLocalAsrCatalog } = await import("../apps/web/src/local-asr-api.ts");

/** 与 packages/server/src/local-asr/service.ts 的 LocalAsrCatalog 同形的 fixture。 */
const rawCatalog = {
	hardware: { os: "darwin", arch: "arm64", cpuCores: 10, memoryBytes: 16 * 1024 ** 3, tier: "balanced", tierNote: "系统内存约 16.0GB，按 16GB 档保守估计（估算，未实测；未跑 benchmark）" },
	runtime: { engine: "sherpa-onnx", version: "1.13.8", python: "3.11", depsBytes: null, depsNote: "共享运行环境（引擎 + venv/cache）估算约 0.2GB；未在本机实测" },
	recommendedId: "whisper-small-int8",
	notes: ["内存 / 档位均为估算，未在本机跑 benchmark", "一次只运行一个本地语音模型"],
	models: [
		{
			id: "paraformer-zh-2023-09-14-int8",
			provider: "local-paraformer",
			family: "paraformer",
			variant: "int8 · 2023-09-14",
			name: "Paraformer 中文（本地）",
			nameEn: "Paraformer zh (sherpa-onnx)",
			languages: ["zh", "en"],
			note: "中文主力，输出无标点（另配标点模型才有）",
			tier: "light",
			tags: ["light"],
			recommended: false,
			recommendationReason: "",
			available: true,
			unavailableReason: null,
			weightsBytes: 243_446_974,
			depsBytes: null,
			depsNote: "另需下载共享运行环境（sherpa-onnx 引擎 + venv/cache，估算约 0.2GB）；未在本机实测",
			suggestedMemoryBytes: 900 * 1024 * 1024,
			memoryNote: "模型进程内存估算（非实测）；整机内存建议见硬件档位",
			capabilities: ["中文", "中英混说", "无标点"],
			multilingual: false,
			license: { licenseName: "Apache License 2.0", termsVersion: "Apache-2.0", decision: "cleared", redistribution: true, attribution: "Paraformer by FunASR", links: { modelCard: "https://x/card", modelLicense: "https://x/lic", engineLicense: "https://x/engine" }, restrictions: ["署名并保留版权与许可声明（Apache-2.0 §4）"], reason: "上游为 Apache-2.0", acceptValue: "Apache-2.0" },
			source: { source: { project: "Paraformer zh · sherpa-onnx 转换", repoUrl: "https://github.com/modelscope/FunASR", weightsRepo: "csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14", weightsRevision: "def027084691107096b5ebba69785756d63de6c5", weightsLicense: "Apache-2.0", engineLicense: "Apache-2.0", engineVersion: "1.13.8", note: "" }, model: { id: "paraformer-zh-2023-09-14-int8", repo: "csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14", revision: "def027084691107096b5ebba69785756d63de6c5", files: [{ path: "model.int8.onnx", size: 243_371_218, sha256: "f".repeat(64) }, { path: "tokens.txt", size: 75_756, sha256: "a".repeat(64) }] } },
			installed: false,
			selected: false,
			running: false,
			install: { state: "not_installed", phase: null, phaseLabel: null, received: 0, total: null, percent: null, error: null, installedAt: null, source: null, jobId: null, attempt: null },
			runtime: { state: "stopped", pid: null, port: null, host: "127.0.0.1", restarts: 0, lastError: null, healthOk: false, loaded: false },
		},
		{
			id: "whisper-small-int8",
			provider: "local-whisper",
			family: "whisper",
			name: "Whisper Small（本地）",
			tier: "balanced",
			tags: ["balanced"],
			recommended: true,
			recommendationReason: "推荐理由：多语均衡档",
			available: true,
			weightsBytes: 375_485_327,
			suggestedMemoryBytes: 1500 * 1024 * 1024,
			memoryNote: "模型进程内存估算（非实测）",
			capabilities: ["多语", "原生输出（含标点 / 大小写）"],
			multilingual: true,
			license: { licenseName: "MIT License (OpenAI Whisper)", termsVersion: "MIT", decision: "cleared", acceptValue: "MIT" },
			install: { state: "installing", phase: "weights", phaseLabel: "下载 / 导入权重", received: 1000, total: 2000, error: null },
		},
	],
};

test("catalog 归一：对齐 backend DTO（tier / capabilities / 嵌套 source / runtime 环境 / selected）", () => {
	const c = normalizeLocalAsrCatalog(rawCatalog);
	assert.equal(c.ok, true);
	assert.equal(c.hardware.tier, "balanced");
	assert.equal(c.runtime.engine, "sherpa-onnx");
	assert.equal(c.runtime.version, "1.13.8");
	assert.equal(c.recommendedId, "whisper-small-int8");
	assert.equal(c.models.length, 2);
	const p = c.models[0];
	assert.equal(p.provider, "local-paraformer");
	assert.equal(p.tier, "light");
	assert.deepEqual(p.tags, ["light"]);
	assert.deepEqual(p.capabilities, ["中文", "中英混说", "无标点"], "能力标签是 catalog 的真实模型事实，原样透传");
	assert.equal(p.license.licenseName, "Apache License 2.0");
	assert.equal(p.license.acceptValue, "Apache-2.0");
	assert.equal(p.license.agreementRequired, false, "MIT/Apache 等 cleared 许可无需显式同意（不弹 checkbox / 不偷传 acceptLicense）");
	assert.equal(normalizeLocalAsrModel({ id: "sv", license: { decision: "unresolved", agreementRequired: true, acceptValue: "1.1" } }).license.agreementRequired, true);
	assert.equal(normalizeLocalAsrModel({ id: "old", license: { decision: "cleared" } }).license.agreementRequired, false, "旧 DTO 缺字段时按 decision 兜底");
	// 嵌套 source 展平：revision 取 model.revision，files 保留
	assert.equal(p.source.weightsRepo, "csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14");
	assert.equal(p.source.revision, "def027084691107096b5ebba69785756d63de6c5");
	assert.equal(p.source.files.length, 2);
	assert.equal(p.downloadId, "asr:paraformer-zh-2023-09-14-int8", "downloadId 默认 = stable 组件 id");
	assert.equal(p.selected, false);
	// 缺 tags 时用 tier 兜底
	const w = normalizeLocalAsrModel({ id: "x", tier: "high" });
	assert.deepEqual(w.tags, ["high"]);
	assert.equal(w.tier, "high");
});

test("catalog 结构不对 → ok=false，不崩、不假装有模型", () => {
	assert.equal(normalizeLocalAsrCatalog({}).ok, false);
	assert.equal(normalizeLocalAsrCatalog({}).models.length, 0);
	assert.equal(emptyLocalAsrCatalog().ok, false);
	assert.equal(normalizeLocalAsrModel(null), null);
	assert.equal(normalizeLocalAsrModel({ name: "没 id" }), null, "没有稳定 id 的项不进入可选清单");
});

test("安装进度：total 未知 → indeterminate；有 total 才现算百分比", () => {
	assert.equal(isIndeterminate(null), true);
	assert.equal(isIndeterminate(0), true);
	assert.equal(isIndeterminate(1000), false);
	assert.equal(installPercent(0, null), null, "总量未知不画假百分比");
	assert.equal(installPercent(500, 1000), 50);
	assert.equal(installPercent(2000, 1000), 100, "夹到 100，不超");
	const m = normalizeLocalAsrModel({ id: "x", install: { state: "installing", received: 100, total: 400 } });
	assert.equal(m.install.percent, 25, "后端没给 percent 时用 received/total 现算");
	assert.equal(normalizeLocalAsrModel({ id: "y", install: { state: "installing", received: 100, total: null } }).install.percent, null);
});

test("下载注册表进度合并：downloading → installing；error → failed", () => {
	const base = { state: "not_installed", received: 0, total: null, percent: null, phase: null, phaseLabel: null, error: null };
	const merged = mergeLiveDownload(base, { state: "downloading", received: 10, total: 20, percent: 50, error: null });
	assert.equal(merged.state, "installing");
	assert.equal(merged.percent, 50);
	assert.equal(merged.phase, "weights");
	assert.equal(mergeLiveDownload(base, { state: "error", received: 0, total: null, percent: null, error: "网络断了" }).state, "failed");
	assert.equal(mergeLiveDownload(base, undefined), base);
});

test("intent：显式「使用」的 seq 守卫作废在途 PUT", () => {
	let s = emptyAsrIntent();
	const a = beginAsrIntent(s);
	s = a.state;
	assert.equal(a.token, 1);
	assert.equal(isCurrentAsrIntent(s, 1), true);
	const s2 = invalidateAsrIntent(s);
	assert.equal(isCurrentAsrIntent(s2, 1), false, "先前的 PUT 完成回调不能 late 覆盖新选择");
	const b = beginAsrIntent(s2);
	assert.equal(b.token, 3);
	assert.equal(isCurrentAsrIntent(b.state, b.token), true);
});

test("展示格式化：GB 体积 / 档位标签 / 内存建议标未实测", () => {
	assert.equal(formatBytes(243_446_974), "243 MB");
	assert.equal(formatBytes(1_775_753_918), "1.78 GB");
	assert.equal(formatBytes(1_036_613_791), "1.04 GB");
	assert.equal(formatBytes(null), "未知");
	assert.equal(tierLabel("light"), "轻量");
	assert.equal(tierLabel("high"), "高质量");
	assert.match(memoryAdvice(2_000_000_000, "模型进程内存估算（非实测）"), /估算，未实测/);
});
