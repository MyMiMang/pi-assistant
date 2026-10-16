/**
 * 许可门槛 + 平台矩阵 + 清单 pin 一致性。
 *
 * 边界：不下载任何权重、不联网、不读用户文件、不碰钥匙串；只用纯函数与常量。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bundleAllowed, importGate, installGate, licenseDisclosure } from "../src/local-asr/license.ts";
import { SENSEVOICE_LICENSE, SENSEVOICE_MODEL, SENSEVOICE_SOURCE, SHERPA_ONNX_VERSION } from "../src/local-asr/manifest.ts";
import { capThreads, senseVoicePlatform, threadsArg } from "../src/local-asr/platform.ts";
import { assertSafeAsrManifest } from "../src/local-asr/weights.ts";
import { buildRegistry, modelsWithCapability } from "../src/model-registry.ts";

const cleared = { ...SENSEVOICE_LICENSE, decision: "cleared" as const, redistribution: true };
const prohibited = { ...SENSEVOICE_LICENSE, decision: "prohibited" as const };

test("许可复核结论是 unresolved：不 bundle、不镜像；安装入口默认关闭，并给出可读原因", () => {
	assert.equal(SENSEVOICE_LICENSE.decision, "unresolved");
	assert.equal(SENSEVOICE_LICENSE.redistribution, false);
	assert.equal(bundleAllowed(SENSEVOICE_LICENSE), false, "unresolved 下绝不允许随 App 分发权重");
	assert.equal(bundleAllowed(cleared), true);
	assert.equal(bundleAllowed(prohibited), false);

	const g = installGate(SENSEVOICE_LICENSE, "1.1");
	assert.equal(g.allowed, false);
	assert.match(String(g.reason), /未最终确认/);
	assert.match(String(g.reason), /issue\/334|issues\/334/, "原因里必须带 issue 链接，便于用户自查");
	// 即使显式传了正确版本，unresolved 默认也不放行
	assert.equal(installGate(SENSEVOICE_LICENSE, "1.1", { allowUnresolved: true }).allowed, true, "显式 override 才放行（产品默认不传）");
});

test("cleared 许可：install 仍要求 acceptLicense 与当前版本完全一致（不能跳过阅读）", () => {
	assert.equal(installGate(cleared, null).allowed, false);
	assert.match(String(installGate(cleared, null).reason), /必须接受/);
	assert.equal(installGate(cleared, "1.0").allowed, false);
	assert.match(String(installGate(cleared, "1.0").reason), /版本不匹配/);
	assert.equal(installGate(cleared, "1.1").allowed, true);
	// SenseVoice 确实需要显式确认（授权 override 路径）
	assert.equal(licenseDisclosure(SENSEVOICE_LICENSE).agreementRequired, true);
});

test("宽松许可（MIT / Apache-2.0）：cleared 不强制 acceptLicense，一键装；只需展示署名与链接", () => {
	const mit = { ...SENSEVOICE_LICENSE, decision: "cleared" as const, redistribution: true, licenseName: "MIT License (OpenAI Whisper)", termsVersion: "MIT", requiresExplicitAgreement: false };
	assert.equal(installGate(mit, null).allowed, true, "MIT 不应因缺少 acceptLicense 被拦");
	assert.equal(installGate(mit, "MIT").allowed, true);
	const d = licenseDisclosure(mit);
	assert.equal(d.agreementRequired, false, "宽松许可不需要用户勾同意");
	assert.equal(d.attribution.length > 0, true, "仍必须展示署名");
	assert.ok(d.links.modelLicense.startsWith("http"), "仍必须展示许可证链接");
	// cleared 但需要确认的仍拦
	assert.equal(installGate(cleared, null).allowed, false);
});

test("prohibited 许可：install 与 import 都关闭", () => {
	assert.equal(installGate(prohibited, "1.1").allowed, false);
	assert.equal(importGate(prohibited).allowed, false);
	// unresolved 下用户自行导入仍开放（自己合法取得的权重）
	assert.equal(importGate(SENSEVOICE_LICENSE).allowed, true);
});

test("条款披露：限制摘要与链接默认可见，acceptValue 就是条款版本", () => {
	const d = licenseDisclosure(SENSEVOICE_LICENSE);
	assert.equal(d.acceptValue, "1.1");
	assert.ok(d.restrictions.length >= 4, "限制摘要必须有多条，不能一句话遮盖");
	assert.match(d.restrictions.join("\n"), /署名/);
	assert.match(d.restrictions.join("\n"), /reference and learning purposes only/);
	assert.match(d.restrictions.join("\n"), /单方改版/);
	assert.ok(d.links.modelLicense.includes("MODEL_LICENSE"));
	assert.ok((d.links.issue ?? "").includes("334"));
	assert.equal(d.attribution, "SenseVoiceSmall by FunASR / FunAudioLLM", "§2.2 署名是硬要求");
});

test("平台矩阵按官方轮子给出支持级别；不虚构 GPU 加速", () => {
	const cases: [string, string, string][] = [
		["darwin", "arm64", "supported"],
		["darwin", "x64", "supported"],
		["win32", "x64", "supported"],
		["win32", "arm64", "conditional"],
		["linux", "x64", "supported"],
		["linux", "arm64", "supported"],
		["linux", "arm", "unsupported"],
		["freebsd", "x64", "unsupported"],
	];
	for (const [os, arch, support] of cases) {
		const p = senseVoicePlatform(os, arch);
		assert.equal(p.support, support, `${os}-${arch}`);
		assert.equal(p.accelerator, "cpu", "一律 CPU：上游未证 SenseVoice 的 CoreML/Metal");
		assert.equal(p.key, `${os}-${arch}`);
	}
	assert.equal(senseVoicePlatform("darwin", "arm64").wheelTag, "macosx_11_0_arm64");
	assert.equal(senseVoicePlatform("darwin", "x64").wheelTag, "macosx_10_15_x86_64");
});

test("线程上限按物理核封顶，拿不到物理核时保守回退（不霸全 CPU）", () => {
	assert.equal(capThreads(8), 8);
	assert.equal(capThreads(16), 8, "默认上限 8，避免吃掉全部核心");
	assert.equal(capThreads(2), 2);
	assert.equal(capThreads(null, { logicalCores: 16 }), 8, "无物理核信息 → 逻辑核/2");
	assert.equal(capThreads(null, { logicalCores: 3 }), 1);
	assert.equal(capThreads(null, {}), 4, "什么都拿不到时按 4");
	assert.equal(capThreads(0, { logicalCores: 0 }), 4);
	assert.equal(capThreads(-3), 4);
	assert.deepEqual(threadsArg(6), ["--num-threads", "6"]);
	assert.deepEqual(threadsArg(0), ["--num-threads", "1"]);
});

test("清单 pin 一致性：revision 是 40 位 SHA、文件摘要 64 位、ONNX 用 HF LFS oid、无脚本", () => {
	assert.match(SENSEVOICE_MODEL.revision, /^[a-f0-9]{40}$/);
	assert.match(SHERPA_ONNX_VERSION, /^\d+\.\d+\.\d+$/);
	assert.equal(SENSEVOICE_SOURCE.weightsRevision, SENSEVOICE_MODEL.revision);
	assert.equal(SENSEVOICE_SOURCE.engineVersion, SHERPA_ONNX_VERSION);
	assert.equal(SENSEVOICE_MODEL.sampleRate, 16000);
	assert.equal(SENSEVOICE_MODEL.channels, 1);
	assert.equal(assertSafeAsrManifest(SENSEVOICE_MODEL.files).length, 0, "自己的清单必须自检通过");

	const onnx = SENSEVOICE_MODEL.files.find((f) => f.path.endsWith(".onnx"));
	assert.ok(onnx, "必须有 onnx 权重");
	assert.equal(onnx.size, 239_233_841);
	assert.equal(onnx.sha256, "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51", "ONNX 摘要 = HF LFS oid");
	assert.equal(SENSEVOICE_MODEL.bytes, SENSEVOICE_MODEL.files.reduce((n, f) => n + f.size, 0));
	// 权重许可**不是** Apache（防止被代码 / 引擎许可误导）
	assert.match(SENSEVOICE_LICENSE.licenseName, /FunASR Model Open Source License/);
	assert.equal(SENSEVOICE_SOURCE.weightsLicense, "FunASR Model Open Source License Agreement v1.1");
	assert.equal(SENSEVOICE_SOURCE.engineLicense, "Apache-2.0");
	assert.equal(SENSEVOICE_SOURCE.repoCodeLicense, "MIT");
});

test("清单自检：拒绝脚本 / 缺 onnx / 缺 tokens / 越界路径 / 非法摘要", () => {
	const bad = [
		[{ path: "run.py", size: 1, sha256: "a".repeat(64) }, { path: "model.int8.onnx", size: 1, sha256: "a".repeat(64) }, { path: "tokens.txt", size: 1, sha256: "a".repeat(64) }],
		[{ path: "tokens.txt", size: 1, sha256: "a".repeat(64) }],
		[{ path: "model.int8.onnx", size: 1, sha256: "a".repeat(64) }],
		[{ path: "../model.int8.onnx", size: 1, sha256: "a".repeat(64) }, { path: "tokens.txt", size: 1, sha256: "a".repeat(64) }],
		[{ path: "model.int8.onnx", size: 1, sha256: "nothex" }, { path: "tokens.txt", size: 1, sha256: "a".repeat(64) }],
	];
	for (const files of bad) assert.ok(assertSafeAsrManifest(files).length > 0, JSON.stringify(files));
});

test("统一注册表：本地 ASR 以 type=asr 出现（不是 chat/classifier），带 asrAdapter 且不含凭据", () => {
	const list = buildRegistry({
		providers: [],
		chatModels: [],
		classifierModels: [],
		custom: [],
		image: { providers: [] },
		local: [
			{
				provider: "local-sensevoice",
				label: "本地 SenseVoice（语音识别）",
				modelId: "sensevoice-small-int8",
				protocol: "local-asr-http",
				type: "asr",
				installed: true,
				running: true,
				state: "running",
				device: "cpu",
				asr: { sampleRate: 16000, maxSeconds: 120, languages: ["zh", "en"], punctuation: true },
			},
		],
	});
	const p = list.find((x) => x.id === "local-sensevoice");
	assert.ok(p, "本地 ASR 服务卡应存在");
	assert.equal(p.kind, "local");
	assert.equal(p.name, "本地 SenseVoice（语音识别）");
	const m = p.models.find((x) => x.type === "asr");
	assert.ok(m, "模型类型必须是 asr");
	assert.deepEqual(m.capabilities, ["asr"]);
	assert.equal(m.source, "local");
	assert.equal(m.asrAdapter?.protocol, "local-asr-http");
	assert.equal(m.asrAdapter?.sampleRate, 16000);
	assert.equal(m.asrAdapter?.requiresApiKey, false, "本地 ASR 不需要用户 API key");
	assert.ok(!p.models.some((x) => x.type === "chat" || x.type === "classifier"), "不伪造成 chat/classifier");
	assert.ok(!JSON.stringify(list).toLowerCase().includes("token"), "注册表里绝不能出现 token 字段");
	assert.ok(modelsWithCapability(list, "asr").length === 1);
});
