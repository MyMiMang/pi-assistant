/**
 * 本地 Laya 一键安装管理：状态机测试。
 *
 * **全部用 fake deps**：不下载任何 GB 依赖、不建 venv、不起真实 Laya、不占 GPU、不碰网络 / 钥匙串 / 系统 Python。
 * 数据目录由 test/setup.ts 强制指向临时目录。
 */
await import("./setup.ts");
import assert from "node:assert/strict";
import { test } from "node:test";
import { platformProfile } from "../src/local-laya/platform.ts";
import { LAYA_SOURCE, LAYA_CHECKPOINTS } from "../src/local-laya/manifest.ts";
import { LocalLayaManager, sanitizeError, type LayaChild, type LayaDeps, type LayaHealth, type LayaPaths, type LayaRunResult } from "../src/local-laya/manager.ts";

function paths(dir: string): LayaPaths {
	return {
		root: dir,
		env: `${dir}/runtime/env`,
		envStaging: `${dir}/runtime/env.new`,
		envPrev: `${dir}/runtime/env.old`,
		python: `${dir}/python`,
		uvCache: `${dir}/uv-cache`,
		hfHome: `${dir}/hf`,
		logs: `${dir}/logs`,
		pidFile: `${dir}/runtime/serve.pid`,
		metaFile: `${dir}/runtime/meta.json`,
	};
}

class FakeChild implements LayaChild {
	pid: number;
	killed: NodeJS.Signals | null = null;
	private cb: ((code: number | null) => void) | null = null;
	constructor(pid = 4321) {
		this.pid = pid;
	}
	kill(s: NodeJS.Signals = "SIGTERM") {
		this.killed = s;
		this.cb?.(0);
		return true;
	}
	onExit(cb: (code: number | null) => void) {
		this.cb = cb;
	}
}

interface FakeOpts {
	platform?: string;
	arch?: string;
	failRun?: string | null;
	health?: LayaHealth;
	installed?: boolean;
	downloadHold?: boolean;
	/** 让 verifyCheckpoint 报「校验失败」，验证失败时绝不 activate */
	verifyFail?: boolean;
}

function fakeDeps(dir: string, opts: FakeOpts = {}) {
	const calls: { run: string[][]; spawned: string[]; phases: string[] } = { run: [], spawned: [], phases: [] };
	const state = { installed: opts.installed ?? false, registered: null as null | { provider: string; modelId: string; protocol: string; baseUrl: string; token: string }, activated: false, rolledBack: false, uninstalled: false, aborted: false, pid: null as number | null, verifyCalls: 0 };
	let child: FakeChild | null = null;
	const deps: LayaDeps = {
		profile: (ctx) => platformProfile(opts.platform ?? "darwin", opts.arch ?? "arm64", ctx),
		nvidiaProbe: async () => ({ available: false, driver: null, cuda: null }),
		ensureUv: async () => `${dir}/uv`,
		uvPath: () => "/fake/uv",
		pythonVersion: () => "3.12",
		run: async (_cmd, args): Promise<LayaRunResult> => {
			calls.run.push(args);
			if (opts.failRun && args.join(" ").includes(opts.failRun)) return { code: 1, stdout: "", stderr: "boom" };
			return { code: 0, stdout: "", stderr: "" };
		},
		spawn: (_exe, args): LayaChild => {
			calls.spawned.push(args.join(" "));
			child = new FakeChild();
			return child;
		},
		downloadCheckpoint: async (_cp, p, signal) => {
			p(500, 1000);
			if (opts.downloadHold) await new Promise<void>((resolve) => setTimeout(resolve, 30));
			if (signal.aborted) {
				state.aborted = true;
				throw new Error("已取消");
			}
			p(1000, 1000);
		},
		verifyCheckpoint: async (_cp, signal) => {
			state.verifyCalls += 1;
			if (signal.aborted) throw new Error("已取消");
			if (opts.verifyFail) throw new Error("权重校验未通过：SHA256 不符：model.safetensors");
		},
		findFreePort: async () => 18080,
		health: async () => opts.health ?? { ok: true, device: "mps", checkpointDevices: { multilingual: "mps" }, cpuFallbacks: { count: 0, lastReason: null }, revisions: { multilingual: LAYA_CHECKPOINTS["laya-multilingual"].revision }, loaded: ["multilingual"] },
		randomToken: () => "deadbeefdeadbeefdeadbeefdeadbeef",
		paths: () => paths(dir),
		registerClassifier: (info) => {
			state.registered = info;
		},
		unregisterClassifier: () => {
			state.registered = null;
		},
		recordPid: (pid) => {
			state.pid = pid;
		},
		now: () => 1000,
		isInstalled: () => state.installed,
		log: () => {},
		activate: async () => {
			state.activated = true;
			state.installed = true;
		},
		rollback: async () => {
			state.rolledBack = true;
		},
		uninstall: async () => {
			state.uninstalled = true;
			state.installed = false;
		},
	};
	return { deps, calls, state, child: () => child };
}

