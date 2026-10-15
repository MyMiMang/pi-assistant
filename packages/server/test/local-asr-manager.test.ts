/**
 * 本地 ASR 生命周期状态机（安装 / 启动 / 停止 / 空闲释放 / 有界重启）。
 *
 * 边界：全部用 fake deps（含可驱动时钟），不下载权重、不起真实 sidecar、不碰钥匙串 / 用户文件 / GPU。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalAsrManager, backoffMs, sanitizeError, type AsrDeps, type AsrPaths, type AsrTimer } from "../src/local-asr/manager.ts";
import { ASR_DEFAULT_IDLE_SECONDS, ASR_MODEL_ID, ASR_PROVIDER_ID, SENSEVOICE_LICENSE, SENSEVOICE_MODEL, SENSEVOICE_SOURCE } from "../src/local-asr/manifest.ts";
import { ASR_PROTOCOL } from "../src/local-asr/adapter.ts";
import { senseVoicePlatform } from "../src/local-asr/platform.ts";

/** 可驱动的假时钟（只跑到期定时器，按时间顺序）。 */
class FakeClock {
	t = 1_000;
	private seq = 0;
	private timers = new Map<number, { at: number; fn: () => void }>();
	now() {
		return this.t;
	}
	setTimer(fn: () => void, ms: number): AsrTimer {
		const id = ++this.seq;
		this.timers.set(id, { at: this.t + ms, fn });
		return { cancel: () => void this.timers.delete(id) };
	}
	advance(ms: number) {
		const target = this.t + ms;
		for (;;) {
			let next: { id: number; at: number; fn: () => void } | null = null;
			for (const [id, e] of this.timers) if (e.at <= target && (!next || e.at < next.at)) next = { id, at: e.at, fn: e.fn };
			if (!next) break;
			this.timers.delete(next.id);
			this.t = next.at;
			next.fn();
		}
		this.t = target;
	}
}

const paths: AsrPaths = {
	root: "/tmp/fake-asr",
	env: "/tmp/fake-asr/runtime/env",
	envStaging: "/tmp/fake-asr/runtime/env.new",
	envPrev: "/tmp/fake-asr/runtime/env.old",
	python: "/tmp/fake-asr/python",
	uvCache: "/tmp/fake-asr/uv-cache",
	weights: "/tmp/fake-asr/weights",
	weightsStaging: "/tmp/fake-asr/weights.new",
	logs: "/tmp/fake-asr/logs",
	pidFile: "/tmp/fake-asr/runtime/serve.pid",
	metaFile: "/tmp/fake-asr/runtime/meta.json",
};

interface Harness {
	manager: LocalAsrManager;
	clock: FakeClock;
	calls: string[];
	state: { pid: number | null; registered: { baseUrl: string; token: string; modelId: string } | null; kills: number[]; rollbacks: number; activates: number; installed: boolean; spawns: number };
	/** 让某一步失败 / 挂起（测试按需改） */
	behavior: { failVerify?: boolean; hangDownload?: boolean; failSpawn?: boolean; healthOk?: boolean; exitAfterStart?: number | null };
}

