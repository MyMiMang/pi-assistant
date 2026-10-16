/**
 * 本地 ASR 多模型：catalog DTO / 运行族真实参数 / 多模型生命周期（装两个 → 选择 → 推理 child → 取消 → 重试 →
 * 重启读 per-model metadata → 卸载一个不影响另一个）/ stale intent / 忙时拒绝切换 / 下载投影。
 *
 * 全部用 fake deps（不下载权重、不起真实 sidecar、不碰用户文件 / GPU / 系统 Python）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
	ASR_CATALOG,
	asrModelSpec,
	classifyAsrHardware,
	recommendAsrModelId,
} from "../src/local-asr/catalog.ts";
import { asrRunnerFamily, hasAsrRunnerFamily, type AsrRunnerFamily } from "../src/local-asr/runner.ts";
import { LocalAsrManager, type AsrDeps, type AsrPaths } from "../src/local-asr/manager.ts";
import { LocalAsrService, asrPhaseLabel, type AsrSelectionPort } from "../src/local-asr/service.ts";
import { projectAsrInstall, asrDownloadId } from "../src/local-asr/download.ts";
import { bus } from "../src/bus.ts";
import * as dl from "../src/downloads.ts";
import { mountLocalAsrRoutes } from "../src/local-asr/routes.ts";
import { senseVoicePlatform } from "../src/local-asr/platform.ts";

const PARA = "paraformer-zh-2023-09-14-int8";
const WSMALL = "whisper-small-int8";

function pathsFor(modelId: string): AsrPaths {
	const root = "/tmp/fake-asr";
	const legacy = modelId === "sensevoice-small-int8";
	const dir = legacy ? root : `${root}/models/${modelId}`;
	return {
		root,
		env: `${root}/runtime/env`,
		envStaging: `${root}/runtime/env.new`,
		envPrev: `${root}/runtime/env.old`,
		python: `${root}/python`,
		uvCache: `${root}/uv-cache`,
		weights: `${dir}/weights`,
		weightsStaging: `${dir}/weights.new`,
		logs: `${root}/logs`,
		pidFile: `${root}/runtime/serve.pid`,
		metaFile: `${dir}/meta.json`,
		serve: legacy ? `${root}/runtime/serve.py` : `${root}/runtime/serve-${modelId}.py`,
	};
}

interface Instance {
	installed: Set<string>;
	serves: Map<string, string>;
	spawned: { exe: string; args: string[] }[];
	activePid: number | null;
	kills: number[];
	rollbacks: number;
	downloads: string[];
	uninstalled: string[];
	onDownload?: () => void;
	hangDownload?: boolean;
	healthOk?: boolean;
}

function makeHarness() {
	const inst: Instance = {
		installed: new Set(),
		serves: new Map(),
		spawned: [],
		activePid: null,
		kills: [],
		rollbacks: 0,
		downloads: [],
		uninstalled: [],
		healthOk: true,
	};
	const deps: AsrDeps = {
		profile: () => senseVoicePlatform("darwin", "arm64"),
		physicalCores: () => 8,
		logicalCores: () => 16,
		ensureUv: async () => "uv",
		uvPath: () => "uv",
		pythonVersion: () => "3.12",
		run: async () => ({ code: 0, stdout: "", stderr: "" }),
		installEngine: async () => {},
		spawnServe: (exe, args) => {
			inst.spawned.push({ exe, args: [...args] });
			const child = {
				pid: 5000 + inst.spawned.length,
				kill: () => {
					inst.kills.push(child.pid);
					return true;
				},
				onExit: () => {},
			};
			inst.activePid = child.pid;
			return child;
		},
		downloadWeights: async (files, p, _signal, _env, _py, opts) => {
			inst.downloads.push(opts.modelId);
			p(1, files.reduce((n, f) => n + f.size, 0));
			inst.onDownload?.();
			if (inst.hangDownload) await new Promise<void>((_res, rej) => _signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
		},
		verifyWeights: async () => {},
		importWeights: async () => ({ copied: 1, bytes: 1 }),
		findFreePort: async () => 51999,
		health: async () => ({ ok: inst.healthOk !== false, device: "cpu", loaded: ["m"] }),
		activate: async (paths, meta) => {
			inst.installed.add(meta.modelId);
			const fam = asrRunnerFamily(meta.runner);
			inst.serves.set(meta.modelId, fam.serveScript({ roles: meta.fileRoles, sampleRate: meta.sampleRate, maxAudioBytes: meta.maxAudioBytes }));
			void paths;
		},
		rollback: async () => {
			inst.rollbacks += 1;
		},
		uninstall: async (_paths, modelId) => {
			if (modelId) {
				inst.installed.delete(modelId);
				inst.uninstalled.push(modelId);
			}
		},
		randomToken: () => "t".repeat(64),
		paths: (modelId?: string) => pathsFor(modelId ?? "sensevoice-small-int8"),
		registerAsr: () => {},
		unregisterAsr: () => {},
		recordPid: (pid) => {
			inst.activePid = pid;
		},
		now: () => 1_000_000,
		setTimer: () => ({ cancel: () => {} }),
		isInstalled: (modelId?: string) => inst.installed.has(modelId ?? "sensevoice-small-int8"),
		log: () => {},
	};

	const selection: { sel: { location: "cloud" | "local"; provider: string; model: string } | null; ver: number } = { sel: null, ver: 0 };
	const port: AsrSelectionPort = {
		read: () => selection.sel,
		version: () => selection.ver,
		write: (s, opts) => {
			if (opts?.expectedVersion !== undefined && opts.expectedVersion !== selection.ver) throw new Error("asr_source_conflict");
			selection.sel = s;
			selection.ver += 1;
		},
	};
	const svc = new LocalAsrService({
		createManager: (spec) =>
			new LocalAsrManager(deps, { source: spec.source, license: spec.license, model: spec.manifest, ids: { provider: spec.provider, modelId: spec.id, protocol: "local-asr-http" } }, () => {}),
		selection: port,
		hardware: () => ({ os: "darwin", arch: "arm64", cpuCores: 8, memoryBytes: 16 * 1024 ** 3 }),
	});
	return { svc, deps, inst, selection, port };
}

// ------------------------------------------------------------------ catalog

test("catalog：6 个模型都有真实 pin / 许可 / 体积；官方模型许可 cleared，SenseVoice 保持 unresolved", () => {
	assert.equal(ASR_CATALOG.length, 6);
	for (const spec of ASR_CATALOG) {
		assert.ok(spec.manifest.files.length >= 2, `${spec.id} 至少两个权重文件`);
		for (const f of spec.manifest.files) assert.match(f.sha256, /^[a-f0-9]{64}$/, `${spec.id} / ${f.path} SHA256 形状`);
		assert.equal(spec.manifest.bytes, spec.manifest.files.reduce((n, f) => n + f.size, 0), `${spec.id} 体积应等于文件之和`);
		assert.ok(hasAsrRunnerFamily(spec.family), `${spec.id} 运行族必须已注册`);
		assert.ok(spec.recommend.estimated === true, `${spec.id} 推荐必须标估算`);
	}
	assert.equal(asrModelSpec(PARA)?.license.decision, "cleared");
	assert.equal(asrModelSpec(WSMALL)?.license.decision, "cleared");
	assert.equal(asrModelSpec("sensevoice-small-int8")?.license.decision, "unresolved");
	assert.equal(ASR_CATALOG.find((m) => m.id === PARA)?.manifest.files[0].path, "model.int8.onnx");
	assert.ok(ASR_CATALOG.find((m) => m.id === WSMALL)?.manifest.files.some((f) => f.path.endsWith("decoder.int8.onnx")));
});

test("catalog DTO：硬件档位 + 推荐 + 每模型状态/许可/来源，且绝不含 token", () => {
	const h = makeHarness();
	const view = h.svc.catalog();
	assert.equal(view.models.length, 6);
	assert.equal(view.hardware.tier, "balanced");
	assert.equal(view.recommendedId, WSMALL);
	assert.equal(view.runtime.engine, "sherpa-onnx");
	assert.ok(view.hardware.tierNote.includes("未实测"));
	for (const m of view.models) {
		assert.equal(m.installed, false);
		assert.ok(m.weightsBytes > 0);
		assert.ok(m.license.links.modelLicense.startsWith("http"));
		assert.ok(m.suggestedMemoryBytes > 0);
		assert.equal(m.recommendationReason.includes("未实测") || !m.recommended, true);
		assert.equal(/"token"\s*:/.test(JSON.stringify(m)), false);
	}
	assert.equal(view.models.find((m) => m.id === PARA)?.license.decision, "cleared");
	assert.equal(view.models.find((m) => m.id === "sensevoice-small-int8")?.license.decision, "unresolved");
});

test("硬件档位按系统总 RAM 保守分档（8/16/32），不是跑分", () => {
	assert.equal(classifyAsrHardware(8 * 1024 ** 3, 8).tier, "light");
	assert.equal(classifyAsrHardware(16 * 1024 ** 3, 8).tier, "balanced");
	assert.equal(classifyAsrHardware(32 * 1024 ** 3, 12).tier, "high");
	assert.equal(classifyAsrHardware(0, 8).tier, "unknown");
	assert.equal(recommendAsrModelId("light"), PARA);
	assert.equal(recommendAsrModelId("high"), "whisper-large-v3-int8");
});

// ------------------------------------------------------------------ 运行族

test("catalog 全部真实清单能过各自运行族自检（Whisper 是 *-tokens.txt，不是 tokens.txt）", () => {
	for (const spec of ASR_CATALOG) {
		const fam = asrRunnerFamily(spec.family);
		const problems = fam.assertWeights(spec.manifest.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })));
		assert.deepEqual(problems, [], `${spec.id} 的自检问题：${problems.join("；")}`);
	}
	assert.equal(asrModelSpec(WSMALL)?.manifest.fileRoles?.tokens, "small-tokens.txt");
	const whisperFiles = ["small-tokens.txt", "e.onnx", "d.onnx"].map((p) => ({ path: p, size: 1, sha256: "a".repeat(64) }));
	assert.deepEqual(asrRunnerFamily("whisper").assertWeights(whisperFiles), []);
});

test("sidecar 脚本按 ASR_WEIGHTS 取权重目录（多模型不能写死 ROOT/weights）", () => {
	const sv = asrRunnerFamily("whisper").serveScript({ roles: { encoder: "e.onnx", decoder: "d.onnx", tokens: "t.txt" }, sampleRate: 16000, maxAudioBytes: 1024 });
	assert.match(sv, /os\.environ\.get\("ASR_WEIGHTS"\) or os\.path\.join\(ROOT, "weights"\)/);
	// /health 必须回报实际加载的 modelId（证明选对了模型，而不只是「有个 onnx」）。
	assert.match(sv, /MODEL_ID = os\.environ\.get\("ASR_MODEL_ID", ""\)/);
	assert.match(sv, /"modelId": MODEL_ID/);
});

test("local-asr.changed 事件驱动统一「下载与组件」状态（不靠每秒轮询）", () => {
	const id = asrDownloadId(PARA);
	const seen: string[] = [];
	const off = bus.on((e) => {
		const item = (e as { item?: { id?: string } }).item;
		if (e.type === "downloads.changed" && item?.id === id) seen.push(item.id);
	});
	// 模拟 manager 的状态变化事件（仅验证转发，不真安装）。
	bus.emit({
		type: "local-asr.changed",
		provider: "local-paraformer",
		modelId: PARA,
		status: { install: { state: "installing", phase: "weights", received: 5, total: 10, error: null } } as unknown as import("../src/local-asr/manager.ts").AsrStatus,
	});
	off();
	assert.ok(seen.length >= 1, "local-asr.changed 应触发统一下载面板重读（notifyDownload）");
	assert.ok(dl.downloadInfo(id), "登记的下载条目应存在");
});

test("运行族：三族生成真实构造参数；Whisper language 显式 \"\"（不回落引擎默认 en）；未知族 fail closed", () => {
	const sv = asrRunnerFamily("sensevoice").serveScript({ roles: { model: "m.onnx", tokens: "t.txt" }, sampleRate: 16000, maxAudioBytes: 1024 });
	assert.match(sv, /from_sense_voice/);
	const pf = asrRunnerFamily("paraformer").serveScript({ roles: { model: "m.onnx", tokens: "t.txt" }, sampleRate: 16000, maxAudioBytes: 1024 });
	assert.match(pf, /from_paraformer/);
	assert.match(pf, /feature_dim=80/);
	const wh = asrRunnerFamily("whisper").serveScript({ roles: { encoder: "e.onnx", decoder: "d.onnx", tokens: "t.txt" }, sampleRate: 16000, maxAudioBytes: 1024 });
	assert.match(wh, /from_whisper/);
	assert.match(wh, /language=LANGUAGE/);
	assert.match(wh, /os\.environ\.get\("ASR_LANGUAGE", ""\)/);
	assert.equal(hasAsrRunnerFamily("qwen3_asr"), false, "Qwen3-ASR 未 pin 前不注册，避免假支持");
	assert.throws(() => asrRunnerFamily("bogus"), /未知的本地 ASR 运行族/);
	assert.deepEqual(projectAsrInstall({ state: "installing", phase: "weights", received: 5, total: 10, error: null }), { state: "downloading", received: 5, total: 10, detail: "下载 / 导入权重", error: null });
	assert.equal(projectAsrInstall({ state: "installing", phase: "engine", received: 0, total: null, error: null }).total, null);
	assert.equal(asrDownloadId(PARA), `asr:${PARA}`);
	assert.equal(asrPhaseLabel("activate"), "启用模型");
});

test("未注册运行族的模型：precheck 直接拒绝（不用假 runner 冒充）", () => {
	const h = makeHarness();
	const bogus: AsrRunnerFamily = { id: "bogus", label: "b", requiredRoles: ["model"], serveScript: () => "", assertWeights: () => [] };
	// 不改全局注册（只验证未知族会抛）
	assert.equal(hasAsrRunnerFamily(bogus.id), false);
	void bogus;
	const spec = asrModelSpec(PARA)!;
	const fake = { ...spec, manifest: { ...spec.manifest, runner: "nope" } };
	const mgr = new LocalAsrManager(
		({
			...h.deps,
			paths: () => pathsFor(fake.id),
		} as AsrDeps),
		{ source: fake.source, license: fake.license, model: fake.manifest, ids: { provider: fake.provider, modelId: fake.id, protocol: "local-asr-http" } },
	);
	const pre = mgr.precheck({ source: "download", acceptLicense: "Apache-2.0" });
	assert.equal(pre.ok, false);
	if (!pre.ok) assert.match(pre.error, /未知的本地 ASR 运行族/);
});

// ------------------------------------------------------------------ 多模型生命周期

test("共享 runtime 复用：引擎已装同一套时跳过 venv/引擎安装，不可复用则完整重建", async () => {
	const spec = asrModelSpec(PARA)!;
	const mk = (reuse: boolean) => {
		const h = makeHarness();
		let venvRuns = 0;
		let engineInstalls = 0;
		let engineReadyCalls = 0;
		const deps: AsrDeps = {
			...h.deps,
			run: async (_cmd, args) => {
				if (args[0] === "venv") venvRuns += 1;
				return { code: 0, stdout: "", stderr: "" };
			},
			installEngine: async () => {
				engineInstalls += 1;
			},
			engineReady: async () => {
				engineReadyCalls += 1;
				return reuse;
			},
		};
		const mgr = new LocalAsrManager(deps, { source: spec.source, license: spec.license, model: spec.manifest, ids: { provider: spec.provider, modelId: spec.id, protocol: "local-asr-http" } });
		return { h, mgr, counts: () => ({ venvRuns, engineInstalls, engineReadyCalls }) };
	};

	const reuse = mk(true);
	await reuse.mgr.install({ source: "download", acceptLicense: "Apache-2.0" });
	assert.deepEqual(reuse.counts(), { venvRuns: 0, engineInstalls: 0, engineReadyCalls: 1 });
	assert.ok(reuse.h.inst.installed.has(PARA), "复用引擎时权重仍要按模型装好");
	assert.equal(reuse.h.inst.downloads[0], PARA);

	const rebuild = mk(false);
	await rebuild.mgr.install({ source: "download", acceptLicense: "Apache-2.0" });
	assert.deepEqual(rebuild.counts(), { venvRuns: 1, engineInstalls: 1, engineReadyCalls: 1 });
	assert.ok(rebuild.h.inst.installed.has(PARA));
});

test("多模型：装两个 → 选择切换（旧 worker 停）→ 推理 child 指向对应模型脚本 → 卸载一个不影响另一个", async () => {
	const h = makeHarness();
	// 装 A（Paraformer, Apache-2.0）
	await h.svc.install(PARA, { acceptLicense: "Apache-2.0", intent: "install" });
	assert.deepEqual(h.inst.downloads, [PARA]);
	// 装 B（Whisper small, MIT）
	await h.svc.install(WSMALL, { acceptLicense: "MIT", intent: "install" });
	assert.deepEqual(h.inst.downloads, [PARA, WSMALL]);
	const view = h.svc.catalog();
	assert.equal(view.models.find((m) => m.id === PARA)?.installed, true);
	assert.equal(view.models.find((m) => m.id === WSMALL)?.installed, true);

	// 选择 A → A 启动
	await h.svc.select(PARA);
	assert.equal(h.svc.managerFor(PARA).status().runtime.state, "running");
	assert.equal(h.inst.spawned.at(-1)?.args[0], pathsFor(PARA).serve);
	assert.equal(h.selection.sel?.model, PARA);

	// 切到 B → A 被停（kill），B 启动且脚本是 B 的
	await h.svc.select(WSMALL);
	assert.ok(h.inst.kills.length >= 1, "切换必须停旧 worker");
	assert.equal(h.svc.managerFor(PARA).status().runtime.state, "stopped");
	assert.equal(h.svc.managerFor(WSMALL).status().runtime.state, "running");
	assert.equal(h.inst.spawned.at(-1)?.args[0], pathsFor(WSMALL).serve);
	assert.equal(h.selection.sel?.model, WSMALL);
	// 生成的脚本确实是 Whisper 参数
	assert.match(h.inst.serves.get(WSMALL) ?? "", /from_whisper/);
	assert.match(h.inst.serves.get(PARA) ?? "", /from_paraformer/);

	// 卸载 B → 只删 B；A 的权重/安装不受影响
	await h.svc.uninstall(WSMALL, true);
	assert.deepEqual(h.inst.uninstalled, [WSMALL]);
	assert.equal(h.svc.managerFor(WSMALL).status().install.state, "not_installed");
	assert.equal(h.svc.managerFor(PARA).status().install.state, "installed");
});

test("单模型元数据：重启后按 per-model metadata 恢复 installed（不误报 / 不丢）", async () => {
	const h = makeHarness();
	await h.svc.install(PARA, { acceptLicense: "Apache-2.0", intent: "install" });
	// 模拟进程重启：新 service 读同一 fake 安装状态
	const h2 = makeHarness();
	h2.inst.installed = h.inst.installed;
	const view = h2.svc.catalog();
	assert.equal(view.models.find((m) => m.id === PARA)?.installed, true);
	assert.equal(view.models.find((m) => m.id === WSMALL)?.installed, false);
});

test("取消安装：回滚 staging、状态回到未安装；随后重试成功且 attempt 递增", async () => {
	const h = makeHarness();
	h.inst.hangDownload = true;
	const installing = h.svc.install(PARA, { acceptLicense: "Apache-2.0", intent: "install" });
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(h.svc.cancel(PARA).ok, true);
	await assert.rejects(installing, /取消/);
	assert.ok(h.inst.rollbacks >= 1);
	assert.equal(h.svc.managerFor(PARA).status().install.state, "not_installed");

	h.inst.hangDownload = false;
	await h.svc.install(PARA, { acceptLicense: "Apache-2.0", intent: "install" });
	assert.equal(h.svc.managerFor(PARA).status().install.state, "installed");
	const view = h.svc.catalog();
	assert.equal(view.models.find((m) => m.id === PARA)?.install.attempt, 2);
});

test("stale intent：install_and_use 期间用户改选云端，安装完成后不得覆盖新选择", async () => {
	const h = makeHarness();
	h.selection.sel = null;
	h.inst.onDownload = () => {
		// 安装进行中，用户改选云端
		h.selection.sel = { location: "cloud", provider: "openai", model: "whisper-1" };
	};
	await h.svc.install(WSMALL, { acceptLicense: "MIT", intent: "install_and_use" });
	const sel = h.selection.sel as { location?: string; model?: string } | null;
	assert.equal(sel?.location, "cloud", "迟到的安装完成不得覆盖后来的 cloud 选择");
	assert.equal(sel?.model, "whisper-1");
});

test("install_and_use：选择自开始未变时才写「用本地」来源", async () => {
	const h = makeHarness();
	await h.svc.install(WSMALL, { acceptLicense: "MIT", intent: "install_and_use" });
	assert.deepEqual(h.selection.sel, { location: "local", provider: "local-whisper", model: WSMALL });
});

test("install_and_use CAS：安装期间别的客户端写过来源（版本前进）→ 不覆盖，保持用户后来的选择", async () => {
	const h = makeHarness();
	// 安装下载中，另一个页面 / 客户端写了一次来源（版本前进），随后用户没再改
	h.inst.onDownload = () => {
		h.selection.ver += 1;
	};
	await h.svc.install(WSMALL, { acceptLicense: "MIT", intent: "install_and_use" });
	assert.equal(h.selection.sel, null, "CAS 失败（版本已变）不得写「用本地」覆盖");
});

test("忙时切换：有录音租约时 select 明确拒绝，不把进行中的音频送给别的模型", async () => {
	const h = makeHarness();
	await h.svc.install(PARA, { acceptLicense: "Apache-2.0", intent: "install" });
	await h.svc.install(WSMALL, { acceptLicense: "MIT", intent: "install" });
	await h.svc.select(PARA);
	const lease = h.svc.managerFor(PARA).acquireRecording();
	await assert.rejects(() => h.svc.select(WSMALL), /正在录音/);
	// 卸载忙模型也拒绝
	await assert.rejects(() => h.svc.uninstall(PARA, true), /正在录音/);
	lease.release();
	await h.svc.select(WSMALL);
	assert.equal(h.svc.managerFor(WSMALL).status().runtime.state, "running");
});

test("全局串行：另一个模型安装进行中时，第二个 install 被拒（不并发 uv pip 污染同一 env）", async () => {
	const h = makeHarness();
	h.inst.hangDownload = true;
	const first = h.svc.install(PARA, { acceptLicense: "Apache-2.0", intent: "install" });
	await new Promise((r) => setTimeout(r, 10));
	const pre = h.svc.precheckInstall(WSMALL, { source: "download", acceptLicense: "MIT" });
	assert.equal(pre.ok, false);
	if (!pre.ok) assert.match(pre.error, /另一个模型的安装/);
	h.svc.cancel(PARA);
	await first.catch(() => {});
});

test("许可门槛：SenseVoice（unresolved）下载安装被拒；自行导入路径仍可用", async () => {
	const h = makeHarness();
	const pre = h.svc.precheckInstall("sensevoice-small-int8", { source: "download", acceptLicense: "1.1" });
	assert.equal(pre.ok, false);
	if (!pre.ok) assert.match(pre.error, /未最终确认/);
	const imp = h.svc.precheckInstall("sensevoice-small-int8", { source: "import", importDir: "/tmp/w" });
	assert.equal(imp.ok, true, "unresolved 下用户自行导入仍开放");
});

test("Whisper 声明 punctuation 为原生输出（不照抄研究里不可靠的 false）", () => {
	for (const id of ["whisper-base-int8", WSMALL, "whisper-turbo-int8", "whisper-large-v3-int8"]) {
		assert.equal(asrModelSpec(id)?.manifest.punctuation, true, `${id} 原生输出含标点`);
	}
	assert.equal(asrModelSpec(PARA)?.manifest.punctuation, false, "Paraformer 确实无标点");
});

// ------------------------------------------------------------------ 路由

test("路由：GET /catalog 返回聚合 DTO 且不启动 worker；按 id install 生效；未知模型 404", async () => {
	const h = makeHarness();
	const app = new Hono();
	mountLocalAsrRoutes(app as never, async (_c, next) => next(), () => h.svc.managerFor("sensevoice-small-int8"), { service: () => h.svc });

	const res = await app.request("/api/local-models/asr/catalog");
	assert.equal(res.status, 200);
	const body = (await res.json()) as { models: unknown[]; hardware: { tier: string }; recommendedId: string };
	assert.equal(body.models.length, 6);
	assert.equal(body.hardware.tier, "balanced");
	assert.equal(body.recommendedId, WSMALL);
	assert.equal(h.inst.spawned.length, 0, "GET catalog 不得启动 worker");
	assert.equal(h.inst.downloads.length, 0, "GET catalog 不得触发下载");

	const ins = await app.request(`/api/local-models/asr/models/${PARA}/install`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ acceptLicense: "Apache-2.0", intent: "install" }),
	});
	assert.equal(ins.status, 200);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(h.svc.managerFor(PARA).status().install.state, "installed");

	// 宽松许可（Whisper MIT）：不带 acceptLicense 也能一键装
	const oneClick = await app.request(`/api/local-models/asr/models/${WSMALL}/install`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ intent: "install" }),
	});
	assert.equal(oneClick.status, 200, "MIT 模型不应强要求每次勾同意");

	// SenseVoice（unresolved）：下载安装 400，不偷放
	const blocked = await app.request("/api/local-models/asr/models/sensevoice-small-int8/install", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ acceptLicense: "1.1", intent: "install" }),
	});
	assert.equal(blocked.status, 400);

	const nf = await app.request("/api/local-models/asr/models/nope/status");
	assert.equal(nf.status, 404);
});