const dir = () => `${process.env.PIA_DATA_DIR}/local-laya`;

test("install：一次成功 → installed/done，走完 preflight→uv→venv→torch→…→activate，且不下多余模型", async () => {
	const { deps, calls, state } = fakeDeps(dir());
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	assert.equal(m.status().install.state, "not_installed");
	assert.equal(m.status().platform.accelerator, "mps");
	const seen: string[] = [];
	const raw = deps.activate;
	deps.activate = async (p) => {
		seen.push(m.status().install.phase);
		return raw(p);
	};
	await m.install({ checkpoint: LAYA_CHECKPOINTS["laya-multilingual"] });
	assert.equal(m.status().install.state, "installed");
	assert.equal(m.status().install.phase, "done");
	assert.ok(state.activated);
	assert.equal(seen[0], "activate");
	// 安装命令里出现 pin 的版本与 torch 后端
	assert.ok(calls.run.some((a) => a.some((x) => x.includes("laya[serve]==0.4.8"))));
	assert.ok(calls.run.some((a) => a.includes("--torch-backend")));
	// 下载后必须跑过固定清单校验，且在 activate 之前
	assert.equal(state.verifyCalls, 1, "安装必须校验权重文件清单");
});

test("install：权重校验失败 → failed + 回滚，绝不 activate（不产生半安装 ready）", async () => {
	const { deps, state } = fakeDeps(dir(), { verifyFail: true });
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	await assert.rejects(() => m.install({ checkpoint: LAYA_CHECKPOINTS["laya-multilingual"] }), /权重校验未通过/);
	assert.equal(state.verifyCalls, 1);
	assert.equal(m.status().install.state, "failed");
	assert.ok(state.rolledBack);
	assert.equal(state.activated, false, "校验未过绝不能 activate");
	assert.equal(m.status().configured, false);
});

test("status：configured（已安装配置）与 registered（进程内可用）分离，stop 不删配置", async () => {
	const { deps, state } = fakeDeps(dir(), { installed: true });
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	assert.equal(m.status().configured, true, "已安装即 configured");
	assert.equal(m.status().registered, null, "未启动则进程内未注册（但 configured 仍为 true）");
	await m.start();
	assert.ok(m.status().registered);
	await m.stop();
	const st = m.status();
	assert.equal(st.registered, null, "停止后进程内不再注册");
	assert.equal(st.configured, true, "停止不得删掉已安装配置");
	assert.equal(st.install.state, "installed", "停止不得把安装状态重置");
	assert.equal(state.registered, null, "停止清掉进程内 runtime key");
});

test("install：Windows ARM64 预检直接失败，不用假 no-op 冒充支持", async () => {
	const { deps, state } = fakeDeps(dir(), { platform: "win32", arch: "arm64" });
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	assert.equal(m.status().platform.support, "unsupported");
	await assert.rejects(() => m.install({ checkpoint: LAYA_CHECKPOINTS["laya-multilingual"] }), /暂不支持/);
	assert.equal(m.status().install.state, "failed");
	assert.ok(!state.activated, "不支持平台绝不能 activate");
	assert.match(m.status().install.error ?? "", /暂不支持/);
});

test("install：取消下载 → 回到未安装，回滚 staging，不产生半安装 ready", async () => {
	const { deps, state } = fakeDeps(dir(), { downloadHold: true });
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	const p = m.install({ checkpoint: LAYA_CHECKPOINTS["laya-multilingual"] }).catch((e: unknown) => e);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(m.status().install.state, "installing");
	assert.equal(m.cancel().ok, true);
	await p;
	assert.equal(m.status().install.state, "not_installed");
	assert.ok(state.rolledBack);
	assert.ok(!state.installed);
});

test("install：失败 → failed + 脱敏错误 + 回滚；旧环境不被破坏", async () => {
	const { deps, state } = fakeDeps(dir(), { failRun: "import laya" });
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	await assert.rejects(() => m.install({ checkpoint: LAYA_CHECKPOINTS["laya-multilingual"] }));
	assert.equal(m.status().install.state, "failed");
	assert.ok(state.rolledBack);
	assert.equal(state.installed, false);
});