function harness(opts: { license?: typeof SENSEVOICE_LICENSE; idleSeconds?: number; platformSupport?: "supported" | "unsupported" } = {}): Harness {
	const clock = new FakeClock();
	const calls: string[] = [];
	const state: Harness["state"] = { pid: null, registered: null, kills: [], rollbacks: 0, activates: 0, installed: false, spawns: 0 };
	const behavior: Harness["behavior"] = { healthOk: true };
	const deps: AsrDeps = {
		profile: () => (opts.platformSupport === "unsupported" ? { ...senseVoicePlatform("linux", "arm"), support: "unsupported", reason: "暂不支持 linux-arm" } : senseVoicePlatform("darwin", "arm64")),
		physicalCores: () => 8,
		logicalCores: () => 16,
		ensureUv: async () => {
			calls.push("ensureUv");
			return "uv";
		},
		uvPath: () => "uv",
		pythonVersion: () => "3.12",
		run: async (_cmd, args) => {
			calls.push(`run:${args[0] ?? ""}`);
			return { code: 0, stdout: "", stderr: "" };
		},
		spawnServe: () => {
			state.spawns += 1;
			if (behavior.failSpawn) throw new Error("spawn 失败");
			return {
				pid: 4242,
				kill: () => {
					state.kills.push(4242);
					return true;
				},
				onExit: () => {},
			};
		},
		downloadWeights: async (files, p, signal) => {
			calls.push("download");
			p(1, files.reduce((n, f) => n + f.size, 0));
			if (behavior.hangDownload) {
				await new Promise<void>((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
			}
		},
		verifyWeights: async () => {
			calls.push("verify");
			if (behavior.failVerify) throw new Error("SHA256 不符：model.int8.onnx");
		},
		importWeights: async () => {
			calls.push("import");
			return { copied: 2, bytes: 8 };
		},
		findFreePort: async () => 51999,
		health: async () => ({ ok: behavior.healthOk !== false, device: "cpu", loaded: ["model.int8.onnx"] }),
		activate: async () => {
			state.activates += 1;
			state.installed = true;
		},
		rollback: async () => {
			state.rollbacks += 1;
		},
		uninstall: async () => {
			state.installed = false;
		},
		randomToken: () => "t".repeat(64),
		paths: () => paths,
		registerAsr: (i) => {
			state.registered = { baseUrl: i.baseUrl, token: i.token, modelId: i.modelId };
		},
		unregisterAsr: () => {
			state.registered = null;
		},
		recordPid: (pid) => {
			state.pid = pid;
		},
		now: () => clock.now(),
		setTimer: (fn, ms) => clock.setTimer(fn, ms),
		isInstalled: () => state.installed,
		log: () => {},
	};
	const manager = new LocalAsrManager(
		deps,
		{ source: SENSEVOICE_SOURCE, license: opts.license ?? SENSEVOICE_LICENSE, model: SENSEVOICE_MODEL, ids: { provider: ASR_PROVIDER_ID, modelId: ASR_MODEL_ID, protocol: ASR_PROTOCOL }, idleSeconds: opts.idleSeconds },
		() => {},
	);
	return { manager, clock, calls, state, behavior };
}

// ------------------------------------------------------------------ 许可

test("unresolved 许可：download 安装被拒，且不执行任何安装步骤", async () => {
	const h = harness();
	await assert.rejects(() => h.manager.install({ source: "download", acceptLicense: "1.1" }), /未最终确认/);
	assert.deepEqual(h.calls, [], "许可没过时不应该跑 uv / 下载");
	assert.equal(h.manager.status().install.state, "not_installed");
});

test("unresolved 许可：用户自行导入仍可安装，且 activate 记录来源为 import", async () => {
	const h = harness();
	const st = await h.manager.install({ source: "import", importDir: "/tmp/user-weights" });
	assert.equal(st.install.state, "installed");
	assert.equal(st.install.source, "import");
	assert.ok(h.calls.includes("import"));
	assert.ok(!h.calls.includes("download"), "导入路径绝不去官方源下载");
	assert.equal(h.state.activates, 1);
});

test("cleared 许可：download 需要正确版本的 acceptLicense；版本不符 / 缺失都拒绝", async () => {
	const cleared = { ...SENSEVOICE_LICENSE, decision: "cleared" as const, redistribution: true };
	const h = harness({ license: cleared });
	await assert.rejects(() => h.manager.install({ source: "download" }), /必须接受/);
	await assert.rejects(() => h.manager.install({ source: "download", acceptLicense: "1.0" }), /版本不匹配/);
	const st = await h.manager.install({ source: "download", acceptLicense: "1.1" });
	assert.equal(st.install.state, "installed");
	assert.equal(st.install.source, "download");
	assert.deepEqual(h.calls, ["ensureUv", "run:venv", "run:pip", "download", "verify"]);
});

test("不支持平台：安装直接拒绝（不用假 no-op 冒充）", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" }, platformSupport: "unsupported" });
	await assert.rejects(() => h.manager.install({ source: "download", acceptLicense: "1.1" }), /暂不支持/);
});

// ------------------------------------------------------------------ 安装失败

test("校验失败：回滚 + failed，不产生半安装 ready（配置为未安装）", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	h.behavior.failVerify = true;
	await assert.rejects(() => h.manager.install({ source: "download", acceptLicense: "1.1" }), /SHA256 不符/);
	const st = h.manager.status();
	assert.equal(st.install.state, "failed");
	assert.equal(st.install.phase, "rollback");
	assert.equal(h.state.rollbacks, 1);
	assert.equal(h.state.installed, false);
	assert.equal(st.configured, false);
	assert.match(String(st.install.error), /SHA256 不符/);
});

