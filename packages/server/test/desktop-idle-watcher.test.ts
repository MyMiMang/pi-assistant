/**
 * 空闲自动关机 watcher 的端到端判定（DESIGN §15.2）：用假时钟 + 注入的假后端，不真睡眠、不碰真虚拟机。
 * 覆盖：10 分钟边界、busy 阻关、有人在看画面阻关、服务重启后重新计时、虚拟机空转单独计时。
 */
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IdleTracker } from "../src/desktop/idle.ts";
import { startIdleWatcher } from "../src/desktop.ts";

const M = 60_000;
const NEVER = 10 ** 9; // 只手动 tick，不真定时
const BASE = 1_700_000_000_000; // 假时钟起点（非 0，和真实 Date.now 一样）

function harness(opts: { idleMinutes?: number; enabled?: boolean } = {}) {
	let now = BASE;
	const tracker = new IdleTracker(() => now);
	const stopped: string[] = [];
	const engineStops: number[] = [];
	const released: string[] = [];
	let running: string[] = ["a1"];
	const busy = new Set<string>();
	const settings = { enabled: opts.enabled ?? true, idleMinutes: opts.idleMinutes ?? 10 };
	const w = startIdleWatcher({
		busy: (id) => busy.has(id),
		changed: () => {},
		now: () => now,
		tracker,
		running: async () => running,
		stop: async (cid) => void stopped.push(cid),
		release: async (id) => void released.push(id),
		engineRunning: async () => true,
		stopEngine: async () => void engineStops.push(now),
		fixedPorts: true,
		settings: () => settings,
		intervalMs: NEVER,
	});
	return {
		w,
		tracker,
		stopped,
		engineStops,
		released,
		busy,
		setRunning: (r: string[]) => (running = r),
		at: (t: number) => (now = BASE + t),
		get now() {
			return now;
		},
	};
}

test("空闲关机 watcher：10 分钟边界到点才关，差 1 秒不关", async () => {
	const h = harness();
	await h.w.tick(); // 服务刚启动第一次看到：从现在开始计时
	assert.deepEqual(h.stopped, []);
	h.at(10 * M - 1);
	await h.w.tick();
	assert.deepEqual(h.stopped, [], "9 分 59 秒不该关");
	h.at(10 * M);
	await h.w.tick();
	assert.deepEqual(h.stopped, ["a1"], "整 10 分钟该关");
	h.w.stop();
});

test("空闲关机 watcher：助理在跑任务时不关，任务结束后重新计时", async () => {
	const h = harness();
	h.busy.add("a1");
	await h.w.tick();
	h.at(99 * M);
	await h.w.tick();
	assert.deepEqual(h.stopped, [], "busy 时不管空闲多久都不关");
	h.busy.delete("a1");
	h.at(100 * M);
	await h.w.tick(); // 上一次 tick（99 分）刷新过使用时间，此时才空闲 1 分钟
	assert.deepEqual(h.stopped, []);
	h.at(109 * M);
	await h.w.tick();
	assert.deepEqual(h.stopped, ["a1"]);
	h.w.stop();
});

test("空闲关机 watcher：有人在看实时画面时不关，画面关掉后重新计时", async () => {
	const h = harness();
	h.tracker.viewerOpen("a1");
	h.at(99 * M);
	await h.w.tick();
	assert.deepEqual(h.stopped, [], "有人看画面不关");
	h.tracker.viewerClose("a1"); // 关掉时 touch
	h.at(108 * M);
	await h.w.tick();
	assert.deepEqual(h.stopped, [], "画面关掉后才 9 分钟");
	h.at(109 * M);
	await h.w.tick();
	assert.deepEqual(h.stopped, ["a1"], "画面关掉整 10 分钟才关");
	h.w.stop();
});

test("空闲关机 watcher：服务重启（新 tracker）第一次看到运行中的电脑不会立刻关", async () => {
	const h = harness();
	h.at(1000 * M);
	await h.w.tick(); // 重启后第一次看到：从现在开始计时
	assert.deepEqual(h.stopped, []);
	h.at(1004 * M);
	h.tracker.touch("a1"); // 期间有工具调用
	h.at(1013 * M);
	await h.w.tick();
	assert.deepEqual(h.stopped, [], "才空闲 9 分钟");
	h.at(1014 * M);
	await h.w.tick();
	assert.deepEqual(h.stopped, ["a1"]);
	h.w.stop();
});

test("空闲关机 watcher：虚拟机上没有桌面容器时，空转同样时间后关虚拟机", async () => {
	const h = harness();
	h.setRunning([]);
	await h.w.tick(); // 虚拟机在跑，第一个 tick 开始计时
	assert.deepEqual(h.engineStops, []);
	h.at(9 * M + 59_000);
	await h.w.tick();
	assert.deepEqual(h.engineStops, []);
	h.at(10 * M);
	await h.w.tick();
	assert.deepEqual(h.engineStops, [h.now], "空转 10 分钟关虚拟机");
	h.w.stop();
});

test("空闲关机 watcher：设为「从不」时永不自动关", async () => {
	const h = harness({ idleMinutes: 0 });
	await h.w.tick();
	h.at(1000 * M);
	await h.w.tick();
	assert.deepEqual(h.stopped, []);
	assert.deepEqual(h.engineStops, []);
	h.w.stop();
});