test("install：并发第二个 install 被拒（单一 job，两个入口不会二次安装）", async () => {
	const { deps, state } = fakeDeps(dir(), { downloadHold: true });
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	const p = m.install({ checkpoint: LAYA_CHECKPOINTS["laya-multilingual"] }).catch((e: unknown) => e);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(m.status().install.state, "installing");
	await assert.rejects(() => m.install({ checkpoint: LAYA_CHECKPOINTS["laya-multilingual"] }), /安装已在进行中/);
	assert.equal(state.verifyCalls, 0, "第二次不得重新开始安装");
	m.cancel();
	await p;
});

test("start/stop：running 时 token 不进 status；注册 loopback baseUrl；stop 只杀自己的子进程", async () => {
	const { deps, state, child } = fakeDeps(dir(), { installed: true });
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	assert.equal(m.status().install.state, "installed");
	await m.start();
	const st = m.status();
	assert.equal(st.runtime.state, "running");
	assert.equal(st.runtime.host, "127.0.0.1");
	assert.equal(st.runtime.port, 18080);
	assert.ok(st.registered);
	assert.equal(st.registered?.modelId, "multilingual");
	// status JSON 里绝不能出现 token
	assert.ok(!JSON.stringify(st).includes("deadbeef"));
	assert.ok(state.registered?.baseUrl.startsWith("http://127.0.0.1:18080/v1/"));
	assert.equal(state.registered?.token, "deadbeefdeadbeefdeadbeefdeadbeef");
	assert.equal(state.pid, 4321);
	await m.stop();
	assert.equal(m.status().runtime.state, "stopped");
	assert.equal(child()?.killed, "SIGTERM");
	assert.equal(state.registered, null);
	assert.equal(state.pid, null);
});

test("install 中途子进程崩溃 → crashed，且不再报 registered，并撤销 classifier 注册", async () => {
	const { deps, child, state } = fakeDeps(dir(), { installed: true });
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	await m.start();
	assert.ok(state.registered, "启动后先注册");
	child()?.kill("SIGKILL");
	assert.equal(m.status().runtime.state, "crashed");
	assert.equal(m.status().registered, null);
	assert.equal(state.registered, null, "崩溃也必须从 Pi 目录里撤销注册，不留死端口的本地服务");
});

test("uninstall：必须显式确认；确认后调 deps.uninstall 并重置状态", async () => {
	const { deps, state } = fakeDeps(dir(), { installed: true });
	const m = new LocalLayaManager(deps, LAYA_SOURCE);
	await assert.rejects(() => m.uninstall(false), /显式确认/);
	assert.ok(!state.uninstalled);
	await m.uninstall(true);
	assert.ok(state.uninstalled);
	assert.equal(m.status().install.state, "not_installed");
});

test("platform：Intel Mac 条件支持并 pin 老栈；Linux arm64 条件 CPU；x64 CUDA 需驱动", () => {
	const intel = platformProfile("darwin", "x64");
	assert.equal(intel.support, "conditional");
	assert.deepEqual(intel.pins, ["numpy<2", "torch==2.2.2", "transformers==4.57.6"]);
	const linuxArm = platformProfile("linux", "arm64");
	assert.equal(linuxArm.support, "conditional");
	assert.equal(linuxArm.accelerator, "cpu");
	// 请求 CUDA 但没有驱动 → 仍 CPU，不假装支持
	const noDriver = platformProfile("linux", "x64", { wantCuda: true, nvidia: { available: false, driver: null, cuda: null } });
	assert.equal(noDriver.accelerator, "cpu");
	const cuda = platformProfile("linux", "x64", { wantCuda: true, nvidia: { available: true, driver: "580.1", cuda: "13.0" } });
	assert.equal(cuda.accelerator, "cuda");
	assert.equal(cuda.torchBackend, "cu130");
	const xpu = platformProfile("win32", "x64", { wantXpu: true, xpu: true });
	assert.equal(xpu.accelerator, "xpu");
	assert.equal(xpu.support, "experimental");
});

test("sanitizeError：去掉 Bearer token 与长 hex", () => {
	const s = sanitizeError(new Error("failed Authorization: Bearer abcdef0123456789 token deadbeefdeadbeefdeadbeefdeadbeef"));
	assert.ok(!s.includes("abcdef0123456789"));
	assert.ok(!s.includes("deadbeefdeadbeefdeadbeefdeadbeef"));
	assert.ok(s.includes("***"));
});