test("取消下载：中断后回滚，状态回到未安装（partial 不残留）", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	h.behavior.hangDownload = true;
	const p = h.manager.install({ source: "download", acceptLicense: "1.1" });
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(h.manager.cancel().ok, true);
	await assert.rejects(() => p, /已取消/);
	const st = h.manager.status();
	assert.equal(st.install.state, "not_installed");
	assert.equal(h.state.rollbacks, 1);
	assert.equal(h.state.installed, false);
});

test("重复安装：进行中再次 install 直接报错（不并发下载）", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	h.behavior.hangDownload = true;
	const p = h.manager.install({ source: "download", acceptLicense: "1.1" });
	await new Promise((r) => setTimeout(r, 5));
	await assert.rejects(() => h.manager.install({ source: "download", acceptLicense: "1.1" }), /已在进行中/);
	h.manager.cancel();
	await p.catch(() => {});
});

// ------------------------------------------------------------------ 运行

test("启动 / 停止：注册端点、记录 pid、停止时撤销注册并清 pid；状态里绝不出现 token", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	await h.manager.install({ source: "download", acceptLicense: "1.1" });
	const st = await h.manager.start();
	assert.equal(st.runtime.state, "running");
	assert.equal(st.runtime.pid, 4242);
	assert.equal(h.state.pid, 4242);
	assert.equal(h.state.registered?.modelId, ASR_MODEL_ID);
	assert.equal(h.state.registered?.token, "t".repeat(64), "注册表内部应有 token");
	assert.ok(st.registered && !("token" in st.registered));
	assert.ok(!JSON.stringify(st).includes("t".repeat(64)), "status 序列化后不得含 token");
	assert.equal(st.runtime.host, "127.0.0.1", "只绑 loopback");

	const stopped = await h.manager.stop("manual");
	assert.equal(stopped.runtime.state, "stopped");
	assert.deepEqual(h.state.kills, [4242], "只 kill 自己 spawn 的 pid");
	assert.equal(h.state.pid, null);
	assert.equal(h.state.registered, null);
	assert.equal(stopped.configured, true, "停止只释放进程，磁盘配置仍在");
});

test("停止会明确中止进行中的推理（stop-active-abort）", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	await h.manager.install({ source: "download", acceptLicense: "1.1" });
	await h.manager.start();
	const lease = h.manager.beginInference();
	assert.equal(lease.signal.aborted, false);
	await h.manager.stop("manual");
	assert.equal(lease.signal.aborted, true);
	lease.end();
});

test("启动失败：有界退避，退避期内拒绝再次启动；连续失败后暂停自动重启", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	await h.manager.install({ source: "download", acceptLicense: "1.1" });
	h.behavior.failSpawn = true;
	await assert.rejects(() => h.manager.start(), /spawn 失败/);
	assert.equal(h.manager.status().runtime.state, "crashed");
	assert.equal(h.manager.status().runtime.restarts, 1);
	await assert.rejects(() => h.manager.start(), /退避/);
	h.clock.advance(backoffMs(1) + 1);
	// 退避到期后允许重试，但仍然失败 → 失败计数累加
	for (let i = 0; i < 4; i++) {
		await h.manager.start().catch(() => {});
		h.clock.advance(backoffMs(5) + 1);
	}
	assert.equal(h.manager.status().idle.paused, true, "连续失败到上限后进入暂停");
	await assert.rejects(() => h.manager.start(), /暂停/);
	h.behavior.failSpawn = false;
	await h.manager.resume();
	const st = await h.manager.start();
	assert.equal(st.runtime.state, "running");
});

// ------------------------------------------------------------------ 空闲释放

test("空闲释放：默认 TTL 到期后释放进程（保留磁盘权重），deadline 从最后一次活动起算", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	await h.manager.install({ source: "download", acceptLicense: "1.1" });
	await h.manager.start();
	assert.equal(h.manager.status().idle.seconds, ASR_DEFAULT_IDLE_SECONDS);

	h.clock.advance((ASR_DEFAULT_IDLE_SECONDS - 1) * 1000);
	assert.equal(h.manager.status().runtime.state, "running", "没到期不该释放");
	h.clock.advance(2_000);
	assert.equal(h.manager.status().runtime.state, "stopped", "到期后释放");
	assert.equal(h.manager.status().idle.unloads, 1);
	assert.deepEqual(h.state.kills, [4242]);
	assert.equal(h.state.installed, true, "释放只停进程，磁盘权重保留");
});

