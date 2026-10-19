/**
 * 本地 ASR 测试共用的假环境：fake deps（不下载权重、不起真实 sidecar、不碰用户文件 / GPU / 系统 Python）
 * + 内存里的语音来源端口（带版本 / present，用来测 CAS）。local-asr-multimodel / local-voice-module 共用。
 */
import { asrRunnerFamily } from "../src/local-asr/runner.ts";
import { LocalAsrManager, type AsrDeps, type AsrPaths } from "../src/local-asr/manager.ts";
import { LocalAsrService, type AsrSelectionPort } from "../src/local-asr/service.ts";
import { senseVoicePlatform } from "../src/local-asr/platform.ts";

export function pathsFor(modelId: string): AsrPaths {
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

export interface Instance {
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

export function makeHarness() {
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

	const selection: { sel: { location: "cloud" | "local"; provider: string; model: string } | null; ver: number; present: boolean } = { sel: null, ver: 0, present: false };
	const port: AsrSelectionPort = {
		read: () => selection.sel,
		version: () => selection.ver,
		present: () => selection.present,
		write: (s, opts) => {
			if (opts?.expectedVersion !== undefined && opts.expectedVersion !== selection.ver) throw new Error("asr_source_conflict");
			selection.sel = s;
			selection.ver += 1;
			selection.present = true;
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