test("录音中绝不释放：租约持有期间跨过 TTL 也不 kill，释放后重新计时", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	await h.manager.install({ source: "download", acceptLicense: "1.1" });
	await h.manager.start();
	const rec = h.manager.acquireRecording();
	h.clock.advance(ASR_DEFAULT_IDLE_SECONDS * 10);
	assert.equal(h.manager.status().runtime.state, "running", "录音期间不能 kill");
	assert.equal(h.state.kills.length, 0);
	rec.release();
	h.clock.advance(ASR_DEFAULT_IDLE_SECONDS * 1000 - 1);
	assert.equal(h.manager.status().runtime.state, "running", "从租约释放起重新计时");
	h.clock.advance(2);
	assert.equal(h.manager.status().runtime.state, "stopped");
});

test("推理中绝不释放；推理结束重置截止时间（新请求重置）", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	await h.manager.install({ source: "download", acceptLicense: "1.1" });
	await h.manager.start();
	const lease = h.manager.beginInference();
	h.clock.advance(ASR_DEFAULT_IDLE_SECONDS * 3);
	assert.equal(h.manager.status().runtime.state, "running", "推理中不能 kill");
	assert.equal(h.manager.status().idle.active, 1);
	lease.end();
	// 结束后重新计时
	h.clock.advance((ASR_DEFAULT_IDLE_SECONDS - 1) * 1000);
	assert.equal(h.manager.status().runtime.state, "running");
	h.clock.advance(2_000);
	assert.equal(h.manager.status().runtime.state, "stopped");
});

test("idleSeconds=0：一次推理结束后立即释放（不是录音中释放）", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" }, idleSeconds: 0 });
	await h.manager.install({ source: "download", acceptLicense: "1.1" });
	await h.manager.start();
	const rec = h.manager.acquireRecording();
	const lease = h.manager.beginInference();
	h.clock.advance(5_000);
	assert.equal(h.manager.status().runtime.state, "running", "有租约时即使 TTL=0 也不释放");
	lease.end();
	rec.release();
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(h.manager.status().runtime.state, "stopped");
});

test("立即释放：忙时拒绝（明确报错），空闲时释放并保留权重", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	await h.manager.install({ source: "download", acceptLicense: "1.1" });
	await h.manager.start();
	const rec = h.manager.acquireRecording();
	await assert.rejects(() => h.manager.unloadNow(), /正在录音|未完成请求/);
	rec.release();
	const st = await h.manager.unloadNow();
	assert.equal(st.runtime.state, "stopped");
	assert.equal(h.state.installed, true);
});

test("空闲 TTL 可配置并被夹到合法区间", () => {
	const h = harness();
	assert.equal(h.manager.setIdleSeconds(120), 120);
	assert.equal(h.manager.setIdleSeconds(-5), 0);
	assert.equal(h.manager.setIdleSeconds(99999), 3600);
});

// ------------------------------------------------------------------ 卸载 / 脱敏

test("卸载需要显式确认；确认后停进程并只删 own 目录", async () => {
	const h = harness({ license: { ...SENSEVOICE_LICENSE, decision: "cleared" } });
	await h.manager.install({ source: "download", acceptLicense: "1.1" });
	await assert.rejects(() => h.manager.uninstall(false), /显式确认/);
	const st = await h.manager.uninstall(true);
	assert.equal(st.install.state, "not_installed");
	assert.equal(h.state.installed, false);
});

test("错误脱敏：token / 长十六进制串不写进状态", () => {
	const msg = sanitizeError(new Error(`请求失败 Bearer ${"a".repeat(40)} 以及 ${"b".repeat(64)}`));
	assert.ok(!msg.includes("a".repeat(40)));
	assert.ok(!msg.includes("b".repeat(64)));
	assert.ok(msg.includes("Bearer ***"));
});

test("有界退避：1s 起步、指数增长、封顶 30s", () => {
	assert.equal(backoffMs(1), 1000);
	assert.equal(backoffMs(2), 2000);
	assert.equal(backoffMs(3), 4000);
	assert.equal(backoffMs(10), 30_000);
});
